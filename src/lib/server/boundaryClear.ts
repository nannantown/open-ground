// Task-boundary context clear — the ONE thing OPEN GROUND adds to Claude Code's
// context management.
//
// ─── Why this exists, and why it is this small ───────────────────────────────
// Compression itself is 100% native: Claude Code's auto-compact fires on its own
// as the context window fills (default ON), and what it preserves is steered by
// the `# Compact Instructions` section compactInstructionsInstall.ts deploys.
// OG deliberately does NOT implement a "context is N% full → /compact" trigger:
// two independent triggers would race the native one, and native explicitly
// backs off after consecutive full-context compactions — a second driver firing
// into that is how you get a session that compacts forever and never works.
//
// What native CANNOT know is where one piece of work ends and the next begins:
// it has no idea a Board card exists. That is the whole of OG's contribution.
// When a card lands in `done`, the pane that ran it is holding a context full of
// a FINISHED task; the next task would inherit it, and every later compaction
// would spend its budget summarising work nobody will return to. Compression
// always loses something — but at a task boundary there is nothing left worth
// keeping, so clearing beats compressing. That makes this the highest-value
// moment to reset, and the only one OG is uniquely able to see.
//
// ─── The safety property this module is built around ────────────────────────
// A wrong clear is destructive and unrecoverable: it throws away the live
// context of work in progress. So the engine never clears optimistically. It
// resolves a card to the panes actually BOUND to it (TerminalInfo.taskId — set
// by the card's 実行 launch and by paste-task), and sends only into a pane that
// is idle and menu-free. A pane that is mid-turn or sitting on a permission
// prompt is not skipped-and-forgotten — it is retried until it settles, and the
// intent EXPIRES if it never does. Never clearing is a tolerable failure; a
// clear landing in the middle of someone's work is not.
import { listPanesForTask, setTerminalTaskId, writeInput, type TaskBoundPane } from './terminal'

/** How long a queued boundary clear keeps waiting for its pane to go idle before
 *  the engine gives up on it. Long enough to outlast a normal closing turn (the
 *  card is usually marked done WHILE claude is still printing its summary), short
 *  enough that a pane the user has taken back over for new work is never cleared
 *  out from under them minutes later. */
export const BOUNDARY_CLEAR_MAX_WAIT_MS = 120_000

/** How often the pending queue is re-examined. */
export const BOUNDARY_CLEAR_TICK_MS = 2_000

/** Ctrl-U — clear the input line before submitting.
 *
 *  Load-bearing, not defensive: the spike measured a `\r` failing to submit when
 *  the input box was not settled, which CONCATENATED the pending text with the
 *  next command (docs/CONTEXT_MANAGEMENT_PLAN.md §6). Half-typed text the user
 *  left in the box would otherwise turn `/clear` into `<their text>/clear`, which
 *  is not a slash command at all — it would be SENT AS A PROMPT. */
const CTRL_U = '\x15'

/** The slash command itself. Plain input + Enter, NOT a bracketed paste: the TUI
 *  executes a slash command only when it is submitted as typed input, and the
 *  spike confirmed this exact byte sequence executes (§3-B1,实机). */
const CLEAR_COMMAND = '/clear\r'

/** Why a pending clear finished — every terminal outcome is named so the caller
 *  (and the tests) can assert on intent rather than on side effects. */
export type BoundaryClearOutcome =
  | 'cleared' // sent into an idle pane — the happy path
  | 'no-pane' // the card had no live bound pane (already closed, or never ran here)
  | 'expired' // never settled within BOUNDARY_CLEAR_MAX_WAIT_MS
  | 'cancelled' // the card left `done` again before we sent

/** Why a pane was not cleared on THIS tick. `working`/`menu-open` are transient —
 *  the intent stays queued and is retried. */
export type BoundaryClearHold = 'working' | 'menu-open'

export type PaneDecision =
  | { action: 'clear'; id: string }
  | { action: 'hold'; id: string; reason: BoundaryClearHold }

/** The whole judgement, isolated as a pure function so the mis-clear guard can be
 *  tested exhaustively without a PTY.
 *
 *  `menuOpen` is checked FIRST and separately from status even though
 *  claudeStatus() already reports a menu-open pane as `waiting`: to this module
 *  those two are opposites. A menu-open pane looks idle precisely because claude
 *  is blocked on a human answer — and keystrokes sent then are consumed BY THE
 *  MENU (Ctrl-U and `/clear` would be answering a permission prompt, picking who
 *  knows what). Treating "waiting" as "safe to type into" is the subtle way this
 *  engine would corrupt a session, so the menu case is named and held. */
export const decidePane = (pane: TaskBoundPane): PaneDecision => {
  if (pane.menuOpen) return { action: 'hold', id: pane.id, reason: 'menu-open' }
  if (pane.status === 'working') return { action: 'hold', id: pane.id, reason: 'working' }
  return { action: 'clear', id: pane.id }
}

/** Injected seams — the engine runs against a fake pool in tests. */
export interface BoundaryClearDeps {
  panesForTask: (taskId: string, now: number) => TaskBoundPane[]
  write: (id: string, data: string) => boolean
  unbind: (id: string, taskId: string) => void
  now: () => number
}

const defaultDeps: BoundaryClearDeps = {
  panesForTask: listPanesForTask,
  write: writeInput,
  // Clearing the context ends this pane's association with the finished card.
  // Without this the pane stays bound, and a later re-open of the same card
  // would queue a clear against a pane that has since moved on to other work.
  unbind: (id) => void setTerminalTaskId(id, ''),
  now: () => Date.now(),
}

interface Pending {
  taskId: string
  /** Wall-clock deadline; past this the intent is dropped as `expired`. */
  deadlineAt: number
}

interface BoundaryClearState {
  pending: Map<string, Pending>
  timer: ReturnType<typeof setInterval> | undefined
  /** Terminal outcomes, newest last — read by tests and the docs' worked example. */
  log: { taskId: string; outcome: BoundaryClearOutcome; at: number }[]
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_boundary_clear: BoundaryClearState | undefined
}

// Same globalThis pattern as the terminal pool: in dev, `tsx watch` reloads this
// module on every edit, and a queue held in a module-local would be silently
// dropped mid-flight — the card would land in `done` and the clear would simply
// never happen, with nothing to show why.
const state: BoundaryClearState =
  globalThis.__openground_boundary_clear ??
  (globalThis.__openground_boundary_clear = {
    pending: new Map(),
    timer: undefined,
    log: [],
  })

const LOG_CAP = 50

const record = (taskId: string, outcome: BoundaryClearOutcome, at: number): void => {
  state.log.push({ taskId, outcome, at })
  if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP)
}

/** Queue a task-boundary clear for a card that just landed in `done`.
 *
 *  Idempotent per card: a Board that writes the same transition twice (a retried
 *  request, a collab echo) must not stack two clears. Re-queuing an already
 *  pending card refreshes nothing — the original deadline stands, so a card
 *  repeatedly re-marked done cannot hold a pane hostage indefinitely. */
export const requestBoundaryClear = (taskId: string, deps: BoundaryClearDeps = defaultDeps): void => {
  if (!taskId || state.pending.has(taskId)) return
  state.pending.set(taskId, {
    taskId,
    deadlineAt: deps.now() + BOUNDARY_CLEAR_MAX_WAIT_MS,
  })
}

/** Drop a queued clear — the card left `done` before we sent (moved back to
 *  doing, 差し戻し/rework, or a plain mis-click undone). The pane is mid-work on
 *  that same card again, so the boundary never actually happened. */
export const cancelBoundaryClear = (taskId: string, deps: BoundaryClearDeps = defaultDeps): void => {
  if (!taskId || !state.pending.delete(taskId)) return
  record(taskId, 'cancelled', deps.now())
}

/** One pass over the queue. Returns the outcomes that RESOLVED on this pass;
 *  entries still waiting for their pane to settle stay queued and return nothing.
 *  Pure with respect to time — `now` comes from deps so tests need no fake timers. */
export const runBoundaryClearTick = (
  deps: BoundaryClearDeps = defaultDeps,
): { taskId: string; outcome: BoundaryClearOutcome }[] => {
  const now = deps.now()
  const resolved: { taskId: string; outcome: BoundaryClearOutcome }[] = []

  for (const [taskId, entry] of Array.from(state.pending.entries())) {
    const panes = deps.panesForTask(taskId, now)

    if (panes.length === 0) {
      state.pending.delete(taskId)
      record(taskId, 'no-pane', now)
      resolved.push({ taskId, outcome: 'no-pane' })
      continue
    }

    const decisions = panes.map(decidePane)
    const clearable = decisions.filter((d): d is { action: 'clear'; id: string } => d.action === 'clear')

    for (const d of clearable) {
      // Two writes, in order, into the same PTY byte stream: wipe whatever sits
      // in the input box, then submit the command. Both are best-effort — a pane
      // that exits between the read above and this write just returns false.
      deps.write(d.id, CTRL_U)
      deps.write(d.id, CLEAR_COMMAND)
      deps.unbind(d.id, taskId)
    }

    // Every bound pane settled and got its clear — the intent is fulfilled.
    if (clearable.length === panes.length) {
      state.pending.delete(taskId)
      record(taskId, 'cleared', now)
      resolved.push({ taskId, outcome: 'cleared' })
      continue
    }

    // At least one pane is still working / menu-open. Keep waiting for it, unless
    // it has burned the whole window — a pane that never settles is far more
    // likely to have been taken over for NEW work than to be still finishing the
    // old card, and clearing it then is the exact mistake this engine forbids.
    if (now >= entry.deadlineAt) {
      state.pending.delete(taskId)
      record(taskId, 'expired', now)
      resolved.push({ taskId, outcome: 'expired' })
    }
  }

  return resolved
}

/** Start the background pass. Idempotent — a second call is a no-op, so a dev
 *  reload cannot end up with two intervals draining the same queue. */
export const startBoundaryClearLoop = (deps: BoundaryClearDeps = defaultDeps): void => {
  if (state.timer) return
  const t = setInterval(() => {
    try {
      runBoundaryClearTick(deps)
    } catch {
      // A tick must never take the server down; the next one retries.
    }
  }, BOUNDARY_CLEAR_TICK_MS)
  // Don't hold the process open just to drain a queue.
  if (typeof t.unref === 'function') t.unref()
  state.timer = t
}

export const stopBoundaryClearLoop = (): void => {
  if (!state.timer) return
  clearInterval(state.timer)
  state.timer = undefined
}

/** Test seam: pending card ids, oldest first. */
export const pendingBoundaryClears = (): string[] => Array.from(state.pending.keys())

/** Test seam: the recent terminal outcomes. */
export const boundaryClearLog = (): { taskId: string; outcome: BoundaryClearOutcome; at: number }[] =>
  state.log.slice()

/** Test seam — drops the queue and the log. */
export const __resetBoundaryClearForTests = (): void => {
  stopBoundaryClearLoop()
  state.pending.clear()
  state.log.length = 0
}
