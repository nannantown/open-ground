// @vitest-environment jsdom
//
// The one-screen Swarm tab after the manager's seat shrank to a nameplate
// (card ③, 2026-09-23 — the owner talks only to the president):
//
//   ① the fleet's question poll asks only for OPEN questions in the OWNER's
//      lane — a question the manager is still settling must not read as one
//      the owner is waiting on;
//   ② a folded worker seat shows the PLAIN wording when the raiser wrote one;
//   ③ the manager's seat is status + start/stop and nothing else, its status
//      read from the active-desk poll (both pools), and a stored desk that died
//      while the app was closed is noticed without a rendered stream.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, within, act } from '@testing-library/react'
import type { ProjectMeta, SwarmOrchestratorState, SwarmWorkerRecord } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
    lang: 'en',
    setLang: () => {},
    toggleLang: () => {},
  }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}))

// These tests are about what an OPEN seat does, so every manager / worker seat
// starts unfolded here (the real default is folded — see
// SwarmSeatStrip and the "icon rail" tests in SwarmModule.seats.test.tsx).
const seatFold = vi.hoisted(() => ({ allOpen: true }))
vi.mock('./SwarmSeatStrip', async (importOriginal) => {
  const real = await importOriginal<typeof import('./SwarmSeatStrip')>()
  class AllOpen extends Set<string> {
    has() {
      return true
    }
  }
  return { ...real, loadOpenSeats: (id: string) => (seatFold.allOpen ? new AllOpen() : real.loadOpenSeats(id)) }
})

import { SwarmModule } from './SwarmModule'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

class FakeEventSource {
  constructor(public url: string) {
    ;((globalThis as { __esUrls?: string[] }).__esUrls ??= []).push(url)
  }
  addEventListener() {}
  close() {}
}

const project: ProjectMeta = {
  id: 'p-seats',
  name: 'proj',
  path: '/pseats',
  description: '',
  lastModified: '2026-09-23T00:00:00.000Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
}

const sdkWorker: SwarmWorkerRecord = {
  worktree: '/home/.openground/projects/p-seats/worktrees/swarm-card-1',
  branch: 'swarm/card-1',
  runtime: 'sdk',
  sdkSessionId: 'sdk-w1',
  taskTitle: '画面を片付ける',
}

const engineState = (overLimit = false): SwarmOrchestratorState => ({
  running: true,
  manualStop: false,
  manualStopPersisted: false,
  overseer: false,
  workers: [],
  reviews: [],
  log: [],
  anomalies: [],
  maxWorkers: 3,
  kpis: {
    leadTime: { medianMs: null, count: 0 },
    conflictRate: null,
    reworkRate: null,
    workerSuccessRate: null,
    counts: { dispatched: 0, integrated: 0, conflicted: 0, reworked: 0, crashed: 0, stalled: 0 },
  },
  consumption: overLimit
    ? { activeWorkers: 1, activeRunMs: 0, dispatched: 51, limit: 50, overLimit: true }
    : { activeWorkers: 0, activeRunMs: 0, dispatched: 0, limit: 0, overLimit: false },
  autonomyRemembered: false,
  autonomyResumed: false,
  overseerRemembered: false,
  managerDesk: null,
})

const MANAGER_SDK_ID = 'sdk-mgr'

const harness = (opts: {
  escalations?: unknown[]
  /** Desk ids the active-desk poll reports as live. */
  active?: () => { id: string; status: string }[]
  /** What GET /api/sdk-session/:id answers for the manager probe. */
  managerProbe?: number
  /** …and its body (default: alive, not reaped). */
  managerProbeBody?: () => unknown
  /** The engine reports the dispatch budget passed. */
  overLimit?: boolean
  /** Fully idle swarm: engine stopped, no workers (the first-run state). */
  idle?: boolean
}) => {
  const urls: string[] = []
  const answered: string[] = []
  let current = ''
  const json = (body: unknown, status = 200) => {
    const u = current
    return Promise.resolve(new Response(JSON.stringify(body), { status })).then((r) => {
      answered.push(u)
      return r
    })
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = typeof input === 'string' ? input : ((input as Request)?.url ?? String(input))
      urls.push(url)
      current = url
      if (url.includes('/api/terminal/active')) return json({ claude: opts.active?.() ?? [] })
      if (url.startsWith('/api/swarm/workers')) return json({ workers: opts.idle ? [] : [sdkWorker] })
      if (url.startsWith('/api/swarm/orchestrator'))
        return json(opts.idle ? { ...engineState(), running: false } : engineState(opts.overLimit))
      if (url.startsWith('/api/swarm/preflight')) return json({ issues: [] })
      if (url.startsWith('/api/swarm/escalations')) return json({ escalations: opts.escalations ?? [] })
      if (url.startsWith(`/api/sdk-session/${MANAGER_SDK_ID}`))
        return json(opts.managerProbeBody?.() ?? { status: 'working' }, opts.managerProbe ?? 200)
      return json({})
    }),
  )
  return { urls, answered }
}

const storeManager = () =>
  localStorage.setItem(
    `openground.swarm.manager.${project.id}`,
    JSON.stringify({
      terminalId: '',
      runtime: 'sdk',
      sdkSessionId: MANAGER_SDK_ID,
      agentSessionId: '',
      startedAt: '2026-09-23T00:00:00.000Z',
    }),
  )

afterEach(() => {
  cleanup()
  delete (globalThis as { __esUrls?: string[] }).__esUrls
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the fleet question poll (①②)', () => {
  it('asks only for OPEN questions in the OWNER lane', async () => {
    const { urls } = harness({})
    render(<SwarmModule project={project} />)
    await waitFor(() => expect(urls.some((u) => u.startsWith('/api/swarm/escalations'))).toBe(true))
    const polls = urls.filter((u) => u.startsWith('/api/swarm/escalations'))
    for (const u of polls) {
      const q = new URL(u, 'http://x').searchParams
      expect(q.get('status')).toBe('open')
      expect(q.get('lane')).toBe('owner')
    }
  })

  it('shows the plain wording on the folded seat, not the technical one', async () => {
    harness({
      escalations: [
        {
          status: 'open',
          sdkSessionId: 'sdk-w1',
          question: 'rebase conflict in src/x.ts:12 — keep ours?',
          plainQuestion: '同じ場所を2人が直しました。どちらを残しますか？',
          createdAt: '2026-09-23T01:00:00.000Z',
        },
      ],
    })
    render(<SwarmModule project={project} />)
    expect(await screen.findByText('同じ場所を2人が直しました。どちらを残しますか？')).toBeTruthy()
    expect(screen.queryByText('rebase conflict in src/x.ts:12 — keep ours?')).toBeNull()
  })
})

describe("the manager's seat (③, conversation since 2026-09-24)", () => {
  it('shows RUNNING, stop, a folded send link and its polled conversation — no stream', async () => {
    storeManager()
    const h = harness({ active: () => [{ id: MANAGER_SDK_ID, status: 'working' }] })
    render(<SwarmModule project={project} />)
    expect(await screen.findByText('projectPanel.swarm.manager.stateRunning')).toBeTruthy()
    // The seat as SwarmModule mounts it (2026-09-24): stop + the FOLDED
    // send-a-word link, the desk's conversation polled from its tail — and
    // still NO stream: a stream per seat is the six-connection freeze.
    const seat = document.querySelector('[data-seat="manager"]')!
    expect(seat).toBeTruthy()
    const buttons = within(seat as HTMLElement).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'projectPanel.swarm.seat.fold',
      'projectPanel.swarm.manager.stopFull',
      'projectPanel.swarm.say.open',
    ])
    expect(seat.querySelector('textarea, input, aside')).toBeNull()
    expect(seat.querySelector('[data-seat-feed]')).toBeTruthy()
    await waitFor(() =>
      expect(h.urls.some((u) => u.startsWith(`/api/sdk-session/${MANAGER_SDK_ID}/tail?`))).toBe(true),
    )
    expect(
      (globalThis as { __esUrls?: string[] }).__esUrls?.some((u) => u.includes(MANAGER_SDK_ID)) ?? false,
    ).toBe(false)
  })

  it('tells the owner, in one line, when the unattended loop passes its budget', async () => {
    harness({ overLimit: true })
    render(<SwarmModule project={project} />)
    expect(
      await screen.findByText('projectPanel.swarm.overLimit:{"dispatched":51,"limit":50}'),
    ).toBeTruthy()
  })

  it('notices a stored desk that died while the app was closed, and says "not there"', async () => {
    storeManager()
    harness({ managerProbe: 404 })
    render(<SwarmModule project={project} />)
    expect(await screen.findByText('projectPanel.swarm.manager.stateAbsent')).toBeTruthy()
    expect(localStorage.getItem(`openground.swarm.manager.${project.id}`)).toBeNull()
  })

  it('reads the desk off the active poll: seen, then lost, the record is cleared', async () => {
    // Without this the record stayed after a mid-session death, so the top
    // bar's Start (planSwarmPower's hasManager) would not relaunch the manager.
    storeManager()
    let live = [{ id: MANAGER_SDK_ID, status: 'working' }]
    const { urls } = harness({ active: () => live })
    render(<SwarmModule project={project} />)
    await waitFor(() => expect(urls.some((u) => u.includes('/api/terminal/active'))).toBe(true))
    expect(await screen.findByText('projectPanel.swarm.manager.stateRunning')).toBeTruthy()
    live = []
    window.dispatchEvent(new Event('focus')) // the poll re-reads on focus
    expect(await screen.findByText('projectPanel.swarm.manager.stateAbsent')).toBeTruthy()
    expect(localStorage.getItem(`openground.swarm.manager.${project.id}`)).toBeNull()
  })

  it('notices a desk that dies before the poll ever sees it (refused on arrival)', async () => {
    storeManager()
    let reaped = false
    harness({ managerProbeBody: () => ({ status: 'failed', reaped }) })
    render(<SwarmModule project={project} />)
    expect(await screen.findByText('projectPanel.swarm.manager.stateRunning')).toBeTruthy()
    reaped = true // the next probe (5 s later) hears it is gone
    expect(
      await screen.findByText('projectPanel.swarm.manager.stateAbsent', {}, { timeout: 12_000 }),
    ).toBeTruthy()
  })
})

// The bottom bar (owner decision 2026-09-24): SwarmModule is no longer a tab —
// SwarmBottomBar renders it folded under every tab. Folded must mean ONE strip:
// no seat mounted (so no stream opened), but the owner still sees at a glance
// whether anyone is waiting on them.
describe('folded into the bottom bar', () => {
  it('mounts no seat while folded, and the same state unfolded does', async () => {
    storeManager()
    harness({ active: () => [{ id: MANAGER_SDK_ID, status: 'working' }] })
    const onToggle = vi.fn()
    const { rerender } = render(<SwarmModule project={project} collapsed onToggleCollapsed={onToggle} />)
    const toggle = await screen.findByRole('button', { name: 'projectPanel.swarm.bar.expand' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Give the polls a lap to land before claiming nothing mounted.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'projectPanel.swarm.power.label' }).hasAttribute('disabled')).toBe(false))
    expect(document.querySelector('[data-seat]')).toBeNull()
    toggle.click()
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<SwarmModule project={project} collapsed={false} onToggleCollapsed={onToggle} />)
    await waitFor(() => expect(document.querySelector('[data-seat="manager"]')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'projectPanel.swarm.bar.collapse' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('counts every open owner question on the folded strip — and says nothing when there are none', async () => {
    harness({
      escalations: [
        { status: 'open', sdkSessionId: 'sdk-w1', question: 'q1', createdAt: '2026-09-23T01:00:00.000Z' },
        // No session id (an engine-raised question): still one the owner owes.
        { status: 'open', question: 'q2', createdAt: '2026-09-23T02:00:00.000Z' },
      ],
    })
    render(<SwarmModule project={project} collapsed onToggleCollapsed={() => {}} />)
    expect(await screen.findByText('projectPanel.swarm.bar.questions:{"count":2}')).toBeTruthy()
    cleanup()
    const { urls, answered } = harness({ escalations: [] })
    render(<SwarmModule project={project} collapsed onToggleCollapsed={() => {}} />)
    // Wait for the inbox poll itself to have ANSWERED — silence before the
    // read lands proves nothing.
    await waitFor(() => expect(answered.some((u) => u.startsWith('/api/swarm/escalations'))).toBe(true))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(urls.some((u) => u.startsWith('/api/swarm/escalations'))).toBe(true)
    expect(screen.queryByText(/projectPanel\.swarm\.bar\.questions/)).toBeNull()
  })

  it('first run: Start on the folded strip opens the explainer instead of starting blind', async () => {
    const { urls } = harness({ idle: true })
    const onToggle = vi.fn()
    render(<SwarmModule project={project} collapsed onToggleCollapsed={onToggle} />)
    const start = await screen.findByRole('switch', { name: 'projectPanel.swarm.power.label' })
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
    expect(start.getAttribute('aria-checked')).toBe('false')
    start.click()
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(urls.some((u) => u.includes('/api/swarm/orchestrator/start'))).toBe(false)
  })

  it('a notice that lives inside the bar puts one dot on the folded strip', async () => {
    harness({ overLimit: true })
    render(<SwarmModule project={project} collapsed onToggleCollapsed={() => {}} />)
    expect(await screen.findByRole('status', { name: 'projectPanel.swarm.bar.attention' })).toBeTruthy()
    cleanup()
    harness({})
    render(<SwarmModule project={project} collapsed onToggleCollapsed={() => {}} />)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'projectPanel.swarm.power.label' }).hasAttribute('disabled')).toBe(false))
    expect(screen.queryByRole('status', { name: 'projectPanel.swarm.bar.attention' })).toBeNull()
  })
})

// Owner decision 2026-09-25 (second design): a folded manager / worker seat is
// a character icon on ONE rail at the right edge — a working seat's icon lit, the
// rest faded; open/fold remembered per project. An OPEN seat leaves the rail (its
// name shows once, in its nameplate, with the fold button). A folded seat mounts
// nothing, so it polls no conversation and opens no stream.
describe('folded seats sit on the icon rail', () => {
  const railSeat = (key: string) => document.querySelector(`[data-rail-seat="${key}"]`) as HTMLButtonElement | null
  const openSeat = (key: string) => document.querySelector(`[data-seat-open="${key}"]`) as HTMLElement | null

  it('starts folded: icons only, lit only on the working seat, no feed polls', async () => {
    seatFold.allOpen = false
    try {
      storeManager()
      const h = harness({
        active: () => [
          { id: MANAGER_SDK_ID, status: 'working' },
          { id: 'sdk-w1', status: 'waiting' },
        ],
      })
      render(<SwarmModule project={project} />)
      await waitFor(() => expect(railSeat('manager')?.dataset.lit).toBe('true'))
      expect(railSeat(sdkWorker.worktree)).toBeTruthy()
      expect(railSeat(sdkWorker.worktree)!.dataset.lit).toBeUndefined()
      expect(railSeat(sdkWorker.worktree)!.getAttribute('aria-label')).toContain('projectPanel.swarm.statusWaiting')
      expect(document.querySelector('[data-seat="manager"]')).toBeNull()
      expect(document.querySelector('[data-seat-feed]')).toBeNull()
      expect(h.urls.some((u) => u.includes('/tail?'))).toBe(false)
    } finally {
      seatFold.allOpen = true
    }
  })

  // The bug the owner saw: the nameplate said 動いている while the lamp was grey
  // (a WAITING desk). The icon must light — and say — exactly what the nameplate says.
  it('the icon says the same state the nameplate says (a waiting manager is "running", lit)', async () => {
    seatFold.allOpen = false
    try {
      storeManager()
      harness({ active: () => [{ id: MANAGER_SDK_ID, status: 'waiting' }] })
      render(<SwarmModule project={project} />)
      await waitFor(() => expect(railSeat('manager')?.getAttribute('aria-label')).toContain('projectPanel.swarm.manager.stateRunning'))
      expect(railSeat('manager')!.dataset.lit).toBe('true')
      act(() => railSeat('manager')!.click())
      const seat = openSeat('manager')!
      expect(within(seat).getByText('projectPanel.swarm.manager.stateRunning')).toBeTruthy()
    } finally {
      seatFold.allOpen = true
    }
  })

  it('an opened seat leaves the rail, shows its name once, folds from its nameplate, and is remembered', async () => {
    seatFold.allOpen = false
    try {
      storeManager()
      harness({ active: () => [{ id: MANAGER_SDK_ID, status: 'working' }] })
      render(<SwarmModule project={project} />)
      await waitFor(() => expect(railSeat('manager')).toBeTruthy())
      act(() => railSeat('manager')!.click())
      expect(document.querySelector('[data-seat="manager"]')).toBeTruthy()
      expect(railSeat('manager')).toBeNull()
      expect(screen.getAllByText('projectPanel.swarm.manager.tab')).toHaveLength(1)
      expect(JSON.parse(localStorage.getItem(`openground.swarmseats.${project.id}`)!)).toEqual(['manager'])
      const fold = openSeat('manager')!.querySelector('[data-seat-fold]') as HTMLButtonElement
      act(() => fold.click())
      expect(document.querySelector('[data-seat="manager"]')).toBeNull()
      expect(railSeat('manager')).toBeTruthy()
      expect(JSON.parse(localStorage.getItem(`openground.swarmseats.${project.id}`)!)).toEqual([])
    } finally {
      seatFold.allOpen = true
    }
  })

  // Commander rework 1: a seat folded while its live log was open reopened as
  // SdkWorkerPane, whose nameplate reads its own stream by other rules — a
  // worker the rail showed as "asking" came back as "working". Folding closes
  // the log, so the reopened seat speaks through the same look as the rail —
  // and under the same name ("Worker 1", not the bare role word).
  it('a seat folded with its log open reopens saying what its rail icon said, under the same name', async () => {
    seatFold.allOpen = false
    try {
      localStorage.setItem(`openground.swarmseats.${project.id}`, JSON.stringify([sdkWorker.worktree]))
      harness({
        active: () => [{ id: 'sdk-w1', status: 'waiting' }],
        escalations: [{ status: 'open', sdkSessionId: 'sdk-w1', question: 'keep ours?', createdAt: '2026-09-25T01:00:00.000Z' }],
      })
      render(<SwarmModule project={project} />)
      const workerName = 'projectPanel.swarm.seat.workerN:{"n":1}'
      await waitFor(() => expect(within(openSeat(sdkWorker.worktree)!).getByText('projectPanel.swarm.sdk.statusQuestion')).toBeTruthy())
      expect(within(openSeat(sdkWorker.worktree)!).getByText(workerName)).toBeTruthy()
      act(() => (within(openSeat(sdkWorker.worktree)!).getByText('projectPanel.swarm.seat.openLog').closest('button') as HTMLButtonElement).click())
      await waitFor(() => expect(within(openSeat(sdkWorker.worktree)!).queryByText('projectPanel.swarm.seat.openLog')).toBeNull())
      act(() => (openSeat(sdkWorker.worktree)!.querySelector('[data-seat-fold]') as HTMLButtonElement).click())
      const icon = railSeat(sdkWorker.worktree)!
      expect(icon.getAttribute('aria-label')).toContain('projectPanel.swarm.sdk.statusQuestion')
      expect(icon.getAttribute('aria-label')).toContain('"name":"' + workerName.replace(/"/g, '\\"'))
      act(() => icon.click())
      const seat = openSeat(sdkWorker.worktree)!
      expect(within(seat).getByText('projectPanel.swarm.sdk.statusQuestion')).toBeTruthy()
      expect(within(seat).getByText(workerName)).toBeTruthy()
    } finally {
      seatFold.allOpen = true
    }
  })
})
