// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, screen, fireEvent, within } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask } from '@/lib/types'

// The Board's FRONT DESK — the supply seat plus the worker monitor.
//
// Everything runs through the REAL path (BoardModule's own orchestrator poll →
// BoardSupplyDock → useSupplyDesk) and asserts on RENDERED OUTPUT and on the
// REQUESTS THAT ACTUALLY WENT OUT. Mocking the dock's inputs would test nothing:
// three of the four contracts below are claims about what the surface does when
// nobody is watching it.
//
// The contracts under guard:
//   1. THE SWARM GATE — an account without the swarm experiment sees no
//      front-desk affordance at all, even against a 200 server handing over a
//      live desk handle. Checked at the RENDER site, not only at the poll.
//   2. ONE DESK, TWO SURFACES — the Board ATTACHES to the desk the server
//      published. It never POSTs a spawn to "make sure" one exists: a second
//      補給官 mints a fresh session id and overwrites the project's single
//      stored slot, so the first desk's conversation is forgotten while its PTY
//      keeps running.
//   3. "NOT TOLD" IS NOT "NO DESK" — an orchestrator response with NO
//      supplyDesk field (an older server, or simply the first frame before the
//      poll lands) renders neither 「閉じています」 nor a launch CTA.
//   4. NO FABRICATED CARD LINK — a worker the engine cannot tie to a card on
//      THIS board is labelled as such, never given a borrowed title.

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
  escalations: [] as Array<Record<string, unknown>>,
  /** undefined ⇒ the key is OMITTED from the response (the old-server shape). */
  supplyDesk: undefined as Record<string, unknown> | null | undefined,
  paneMounts: [] as string[],
  deletedTerminals: [] as string[],
}))

vi.mock('@/components/canvas/ClaudeTerminalPane', () => ({
  ClaudeTerminalPane: ({ terminalId }: { terminalId: string }) => {
    h.paneMounts.push(terminalId)
    return <div data-testid="claude-pane" data-terminal={terminalId} />
  },
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
        ':id': {
          $delete: ({ param }: { param: { id: string } }) => {
            h.deletedTerminals.push(param.id)
            return Promise.resolve({ ok: true })
          },
        },
      },
      swarm: {
        orchestrator: {
          $get: () =>
            Promise.resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  running: true,
                  maxWorkers: 6,
                  workers: h.workers,
                  reviews: h.reviews,
                  log: [],
                  anomalies: [],
                  // OMITTED entirely when undefined — the old-server shape.
                  ...(h.supplyDesk === undefined ? {} : { supplyDesk: h.supplyDesk }),
                }),
            }),
        },
        escalations: {
          $get: () =>
            Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ escalations: h.escalations }),
            }),
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

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() })
}

/** The dock remembers open/closed per project — seed it OPEN so the expanded
 *  body (the desk + the monitor) is on screen without a click. */
const openDock = () =>
  localStorage.setItem('openground.board.supplydock.p1', JSON.stringify({ open: true, h: 300 }))

const liveDesk = { runtime: 'pty', handleId: 'pty-9', agentSessionId: 'sid-9' }

const workerRec = (over: Record<string, unknown> = {}) => ({
  terminalId: 'pty-1',
  branch: 'swarm/w1',
  taskId: 'doing1',
  taskTitle: 'Doing one',
  startedAt: '2026-01-01T00:00:00.000Z',
  stage: 'running',
  phase: 'implement',
  ...over,
})

let postedUrls: string[] = []

beforeEach(() => {
  localStorage.clear()
  h.workers = []
  h.reviews = []
  h.escalations = []
  h.supplyDesk = null
  h.paneMounts = []
  h.deletedTerminals = []
  postedUrls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      postedUrls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ terminalId: 'pty-new', agentSessionId: 'sid-new', resumed: false }),
      } as unknown as Response
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the swarm gate — a non-swarm account has no front desk', () => {
  it('renders NO dock, no title, no launch CTA — against a 200 server with a LIVE desk', async () => {
    openDock()
    h.supplyDesk = liveDesk
    h.workers = [workerRec()]
    renderBoard([task({ id: 'doing1', title: 'Doing one' })], false)
    await settle()

    expect(screen.queryByTestId('board-supply-dock')).toBeNull()
    expect(screen.queryByText('board.supply.title')).toBeNull()
    expect(screen.queryByText('board.supply.open')).toBeNull()
    expect(screen.queryByText('board.supply.closed')).toBeNull()
    // And it never attached to the desk it was told about.
    expect(h.paneMounts).toEqual([])
    // Positive control: the board itself DID render, so the absences above are
    // not "nothing mounted".
    expect(screen.getByText('Doing one')).toBeTruthy()
  })

  it('the SAME state on a swarm account renders the desk (the positive control)', async () => {
    openDock()
    h.supplyDesk = liveDesk
    h.workers = [workerRec()]
    renderBoard([task({ id: 'doing1', title: 'Doing one' })], true)
    await settle()

    expect(screen.queryByTestId('board-supply-dock')).toBeTruthy()
    expect(screen.queryByText('board.supply.title')).toBeTruthy()
    expect(h.paneMounts).toContain('pty-9')
  })
})

describe('one desk, two surfaces — the Board attaches, it never spawns', () => {
  it('mounts the pane on the PUBLISHED handle and POSTs nothing', async () => {
    openDock()
    h.supplyDesk = liveDesk
    renderBoard([task({})], true)
    await settle()

    expect(screen.getByTestId('claude-pane').getAttribute('data-terminal')).toBe('pty-9')
    // The whole contract in one assertion: no spawn request left the client.
    expect(postedUrls.filter(u => u.includes('/api/swarm/supply'))).toEqual([])
  })

  it('adopting the published desk WRITES the shared record, so the Swarm tab finds the same desk', async () => {
    openDock()
    h.supplyDesk = liveDesk
    renderBoard([task({})], true)
    await settle()

    // The SAME key SwarmModule reads. Two surfaces, one record — that is what
    // makes them the same desk rather than two views that drift apart.
    const stored = JSON.parse(localStorage.getItem('openground.swarm.supply.p1') ?? 'null')
    expect(stored).toMatchObject({ terminalId: 'pty-9', agentSessionId: 'sid-9' })
  })

  it('the launch CTA is the ONLY thing that POSTs a spawn', async () => {
    openDock()
    h.supplyDesk = null
    renderBoard([task({})], true)
    await settle()
    expect(postedUrls.filter(u => u.includes('/api/swarm/supply'))).toEqual([])

    await act(async () => {
      fireEvent.click(screen.getByText('board.supply.open'))
    })
    await settle()

    expect(postedUrls.filter(u => u === '/api/swarm/supply')).toEqual(['/api/swarm/supply'])
    expect(screen.getByTestId('claude-pane').getAttribute('data-terminal')).toBe('pty-new')
  })

  it('stop goes through the INTENT-clearing route, not just a raw terminal delete', async () => {
    // /api/swarm/supply/stop also clears supplyDesired — without it, boot
    // auto-resume resurrects a desk the owner just closed, every restart.
    openDock()
    h.supplyDesk = liveDesk
    renderBoard([task({})], true)
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByText('board.supply.stop'))
    })
    await settle()

    expect(postedUrls).toContain('/api/swarm/supply/stop')
    expect(h.deletedTerminals).toContain('pty-9')
    expect(screen.queryByTestId('claude-pane')).toBeNull()
  })

  it('停止 STICKS — the closed desk does not come back on the next poll', async () => {
    // The server keeps publishing the handle for up to a poll after the kill
    // (its answer is a process-table read taken before the DELETE landed). The
    // reconcile is built to ADOPT a live desk the record does not name, so
    // without the just-stopped marker the pane the owner closed reappears —
    // and closing it again loses the same race. Same failure the commander's
    // 停止 had (overnight review 2026-08-03), one pool over.
    openDock()
    h.supplyDesk = liveDesk
    renderBoard([task({})], true)
    await settle()
    expect(screen.getByTestId('claude-pane')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByText('board.supply.stop'))
    })
    await settle()
    // Poll again with the server STILL naming the desk it has not reaped yet.
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await settle()

    expect(screen.queryByTestId('claude-pane')).toBeNull()
    expect(screen.getByText('board.supply.open')).toBeTruthy()
    // And it did not quietly re-adopt in the shared record either.
    expect(localStorage.getItem('openground.swarm.supply.p1')).toBeNull()
  })
})

describe('"the server did not say" is not "there is no desk"', () => {
  it('an orchestrator response with NO supplyDesk field renders neither "closed" nor a CTA', async () => {
    openDock()
    h.supplyDesk = undefined // key omitted entirely
    renderBoard([task({})], true)
    await settle()

    // The dock is there (the monitor half still has things to say) — but it
    // makes no claim about the desk.
    expect(screen.getByTestId('board-supply-dock')).toBeTruthy()
    expect(screen.queryByText('board.supply.closed')).toBeNull()
    expect(screen.queryByText('board.supply.open')).toBeNull()
    expect(screen.queryByTestId('claude-pane')).toBeNull()
  })

  it('a DEFINITE null does earn the closed copy + CTA (the positive control)', async () => {
    openDock()
    h.supplyDesk = null
    renderBoard([task({})], true)
    await settle()

    expect(screen.getByText('board.supply.closed')).toBeTruthy()
    expect(screen.getByText('board.supply.open')).toBeTruthy()
  })
})

describe('the fleet monitor', () => {
  it('names the card a worker is on, and REFUSES to name one it cannot tie', async () => {
    openDock()
    h.supplyDesk = liveDesk
    h.workers = [
      workerRec({ terminalId: 'pty-1', branch: 'swarm/on-card', taskId: 'doing1' }),
      // No taskId at all — a curl spawn, a Swarm-tab restart, a boot-resumed
      // roster row. Real work with no card.
      workerRec({ terminalId: 'pty-2', branch: 'swarm/loose', taskId: '' }),
      // A taskId this board does not hold (another project's card id forged in,
      // or a card deleted since dispatch).
      workerRec({ terminalId: 'pty-3', branch: 'swarm/ghost', taskId: 'no-such-card' }),
    ]
    renderBoard([task({ id: 'doing1', title: 'Doing one' })], true)
    await settle()

    // Scoped to the DOCK: the doing card's own worker strip prints the same
    // branch, and a page-wide query would pass on the card's copy alone.
    const dock = within(screen.getByTestId('board-supply-dock'))
    expect(dock.getByText('swarm/on-card')).toBeTruthy()
    expect(dock.getByText('swarm/loose')).toBeTruthy()
    expect(dock.getByText('swarm/ghost')).toBeTruthy()
    // The one worker the board CAN place is named by its card title.
    expect(dock.getByText('Doing one')).toBeTruthy()
    // Exactly the two unattributable ones say so — never a borrowed title.
    expect(dock.getAllByText('board.supply.workerNoCard').length).toBe(2)
  })

  it('rolls up what is running, in review, and waiting on the owner', async () => {
    openDock()
    h.supplyDesk = liveDesk
    h.workers = [workerRec({ terminalId: 'pty-1' })]
    h.reviews = [{ taskId: 'rev1', branch: 'swarm/r1', taskTitle: 'Review one', status: 'ff' }]
    h.escalations = [
      {
        id: 'e1',
        receiptKey: 'k1',
        createdAt: '2026-08-15T00:00:00.000Z',
        projectPath: '/tmp/proj',
        taskId: 'doing1',
        question: 'q',
        context: 'c',
        whyEscalated: 'irreversible',
        status: 'open',
      },
      // No taskId — counted in the roll-up all the same: it is a question
      // waiting on the owner, and dropping it would lose exactly the ones that
      // have no card to surface them.
      {
        id: 'e2',
        receiptKey: 'k2',
        createdAt: '2026-08-15T00:00:00.000Z',
        projectPath: '/tmp/proj',
        question: 'q2',
        context: 'c',
        whyEscalated: 'policy',
        status: 'open',
      },
    ]
    renderBoard(
      [
        task({ id: 'doing1', title: 'Doing one' }),
        task({ id: 'rev1', title: 'Review one', boardColumn: 'review' }),
      ],
      true,
    )
    await settle()

    // One clause per thing we actually read, joined — NOT one template with
    // three slots, which is what let an unread inbox print 「判断待ち0」.
    expect(screen.getByText(/board\.supply\.rollupWorking \{"n":1\}/)).toBeTruthy()
    expect(screen.getByText(/board\.supply\.rollupReview \{"n":1\}/)).toBeTruthy()
    expect(screen.getByText(/board\.supply\.rollupWaiting \{"n":2\}/)).toBeTruthy()
  })
})

describe('the height drag detaches on EVERY way a gesture ends', () => {
  // The defect: only `pointerup` detached. A cancelled gesture (trackpad scroll
  // taking over, touch interrupted, pointer stolen) left the drag armed
  // forever — every later mouse move, no button held, dragged the dock — and
  // every new press stacked another listener pair on window.
  const move = (clientY: number) => {
    const e = new Event('pointermove') as PointerEvent & { clientY: number }
    Object.defineProperty(e, 'clientY', { value: clientY })
    window.dispatchEvent(e)
  }

  it('a CANCELLED drag stops following the pointer', async () => {
    openDock()
    const { container } = renderBoard([task({ id: 'doing1', title: 'Doing one' })], true)
    await settle()
    const grip = container.querySelector('[role="separator"]')
    expect(grip, 'no resize grip found — update the selector').toBeTruthy()

    fireEvent.pointerDown(grip as Element, { clientY: 500 })
    // The browser takes the gesture away instead of completing it.
    await act(async () => {
      window.dispatchEvent(new Event('pointercancel'))
    })
    // …and an ordinary move afterwards must change nothing.
    await act(async () => move(400))

    const panel = container.querySelector('[data-testid="board-supply-dock"]') as HTMLElement
    const body = panel.querySelector('[style*="height"]') as HTMLElement | null
    expect(body?.style.height ?? '300px').toBe('300px')
  })

  it('a COMPLETED drag still resizes — the fix did not disarm the feature', async () => {
    openDock()
    const { container } = renderBoard([task({ id: 'doing1', title: 'Doing one' })], true)
    await settle()
    const grip = container.querySelector('[role="separator"]')!
    fireEvent.pointerDown(grip, { clientY: 500 })
    await act(async () => move(400)) // dragging UP grows the dock
    const panel = container.querySelector('[data-testid="board-supply-dock"]') as HTMLElement
    const body = panel.querySelector('[style*="height"]') as HTMLElement | null
    expect(body?.style.height).toBe('400px')
  })
})
