// supplyNotice — the engine→SUPPLY-DESK channel (owner decision 2026-09-22).
//
// WHY IT EXISTS. Inside a project the owner wants to talk to ONE seat — the
// supply officer (タスク窓口) — and never have to go and look at the commander's
// window. Until now there was no route in that direction at all: `POST
// /api/swarm/manager/say` carries supply→commander and nothing carries the
// reverse, so when the commander needed a decision the only destination was the
// owner's bell. MEASURED 2026-09-22: escalation 27537000 (a high-risk merge
// waiting for permission, 08:53) reached the bell and the OS toast, the supply
// officer never learned of it, and the owner opened the question inbox by hand
// at 09:03. The supply skill is deliberately "Never self-initiate", so it will
// never find such a thing by itself — something has to TELL it.
//
// THREE LANES PER PROJECT (reworked 2026-09-23 — 「社長」). Originally ONE slot,
// newest-overwrites, borrowed from the commander's notice slot. That was right
// for a status ping and WRONG for what this channel carries: a question that
// opened while the desk was mid-turn was silently replaced by the next event
// (a landing, a fatal), the desk never heard of it, and the worker sat waiting
// while the owner believed nothing needed them. Now:
//   • REPLIES — the commander's answers (FIFO, cap {@link SUPPLY_REPLY_CAP});
//   • IMPORTANT — questions, holds, fatals, stalls, deliveries (FIFO, cap
//     {@link SUPPLY_NOTICE_CAP}): each one is something the owner must judge or
//     know, so none may erase another;
//   • PROGRESS — "started X", "X is being checked", "X went back for rework":
//     ACCUMULATED into one digest line until the desk is free, so ten
//     transitions cost the owner's conversation one turn, not ten. No bell and no
//     toast — progress is conversation-only (the owner's 3-tier rule).
//   Delivered in that order, one line per desk per pass;
//   • CLEARED the moment it is delivered;
//   • KEPT while the president's desk is closed (owner decision 2026-09-23 —
//     the 監督 tab is gone, so the desk is the ONLY place these are retold). An
//     important notice has no TTL: it waits for the next desk and is told then,
//     with its age attached. A QUESTION is kept only while it is still open —
//     answering/dismissing it removes its line ({@link forgetSupplyQuestion}),
//     and a NEW desk (a fresh conversation) is re-told every question still
//     waiting on the owner, read from the escalation store itself
//     ({@link catchUpSupplyDesks});
//   • PERSISTED (the important lane only) to `~/.openground/supply-notice-queue.json`,
//     so an app restart — a self-update right after a delivery, above all —
//     loses neither a question nor a fatal, hold or delivery that the desk had
//     not heard yet. What was delivered is removed from the file, so a restart
//     does not retell it either;
//   • BUNDLED: several queued important notices go out as ONE line (one desk
//     turn), the WHOLE line kept within {@link SUPPLY_NOTICE_LINE_MAX} — the
//     longest single notice, i.e. what is known to type cleanly into a desk.
//   (Replies and the progress digest are still memory-only: a restart loses a
//   commander reply queued for a closed desk — the bell keeps it via
//   onReplyExpired only when it ages out in-process.)
//   • HELD, never forced, when the desk is generating / half-typed / showing a
//     menu ({@link noticeDeliverable} — the same three refusals, byte for byte).
//     A held notice is simply re-offered on the next pass. Missing is free.
//
// NO NEW POLLING. Delivery is attempted inline at queue time (so the common case
// — an idle desk — is instant), and anything held rides the supply desk loop
// that ALREADY runs (supplyContextCap.ts, 60s). Nothing here starts a timer.
//
// WHAT IS DELIVERED — only what needs the owner's judgement or awareness
// ({@link SUPPLY_NOTICE_INFO_EVENTS}): a question opened, a fatal event (which
// includes the high-risk force-hold), work landing on the trunk. Routine engine
// traffic (dispatch, heartbeats, review transitions, the daily fuel report,
// commander wake-ups) is NOT delivered: the supply desk is the owner's
// conversation and the single fattest context in the app (38.3% of fuel,
// measured — card vs-49), so every line sent is paid for twice.
//
// NO CTRL-U. `noticeDeliverable` has already established the input box is
// EMPTY, so there is nothing to clear; sending one anyway would be a keystroke
// into a desk we have not re-read. This channel never sends ESC either — that
// destructiveness is what the commander's NUDGE is for, and the reason it needs
// four conservative gates in front of it while this needs none.

import { basename, dirname, join, resolve } from 'path'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'fs'
import { openGroundHome } from './paths'
import { noticeDeliverable } from './deskDeliverable'
import { SUPPLY_DESK_LABEL } from './swarmSupply'
import { listOwnerDeskTerminals, isTerminalProcessAlive, getTerminalScreen, writeInput } from './terminal'
import type { AppNotification, SwarmInfoEvent } from '../types'

/** The INFO-grade events that reach the supply desk. Everything absent from this
 *  set is routine and deliberately stays out of the owner's conversation — see
 *  the file header. Fatal notifications are delivered WHOLESALE (the fatal lane
 *  is by definition "the unmanned loop broke"), which is also how the high-risk
 *  force-hold arrives: it is the fatal event 'high-risk-hold'. */
export const SUPPLY_NOTICE_INFO_EVENTS: ReadonlySet<SwarmInfoEvent> = new Set<SwarmInfoEvent>([
  // A question landed in the inbox and the owner's answer is what unblocks it.
  'escalation-open',
  // The same question, still unanswered hours later.
  'escalation-reminder',
  // STALLS — the owner asked to be told when something stops (2026-09-23):
  // finished work is piling up un-reviewed, or a worker says it is done with
  // nothing to show for it. Both mean "nothing is moving" in plain terms.
  'review-idle',
  'ready-without-work',
  // The app is about to replace itself with a build carrying the merged work —
  // the closest thing the engine has to "it was released".
  'self-update-requested',
])

/** Longest line we will type into the desk. A notification `detail` is a
 *  one-liner by contract, but it is composed at ~30 fire sites and one of them
 *  growing must not paste a paragraph into the owner's conversation. */
export const SUPPLY_NOTICE_MAX = 400

/** Tokens that must never be typed into the owner's conversation, in the order
 *  they are removed. A notification `detail` is written for a human, but several
 *  fire sites append operator vocabulary to it — the high-risk hold names up to
 *  three changed FILE PATHS, `guard-unwired` names `~/.claude/settings.json`,
 *  and an escalation with no `plainQuestion` falls back to the worker's own raw
 *  wording. The supply officer is required to keep that vocabulary out of what
 *  it SAYS; this keeps it out of what is TYPED, which the owner also reads.
 *
 *  Each match becomes '…' rather than being deleted, so a sentence that loses a
 *  path still reads as having had something there. */
const REDACTIONS: readonly [RegExp, string][] = [
  // MARKER BRACKETS, first and to NOTHING rather than '…'. Every line this app
  // types into a desk is identified by a 【…】 prefix the receiving skill matches
  // on — 【エンジンからの知らせ】 here, 【本人からの回答(escalation)】 in the rework
  // slot. The prefix is added AFTER this function runs, so a payload has no
  // legitimate use for the brackets at all, and leaving them lets a CALLER
  // forge a line's provenance: a commander reply (supply/say) whose text begins
  // 「【本人からの回答(escalation)】 …」 would read to the desk as the owner
  // speaking. '…' would be wrong here for the same reason: a forged marker is
  // not information that was redacted, it is a control token that was never
  // allowed. Verified 2026-09-22: no notification `detail` in the tree contains
  // 【 or 】, so nothing real is lost.
  [/[【】]/g, ''],
  [/\bswarm\/[\w.\-/]+/g, '…'], //            branch names
  [/(?:~|\.{1,2})?\/[\w.\-]+(?:\/[\w.\-]+)+/g, '…'], // absolute + relative paths
  [/\b[0-9a-f]{8,}\b/gi, '…'], //              card ids, UUIDs, short SHAs
]

/** Flatten to ONE typed line: control characters (CR above all — it would submit
 *  early and split the notice across two turns) become spaces, operator
 *  vocabulary is redacted ({@link REDACTIONS}), runs collapse, and the result is
 *  capped. Pure. */
export const sanitizeSupplyNotice = (raw: string): string => {
  let out = Array.from(raw)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0
      return cp < 0x20 || cp === 0x7f ? ' ' : ch
    })
    .join('')
  for (const [re, to] of REDACTIONS) out = out.replace(re, to)
  // Cap by CODE POINT, not UTF-16 unit: slicing a string at 400 units can land
  // between a surrogate pair and type a lone surrogate into the PTY.
  return Array.from(out.replace(/\s+/g, ' ').trim()).slice(0, SUPPLY_NOTICE_MAX).join('')
}

/** The prefix every engine-sent line carries, so the supply officer can tell a
 *  notice from something the owner typed. Matched by skills/supply/SKILL.md —
 *  code-matched text, frozen (CLAUDE.md "Language policy"). */
export const SUPPLY_NOTICE_PREFIX = '【エンジンからの知らせ】'

/** The instruction tail. The supply officer's whole job with a notice is to
 *  RETELL it to the owner, who is not a programmer — so the obligation travels
 *  with the notice rather than living only in the skill file, which a compacted
 *  desk may no longer have in view. */
const SUPPLY_NOTICE_TAIL = '(自動の知らせ。オーナーに平易に1〜3行で。専門用語・ID不可)'

/** Progress digest tail — shorter still: it is news, not a decision, and the
 *  owner asked not to be asked anything about it. */
const SUPPLY_PROGRESS_TAIL = '(自動の進捗。オーナーに1〜2行で短く。質問しない)'

/** Wrap a plain summary into the line that gets typed. Pure. */
export const supplyNoticeLine = (summary: string): string =>
  `${SUPPLY_NOTICE_PREFIX}${sanitizeSupplyNotice(summary)} ${SUPPLY_NOTICE_TAIL}`

/** The progress digest's line. Same frozen prefix (the skill matches one engine
 *  prefix); the content starts with 「進捗:」 so the desk can tell it is news. Pure. */
export const supplyProgressLine = (items: readonly string[]): string =>
  `${SUPPLY_NOTICE_PREFIX}${sanitizeSupplyNotice(`進捗: ${items.join(' / ')}`)} ${SUPPLY_PROGRESS_TAIL}`

/** How many undelivered IMPORTANT notices a project may hold. Sized for a whole
 *  absence (the desk may stay closed for a day): past it the OLDEST is dropped —
 *  the bell still holds it, and an open question is re-read from the store when
 *  the next desk opens ({@link catchUpSupplyDesks}), so the loss is bounded to
 *  news. */
export const SUPPLY_NOTICE_CAP = 30

/** A notice delivered at least this long after it was raised says so — 「約2時間前」
 *  — so a desk opened in the evening does not retell a morning event as news. */
export const SUPPLY_NOTICE_AGE_LABEL_MS = 10 * 60 * 1000

/** Plain-Japanese age, e.g. 「約15分前」「約3時間前」. Pure. */
export const noticeAgeLabel = (ms: number): string => {
  const min = Math.round(ms / 60_000)
  return min < 60 ? `約${min}分前` : `約${Math.round(min / 60)}時間前`
}

/** How many distinct items one progress digest carries. Past it the oldest
 *  item drops (the Board still shows everything). */
export const SUPPLY_PROGRESS_MAX_ITEMS = 6

/** The prefix a COMMANDER REPLY carries (owner decision 2026-09-22 — 「社長と話す」).
 *  Deliberately distinct from {@link SUPPLY_NOTICE_PREFIX}: the desk relayed the
 *  owner's sentence to the commander and told them 「聞いてきます」, so the answer
 *  must be recognisable as the ANSWER TO THAT, not as fresh engine news the desk
 *  would retell as if unprompted. Matched by skills/supply/SKILL.md — code-matched
 *  text, frozen (CLAUDE.md "Language policy"). */
export const SUPPLY_REPLY_PREFIX = '【司令官からの返事】'

/** The reply's instruction tail. Same reason the notice has one: the obligation
 *  travels with the line, because a compacted desk may no longer hold the skill
 *  file in view. */
const SUPPLY_REPLY_TAIL =
  'これはあなたが司令官に聞いたことへの返事です。オーナーに平易な言葉で伝えてください(専門用語・ブランチ名・IDは書かない)。'

/** Wrap a commander reply into the line that gets typed. Pure. */
export const supplyReplyLine = (summary: string): string =>
  `${SUPPLY_REPLY_PREFIX}${sanitizeSupplyNotice(summary)} ${SUPPLY_REPLY_TAIL}`

/** How many undelivered replies a project may hold.
 *
 *  A QUEUE, not the news slot's single overwriting cell, and the difference is
 *  the whole point. Newest-overwrites is right for news ("the latest state of
 *  the world wins") and WRONG for an answer: two replies landing inside one
 *  60-second pass would silently erase one, and the owner would be left waiting
 *  for a reply to a question that had already been answered. Bounded anyway,
 *  because unbounded would let a looping commander paste a wall of text into the
 *  owner's conversation — past the cap the OLDEST is dropped (it is the one most
 *  likely already superseded) and the bell keeps it via {@link
 *  SupplyNoticeDeps.onReplyExpired}. */
export const SUPPLY_REPLY_CAP = 5

/**
 * The line this notification should put on the supply desk, or null when it is
 * not one the owner needs to hear about. PURE — the allowlist is assertable
 * without a desk, a pool or a project.
 *
 * The notification's own `detail` is reused as the summary rather than a second
 * per-event phrasebook: those strings are already Japanese one-liners written
 * for a human (CLAUDE.md "Language policy" — notification `detail` is
 * owner-facing text), and a parallel set of wordings here would drift from them
 * the first time a fire site was reworded.
 */
export const supplyNoticeFor = (n: AppNotification): string | null => {
  const text = supplyNoticeText(n)
  return text === null ? null : supplyNoticeLine(text)
}

/** The raw summary {@link supplyNoticeFor} wraps, or null. Pure. */
const supplyNoticeText = (n: AppNotification): string | null => {
  if (n.kind === 'swarm-fatal' && n.swarmFatal) return n.swarmFatal.detail
  if (n.kind === 'swarm-info' && n.swarmInfo && SUPPLY_NOTICE_INFO_EVENTS.has(n.swarmInfo.event)) {
    return n.swarmInfo.detail
  }
  return null
}

/** The project this notification concerns, or null. A notification with no
 *  project (the boot-wide 'engine-resume-suppressed', the home-data
 *  'data-integrity') has no desk to address and is simply not delivered — the
 *  bell and the OS toast still carry it. */
const noticeProject = (n: AppNotification): string | null =>
  (n.kind === 'swarm-fatal' ? n.swarmFatal?.projectPath : n.swarmInfo?.projectPath) || null

export interface SupplyNoticeDeps {
  /** Live supply desks, as {terminalId, cwd}. */
  desks: () => { id: string; cwd: string }[]
  screen: (terminalId: string) => string | null
  /** Type the line into the desk; true iff the keystrokes were written. */
  write: (terminalId: string, data: string) => boolean
  /** Injectable clock — {@link SUPPLY_NOTICE_TTL_MS} is measured against it. */
  now: () => number
  /** Where a REPLY goes when it expired undelivered ({@link queueSupplyReply}).
   *  A news item that ages out is simply dropped — the bell already holds it. A
   *  reply is the answer to a question the OWNER asked, so dropping it silently
   *  leaves them waiting forever for something that already arrived. */
  onReplyExpired: (projectPath: string, line: string) => void
  /** The questions currently waiting on the OWNER in this project (open, owner
   *  lane), as {escalation id, owner-facing detail}. Read by
   *  {@link catchUpSupplyDesks} when a new desk appears. */
  openQuestions: (projectPath: string) => Promise<{ id: string; detail: string; at?: number }[]>
}

const defaultDeps: SupplyNoticeDeps = {
  desks: () =>
    listOwnerDeskTerminals()
      .filter((d) => d.deskLabel === SUPPLY_DESK_LABEL && isTerminalProcessAlive(d.id))
      // NEWEST FIRST, and that ordering is load-bearing. `listOwnerDeskTerminals`
      // returns pool INSERTION order (oldest first), and a project can legitimately
      // hold two live supply desks — `adoptLiveSupplyDesk` hands the client
      // `alive[0]` of a newest-first list and deliberately does NOT kill the
      // extras («余分な卓は Terminal タブから閉じてください»). Sorted the other way,
      // the notice is typed into the ORPHAN the owner is not looking at, the slot
      // is cleared, and the news is gone — the exact silence this channel exists
      // to end. Same order as listLiveDesksIn, so every reader agrees which desk
      // "the" supply desk is.
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .map((d) => ({ id: d.id, cwd: d.cwd })),
  screen: getTerminalScreen,
  write: writeInput,
  now: () => Date.now(),
  // Lazy + dynamic on purpose: swarmNotifications imports THIS module (it calls
  // noticeToSupply for every notification it creates), so a static import back
  // would close a cycle at module-init time. Fire-and-forget — a failed bell
  // write must not throw inside a delivery pass.
  onReplyExpired: (projectPath, line) => {
    void import('./swarmNotifications')
      .then(({ createSwarmInfoNotification }) =>
        createSwarmInfoNotification({
          event: 'commander-reply',
          detail: line,
          projectPath,
        }),
      )
      .catch(() => {})
  },
  // Dynamic for the same reason: swarmEscalations imports THIS module (to drop
  // an answered question's line), so a static import back would be a cycle.
  openQuestions: async (projectPath) => {
    const { listOpenOwnerQuestionsStrict, ownerQuestionDetail } = await import('./swarmEscalations')
    const open = await listOpenOwnerQuestionsStrict(projectPath)
    return open.map((e) => {
      // When it became the OWNER's question (a commander-lane one handed on
      // later is told by that time, not by when a worker first asked it).
      const at = Date.parse(e.raisedToOwnerAt ?? e.createdAt)
      return { id: e.id, detail: ownerQuestionDetail(e), ...(Number.isFinite(at) ? { at } : {}) }
    })
  },
}

/** The key both sides of the match are reduced to.
 *
 *  The two spellings genuinely come from different pipelines: a notification's
 *  `projectPath` is canonicalized (engine.path / the escalation store), while a
 *  desk's `cwd` is the RAW string its launcher was handed — `requireProjectPath`
 *  validates the canonical form but returns the client's original. A raw `===`
 *  therefore loses every notice for a desk opened as `/repo/x/` (trailing slash
 *  passes validation), forever and silently.
 *
 *  `resolve` is the sync normalisation that covers it (trailing slash, `.`/`..`,
 *  duplicate separators). It does NOT resolve symlinks — `canonicalize` would,
 *  but it is async and this runs inside a synchronous delivery pass; a project
 *  reached through two different symlinked spellings still misses, which is the
 *  same limitation the PTY pool's own `listLiveDesksIn` comparison has. */
const deskKey = (p: string): string => {
  try {
    return resolve(p)
  } catch {
    return p
  }
}

/**
 * How long an undelivered PROGRESS digest or commander REPLY stays worth saying.
 * Past this progress is DROPPED and a reply is handed to the bell. IMPORTANT
 * notices no longer expire (2026-09-23 — the desk is now their only retelling;
 * see the file header): the staleness below is solved for them by withdrawing
 * an answered question ({@link forgetSupplyQuestion}) and by the age label.
 *
 * WHY IT EXPIRES AT ALL (the original reasoning, still true of progress). The commander's twin slot lives on
 * `ProjectEngine.managerNotice` and is recomputed from live state every pass, so
 * it cannot go stale. This one is a fire-and-forget push, so without a clock a
 * notice for a project with no supply desk waits for the LIFE OF THE PROCESS and
 * is typed the instant a desk first appears: a question that opened at 09:00 and
 * was answered from the inbox at 09:05 would greet the owner at 17:00 as if it
 * were news. That is worse than silence — it is wrong, and it spends a turn on
 * the app's fattest context to be wrong.
 *
 * 30 minutes is longer than any desk stays busy mid-turn (so it never drops a
 * notice the desk was merely slow to accept) and far shorter than the gap that
 * makes news stale. The bell and the OS toast still hold the event either way,
 * so an expired notice is not a lost one.
 */
export const SUPPLY_NOTICE_TTL_MS = 30 * 60 * 1000

interface PendingNotice {
  line: string
  /** The sanitized summary (IMPORTANT lane) — what a bundle is built from and
   *  what is persisted. */
  text?: string
  /** When it was raised — the input to {@link SUPPLY_NOTICE_TTL_MS} (replies,
   *  progress) and to the age label (important). */
  at: number
  /** The question this line retells — set on escalation-open/-reminder, so the
   *  line can be withdrawn once the question is answered. */
  escalationId?: string
}

/** The IMPORTANT queue per project. On `globalThis` so it survives `tsx watch`
 *  reloads in dev, like every other in-memory server map here. (A new global
 *  name: the old one held a single-slot shape a reloaded module must not read.) */
declare global {
  // eslint-disable-next-line no-var
  var __openground_supply_notice_q: Map<string, PendingNotice[]> | undefined
  // eslint-disable-next-line no-var
  var __openground_supply_reply: Map<string, PendingNotice[]> | undefined
  // eslint-disable-next-line no-var
  var __openground_supply_progress: Map<string, { items: string[]; at: number }> | undefined
  // eslint-disable-next-line no-var
  var __openground_supply_seen_desks: Set<string> | undefined
  // eslint-disable-next-line no-var
  var __openground_supply_told: Map<string, Set<string>> | undefined
  // eslint-disable-next-line no-var
  var __openground_supply_resolved: Set<string> | undefined
  // eslint-disable-next-line no-var
  var __openground_supply_q_loaded: { loaded: boolean } | undefined
}
const pending: Map<string, PendingNotice[]> =
  globalThis.__openground_supply_notice_q ?? (globalThis.__openground_supply_notice_q = new Map())
/** The PROGRESS digest per project — accumulated, not queued. */
const progress: Map<string, { items: string[]; at: number }> =
  globalThis.__openground_supply_progress ?? (globalThis.__openground_supply_progress = new Map())
/** The reply QUEUE per project — see {@link SUPPLY_REPLY_CAP} for why replies
 *  are not allowed to share the news slot. */
const replies: Map<string, PendingNotice[]> =
  globalThis.__openground_supply_reply ?? (globalThis.__openground_supply_reply = new Map())

/** Desk terminal ids already caught up ({@link catchUpSupplyDesks}). */
const seenDesks: Set<string> =
  globalThis.__openground_supply_seen_desks ?? (globalThis.__openground_supply_seen_desks = new Set())

/** Per desk terminal id: the questions (escalation ids) already typed into it,
 *  so the catch-up never retells one this conversation has already heard. */
const toldTo: Map<string, Set<string>> =
  globalThis.__openground_supply_told ?? (globalThis.__openground_supply_told = new Map())

/** Questions answered/dismissed recently — refused by pushImportant. */
const resolvedQuestions: Set<string> =
  globalThis.__openground_supply_resolved ?? (globalThis.__openground_supply_resolved = new Set())
const RESOLVED_QUESTIONS_MAX = 500

/** The queue key for a fatal that names no project (app-wide: self-update
 *  rollback / canary-failed, engine-resume-suppressed, data-integrity). Told once,
 *  to whichever president desk can take it first. Not a path, so never deskKey'd. */
const APP_WIDE = '*app-wide*'

/** Whether the persisted important queue has been read into `pending` in this
 *  process (globalThis — a tsx reload keeps both the map and the flag). */
const diskState: { loaded: boolean } =
  globalThis.__openground_supply_q_loaded ?? (globalThis.__openground_supply_q_loaded = { loaded: false })

const queueFile = (): string => join(openGroundHome(), 'supply-notice-queue.json')

/** Warn ONCE per distinct message, so a failure that repeats every pass (a
 *  store that stays unreadable) is visible in the log without flooding it. */
const warned: Set<string> = new Set()
const warnOnce = (key: string, msg: string): void => {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[supplyNotice] ${msg}`)
}

/** Append without duplicating (two QUESTIONS are the same only if they are the
 *  same question; other notices dedup on their text), then cap — evicting news
 *  before questions. Shared by the push path and the disk merge. */
const addUnique = (q: PendingNotice[], n: PendingNotice): void => {
  const dup = q.some((p) =>
    n.escalationId !== undefined && p.escalationId !== undefined ? p.escalationId === n.escalationId : p.line === n.line,
  )
  if (!dup) q.push(n)
  // Over the cap, news goes before questions: a question dropped here would not
  // be re-read for a desk that was already caught up.
  while (q.length > SUPPLY_NOTICE_CAP) {
    const news = q.findIndex((p) => !p.escalationId)
    q.splice(news >= 0 ? news : 0, 1)
  }
}

/**
 * Read the persisted important queue into memory — once per process, and ONLY
 * once it has actually been read. The same rule as the strict escalation read
 * (S1), for the same reason: a tolerant "any error = empty" load followed by the
 * next write-through would OVERWRITE the file with an empty queue and destroy
 * every held fatal / hold / delivery on one transient error.
 *   • ENOENT → genuinely empty (first run); loaded.
 *   • a read error (EIO, EMFILE, EACCES …) → NOT loaded: retried on the next
 *     call, and {@link savePending} writes nothing meanwhile (what is queued in
 *     memory is merged in when the read finally succeeds).
 *   • unparseable / wrong shape → the file is MOVED ASIDE to `.corrupt-<ts>`
 *     (kept for inspection, never deleted) and the queue starts fresh; loaded.
 */
const ensureLoaded = (): void => {
  if (diskState.loaded) return
  let file: string
  let raw: string
  try {
    file = queueFile()
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      diskState.loaded = true
      return
    }
    // No pinned home (tests) has no code and nothing to protect — treat as
    // empty so the rest of the channel works.
    if (!code) {
      diskState.loaded = true
      return
    }
    warnOnce(`load:${code}`, `could not read the saved notice queue (${code}); will retry, not overwriting it`)
    return
  }
  let entries: unknown[]
  try {
    const parsed = JSON.parse(raw) as { queues?: unknown }
    if (!Array.isArray(parsed?.queues)) throw new Error('not {queues: []}')
    entries = parsed.queues
  } catch (e) {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // Could not move it aside — do NOT overwrite it; try again next time.
      warnOnce('load:corrupt-stuck', `saved notice queue is damaged and could not be moved aside: ${String(e)}`)
      return
    }
    warnOnce('load:corrupt', `saved notice queue was damaged; moved aside and starting fresh`)
    diskState.loaded = true
    return
  }
  // Merge: what was on disk comes first (it is older), then anything queued in
  // memory while the read was failing. An answered question is not revived.
  const memory = new Map(pending)
  pending.clear()
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) continue
    const q: PendingNotice[] = []
    for (const it of entry[1] as Record<string, unknown>[]) {
      if (!it || typeof it.text !== 'string' || typeof it.at !== 'number') continue
      const escalationId = typeof it.escalationId === 'string' && it.escalationId ? it.escalationId : undefined
      if (escalationId && resolvedQuestions.has(escalationId)) continue
      addUnique(q, { text: it.text, line: supplyNoticeLine(it.text), at: it.at, ...(escalationId ? { escalationId } : {}) })
    }
    if (q.length) pending.set(entry[0], q)
  }
  for (const [k, mq] of Array.from(memory)) {
    const q = pending.get(k) ?? []
    for (const n of mq) addUnique(q, n)
    if (q.length) pending.set(k, q)
  }
  diskState.loaded = true
  if (memory.size) savePending()
}

let tmpSeq = 0

/** Write the important queue through — the repo's atomic-write discipline
 *  (atomicWrite.ts) in a synchronous form, because every caller is a synchronous
 *  pass: a UNIQUE temp name (two processes on one home — dev beside the app —
 *  never share one), data fsync'd before the rename (a power cut cannot publish
 *  an empty file), owner-only mode (it holds question text). Never while the
 *  file has not been read ({@link ensureLoaded}) — that is how a write-through
 *  would erase what it never saw. Does not create the home dir (the home
 *  migration owns that). Best effort. */
const savePending = (): void => {
  if (!diskState.loaded) return
  let tmp: string | null = null
  try {
    const file = queueFile()
    const queues = Array.from(pending, ([k, q]) => [
      k,
      q.map((p) => ({ text: p.text ?? '', at: p.at, ...(p.escalationId ? { escalationId: p.escalationId } : {}) })),
    ])
    tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${tmpSeq++}`)
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify({ version: 1, queues }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    tmp = null
  } catch {
    /* best effort */
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

/** Tests only. `keepDisk:true` = what an app RESTART does: the in-memory state is
 *  gone, the persisted important queue is read back on next use. */
export const resetSupplyNoticeState = (opts: { keepDisk?: boolean } = {}): void => {
  diskState.loaded = false
  warned.clear()
  if (!opts.keepDisk) {
    try {
      rmSync(queueFile(), { force: true })
    } catch {
      /* no pinned home — nothing persisted */
    }
  }
  toldTo.clear()
  resolvedQuestions.clear()
  pending.clear()
  replies.clear()
  progress.clear()
  seenDesks.clear()
}

/** The NEXT news line each project would hear (important first, else the
 *  progress digest) — for tests and diagnostics. */
export const peekSupplyNotices = (): ReadonlyMap<string, string> => {
  ensureLoaded()
  const out = new Map<string, string>()
  for (const [k, q] of Array.from(pending)) if (q[0]) out.set(k, q[0].line)
  for (const [k, p] of Array.from(progress)) if (!out.has(k) && p.items.length) out.set(k, supplyProgressLine(p.items))
  return out
}

/** Every queued IMPORTANT line per project, oldest first — for tests. */
export const peekSupplyImportant = (): ReadonlyMap<string, readonly string[]> => {
  ensureLoaded()
  return new Map(Array.from(pending, ([k, v]) => [k, v.map((n) => n.line)] as const))
}

/** The accumulated progress items per project — for tests. */
export const peekSupplyProgress = (): ReadonlyMap<string, readonly string[]> =>
  new Map(Array.from(progress, ([k, v]) => [k, [...v.items]] as const))

/** The queued replies per project, oldest first — for tests and diagnostics. */
export const peekSupplyReplies = (): ReadonlyMap<string, readonly string[]> =>
  new Map(Array.from(replies, ([k, v]) => [k, v.map((r) => r.line)] as const))

/**
 * Deliver every pending notice it can. A desk that is busy / half-typed /
 * showing a menu keeps its notice for the next pass; a delivered one is cleared
 * immediately. Returns the project paths delivered this pass. Never throws — a
 * failed pass must not kill the loop that calls it.
 */
export const flushSupplyNotices = (partial: Partial<SupplyNoticeDeps> = {}): string[] => {
  const deps = { ...defaultDeps, ...partial }
  const delivered: string[] = []
  ensureLoaded()
  // BOTH lanes, or the pass bails before it ever looks at the replies — which
  // it did, and the reply tests caught it: with no news queued, a commander's
  // answer sat in the queue until some unrelated notice happened to arrive.
  if (pending.size === 0 && replies.size === 0 && progress.size === 0) return delivered
  const now = deps.now()
  // Stale PROGRESS is dropped rather than delivered late — see
  // SUPPLY_NOTICE_TTL_MS. IMPORTANT notices are NOT: they wait for the next desk
  // (file header), bounded by SUPPLY_NOTICE_CAP.
  for (const [key, p] of Array.from(progress)) {
    if (now - p.at > SUPPLY_NOTICE_TTL_MS) progress.delete(key)
  }
  // Replies age out on the same clock, but they are HANDED ON rather than
  // dropped (see SupplyNoticeDeps.onReplyExpired) — an answer the owner is
  // waiting for must not simply vanish because their desk was closed.
  for (const [key, q] of Array.from(replies)) {
    const live = q.filter((r) => {
      if (now - r.at <= SUPPLY_NOTICE_TTL_MS) return true
      try {
        deps.onReplyExpired(key, r.line)
      } catch {
        /* best effort — the bell is a fallback, not a correctness precondition */
      }
      return false
    })
    if (live.length === 0) replies.delete(key)
    else replies.set(key, live)
  }
  let desks: { id: string; cwd: string }[] = []
  try {
    desks = deps.desks()
  } catch {
    return delivered // no desk list, nothing to do; everything stays queued
  }
  // ONE desk per project: the first (= newest, see defaultDeps.desks) desk of a
  // project is "the" president. An older orphan desk in the same project must
  // not take a line just because the newest one is busy — the owner is looking
  // at the newest one and would never hear it.
  const served = new Set<string>()
  // Project-less fatals (APP_WIDE) go to the first desk that can take them.
  for (const desk of desks) {
    // PER DESK, not around the loop: one throwing screen()/write() must not
    // abort delivery for every project after it in the list.
    try {
      const key = deskKey(desk.cwd)
      if (served.has(key)) continue
      served.add(key)
      // ONE line per desk per pass, and a REPLY goes before news. The order is
      // not a preference: the owner is sitting there having been told
      // 「聞いてきます」, and the desk starts generating the moment it receives a
      // line — so a second write in the same pass would hit a busy desk and be
      // held anyway. Answering first means the wait the owner actually notices
      // is the one that ends.
      const queue = replies.get(key)
      const reply = queue?.[0] ?? null
      // App-wide fatals first: they are rare and concern the whole app.
      const importantKey = reply ? null : pending.get(APP_WIDE)?.length ? APP_WIDE : pending.get(key)?.length ? key : null
      const bundle = importantKey ? takeBundle(pending.get(importantKey) ?? [], now) : null
      const important = bundle ? bundle.items[0] : null
      const digest = reply || important ? null : progress.get(key)
      const importantLine = bundle?.line
      const line =
        reply?.line ?? importantLine ?? (digest && digest.items.length ? supplyProgressLine(digest.items) : null)
      if (!line) continue
      if (!noticeDeliverable(deps.screen(desk.id))) continue // busy / half-typed / menu — next pass
      if (!deps.write(desk.id, `${line}\r`)) continue
      if (reply && queue) {
        queue.shift()
        if (queue.length === 0) replies.delete(key)
      } else if (bundle) {
        const told = toldTo.get(desk.id) ?? new Set<string>()
        for (const it of bundle.items) if (it.escalationId) told.add(it.escalationId)
        toldTo.set(desk.id, told)
        const ik = importantKey ?? key
        const q = pending.get(ik)
        q?.splice(0, bundle.items.length)
        if (!q || q.length === 0) pending.delete(ik)
        savePending()
      } else {
        progress.delete(key)
      }
      delivered.push(key)
    } catch {
      /* best effort — a notice that missed stays queued for the next pass */
    }
  }
  return delivered
}

/** Append to a project's IMPORTANT queue (dedup on identical line or on the
 *  same question — a reminder never queues behind its own unsaid question; cap). */
const pushImportant = (key: string, summary: string, at: number, escalationId?: string): void => {
  ensureLoaded()
  // A question answered while its line was being composed (catch-up and the S11
  // reminder both read the store, then await) must not be queued afterwards.
  if (escalationId && resolvedQuestions.has(escalationId)) return
  const text = sanitizeSupplyNotice(summary)
  if (!text) return
  const line = supplyNoticeLine(text)
  const q = pending.get(key) ?? []
  addUnique(q, { line, text, at, ...(escalationId ? { escalationId } : {}) })
  pending.set(key, q)
  savePending()
}

/** The longest WHOLE line a bundle may be: the longest single notice (prefix +
 *  a {@link SUPPLY_NOTICE_MAX} summary + tail) — the size already typed into
 *  desks; a longer line risks its Enter being dropped, and a bundle is counted
 *  as told once written. A notice that does not fit waits for the next bundle. */
export const SUPPLY_NOTICE_LINE_MAX = SUPPLY_NOTICE_PREFIX.length + SUPPLY_NOTICE_MAX + 1 + SUPPLY_NOTICE_TAIL.length

const SUPPLY_BUNDLE_TAIL = '(自動の知らせ・まとめ。件ごとに平易に短く。専門用語・ID不可)'

/** The next line for a queue: its oldest notice, plus as many following ones as
 *  fit in {@link SUPPLY_NOTICE_LINE_MAX} — so a backlog (a desk opening after a
 *  day away) costs a few turns of the owner's conversation, not one per notice.
 *  Each item carries its own age. Pure. */
const takeBundle = (q: readonly PendingNotice[], now: number): { items: PendingNotice[]; line: string } | null => {
  const first = q[0]
  if (!first) return null
  const aged = (p: PendingNotice) =>
    `${now - p.at >= SUPPLY_NOTICE_AGE_LABEL_MS ? `(${noticeAgeLabel(now - p.at)}) ` : ''}${p.text ?? sanitizeSupplyNotice(p.line)}`
  const bundleLine = (its: readonly PendingNotice[]) =>
    `${SUPPLY_NOTICE_PREFIX}(${its.length}件まとめて) ${its.map((p, i) => `[${i + 1}] ${aged(p)}`).join(' ')} ${SUPPLY_BUNDLE_TAIL}`
  const items = [first]
  for (const p of q.slice(1)) {
    if (bundleLine([...items, p]).length > SUPPLY_NOTICE_LINE_MAX) break
    items.push(p)
  }
  if (items.length === 1) {
    const line =
      now - first.at >= SUPPLY_NOTICE_AGE_LABEL_MS
        ? first.line.replace(SUPPLY_NOTICE_PREFIX, `${SUPPLY_NOTICE_PREFIX}(${noticeAgeLabel(now - first.at)}の知らせ) `)
        : first.line
    return { items, line }
  }
  return { items, line: bundleLine(items) }
}

/**
 * Put ONE important line on the project's supply desk — queued behind any
 * other important line, never overwriting one (see the file header). Tries to
 * deliver immediately so an idle desk hears it at once; anything held is
 * re-offered by {@link flushSupplyNotices} on the supply loop's next pass.
 *
 * `projectPath` must be the canonical project path (what a desk's `cwd` reads
 * as) — notification payloads already carry it canonicalized.
 */
export const queueSupplyNotice = (
  projectPath: string,
  summary: string,
  deps: Partial<SupplyNoticeDeps> = {},
): void => {
  if (!projectPath) return
  pushImportant(deskKey(projectPath), summary, (deps.now ?? Date.now)())
  flushSupplyNotices(deps)
}

/**
 * Add ONE progress item ("「X」に取りかかりました") to the project's digest. Items
 * accumulate until the desk is free and go out as ONE line; progress never rings
 * the bell. An identical item is not repeated.
 */
export const queueSupplyProgress = (
  projectPath: string,
  item: string,
  deps: Partial<SupplyNoticeDeps> = {},
): void => {
  const text = sanitizeSupplyNotice(item)
  if (!projectPath || !text) return
  const key = deskKey(projectPath)
  const cur = progress.get(key) ?? { items: [], at: (deps.now ?? Date.now)() }
  if (!cur.items.includes(text)) cur.items.push(text)
  while (cur.items.length > SUPPLY_PROGRESS_MAX_ITEMS) cur.items.shift()
  cur.at = (deps.now ?? Date.now)()
  progress.set(key, cur)
  flushSupplyNotices(deps)
}

/**
 * Put ONE commander REPLY on the project's supply desk — the missing return leg
 * of `POST /api/swarm/manager/say` (owner decision 2026-09-22).
 *
 * WHY THIS EXISTS. The desk could already speak to the commander and could not
 * hear back: the commander answered in its own window, which nobody reads. So
 * the owner could say 「入れて」 but never 「入れて大丈夫か聞いて」 — the round trip
 * had no return path, and that single missing leg is what kept the desk from
 * being the one seat the owner talks to.
 *
 * Queued (never overwriting — {@link SUPPLY_REPLY_CAP}), delivered ahead of news
 * on the pass that already walks every desk, and handed to the bell if it ages
 * out. Same three refusals as every other engine→desk write: a busy, half-typed
 * or menu-showing desk keeps the reply for the next pass.
 *
 * Returns how many replies are still WAITING for this project afterwards, so a
 * caller can say 「届けました」 or 「今は取り込み中なので後で」 honestly. 0 means the
 * queue drained, i.e. this line was typed. (Not a bare boolean: with an earlier
 * reply still queued, the delivery this call triggers is of the OLDER one, and
 * "delivered: true" would then be a lie about the line the caller just handed
 * over.)
 */
export const queueSupplyReply = (
  projectPath: string,
  summary: string,
  deps: Partial<SupplyNoticeDeps> = {},
): number => {
  const line = supplyReplyLine(summary)
  if (!projectPath || line.length === 0) return 0
  const key = deskKey(projectPath)
  const q = replies.get(key) ?? []
  q.push({ line, at: (deps.now ?? Date.now)() })
  // Over the cap the OLDEST goes, and it goes to the bell rather than nowhere.
  while (q.length > SUPPLY_REPLY_CAP) {
    const dropped = q.shift()
    if (!dropped) break
    try {
      ;(deps.onReplyExpired ?? defaultDeps.onReplyExpired)(key, dropped.line)
    } catch {
      /* best effort */
    }
  }
  replies.set(key, q)
  flushSupplyNotices(deps)
  return replies.get(key)?.length ?? 0
}

/**
 * The hook swarmNotifications calls for every notification it creates: deliver
 * it to the project's supply desk IF it is one the owner must judge or know
 * about. A no-op for everything else, and for anything with no project.
 */
export const noticeToSupply = (n: AppNotification, deps: Partial<SupplyNoticeDeps> = {}): void => {
  const project = noticeProject(n)
  const text = supplyNoticeText(n)
  if (text === null) return
  // A project-less FATAL still has to reach the owner (the 監督 feed that used to
  // show it on every project is gone) — it rides the app-wide lane. Project-less
  // info events stay bell-only.
  if (!project && n.kind !== 'swarm-fatal') return
  const escalationId = n.kind === 'swarm-info' ? n.swarmInfo?.escalationId : undefined
  pushImportant(project ? deskKey(project) : APP_WIDE, text, (deps.now ?? Date.now)(), escalationId || undefined)
  flushSupplyNotices(deps)
}

/**
 * Withdraw every queued line that retells this question. Called when it is
 * answered or dismissed (swarmEscalations.ts) — this is what makes it safe for
 * questions to have no TTL: an undelivered question can wait for a closed desk
 * as long as it takes, and can never be told after it stopped being true.
 */
export const forgetSupplyQuestion = (escalationId: string): void => {
  resolvedQuestions.add(escalationId)
  // Bounded: only the race window (one store read) needs the memory.
  while (resolvedQuestions.size > RESOLVED_QUESTIONS_MAX) {
    const oldest = resolvedQuestions.values().next().value
    if (oldest === undefined) break
    resolvedQuestions.delete(oldest)
  }
  ensureLoaded()
  let changed = false
  for (const [key, q] of Array.from(pending)) {
    const live = q.filter((p) => p.escalationId !== escalationId)
    if (live.length === q.length) continue
    changed = true
    if (live.length === 0) pending.delete(key)
    else pending.set(key, live)
  }
  if (changed) savePending()
}

/**
 * The president's desk just OPENED (or was replaced): tell it every question
 * still waiting on the owner, then deliver as usual. Rides the supply loop
 * (60s). A desk is caught up once per terminal id — a reloaded browser tab
 * re-adopting the same live desk is not a new conversation and hears nothing
 * twice; a restarted desk is, and hears them again (it has no memory of them).
 *
 * Read from the escalation STORE as well as this module's (persisted) queue: the
 * store is where an unanswered question actually lives, and a question already
 * told to an EARLIER desk must be told to this new conversation again. Strict
 * read — an unreadable store throws, the desk is un-marked, and the next pass
 * retries (a tolerant read would look empty and mark it caught up for good).
 * A question already queued is not queued twice.
 */
export const catchUpSupplyDesks = async (partial: Partial<SupplyNoticeDeps> = {}): Promise<void> => {
  const deps = { ...defaultDeps, ...partial }
  // Held notices first, synchronously — a slow or failing store read must not
  // delay what is already queued.
  flushSupplyNotices(partial)
  let desks: { id: string; cwd: string }[] = []
  try {
    desks = deps.desks()
  } catch {
    return
  }
  const live = new Set(desks.map((d) => d.id))
  for (const id of Array.from(seenDesks)) if (!live.has(id)) seenDesks.delete(id)
  for (const id of Array.from(toldTo.keys())) if (!live.has(id)) toldTo.delete(id)
  let added = false
  for (const desk of desks) {
    if (seenDesks.has(desk.id)) continue
    // Marked BEFORE the await so an overlapping pass cannot catch it up twice;
    // unmarked on failure so the next pass retries.
    seenDesks.add(desk.id)
    try {
      const at = deps.now()
      for (const qn of await deps.openQuestions(desk.cwd)) {
        if (toldTo.get(desk.id)?.has(qn.id)) continue // heard it at queue time
        // Stamped with when it was ASKED, so an old question is told as old.
        pushImportant(deskKey(desk.cwd), qn.detail, qn.at ?? at, qn.id)
        added = true
      }
    } catch (e) {
      seenDesks.delete(desk.id)
      // Retried every pass; say so once, so a store that STAYS unreadable (the
      // president then never hears the open questions) is diagnosable.
      warnOnce(`catchup:${desk.id}`, `catch-up read failed for a president desk; retrying each pass: ${String(e)}`)
    }
  }
  if (added) flushSupplyNotices(partial)
}
