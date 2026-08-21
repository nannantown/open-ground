// @vitest-environment jsdom
//
// App.tsx WHOLE-RENDER integration test — the long-standing "full-render gap"
// (App.collab.test.tsx covers only the two pure helpers, noting "App pulls in
// the entire canvas tree — a known full-render gap"). This mounts the REAL App
// inside its production provider tree (main.tsx order: I18n → Auth → Realtime)
// with the network stubbed, so we exercise:
//   * the mount path actually renders without throwing (the fragile part),
//   * the first-run empty state vs the populated Ground (one Ground card per
//     registered project — proves load() → /api/projects wiring reaches the UI),
//   * the global "Claude is designing" beacon driven by /api/canvas/ai/active.
//
// fetch is stubbed (both raw fetch('/api/…') AND the hc `api.*` client funnel
// through global fetch); ResizeObserver is stubbed because InfiniteCanvas
// observes its viewport. No claude, no real network, HOME already isolated by
// the suite-wide setup-home.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react'
import App from './App'
import { I18nProvider } from '@/i18n/I18nContext'
import { AuthProvider } from '@/lib/auth/AuthContext'
import { RealtimeProvider } from '@/lib/collab/RealtimeContext'
import type { GroundLampRow, ProjectMeta } from '@/lib/types'

// InfiniteCanvas observes its viewport with a ResizeObserver — absent in jsdom.
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Minimal but SHAPE-CORRECT payloads. /api/projects carries the whole Ground
// bootstrap ({ settings, projects, canvas }) — load() reads data.canvas.positions
// + data.settings, so those must exist or autoLayout/setSettings throw.
const SETTINGS = { projectsRoot: null, archiveDirName: '', excludePatterns: [] }
const EMPTY_CANVAS = { positions: {}, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] }

const projectMeta = (over: Partial<ProjectMeta> = {}): ProjectMeta => ({
  id: 'id',
  name: 'Project',
  path: '/tmp/project',
  description: '',
  lastModified: '2020-01-01T00:00:00Z',
  hasGit: false,
  openTaskCount: 0,
  totalTaskCount: 0,
  ...over,
})

const reply = (status: number, body: unknown) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response)

const urlOf = (input: unknown): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : ((input as Request)?.url ?? '')

interface MockOpts {
  projects?: ProjectMeta[]
  aiActiveJobs?: number
  /** Non-2xx status for POST /api/settings, to exercise the save-failure path. */
  settingsPostStatus?: number
  settingsPostError?: string
  /** GET /api/experiments — the owner-only gate, resolved SERVER-side. Omitted ⇒
   *  the shipped/non-owner answer (nothing eligible, every flag closed). */
  experiments?: { eligible: boolean; flags: Record<string, boolean> }
  /** GET /api/ground/lamps — what each card's lamp is decided from. Omitted ⇒
   *  no rows, i.e. every card dark, which is the resting state. */
  lamps?: GroundLampRow[]
}

const methodOf = (input: unknown, init?: RequestInit): string =>
  init?.method ?? (input instanceof Request ? input.method : 'GET')

function installFetch(opts: MockOpts = {}) {
  const projects = opts.projects ?? []
  const jobs = Array.from({ length: opts.aiActiveJobs ?? 0 }, (_, i) => ({ id: `job-${i}` }))
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = urlOf(input)
    if (url.includes('/api/settings') && methodOf(input, init) === 'POST') {
      const status = opts.settingsPostStatus ?? 200
      return reply(status, status >= 300 ? { error: opts.settingsPostError ?? 'save failed' } : { ok: true })
    }
    if (url.includes('/api/settings')) return reply(200, { ...SETTINGS, suggestedDisplayName: null })
    if (url.includes('/api/projects'))
      return reply(200, { settings: SETTINGS, projects, canvas: EMPTY_CANVAS })
    if (url.includes('/api/experiments'))
      return reply(
        200,
        opts.experiments ?? {
          eligible: false,
          flags: { swarm: false, sandbox: false, persona: false },
        },
      )
    if (url.includes('/api/canvas/ai/active')) return reply(200, { jobs })
    if (url.includes('/api/terminal/active')) return reply(200, { cwds: [], claude: [] })
    if (url.includes('/api/ground/lamps')) return reply(200, { lamps: opts.lamps ?? [] })
    if (url.includes('/api/auth/session')) return reply(503, {}) // signed-out (default build)
    if (url.includes('/api/collab/config')) return reply(200, { enabled: false })
    // Everything else (feedback/config, module-submissions, notifications,
    // auth/config, usage, …) reads optionally — an empty object collapses to
    // the default (disabled) build, which is what we render here.
    return reply(200, {})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderApp = () =>
  render(
    <I18nProvider>
      <AuthProvider>
        <RealtimeProvider>
          <App />
        </RealtimeProvider>
      </AuthProvider>
    </I18nProvider>,
  )

beforeEach(() => {
  // Deterministic UI language (the empty-state copy asserted below is English).
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ROStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App — whole-render integration', () => {
  it('mounts the full provider tree and shows the first-run empty state when no projects exist', async () => {
    installFetch({ projects: [] })
    await act(async () => {
      renderApp()
    })
    // misc.empty.title (en) — the first-run overlay headline.
    expect(await screen.findByText('Begin your atlas.')).toBeInTheDocument()
  })

  it('renders one Ground card per registered project and drops the empty state', async () => {
    // Distinctive, collision-proof names — a generic name like "Beta" would
    // also match the Toolbar's "Beta" feature badge and yield false multiples.
    installFetch({
      projects: [
        projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' }),
        projectMeta({ id: 'b', name: 'Cartographers Guild', path: '/b' }),
      ],
    })
    await act(async () => {
      renderApp()
    })
    // Cards are driven by load() → /api/projects → setProjects → InfiniteCanvas.
    // Finding both names proves the hc fetch funnel reached the UI.
    expect(await screen.findByText('Northwind Atlas')).toBeInTheDocument()
    expect(screen.getByText('Cartographers Guild')).toBeInTheDocument()
    // The empty-state overlay must be gone once the Ground has owned cards.
    expect(screen.queryByText('Begin your atlas.')).not.toBeInTheDocument()
  })

  // ── the Ground card lamp ─────────────────────────────────────────────────
  //
  // THE BUG THIS REPLACED, twice reported: every card read WAITING with every
  // task done, because the lamp was the collapsed list of live `claude` panes
  // and every project running a swarm holds a commander and a supply desk at
  // their prompts. The lamp is now about the WORK — /api/ground/lamps sends the
  // facts, the pure groundLamp() decides — and these assert the two ends of that
  // wire on the REAL card, not on the helper.
  it('shows nothing at all on a project whose cards are all done', async () => {
    // 「作業が終わってて何も出さない時にuserは見にいくんですよ」 — silence is the
    // signal, and a live process must not be able to break it.
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', started: 0, openQuestions: 0, liveWork: true }],
    })
    await act(async () => {
      renderApp()
    })
    await screen.findByText('Northwind Atlas')
    await waitFor(() =>
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0),
    )
    expect(screen.queryByText('Waiting')).not.toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
    // …and it is SILENT, not "No data" — the board was read, and it said done.
    expect(screen.queryByText('No data')).not.toBeInTheDocument()
  })

  it('says Running while a started card is actually being worked', async () => {
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', started: 1, openQuestions: 0, liveWork: true }],
    })
    await act(async () => {
      renderApp()
    })
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.queryByText('Waiting')).not.toBeInTheDocument()
  })

  it('stays SILENT on started-but-idle work — waiting is only ever a question (2026-08-18)', async () => {
    // The owner's amendment: 「waitingは僕が何かをしないといけない時にだけ出しま
    // しょう」. Parked/stalled cards are the machine's problem; the card goes
    // amber only for an unanswered question (the case below).
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', started: 1, openQuestions: 0, liveWork: false }],
    })
    await act(async () => {
      renderApp()
    })
    await screen.findByText('Northwind Atlas')
    expect(screen.queryByText('Waiting')).not.toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })

  it('says Waiting for an open question even while the swarm runs', async () => {
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', started: 2, openQuestions: 1, liveWork: true }],
    })
    await act(async () => {
      renderApp()
    })
    expect(await screen.findByText('Waiting')).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })

  it('says NO DATA — not silence — over a board it could not read', async () => {
    // ⚠ THE SUBTLE ONE. `started` absent is not 0, and here the difference is
    // not a number on screen: SILENCE IS THE FINISHED STATE on this card. So a
    // corrupt tasks.json rendering as a blank card would tell the owner their
    // project is done, using a file nobody managed to open. It has to say
    // something, and what it says must be about the app, not about their work.
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', liveWork: true }],
    })
    await act(async () => {
      renderApp()
    })
    expect(await screen.findByText('No data')).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
    expect(screen.queryByText('Waiting')).not.toBeInTheDocument()
  })

  it('surfaces the global "Claude is designing" beacon while a Canvas AI job is active', async () => {
    installFetch({ projects: [], aiActiveJobs: 2 })
    await act(async () => {
      renderApp()
    })
    // canvas.generate.generating (en) — only rendered when aiActiveCount > 0,
    // i.e. /api/canvas/ai/active reported running jobs.
    expect(await screen.findByText('Generating with Claude…')).toBeInTheDocument()
  })

  it('hides the AI beacon when no Canvas AI job is running', async () => {
    installFetch({ projects: [], aiActiveJobs: 0 })
    await act(async () => {
      renderApp()
    })
    // Wait for the mount to settle on a known anchor, then assert the beacon is absent.
    await screen.findByText('Begin your atlas.')
    expect(screen.queryByText('Generating with Claude…')).not.toBeInTheDocument()
  })
})

// ─── The Ground Persona entry (2026-08-14) ──────────────────────────────────
//
// The Persona surface is about the OWNER, not a repo (its notes live in
// ~/.openground/ and are identical on every project), so it left the per-project
// tab row for the Ground toolbar beside Settings / Manual / Skills. It stays
// owner-only and hidden: App passes `onOpenPersona` ONLY when the persona
// experiment (its own flag) is open, and an undefined handler is what makes the
// Toolbar render nothing at all. (Until 2026-08-20 a swarm flag also opened it;
// persona is now its own beta and that coupling was dropped — see gate.ts.)
//
// Asserted through the WHOLE app rather than the Toolbar in isolation, because
// what has to hold is the wiring: /api/experiments → useExperiments →
// isPersonaOpen → the prop → a button that actually opens the panel. A Toolbar
// unit test cannot tell a closed gate from a forgotten prop.
const gateFlags = (open: Partial<Record<string, boolean>> = {}) => ({
  eligible: true,
  flags: { swarm: false, sandbox: false, persona: false, ...open },
})

describe('App — Ground Persona entry gate', () => {
  it('draws NO persona entry on the default build (every experiment closed)', async () => {
    installFetch({ projects: [] })
    await act(async () => {
      renderApp()
    })
    await screen.findByText('Begin your atlas.')
    // Anchor on a control that IS always there, so "nothing found" cannot be a
    // toolbar that failed to render at all.
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Persona' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('persona-panel')).not.toBeInTheDocument()
  })

  it('draws the entry when the persona experiment is open, and it opens the panel', async () => {
    installFetch({ projects: [], experiments: gateFlags({ persona: true }) })
    await act(async () => {
      renderApp()
    })
    const entry = await screen.findByRole('button', { name: 'Persona' })
    // Closed until asked for — the toolbar entry is a door, not a panel.
    expect(screen.queryByTestId('persona-panel')).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(entry)
    })
    const panel = await screen.findByTestId('persona-panel')
    // Full-bleed, but it keeps a Ground panel's explicit way out — and since
    // 2026-08-15 that way out is the SHARED one every other panel uses (owner:
    // 「戻るボタンも他の画面と共通化して踏襲させて」), top-left, not a Close in
    // the corner. Pinned by name so a silent revert to a bespoke control here
    // fails rather than merely looking different.
    const back = within(panel).getByRole('button', { name: 'Back to Ground' })
    expect(back).toBeInTheDocument()
    // ⚠ AND IT LOOKS LIKE THE OTHER ONES. Sharing the component was not enough:
    // it sat inside a bordered, shadowed chip here and bare everywhere else, so
    // it still read as a different control (owner, 2026-08-16: 「groundに戻るの
    // デザインも他のところと違うよね なぜ同じにしない?」). The chip existed to fix a
    // real contrast problem — `ink-muted` is ~1.5:1 on the non-inverting stage —
    // which is now fixed in the INK (`tone="onDeep"`) where it belongs. Both
    // halves are pinned, because dropping the chip without the tone swap trades
    // a visible inconsistency for an invisible one.
    expect((back.parentElement as HTMLElement).className).not.toMatch(
      /\bborder\b|\bbg-bg-card\b|\bshadow-card\b/,
    )
    expect(back.className).toMatch(/text-ink-onDeep/)
    expect(back.className).not.toMatch(/text-ink-muted/)
    await act(async () => {
      fireEvent.click(back)
    })
    expect(screen.queryByTestId('persona-panel')).not.toBeInTheDocument()
  })

  it('Escape closes the panel — the other affordance every Ground panel has', async () => {
    // Asserted on the DOM, not on the wiring: the surface is edge-to-edge with a
    // canvas that takes its own pointer/keyboard gestures, so "the shared Overlay
    // handles Esc" is exactly the kind of claim that is true right up until a
    // child swallows the key.
    installFetch({ projects: [], experiments: gateFlags({ persona: true }) })
    await act(async () => {
      renderApp()
    })
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Persona' }))
    })
    await screen.findByTestId('persona-panel')
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.queryByTestId('persona-panel')).not.toBeInTheDocument()
  })

  it('⚠ does NOT draw the entry for a swarm-only account (the 0.11.94 leak, fixed)', async () => {
    // Persona was promoted to its own beta (2026-08-20): the swarm↔persona
    // any-of gate was dropped, so a `flags.swarm` account no longer sees the
    // personal-corpus screen. The owner's own "swarm on ⇒ persona visible"
    // coupling now lives server-side in flags.persona, so it never reaches the
    // client as a bare swarm flag.
    installFetch({ projects: [], experiments: gateFlags({ swarm: true }) })
    await act(async () => {
      renderApp()
    })
    await screen.findByText('Begin your atlas.')
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Persona' })).not.toBeInTheDocument()
  })

  it('stays hidden when only an unrelated experiment is open', async () => {
    installFetch({ projects: [], experiments: gateFlags({ sandbox: true }) })
    await act(async () => {
      renderApp()
    })
    await screen.findByText('Begin your atlas.')
    expect(screen.queryByRole('button', { name: 'Persona' })).not.toBeInTheDocument()
  })
})

describe('App — saveSettings failure handling (audit 856daefb)', () => {
  it('surfaces an error and does NOT silently roll back the edit when POST /api/settings fails', async () => {
    const fetchMock = installFetch({
      projects: [],
      settingsPostStatus: 500,
      settingsPostError: 'disk full',
    })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    let unmount!: () => void
    await act(async () => {
      ;({ unmount } = renderApp())
    })
    await screen.findByText('Begin your atlas.')

    const projectsCallsBefore = fetchMock.mock.calls.filter((c) =>
      urlOf(c[0]).includes('/api/projects'),
    ).length

    const gear = screen.getByRole('button', { name: 'Settings' })
    fireEvent.click(gear)
    const nameInput = await screen.findByRole('textbox')
    fireEvent.change(nameInput, { target: { value: 'New Name' } })
    fireEvent.blur(nameInput) // triggers the panel's immediate flush() → onSave

    // The failed save must be surfaced to the user…
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))
    expect(alertSpy.mock.calls[0][0]).toContain('disk full')
    // …and must NOT reload /api/projects (which would refetch the stale
    // settings and silently overwrite the user's edit with no explanation —
    // the exact bug from audit 856daefb).
    const projectsCallsAfter = fetchMock.mock.calls.filter((c) =>
      urlOf(c[0]).includes('/api/projects'),
    ).length
    expect(projectsCallsAfter).toBe(projectsCallsBefore)

    // Unmount while the mock is still installed — the panel's flush-on-unmount
    // effect re-fires onSave with the (still-pending) edit, which would
    // otherwise hit the real network after fetch is unstubbed in afterEach.
    await act(async () => {
      unmount()
    })
  })
})
