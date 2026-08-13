// ownerDeskLimit — "your own conversation stopped, and nobody was going to tell
// you". The model-limit watch for the OWNER'S conversation desks: the Terminal
// tab's panes, Board 実行, the commander / supply desks — every claude PTY the
// owner types into and waits on (TerminalInfo.ownerDesk).
//
// WHY THIS EXISTS (the 2026-07-18 event). A Fable 5 exhaustion hit the machine.
// Everything the swarm engine MANAGED was rescued automatically: its sensor read
// the workers' screens, confirmed the limit in 1m42s, held + requeued the cards,
// and demoted the tier so the commander relaunched on opus. The owner's OWN desks
// were not: they sat showing
//
//     You've reached your Fable 5 limit. Run /usage-credits to continue or
//     switch models with /model.
//
// and simply stopped — no bell, no toast, nothing — until the owner happened to
// look at the pane and type /model by hand. OG was already scraping that exact
// wording for its workers; it just never pointed the same eyes at the desks where
// a HUMAN was waiting. This module points them there.
//
// WHAT IT DOES NOT DO — it never touches the desk. No Enter, no /model, no model
// switch, no kill. The owner's conversation is theirs; an app that silently
// rewrote which model it runs on would be a worse surprise than the silence it
// replaced. The whole scope is: notice, and say so once, in words a non-programmer
// can act on.
//
// RELATIONSHIP TO THE ENGINE. The detection is the engine's, reused rather than
// rebuilt — but reuse means the JUDGEMENT, not the tuning knobs:
//
//   • SHARED, and never to be forked: the WORDING (swarmRateLimitText, the same
//     module the pre-launch tier probe reuses) and the frame ANATOMY
//     (@/lib/claudeScreen, shared with swarmQuestions / swarmEscalations). Both
//     answer "what does a claude screen SAY", one question with one right answer.
//   • DELIBERATELY OWN: the two TIMING gates below. The first cut imported them
//     from swarmOrchestrator; review (2026-07-18) rejected that, because the
//     engine's constants are defined against WORKER questions ("how long before a
//     worker's screen is worth reading", "how long must an AT-SPAWN notice hold")
//     — retuning one for a worker-side reason would silently move when the OWNER
//     gets told. Copying a NUMBER is safe; copying the WORDING is what would rot.
//
// What else differs is deliberate and documented at each gate below — a desk has
// none of the worker arm's corroborating signals (no spawn-onset window, no commit
// count, no heartbeat), so it substitutes a stricter reading of the screen.
//
// Runs as its own boot loop (startOwnerDeskLimitLoop), NOT inside an engine pass:
// the desks that go dark are precisely the ones nobody is managing, so the watch
// must work with no swarm running and no UI open — the same independence
// terminal.ts's sweep loop has.

import { basename } from 'path'
import { classifyQuotaRefusal, type QuotaRefusalKind } from './swarmRateLimitText'
import { listOwnerDeskTerminals, getTerminalScreenLogical, type OwnerDeskTerminal } from './terminal'
import { createSwarmInfoNotification } from './swarmNotifications'
import { projectUUIDFromPath } from './projectDataPath'
import { getSettings } from './store'
import type { SwarmInfoNotification } from '../types'

/** How long a desk's PTY output must lull before its screen is sampled, and the
 *  FIRST half of the false-positive guard: a session that is streaming output is
 *  working, whatever text happens to be on its screen, so a desk that merely
 *  PRINTED the limit wording (reviewing this very file, drafting a plan that
 *  quotes the notice) is never even looked at while it keeps painting. A desk
 *  already being tracked is re-sampled every pass regardless, so a conversation
 *  that comes back to life is noticed promptly.
 *
 *  CALIBRATED FROM the worker arm's scrape gate of the PTY era
 *  (RATE_LIMIT_SCRAPE_QUIET_MS, 45s — deleted 2026-08-13 with that sensor
 *  layer) but deliberately its OWN constant, which is why it SURVIVES the
 *  donor's deletion unchanged. Review (2026-07-18) caught the first cut
 *  importing the engine's value: the two windows answer different questions,
 *  so retuning one for the other's reason would move the owner's notification
 *  timing silently. Copying a NUMBER is safe; the WORDING is what must never
 *  be copied, and that still comes from the shared module. */
export const OWNER_DESK_QUIET_MS = 45_000

/** How long the notice must HOLD a desk's screen before the owner is told — the
 *  SECOND half of the guard: one transient frame (a notice that flashes mid-boot
 *  and clears) never raises a notification. Combined with the quiet gate the owner
 *  hears about a stopped conversation roughly 1.5–2 minutes in — the same order as
 *  the engine's own 1m42s detection on 2026-07-18. Own constant for the same
 *  reason as {@link OWNER_DESK_QUIET_MS}: its PTY-era counterpart
 *  (RATE_LIMIT_EARLY_CONFIRM_MS, deleted 0813) was defined as "how long an
 *  AT-SPAWN notice must hold", a question a desk never asks. */
export const OWNER_DESK_CONFIRM_MS = 45_000

/** How many CONSECUTIVE normal screens re-arm a desk after a stop.
 *
 *  The dedup's memory. Binding "already told" to the LAST FRAME — the first cut,
 *  which dropped the entry on any single non-matching read — makes the dedup only
 *  as stable as the frame classifier: a stopped desk where the owner types a
 *  character and deletes it flips matched → not → matched, taking `notified` with
 *  it, and the SAME stop rings a second time a pass later. So the entry survives a
 *  lone dissenting frame, and only a desk that reads normal this many passes
 *  running is considered to have recovered.
 *
 *  Sized to cost one extra interval (~15s) of latency on a genuine recovery,
 *  which nothing depends on — the recovery path has no deadline, it only decides
 *  when a FUTURE stop may notify again. */
export const OWNER_DESK_REARM_READS = 3

/** How long a confirmed stop is HELD BACK, waiting to see whether it is part of a
 *  larger event, before the owner is told.
 *
 *  WHY IT EXISTS (adversarial review, 2026-07-18 round 3 — the first coalescing
 *  fix was measured and did not work). Merging "the stops confirmed in the same
 *  PASS" only merges desks that fall in the same 15-second bucket, and which
 *  bucket a desk lands in is decided by ITS OWN output-quiet window. An
 *  account-wide exhaustion does not stop every desk at the same instant — each
 *  desk fails when its own in-flight request lands — so the desks it stops
 *  routinely straddle a bucket boundary. Measured on the real pass:
 *
 *      skew 0s  → 1 notification   (the only case the first fix's test covered)
 *      skew 1s  → 2 notifications
 *      skew 15s → 6 IDENTICAL notifications — verbatim the rejected defect
 *
 *  So the merge window has to span the EVENT, not the tick: a confirmed stop
 *  waits until no NEW desk has been confirmed for this long, and only then is the
 *  accumulated set told as one. One quiet interval is the smallest window that can
 *  observe "nothing else is arriving", since that is how often the pass runs. */
export const OWNER_DESK_MERGE_QUIET_MS = 15_000

/** The ceiling on that hold-back, from the FIRST confirmation in the cluster.
 *
 *  Without it a trickle of desks arriving just inside the quiet window would defer
 *  the notification indefinitely — the owner would hear nothing precisely because
 *  a lot was going wrong. At the cap the accumulated set is told and any later
 *  desk starts a fresh cluster: an event spread wider than this reads as two
 *  arrivals, which is what it is. Costs a single stopped desk one quiet interval
 *  (~15s) on top of the ~90s detection — see {@link OWNER_DESK_LIMIT_INTERVAL_MS}. */
export const OWNER_DESK_MERGE_CAP_MS = 60_000

/** Per-desk (keyed by terminalId) sighting bookkeeping. */
interface DeskLimitSighting {
  /** Epoch ms the quota notice was FIRST seen holding this desk's screen. */
  sightedAt: number
  /** Has the owner already been told about THIS sighting? The dedup: one
   *  notification per stop, not one per pass. Survives until the desk RE-ARMS —
   *  see {@link OWNER_DESK_REARM_READS} — so a conversation that recovers and
   *  later hits the wall again notifies afresh, while a flicker does not. */
  notified: boolean
  /** Consecutive passes that have READ a normal screen since the last refusal
   *  frame. Reset to 0 by any refusal frame; at {@link OWNER_DESK_REARM_READS}
   *  the entry is dropped and the desk is armed again. Counts only passes that
   *  actually obtained a screen — an unreadable one is missing evidence, not
   *  evidence of recovery. */
  normalReads: number
  /** Epoch ms this stop cleared the hold window and became ELIGIBLE to be told —
   *  null until then. The clock the merge window runs on (see
   *  {@link OWNER_DESK_MERGE_QUIET_MS}); a desk that recovers while waiting is
   *  dropped with its entry and never notifies, which is correct — the stop
   *  resolved itself before anyone was told about it. */
  confirmedAt: number | null
}

interface OwnerDeskLimitState {
  sightings: Map<string, DeskLimitSighting>
  /** Guards against overlapping passes (a slow notify must not let the next tick
   *  re-enter and double-fire). */
  passInFlight: boolean
}

declare global {
  // On globalThis so a `tsx watch` reload keeps the sighting clocks instead of
  // silently restarting every desk's hold window — same reason terminal.ts's pool
  // and the orchestrator's engine store live there.
  // eslint-disable-next-line no-var
  var __openground_owner_desk_limit: OwnerDeskLimitState | undefined
  // eslint-disable-next-line no-var
  var __openground_owner_desk_limit_timer: ReturnType<typeof setInterval> | null | undefined
}

const state: OwnerDeskLimitState =
  globalThis.__openground_owner_desk_limit ??
  (globalThis.__openground_owner_desk_limit = { sightings: new Map(), passInFlight: false })

/** Which PROJECT a desk belongs to, named the way the owner named it.
 *
 *  `basename(cwd)` is NOT good enough, which is the whole reason this exists: a
 *  desk opened in a swarm worktree sits at
 *  `~/.openground/projects/<uuid>/worktrees/swarm-engine-0718-0718-134651-f115e…`,
 *  so the bare folder name is a machine stamp — precisely the vocabulary a
 *  plain-language message must not contain. The UUID route resolves such a path
 *  back to the project it belongs to (projectUUIDFromPath accepts a project's
 *  central worktrees dir), and the registry's `displayName` is the same name the
 *  Ground card shows, so the owner reads the label they chose.
 *
 *  Returns null when the cwd resolves to no registered project at all (a
 *  custom-module dir, whose folder name is itself a UUID). The caller then omits
 *  the location rather than printing something machine-shaped — an unlabelled
 *  message the owner can still act on beats a labelled one they can't parse.
 *  Never throws. */
export const resolveDeskProject = async (
  cwd: string,
): Promise<{ label: string; path: string } | null> => {
  try {
    const uuid = await projectUUIDFromPath(cwd)
    const entry = (await getSettings()).projects?.find((p) => p.id === uuid)
    if (!entry) return null
    const label = entry.displayName?.trim() || basename(entry.path)
    return label ? { label, path: entry.path } : null
  } catch {
    return null // unregistered cwd — say nothing rather than something cryptic
  }
}

/** The plain-language body the owner reads (bell row + OS toast). Deliberately
 *  written to a NON-PROGRAMMER standard, in the three parts an owner-facing
 *  message owes them: WHAT happened → WHAT it means for them → the ONE thing to
 *  do. No tier / quota / rate-limit / PTY / session vocabulary: the reader is the
 *  person who owns the work, not the person who owns the engine.
 *
 *  `label` is the project's own name (see {@link resolveDeskProject}), or null to
 *  drop the location clause entirely. Pure + exported so the wording is pinned by
 *  a test. */
export const buildOwnerDeskLimitDetail = (
  label: string | null,
  desk: string | null,
  kind: QuotaRefusalKind,
): string =>
  'いま使っていたAIモデルが、使える量の上限に達しました。' +
  // WHERE, as specifically as we can name it. An account-wide exhaustion stops
  // every desk at once, so a message that named only the project would put two
  // identical rows in the bell for two different conversations — the owner would
  // not know which pane to go to. `desk` is the role the owner knows it by
  // ("司令官"), set only where that name is unambiguous. Desks WITHOUT one (the
  // Terminal tab's panes, Board 実行 — the commonest kind) are handled by
  // coalescing instead; see {@link buildOwnerDeskLimitMergedDetail}.
  (label
    ? desk
      ? `「${label}」の${desk}で開いている会話は`
      : `「${label}」で開いている会話は`
    : desk
      ? `${desk}の会話は`
      : 'その会話は') +
  'ここで止まったままで、待っても自動では再開しません。' +
  ownerDeskRemedy(kind, 'その会話')

/** The ONE thing to do — which differs by what actually ran out.
 *
 *  Review (2026-07-18, round 3) caught the shipped message telling every owner to
 *  type /model. On an ACCOUNT-WIDE stop that menu's every entry is exhausted too:
 *  the owner follows the instruction, nothing happens, and the message has left
 *  them with no next move — worse than the silence this feature replaced.
 *
 *  The account-wide branch still names model-switching FIRST, ahead of waiting,
 *  and that hedge is deliberate. The kind is read off the CLI's own remedy line,
 *  which a wrapped notice can leave in a row the classifier did not need to
 *  reassemble; that residual misreads a per-model stop as account-wide, never the
 *  reverse. Naming both moves means the misread costs the owner a sentence of
 *  hedging rather than the actual fix.
 *
 *  Deliberately does NOT restate WHEN the limit comes back, though the CLI prints
 *  it: rendering "3pm (Asia/Tokyo)" as a local clock means re-interpreting a time
 *  whose zone the CLI does not always state, and a bell that contradicts the pane
 *  it is pointing at is worse than one that stays quiet about it. The owner is
 *  being sent to the very screen where the CLI's own reset sentence is written. */
const ownerDeskRemedy = (kind: QuotaRefusalKind, where: string): string =>
  kind === 'model-switchable'
    ? `続けるには、${where}の入力欄に /model と入力して、別のモデルを選んでください。`
    : '続けるには、別のモデルに切り替えるか、上限が回復するまで少し待ってください。'

/** One stopped desk, as the message needs to name it. */
export interface StoppedDesk {
  /** Its project, owner-named — see {@link resolveDeskProject}. Null = unregistered. */
  project: { label: string; path: string } | null
  /** Its role name ("司令官") when its launcher set one. */
  desk: string | null
  /** Which kind of stop, which decides the advice. */
  kind: QuotaRefusalKind
}

/** Name a set of stopped desks in one clause, grouped by project.
 *
 *  Grouped rather than listed flat because the desks that collapse together are
 *  exactly the ones with no role name: four Terminal panes in one project would
 *  otherwise read `「OG」の会話・「OG」の会話・…`. Counting them says the same thing
 *  in the words the owner would use. */
const describeStoppedDesks = (stopped: readonly StoppedDesk[]): string => {
  const groups = new Map<string, { label: string | null; named: string[]; plain: number }>()
  for (const s of stopped) {
    const label = s.project?.label ?? null
    const key = label ?? ''
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { label, named: [], plain: 0 }))
    if (s.desk) g.named.push(s.desk)
    else g.plain += 1
  }
  return Array.from(groups.values())
    .map((g) => {
      const items = [...g.named]
      if (g.plain === 1) items.push('会話')
      else if (g.plain > 1) items.push(`会話${g.plain}件`)
      return g.label ? `「${g.label}」の${items.join('・')}` : items.join('・')
    })
    .join('、')
}

/** The body for TWO OR MORE desks that stopped in the same pass.
 *
 *  WHY COALESCING EXISTS (review 2026-07-18, round 3). An account-wide exhaustion
 *  stops every desk at once — and `deskLabel` is set only on the commander and
 *  supply desks, so the Terminal tab's panes and Board 実行 (the commonest desks
 *  by far) all render the SAME sentence. Six identical bell rows and six identical
 *  toasts is not six pieces of information; it is one, repeated. One row that
 *  counts them says more and costs one slot.
 *
 *  ⚠ The original justification also claimed the repeats could crowd real fatal
 *  escalations out of the bell's cap. That no longer holds: the cap became
 *  PER-KIND (swarmNotifications' capNotificationsByKind), so a swarm-info flood
 *  cannot evict a swarm-fatal record. The owner-facing noise is reason enough on
 *  its own — but the stale half is called out rather than quietly dropped, because
 *  "the reason we did this" is what the next reader will reuse. */
export const buildOwnerDeskLimitMergedDetail = (stopped: readonly StoppedDesk[]): string =>
  'いま使っていたAIモデルが、使える量の上限に達しました。' +
  `開いている会話 ${stopped.length}件（${describeStoppedDesks(stopped)}）が` +
  'どれも止まったままで、待っても自動では再開しません。' +
  // The advice must be true of EVERY desk in the row, so one account-wide stop
  // among them softens the whole message: telling the owner to /model out of a
  // stop that /model cannot fix is the defect this round exists to close.
  ownerDeskRemedy(
    stopped.every((s) => s.kind === 'model-switchable') ? 'model-switchable' : 'account-wide',
    'それぞれの会話',
  )

/** The notification record for the desks that stopped in ONE pass — a single row
 *  whether that is one desk or six. Pure + exported for the test. */
export const buildOwnerDeskLimitNotification = (
  stopped: readonly StoppedDesk[],
): SwarmInfoNotification => {
  const one = stopped.length === 1 ? stopped[0] : null
  // The PROJECT root, so the bell row can open the right project — a worktree path
  // would point the owner at a directory they never opened. Omitted rather than
  // faked when the desks disagree about which project they are in, or when the cwd
  // resolves to no registered project at all (a custom-module dir, whose path the
  // bell cannot open): a row that opens the wrong place is worse than one that
  // opens nowhere.
  const paths = new Set(stopped.map((s) => s.project?.path ?? ''))
  const projectPath = paths.size === 1 ? (stopped[0]?.project?.path ?? '') : ''
  return {
    event: 'session-limit',
    detail: one
      ? buildOwnerDeskLimitDetail(one.project?.label ?? null, one.desk, one.kind)
      : buildOwnerDeskLimitMergedDetail(stopped),
    ...(projectPath ? { projectPath } : {}),
  }
}

/** Injectable seams — production wires the real pool + notifier; tests drive
 *  synthetic PTY screens. There is deliberately NO input/write seam here: the
 *  watch is structurally incapable of touching the owner's conversation. */
export interface OwnerDeskLimitDeps {
  /** Live owner desks (default: {@link listOwnerDeskTerminals}). */
  listDesks: () => OwnerDeskTerminal[]
  /** A desk's current screen, soft-wrapped rows rejoined
   *  (default: {@link getTerminalScreenLogical}). */
  screen: (terminalId: string) => string | null
  /** Raise the bell + OS toast (default: {@link createSwarmInfoNotification}). */
  notify: (n: SwarmInfoNotification) => Promise<unknown>
  /** Name the desk's project for the message (default: {@link resolveDeskProject}). */
  project: (cwd: string) => Promise<{ label: string; path: string } | null>
}

const defaultDeps = (): OwnerDeskLimitDeps => ({
  listDesks: listOwnerDeskTerminals,
  screen: getTerminalScreenLogical,
  notify: (n) => createSwarmInfoNotification(n),
  project: resolveDeskProject,
})

export interface OwnerDeskLimitPassResult {
  /** terminalIds notified on THIS pass (one per newly-confirmed stop). */
  notified: string[]
  /** terminalIds currently sighted as stopped (notified or still confirming). */
  tracked: string[]
}

/**
 * ONE watch pass: sample the quiet desks, track how long a quota notice has held
 * each screen, and tell the owner once per stop.
 *
 * Read-only with respect to every desk — it looks at screens and raises
 * notifications, nothing else.
 *
 * @param now injectable clock (epoch ms), house style.
 */
export const runOwnerDeskLimitPass = async (
  opts: { now?: number; deps?: Partial<OwnerDeskLimitDeps> } = {},
): Promise<OwnerDeskLimitPassResult> => {
  // RE-ENTRANCY belongs to the PASS, not to whoever calls it. `notified` is marked
  // before an awaited notify, so two passes overlapping inside that window would
  // both see `notified: false` and both ring. The loop below already declines to
  // start an overlapping tick, but a SECOND driver (a "check this desk now" route,
  // a test harness) would not — and a guard that only works for one caller is the
  // house's known failure mode. Held in try/finally so a throwing pass cannot wedge
  // the watch shut for good.
  if (state.passInFlight) return { notified: [], tracked: Array.from(state.sightings.keys()) }
  state.passInFlight = true
  try {
    return await runOwnerDeskLimitPassInner(opts)
  } finally {
    state.passInFlight = false
  }
}

const runOwnerDeskLimitPassInner = async (
  opts: { now?: number; deps?: Partial<OwnerDeskLimitDeps> },
): Promise<OwnerDeskLimitPassResult> => {
  const now = opts.now ?? Date.now()
  const deps = { ...defaultDeps(), ...opts.deps }

  let desks: OwnerDeskTerminal[] = []
  try {
    desks = deps.listDesks()
  } catch {
    return { notified: [], tracked: Array.from(state.sightings.keys()) }
  }

  // Drop bookkeeping for desks that are gone (the conversation was closed, the
  // PTY exited). Mirrors the engine's prune of engine.limitScreen against the
  // live terminal set — without it a long-lived process would accumulate one
  // entry per closed pane forever.
  //
  // ⚠ This drops `notified` with the entry, so a desk missing for a SINGLE pass
  // would be told again about a stop it was already told about. That is safe only
  // because listDesks is a synchronous scan of an in-memory Map keyed on flags that
  // do not flicker: it cannot transiently omit a live desk. Should it ever become
  // async or fallible, the dedup breaks silently — prune on a CONFIRMED absence
  // (two consecutive passes, like the re-arm below) rather than on one reading.
  const live = new Set(desks.map((d) => d.id))
  for (const id of Array.from(state.sightings.keys())) {
    if (!live.has(id)) state.sightings.delete(id)
  }

  const notified: string[] = []
  const pending: Array<{
    desk: OwnerDeskTerminal
    kind: QuotaRefusalKind
    sighting: DeskLimitSighting
  }> = []
  for (const desk of desks) {
    const tracked = state.sightings.get(desk.id)

    // QUIET GATE — only a desk whose output has lulled is read at all. `startedAtMs`
    // floors the window so a freshly-spawned desk that has not painted yet isn't
    // treated as quiet since forever. A desk already tracked is re-read every pass:
    // that is how a RECOVERY is spotted (and the entry re-armed) without waiting
    // for another lull.
    const lastActivity = Math.max(desk.lastOutputAt ?? Number.NEGATIVE_INFINITY, desk.startedAtMs)
    const quiet = now - lastActivity >= OWNER_DESK_QUIET_MS
    if (!quiet && !tracked) continue

    let screen: string | null = null
    try {
      screen = deps.screen(desk.id)
    } catch {
      // Unreadable screen ⇒ no evidence either way. Fail-open: a transient read
      // failure delays a notification, and (below) it does NOT count toward
      // re-arming a desk we have already told the owner about.
    }

    // WORDING + POSITION + NOT-GENERATING, all required. classifyQuotaRefusal asks
    // (a) is this the CLI's own refusal wording — not a transient fault, whose
    // remedy is to wait rather than to switch models, and not the bare phrase
    // "usage limit" that any conversation ABOUT limits contains; (b) is this
    // session idle rather than mid-generation; and (c) is the notice the WHOLE of
    // what was last said — nothing after it (a desk that quoted it and worked on)
    // and nothing before it in the same utterance (a report that ENDS by quoting
    // it — the commander's daily work). See that function's docblock for why a
    // desk needs all of them, and why measuring position in raw screen characters
    // does not work at real terminal geometry.
    const kind = classifyQuotaRefusal(screen)
    if (!kind) {
      if (tracked && screen !== null) {
        // RE-ARM WITH HYSTERESIS — one dissenting frame is not a recovery. See
        // OWNER_DESK_REARM_READS: without this, a stopped desk that the owner
        // types into and clears flips the classifier and rings a second time for
        // the same stop.
        tracked.normalReads += 1
        if (tracked.normalReads >= OWNER_DESK_REARM_READS) state.sightings.delete(desk.id)
      }
      continue
    }

    if (!tracked) {
      state.sightings.set(desk.id, {
        sightedAt: now,
        notified: false,
        normalReads: 0,
        confirmedAt: null,
      })
      continue
    }
    tracked.normalReads = 0 // still stopped — any recovery streak is broken
    if (tracked.notified) continue // already told the owner about THIS stop
    if (now - tracked.sightedAt < OWNER_DESK_CONFIRM_MS) continue // still confirming

    // ELIGIBLE, not yet told. The stop is real; whether it is told NOW or waits for
    // the rest of its event is decided below, once every desk has been classified.
    if (tracked.confirmedAt === null) tracked.confirmedAt = now
    pending.push({ desk, kind, sighting: tracked })
  }

  // ONE notification for the whole EVENT. The classification loop above is
  // deliberately await-free, and the flush below waits for the event to stop
  // growing, so an account-wide exhaustion — which stops every desk, but each one
  // as its own in-flight request fails — is told as the single thing it is rather
  // than as six identical rows arriving over a minute.
  //
  // ⚠ Scoping this to "the stops confirmed in the same PASS" is NOT enough, and
  // looks like it works: which pass a desk lands in follows its own output-quiet
  // window, so one second of skew splits a pair across the 15s tick boundary. See
  // OWNER_DESK_MERGE_QUIET_MS for the measurements.
  const flush =
    pending.length > 0 &&
    (now - Math.max(...pending.map((p) => p.sighting.confirmedAt ?? now)) >=
      OWNER_DESK_MERGE_QUIET_MS ||
      now - Math.min(...pending.map((p) => p.sighting.confirmedAt ?? now)) >=
        OWNER_DESK_MERGE_CAP_MS)

  if (flush) {
    for (const p of pending) {
      // Marked BEFORE awaiting: at-most-once is the contract, so a slow or failing
      // notify must not leave the door open for a second one. A genuinely failed
      // write costs this stop its notification (the desk is still visibly stopped
      // on screen) — the same best-effort stance the escalation path takes.
      p.sighting.notified = true
      notified.push(p.desk.id)
    }
    // Projects resolved HERE, not at sighting: one lookup per notification (rare)
    // rather than per pass, and never on the path that decides IF we notify.
    //
    // Naming a desk must not be able to COST it its notification. Every desk is
    // already flagged `notified`, so anything that throws between here and the
    // notify loses the stop for good — and since the pass now speaks for all of
    // them at once, one bad lookup would lose SIX. So the resolver is wrapped to
    // absorb a rejection AND a synchronous throw (an injected `project` seam is
    // not required to be async); an unnamed desk still produces a message the
    // owner can act on, which is the whole point of the location being optional.
    const name = async (cwd: string): Promise<{ label: string; path: string } | null> => {
      try {
        return await deps.project(cwd)
      } catch {
        return null
      }
    }
    const stopped: StoppedDesk[] = await Promise.all(
      pending.map(async (p) => ({
        project: await name(p.desk.cwd),
        desk: p.desk.deskLabel ?? null,
        kind: p.kind,
      })),
    )
    try {
      await deps.notify(buildOwnerDeskLimitNotification(stopped))
    } catch {
      // A FAILED write is not a delivered notification. `notified` is set before
      // the await so a concurrent pass cannot double-fire — but leaving it set
      // after a throw means the owner is never told about this stop at all, and
      // the desk is still sitting there stopped.
      //
      // Safe to retry because the throw can only come from the bell's disk write:
      // createSwarmInfoNotification awaits appendSwarmNotification and then calls
      // sendOsNotification, which is total (it catches its own IPC failure and
      // returns false). So a throw means NOTHING was recorded — there is no
      // half-written row for a retry to duplicate. The contract is at-most-once
      // per SUCCESSFUL write; the next pass re-flushes (confirmedAt is unchanged,
      // so the merge window has already elapsed) and tries again.
      for (const p of pending) p.sighting.notified = false
      notified.length = 0
    }
  }

  return { notified, tracked: Array.from(state.sightings.keys()) }
}

/** Drop all sighting state (test cleanup / shutdown). */
export const resetOwnerDeskLimitState = (): void => {
  state.sightings.clear()
  state.passInFlight = false
}

/** How often the watch runs. Small next to the two 45s gates, so the tick adds at
 *  most ~15s to a detection that is otherwise ~90s; the pass itself is one Map
 *  scan plus a screen read per QUIET desk, so a working owner (output flowing)
 *  costs nothing at all. */
export const OWNER_DESK_LIMIT_INTERVAL_MS = 15_000

/** Start the owner-desk model-limit watch loop. Independent of the swarm engine
 *  and of the UI by design — the desks that go dark are exactly the ones nobody
 *  is managing. Idempotent + reload-safe (the timer lives on globalThis and a
 *  re-eval clears the old one instead of stacking a second), and `unref`'d so the
 *  watch alone never holds the process open. Wired ONCE at server boot
 *  (server/index.ts); unit tests mount the Hono app, not the entry, so it never
 *  auto-runs there. */
export const startOwnerDeskLimitLoop = (
  intervalMs: number = OWNER_DESK_LIMIT_INTERVAL_MS,
  deps: Partial<OwnerDeskLimitDeps> = {},
): void => {
  if (globalThis.__openground_owner_desk_limit_timer) {
    clearInterval(globalThis.__openground_owner_desk_limit_timer)
  }
  const timer = setInterval(() => {
    // Overlap is declined inside the pass itself (see runOwnerDeskLimitPass), so a
    // slow tick is a no-op here rather than a second concurrent scan.
    void runOwnerDeskLimitPass({ deps }).catch(() => {
      /* a failed pass must never kill the loop */
    })
  }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  globalThis.__openground_owner_desk_limit_timer = timer
}

/** Stop the watch loop (shutdown / test cleanup). Idempotent. */
export const stopOwnerDeskLimitLoop = (): void => {
  if (globalThis.__openground_owner_desk_limit_timer) {
    clearInterval(globalThis.__openground_owner_desk_limit_timer)
    globalThis.__openground_owner_desk_limit_timer = null
  }
}
