// THE INTERVIEW LOOP — one question a day, drawn from the owner's own record.
//
// The Persona tab (PersonaModule) grows a stand-in the overseer is later
// injected with. Hand-written notes only capture what the owner thinks to write
// down; this loop covers the rest by noticing something they actually DID and
// asking about the judgment behind it — "you sent X back twice — what was
// missing?" — one question, once a day, answer appended to the corpus.
//
// WHY NO `claude` HERE (the load-bearing design call):
//
//   Generation is a DETERMINISTIC template fill over the owner's durable
//   records — no model is spawned. `claude -p` is forbidden repo-wide
//   (subscription billing, see claudeTerminal.ts), so an LLM question would
//   mean a whole PTY session per day: ~30-60s, marker scraping, ANSI
//   stripping, a timeout path, and the 0.11.12 hang class. For ONE short
//   sentence a day that is a bad trade — but the deciding reason is
//   correctness, not cost:
//
//   1. The ban on generic questions becomes STRUCTURAL. Every template needs a
//      concrete observed fact to fill its slots; with no material we emit no
//      question at all. A personality-quiz question ("are you a planner?") is
//      not something this module can produce, rather than something a prompt
//      asks a model not to produce.
//   2. A card carries NO MOVE OR APPROVAL TIMESTAMPS — `createdAt`, its current
//      column, and a few durable flags/counters (`reworkCount`,
//      `selfSupplyApproved`, `reviewedBy`), but nothing saying WHEN any of it
//      happened (see ProjectTask). A model handed a board digest will cheerfully
//      write "you moved X to done yesterday", which is unknowable. Templates
//      bound to real fields cannot invent history: the board detectors below ask
//      about a durable FACT ("you sent this back twice") and never about timing,
//      while the only questions that speak about SPEED come from escalations,
//      which do record createdAt/answeredAt/dismissedAt.
//
//   Token discipline therefore lands at zero, and the once-a-day cap exists to
//   bound how often the OWNER is interrupted, not how much is spent.
//
// ENGINE-INDEPENDENT + APP-UPTIME-ONLY: nothing is scheduled. The tab asks, and
// the day's question is generated on that first ask (an explicit POST — a GET
// must never mutate, see the drain-tick rule). No swarm engine, no timer, no
// work at all on days the tab is never opened.

import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import type {
  Escalation,
  PersonaInterviewState,
  PersonaQuestion,
  PersonaQuestionKind,
  ProjectTask,
} from '@/lib/types'
import { atomicWriteJson } from './atomicWrite'
import { ensureOpenGroundHome, personaInterviewFile } from './paths'
import { getSettings } from './store'
import { ensureProjectsMigrated } from './registry'
import { readProjectData } from './projectData'
import { listEscalations } from './swarmEscalations'
import { appendJudgment } from './youCorpus'

// Personal data (it quotes the owner's own board) — owner-only, like the corpus.
const FILE_MODE = 0o600

/** How many past subjects we remember, so a long-running install cannot grow
 *  this file without bound.
 *
 *  Sized so the bound stays theoretical: the tab promises「同じことは二度聞き
 *  ません」/ "never the same one twice", and the oldest keys ARE dropped past the
 *  cap, so a subject that outlives the window could return and make that copy
 *  false. Generation is capped at one per local day, so this is ~13 years of
 *  daily use — and ~250KB at the ceiling, which is nothing for a local
 *  single-user file. Cheaper than weakening a sentence the owner reads. */
const MAX_ASKED_SUBJECTS = 5000

/** How far back a fact may be and still be worth asking about. */
const MATERIAL_WINDOW_DAYS = 30
/** A card sitting in `blocked` this long is a real "parked" signal, not a blip. */
const STALE_BLOCKED_DAYS = 3
/** An unanswered question to the owner this old is worth asking about. */
const LONG_OPEN_DAYS = 2
/** A todo this old, while newer cards moved on, is a real "passed over" signal. */
const PASSED_OVER_DAYS = 7
/** Decided inside this ⇒ "settled it right away". */
const FAST_DECISION_MS = 60 * 60 * 1000
/** Sat this long before being decided ⇒ "held on to it". */
const SLOW_DECISION_MS = 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** Quoted titles are the owner's own words but can be long or multi-line —
 *  flatten and cap so a question stays one readable sentence. */
const SNIP_MAX = 60
export const snip = (s: string, max: number = SNIP_MAX): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  // Cut by CODE POINT, not code unit: a plain slice can split a surrogate pair
  // (emoji, rarer CJK) and leave a lone half. That half is then frozen onto the
  // question record and written into you-corpus.md, where the UTF-8 encode turns
  // it into U+FFFD permanently — a corruption in the owner's own corpus that no
  // later edit can undo. Counting code points also means an emoji title is cut
  // at 60 glyphs rather than ~30.
  const points = Array.from(flat)
  return points.length <= max ? flat : `${points.slice(0, max).join('')}…`
}

/** Local 'YYYY-MM-DD'. Deliberately local, not `toISOString().slice(0,10)`:
 *  "one a day" is the OWNER's day, and a UTC roll would flip the question
 *  mid-evening in JST. (Twin of dailyFuelReport's localDateKey — kept private
 *  here rather than shared, so the two features cannot break each other.) */
export const localDateKey = (nowMs: number): string => {
  const d = new Date(nowMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** ms since an ISO timestamp, or null when it is absent/unparseable. A card can
 *  legitimately carry `createdAt: ''` (ProjectTaskSchema `.catch('')`), so this
 *  must never produce NaN-driven nonsense. */
const ageMs = (iso: string | undefined, nowMs: number): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const age = nowMs - t
  return age >= 0 ? age : null
}

const days = (ms: number): number => Math.floor(ms / DAY_MS)

// ─── Persisted state ─────────────────────────────────────────────────────────
//
// Same three-layer shape the daily fuel report settled on, minus its third
// layer: disk sentinel (survives restart) + a globalThis memo (survives a
// `tsx watch` reload, and holds the day even when the disk write fails). No
// domain-truth scan is needed here because the only artifact a run produces IS
// this record — a lost sentinel costs at most one extra question after a
// restart, never a flood.

const memoGlobal = globalThis as typeof globalThis & {
  __openground_persona_interview_memo?: PersonaInterviewState | null
  __openground_persona_interview_inflight?: Promise<PersonaQuestion | null> | null
  __openground_persona_interview_chain?: Promise<unknown>
}

/** Single-flight chain for every read-modify-write of the state.
 *
 *  answer/skip read the state, await the corpus write, then commit — a real gap
 *  another caller can slip into. Two windows on one machine (the Electron app
 *  and a browser on :5174) are a supported setup, and without this two
 *  overlapping answers both saw `status: 'open'` and BOTH wrote the decision
 *  into the corpus. It also stops a commit that started before a day rollover
 *  from restoring the previous `lastAskedDate` and dropping the new subject.
 *  On globalThis for the same reason as the memo: a `tsx watch` reload must not
 *  hand the two module copies two different locks. */
const withStateLock = <T,>(fn: () => Promise<T>): Promise<T> => {
  const prev = memoGlobal.__openground_persona_interview_chain ?? Promise.resolve()
  const run = prev.then(fn, fn)
  memoGlobal.__openground_persona_interview_chain = run.catch(() => undefined)
  return run
}

const emptyState = (): PersonaInterviewState => ({
  version: 1,
  lastAskedDate: '',
  today: null,
  askedSubjects: [],
})

const isMissingFileError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Tolerant read: a corrupt/unreadable state file must not wedge the tab. The
 *  worst case is one repeated question, so unlike the corpus (where "unreadable
 *  ≠ absent" guards real judgments) tolerance is the safe direction here. */
export const readInterviewState = async (): Promise<PersonaInterviewState> => {
  const memo = memoGlobal.__openground_persona_interview_memo
  if (memo) return memo
  await ensureOpenGroundHome()
  let raw: string
  try {
    raw = await readFile(personaInterviewFile(), 'utf8')
  } catch (err) {
    if (!isMissingFileError(err)) {
      console.error('[openground:persona-interview] state unreadable — starting fresh', err)
    }
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersonaInterviewState>
    return {
      version: 1,
      lastAskedDate: typeof parsed.lastAskedDate === 'string' ? parsed.lastAskedDate : '',
      today: (parsed.today as PersonaQuestion | null) ?? null,
      askedSubjects: Array.isArray(parsed.askedSubjects)
        ? parsed.askedSubjects.filter((s): s is string => typeof s === 'string')
        : [],
    }
  } catch {
    console.error('[openground:persona-interview] state corrupt — starting fresh')
    return emptyState()
  }
}

/** Memory FIRST, then disk. A failed write leaves the day marked in memory, so
 *  the owner is not re-asked every time they revisit the tab this session. */
const commitInterviewState = async (state: PersonaInterviewState): Promise<void> => {
  memoGlobal.__openground_persona_interview_memo = state
  try {
    await ensureOpenGroundHome()
    await atomicWriteJson(personaInterviewFile(), state, { mode: FILE_MODE })
  } catch (e) {
    console.error(
      '[openground:persona-interview] state write failed — today holds in memory, but a restart may re-ask',
      e,
    )
  }
}

/** Tests only: the memo and the in-flight latch live on globalThis (reload
 *  safety), which means they outlive a test file. */
export const _resetPersonaInterviewForTest = (): void => {
  memoGlobal.__openground_persona_interview_memo = null
  memoGlobal.__openground_persona_interview_inflight = null
}

// ─── Material ────────────────────────────────────────────────────────────────

/** One card plus the project it came from — the board carries no project ref.
 *
 *  The project is identified by its REGISTRY UUID, never by its name. A name is
 *  not an identity: two registered folders can share a basename (~/work/api and
 *  ~/oss/api), and `displayName` is owner-editable and documented as "purely
 *  cosmetic" (ProjectEntry). Grouping on one made detectPassedOver pair cards
 *  from two unrelated repos and assert a race between them that never happened —
 *  a fabrication this module exists to make impossible, and one that would have
 *  been written into the corpus permanently.
 *
 *  There is deliberately NO name field here: no question renders a project name,
 *  so carrying one would only leave the same trap set for the next detector. */
interface BoardCard {
  task: ProjectTask
  projectId: string
}

export interface InterviewMaterial {
  cards: BoardCard[]
  escalations: Escalation[]
  /** EVERY source was actually read. `false` ⇒ at least one board, or the
   *  escalation inbox, could not be read — so an empty result is silence about
   *  the owner's records, NOT a fact about them. Only a complete sweep may back
   *  the claim "there is nothing worth asking about today". */
  complete: boolean
}

/** Sweep every registered project's board + the machine-wide escalation inbox.
 *  Read-only throughout.
 *
 *  Tolerance here is DELIBERATELY PARTIAL: a single unreadable project must not
 *  silence a loop that the other twelve projects have plenty of material for, so
 *  the sweep carries on — but it records that it did not see everything. What
 *  the caller must never do is turn that gap into a confident empty answer; see
 *  ensureTodayQuestion, which refuses to burn the day on an incomplete sweep.
 *
 *  KNOWN LIMIT, stated rather than papered over: both readers below are tolerant
 *  by design (readProjectData serves empty() for a corrupt tasks.json,
 *  listEscalations reads through readTolerant). A corrupt store therefore
 *  arrives here as an EMPTY one, not as a failure, and `complete` stays true —
 *  it can only see faults that actually throw. Tightening that means changing
 *  those readers, which the whole cockpit depends on; it is not this module's
 *  call to make. */
export const gatherMaterial = async (): Promise<InterviewMaterial> => {
  const cards: BoardCard[] = []
  let complete = true
  try {
    await ensureProjectsMigrated()
    const entries = (await getSettings()).projects ?? []
    for (const entry of entries) {
      try {
        const data = await readProjectData(entry.path)
        // The registry UUID — stable across rename/move, and unique by
        // construction. See BoardCard for why a name must never stand in.
        for (const task of data.tasks ?? []) cards.push({ task, projectId: entry.id })
      } catch {
        /* unreadable / vanished project — skipped, but the sweep is now partial */
        complete = false
      }
    }
  } catch (e) {
    console.error('[openground:persona-interview] board sweep failed', e)
    complete = false
  }

  let escalations: Escalation[] = []
  try {
    // listEscalations expands screenshotRef into an inline `screenshot` (up to
    // 8KB of PTY dump each). Drop it immediately — we only read timestamps and
    // question text, and holding them would haul megabytes into memory.
    escalations = (await listEscalations()).map(({ screenshot: _screenshot, ...rest }) => rest)
  } catch (e) {
    console.error('[openground:persona-interview] escalation read failed', e)
    complete = false
  }

  return { cards, escalations, complete }
}

// ─── Detectors ───────────────────────────────────────────────────────────────
//
// Each detector looks for ONE concrete pattern and returns a question quoting
// what it found, or null when the owner's records hold no such thing. Both
// languages are rendered here and frozen onto the record (see PersonaQuestion).
//
// COPY RULE, same as the rest of this tab: the reader is the OWNER, not a
// programmer. No "column", "escalation", "branch", "PR" — a card is a カード,
// a question from a running job is 作業からの相談, `blocked` is 保留.

interface Candidate {
  kind: PersonaQuestionKind
  subjectKey: string
  /** THE SETTING, one sentence, rendered ABOVE the question (2026-08-15).
   *
   *  Without it the question was a pair of quotes with no world around them —
   *  「『Contents interrupted. どうしますか?』に『何が使えなかった?』と答えました」
   *  is unreadable to the person being asked, and they are the only person it
   *  is for. The preamble says WHEN it happened and WHAT KIND of moment it was,
   *  so the quotes land in a scene instead of arriving naked.
   *
   *  ⚠ Never a project NAME — see BoardCard: this module carries ids, not
   *  names, and re-introducing one here would set that trap for the next
   *  detector. "When, and what kind of moment" is enough to place a memory. */
  contextJa: string
  contextEn: string
  textJa: string
  textEn: string
}

/** A detector returns EVERY hit it found, best first — not just its top one.
 *
 *  Returning a single hit looked equivalent (pickCandidate filters out subjects
 *  already asked) and was not: a parked card does not move, so the top hit stays
 *  the top hit forever, and once it had been asked its whole KIND went silent
 *  permanently while the runners-up sat unasked. Ten parked cards produced one
 *  question, ever. Ranked lists let the picker fall through to the next real
 *  observation instead. */
/** 「いつの話か」 for a preamble, from an ISO stamp. Absent/unparseable ⇒ null,
 *  and the caller drops the clause rather than inventing a day — a preamble
 *  that misdates a memory is worse than one that does not date it. */
const agoJa = (iso: string | undefined, nowMs: number): string | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = days(Math.max(0, nowMs - t))
  return d <= 0 ? '今日' : d === 1 ? 'きのう' : d < 14 ? `${d}日前` : `${Math.floor(d / 7)}週間前`
}

const agoEn = (iso: string | undefined, nowMs: number): string | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = days(Math.max(0, nowMs - t))
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 14 ? `${d} days ago` : `${Math.floor(d / 7)} weeks ago`
}

/** Join a preamble's clauses, dropping any the record could not support. */
const setting = (...parts: (string | null)[]): string => parts.filter(Boolean).join('、') + '。'
const settingEn = (...parts: (string | null)[]): string => parts.filter(Boolean).join(', ') + '.'

type Detector = (m: InterviewMaterial, nowMs: number) => Candidate[]

const withinWindow = (iso: string | undefined, nowMs: number): boolean => {
  const age = ageMs(iso, nowMs)
  return age != null && age <= MATERIAL_WINDOW_DAYS * DAY_MS
}

/** Newest-first by an ISO field, NaN-safe. */
const byIsoDesc =
  <T,>(pick: (v: T) => string | undefined) =>
  (a: T, b: T): number =>
    (Date.parse(pick(b) ?? '') || 0) - (Date.parse(pick(a) ?? '') || 0)

/** A card the owner sent back. `reworkCount` is a durable counter (it resets
 *  when the card reaches todo/done, so a live count means the card is still in
 *  flight — exactly when the reason is worth capturing). No timing is claimed:
 *  nothing records WHEN a card was sent back.
 *
 *  The subject key is the card ALONE, deliberately not card+count: the question
 *  asks the same thing at 1, 2 and 3 send-backs, so keying on the count would
 *  re-ask something the owner already answered, in near-identical words. */
const detectRework: Detector = (m) =>
  m.cards
    .filter((c) => !c.task.done && (c.task.reworkCount ?? 0) > 0)
    .sort((a, b) => (b.task.reworkCount ?? 0) - (a.task.reworkCount ?? 0))
    .map(({ task }) => {
      const n = task.reworkCount ?? 0
      const title = snip(task.title)
      return {
        kind: 'card-rework' as const,
        subjectKey: `card-rework:${task.id}`,
        // No date: nothing records WHEN a card was sent back (see the header).
        contextJa: 'Board のカードを、できあがりに納得がいかず差し戻したときの話です。',
        contextEn: 'About a card on your board that you sent back rather than accepting.',
        textJa:
          n === 1
            ? `「${title}」を一度やり直してもらいました — 何が足りなかったのですか?`
            : `「${title}」を${n}回やり直してもらいました — 毎回、何が足りなかったのですか?`,
        textEn:
          n === 1
            ? `You sent "${title}" back once — what was missing?`
            : `You sent "${title}" back ${n} times — what kept being missing?`,
      }
    })

/** One question settled on the spot, another held for days. The contrast the
 *  card names — and the only place decision SPEED is genuinely knowable, because
 *  an escalation records both when it was raised and when it was answered. */
const detectDecisionSpeedContrast: Detector = (m, nowMs) => {
  const decided = m.escalations
    .filter((e) => e.status === 'answered' || e.status === 'injected')
    .filter((e) => withinWindow(e.answeredAt, nowMs))
    .map((e) => {
      const raised = Date.parse(e.createdAt)
      const answered = Date.parse(e.answeredAt ?? '')
      if (Number.isNaN(raised) || Number.isNaN(answered)) return null
      const took = answered - raised
      return took >= 0 ? { e, took } : null
    })
    .filter((v): v is { e: Escalation; took: number } => v != null)

  const fast = decided.filter((d) => d.took <= FAST_DECISION_MS).sort((a, b) => a.took - b.took)
  const slow = decided.filter((d) => d.took >= SLOW_DECISION_MS).sort((a, b) => b.took - a.took)

  // Pair them off, so a later visit gets a DIFFERENT pair rather than nothing.
  // No same-escalation guard is needed: the two buckets are disjoint by
  // construction (≤1h vs ≥24h), so one record cannot sit in both. (An earlier
  // version checked anyway — unreachable code that read as if the overlap were
  // possible.) Whoever moves those constants owns re-checking this.
  const out: Candidate[] = []
  for (let i = 0; i < Math.min(fast.length, slow.length); i++) {
    const fastQ = snip(fast[i].e.plainQuestion || fast[i].e.question)
    const slowQ = snip(slow[i].e.plainQuestion || slow[i].e.question)
    const heldDays = Math.max(1, days(slow[i].took))
    out.push({
      kind: 'decision-speed-contrast',
      subjectKey: `decision-speed-contrast:${fast[i].e.id}:${slow[i].e.id}`,
      contextJa: setting(
        '作業が止まって分身があなたに判断を仰いだ相談のうち',
        '決めるまでの早さが大きく違った2件です',
      ),
      contextEn: settingEn(
        'Two moments when work stopped and your stand-in asked you to decide',
        'one you settled at once and one you sat on',
      ),
      textJa: `「${fastQ}」はすぐ決めて、「${slowQ}」は${heldDays}日置いてから決めました — この2つの違いは何でしたか?`,
      textEn: `You settled "${fastQ}" right away, but held "${slowQ}" for ${heldDays} day(s) — what was different about them?`,
    })
  }
  return out
}

/** A card parked in 保留 — the parking itself was a decision.
 *
 *  The number is CARD AGE and is worded as such. It is NOT time-on-hold: nothing
 *  records when a card entered a column, and the repo's own rework-overflow path
 *  parks a long-lived card without touching `createdAt`, so "has sat on hold for
 *  40 days" would be a fabrication about a card parked one second ago. */
const detectStaleBlocked: Detector = (m, nowMs) =>
  m.cards
    .filter((c) => c.task.boardColumn === 'blocked' && !c.task.done)
    .map((c) => ({ c, age: ageMs(c.task.createdAt, nowMs) }))
    .filter(
      (v): v is { c: BoardCard; age: number } =>
        v.age != null && v.age >= STALE_BLOCKED_DAYS * DAY_MS,
    )
    .sort((a, b) => b.age - a.age)
    .map(({ c, age }) => ({
      kind: 'card-stale-blocked' as const,
      subjectKey: `card-stale-blocked:${c.task.id}`,
      contextJa: setting('Board で「保留」に置いたまま動いていないカードの話です'),
      contextEn: settingEn('About a card sitting in the on-hold column of your board'),
      textJa: `${days(age)}日前に作った「${snip(c.task.title)}」が、いま保留のままです — 何を待っていますか? それとも、もう要りませんか?`,
      textEn: `"${snip(c.task.title)}", added ${days(age)} days ago, is on hold right now — what are you waiting for? Or is it no longer needed?`,
    }))

/** Something asked the owner and never got an answer. Not answering is itself a
 *  judgment. The elapsed time IS sound here: an escalation is never reopened, so
 *  now − createdAt really is how long it has gone unanswered. */
const detectLongOpen: Detector = (m, nowMs) =>
  m.escalations
    .filter((e) => e.status === 'open')
    .map((e) => ({ e, age: ageMs(e.createdAt, nowMs) }))
    .filter(
      (v): v is { e: Escalation; age: number } => v.age != null && v.age >= LONG_OPEN_DAYS * DAY_MS,
    )
    .sort((a, b) => b.age - a.age)
    .map(({ e, age }) => ({
      kind: 'escalation-long-open' as const,
      subjectKey: `escalation-long-open:${e.id}`,
      contextJa: setting(
        agoJa(e.createdAt, nowMs),
        '作業が止まり、分身があなたに判断を仰ぎました',
        'まだ答えていません',
      ),
      contextEn: settingEn(
        agoEn(e.createdAt, nowMs),
        'work stopped and your stand-in asked you to decide',
        'it is still waiting',
      ),
      textJa: `「${snip(e.plainQuestion || e.question)}」という相談に、${days(age)}日答えていません — 答えにくいのは何が引っかかっているからですか?`,
      textEn: `A question — "${snip(e.plainQuestion || e.question)}" — has gone ${days(age)} days without an answer. What is making it hard to call?`,
    }))

/** Closed without answering: the owner decided it did not need them. */
const detectDismissed: Detector = (m, nowMs) =>
  m.escalations
    .filter((e) => e.status === 'dismissed' && withinWindow(e.dismissedAt, nowMs))
    .sort(byIsoDesc((e: Escalation) => e.dismissedAt))
    .map((e) => ({
      kind: 'escalation-dismissed' as const,
      subjectKey: `escalation-dismissed:${e.id}`,
      contextJa: setting(
        agoJa(e.dismissedAt, nowMs),
        '分身があなたに判断を仰ぎ、あなたは答えずにその相談を閉じました',
      ),
      contextEn: settingEn(
        agoEn(e.dismissedAt, nowMs),
        'your stand-in asked you to decide and you closed the question instead',
      ),
      textJa: `「${snip(e.plainQuestion || e.question)}」という相談を、答えずに閉じました — これは、あなたが決めることではなかったのですか?`,
      textEn: `You closed a question — "${snip(e.plainQuestion || e.question)}" — without answering it. Was it simply not yours to decide?`,
    }))

/** An old card still waiting while a newer one moved ahead — WITHIN ONE PROJECT
 *  (cards in different projects were never competing for the same turn, so
 *  pairing across them would assert a race that never happened).
 *
 *  "One project" means ONE REGISTRY UUID. Grouping by name looked equivalent and
 *  was not: two folders may share a basename, so ~/work/api's neglected card got
 *  paired with ~/oss/api's unrelated one and the owner was asked what decides an
 *  order that was never contested. See BoardCard.
 *
 *  Both halves are durable: `createdAt`, and where each card sits now. Cards are
 *  always created in todo, so a card now in doing/review/done genuinely did move
 *  ahead. The age is worded "added N days ago", not as time spent waiting — a
 *  card can leave todo and come back, and nothing records that.
 *
 *  Keyed on the WAITING card alone: keying on the pair would mint a fresh key
 *  every time any newer card started, re-asking about the same neglected card
 *  day after day. */
const detectPassedOver: Detector = (m, nowMs) => {
  const out: Candidate[] = []
  const byProject = new Map<string, BoardCard[]>()
  for (const c of m.cards) byProject.set(c.projectId, [...(byProject.get(c.projectId) ?? []), c])

  for (const [, cards] of Array.from(byProject.entries()).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const waiting = cards
      .filter((c) => !c.task.done && (c.task.boardColumn ?? 'todo') === 'todo')
      .map((c) => ({ c, age: ageMs(c.task.createdAt, nowMs) }))
      .filter(
        (v): v is { c: BoardCard; age: number } =>
          v.age != null && v.age >= PASSED_OVER_DAYS * DAY_MS,
      )
      .sort((a, b) => b.age - a.age)

    for (const { c, age } of waiting) {
      const waitingAt = Date.parse(c.task.createdAt)
      const overtaker = cards
        .filter((o) => o.task.id !== c.task.id)
        .filter((o) => o.task.done || ['doing', 'review', 'done'].includes(o.task.boardColumn ?? ''))
        .map((o) => ({ o, at: Date.parse(o.task.createdAt) }))
        .filter((v) => !Number.isNaN(v.at) && v.at > waitingAt)
        .sort((a, b) => b.at - a.at)[0]
      if (!overtaker) continue
      out.push({
        kind: 'todo-passed-over',
        subjectKey: `todo-passed-over:${c.task.id}`,
        contextJa: setting('同じ Board の未着手の列で、順番が入れ替わった2枚の話です'),
        contextEn: settingEn(
          'About two cards in the same board\u2019s to-do column, where the later one went first',
        ),
        textJa: `${days(age)}日前に作った「${snip(c.task.title)}」はまだ順番待ちで、あとから作った「${snip(overtaker.o.task.title)}」が先に進みました — 順番を決めているものは何ですか?`,
        textEn: `"${snip(c.task.title)}", added ${days(age)} days ago, is still waiting while "${snip(overtaker.o.task.title)}", added later, moved ahead — what decides the order?`,
      })
    }
  }
  return out
}

/** THE UNCLASSIFIED-AREA PROBE — the reason this loop exists at all.
 *
 *  `proxyDraft.isAbstention` is the stand-in's own admission that the corpus is
 *  too thin to judge something (swarmOverseer writes it when the brain declines).
 *  That is precisely "an area the persona map does not cover yet", already
 *  recorded — so 「未分類の領域に出会ったら決めつけず1問だけ聞く」 becomes a detector
 *  rather than a hope. Ranked first below for the same reason. */
const detectCorpusGap: Detector = (m, nowMs) =>
  m.escalations
    .filter((e) => e.proxyDraft?.isAbstention === true && withinWindow(e.createdAt, nowMs))
    .sort(byIsoDesc((e: Escalation) => e.createdAt))
    .map((e) => ({
      kind: 'corpus-gap' as const,
      subjectKey: `corpus-gap:${e.id}`,
      contextJa: setting(
        agoJa(e.createdAt, nowMs),
        '作業が止まったとき、分身は今わかっていることでは判断できないと言って、あなたに回しました',
      ),
      contextEn: settingEn(
        agoEn(e.createdAt, nowMs),
        'work stopped and your stand-in said what it knows was not enough to call it, so it passed the question to you',
      ),
      textJa: `「${snip(e.plainQuestion || e.question)}」— ここは分身が「自分には決められない」と言った場所です。あなたなら、何を見て決めますか?`,
      textEn: `"${snip(e.plainQuestion || e.question)}" — your stand-in said it could not call this one. What would you look at to decide?`,
    }))

/** A decision the owner already made, quoted back to them: was that a RULE, or
 *  just this once? A corpus that knows which is worth far more than one holding
 *  the bare answer — and the answer text is the richest judgment material on the
 *  machine (the owner's own words, never the proxy's). */
const detectAnswerRule: Detector = (m, nowMs) =>
  m.escalations
    .filter((e) => e.status === 'answered' || e.status === 'injected')
    .filter((e) => !!e.answer?.trim() && withinWindow(e.answeredAt, nowMs))
    .sort(byIsoDesc((e: Escalation) => e.answeredAt))
    .map((e) => ({
      kind: 'escalation-answer-rule' as const,
      subjectKey: `escalation-answer-rule:${e.id}`,
      contextJa: setting(
        agoJa(e.answeredAt, nowMs),
        '作業が止まって分身があなたに判断を仰ぎ、あなたが答えました',
      ),
      contextEn: settingEn(
        agoEn(e.answeredAt, nowMs),
        'work stopped, your stand-in asked you to decide, and you answered',
      ),
      textJa: `聞かれたのは「${snip(e.plainQuestion || e.question)}」で、あなたの答えは「${snip((e.answer ?? '').trim())}」でした。これは次からも同じ判断になりますか? それとも、このときだけですか?`,
      textEn: `The question was "${snip(e.plainQuestion || e.question)}", and you answered "${snip((e.answer ?? '').trim())}". Is that the rule from here on, or was it just this once?`,
    }))

/** The owner let something through. `selfSupplyApproved` is set ONLY by the
 *  owner-gated approve route, so it is genuinely their call — and it is a
 *  durable FLAG, so the question asks what they look at, never WHEN they did it
 *  (nothing records that). This is the 承認 half of the board signal. */
const detectApproved: Detector = (m) =>
  m.cards
    .filter((c) => c.task.selfSupplyApproved === true)
    .sort((a, b) => (a.task.id < b.task.id ? -1 : 1))
    .map(({ task }) => ({
      kind: 'card-approved' as const,
      subjectKey: `card-approved:${task.id}`,
      // A durable FLAG, not an event: nothing records when it was set.
      contextJa: 'Board に自動で積まれたカードを、あなたが「進めてよい」と通したときの話です。',
      contextEn: 'About a card your swarm proposed on its own, which you let through.',
      textJa: `「${snip(task.title)}」を、進めてよいと承認しました — 通すか止めるかは、何を見て決めていますか?`,
      textEn: `You approved "${snip(task.title)}" to go ahead — what do you look at when deciding to let something through?`,
    }))

/** Every detector, tagged with the kind it emits.
 *
 *  EXPORTED ON PURPOSE: the policy test enumerates this list to prove EVERY
 *  detector is covered by a fixture and that its rendered question clears the
 *  banned-phrasing check. Without the export the test could only pin the
 *  questions it happened to know about — which is exactly how a generic
 *  personality-quiz template would slip in unnoticed (proven by mutation during
 *  review: a quiz detector was added and all 92 tests still passed). Order is
 *  the tie-break when nothing has been asked yet: the unclassified-area probe
 *  first, richest signal after. */
export interface RegisteredDetector {
  kind: PersonaQuestionKind
  detect: Detector
}

export const DETECTORS: RegisteredDetector[] = [
  { kind: 'corpus-gap', detect: detectCorpusGap },
  { kind: 'card-rework', detect: detectRework },
  { kind: 'escalation-answer-rule', detect: detectAnswerRule },
  { kind: 'decision-speed-contrast', detect: detectDecisionSpeedContrast },
  { kind: 'card-stale-blocked', detect: detectStaleBlocked },
  { kind: 'escalation-long-open', detect: detectLongOpen },
  { kind: 'card-approved', detect: detectApproved },
  { kind: 'todo-passed-over', detect: detectPassedOver },
  { kind: 'escalation-dismissed', detect: detectDismissed },
]

/** Pick one candidate: never a subject already asked about, and preferring a
 *  KIND that has come up least recently — so ten parked cards do not produce ten
 *  days of the same question, and no kind starves either. EVERY hit of EVERY
 *  detector is in play, so exhausting one kind's best subject falls through to
 *  its runner-up instead of silencing that kind for good. Fully deterministic
 *  given the state: ties break on detector order, then the detector's own rank. */
export const pickCandidate = (
  material: InterviewMaterial,
  state: PersonaInterviewState,
  nowMs: number,
): Candidate | null => {
  const asked = new Set(state.askedSubjects)
  const recent = state.askedSubjects.slice(-DETECTORS.length * 2)
  const kindUse = (kind: string): number => recent.filter((s) => s.startsWith(`${kind}:`)).length

  let failed = 0
  const candidates = DETECTORS.flatMap(({ detect }, i) => {
    try {
      return detect(material, nowMs).map((c, j) => ({ c, i, j }))
    } catch (e) {
      // One bad detector costs its own kind, never the whole day.
      console.error('[openground:persona-interview] detector failed', e)
      failed++
      return []
    }
  }).filter((v) => !asked.has(v.c.subjectKey))

  // ALL of them threw ⇒ this is a broken build, not a quiet week. Swallowing it
  // would render the honest empty state —「今日は質問がありません」— over a total
  // failure, and mark the day so it never retries: a tolerant catch turning a
  // loud fault into a confident false claim. Fail loudly instead; the route
  // 500s and the tab hides the section rather than asserting emptiness.
  if (failed > 0 && failed === DETECTORS.length) {
    throw new Error(`persona interview: all ${failed} detectors failed`)
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => kindUse(a.c.kind) - kindUse(b.c.kind) || a.i - b.i || a.j - b.j)
  return candidates[0].c
}

// ─── The once-a-day entry point ──────────────────────────────────────────────

export interface InterviewDeps {
  now?: () => number
  gather?: () => Promise<InterviewMaterial>
  newId?: () => string
}

/** Ensure today's question exists and return it (null when the owner's records
 *  hold nothing worth asking about today).
 *
 *  IDEMPOTENT PER LOCAL DAY: the second call on the same day returns the same
 *  record — including its `answered` / `skipped` status, and including a day
 *  that legitimately produced nothing (`lastAskedDate` is bumped either way, so
 *  a barren day is not re-swept on every tab visit).
 *
 *  Concurrent callers share one in-flight promise: the tab mounting twice must
 *  not sweep every board twice, nor race two different questions onto one day.
 *  The latch gives SHARING (both callers get the same answer); the state lock
 *  inside gives ATOMICITY against a concurrent answer/skip. Both are needed. */
export const ensureTodayQuestion = async (
  deps: InterviewDeps = {},
): Promise<PersonaQuestion | null> => {
  const inflight = memoGlobal.__openground_persona_interview_inflight
  if (inflight) return inflight

  const run = withStateLock(async (): Promise<PersonaQuestion | null> => {
    const nowMs = deps.now?.() ?? Date.now()
    const today = localDateKey(nowMs)
    const state = await readInterviewState()
    if (state.lastAskedDate === today) return state.today

    const material = await (deps.gather ?? gatherMaterial)()
    const candidate = pickCandidate(material, state, nowMs)

    if (!candidate) {
      // NOTHING FOUND — but "found nothing" and "could not look" are different
      // answers, and only one of them may be told to the owner.
      //
      // The tab renders an empty day as「今は新しく聞くことがないので、無理に作って
      // いません」— an assertion about THEIR records. Making it off a sweep that
      // failed to read those records is the same fault the detector guard below
      // refuses to commit (pickCandidate: "a tolerant catch turning a loud fault
      // into a confident false claim"), and it is worse here, because the commit
      // then marks the day and no retry comes until tomorrow. Fail loudly and
      // leave the day unmarked: the route 500s, the tab hides the section rather
      // than asserting emptiness, and the owner's next visit sweeps again.
      if (!material.complete) {
        throw new Error(
          'persona interview: some records could not be read — refusing to claim there is nothing to ask',
        )
      }
      // A genuinely quiet day: mark it, so a fruitless sweep does not repeat on
      // every visit. Tomorrow's call sweeps again.
      await commitInterviewState({ ...state, lastAskedDate: today, today: null })
      return null
    }

    const question: PersonaQuestion = {
      id: deps.newId?.() ?? randomUUID(),
      date: today,
      kind: candidate.kind,
      subjectKey: candidate.subjectKey,
      contextJa: candidate.contextJa,
      contextEn: candidate.contextEn,
      textJa: candidate.textJa,
      textEn: candidate.textEn,
      createdAt: new Date(nowMs).toISOString(),
      status: 'open',
    }
    await commitInterviewState({
      version: 1,
      lastAskedDate: today,
      today: question,
      askedSubjects: [...state.askedSubjects, candidate.subjectKey].slice(-MAX_ASKED_SUBJECTS),
    })
    return question
  })

  memoGlobal.__openground_persona_interview_inflight = run
  try {
    return await run
  } finally {
    memoGlobal.__openground_persona_interview_inflight = null
  }
}

/** Read-only view of today's question — never generates. The GET seam.
 *
 *  `generated` distinguishes "swept, found nothing" from "not swept yet". A
 *  reader that collapses the two reports "nothing to ask about today" for a day
 *  nobody has looked at — a claim about the owner's records made without
 *  reading them. */
export const peekTodayQuestion = async (
  deps: InterviewDeps = {},
): Promise<{ question: PersonaQuestion | null; generated: boolean }> => {
  const nowMs = deps.now?.() ?? Date.now()
  const state = await readInterviewState()
  const generated = state.lastAskedDate === localDateKey(nowMs)
  return { question: generated ? state.today : null, generated }
}

export interface AnswerDeps extends InterviewDeps {
  /** DI for tests: the corpus write-back (default appendJudgment). */
  appendMemory?: typeof appendJudgment
}

export interface AnswerResult {
  question: PersonaQuestion
  /** The judgment was stored, but the file the stand-in reads was NOT rebuilt
   *  (appendJudgment's `meta.skipped` — it does not throw for this). Carried all
   *  the way to the UI so "your stand-in has this now" is never said falsely. */
  corpusStale: boolean
}

/** The owner answers — the whole point of the loop. The answer goes to the
 *  CORPUS (Q + A + date, the same shape the escalation write-back uses, so the
 *  overseer reads both the same way); this module keeps only the status.
 *
 *  Unlike the escalation path, a corpus failure here is NOT best-effort: there
 *  is no worker waiting on it, and silently marking a question answered while
 *  losing the answer would destroy the one thing the owner just typed. It
 *  throws, and the question stays open so the UI can offer a retry. */
export const answerTodayQuestion = async (
  id: string,
  answer: string,
  deps: AnswerDeps = {},
): Promise<AnswerResult> => {
  const text = answer.trim()
  if (!text) throw new Error('answer text is required')

  return withStateLock(async () => {
    const nowMs = deps.now?.() ?? Date.now()
    const state = await readInterviewState()
    const q = state.today
    if (!q || q.id !== id) throw new Error('question not found')
    // Inside the lock, so this really is check-THEN-act: two overlapping answers
    // used to both see 'open' and both write the decision into the corpus.
    if (q.status !== 'open') return { question: q, corpusStale: false }

    const appendMemory = deps.appendMemory ?? appendJudgment
    const { meta } = await appendMemory({
      // `Q:` / `→ オーナーの回答:` — byte-identical framing to the escalation
      // write-back (swarmEscalations.ts), so the corpus reads as one voice and
      // the overseer needs no second parser. The DATE rides on the judgment's
      // own `addedAt`, which is what the corpus renders.
      text: `Q: ${[q.contextJa, q.textJa].filter(Boolean).join(' ')}\n→ オーナーの回答: ${text}`,
      tags: ['interview', q.kind],
      context: 'ペルソナタブ 今日の1問',
    })

    const resolved: PersonaQuestion = {
      ...q,
      status: 'answered',
      resolvedAt: new Date(nowMs).toISOString(),
    }
    // Committing the snapshot read at the top of this lock is safe ONLY because
    // withStateLock serializes every read-modify-write of the state: the append
    // above is the slowest write in the app (fsync + a full corpus reassembly),
    // and nothing else can commit inside that window. Without the lock this
    // would need a re-read — a day rollover landing mid-append would otherwise
    // be rolled backwards, erasing the new day's question and un-burning its
    // subject. (An earlier version re-read here and claimed the re-read was
    // load-bearing; it was unreachable, and no test could reach it either.)
    await commitInterviewState({ ...state, today: resolved })
    return { question: resolved, corpusStale: meta?.skipped === true }
  })
}

/** The owner passes. Nothing reaches the corpus — an unanswered question taught
 *  it nothing — but the subject is already in `askedSubjects` (recorded at
 *  generation), so this exact observation never comes back. */
export const skipTodayQuestion = async (
  id: string,
  deps: InterviewDeps = {},
): Promise<PersonaQuestion> =>
  withStateLock(async () => {
    const nowMs = deps.now?.() ?? Date.now()
    const state = await readInterviewState()
    const q = state.today
    if (!q || q.id !== id) throw new Error('question not found')
    if (q.status !== 'open') return q

    const resolved: PersonaQuestion = {
      ...q,
      status: 'skipped',
      resolvedAt: new Date(nowMs).toISOString(),
    }
    await commitInterviewState({ ...state, today: resolved })
    return resolved
  })
