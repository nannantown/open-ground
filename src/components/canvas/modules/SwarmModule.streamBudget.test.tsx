// @vitest-environment jsdom
//
// The connection budget (差し戻し 2026-09-24, must-fix 1). The Swarm bar sits
// under EVERY tab, so the Terminal tab's panes (one SSE stream each) and the
// open bar's seats (the president's desk, the unfolded worker's transcript)
// are alive together. The app's server speaks HTTP/1.1 on one origin, where
// Chromium opens at most SIX connections; every live stream holds one. At six,
// every later request — terminal input, the polls, Start/Stop — waits forever.
//
// These cases model exactly that: a connection pool of six, where a fetch made
// while six streams are open never answers. The page's panes are modelled as
// streams the page holds (holdStream('page') + an open connection each).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { ProjectMeta, SwarmOrchestratorState, SwarmWorkerRecord } from '@/lib/types'
import { HOST_CONNECTION_CAP, StreamOwnerContext, holdStream } from '@/lib/streamBudget'

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
vi.mock('./SwarmSeatStrip', async (importOriginal) => {
  const real = await importOriginal<typeof import('./SwarmSeatStrip')>()
  class AllOpen extends Set<string> {
    has() {
      return true
    }
  }
  return { ...real, loadOpenSeats: () => new AllOpen() }
})

import { SwarmModule } from './SwarmModule'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// ── The connection pool ────────────────────────────────────────────────────
const pool = { open: 0, peak: 0 }
class FakeEventSource {
  closed = false
  constructor(public url: string) {
    pool.open++
    pool.peak = Math.max(pool.peak, pool.open)
  }
  addEventListener() {}
  close() {
    if (this.closed) return
    this.closed = true
    pool.open--
  }
}

const project: ProjectMeta = {
  id: 'p-budget',
  name: 'budget',
  path: '/tmp/p-budget',
} as ProjectMeta

const sdkWorker: SwarmWorkerRecord = {
  worktree: '/home/.openground/projects/p-budget/worktrees/swarm-card-1',
  branch: 'swarm/card-1',
  runtime: 'sdk',
  sdkSessionId: 'sdk-w1',
  taskTitle: '画面を片付ける',
}

const engineState = {
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
  consumption: { activeWorkers: 0, activeRunMs: 0, dispatched: 0, limit: 0, overLimit: false },
  autonomyRemembered: false,
  autonomyResumed: false,
  overseerRemembered: false,
  managerDesk: null,
} as unknown as SwarmOrchestratorState

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

const harness = (roster: SwarmWorkerRecord[] = [sdkWorker]) => {
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      // All six connections busy with streams → this request never gets one.
      if (pool.open >= HOST_CONNECTION_CAP) return new Promise<Response>(() => {})
      const url = typeof input === 'string' ? input : ((input as Request)?.url ?? String(input))
      if (url.includes('/api/terminal/active')) return json({ claude: [{ id: 'sdk-w1', status: 'working' }] })
      if (url.startsWith('/api/swarm/workers')) return json({ workers: roster })
      if (url.startsWith('/api/swarm/orchestrator')) return json(engineState)
      if (url.startsWith('/api/swarm/preflight')) return json({ issues: [] })
      if (url.startsWith('/api/swarm/escalations')) return json({ escalations: [] })
      return json({})
    }),
  )
}

/** The Terminal tab's panes: each holds a page slot AND a real connection. */
const openPagePanes = (n: number) => {
  const panes: { release: () => void; es: FakeEventSource }[] = []
  for (let i = 0; i < n; i++) {
    panes.push({ release: holdStream('page'), es: new FakeEventSource(`/api/terminal/pane-${i}/stream`) })
  }
  return () => panes.forEach((p) => (p.release(), p.es.close()))
}

/** A request the owner makes right now (typing into a terminal pane). */
const answersWithin = async (ms: number) => {
  const r = await Promise.race([
    fetch('/api/terminal/pane-0/input', { method: 'POST' }).then(() => 'answered'),
    new Promise((res) => setTimeout(() => res('stalled'), ms)),
  ])
  return r === 'answered'
}

const renderBar = () =>
  render(
    <StreamOwnerContext.Provider value="swarmBar">
      <SwarmModule project={project} collapsed={false} onToggleCollapsed={() => {}} />
    </StreamOwnerContext.Provider>,
  )

let closePanes: (() => void) | null = null
afterEach(() => {
  closePanes?.()
  closePanes = null
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  pool.open = 0
  pool.peak = 0
})

describe('the Swarm bar never starves the window of connections', () => {
  it('a seat that opens no stream (a dead worker with no handle) spends no slot', async () => {
    // Listed FIRST so a plan that charged it would leave nothing for the live one.
    const deadNoHandle: SwarmWorkerRecord = {
      worktree: '/home/.openground/projects/p-budget/worktrees/swarm-card-0',
      branch: 'swarm/card-0',
      note: 'died',
    }
    harness([deadNoHandle, sdkWorker])
    closePanes = openPagePanes(4)
    renderBar()
    const open = await screen.findByRole('button', { name: /projectPanel\.swarm\.seat\.openLog/ })
    expect((open as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(open)
    // Four panes + the one live transcript = five, within budget.
    await waitFor(() => expect(pool.open).toBe(5))
    expect(await answersWithin(500)).toBe(true)
  })

  it('five terminal panes open: unfolding a worker is withheld, and a request still answers', async () => {
    harness()
    closePanes = openPagePanes(5)
    renderBar()
    const open = await screen.findByRole('button', { name: /projectPanel\.swarm\.seat\.openLog/ })
    // The owner tries to watch the worker anyway.
    fireEvent.click(open)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(pool.peak).toBeLessThan(HOST_CONNECTION_CAP)
    expect(await answersWithin(500)).toBe(true)
    // …and the screen says why, instead of silently doing nothing.
    expect((open as HTMLButtonElement).disabled).toBe(true)
    expect(open.getAttribute('title')).toBe('projectPanel.swarm.bar.streamLimit')
  })

  it('a pane opened while a worker streams takes the slot back from the bar', async () => {
    harness()
    closePanes = openPagePanes(4)
    renderBar()
    fireEvent.click(await screen.findByRole('button', { name: /projectPanel\.swarm\.seat\.openLog/ }))
    // Four panes + the worker's transcript = five: allowed, the log is open.
    await waitFor(() => expect(pool.open).toBe(5))
    // The owner opens a fifth terminal pane.
    const closeFifth = openPagePanes(1)
    try {
      await waitFor(() => expect(pool.open).toBe(5))
      expect(await answersWithin(500)).toBe(true)
      expect(screen.getByText('projectPanel.swarm.bar.streamLimit')).toBeTruthy()
    } finally {
      closeFifth()
    }
  })
})

// The budget is only as good as its bookkeeping: a stream-opening pane must
// hold a slot, on the RIGHT side, for exactly as long as it is mounted.
// (TerminalPane / ClaudeTerminalPane hold theirs the same way, around the one
// `new EventSource` each; xterm cannot open in jsdom, so SdkWorkerPane — the
// pane the Board's drawer and the bar both mount — stands in here.)
describe('a stream-opening pane holds its slot on the right side', () => {
  it('counts as the PAGE by default and as the BAR inside the Swarm bar, and releases on unmount', async () => {
    harness()
    const { SdkWorkerPane } = await import('./SdkWorkerPane')
    const { streamCount } = await import('@/lib/streamBudget')
    const pane = <SdkWorkerPane sdkSessionId="sdk-w1" projectPath="/tmp/p" branch="b" taskTitle="t" />
    const page = render(pane)
    expect(streamCount('page')).toBe(1)
    expect(streamCount('swarmBar')).toBe(0)
    page.unmount()
    expect(streamCount()).toBe(0)
    const bar = render(<StreamOwnerContext.Provider value="swarmBar">{pane}</StreamOwnerContext.Provider>)
    expect(streamCount('swarmBar')).toBe(1)
    expect(streamCount('page')).toBe(0)
    bar.unmount()
    expect(streamCount()).toBe(0)
    expect(pool.open).toBe(0)
  })
})
