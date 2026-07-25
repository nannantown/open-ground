// @vitest-environment jsdom
//
// card 2b — the OVERSEER RESTORE BANNER, client side: the surface
// OVERSEER_DESIGN.md:161 asks for ("this asymmetry is made visible through the
// toggle's display"), which card 2 accidentally silenced by making a restart RESUME
// the engine — the old reminder is gated on `!running`, so it stopped rendering.
//
// The server pins live in src/lib/server/swarmOrchestrator.overseerReminder.test.ts
// (what the two actions DO). This file pins the WIRING, which is where the
// d1d6d704 dismiss bug actually lived: the banner was right, the action behind [×]
// was the wrong one. Each test names the mutation that turns it red:
//   · point [×] at the overseer toggle (…/overseer {enabled:false}) instead of its
//     own …/overseer/dismiss endpoint ⇒ red
//   · point [戻す] at anything other than an arm (…/overseer {enabled:true}) ⇒ red
//   · restore `autonomyRemembered && !engine.running` as the restored notice's
//     condition ⇒ red (that pair cannot be true for a resumed engine)
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { messages } from '@/i18n/messages'
import type { ProjectMeta, SwarmOrchestratorState } from '@/lib/types'

// Translate to the KEY, so these assertions are locale-independent (the sibling
// SwarmEscalationsPane.test.tsx pattern). The actual JA/EN copy is pinned by its
// own describe block at the bottom — where a wording check belongs.
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

/** The engine snapshot GET /api/swarm/orchestrator answers with. Defaults describe
 *  a freshly-booted app whose engine WAS restored and whose overseer was NOT —
 *  card 2b's exact state. */
const engineState = (over: Partial<SwarmOrchestratorState> = {}): SwarmOrchestratorState => ({
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
  autonomyRemembered: true,
  autonomyResumed: true,
  overseerRemembered: true,
  ...over,
})

type Posted = { url: string; body: unknown }

/** Answer every route the Swarm pane polls and RECORD the POSTs, so a test can
 *  assert which endpoint a button reached. The engine GET replays `current`, which
 *  the two endpoints under test mutate the way the server would. */
const harness = (state: SwarmOrchestratorState) => {
  const posted: Posted[] = []
  let current = state
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)

  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : ((input as Request)?.url ?? '')
      if (init?.method === 'POST' && url.startsWith('/api/swarm/')) {
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
        posted.push({ url, body })
        if (url === '/api/swarm/orchestrator/overseer') {
          current = { ...current, overseer: body.enabled === true, overseerRemembered: true }
        } else if (url === '/api/swarm/orchestrator/overseer/dismiss') {
          current = { ...current, overseerRemembered: false }
        }
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

const EFFECTS = 'projectPanel.swarm.overseerReminder.effects'
const RESTORE = 'projectPanel.swarm.overseerReminder.restore'
const DISMISS = 'projectPanel.swarm.overseerReminder.dismiss'
const RESTORED_NOTICE = 'projectPanel.swarm.autonomyRestored'
const NEEDS_AUTONOMY = 'projectPanel.swarm.overseerReminder.needsAutonomy'

describe('overseer restore banner — the asymmetry made visible (完了条件1)', () => {
  it('renders while the record says ON and the overseer is OFF, with the one-click restore', async () => {
    harness(engineState())
    render(<SwarmModule project={project} />)

    expect(await screen.findByText(EFFECTS)).toBeTruthy()
    expect(await screen.findByRole('button', { name: RESTORE })).toBeTruthy()
  })

  it('stays hidden when the overseer is already armed, and when nothing is remembered', async () => {
    harness(engineState({ overseer: true }))
    const armed = render(<SwarmModule project={project} />)
    await waitFor(() => expect(armed.queryByText(EFFECTS)).toBeNull())
    cleanup()

    harness(engineState({ overseerRemembered: false }))
    const forgotten = render(<SwarmModule project={project} />)
    await waitFor(() => expect(forgotten.queryByText(EFFECTS)).toBeNull())
  })

  it('[戻す] really ARMS — it POSTs the overseer toggle with enabled:true', async () => {
    const { posted } = harness(engineState())
    render(<SwarmModule project={project} />)

    await userEvent.click(await screen.findByRole('button', { name: RESTORE }))

    // MUTATION: wire the button to the dismiss action (or to nothing) ⇒ red.
    await waitFor(() =>
      expect(posted).toContainEqual({
        url: '/api/swarm/orchestrator/overseer',
        body: { path: '/p2b', enabled: true },
      }),
    )
    // ...and the banner steps aside once the overseer is actually on.
    await waitFor(() => expect(screen.queryByText(EFFECTS)).toBeNull())
  })

  it('[×] is NOT a no-op: it POSTs the dedicated dismiss endpoint, never the toggle', async () => {
    const { posted } = harness(engineState())
    render(<SwarmModule project={project} />)
    await screen.findByText(EFFECTS)

    await userEvent.click(await screen.findByRole('button', { name: DISMISS }))

    // THE card's 完了条件2. MUTATION: point this at …/overseer with enabled:false —
    // the "obvious" implementation — ⇒ red on BOTH assertions. That request is a
    // guaranteed no-op server-side (the overseer is already disarmed, so the change
    // guard skips the persist), which is exactly how the autonomy banner's [×]
    // became a button the owner could press forever (d1d6d704).
    await waitFor(() =>
      expect(posted).toContainEqual({
        url: '/api/swarm/orchestrator/overseer/dismiss',
        body: { path: '/p2b' },
      }),
    )
    expect(posted.some((p) => p.url === '/api/swarm/orchestrator/overseer')).toBe(false)
    // ...and the banner is gone because the RECORD changed, not just local state.
    await waitFor(() => expect(screen.queryByText(EFFECTS)).toBeNull())
  })

  it('the restore button is disabled while autonomy is OFF, with the reason on screen', async () => {
    // Arming needs a running engine (the server's D1 gate, untouched by this card).
    // Dimming + saying why beats a click that silently does nothing.
    harness(engineState({ running: false, autonomyResumed: false }))
    render(<SwarmModule project={project} />)

    const restore = (await screen.findByRole('button', { name: RESTORE })) as HTMLButtonElement
    expect(restore.disabled).toBe(true)
    expect(await screen.findByText(NEEDS_AUTONOMY)).toBeTruthy()
  })
})

describe('autonomy restored notice — visible even though the engine came back running (完了条件5)', () => {
  it('shows for a BOOT-RESUMED engine — the case the old !running reminder can never cover', async () => {
    harness(engineState({ autonomyResumed: true, running: true }))
    render(<SwarmModule project={project} />)
    // MUTATION: gate this on `autonomyRemembered && !engine.running` (the pre-card-2b
    // condition) ⇒ red, because a resumed engine is running by definition.
    expect(await screen.findByText(RESTORED_NOTICE)).toBeTruthy()
  })

  it('does NOT show after a plain manual ON — a manual start restored nothing', async () => {
    harness(engineState({ autonomyResumed: false, running: true, autonomyRemembered: true }))
    const view = render(<SwarmModule project={project} />)
    await waitFor(() => expect(view.queryByText(RESTORED_NOTICE)).toBeNull())
  })
})

describe('banner copy — the owner has to understand what they are turning back on (完了条件4)', () => {
  // The button is one click from waking an AI that acts on its own. A banner the
  // owner cannot parse is not consent, so the copy is part of the feature, not
  // decoration — pinned in BOTH languages.
  const KEYS = [
    'projectPanel.swarm.overseerReminder',
    'projectPanel.swarm.overseerReminder.effects',
    'projectPanel.swarm.overseerReminder.needsAutonomy',
    'projectPanel.swarm.overseerReminder.restore',
    'projectPanel.swarm.overseerReminder.dismiss',
    'projectPanel.swarm.autonomyRestored',
  ] as const

  it('exists in JA and EN', () => {
    for (const key of KEYS) {
      for (const lang of ['ja', 'en'] as const) {
        const text = (messages[lang] as Record<string, string>)[key]
        expect(text, `${lang}:${key}`).toBeTruthy()
        expect(text, `${lang}:${key}`).not.toBe(key)
      }
    }
  })

  it('spells out ALL THREE outward effects, in plain words — not "it only notifies you"', () => {
    // The three the owner is actually consenting to (OVERSEER_DESIGN.md K2): the
    // supervisor STARTS an AI, STEPS INTO work already running, and CLEANS UP after
    // it. MUTATION: soften the line to "it watches and notifies you" ⇒ red.
    const ja = (messages.ja as Record<string, string>)['projectPanel.swarm.overseerReminder.effects']
    expect(ja).toMatch(/AI/) // 自分で AI を立ち上げ
    expect(ja).toMatch(/指示/) // 進んでいる作業に横から指示を入れ
    expect(ja).toMatch(/片付け|片づけ/) // 終わった作業の後片付け
    const en = (messages.en as Record<string, string>)['projectPanel.swarm.overseerReminder.effects']
    expect(en).toMatch(/starts up an AI/i)
    expect(en).toMatch(/instructions|steps in/i)
    expect(en).toMatch(/tidies|cleans/i)
  })

  it('uses NO engineering jargon — the owner is not a programmer', () => {
    for (const key of KEYS) {
      for (const lang of ['ja', 'en'] as const) {
        const text = (messages[lang] as Record<string, string>)[key]
        expect(text, `${lang}:${key}`).not.toMatch(/tier|quota|PTY|janitor|engine\.json|overseer/i)
      }
    }
  })
})
