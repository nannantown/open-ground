// @vitest-environment jsdom
//
// 司令官の卓を閉じるボタンは、意図を記録する経路を通る (2026-08-26)
//
// The commander now comes back at boot (`EngineIntent.managerDesired`), which
// turns "close the desk" into a statement the server has to hear. Before this
// change the button DELETEd the desk's raw handle — a kill with no intent — and
// that is precisely the trap /api/swarm/supply/stop was built to avoid on its
// side: a stop that never clears the flag resurrects a desk the owner just
// closed, on every restart, forever.
//
// So the observable pinned here is the ROUTE, not the outcome the UI shows: the
// pane clears its own record either way, so a raw kill and a proper stop look
// IDENTICAL on screen. Only the request tells them apart.
//
// MUTATIONS that turn this red: point stopCommanderDesk back at
// `DELETE /api/terminal/:id` (or at the sdk-session DELETE); drop the `path`
// from its body (the route 400s without it).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProjectMeta, SwarmOrchestratorState } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
    lang: 'en',
    setLang: () => {},
    toggleLang: () => {},
  }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}))

// The module reads its engine through this hook (an SSE + poll pipeline that
// jsdom cannot drive), and with a fully IDLE swarm it replaces the whole tab
// surface with the first-run onboarding — the commander's launch CTA is not on
// screen at all. Override just `running`, exactly the way
// SwarmModule.sdkTeardown.test.tsx overrides just `realWorkers`; everything
// else — the module's own wiring, the stop handler, the fetches — is real. An
// engine that is UP is also the realistic state for this bug: the desk is
// closed while work is still moving.
vi.mock('./useSwarmEngine', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>
  const original = mod.useSwarmEngine as (p: string) => { engine: Record<string, unknown> }
  return {
    ...mod,
    useSwarmEngine: (p: string) => {
      const real = original(p)
      return { ...real, engine: { ...real.engine, running: true, available: true } }
    },
  }
})

import { SwarmModule } from './SwarmModule'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

class FakeEventSource {
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

// A LIVE commander pane mounts a real xterm, whose DPR watcher calls
// `matchMedia` — absent in jsdom, and its throw lands as an unhandled rejection
// that vitest flags as "might cause false positives" for the whole run. The
// terminal's rendering is not what this test observes; only the stop request is.
const stubMatchMedia = () =>
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )

const project: ProjectMeta = {
  id: 'p-cmd',
  name: 'proj',
  path: '/pcmd',
  description: '',
  lastModified: '2026-08-26T00:00:00.000Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
}

// `running:true` on purpose: with a fully IDLE swarm the module replaces the
// whole tab surface with the first-run onboarding, and the commander's launch
// CTA is not on screen at all. An engine that is up is also the realistic state
// for this bug — the desk is closed while work is moving.
const engineState = (): SwarmOrchestratorState => ({
  running: true,
  manualStop: false,
  manualStopPersisted: false,
  selfSupply: false,
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
})

type Req = { url: string; method: string; body: string }

const harness = () => {
  const reqs: Req[] = []
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)

  vi.stubGlobal('EventSource', FakeEventSource)
  stubMatchMedia()
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : ((input as Request)?.url ?? '')
      const method = (init?.method ?? 'GET').toUpperCase()
      reqs.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' })
      if (url === '/api/swarm/manager' && method === 'POST')
        return json({ terminalId: 'term-1', runtime: 'pty', agentSessionId: 'a1', resumed: false })
      if (url.startsWith('/api/swarm/workers')) return json({ workers: [] })
      if (url.startsWith('/api/swarm/orchestrator')) return json(engineState())
      if (url.startsWith('/api/swarm/preflight')) return json({ issues: [] })
      if (url.startsWith('/api/swarm/escalations')) return json({ escalations: [] })
      return json({})
    }),
  )
  return { reqs }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('closing the commander desk', () => {
  it('goes through POST /api/swarm/manager/stop — the route that also forgets the desk', async () => {
    const { reqs } = harness()
    // Past the first-run onboarding, which otherwise REPLACES the whole tab
    // surface while the engine is idle and no desk exists — exactly this test's
    // starting state.
    localStorage.setItem('og-swarm-onboarding-seen-v1', '1')
    render(<SwarmModule project={project} />)

    // The module opens on the supply tab; the commander lives on its own.
    await userEvent.click(await screen.findByText('projectPanel.swarm.manager.tab'))
    await userEvent.click(await screen.findByText('projectPanel.swarm.manager.launch'))
    await waitFor(() =>
      expect(reqs.some((r) => r.url === '/api/swarm/manager' && r.method === 'POST')).toBe(true),
    )

    await userEvent.click(await screen.findByTitle('projectPanel.swarm.manager.stop'))

    await waitFor(() =>
      expect(
        reqs.some((r) => r.url === '/api/swarm/manager/stop' && r.method === 'POST'),
        'the close button must state the intent, not just kill the handle',
      ).toBe(true),
    )
    // The route gates on a registered project path — a body without it 400s.
    const stop = reqs.find((r) => r.url === '/api/swarm/manager/stop')!
    expect(JSON.parse(stop.body)).toEqual({ path: project.path })
    // …and it is NOT ALSO a raw kill: a bare handle DELETE stops the desk while
    // leaving `managerDesired` set, which is the resurrection bug itself.
    expect(reqs.some((r) => r.method === 'DELETE' && r.url.startsWith('/api/terminal/'))).toBe(false)
    expect(reqs.some((r) => r.method === 'DELETE' && r.url.startsWith('/api/sdk-session/'))).toBe(
      false,
    )
  })
})
