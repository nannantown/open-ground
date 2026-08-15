// @vitest-environment jsdom
//
// Guard for the removal of the Canvas + Board side terminal docks (2026-08-15).
//
// Two facts are pinned here, and neither had ANY existing coverage:
//
//  1. Neither the Canvas view nor the Board view renders a TerminalDock. The
//     dock's collapsed state is a <button title={t('projectPanel.dockOpen')}>,
//     so its absence is observable in the DOM — not "the import is gone".
//     Canvas and Board are asserted separately because they were two separate
//     mounts and deleting one while leaving the other is exactly the miss.
//
//  2. The orphan sweep actually fires. Removing the mounts does NOT kill the
//     PTYs they spawned: EmbeddedClaudeTerminal never tore its PTY down on
//     unmount by design, and nothing server-side reclaims one (sweepTerminalPool
//     keeps live sessions; killing by cwd would take the Terminal tab's shells
//     and the Board drawer's task sessions with it). An orphan would keep the
//     Ground "Terminal" beacon lit forever, keep ownerDeskLimit notifying about
//     a desk with no window, and pin computeRestartSafety to safe:false —
//     silently stopping hands-free auto-update restarts. So the test asserts the
//     OBSERVABLE teardown: the DELETE actually went out on the wire AND the
//     localStorage binding is gone. Not "killEmbeddedTerminals was called".
//
// Each test uses its OWN project path: the sweep is once-per-path per module
// load (`sweptLegacyDocks`), so sharing a path would let a later test read a
// swept-clean store and pass vacuously.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { ProjectData, ProjectMeta } from '@/lib/types'
import { VIEW_KEY } from '@/lib/persistView'

// --- Mocks -----------------------------------------------------------------

// Identity translator: assert on i18n KEYS. The dock's title is
// t('projectPanel.dockOpen', { title }) — params are ignored by this stub, so
// the rendered title attribute is the bare key.
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))

vi.mock('@/lib/useClaudeConnection', () => ({
  useClaudeConnection: () => ({ installed: true, loggedIn: true }),
}))

// Stub the heavy render targets of the two views under test. Their testids are
// the POSITIVE control: if the view never mounted, the dock assertion would
// pass for the wrong reason.
vi.mock('@/components/canvas/modules/BoardModule', () => ({
  BoardModule: (props: { data: ProjectData }) => (
    <div data-testid="board">{props.data.tasks.length}</div>
  ),
}))
vi.mock('@/components/canvas/ProjectCanvas', () => ({
  ProjectCanvas: () => <div data-testid="project-canvas" />,
}))
vi.mock('@/components/canvas/CanvasWorkspace', () => ({
  CanvasWorkspace: () => <div data-testid="canvas-ws" />,
}))

// Every api-client path resolves benignly via a deep proxy; the project GET is
// steered per test.
const h = vi.hoisted(() => ({
  projectGet: null as null | ((...a: unknown[]) => Promise<Response>),
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
      apply: (_t, _this, args: unknown[]) =>
        path.join('.') === 'project.$get' && h.projectGet ? h.projectGet(...args) : benign(),
    })
  return { api: { api: deep([]) } }
})

import { ProjectPanel } from '@/components/canvas/ProjectPanel'

// --- Fixtures --------------------------------------------------------------

const project = (id: string, path: string): ProjectMeta => ({
  id,
  name: 'proj',
  path,
  description: '',
  lastModified: '2026-06-30T00:00:00Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
})

const VALID: ProjectData = {
  description: '',
  tasks: [],
  notes: '',
  updatedAt: '2026-06-30T00:00:00Z',
}

const noop = () => {}

/** Land the panel on `tab` by seeding the persisted view for THIS project —
 *  the same path a reload restore takes, so the first-tab-default effect
 *  honours it instead of yanking the view to the leftmost tab. */
const openOn = (p: ProjectMeta, tab: 'canvas' | 'board') => {
  localStorage.setItem(VIEW_KEY, JSON.stringify({ projectId: p.id, panelTab: tab }))
}

const renderPanel = (p: ProjectMeta) =>
  render(<ProjectPanel project={p} onClose={noop} onRemove={noop} frameLabel={null} />)

type Call = { url: string; method: string }
let calls: Call[] = []

beforeEach(() => {
  calls = []
  localStorage.clear()
  h.projectGet = () => Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 }))
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    }),
  )
})
afterEach(() => {
  h.projectGet = null
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('ProjectPanel — the Canvas/Board side terminal dock is gone', () => {
  it('the Canvas view renders no terminal dock', async () => {
    const p = project('uuid-canvas', '/tmp/proj-canvas-view')
    openOn(p, 'canvas')
    renderPanel(p)
    // Positive control: the Canvas view really did mount …
    expect(await screen.findByTestId('project-canvas')).toBeTruthy()
    // … and it carries neither the collapsed rail nor an expanded dock.
    expect(screen.queryByTitle('projectPanel.dockOpen')).toBeNull()
    expect(screen.queryByTitle('projectPanel.dockClose')).toBeNull()
  })

  it('the Board view renders no terminal dock', async () => {
    const p = project('uuid-board', '/tmp/proj-board-view')
    openOn(p, 'board')
    renderPanel(p)
    expect(await screen.findByTestId('board')).toBeTruthy()
    expect(screen.queryByTitle('projectPanel.dockOpen')).toBeNull()
    expect(screen.queryByTitle('projectPanel.dockClose')).toBeNull()
  })
})

describe('ProjectPanel — the removed docks leave no orphan PTY', () => {
  it('kills the stored canvas/board dock PTYs and drops their bindings', async () => {
    const p = project('uuid-sweep', '/tmp/proj-sweep')
    // What an in-place upgrade leaves behind: two dock PTYs still running
    // server-side plus the docks' open/tabs state.
    localStorage.setItem(`openground.embterm.${p.path}:canvas:1`, 'pty-77')
    localStorage.setItem(`openground.embterm.${p.path}:board:1`, 'pty-78')
    localStorage.setItem(
      `openground.dockterm.${p.path}:canvas`,
      JSON.stringify({ open: true, tabs: ['1'], activeId: '1' }),
    )
    // A custom tab's dock is namespaced by its module identity — it must survive.
    localStorage.setItem('openground.embterm.custom-module-abc:custom:1', 'pty-keep')
    openOn(p, 'board')

    renderPanel(p)
    await act(async () => {})

    const deletes = calls.filter(c => c.method === 'DELETE').map(c => c.url).sort()
    expect(deletes).toEqual(['/api/terminal/pty-77', '/api/terminal/pty-78'])
    expect(localStorage.getItem(`openground.embterm.${p.path}:canvas:1`)).toBeNull()
    expect(localStorage.getItem(`openground.embterm.${p.path}:board:1`)).toBeNull()
    expect(localStorage.getItem(`openground.dockterm.${p.path}:canvas`)).toBeNull()
    // The custom-tab dock is untouched — its surface still mounts one.
    expect(localStorage.getItem('openground.embterm.custom-module-abc:custom:1')).toBe('pty-keep')
  })

  it('sweeps by project PATH (the namespace the removed docks actually used)', async () => {
    // Both removed mounts passed no `storageId`, so EmbeddedClaudeTerminal fell
    // back to `sid = projectPath`. Sweeping by project.id would find nothing and
    // silently leave the PTY running — this pins the id choice.
    const p = project('uuid-namespace', '/tmp/proj-namespace')
    localStorage.setItem(`openground.embterm.${p.path}:canvas:1`, 'pty-99')
    // A decoy under the UUID namespace: nothing ever wrote here, and a sweep
    // aimed at project.id would clear this while leaving the real binding.
    localStorage.setItem(`openground.embterm.${p.id}:canvas:1`, 'pty-decoy')
    openOn(p, 'canvas')

    renderPanel(p)
    await act(async () => {})

    const deletes = calls.filter(c => c.method === 'DELETE').map(c => c.url)
    expect(deletes).toContain('/api/terminal/pty-99')
    expect(deletes).not.toContain('/api/terminal/pty-decoy')
    expect(localStorage.getItem(`openground.embterm.${p.path}:canvas:1`)).toBeNull()
  })
})
