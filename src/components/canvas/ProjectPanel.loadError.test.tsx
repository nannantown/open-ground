// @vitest-environment jsdom
//
// Regression guard for the initial-load `res.ok` check (ProjectPanel's load
// effect). Before the fix `.then(r => r.json())` parsed the body regardless of
// status, so a non-2xx `{ error }` envelope — e.g. a 403 when the project was
// unregistered in ANOTHER window, then this card is opened — was adopted as
// `data`. That left `loadError` null (no Retry UI) AND fed BoardModule a
// tasks-less object → `data.tasks.find` TypeError → white screen. The guard
// throws on `!r.ok` so the load routes through the catch → setLoadError → the
// designed Retry UI, matching reloadProjectData / persist / the describe poll.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ProjectData, ProjectMeta } from '@/lib/types'

// --- Mocks -----------------------------------------------------------------

// Identity translator: assert on i18n KEYS (projectPanel.retry / .loadFailed)
// rather than localized copy. (RealtimeContext's default is { enabled:false },
// so useCollab needs no provider; ProjectPanel's owner body renders no
// CollabPresence/useAuth, so no AuthProvider is needed either.)
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))

// The claude `auth status` probe is irrelevant here and would add async churn —
// stub it to a settled "connected" so no /api/claude-connection fetch fires.
vi.mock('@/lib/useClaudeConnection', () => ({
  useClaudeConnection: () => ({ installed: true, loggedIn: true }),
}))

// Stub the heavy render targets. The Board mock reads `data.tasks.length` — this
// is the TEETH: if the res.ok guard regresses and an `{ error }` envelope ever
// reaches `data`, the success branch renders this and throws on `data.tasks`,
// failing the test. On the error path the Board must never mount at all.
vi.mock('@/components/canvas/modules/BoardModule', () => ({
  // The notes field stands in for the drawer's notes (defaultValue + onBlur →
  // persist, BoardModule.tsx) for the leave-saves guards.
  BoardModule: (props: { data: ProjectData; persist: (d: ProjectData) => void }) => (
    <div data-testid="board">
      {props.data.tasks.length}
      <textarea
        data-testid="board-notes"
        defaultValue={props.data.notes}
        onBlur={e => props.persist({ ...props.data, notes: e.currentTarget.value })}
      />
    </div>
  ),
}))
vi.mock('@/components/canvas/CanvasWorkspace', () => ({
  CanvasWorkspace: () => <div data-testid="canvas-ws" />,
}))

// Control the initial-load GET per test; every OTHER api path resolves benignly
// via a deep proxy so unrelated mount effects never hit the network or throw on
// an undefined route.
const h = vi.hoisted(() => ({
  projectGet: null as null | ((...a: unknown[]) => Promise<Response>),
  puts: [] as ProjectData[],
}))
vi.mock('@/lib/api-client', () => {
  const benign = () =>
    Promise.resolve(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  const deep = (path: string[]): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, prop) =>
        prop === 'then' ? undefined : deep([...path, typeof prop === 'string' ? prop : String(prop)]),
      apply: (_t, _this, args: unknown[]) => {
        if (path.join('.') === 'project.$put') h.puts.push((args[0] as { json: ProjectData }).json)
        return path.join('.') === 'project.$get' && h.projectGet ? h.projectGet(...args) : benign()
      },
    })
  return { api: { api: deep([]) } }
})

import { ProjectPanel } from '@/components/canvas/ProjectPanel'

// --- Fixtures --------------------------------------------------------------

const PROJECT: ProjectMeta = {
  id: 'uuid-1',
  name: 'proj',
  path: '/tmp/proj',
  description: '',
  lastModified: '2026-06-30T00:00:00Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
}

const VALID: ProjectData = {
  description: '',
  tasks: [],
  notes: '',
  updatedAt: '2026-06-30T00:00:00Z',
}

const noop = () => {}
const errorResponse = (status: number) =>
  Promise.resolve(
    new Response(JSON.stringify({ error: 'project not registered' }), { status }),
  )

const renderPanel = () =>
  render(<ProjectPanel project={PROJECT} onClose={noop} onRemove={noop} frameLabel={null} />)

beforeEach(() => {
  // Any raw fetch() mount effect (editors / branch-changes / describe-active …)
  // gets a benign 200 so it can't throw or hit a real server (HOME-isolated).
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    ),
  )
})
afterEach(() => {
  h.projectGet = null
  h.puts = []
  vi.unstubAllGlobals()
})

describe('ProjectPanel initial load — res.ok guard', () => {
  it('shows the Retry UI (loadError set) instead of crashing when the GET 403s', async () => {
    h.projectGet = () => errorResponse(403)
    renderPanel()
    // loadError is set → the body renders the designed Retry affordance …
    expect(await screen.findByText('projectPanel.retry')).toBeTruthy()
    // … and the { error } body was NOT adopted as data, so the Board (which
    // would crash on data.tasks.find) never mounts. No white screen.
    expect(screen.queryByTestId('board')).toBeNull()
  })

  it.each([404, 500])('shows Retry on a %i too (no white screen)', async (status) => {
    h.projectGet = () => errorResponse(status)
    renderPanel()
    expect(await screen.findByText('projectPanel.retry')).toBeTruthy()
    expect(screen.queryByTestId('board')).toBeNull()
  })

  it('renders the board normally on a 200 (normal load is unchanged)', async () => {
    h.projectGet = () => Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 }))
    renderPanel()
    // Valid ProjectData flows through to BoardModule (tasks readable) and no
    // error surface appears — the ok path is untouched by the guard.
    expect(await screen.findByTestId('board')).toBeTruthy()
    expect(screen.queryByText('projectPanel.retry')).toBeNull()
  })
})

// Opening a project is the read receipt for the Ground card's eye (owner
// 2026-09-26: 「プロジェクトの中に入ったら、既読みたいな感じ」). The panel — not
// the agent-team bar — must stamp it, and with the 'opened' kind: a /seen
// stamp here would clear the president's hand on a mere visit.
describe('ProjectPanel — opening the project clears the Ground eye', () => {
  it('stamps POST /api/ground/opened with the path on open and on leave, never /seen', async () => {
    h.projectGet = () => Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 }))
    const { unmount } = renderPanel()
    await screen.findByTestId('board')
    const f = fetch as unknown as ReturnType<typeof vi.fn>
    const ground = () =>
      f.mock.calls
        .filter((c) => String(c[0]).startsWith('/api/ground/'))
        .map((c) => [String(c[0]), JSON.parse(String((c[1] as RequestInit).body)).path])
    expect(ground()).toEqual([['/api/ground/opened', '/tmp/proj']])
    unmount()
    expect(ground()).toEqual([
      ['/api/ground/opened', '/tmp/proj'],
      ['/api/ground/opened', '/tmp/proj'],
    ])
  })
})

// Back-to-Ground shortcut (owner 2026-10-01). Cmd+G is the Canvas's Group, so
// the chord is Cmd+[ on the Mac / Ctrl+Shift+[ elsewhere. It must work with the
// caret in a terminal (xterm's input is a TEXTAREA that would eat the key),
// never mid-IME, never on Ground (the panel stays mounted with project=null),
// never under an overlay, and it must let blur-saved fields commit first.
describe('ProjectPanel — Cmd+[ goes back to Ground', () => {
  const mac = () => vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
  const loaded = () => {
    h.projectGet = () => Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 }))
  }

  it('closes on Cmd+[ with the caret in a terminal, not mid-IME or on other chords', () => {
    mac()
    loaded()
    const term = document.createElement('textarea')
    document.body.appendChild(term)
    try {
      const onClose = vi.fn()
      render(<ProjectPanel project={PROJECT} onClose={onClose} onRemove={noop} frameLabel={null} />)
      const seen = vi.fn()
      term.addEventListener('keydown', seen)
      fireEvent.keyDown(term, { key: '[', metaKey: true, isComposing: true })
      fireEvent.keyDown(term, { key: '[', ctrlKey: true })
      fireEvent.keyDown(term, { key: '[' })
      fireEvent.keyDown(term, { key: 'g', metaKey: true }) // Canvas Group stays Canvas's
      fireEvent.keyDown(term, { key: 'g', metaKey: true, shiftKey: true }) // and Ungroup
      expect(onClose).not.toHaveBeenCalled()
      fireEvent.keyDown(term, { key: '[', metaKey: true })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(seen).toHaveBeenCalledTimes(5) // the terminal never got the Cmd+[
    } finally {
      term.remove()
    }
  })

  it('off the Mac the chord is Ctrl+Shift+[ — plain Ctrl+[ stays ESC for the terminal', () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'Win32' })
    loaded()
    const onClose = vi.fn()
    render(<ProjectPanel project={PROJECT} onClose={onClose} onRemove={noop} frameLabel={null} />)
    fireEvent.keyDown(window, { key: '[', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '{', ctrlKey: true, shiftKey: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('on Ground (project=null) the key is left alone — no close, not stopped', () => {
    mac()
    const onClose = vi.fn()
    render(<ProjectPanel project={null} onClose={onClose} onRemove={noop} frameLabel={null} />)
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    try {
      const ev = new KeyboardEvent('keydown', { key: '[', metaKey: true, bubbles: true, cancelable: true })
      document.body.dispatchEvent(ev)
      expect(onClose).not.toHaveBeenCalled()
      expect(ev.defaultPrevented).toBe(false)
      expect(seen).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', seen)
    }
  })

  // The Board drawer's notes save on blur through persist(), which debounces.
  // Leaving drops the project (App passes project=null), so the debounced save
  // must be flushed on the way out or it finds no data and is lost. Asserts
  // the BODY that reaches PUT, not merely that a save handler ran.
  const typeNoteThenLeave = async (leave: (notes: HTMLElement) => void) => {
    mac()
    loaded()
    const onClose = vi.fn(() =>
      view.rerender(<ProjectPanel project={null} onClose={onClose} onRemove={noop} frameLabel={null} />),
    )
    const view = render(<ProjectPanel project={PROJECT} onClose={onClose} onRemove={noop} frameLabel={null} />)
    const notes = (await screen.findByTestId('board-notes')) as HTMLTextAreaElement
    notes.focus()
    notes.value = 'memo typed just before leaving'
    leave(notes)
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(h.puts.map(b => b.notes)).toContain('memo typed just before leaving'),
    )
  }

  it('a note typed then left with Cmd+[ (caret still in it) is saved', async () => {
    await typeNoteThenLeave(notes => fireEvent.keyDown(notes, { key: '[', metaKey: true }))
  })

  it('…and the same through the back button', async () => {
    await typeNoteThenLeave(() => {
      const back = screen.getByTitle(/projectPanel\.backToGround/)
      back.focus() // what a real click does first: the field blurs
      fireEvent.click(back)
    })
  })

  it('does nothing while an overlay (settings / palette / dialog) is open', () => {
    mac()
    loaded()
    const overlay = document.createElement('div')
    overlay.setAttribute('data-esc-overlay', '')
    document.body.appendChild(overlay)
    try {
      const onClose = vi.fn()
      render(<ProjectPanel project={PROJECT} onClose={onClose} onRemove={noop} frameLabel={null} />)
      fireEvent.keyDown(window, { key: '[', metaKey: true })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      overlay.remove()
    }
  })
})
