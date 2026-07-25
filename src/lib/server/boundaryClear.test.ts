import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  decidePane,
  requestBoundaryClear,
  cancelBoundaryClear,
  runBoundaryClearTick,
  pendingBoundaryClears,
  boundaryClearLog,
  startBoundaryClearLoop,
  stopBoundaryClearLoop,
  __resetBoundaryClearForTests,
  BOUNDARY_CLEAR_MAX_WAIT_MS,
  type BoundaryClearDeps,
} from './boundaryClear'
import type { TaskBoundPane } from './terminal'

// The task-boundary context clear.
//
// The teeth that matter are all one property: A CLEAR MUST NEVER LAND IN LIVE
// WORK. Clearing is destructive and unrecoverable — it throws away a session's
// whole context — so every case below is written from the mis-clear side:
// a pane mid-turn, a pane sitting on a permission menu, a pane that belongs to a
// DIFFERENT card, a card that never actually crossed the boundary, a card that
// came back out of `done`. Failing to clear is a tolerable outcome; clearing the
// wrong pane is not, and these fix that asymmetry in place.
//
// No PTY and no fake timers: the pool and the clock are injected seams.

const CLEAR = '/clear\r'
const CTRL_U = '\x15'

let writes: { id: string; data: string }[]
let unbound: { id: string; taskId: string }[]
let panes: Map<string, TaskBoundPane[]>
let clock: number

/** A pane that is safe to clear — idle, no menu. */
const idlePane = (id: string): TaskBoundPane => ({ id, status: 'waiting', menuOpen: false })
/** A pane mid-turn (claude's spinner is repainting). */
const workingPane = (id: string): TaskBoundPane => ({ id, status: 'working', menuOpen: false })
/** A pane blocked on a human answering a TUI menu (permission prompt). */
const menuPane = (id: string): TaskBoundPane => ({ id, status: 'waiting', menuOpen: true })

let deps: BoundaryClearDeps

beforeEach(() => {
  __resetBoundaryClearForTests()
  writes = []
  unbound = []
  panes = new Map()
  clock = 1_000_000
  deps = {
    panesForTask: (taskId) => panes.get(taskId) ?? [],
    write: (id, data) => {
      writes.push({ id, data })
      return true
    },
    unbind: (id, taskId) => void unbound.push({ id, taskId }),
    now: () => clock,
  }
})
afterEach(() => {
  __resetBoundaryClearForTests()
})

/** Every id that received the actual clear command. */
const clearedIds = (): string[] => writes.filter((w) => w.data === CLEAR).map((w) => w.id)

describe('decidePane — the mis-clear guard, exhaustively', () => {
  it('clears an idle pane', () => {
    expect(decidePane(idlePane('p1'))).toEqual({ action: 'clear', id: 'p1' })
  })

  it('HOLDS a pane that is mid-turn — clearing would kill work in flight', () => {
    expect(decidePane(workingPane('p1'))).toEqual({
      action: 'hold',
      id: 'p1',
      reason: 'working',
    })
  })

  it('HOLDS a menu-open pane even though its status reads `waiting`', () => {
    // The subtle one. claudeStatus() reports a menu-open pane as `waiting`
    // because claude is blocked on a human — so a naive "waiting means idle"
    // check would type INTO AN OPEN PERMISSION PROMPT, where Ctrl-U and the
    // /clear text are consumed as the menu's answer rather than as a command.
    expect(decidePane(menuPane('p1'))).toEqual({
      action: 'hold',
      id: 'p1',
      reason: 'menu-open',
    })
  })

  it('prefers the menu reason when a pane is both working and menu-open', () => {
    expect(decidePane({ id: 'p1', status: 'working', menuOpen: true })).toEqual({
      action: 'hold',
      id: 'p1',
      reason: 'menu-open',
    })
  })
})

describe('the boundary clear itself', () => {
  it('sends Ctrl-U before /clear, in that order', () => {
    // Load-bearing ordering, not decoration: the spike measured unsubmitted text
    // in the input box CONCATENATING with the next command. Without the Ctrl-U,
    // leftover text turns `/clear` into `<leftover>/clear` — not a slash command
    // at all, so it would be sent to the model as a prompt.
    panes.set('card-1', [idlePane('p1')])
    requestBoundaryClear('card-1', deps)

    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: 'card-1', outcome: 'cleared' }])
    expect(writes).toEqual([
      { id: 'p1', data: CTRL_U },
      { id: 'p1', data: CLEAR },
    ])
  })

  it('unbinds the pane from the finished card once cleared', () => {
    // Otherwise the pane stays owned by a card that is over, and re-opening that
    // card later would queue a clear against a pane that has moved on.
    panes.set('card-1', [idlePane('p1')])
    requestBoundaryClear('card-1', deps)
    runBoundaryClearTick(deps)
    expect(unbound).toEqual([{ id: 'p1', taskId: 'card-1' }])
  })

  it('clears every pane bound to the card', () => {
    panes.set('card-1', [idlePane('p1'), idlePane('p2')])
    requestBoundaryClear('card-1', deps)
    runBoundaryClearTick(deps)
    expect(clearedIds()).toEqual(['p1', 'p2'])
  })

  it('never touches a pane bound to a DIFFERENT card', () => {
    // The reason TerminalInfo.taskId exists at all. Resolving by cwd would sweep
    // every pane in the project, including one holding unrelated live work.
    panes.set('card-1', [idlePane('p1')])
    panes.set('card-2', [idlePane('other')])
    requestBoundaryClear('card-1', deps)
    runBoundaryClearTick(deps)
    expect(clearedIds()).toEqual(['p1'])
  })

  it('writes nothing at all until a card is queued', () => {
    panes.set('card-1', [idlePane('p1')])
    expect(runBoundaryClearTick(deps)).toEqual([])
    expect(writes).toEqual([])
  })
})

describe('waiting for the pane to settle', () => {
  it('does not clear a working pane, and stays queued instead of giving up', () => {
    // Skip-and-forget would be the easy bug: the card is usually marked done
    // WHILE claude is still printing its closing summary, so the very first tick
    // almost always finds the pane `working`. Dropping it there would mean the
    // feature silently never fires in the common case.
    panes.set('card-1', [workingPane('p1')])
    requestBoundaryClear('card-1', deps)

    expect(runBoundaryClearTick(deps)).toEqual([])
    expect(writes).toEqual([])
    expect(pendingBoundaryClears()).toEqual(['card-1'])
  })

  it('clears on a later tick once the pane goes idle', () => {
    panes.set('card-1', [workingPane('p1')])
    requestBoundaryClear('card-1', deps)
    runBoundaryClearTick(deps)
    expect(writes).toEqual([])

    panes.set('card-1', [idlePane('p1')])
    clock += 5_000
    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: 'card-1', outcome: 'cleared' }])
    expect(clearedIds()).toEqual(['p1'])
  })

  it('holds the WHOLE card while any one of its panes is still busy', () => {
    // Partial progress is allowed (the idle pane gets its clear immediately),
    // but the intent must stay queued so the busy pane is not forgotten.
    panes.set('card-1', [idlePane('p1'), workingPane('p2')])
    requestBoundaryClear('card-1', deps)

    expect(runBoundaryClearTick(deps)).toEqual([])
    expect(clearedIds()).toEqual(['p1'])
    expect(pendingBoundaryClears()).toEqual(['card-1'])

    // p1 was cleared and unbound, so the pool now reports only p2 for this card.
    panes.set('card-1', [idlePane('p2')])
    clock += 5_000
    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: 'card-1', outcome: 'cleared' }])
    expect(clearedIds()).toEqual(['p1', 'p2'])
  })

  it('EXPIRES rather than clearing a pane that never settles', () => {
    // The safety valve. A pane still busy two minutes after its card was closed
    // is far more likely to have been taken over for NEW work than to still be
    // finishing the old card — so the intent is dropped, never forced through.
    panes.set('card-1', [workingPane('p1')])
    requestBoundaryClear('card-1', deps)
    runBoundaryClearTick(deps)

    clock += BOUNDARY_CLEAR_MAX_WAIT_MS + 1
    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: 'card-1', outcome: 'expired' }])
    expect(writes).toEqual([])
    expect(pendingBoundaryClears()).toEqual([])
  })

  it('expires a permanently menu-blocked pane without answering the menu', () => {
    panes.set('card-1', [menuPane('p1')])
    requestBoundaryClear('card-1', deps)
    runBoundaryClearTick(deps)
    clock += BOUNDARY_CLEAR_MAX_WAIT_MS + 1
    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: 'card-1', outcome: 'expired' }])
    expect(writes).toEqual([])
  })

  it('resolves as no-pane when the card has no live session', () => {
    requestBoundaryClear('card-1', deps)
    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: 'card-1', outcome: 'no-pane' }])
    expect(pendingBoundaryClears()).toEqual([])
  })
})

describe('cancelling — the card came back out of done', () => {
  it('drops a queued clear so a reopened card keeps its context', () => {
    // 差し戻し (review→doing) and a plain undone mis-click both land here. The
    // pane is working on that same card again, so the boundary never happened.
    panes.set('card-1', [workingPane('p1')])
    requestBoundaryClear('card-1', deps)
    cancelBoundaryClear('card-1', deps)

    panes.set('card-1', [idlePane('p1')])
    expect(runBoundaryClearTick(deps)).toEqual([])
    expect(writes).toEqual([])
    expect(boundaryClearLog().map((e) => e.outcome)).toEqual(['cancelled'])
  })

  it('is a no-op for a card that was never queued', () => {
    cancelBoundaryClear('card-x', deps)
    expect(boundaryClearLog()).toEqual([])
  })
})

describe('queueing', () => {
  it('is idempotent per card — a repeated done write does not stack clears', () => {
    panes.set('card-1', [idlePane('p1')])
    requestBoundaryClear('card-1', deps)
    requestBoundaryClear('card-1', deps)
    expect(pendingBoundaryClears()).toEqual(['card-1'])

    runBoundaryClearTick(deps)
    expect(clearedIds()).toEqual(['p1'])
  })

  it('does not let a card re-marked done extend its own deadline forever', () => {
    // Re-queuing must not refresh the deadline, or a Board that re-writes `done`
    // on a poll would keep a busy pane under threat of a clear indefinitely.
    panes.set('card-1', [workingPane('p1')])
    requestBoundaryClear('card-1', deps) // deadline pinned at T + MAX_WAIT

    // Three more `done` writes while the pane stays busy. Each must leave the
    // ORIGINAL deadline alone — so the card is still merely waiting, not expired.
    for (let i = 0; i < 3; i++) {
      clock += BOUNDARY_CLEAR_MAX_WAIT_MS / 4
      requestBoundaryClear('card-1', deps)
      expect(runBoundaryClearTick(deps)).toEqual([])
    }

    // …and it expires exactly at the deadline the FIRST request set, proving the
    // re-queues never pushed it out.
    clock += BOUNDARY_CLEAR_MAX_WAIT_MS / 4
    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: 'card-1', outcome: 'expired' }])
    expect(writes).toEqual([])
  })

  it('ignores an empty task id', () => {
    requestBoundaryClear('', deps)
    expect(pendingBoundaryClears()).toEqual([])
  })

  it('tracks several cards independently', () => {
    panes.set('card-1', [idlePane('p1')])
    panes.set('card-2', [workingPane('p2')])
    requestBoundaryClear('card-1', deps)
    requestBoundaryClear('card-2', deps)

    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: 'card-1', outcome: 'cleared' }])
    expect(pendingBoundaryClears()).toEqual(['card-2'])
    expect(clearedIds()).toEqual(['p1'])
  })
})

describe('the background loop', () => {
  it('is idempotent — a dev reload cannot end up with two drains', () => {
    startBoundaryClearLoop(deps)
    startBoundaryClearLoop(deps)
    stopBoundaryClearLoop()
    // Stopping once must fully stop it; a second interval would keep draining.
    panes.set('card-1', [idlePane('p1')])
    requestBoundaryClear('card-1', deps)
    expect(writes).toEqual([])
  })

  it('survives a throwing pool without taking the server down', () => {
    const boom: BoundaryClearDeps = {
      ...deps,
      panesForTask: () => {
        throw new Error('pool exploded')
      },
    }
    requestBoundaryClear('card-1', boom)
    expect(() => startBoundaryClearLoop(boom)).not.toThrow()
    stopBoundaryClearLoop()
  })
})
