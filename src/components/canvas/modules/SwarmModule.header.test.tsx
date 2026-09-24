// @vitest-environment jsdom
//
// The team bar's ONE header row (owner request 2026-09-24, after using 0.11.142):
//   · the WHOLE row opens / folds the bar — a click on a control inside it (the
//     on/off switch) stays that control's;
//   · the monitoring switch, the execution-mode menu, the "running · N workers"
//     pill and the "resumed after restart" chip are gone (the owner asks the
//     president in words instead — skills/supply/SKILL.md), and so is the
//     overseer restore banner that re-armed monitoring from the screen.
// Each test names the mutation that turns it red.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import type { ProjectMeta, SwarmOrchestratorState } from '@/lib/types'
import { messages } from '@/i18n/messages'

// Translate to the KEY, so these assertions are locale-independent. The actual
// JA/EN copy (the team's on-screen name) is pinned against the real message
// tables in the "on-screen name" block at the bottom.
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

// The poll lap + several React ticks; the 5s default is a known false-red source
// under parallel load. Same pin as the siblings.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const project: ProjectMeta = {
  id: 'p-2b',
  name: 'proj',
  path: '/p2b',
  description: '',
  lastModified: '2026-07-24T00:00:00.000Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
}

/** The engine snapshot GET /api/swarm/orchestrator answers with. */
const engineState = (over: Partial<SwarmOrchestratorState> = {}): SwarmOrchestratorState => ({
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
  autonomyRemembered: true,
  autonomyResumed: true,
  overseerRemembered: true,
  ...over,
})

type Posted = { url: string; body: unknown }

/** Answer every route the bar polls and RECORD the POSTs, so a test can assert
 *  which endpoint a control reached. */
const harness = (state: SwarmOrchestratorState) => {
  const posted: Posted[] = []
  const current = state
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)

  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : ((input as Request)?.url ?? '')
      if (init?.method === 'POST' && url.startsWith('/api/swarm/')) {
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
        posted.push({ url, body })
        return json(current)
      }
      if (url.startsWith('/api/swarm/orchestrator?')) return json(current)
      if (url.startsWith('/api/swarm/workers')) return json({ workers: [] })
      if (url.startsWith('/api/swarm/preflight')) return json({ issues: [] })
      if (url === '/api/swarm/notifications') return json({ items: [] })
      return json({})
    }),
  )
  return { posted }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const POWER = 'projectPanel.swarm.power.label'

describe('the header row opens and folds the bar (owner 2026-09-24)', () => {
  it('a click on the EMPTY part of the row toggles once', async () => {
    harness(engineState())
    const onToggle = vi.fn()
    render(<SwarmModule project={project} collapsed onToggleCollapsed={onToggle} />)
    const toggle = await screen.findByTestId('swarm-bar-toggle')
    const row = toggle.parentElement!
    // MUTATION: drop the row's onClick ⇒ red (only the left button would open it).
    fireEvent.click(row)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('the named toggle button toggles exactly once — the row does not echo it', async () => {
    harness(engineState())
    const onToggle = vi.fn()
    render(<SwarmModule project={project} collapsed onToggleCollapsed={onToggle} />)
    const toggle = await screen.findByTestId('swarm-bar-toggle')
    expect(toggle.tagName).toBe('BUTTON') // keyboard path: a native, focusable button
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // MUTATION: remove the row handler's control guard ⇒ 2 calls (opens then folds).
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('the second click of a double-click is ignored — on the row and on the name button', async () => {
    harness(engineState())
    const onToggle = vi.fn()
    render(<SwarmModule project={project} collapsed onToggleCollapsed={onToggle} />)
    const toggle = await screen.findByTestId('swarm-bar-toggle')
    // MUTATION: drop either `e.detail > 1` guard ⇒ 3 or 4 calls (open-then-fold).
    fireEvent.click(toggle.parentElement!, { detail: 1 })
    fireEvent.click(toggle.parentElement!, { detail: 2 })
    fireEvent.click(toggle, { detail: 1 })
    fireEvent.click(toggle, { detail: 2 })
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it('pressing the on/off switch never opens or folds the bar', async () => {
    const { posted } = harness(engineState({ running: true }))
    const onToggle = vi.fn()
    render(<SwarmModule project={project} onToggleCollapsed={onToggle} />)
    const power = await screen.findByRole('switch', { name: POWER })
    await waitFor(() => expect(power.hasAttribute('disabled')).toBe(false))
    fireEvent.click(power)
    await waitFor(() => expect(posted.some((p) => p.url === '/api/swarm/orchestrator/stop')).toBe(true))
    // MUTATION: guard only on the toggle button instead of every control ⇒ red.
    expect(onToggle).not.toHaveBeenCalled()
  })
})

describe('what the header no longer carries (owner 2026-09-24)', () => {
  it('no monitoring switch, mode menu, status pill, restart chip or overseer banner — folded or open', async () => {
    // The state that used to light every one of them at once.
    harness(engineState({ running: true, autonomyResumed: true, overseer: false, overseerRemembered: true }))
    for (const collapsed of [true, false]) {
      const view = render(<SwarmModule project={project} collapsed={collapsed} onToggleCollapsed={() => {}} />)
      await screen.findByRole('switch', { name: POWER })
      const text = view.container.textContent ?? ''
      for (const gone of [
        'projectPanel.swarm.manager.overseer',
        'projectPanel.swarm.mode.',
        'projectPanel.swarm.power.running',
        'projectPanel.swarm.power.workers',
        'projectPanel.swarm.autonomyRestored',
        'projectPanel.swarm.overseerReminder',
      ]) {
        expect(text.includes(gone), `${gone} (collapsed=${collapsed})`).toBe(false)
      }
      expect(view.queryByRole('button', { pressed: false })).toBeNull()
      view.unmount()
    }
  })

  it('the toggle carries the team-name key', async () => {
    harness(engineState())
    render(<SwarmModule project={project} collapsed onToggleCollapsed={() => {}} />)
    const toggle = await screen.findByTestId('swarm-bar-toggle')
    expect(toggle.textContent).toContain(POWER)
  })
})

// Owner 2026-09-24: "stop calling it swarm — エージェントチーム in both languages".
// Keys, API paths and data keep `swarm`; only what is SHOWN changes.
describe('on-screen name: エージェントチーム / Agent Team', () => {
  it('the bar\'s name is Agent Team (en) and エージェントチーム (ja)', () => {
    // MUTATION: put 'Swarm' back in power.label ⇒ red.
    expect(messages.en[POWER]).toBe('Agent Team')
    expect(messages.ja[POWER]).toBe('エージェントチーム')
  })

  it('no displayed message says "swarm" in either language', () => {
    for (const lang of ['en', 'ja'] as const) {
      const hits = Object.entries(messages[lang]).filter(([, v]) => /swarm|スウォーム/i.test(v))
      // MUTATION: any i18n VALUE back to "Swarm …" ⇒ red (keys are exempt).
      expect(hits.map(([k]) => k), lang).toEqual([])
    }
  })
})

describe('master power switch — one on/off toggle (owner 2026-09-24)', () => {
  it('a click while running turns it OFF: POSTs stop, never start', async () => {
    const { posted } = harness(engineState({ running: true }))
    render(<SwarmModule project={project} />)
    const power = await screen.findByRole('switch', { name: POWER })
    await waitFor(() => expect(power.getAttribute('aria-checked')).toBe('true'))
    await waitFor(() => expect(power.hasAttribute('disabled')).toBe(false))
    power.click()
    // MUTATION: make onClick always pass `true` ⇒ red (the owner could never stop the team).
    await waitFor(() => expect(posted.some((p) => p.url === '/api/swarm/orchestrator/stop')).toBe(true))
    expect(posted.some((p) => p.url === '/api/swarm/orchestrator/start')).toBe(false)
  })
})
