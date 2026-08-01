// @vitest-environment jsdom
//
// Tearing down a MANUAL worker, from the worker tab, when that worker lives in
// the SDK pool instead of the PTY pool.
//
// Two failures are pinned here, and both are of the family this repo keeps
// re-discovering (docs/MAP.md §5 — "ask one pool a question about a worker that
// may be in the other"):
//   · the tile offered no teardown at all for an SDK worker, so its worktree
//     could only be removed by hand on disk;
//   · `terminate` stopped the desk via `worker.terminalId`, which for an SDK
//     worker is the EMPTY STRING — the stop silently did nothing and the
//     worktree removal ran with `claude` still working in that tree.
//
// MUTATIONS that turn this red: drop onTerminate/onForceRemove from the
// SdkWorkerPane call site; or delete the sdk-session DELETE from `terminate`
// (leaving only the PTY delete), which is exactly the pre-fix code.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

// ⚠ THE ROSTER ROW IS INJECTED, and that is not test convenience — it is a
// defect this file could not route around. `sanitizeSwarmWorkers`
// (useSwarmEngine.ts) copies the roster field by field and copies NEITHER
// `runtime` NOR `sdkSessionId`, so today every SDK worker reaches this module
// looking like a PTY worker with no terminalId: the SdkWorkerPane branch is
// unreachable from the live poll, and the tile the owner actually sees is the
// PTY one's "session ended" placeholder. That sanitizer is out of this change's
// scope (reported separately). Everything else here — engine state, the polls,
// the module's own wiring — is the real thing; only the one row the sanitizer
// currently truncates is supplied in the shape the server already sends.
vi.mock('./useSwarmEngine', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>
  const original = mod.useSwarmEngine as (p: string) => Record<string, unknown>
  return {
    ...mod,
    useSwarmEngine: (p: string) => ({ ...original(p), realWorkers: [sdkWorker] }),
  }
})

import { SwarmModule } from './SwarmModule'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// The SDK tile opens an SSE stream on mount; jsdom has no EventSource and this
// case does not depend on the transcript, so a silent stub is enough.
class FakeEventSource {
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

const project: ProjectMeta = {
  id: 'p-sdk',
  name: 'proj',
  path: '/psdk',
  description: '',
  lastModified: '2026-07-31T00:00:00.000Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
}

/** A MANUAL SDK worker exactly as the roster reports one: `stage` absent (that
 *  is what makes it terminable from this tab), NO terminalId — the invariant is
 *  pty ⇔ terminalId / sdk ⇔ sdkSessionId — and the session id instead. */
const sdkWorker: SwarmWorkerRecord = {
  worktree: '/home/.openground/projects/p-sdk/worktrees/swarm-card-9',
  branch: 'swarm/card-9',
  runtime: 'sdk',
  sdkSessionId: 'sdk-9',
  taskTitle: 'SDK の卓を片付ける',
}

const engineState = (): SwarmOrchestratorState => ({
  running: false,
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

type Req = { url: string; method: string }

/** Answer every route the pane polls, and RECORD each request in order — the
 *  order is the point: the desk must be stopped BEFORE its worktree is pulled
 *  out from under it. `removed` decides whether the soft remove succeeded. */
const harness = (opts: { removed: boolean; reason?: string }) => {
  const reqs: Req[] = []
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)

  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : ((input as Request)?.url ?? '')
      const method = (init?.method ?? 'GET').toUpperCase()
      reqs.push({ url, method })
      if (url.startsWith('/api/swarm/workers')) return json({ workers: [sdkWorker] })
      if (url.startsWith('/api/swarm/orchestrator')) return json(engineState())
      if (url.startsWith('/api/swarm/preflight')) return json({ issues: [] })
      if (url.startsWith('/api/swarm/escalations')) return json({ escalations: [] })
      if (url === '/api/swarm/worktree/remove')
        return json({ removed: opts.removed, reason: opts.reason })
      return json({})
    }),
  )
  return { reqs }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const openWorkerTab = async () => {
  render(<SwarmModule project={project} />)
  await userEvent.click(await screen.findByRole('tab', { name: /workersTab/ }))
}

describe('terminating a manual SDK worker from the worker tab', () => {
  it('stops the SDK SESSION (not a nonexistent PTY) before removing the worktree', async () => {
    const { reqs } = harness({ removed: true })
    await openWorkerTab()

    await userEvent.click(await screen.findByTitle('projectPanel.swarm.terminate'))

    await waitFor(() =>
      expect(reqs.some((r) => r.url === '/api/swarm/worktree/remove' && r.method === 'POST')).toBe(
        true,
      ),
    )
    const stop = reqs.findIndex(
      (r) => r.method === 'DELETE' && r.url.startsWith('/api/sdk-session/sdk-9?'),
    )
    const remove = reqs.findIndex((r) => r.url === '/api/swarm/worktree/remove')
    // The desk was actually told to stop...
    expect(stop, 'no DELETE /api/sdk-session/sdk-9 — the SDK desk was never stopped').toBeGreaterThan(-1)
    // ...and told BEFORE its tree was pulled away.
    expect(stop).toBeLessThan(remove)
    // The gate is a project path, so a DELETE without it 400s server-side.
    expect(reqs[stop].url).toContain(`path=${encodeURIComponent(project.path)}`)
    // Nothing was asked of the PTY pool: this worker has no terminalId, and a
    // DELETE /api/terminal/ with an empty id addresses either nobody or, worse,
    // someone else.
    expect(reqs.some((r) => r.url.startsWith('/api/terminal/') && r.method === 'DELETE')).toBe(false)
  })

  it('offers force-remove on the SDK tile when a soft terminate keeps a dirty tree', async () => {
    const { reqs } = harness({ removed: false, reason: 'worktree is dirty' })
    await openWorkerTab()

    await userEvent.click(await screen.findByTitle('projectPanel.swarm.terminate'))

    // The tile stays, now carrying the retained strip + its force affordance —
    // the same recovery the PTY tile has always offered.
    const force = await screen.findByText('projectPanel.swarm.forceRemove')
    await userEvent.click(force)

    await waitFor(() =>
      expect(reqs.filter((r) => r.url === '/api/swarm/worktree/remove').length).toBe(2),
    )
  })
})
