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
import { render, screen, waitFor, cleanup, within } from '@testing-library/react'
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
}) => {
  const urls: string[] = []
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = typeof input === 'string' ? input : ((input as Request)?.url ?? String(input))
      urls.push(url)
      if (url.includes('/api/terminal/active')) return json({ claude: opts.active?.() ?? [] })
      if (url.startsWith('/api/swarm/workers')) return json({ workers: [sdkWorker] })
      if (url.startsWith('/api/swarm/orchestrator')) return json(engineState(opts.overLimit))
      if (url.startsWith('/api/swarm/preflight')) return json({ issues: [] })
      if (url.startsWith('/api/swarm/escalations')) return json({ escalations: opts.escalations ?? [] })
      if (url.startsWith(`/api/sdk-session/${MANAGER_SDK_ID}`))
        return json(opts.managerProbeBody?.() ?? { status: 'working' }, opts.managerProbe ?? 200)
      return json({})
    }),
  )
  return { urls }
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

describe("the manager's seat is a nameplate (③)", () => {
  it('shows RUNNING and nothing but status + stop', async () => {
    storeManager()
    harness({ active: () => [{ id: MANAGER_SDK_ID, status: 'working' }] })
    render(<SwarmModule project={project} />)
    expect(await screen.findByText('projectPanel.swarm.manager.stateRunning')).toBeTruthy()
    // The seat as SwarmModule mounts it: one control, no input, no stream —
    // i.e. SwarmModule did not wrap anything else (a transcript, a command box,
    // a dashboard) into the manager's seat.
    const seat = document.querySelector('[data-seat="manager"]')!
    expect(seat).toBeTruthy()
    const buttons = within(seat as HTMLElement).getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].getAttribute('aria-label')).toBe('projectPanel.swarm.manager.stopFull')
    expect(seat.querySelector('textarea, input, aside')).toBeNull()
    // No transcript stream is opened for the manager desk.
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
