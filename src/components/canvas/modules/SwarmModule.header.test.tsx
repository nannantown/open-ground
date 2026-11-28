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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react'
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
const harness = (state: SwarmOrchestratorState, escalations: unknown[] | (() => unknown[]) = []) => {
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
      if (url.startsWith('/api/swarm/escalations?')) return json({ escalations: typeof escalations === 'function' ? escalations() : escalations })
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
beforeEach(() => { localStorage.clear() })

const POWER = 'projectPanel.swarm.power.label'

describe('the header row opens and folds the bar (owner 2026-09-24)', () => {
  it('shows frame authority and hides project power inside or outside without disabling manual president conversation', async () => {
    for (const allowed of [true, false]) {
      const { posted } = harness(engineState({ running: false, autonomyRemembered: true, automation: { enabled: true, allowed } }))
      const view = render(<SwarmModule project={project} />)
      await screen.findByText(allowed ? 'projectPanel.swarm.automationFrameInside' : 'projectPanel.swarm.automationFrameOutside')
      expect(screen.queryByRole('switch', { name: POWER })).toBeNull()
      expect(posted.map((item) => item.url).filter((url) => url.includes('/orchestrator/start') || url.includes('/orchestrator/stop'))).toHaveLength(0)
      expect(screen.queryByText('projectPanel.swarm.autonomyReminder.resume')).toBeNull()
      const talk = screen.getByRole('button', { name: 'projectPanel.swarm.automationFrameTalk' }) as HTMLButtonElement
      expect(talk.disabled).toBe(false)
      const supplyBefore = posted.filter((item) => item.url === '/api/swarm/supply/open').length
      fireEvent.click(talk)
      await waitFor(() => expect(posted.filter((item) => item.url === '/api/swarm/supply/open')).toHaveLength(supplyBefore + 1))
      expect(posted.some((item) => item.url.includes('/orchestrator/start'))).toBe(false)
      view.unmount()
    }
  })

  it('hides every owner project automation action before the first frame while preserving manual president launch', async () => {
    for (const collapsed of [true, false]) {
      for (const seen of [false, true]) {
        if (seen) localStorage.setItem('og-swarm-onboarding-seen-v1', '1')
        else localStorage.removeItem('og-swarm-onboarding-seen-v1')
        const { posted } = harness(engineState({ running: false, autonomyRemembered: true }))
        const view = render(<SwarmModule project={project} ownerFeatures collapsed={collapsed} onToggleCollapsed={() => {}} />)
        await screen.findByTestId('swarm-bar-toggle')
        expect(screen.queryByRole('switch', { name: POWER })).toBeNull()
        expect(screen.queryByRole('button', { name: 'projectPanel.swarm.power.start' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'projectPanel.swarm.autonomyReminder.resume' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'projectPanel.swarm.autonomyReminder.dismiss' })).toBeNull()
        if (!collapsed) {
          const talk = await screen.findByRole('button', { name: 'projectPanel.swarm.automationFrameTalk' })
          fireEvent.click(talk)
          await waitFor(() => expect(posted.some(item => item.url === '/api/swarm/supply/open')).toBe(true))
        }
        expect(posted.some(item => /\/orchestrator\/(start|stop)$/.test(item.url))).toBe(false)
        view.unmount()
      }
    }
  })

  it('retains the unconfigured public opt-in start and resume controls', async () => {
    localStorage.setItem('og-swarm-onboarding-seen-v1', '1')
    const { posted } = harness(engineState({ running: false, autonomyRemembered: true, automation: { enabled: false, allowed: true } }))
    render(<SwarmModule project={project} ownerFeatures={false} />)
    const power = await screen.findByRole('switch', { name: POWER })
    await waitFor(() => expect((power as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByRole('button', { name: 'projectPanel.swarm.power.start' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'projectPanel.swarm.autonomyReminder.resume' })).toBeTruthy()
    fireEvent.click(power)
    await waitFor(() => expect(posted.some(item => item.url === '/api/swarm/orchestrator/start')).toBe(true))
  })

  it('keeps a running owner engine visible without exposing project auto-power, while manual president start still works', async () => {
    const { posted } = harness(engineState({ running: true }))
    render(<SwarmModule project={project} ownerFeatures />)
    const manual = await screen.findByRole('button', { name: 'projectPanel.swarm.supply.launch' })
    expect(screen.queryByRole('switch', { name: POWER })).toBeNull()
    expect(screen.queryByRole('button', { name: 'projectPanel.swarm.power.start' })).toBeNull()
    fireEvent.click(manual)
    await waitFor(() => expect(posted.some(item => item.url === '/api/swarm/supply/open')).toBe(true))
    expect(posted.some(item => /\/orchestrator\/(start|stop)$/.test(item.url))).toBe(false)
  })

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

// Review D-M3 (2026-11-28): a held operation's question (receiptKey `hold:`) is
// answered right from the bar's 「あなたへの質問」 — the president cannot answer for
// its own held conversation, and no screen posted an answer before.
describe('the bar takes the answer to a held operation', () => {
  const hold = { id: 'esc-1', status: 'open', receiptKey: 'hold:native-sid', plainQuestion: '決めていただきたいこと: 社長が…\nA「確認した」: …' }
  it('with a held-operation question the count is a button that opens it; A posts the answer', async () => {
    const { posted } = harness(engineState(), [hold])
    render(<SwarmModule project={project} collapsed onToggleCollapsed={() => {}} />)
    const chip = await screen.findByRole('button', { name: 'projectPanel.swarm.bar.questions:{"count":1}' })
    expect(chip.getAttribute('title')).toBe('projectPanel.swarm.bar.answerHint')
    fireEvent.click(chip)
    expect(await screen.findByText(/決めていただきたいこと: 社長が/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'B' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    await waitFor(() => expect(posted).toContainEqual({ url: '/api/swarm/escalations/answer', body: { id: 'esc-1', answer: 'A' } }))
  })
  // Review R2 S-1: after the last held question was answered the dialog stayed
  // "open" with nothing in it, so the next poll's hold question (or the answered
  // one, handed back by a poll already in flight) popped the modal with no click.
  it('answering the last held question closes the dialog for good: no later poll reopens it by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let list: unknown[] = [hold]
      let reads = 0
      harness(engineState(), () => { reads++; return list })
      render(<SwarmModule project={project} collapsed onToggleCollapsed={() => {}} />)
      fireEvent.click(await screen.findByRole('button', { name: 'projectPanel.swarm.bar.questions:{"count":1}' }))
      fireEvent.click(await screen.findByRole('button', { name: 'A' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      const poll = async () => {
        const before = reads
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
        await waitFor(() => expect(reads).toBeGreaterThan(before))
        await act(async () => {})
      }
      // A poll already in flight hands back the question just answered…
      await poll()
      await screen.findByRole('button', { name: 'projectPanel.swarm.bar.questions:{"count":1}' })
      expect(screen.queryByRole('dialog')).toBeNull()
      // …and a new held question arrives on the next one.
      list = [{ ...hold, id: 'esc-9', plainQuestion: '別の止まった操作' }]
      await poll()
      expect(screen.queryByText(/別の止まった操作/)).toBeNull()
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
  // Review R2 S-8: the chip counted every open question while the dialog showed
  // only the held ones, and the others lost their "tell the president" hint.
  it('held and ordinary questions together: the chip and the dialog say the same count, and the others are named', async () => {
    const other = (id: string) => ({ id, status: 'open', receiptKey: `commander:${id}`, question: 'q' })
    harness(engineState(), [hold, other('esc-2'), other('esc-3')])
    render(<SwarmModule project={project} collapsed onToggleCollapsed={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'projectPanel.swarm.bar.questions:{"count":3}' }))
    expect(await screen.findByRole('dialog', { name: 'projectPanel.swarm.bar.questions:{"count":3}' })).toBeTruthy()
    expect(screen.getByText('projectPanel.swarm.bar.otherQuestions:{"count":2}')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'A' })).toHaveLength(1)
  })
  it('other questions keep the plain count (answered through the president)', async () => {
    harness(engineState(), [{ id: 'esc-2', status: 'open', receiptKey: 'commander:x', question: 'q' }])
    render(<SwarmModule project={project} collapsed onToggleCollapsed={() => {}} />)
    await screen.findByText('projectPanel.swarm.bar.questions:{"count":1}')
    expect(screen.queryByRole('button', { name: 'projectPanel.swarm.bar.questions:{"count":1}' })).toBeNull()
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
