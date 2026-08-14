// personaLedger.ts — the DECISION LEDGER: what the owner's stand-in ACTUALLY DID.
//
// WHY THIS EXISTS. The Persona screen is composed today from SELF-REPORT only —
// the courses the owner scored about themselves (personaCourses.ts) and the
// judgments they typed into the corpus. That is one half of a portrait. This is
// the OTHER half: the record of the stand-in acting against REAL work — every
// time the proxy answered a blocked worker AS the owner, handed the question back
// to them instead, or declared it could not faithfully speak for them. It is the
// precondition for everything asked for next ("this week it answered 3 and asked
// you 2", the said-vs-did gap, the time axis): NOTHING CAN BE SHOWN THAT WAS NOT
// RECORDED, so the recording is the whole card. A screen can be rebuilt from a
// ledger; a ledger cannot be reconstructed from a screen.
//
// WHAT IS RECORDED. One entry per settled proxy-you decision (swarmOverseerBrain's
// `OwnerAnswer`), mapped to a verdict the owner can read:
//   answer                             ⇒ 'answered'  (+ the reported confidence)
//   escalate why='insufficient-info'   ⇒ 'abstained'
//   escalate why='irreversible'|'policy' ⇒ 'asked'
// ⚠ THE 'abstained' LANE IS DELIBERATELY WIDE. `why:'insufficient-info'` covers
// BOTH a real calibrated abstention (the brain ran, read the corpus, judged it
// thin — the only site that also sets `abstained:true`) AND the failure paths that
// report the same `why` (brain crash/timeout, no parseable verdict, the caller's
// watchdog synthesis). They are conflated HERE, in the verdict, because from the
// owner's seat both mean "it did not answer and did not ask me a real question";
// the distinction is not lost — `why` is stored verbatim, so a later screen that
// wants the honest split can recover it (and the brain's `abstained` flag is
// available at the wiring seam if a fourth verdict is ever wanted).
//
// ⚠ PRIVACY — this is a record of the owner's own local work.
// It never leaves the machine. It is written 0600 under the app home (never inside
// a repo), and NOTHING in it may be exposed by an API that returns free text to a
// non-loopback caller: GET /api/persona/ledger is loopback-guarded exactly like its
// you-corpus / persona-courses siblings. The `question` field is UNTRUSTED text
// another agent wrote and is stored TRUNCATED — this is a record of decisions, not
// a transcript, and a blocker text can be tens of KB.
//
// WHY A LEDGER WRITE MAY NEVER FAIL A DECISION. The single production writer sits
// on the swarm's proxy-answer path (swarmOverseer's `answerAsOwner` wrapper). That
// chain has a "never throws" contract — a blocked worker's question must reach
// either the worker or the owner regardless of what the disk is doing — so
// `recordDecision` swallows every error (logged, never rethrown), and the wrapper
// isolates it a second time. An unrecorded decision costs a statistic; a broken
// decision path costs the swarm.
//
// APPEND-ONLY, CAPPED. Entries are only ever appended, never rewritten — with ONE
// permitted mutation: stamping `answered` when the owner later answers the
// escalation the entry raised (see markEscalationAnswered). Unlike escalations.json
// (uncapped, because losing an unanswered irreversible question would violate the
// fail-closed rule) this file is capped at the NEWEST {@link MAX_LEDGER_ENTRIES}:
// a dropped row costs a statistic, not a decision.

import { readFile, rename } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { atomicWriteJson } from './atomicWrite'
import { ensureOpenGroundHome, personaLedgerFile } from './paths'
import type {
  PersonaLedgerCounts,
  PersonaLedgerEntry,
  PersonaLedgerResponse,
  PersonaLedgerSummary,
  PersonaLedgerVerdict,
  PersonaLedgerWhy,
} from '@/lib/types'

/** Personal data — owner-only, like the corpus and the courses beside it. */
const FILE_MODE = 0o600

/** How many entries are kept (the NEWEST ones; the oldest fall off).
 *
 *  2000 because the ONE writer is budgeted: the overseer's brain is hard-capped at
 *  OVERSEER_THRESHOLDS.brainMaxPerDay = 24 calls per UTC day, so 2000 rows is ≈83
 *  days of CONTINUOUSLY maxed-out autonomous operation — an order of magnitude more
 *  than the 7-day window the screen reads, and the same order as the 90-day
 *  escalation retention, so the ledger outlives the records it refers to. It is
 *  also small enough to read whole on every glance: at the question cap below an
 *  entry is a few hundred bytes, i.e. ≲1.5 MB worst case for a file that is parsed
 *  once per screen open. */
export const MAX_LEDGER_ENTRIES = 2000

/** Chars of the question kept per entry. The question is UNTRUSTED text written by
 *  another agent and can be a whole PTY-tail-sized blocker (swarmEscalations clamps
 *  the same field at 4 KB, and the brain prompt at 4 KB); 500 is enough to
 *  RECOGNISE a decision in a list, which is all this record is for. The full text
 *  lives on the escalation record when the question reached the owner. */
export const MAX_LEDGER_QUESTION = 500

/** The trailing window `summary.week` counts. */
export const LEDGER_WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** How many entries GET /api/persona/ledger returns under `recent`. */
export const LEDGER_RECENT_LIMIT = 20

/** Chars of the NORMALIZED question that go into the correlation key.
 *
 *  STRICTLY BELOW swarmEscalations' MAX_ESCALATION_QUESTION (4 KB) on purpose: the
 *  escalation record stores `question.trim().slice(0, 4096)`, so a key built from
 *  any shorter prefix is identical whether it is computed from the FULL question
 *  (here, at decision time) or from the CLAMPED one (there, when the owner answers).
 *  A prefix key by construction — not an equality this file has to keep in sync
 *  with a constant in another module. */
const LEDGER_KEY_QUESTION_CHARS = 2000

const VERDICTS: readonly PersonaLedgerVerdict[] = ['answered', 'asked', 'abstained']

/** The reason classes {@link sanitizeEntry} will keep. A `why` outside this set is
 *  DROPPED (the row survives — a decision with an unreadable reason is still a
 *  decision), which is what makes `PersonaLedgerWhy` an honest type for wire data
 *  rather than a claim about a file anyone can hand-edit. */
const WHYS: readonly PersonaLedgerWhy[] = ['irreversible', 'insufficient-info', 'policy']

/** ~/.openground/persona-ledger.json. Versioned envelope so a future shape change
 *  is a migration rather than a guess. */
interface PersonaLedgerStore {
  version: 1
  /** OLDEST → NEWEST (append order). The readers that want newest-first say so. */
  entries: PersonaLedgerEntry[]
}

/** What a caller hands {@link recordDecision}. `id` / `at` are generated unless a
 *  caller (or a test) pins them. */
export interface PersonaLedgerInput {
  projectPath: string
  verdict: PersonaLedgerVerdict
  /** Truncated to {@link MAX_LEDGER_QUESTION} on the way in. */
  question: string
  why?: PersonaLedgerWhy
  confidence?: 'high' | 'medium' | 'low'
  key?: string
  id?: string
  at?: string
}

// "This path does not exist" — the ONLY read failure a writer may read as
// "legitimately empty" (same rule and reasoning as youCorpus.ts / personaCourses.ts).
const isMissingFileError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Keep only rows that are actually usable as entries.
 *
 *  A hand-mangled (or half-written by an older build) file must not put junk on the
 *  wire or into the counts: the route ships `recent` straight to the screen and
 *  {@link summarizeLedger} indexes a counter BY `verdict`, so an unknown verdict
 *  string would create a phantom bucket nobody reads. Dropping the row is the
 *  fail-open answer — the same trade the Persona catalogue makes. */
const sanitizeEntry = (raw: unknown): PersonaLedgerEntry | null => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Partial<PersonaLedgerEntry>
  if (typeof e.id !== 'string' || !e.id) return null
  if (typeof e.at !== 'string' || !e.at) return null
  if (typeof e.projectPath !== 'string') return null
  if (typeof e.question !== 'string') return null
  if (!VERDICTS.includes(e.verdict as PersonaLedgerVerdict)) return null
  const out: PersonaLedgerEntry = {
    id: e.id,
    at: e.at,
    projectPath: e.projectPath,
    verdict: e.verdict as PersonaLedgerVerdict,
    question: e.question.slice(0, MAX_LEDGER_QUESTION),
  }
  if (WHYS.includes(e.why as PersonaLedgerWhy)) out.why = e.why as PersonaLedgerWhy
  if (e.confidence === 'high' || e.confidence === 'medium' || e.confidence === 'low') {
    out.confidence = e.confidence
  }
  if (typeof e.key === 'string') out.key = e.key
  const answered = e.answered as { at?: unknown } | undefined
  if (answered && typeof answered === 'object' && typeof answered.at === 'string') {
    out.answered = { at: answered.at, byOwner: true }
  }
  return out
}

const parseEntries = (raw: string): PersonaLedgerEntry[] | null => {
  const parsed: unknown = JSON.parse(raw)
  // A bare array is accepted as well as the envelope: it costs two lines and makes
  // the file trivially hand-inspectable/repairable, which matters for a record the
  // owner is meant to be able to audit.
  const list = Array.isArray(parsed)
    ? parsed
    : parsed != null && typeof parsed === 'object'
      ? (parsed as Partial<PersonaLedgerStore>).entries
      : null
  if (!Array.isArray(list)) return null
  return list.flatMap((row) => {
    const e = sanitizeEntry(row)
    return e ? [e] : []
  })
}

/** TOLERANT read — the one every READER uses (the route, and the screen behind it).
 *
 *  An unreadable or corrupt ledger must never take the Persona screen down: the
 *  worst case is "the counts show zero", which is exactly what a fresh machine
 *  shows and costs the owner nothing but a statistic. Same fail-open trade as
 *  readPersonaCoursesStore, and the reason the route can never 500 on this file.
 *
 *  Returns OLDEST → NEWEST (append order). */
export const readLedger = async (): Promise<PersonaLedgerEntry[]> => {
  await ensureOpenGroundHome()
  let raw: string
  try {
    raw = await readFile(personaLedgerFile(), 'utf8')
  } catch (err) {
    if (!isMissingFileError(err)) {
      console.error('[openground:persona-ledger] ledger unreadable — reporting empty', err)
    }
    return []
  }
  try {
    return parseEntries(raw) ?? []
  } catch {
    console.error('[openground:persona-ledger] ledger corrupt — reporting empty')
    return []
  }
}

/** STRICT read, for the write path only. Differs from the reader above in the two
 *  places where shrugging would DESTROY the record rather than merely under-report
 *  it (lifted from personaCourses.ts / youCorpus.ts, same reasoning):
 *   • a non-ENOENT read failure (EACCES, EIO…) means the history IS there and we
 *     simply cannot see it — appending one row onto an assumed-empty list would
 *     erase every earlier decision. Refuse instead; recordDecision's catch turns
 *     that into "this one decision went unrecorded".
 *   • a PARSE failure preserves the damaged file aside as `.corrupt-<ts>` before we
 *     continue from empty, so a hand-mangled ledger stays recoverable. */
const readEntriesForWrite = async (): Promise<PersonaLedgerEntry[]> => {
  const file = personaLedgerFile()
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if (!isMissingFileError(err)) throw err
    return []
  }
  try {
    const parsed = parseEntries(raw)
    if (!parsed) throw new Error('persona-ledger store is not an entry list')
    return parsed
  } catch {
    // Best-effort preservation; if even the rename fails the throw propagates and
    // the caller records nothing rather than clobbering.
    await rename(file, `${file}.corrupt-${Date.now()}`)
    return []
  }
}

// Single-flight chain for every read-modify-write. Two windows on one machine (the
// Electron app and a browser on :5174) are a supported setup, and the overseer's
// detached brain chains settle whenever they settle — without this, two decisions
// landing together would each write the list they read and one would vanish. On
// globalThis for the same reason as the terminal pool and the courses chain: a
// `tsx watch` reload must not hand two module copies two different locks.
const lockGlobal = globalThis as typeof globalThis & {
  __openground_persona_ledger_chain?: Promise<unknown>
}

const withLedgerLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = lockGlobal.__openground_persona_ledger_chain ?? Promise.resolve()
  const run = prev.then(fn, fn)
  lockGlobal.__openground_persona_ledger_chain = run.catch(() => undefined)
  return run
}

const persist = async (entries: PersonaLedgerEntry[]): Promise<void> => {
  // Trim from the FRONT: the newest decision is the one the screen is about, so the
  // OLDEST row is what falls off. (Slicing the other way would keep a fossil and
  // drop the decision that just happened — the mutation this cap is tested against.)
  const store: PersonaLedgerStore = { version: 1, entries: entries.slice(-MAX_LEDGER_ENTRIES) }
  await atomicWriteJson(personaLedgerFile(), store, { mode: FILE_MODE, fsync: true })
}

/** The correlation key: "this project asked this question".
 *
 *  Stable across the escalation clamp (see {@link LEDGER_KEY_QUESTION_CHARS}) and
 *  across whitespace/case wobble, mirroring swarmEscalations' own receiptKey
 *  normalization so the two agree on what "the same question" means. It is a PREFIX
 *  key: two genuinely different questions sharing their first 2000 normalized chars
 *  in one project collide, and {@link markEscalationAnswered} then stamps the newest
 *  unanswered one — an acceptable miss for a statistic, and impossible to hit with
 *  real worker questions. */
export const ledgerMatchKey = (input: { projectPath: string; question: string }): string => {
  const norm = input.question
    .trim()
    .slice(0, LEDGER_KEY_QUESTION_CHARS)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return createHash('sha1').update(`${input.projectPath}|${norm}`).digest('hex')
}

/** Append ONE decision. NEVER THROWS — see the file header: a ledger write must not
 *  be able to break the swarm's proxy-answer path, so every failure (unreadable
 *  store, full disk, EACCES) is logged and swallowed. The caller gets no error to
 *  handle because there is nothing it could do with one. */
export const recordDecision = async (input: PersonaLedgerInput): Promise<void> => {
  try {
    const entry: PersonaLedgerEntry = {
      id: input.id ?? randomUUID(),
      at: input.at ?? new Date().toISOString(),
      projectPath: input.projectPath,
      verdict: input.verdict,
      question: input.question.slice(0, MAX_LEDGER_QUESTION),
      ...(input.why ? { why: input.why } : {}),
      ...(input.confidence ? { confidence: input.confidence } : {}),
      ...(input.key ? { key: input.key } : {}),
    }
    await withLedgerLock(async () => {
      await ensureOpenGroundHome()
      const entries = await readEntriesForWrite()
      entries.push(entry)
      await persist(entries)
    })
  } catch (err) {
    console.warn(`[openground:persona-ledger] decision not recorded: ${errMsg(err)}`)
  }
}

/** Verdicts a KEY-matched owner answer may be stamped onto: the ones where the
 *  stand-in DECLINED to speak. See {@link markEscalationAnswered}. */
const DEFERRED_VERDICTS: readonly PersonaLedgerVerdict[] = ['asked', 'abstained']

/** The owner answered the escalation this decision raised — stamp it.
 *
 *  THE HIGHEST-VALUE SIGNAL IN THE SYSTEM: the proxy asked, the human decided, and
 *  the human's answer is the correction the stand-in can be measured against. Match
 *  by ledger `id` when the caller has one, or by {@link ledgerMatchKey} (what the
 *  escalation seam has: a project and a question). The NEWEST unanswered match wins,
 *  so a recurring question stamps the round that actually reached the owner.
 *
 *  ⚠ THE KEY PATH MATCHES ONLY `asked` / `abstained` ROWS — the ones where the
 *  stand-in declined to speak. A `verdict:'answered'` row is REACHABLE under the
 *  same key and must never be stamped: when the overseer's drain cannot deliver a
 *  proxy answer to its worker it falls through to the inbox with the SAME
 *  projectPath and the SAME question (swarmOverseer, "proxy が回答済みだが worker
 *  への配達に失敗"), so the owner then answers an inbox item for a question the
 *  proxy DID answer. Stamping that row would make the screen assert the exact
 *  opposite of what happened — a delivery failure is not an owner correction —
 *  and would inflate the said-vs-did evidence with a case where the stand-in never
 *  deferred. The `{id}` path is deliberately NOT filtered: a caller naming one
 *  exact row already knows which decision it means.
 *
 *  This is the ONLY mutation an append-only ledger permits, and it is monotonic —
 *  an already-stamped entry is skipped, never re-dated.
 *
 *  NEVER THROWS (same contract as recordDecision — it runs on the owner's
 *  answer-an-escalation path, which must not fail because a statistic did).
 *  Returns whether an entry was stamped; a miss is ordinary (most escalations are
 *  template raises the proxy never saw). */
export const markEscalationAnswered = async (
  ref: { id: string } | { key: string },
  opts: { at?: string } = {},
): Promise<boolean> => {
  try {
    return await withLedgerLock(async () => {
      await ensureOpenGroundHome()
      const entries = await readEntriesForWrite()
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]
        if (e.answered) continue
        const hit =
          'id' in ref
            ? e.id === ref.id
            : e.key !== undefined && e.key === ref.key && DEFERRED_VERDICTS.includes(e.verdict)
        if (!hit) continue
        e.answered = { at: opts.at ?? new Date().toISOString(), byOwner: true }
        await persist(entries)
        return true
      }
      return false
    })
  } catch (err) {
    console.warn(`[openground:persona-ledger] owner-answer stamp not recorded: ${errMsg(err)}`)
    return false
  }
}

const emptyCounts = (): PersonaLedgerCounts => ({ answered: 0, asked: 0, abstained: 0 })

/** The counts the screen reads. PURE — no fs, injected `now` — so "this week it
 *  answered 3 and asked you 2" is testable without touching a disk, and the 7-day
 *  boundary can be driven from both sides.
 *
 *  WINDOW RULE (same as the portrait's recentCount): an entry counts as "this week"
 *  when `now - at <= 7 days`. An UNPARSEABLE stamp is never recent (it still counts
 *  in `total` — it happened, we just cannot place it); a stamp slightly in the
 *  FUTURE (clock skew) reads as recent rather than being dropped. */
export const summarizeLedger = (
  entries: readonly PersonaLedgerEntry[],
  now: number,
): PersonaLedgerSummary => {
  const week = emptyCounts()
  const total = emptyCounts()
  let lastMs = Number.NEGATIVE_INFINITY
  let lastAt: string | null = null
  for (const e of entries) {
    if (!VERDICTS.includes(e.verdict)) continue
    total[e.verdict] += 1
    const t = Date.parse(e.at)
    if (!Number.isFinite(t)) continue
    if (now - t <= LEDGER_WEEK_MS) week[e.verdict] += 1
    // Read from the stamps rather than "the last element": the file is append
    // ordered, but a hand-repaired one need not be, and lastAt drives a "last
    // active" line that must not read older than a row sitting right above it.
    if (t > lastMs) {
      lastMs = t
      lastAt = e.at
    }
  }
  return { week, total, lastAt }
}

/** GET /api/persona/ledger's body: the counts + the newest entries.
 *
 *  FAIL-OPEN by construction — readLedger already shrugs at an unreadable or
 *  corrupt file, so an unusable ledger is zeros and an empty list, never a 500 on
 *  a read-only screen. */
export const getPersonaLedger = async (
  deps: { now?: () => number } = {},
): Promise<PersonaLedgerResponse> => {
  const entries = await readLedger()
  return {
    summary: summarizeLedger(entries, deps.now?.() ?? Date.now()),
    // Newest first — the order the screen lists them in, decided ONCE here so
    // "which end is new" has exactly one answer in this codebase.
    recent: [...entries].reverse().slice(0, LEDGER_RECENT_LIMIT),
  }
}
