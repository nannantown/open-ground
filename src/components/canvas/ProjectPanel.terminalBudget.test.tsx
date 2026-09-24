// @vitest-environment jsdom
//
// 差し戻し 2026-09-24 (2回目, must-fix): a Terminal layout SAVED under the old
// cap of six panes. MAX_TERMINALS (= the stream budget, 5) only gated adding a
// pane; loading returned all six, so opening the Terminal tab opened six SSE
// streams — every connection Chromium gives the origin — and every request,
// the panes' own input included, waited forever.
//
// Expected: at most STREAM_BUDGET panes stream; the rest stay in the layout
// with their shells untouched (whatever runs there is the owner's work) and
// say why; closing a streaming pane brings the next one back live.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import type { ProjectData, ProjectMeta } from '@/lib/types'
import { VIEW_KEY } from '@/lib/persistView'
import { STREAM_BUDGET, streamCount } from '@/lib/streamBudget'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))
vi.mock('@/lib/useClaudeConnection', () => ({
  useClaudeConnection: () => ({ installed: true, loggedIn: true }),
}))
vi.mock('@/components/canvas/modules/BoardModule', () => ({
  BoardModule: () => <div data-testid="board" />,
}))
// The real pane opens its stream via xterm, which cannot run in jsdom. The
// stub does exactly what the real one does about the budget: hold a PAGE slot
// for as long as it is mounted (TerminalPane.tsx, around its `new EventSource`).
vi.mock('@/components/canvas/TerminalPane', async () => {
  const React = await import('react')
  const { holdStream } = await import('@/lib/streamBudget')
  const TerminalPane = React.forwardRef(function TerminalPane(props: { slotKey?: string }, _ref) {
    React.useEffect(() => holdStream('page'), [])
    return <div data-testid="terminal-pane" data-slot={props.slotKey} />
  })
  return { TerminalPane }
})

const h = vi.hoisted(() => ({ deletes: [] as string[] }))
vi.mock('@/lib/api-client', () => {
  const VALID = { description: '', tasks: [], notes: '', updatedAt: '2026-06-30T00:00:00Z' }
  const ok = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
  const deep = (path: string[]): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, prop) => (prop === 'then' ? undefined : deep([...path, String(prop)])),
      apply: (_t, _this, args: unknown[]) => {
        const p = path.join('.')
        if (p.endsWith('$delete')) h.deletes.push(JSON.stringify(args[0]))
        return p === 'project.$get' ? ok(VALID) : ok({})
      },
    })
  return { api: { api: deep([]) } }
})

import { ProjectPanel } from '@/components/canvas/ProjectPanel'

const project: ProjectMeta = {
  id: 'p-six',
  name: 'six',
  path: '/tmp/p-six',
  description: '',
  lastModified: '2026-06-30T00:00:00Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
} as ProjectMeta
void ({} as ProjectData)

const SIX = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `slot-${n}`, label: `Terminal ${n}` }))

beforeEach(() => {
  localStorage.clear()
  h.deletes = []
  localStorage.setItem(VIEW_KEY, JSON.stringify({ projectId: project.id, panelTab: 'terminal' }))
  localStorage.setItem(`openground.terminal.slots.${project.path}`, JSON.stringify(SIX))
  // Each saved pane is bound to a live shell.
  for (const s of SIX) localStorage.setItem(`openground.terminal.session.${project.path}.${s.id}`, `pty-${s.id}`)
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))))
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('a Terminal layout saved with six panes', () => {
  it('streams at most STREAM_BUDGET panes; the sixth waits, its shell untouched', async () => {
    render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />)
    await screen.findAllByTestId('terminal-pane')
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(STREAM_BUDGET)
    expect(streamCount('page')).toBeLessThanOrEqual(STREAM_BUDGET)
    // The sixth pane is still in the layout, says why, and its shell was not killed.
    expect(document.querySelector('[data-terminal-over-budget="slot-6"]')).toBeTruthy()
    expect(h.deletes).toEqual([])
    expect(localStorage.getItem(`openground.terminal.session.${project.path}.slot-6`)).toBe('pty-slot-6')
  })

  it('closing a streaming pane brings the waiting one back live', async () => {
    render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />)
    await screen.findAllByTestId('terminal-pane')
    const close = screen.getAllByRole('button', { name: 'projectPanel.closeTerminal' })[0]
    await act(async () => {
      fireEvent.click(close)
    })
    const live = screen.getAllByTestId('terminal-pane').map((e) => e.getAttribute('data-slot'))
    expect(live).toContain('slot-6')
    expect(live).toHaveLength(STREAM_BUDGET)
    expect(streamCount('page')).toBeLessThanOrEqual(STREAM_BUDGET)
  })
})
