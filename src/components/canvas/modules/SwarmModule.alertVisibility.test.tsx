// @vitest-environment jsdom
//
// THE ALERT THAT COULD NOT BE SEEN (adversarial review, 2026-08-04).
//
// The Swarm tab replaces its ENTIRE surface — the sub-tab strip and every pane,
// including the needs-attention feed — with a first-run onboarding whenever
// nothing is up: no engine, no desks, no workers, no open questions. That is a
// good default, and it collides with the alerts that fire in exactly that state:
//
//   • 'engine-resume-suppressed' means the engine did NOT come back at boot, so
//     `running` is false and nothing is seated, BY DEFINITION;
//   • 'all-workers-down' / 'canary-failed' / 'rollback' arrive after everything
//     has stopped.
//
// So the one screen the owner opens to ask "why is nothing running?" showed them
// the onboarding, and the explanation lived only in the Ground bell.
//
// This file mounts the real module and asserts what is IN THE DOM. Mutation that
// turns it red: drop `pendingAlerts === 0` from the `swarmIdle` condition in
// SwarmModule.tsx.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
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

import { SwarmModule } from './SwarmModule'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const project: ProjectMeta = {
  id: 'p-alert',
  name: 'proj',
  path: '/palert',
  description: '',
  lastModified: '2026-08-04T00:00:00.000Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
}

/** A completely idle engine — the state the onboarding is FOR. */
const idleEngine = (): SwarmOrchestratorState => ({
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

const RESUME_SUPPRESSED = {
  id: 'n-boot-1',
  kind: 'swarm-fatal',
  createdAt: Date.parse('2026-08-04T03:00:00.000Z'),
  swarmFatal: {
    event: 'engine-resume-suppressed',
    detail: 'claude をすぐに使えなかったため自動再開を見送りました',
    // Production sets this for the per-project resume branch — the whole reason
    // this alert may take the screen is that it explains why THIS project is not
    // running.
    projectPath: '/palert',
  },
}

const harness = (notifications: unknown[]) => {
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = typeof input === 'string' ? input : ((input as Request)?.url ?? '')
      if (url.startsWith('/api/swarm/orchestrator?')) return json(idleEngine())
      if (url.startsWith('/api/swarm/workers')) return json({ workers: [] })
      if (url.startsWith('/api/swarm/preflight')) return json({ issues: [] })
      if (url === '/api/swarm/notifications') return json({ notifications })
      return json({})
    }),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Swarm tab — an undismissed alert outranks the first-run onboarding', () => {
  it('shows the onboarding when the swarm is idle AND nothing is waiting', async () => {
    // The control: without this the test below could pass because the onboarding
    // never renders at all, and it would be measuring nothing.
    harness([])
    render(<SwarmModule project={project} />)
    await waitFor(() => {
      expect(screen.getByText('projectPanel.swarm.onboarding.intro')).toBeTruthy()
    })
  })

  it('shows the ALERT instead when a fatal is waiting in that same idle state', async () => {
    harness([RESUME_SUPPRESSED])
    render(<SwarmModule project={project} />)
    await waitFor(() => {
      // The needs-attention heading is on screen…
      expect(screen.getByText('projectPanel.swarm.overseer.alertsHeading')).toBeTruthy()
    })
    // …and the onboarding is not covering it.
    expect(screen.queryByText('projectPanel.swarm.onboarding.intro')).toBeNull()
  })

  it('a fatal the owner already handled does NOT keep the onboarding away', async () => {
    // The other direction: once it is dealt with, the tab goes back to normal.
    harness([{ ...RESUME_SUPPRESSED, handledAt: Date.parse('2026-08-04T03:05:00.000Z') }])
    render(<SwarmModule project={project} />)
    await waitFor(() => {
      expect(screen.getByText('projectPanel.swarm.onboarding.intro')).toBeTruthy()
    })
  })
})
