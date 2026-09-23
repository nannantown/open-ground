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
// THE SAME SHAPE AS THE COMMANDER'S NOTICE SLOT (swarmOrchestrator's
// managerNotice / defaultNotifyManagerReady — card 715dd79f, which closed the
// identical defect on the commander side):
//   • ONE slot per project, newest overwrites — a queue would let a quiet desk
//     accumulate a backlog and then paste a wall of stale news at the owner;
//   • CLEARED the moment it is delivered;
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

import { resolve } from 'path'
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
const SUPPLY_NOTICE_TAIL =
  'この知らせをオーナーに平易な言葉で1〜3行で伝えてください(専門用語・ブランチ名・IDは書かない)。'

/** Wrap a plain summary into the line that gets typed. Pure. */
export const supplyNoticeLine = (summary: string): string =>
  `${SUPPLY_NOTICE_PREFIX}${sanitizeSupplyNotice(summary)} ${SUPPLY_NOTICE_TAIL}`

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
  if (n.kind === 'swarm-fatal' && n.swarmFatal) return supplyNoticeLine(n.swarmFatal.detail)
  if (n.kind === 'swarm-info' && n.swarmInfo && SUPPLY_NOTICE_INFO_EVENTS.has(n.swarmInfo.event)) {
    return supplyNoticeLine(n.swarmInfo.detail)
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
  now: Date.now,
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
 * How long an undelivered notice stays worth saying. Past this it is DROPPED,
 * not delivered late.
 *
 * WHY IT EXPIRES AT ALL. The commander's twin slot lives on
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
  /** When it was raised — the input to {@link SUPPLY_NOTICE_TTL_MS}. */
  at: number
}

/** The ONE pending notice per project. On `globalThis` so it survives `tsx watch`
 *  reloads in dev, like every other in-memory server map here. */
declare global {
  // eslint-disable-next-line no-var
  var __openground_supply_notice: Map<string, PendingNotice> | undefined
  // eslint-disable-next-line no-var
  var __openground_supply_reply: Map<string, PendingNotice[]> | undefined
}
const pending: Map<string, PendingNotice> =
  globalThis.__openground_supply_notice ?? (globalThis.__openground_supply_notice = new Map())
/** The reply QUEUE per project — see {@link SUPPLY_REPLY_CAP} for why replies
 *  are not allowed to share the news slot. */
const replies: Map<string, PendingNotice[]> =
  globalThis.__openground_supply_reply ?? (globalThis.__openground_supply_reply = new Map())

export const resetSupplyNoticeState = (): void => {
  pending.clear()
  replies.clear()
}

/** What is waiting for each project right now — for tests and diagnostics. */
export const peekSupplyNotices = (): ReadonlyMap<string, string> =>
  new Map(Array.from(pending, ([k, v]) => [k, v.line] as const))

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
  // BOTH lanes, or the pass bails before it ever looks at the replies — which
  // it did, and the reply tests caught it: with no news queued, a commander's
  // answer sat in the queue until some unrelated notice happened to arrive.
  if (pending.size === 0 && replies.size === 0) return delivered
  const now = deps.now()
  // Stale news is dropped rather than delivered late — see SUPPLY_NOTICE_TTL_MS.
  // Done over the whole map, not just the desks seen this pass, so a project that
  // never grows a desk cannot accumulate entries forever.
  for (const [key, p] of Array.from(pending)) {
    if (now - p.at > SUPPLY_NOTICE_TTL_MS) pending.delete(key)
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
  for (const desk of desks) {
    // PER DESK, not around the loop: one throwing screen()/write() must not
    // abort delivery for every project after it in the list.
    try {
      const key = deskKey(desk.cwd)
      // ONE line per desk per pass, and a REPLY goes before news. The order is
      // not a preference: the owner is sitting there having been told
      // 「聞いてきます」, and the desk starts generating the moment it receives a
      // line — so a second write in the same pass would hit a busy desk and be
      // held anyway. Answering first means the wait the owner actually notices
      // is the one that ends.
      const queue = replies.get(key)
      const reply = queue?.[0] ?? null
      const line = reply?.line ?? pending.get(key)?.line ?? null
      if (!line) continue
      if (!noticeDeliverable(deps.screen(desk.id))) continue // busy / half-typed / menu — next pass
      if (!deps.write(desk.id, `${line}\r`)) continue
      if (reply && queue) {
        queue.shift()
        if (queue.length === 0) replies.delete(key)
      } else {
        pending.delete(key)
      }
      delivered.push(key)
    } catch {
      /* best effort — a notice that missed stays queued for the next pass */
    }
  }
  return delivered
}

/**
 * Put ONE line on the project's supply desk. Newest overwrites — see the file
 * header for why this is a slot and not a queue. Tries to deliver immediately so
 * an idle desk hears it at once; anything held is re-offered by
 * {@link flushSupplyNotices} on the supply loop's next pass.
 *
 * `projectPath` must be the canonical project path (what a desk's `cwd` reads
 * as) — notification payloads already carry it canonicalized.
 */
export const queueSupplyNotice = (
  projectPath: string,
  summary: string,
  deps: Partial<SupplyNoticeDeps> = {},
): void => {
  const line = supplyNoticeLine(summary)
  if (!projectPath || line.length === 0) return
  pending.set(deskKey(projectPath), { line, at: (deps.now ?? Date.now)() })
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
  const line = supplyNoticeFor(n)
  if (!project || !line) return
  pending.set(deskKey(project), { line, at: (deps.now ?? Date.now)() })
  flushSupplyNotices(deps)
}
