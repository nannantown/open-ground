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
}
const pending: Map<string, PendingNotice> =
  globalThis.__openground_supply_notice ?? (globalThis.__openground_supply_notice = new Map())

export const resetSupplyNoticeState = (): void => pending.clear()

/** What is waiting for each project right now — for tests and diagnostics. */
export const peekSupplyNotices = (): ReadonlyMap<string, string> =>
  new Map(Array.from(pending, ([k, v]) => [k, v.line] as const))

/**
 * Deliver every pending notice it can. A desk that is busy / half-typed /
 * showing a menu keeps its notice for the next pass; a delivered one is cleared
 * immediately. Returns the project paths delivered this pass. Never throws — a
 * failed pass must not kill the loop that calls it.
 */
export const flushSupplyNotices = (partial: Partial<SupplyNoticeDeps> = {}): string[] => {
  const deps = { ...defaultDeps, ...partial }
  const delivered: string[] = []
  if (pending.size === 0) return delivered
  const now = deps.now()
  // Stale news is dropped rather than delivered late — see SUPPLY_NOTICE_TTL_MS.
  // Done over the whole map, not just the desks seen this pass, so a project that
  // never grows a desk cannot accumulate entries forever.
  for (const [key, p] of Array.from(pending)) {
    if (now - p.at > SUPPLY_NOTICE_TTL_MS) pending.delete(key)
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
      const p = pending.get(key)
      if (!p) continue
      if (!noticeDeliverable(deps.screen(desk.id))) continue // busy / half-typed / menu — next pass
      if (!deps.write(desk.id, `${p.line}\r`)) continue
      pending.delete(key)
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
