// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask } from '@/lib/types'

// Swarm-worker live screen in the Board drawer (card 225e2a5d) — when a swarm
// worker (engine-dispatched) owns the OPEN card, the drawer shows that worker's
// live `claude` screen INSTEAD of the Run button; a card with no worker keeps
// the Run button (従来維持). The worker's terminalId comes from the runtime
// orchestrator poll (NOT persisted on the card) and the poll is owner-gated
// upstream (403 → empty map → never the worker screen). On the worker's PTY exit
// we fall back to the normal drawer — never a black screen.
//
// These tests exercise BoardModule's BRANCHING only: SwarmWorkerPane (which
// wraps ClaudeTerminalPane → xterm + SSE) is stubbed so the test never reaches
// the real terminal/probe path. That seam is covered by the swarm pane's own
// tests; here we assert which branch BoardModule renders and the props it feeds.

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/components/canvas/CollabPresence', () => ({
  CollabPresence: () => null,
  usePublishPresence: () => {},
}))

// Stub the worker pane: render its key props + an exit trigger, so we can assert
// BoardModule picked the worker branch and wired onExit (the fallback path)
// without pulling in xterm / the SSE stream / the PTY probe.
vi.mock('@/components/canvas/modules/SwarmWorkerPane', () => ({
  SwarmWorkerPane: ({
    terminalId,
    branch,
    status,
    source,
    onExit,
  }: {
    terminalId: string
    branch: string
    status: string
    source?: string
    onExit: () => void
  }) => (
    <div
      data-testid="worker-pane"
      data-terminalid={terminalId}
      data-branch={branch}
      data-status={status}
      data-source={source}
    >
      <button type="button" onClick={onExit}>
        worker-exit
      </button>
    </div>
  ),
}))

// Mutable poll state, hoisted so the api mock factory can close over it. Each
// test sets `h.workers` (the orchestrator's live workers) and, for the owner
// gate, the orchestrator response's ok/status.
const h = vi.hoisted(() => ({
  workers: [] as Array<Record<string, unknown>>,
  reviews: [] as Array<Record<string, unknown>>,
  managerPresence: undefined as string | undefined,
  orchOk: true,
  orchStatus: 200,
}))

vi.mock('@/lib/api-client', () => ({
  api: {
    api: {
      settings: { $get: () => Promise.resolve({ json: () => Promise.resolve({}) }) },
      project: {
        'task-title': {
          $post: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ title: null }) }),
        },
        'pr-info': {
          $post: () => Promise.resolve({ json: () => Promise.resolve({ available: false }) }),
        },
      },
      // Beacon poll → drives workerScreenStatus. Report every live worker pty as
      // 'working' so the status maps to 'working'.
      terminal: {
        active: {
          $get: () =>
            Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  claude: h.workers.map(w => ({ id: w.terminalId, status: 'working' })),
                }),
            }),
        },
      },
      // Orchestrator poll → workersByTask. Owner-gated upstream (403).
      swarm: {
        orchestrator: {
          $get: () =>
            Promise.resolve({
              ok: h.orchOk,
              status: h.orchStatus,
              json: () =>
                Promise.resolve({
                  running: true,
                  maxWorkers: 6,
                  workers: h.workers,
                  reviews: h.reviews,
                  ...(h.managerPresence ? { managerPresence: h.managerPresence } : {}),
                  log: [],
                  anomalies: [],
                }),
            }),
        },
      },
    },
  },
}))

import { BoardModule } from './BoardModule'

const makeTask = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: 't1',
  title: 'Saved title',
  notes: 'Do the work',
  done: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  boardColumn: 'doing',
  ...over,
})

const makeData = (task: ProjectTask): ProjectData =>
  ({ description: '', tasks: [task], notes: '', updatedAt: '' }) as ProjectData

const baseProject = { id: 'p1', name: 'proj', path: '/tmp/proj', hasGit: true } as ProjectMeta

const renderDrawer = () => {
  const utils = render(
    <BoardModule
      data={makeData(makeTask())}
      project={baseProject}
      persist={vi.fn()}
      detailId="t1"
      onOpenDetail={vi.fn()}
      renderConversation={() => <div data-testid="conversation" />}
      hasTerminalSlot={() => false}
      liveTerminalId={() => null}
      onDeleteTask={vi.fn()}
      onLaunchTask={vi.fn(async () => ({ ok: true }))}
    />,
  )
  return utils
}

const worker = (over: Record<string, unknown> = {}) => ({
  terminalId: 'pty-worker-1',
  branch: 'swarm/w-test',
  taskId: 't1',
  taskTitle: 'Saved title',
  startedAt: '2026-01-01T00:00:00.000Z',
  stage: 'running',
  note: 'implementing the thing',
  ...over,
})

// Let both polls (orchestrator + beacon) fully resolve: each chains
// $get → res.json() → setState, so flush several microtask hops inside act.
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}

// Force a fresh poll without waiting out the 5s interval: BoardModule re-polls on
// window focus. Used after mutating h.workers mid-test (e.g. a rework re-dispatch).
const repoll = async () => {
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await settle()
}

beforeEach(() => {
  localStorage.clear()
  h.workers = []
  h.reviews = []
  h.managerPresence = undefined
  h.orchOk = true
  h.orchStatus = 200
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BoardModule drawer — swarm worker live screen', () => {
  it('a worker on the open card shows its live screen instead of the Run button', async () => {
    h.workers = [worker()]
    const { container, getByTestId, queryByText } = renderDrawer()
    await settle()
    // The worker pane replaces the draft/Run footer.
    const pane = getByTestId('worker-pane')
    expect(pane.getAttribute('data-terminalid')).toBe('pty-worker-1')
    expect(pane.getAttribute('data-branch')).toBe('swarm/w-test')
    // Engine-dispatched → read-only source, so SwarmWorkerPane shows the Engine
    // badge and no terminate control.
    expect(pane.getAttribute('data-source')).toBe('engine')
    // Live beacon → 'working'.
    expect(pane.getAttribute('data-status')).toBe('working')
    // The Run button is gone (the worker is already running it).
    expect(queryByText('board.run.button')).toBeNull()
    // Context strip (scoped to the drawer — the kanban card echoes these too)
    // carries the card title + the worker's heartbeat note.
    const drawer = container.querySelector('aside')!
    expect(drawer.textContent).toContain('Saved title')
    expect(drawer.textContent).toContain('implementing the thing')
  })

  it('a worker on a DIFFERENT card leaves this card on the Run button (keyed by taskId)', async () => {
    h.workers = [worker({ taskId: 'someone-else' })]
    const { queryByTestId, getByText } = renderDrawer()
    await settle()
    expect(queryByTestId('worker-pane')).toBeNull()
    // 従来維持: no worker on THIS card → the Run button stays.
    expect((getByText('board.run.button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('no workers at all → the Run button stays (従来の実行ボタン維持)', async () => {
    h.workers = []
    const { queryByTestId, getByText } = renderDrawer()
    await settle()
    expect(queryByTestId('worker-pane')).toBeNull()
    expect(getByText('board.run.button')).toBeTruthy()
  })

  it('owner gate: a 403 orchestrator poll never shows the worker screen', async () => {
    // A non-owner is 403'd upstream → the client clears the map, so even a card
    // a worker is "on" shows the normal drawer, never the live screen.
    h.workers = [worker()]
    h.orchOk = false
    h.orchStatus = 403
    const { queryByTestId, getByText } = renderDrawer()
    await settle()
    expect(queryByTestId('worker-pane')).toBeNull()
    expect(getByText('board.run.button')).toBeTruthy()
  })

  it('worker PTY exit falls back to the Run button — no dead black screen', async () => {
    h.workers = [worker()]
    const { getByTestId, getByText, queryByTestId, queryByText } = renderDrawer()
    await settle()
    expect(getByTestId('worker-pane')).toBeTruthy()
    expect(queryByText('board.run.button')).toBeNull()
    // The worker's PTY closes (ClaudeTerminalPane.onExit) — our stub fires it.
    fireEvent.click(getByText('worker-exit'))
    await settle()
    // The dead worker id is marked exited → the drawer reverts to the draft Run
    // footer rather than leaving the terminal's black "exited" void. The poll
    // still reports the same worker, but its id stays suppressed.
    expect(queryByTestId('worker-pane')).toBeNull()
    expect(getByText('board.run.button')).toBeTruthy()
  })

  it('a re-dispatched worker (fresh terminalId) shows again after an exit', async () => {
    h.workers = [worker()]
    const { getByTestId, getByText, queryByTestId } = renderDrawer()
    await settle()
    fireEvent.click(getByText('worker-exit'))
    await settle()
    expect(queryByTestId('worker-pane')).toBeNull()
    // The engine re-dispatches: a NEW worker with a fresh terminalId (rework).
    h.workers = [worker({ terminalId: 'pty-worker-2' })]
    await repoll()
    const pane = getByTestId('worker-pane')
    expect(pane.getAttribute('data-terminalid')).toBe('pty-worker-2')
  })
})

// ── Commander strip gates (差し戻し M2) ──────────────────────────────────────
// The two load-bearing gates the per-card commander strip depends on, exercised
// through the REAL resolve path (BoardModule's orchestrator poll →
// resolveManagerForTask → BoardTab → BoardCard) — NOT a mocked managerForTask,
// which is exactly why the BoardCard-level tests could not catch these:
//  1. the NO-FABRICATION gate — a review card the engine does not list gets
//     NOTHING (the mutation `reviewsByTask.get(id) ?? 'unknown'` must go red);
//  2. the 403 owner-gate fallback — flipping to 403 must CLEAR shown linkage
//     (deleting the 403-branch clears must go red). 完了条件C.
describe('BoardModule board — commander strip gates (review column)', () => {
  const reviewTask = () =>
    makeTask({ id: 'r1', title: 'Review me', boardColumn: 'review', branch: 'swarm/r1' })
  const renderBoard = (card: ProjectTask) =>
    render(
      <BoardModule
        data={makeData(card)}
        project={baseProject}
        persist={vi.fn()}
        detailId={null}
        onOpenDetail={vi.fn()}
        renderConversation={() => <div />}
        hasTerminalSlot={() => false}
        liveTerminalId={() => null}
        onDeleteTask={vi.fn()}
        onLaunchTask={vi.fn(async () => ({ ok: true }))}
      />,
    )

  it('positive control: a review card IN the engine queue shows the strip', async () => {
    h.reviews = [{ taskId: 'r1', branch: 'swarm/r1', taskTitle: 'Review me', status: 'ff' }]
    h.managerPresence = 'working'
    const { getByText } = renderBoard(reviewTask())
    await settle()
    expect(getByText('board.card.managerLabel')).toBeTruthy()
    expect(getByText('· projectPanel.swarm.manager.reviewFf')).toBeTruthy()
  })

  it('NO-FABRICATION: a review card the engine does NOT list gets no strip', async () => {
    // The queue lists a DIFFERENT card; presence is quiet so the header badge
    // cannot blur the assertion. r1 (hand-made / someone else's branch) must
    // show nothing — never a fabricated 「判定中」.
    h.reviews = [{ taskId: 'other', branch: 'swarm/other', taskTitle: 'x', status: 'ff' }]
    h.managerPresence = 'quiet'
    const { queryByText } = renderBoard(reviewTask())
    await settle()
    expect(queryByText('board.card.managerLabel')).toBeNull()
  })

  it('owner gate: flipping to 403 clears an already-shown strip AND header badge', async () => {
    h.reviews = [{ taskId: 'r1', branch: 'swarm/r1', taskTitle: 'Review me', status: 'ff' }]
    h.managerPresence = 'working'
    const { getByText, queryByText } = renderBoard(reviewTask())
    await settle()
    expect(getByText('board.card.managerLabel')).toBeTruthy()
    // The poll turns non-owner: a STANDING auth state, not a blip — the linkage
    // must clear, not linger.
    h.orchOk = false
    h.orchStatus = 403
    await repoll()
    expect(queryByText('board.card.managerLabel')).toBeNull()
    expect(
      queryByText('board.card.managerLabel projectPanel.swarm.manager.stageRunning'),
    ).toBeNull()
  })

  it('B-3 header badge: commander working shows on the review lane even with an empty queue', async () => {
    // Engine stopped → reviews: [] — the per-card strips have nothing to hang
    // on, but the BOARD-LEVEL badge still tells the owner the commander is on
    // duty (the honest altitude when no per-card fact exists).
    h.reviews = []
    h.managerPresence = 'working'
    const { getByText, queryByText } = renderBoard(reviewTask())
    await settle()
    expect(
      getByText('board.card.managerLabel projectPanel.swarm.manager.stageRunning'),
    ).toBeTruthy()
    // …and no per-card strip is fabricated for it.
    expect(queryByText('board.card.managerLabel')).toBeNull()
  })
})
