// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask } from '@/lib/types'

// Board card activity — WHO is on a card and roughly what stage, plus the one
// thing the card must never do: say more than the record supports.
//
// Everything here runs through the REAL path (BoardModule's own polls →
// resolveWorkerForTask / resolveManagerForTask / resolveAlertForTask → BoardTab
// → BoardCard) and asserts on RENDERED OUTPUT. That matters twice over:
//   • a mocked resolver cannot catch a broken gate, because the gate lives in
//     the resolver;
//   • the swarm gate is a claim about what a NON-SWARM ACCOUNT SEES, so a test
//     asserting a boolean would be testing the wrong thing entirely.
//
// The three contracts under guard:
//   1. THE SWARM GATE — an account without the swarm experiment renders none of
//      it, even against a 200 server that hands over full swarm state.
//   2. NO FABRICATION — a worker/question the engine cannot tie to a card is
//      reported at BOARD altitude, never smeared onto cards (差し戻し M1/M2).
//   3. NO SILENT STALENESS — a note whose heartbeat went quiet must actually
//      change on screen; the map-identity optimisation must not freeze it.

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, vars?: Record<string, string | number>) =>
      vars ? `${k} ${JSON.stringify(vars)}` : k,
  }),
}))
vi.mock('@/components/canvas/CollabPresence', () => ({
  CollabPresence: () => null,
  usePublishPresence: () => {},
}))
vi.mock('@/components/canvas/modules/SwarmWorkerPane', () => ({
  SwarmWorkerPane: () => <div data-testid="worker-pane" />,
}))

const h = vi.hoisted(() => ({
  workers: [] as Array<Record<string, unknown>>,
  reviews: [] as Array<Record<string, unknown>>,
  managerPresence: undefined as string | undefined,
  orchOk: true,
  orchStatus: 200,
  escalations: [] as Array<Record<string, unknown>>,
  escOk: true,
  escStatus: 200,
  escCalls: 0,
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
        escalations: {
          $get: () => {
            h.escCalls++
            return Promise.resolve({
              ok: h.escOk,
              status: h.escStatus,
              json: () => Promise.resolve({ escalations: h.escalations }),
            })
          },
        },
      },
    },
  },
}))

import { BoardModule } from './BoardModule'

const task = (over: Partial<ProjectTask>): ProjectTask => ({
  id: 't1',
  title: 'Card',
  done: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  boardColumn: 'doing',
  ...over,
})

const data = (tasks: ProjectTask[]): ProjectData =>
  ({ description: '', tasks, notes: '', updatedAt: '' }) as ProjectData

const baseProject = { id: 'p1', name: 'proj', path: '/tmp/proj', hasGit: true } as ProjectMeta

const renderBoard = (tasks: ProjectTask[], swarmVisible: boolean) =>
  render(
    <BoardModule
      data={data(tasks)}
      project={baseProject}
      persist={vi.fn()}
      detailId={null}
      onOpenDetail={vi.fn()}
      renderConversation={() => <div />}
      hasTerminalSlot={() => false}
      liveTerminalId={() => null}
      onDeleteTask={vi.fn()}
      onLaunchTask={vi.fn(async () => ({ ok: true }))}
      swarmVisible={swarmVisible}
    />,
  )

// Both polls chain $get → res.json() → setState, so flush several microtask hops.
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
}
const repoll = async () => {
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await settle()
}

const workerRec = (over: Record<string, unknown> = {}) => ({
  terminalId: 'pty-1',
  branch: 'swarm/w1',
  taskId: 'doing1',
  taskTitle: 'Doing one',
  startedAt: '2026-01-01T00:00:00.000Z',
  stage: 'running',
  phase: 'implement',
  note: 'wiring the reducer',
  ...over,
})

const escRec = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  receiptKey: 'k1',
  createdAt: '2026-08-15T00:00:00.000Z',
  projectPath: '/tmp/proj',
  taskId: 'todo1',
  question: 'Delete the release tag?',
  context: 'ctx',
  whyEscalated: 'irreversible',
  status: 'open',
  ...over,
})

// A board carrying one card in each lane the surfaces care about.
// The worker strip's tooltip — where the branch handle and the worker's own
// report live since 2026-08-23 (both were card body rows until the owner had
// them removed: at ~260px they only ever rendered truncated). Asserting on the
// title is how these tests keep watching the SAME facts they always watched.
// Null when no strip is on screen at all, which is what the gate test needs.
const stripHint = (c: HTMLElement): string | null =>
  c.querySelector('[title^="swarm/w1"]')?.getAttribute('title') ?? null

const everyLane = () => [
  task({ id: 'doing1', title: 'Doing one', boardColumn: 'doing' }),
  task({ id: 'rev1', title: 'Review one', boardColumn: 'review', branch: 'swarm/r1' }),
  task({ id: 'todo1', title: 'Todo one', boardColumn: 'todo' }),
]

// Full swarm state: a worker on the doing card, the review card in the engine's
// queue, the commander working, and an open question on the todo card.
const fullSwarmState = () => {
  h.workers = [workerRec({ heartbeatAt: new Date().toISOString() })]
  h.reviews = [{ taskId: 'rev1', branch: 'swarm/r1', taskTitle: 'Review one', status: 'ff' }]
  h.managerPresence = 'working'
  h.escalations = [escRec()]
}

beforeEach(() => {
  localStorage.clear()
  h.workers = []
  h.reviews = []
  h.managerPresence = undefined
  h.orchOk = true
  h.orchStatus = 200
  h.escalations = []
  h.escOk = true
  h.escStatus = 200
  h.escCalls = 0
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ── 1. THE SWARM GATE ───────────────────────────────────────────────────────
describe('swarm gate — a non-swarm account renders NO swarm surface on the Board', () => {
  it('POSITIVE CONTROL: with the gate open, every surface is on screen', async () => {
    fullSwarmState()
    const { getByText, getAllByText, container } = renderBoard(everyLane(), true)
    await settle()
    // 稼働中 twice: the doing card's worker strip and the review card's
    // commander presence word — the shared Swarm-tab vocabulary, on purpose.
    expect(getAllByText('projectPanel.swarm.manager.stageRunning')).toHaveLength(2)
    // Branch + note are in the strip's tooltip now, not card body text.
    expect(stripHint(container)).toBe('swarm/w1 — wiring the reducer')
    expect(getByText('board.card.managerLabel')).toBeTruthy() // commander strip
    expect(getByText('board.card.needsYou')).toBeTruthy() // needs-you badge
    expect(container.textContent).toContain('board.card.phaseImplement')
  })

  it('with the gate CLOSED and a 200 server handing over everything, none of it renders', async () => {
    // ⚠ The server answers 200 here on purpose. This asserts the CLIENT gate:
    // an owner with the swarm experiment OFF is not 403'd by the route, so the
    // server's owner gate cannot be what hides this.
    fullSwarmState()
    const { getByText, queryByText, container } = renderBoard(everyLane(), false)
    await settle()
    // The board itself still works — this is the positive control that keeps
    // the absences below from passing because nothing rendered at all.
    expect(getByText('Doing one')).toBeTruthy()
    expect(getByText('Review one')).toBeTruthy()
    expect(getByText('Todo one')).toBeTruthy()
    // …and every swarm surface is gone.
    expect(queryByText('projectPanel.swarm.manager.stageRunning')).toBeNull()
    // ⚠ Branch and note left the card BODY in 2026-08-23, so queryByText for
    // them now passes with the gate wide open — it would be a tautology here.
    // The strip's tooltip is the live assertion: no strip, no hint.
    expect(stripHint(container)).toBeNull()
    expect(queryByText('swarm/w1')).toBeNull()
    expect(queryByText('wiring the reducer')).toBeNull()
    expect(queryByText('board.card.managerLabel')).toBeNull()
    expect(queryByText('board.card.needsYou')).toBeNull()
    // No swarm vocabulary anywhere in the rendered tree — not the phase words,
    // not the honesty line, not the commander duty badge.
    expect(container.textContent).not.toContain('board.card.phase')
    expect(container.textContent).not.toContain('board.swarm.')
    expect(container.textContent).not.toContain('projectPanel.swarm.')
  })

  it('with the gate closed the Board never even ASKS the swarm routes', async () => {
    fullSwarmState()
    renderBoard(everyLane(), false)
    await settle()
    await repoll()
    expect(h.escCalls).toBe(0)
  })

  it('the board-wide honesty line is gated too', async () => {
    // Unattributed activity exists — but a non-swarm account is told nothing
    // about the swarm, including its unattributable parts.
    h.workers = [workerRec({ taskId: '' })]
    h.escalations = [escRec({ taskId: undefined })]
    const { queryByText } = renderBoard(everyLane(), false)
    await settle()
    expect(queryByText(/board\.swarm\.unattributed/)).toBeNull()
  })

  it('FAIL-CLOSED: a host that passes no gate at all gets the hidden side', async () => {
    // A new host (or a refactor that drops the prop) must land on "hidden", not
    // on "shown". The absence of a decision is not permission.
    fullSwarmState()
    const { getByText, queryByText, container } = render(
      <BoardModule
        data={data(everyLane())}
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
    await settle()
    expect(getByText('Doing one')).toBeTruthy() // positive control
    expect(queryByText('swarm/w1')).toBeNull()
    expect(queryByText('board.card.needsYou')).toBeNull()
    expect(container.textContent).not.toContain('projectPanel.swarm.')
  })

  it('the DRAWER is gated too — no live swarm worker screen for a non-swarm account', async () => {
    // This surface reads the worker map directly rather than through a gated
    // resolver, so it needs its own check. Without it the drawer would hand a
    // non-swarm account a running worker's claude screen in place of its Run
    // button — the most privileged thing on this whole tab.
    fullSwarmState()
    const open = (swarmVisible: boolean) =>
      render(
        <BoardModule
          data={data(everyLane())}
          project={baseProject}
          persist={vi.fn()}
          detailId="doing1"
          onOpenDetail={vi.fn()}
          renderConversation={() => <div data-testid="conversation" />}
          hasTerminalSlot={() => false}
          liveTerminalId={() => null}
          onDeleteTask={vi.fn()}
          onLaunchTask={vi.fn(async () => ({ ok: true }))}
          swarmVisible={swarmVisible}
        />,
      )
    const shown = open(true)
    await settle()
    expect(shown.queryByTestId('worker-pane')).toBeTruthy() // positive control
    cleanup()
    const hidden = open(false)
    await settle()
    expect(hidden.queryByTestId('worker-pane')).toBeNull()
    // …and the ordinary Run button is what the card offers instead.
    expect(hidden.getByText('board.run.button')).toBeTruthy()
  })

  it('the commander DUTY BADGE (a raw prop, not a resolver) is gated too', async () => {
    // reviewManagerPresence is the one swarm fact passed as a value rather than
    // through a gated callback, so it needs its own check.
    h.reviews = []
    h.managerPresence = 'working'
    const { queryByText } = renderBoard(everyLane(), false)
    await settle()
    expect(
      queryByText('board.card.managerLabel projectPanel.swarm.manager.stageRunning'),
    ).toBeNull()
  })
})

// ── 2. NO FABRICATION ───────────────────────────────────────────────────────
describe('honesty — activity the engine cannot tie to a card', () => {
  it('a worker with NO taskId is reported board-wide, never on a card', async () => {
    h.workers = [
      workerRec({ terminalId: 'pty-a', taskId: '' }),
      workerRec({ terminalId: 'pty-b', taskId: '', branch: 'swarm/w2' }),
    ]
    const { getByText, queryByText } = renderBoard(everyLane(), true)
    await settle()
    // Counted at the altitude where it is true…
    expect(getByText(/board\.swarm\.unattributedWorkers.*"n":2/)).toBeTruthy()
    // …and NO card claims one of them.
    expect(queryByText('swarm/w1')).toBeNull()
    expect(queryByText('projectPanel.swarm.manager.stageRunning')).toBeNull()
  })

  it('counts unattributed workers EXPLICITLY — two workers may share one taskId', async () => {
    // workers.length - map.size would report 1 phantom here. There is none.
    h.workers = [
      workerRec({ terminalId: 'pty-a', taskId: 'doing1' }),
      workerRec({ terminalId: 'pty-b', taskId: 'doing1', branch: 'swarm/w2' }),
    ]
    const { queryByText } = renderBoard(everyLane(), true)
    await settle()
    expect(queryByText(/board\.swarm\.unattributedWorkers/)).toBeNull()
  })

  it('an escalation with NO taskId is counted board-wide and marks no card', async () => {
    h.escalations = [escRec({ taskId: undefined }), escRec({ id: 'e2', taskId: undefined })]
    const { getByText, queryByText } = renderBoard(everyLane(), true)
    await settle()
    expect(getByText(/board\.swarm\.unattributedQuestions.*"n":2/)).toBeTruthy()
    expect(queryByText('board.card.needsYou')).toBeNull()
  })

  it('nothing unattributed → the line is absent entirely (it never reassures)', async () => {
    fullSwarmState()
    const { queryByText } = renderBoard(everyLane(), true)
    await settle()
    expect(queryByText(/board\.swarm\.unattributed/)).toBeNull()
  })

  it('an escalation rooted in a card marks THAT card only', async () => {
    h.escalations = [escRec({ taskId: 'todo1' })]
    const { getAllByText, container } = renderBoard(everyLane(), true)
    await settle()
    expect(getAllByText('board.card.needsYou')).toHaveLength(1)
    const marked = container.querySelector('[title="Delete the release tag?"]')
    expect(marked).toBeTruthy()
    expect(marked?.closest('article')?.textContent).toContain('Todo one')
  })

  it('a 404 escalations route (older server) claims nothing either way', async () => {
    // The route does not exist → we do not know whether anything is waiting.
    // The correct output is silence, NOT an all-clear — and the surfaces fed by
    // the still-200 orchestrator poll must keep working.
    fullSwarmState()
    h.escOk = false
    h.escStatus = 404
    const { getByText, queryByText, container } = renderBoard(everyLane(), true)
    await settle()
    expect(queryByText('board.card.needsYou')).toBeNull()
    expect(container.textContent).not.toMatch(/allClear|判断待ちはありません/)
    // The other poll is unaffected — a dead escalations route must not blank
    // the worker strips.
    expect(stripHint(container)).toBe('swarm/w1 — wiring the reducer')
  })

  it('the roll-up NEVER prints a waiting count it did not read (「判断待ち0」)', async () => {
    // The defect the reviewer found: the roll-up was one three-slot template,
    // so an unread inbox rendered `waiting: 0` — the very reassurance the card
    // layer refuses to make. The card badge and the honesty line were correct;
    // the roll-up was the only thing on the Board speaking about escalations,
    // and it said you were clear.
    fullSwarmState()
    h.escalations = [escRec({ taskId: 'todo1' })]
    h.escOk = false
    h.escStatus = 404
    const { container } = renderBoard(everyLane(), true)
    await settle()
    const text = container.textContent ?? ''
    // The clause is OMITTED, not zeroed — in either rendering of the mock t().
    expect(text).not.toContain('board.supply.rollupWaiting')
    expect(text).not.toMatch(/判断待ち0|0 waiting on you/)
    // …while the clauses we DID read are still said.
    expect(text).toContain('board.supply.rollupWorking')
  })

  it('the roll-up drops the engine clauses too when no lap has landed', async () => {
    // Same rule, other poll: `0 working` beside a running worker is the same
    // kind of lie, just from the orchestrator side.
    fullSwarmState()
    h.orchOk = false
    h.orchStatus = 500
    const { container } = renderBoard(everyLane(), true)
    await settle()
    const text = container.textContent ?? ''
    expect(text).not.toContain('board.supply.rollupWorking')
    expect(text).not.toContain('board.supply.rollupReview')
  })

  it('the fleet list says NOT CHECKED, never "no workers", before a lap lands', async () => {
    // "Not told" and "none" are different facts. Rendering the second while a
    // worker is mid-task is a flat contradiction of the card strips beside it.
    fullSwarmState()
    // The fleet list only exists while the dock is expanded.
    localStorage.setItem('openground.board.supplydock.p1', JSON.stringify({ open: true, h: 300 }))
    h.orchOk = false
    h.orchStatus = 500
    const { container } = renderBoard(everyLane(), true)
    await settle()
    const text = container.textContent ?? ''
    expect(text).not.toContain('board.supply.noWorkers')
    expect(text).toContain('board.supply.workersUnknown')
  })

  it('a 403 escalations route clears an already-shown badge (standing auth state)', async () => {
    h.escalations = [escRec({ taskId: 'todo1' })]
    const { getByText, queryByText } = renderBoard(everyLane(), true)
    await settle()
    expect(getByText('board.card.needsYou')).toBeTruthy()
    h.escOk = false
    h.escStatus = 403
    await repoll()
    expect(queryByText('board.card.needsYou')).toBeNull()
  })

  it('a transient 500 KEEPS the last badge rather than flashing it off', async () => {
    h.escalations = [escRec({ taskId: 'todo1' })]
    const { getByText } = renderBoard(everyLane(), true)
    await settle()
    expect(getByText('board.card.needsYou')).toBeTruthy()
    h.escOk = false
    h.escStatus = 500
    await repoll()
    // Still there: a blip is not evidence the question was answered.
    expect(getByText('board.card.needsYou')).toBeTruthy()
  })
})

// ── 3. NO SILENT STALENESS ──────────────────────────────────────────────────
describe('worker note freshness survives the map-identity optimisation', () => {
  it('a heartbeat that goes quiet turns the note stale ON SCREEN, across polls', async () => {
    // Lap 1: a fresh beat — the note is a statement about now.
    h.workers = [workerRec({ heartbeatAt: new Date().toISOString() })]
    const { container } = renderBoard(everyLane(), true)
    await settle()
    // A current note prints bare — no 「最後の報告:」 prefix.
    expect(stripHint(container)).toBe('swarm/w1 — wiring the reducer')
    // Lap 2: the SAME worker, same branch/stage/phase/note — only the beat is
    // older. Every other field in the identity test is byte-identical, so if
    // the freshness verdict is not part of that test the map keeps its identity
    // and this screen never updates: the card goes on printing a 30-minute-old
    // note as if it were current. Silent, and permanent.
    h.workers = [workerRec({ heartbeatAt: new Date(Date.now() - 30 * 60_000).toISOString() })]
    await repoll()
    expect(stripHint(container)).toBe('swarm/w1 — board.card.noteStale wiring the reducer')
  })

  it('a worker the engine reports with NO beat time shows no note line', async () => {
    h.workers = [workerRec({ heartbeatAt: undefined })]
    const { container, queryByText } = renderBoard(everyLane(), true)
    await settle()
    // Positive control: the strip IS up (its hint names the branch) — so the
    // absence below is about the note, not a board that failed to render.
    expect(stripHint(container)).toBe('swarm/w1')
    expect(queryByText('wiring the reducer')).toBeNull()
    expect(queryByText('board.card.noteStale')).toBeNull()
  })
})
