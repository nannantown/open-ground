// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData, ProjectMeta } from '@/lib/types'
import { ProjectPanel } from './ProjectPanel'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k, lang: 'en' }) }))
vi.mock('@/lib/useClaudeConnection', () => ({ useClaudeConnection: () => ({ installed: true, loggedIn: true }) }))
vi.mock('@/components/canvas/modules/BoardModule', () => ({ BoardModule: () => <div>Loaded board</div> }))
const h = vi.hoisted(() => ({ get: vi.fn(), describe: vi.fn() }))
vi.mock('@/lib/api-client', () => {
  const deep = (path: string[]): unknown => new Proxy(() => {}, {
    get: (_t, p) => p === 'then' ? undefined : deep([...path, String(p)]),
    apply: () => path.join('.') === 'project.$get' ? h.get()
      : path.join('.') === 'project.describe.$post' ? h.describe()
      : Promise.resolve(new Response('{}')),
  })
  return { api: { api: deep([]) } }
})

const initial: ProjectData = { description: '', tasks: [], notes: '', updatedAt: '2026-09-21T00:00:00.000Z' }
const generated: ProjectData = { ...initial, description: 'Generated project summary', descriptionEn: 'Generated project summary', updatedAt: '2026-09-21T00:00:01.000Z' }
const project: ProjectMeta = { id: 'desc', path: '/tmp/desc', name: 'Description fixture', description: '', lastModified: '', hasGit: false, openTaskCount: 0, totalTaskCount: 0 }
const response = (d: unknown) => new Response(JSON.stringify(d))
// The ⋯ menu closes on every pick, so each lookup reopens it.
const menuItem = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'projectPanel.moreActions' }))
  return screen.queryByRole('button', { name })
}
const closeMenu = () => fireEvent.mouseDown(document.body)

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  h.get.mockReset().mockImplementation(async () => response(initial))
  h.describe.mockReset().mockResolvedValue(response({ jobId: 'job' }))
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/describe/active')) return response({ jobs: [] })
    if (url.includes('/describe/job/job')) return response({ status: 'done' })
    if (url.includes('/branch-changes')) return response({ isGit: true, branch: 'main', working: [] })
    if (url.includes('/active-branches')) return response({ isGit: true, branches: [{ name: 'main', current: true }] })
    if (url.includes('/project/editors')) return response({ editors: [{ name: 'Fixture Editor' }], default: null, canPick: false })
    return response({})
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('project header (owner 2026-10-02: the title opens nothing)', () => {
  it('shows the name as plain text with folder / editor / branch beside it, and no details dialog', async () => {
    await act(async () => { render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />) })
    const header = screen.getByTestId('project-header')
    const name = within(header).getByText(project.name)
    expect(name.closest('button')).toBeNull()
    fireEvent.click(name)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(header).getByRole('button', { name: 'projectPanel.revealFolder' })).toBeTruthy()
    fireEvent.click(within(header).getByRole('button', { name: 'projectPanel.openInEditor' }))
    expect(screen.getByRole('menuitem', { name: 'Fixture Editor' })).toBeTruthy()
    closeMenu()
    fireEvent.click(within(header).getByRole('button', { name: 'projectPanel.branchMenuTitle' }))
    expect(screen.getByRole('menuitem', { name: 'projectPanel.branchChangesTitle' })).toBeTruthy()
  })

  it('lists folder / editor / branch in the ⋯ menu too (the only place they fit on a phone)', async () => {
    await act(async () => { render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />) })
    fireEvent.click(screen.getByRole('button', { name: 'projectPanel.moreActions' }))
    expect(screen.getAllByRole('button', { name: 'projectPanel.revealFolder' })).toHaveLength(2)
    // The ⋯ entries open the SAME chooser / branch list as the inline controls.
    // The menu is portaled after the header, so its entry is the last match.
    fireEvent.click(screen.getAllByRole('button', { name: 'projectPanel.openInEditor' }).at(-1)!)
    expect(screen.getByRole('menuitem', { name: 'Fixture Editor' })).toBeTruthy()
    closeMenu()
    fireEvent.click(screen.getByRole('button', { name: 'projectPanel.moreActions' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'projectPanel.branchMenuTitle' }).at(-1)!)
    expect(screen.getByRole('menuitem', { name: 'projectPanel.branchChangesTitle' })).toBeTruthy()
  })

  it('Escape closes only an open editor / branch / ⋯ menu, never the project', async () => {
    const close = vi.fn()
    const appEscape = vi.fn((e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close() })
    window.addEventListener('keydown', appEscape)
    try {
      await act(async () => { render(<ProjectPanel project={project} onClose={close} onRemove={() => {}} frameLabel={null} />) })
      const header = screen.getByTestId('project-header')
      for (const trigger of ['projectPanel.openInEditor', 'projectPanel.branchMenuTitle']) {
        fireEvent.click(within(header).getByRole('button', { name: trigger }))
        expect(screen.getByRole('menu')).toBeTruthy()
        fireEvent.keyDown(document.body, { key: 'Escape' })
        expect(screen.queryByRole('menu')).toBeNull()
      }
      menuItem('projectPanel.renameProjectMenu')
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.queryByRole('button', { name: 'projectPanel.renameProjectMenu' })).toBeNull()
      expect(appEscape).toHaveBeenCalledTimes(0)
      expect(close).not.toHaveBeenCalled()
    } finally { window.removeEventListener('keydown', appEscape) }
  })

  it('puts the description under the name in its hover tooltip', async () => {
    h.get.mockImplementation(async () => response(generated))
    await act(async () => { render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />) })
    expect(within(screen.getByTestId('project-header')).getByText(project.name).getAttribute('title'))
      .toBe(`${project.name}\n${generated.description}`)
  })

  it('renames from the ⋯ menu through an input in the header', async () => {
    const rename = vi.fn(async () => undefined)
    await act(async () => { render(<ProjectPanel project={project} onRename={rename} onClose={() => {}} onRemove={() => {}} frameLabel={null} />) })
    fireEvent.click(menuItem('projectPanel.renameProjectMenu')!)
    const input = within(screen.getByTestId('project-header')).getByDisplayValue(project.name)
    fireEvent.change(input, { target: { value: 'Renamed' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(rename).toHaveBeenCalledWith(project, 'Renamed')
  })

  it('moves skills into the ⋯ menu for the owner only', async () => {
    const view = await act(async () => render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />))
    expect(menuItem('projectPanel.skillsButton')).toBeNull()
    closeMenu()
    view.rerender(<ProjectPanel project={project} ownerFeatures onClose={() => {}} onRemove={() => {}} frameLabel={null} />)
    fireEvent.click(menuItem('projectPanel.skillsButton')!)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('description response ordering', () => {
  it('keeps the description out of the workspace bar and offers refresh in the ⋯ menu', async () => {
    h.get.mockImplementation(async () => response(generated))
    await act(async () => { render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />) })
    expect(screen.queryByText(generated.description)).toBeNull()
    const header = screen.getByTestId('project-header')
    expect(within(header).getByRole('button', { name: 'Board' })).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'misc.usage.heading' })).toBeTruthy()
    expect(menuItem('projectPanel.regenerateDescription')).toBeTruthy()
    expect(h.describe).not.toHaveBeenCalled()
  })
  it('does not erase a newly generated description when an older board poll finishes late', async () => {
    await act(async () => { render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />) })
    let finishOld!: (r: Response) => void
    h.get.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(finishOld).toBeTypeOf('function')
    h.get.mockImplementation(async () => response(generated))
    const generate = menuItem('projectPanel.generateDescription')!
    await act(async () => { fireEvent.click(generate) })
    expect(menuItem('projectPanel.regenerateDescription')).toBeTruthy()
    closeMenu()
    await act(async () => { finishOld(response(initial)) })
    expect(menuItem('projectPanel.regenerateDescription')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'projectPanel.generateDescription' })).toBeNull()
  })

  it('ignores a delayed job refresh when the normal poll already adopted a newer description', async () => {
    await act(async () => { render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />) })
    let finishJobRead!: (r: Response) => void
    h.get.mockImplementationOnce(() => new Promise<Response>(resolve => { finishJobRead = resolve }))
    const generate = menuItem('projectPanel.generateDescription')!
    await act(async () => { fireEvent.click(generate) })
    expect(finishJobRead).toBeTypeOf('function')
    h.get.mockImplementation(async () => response(generated))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    // Still generating (the job read hangs) — the menu item offers to stop.
    expect(menuItem('projectPanel.cancelDescription')).toBeTruthy()
    closeMenu()
    await act(async () => { finishJobRead(response(initial)) })
    expect(menuItem('projectPanel.regenerateDescription')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'projectPanel.generateDescription' })).toBeNull()
  })
})
