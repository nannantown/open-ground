// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask } from '@/lib/types'

// Phase-following drawer contract (BoardModule):
//   Draft (no terminal slot)
//     - empty card → ONE capture textarea; blur derives title (first line,
//       titleAuto) + notes, and fires the auto-title request for multi-line text
//     - card with text → full fields (content grows), Launch bar at the bottom
//     - the conversation pane is NOT mounted at all
//   Session (slot exists)
//     - terminal pane mounts; fields collapse behind the one-line header
//     - status strip narrates branch / completion flow / PR
//     - chevron header expands the fields block
//   Title ownership
//     - first keystroke in the title field clears titleAuto (persisted), so an
//       in-flight auto-title can never land over hand-typed text

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
const taskTitlePost = vi.fn((_a?: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ title: null }) }),
)
vi.mock('@/lib/api-client', () => ({
  api: {
    api: {
      settings: { $get: () => Promise.resolve({ json: () => Promise.resolve({}) }) },
      project: { 'task-title': { $post: (a: unknown) => taskTitlePost(a) } },
    },
  },
}))

import { BoardModule } from './BoardModule'

const makeTask = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: 't1',
  title: 'Saved title',
  done: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  boardColumn: 'todo',
  ...over,
})

const makeData = (task: ProjectTask, config?: ProjectData['config']): ProjectData =>
  ({
    description: '',
    tasks: [task],
    notes: '',
    updatedAt: '',
    ...(config ? { config } : {}),
  }) as ProjectData

const project = { id: 'p1', name: 'proj', path: '/tmp/proj', hasGit: true } as ProjectMeta

const renderDrawer = (data: ProjectData, opts: { session?: boolean } = {}) => {
  const onOpenDetail = vi.fn()
  const persist = vi.fn()
  const onLaunchTask = vi.fn()
  const utils = render(
    <BoardModule
      data={data}
      project={project}
      persist={persist}
      detailId="t1"
      onOpenDetail={onOpenDetail}
      renderConversation={() => <div data-testid="conversation" />}
      hasTerminalSlot={() => opts.session ?? false}
      onDeleteTask={vi.fn()}
      onLaunchTask={onLaunchTask}
    />,
  )
  return { ...utils, onOpenDetail, persist, onLaunchTask }
}

beforeEach(() => {
  localStorage.clear()
  taskTitlePost.mockClear()
})
afterEach(cleanup)

describe('BoardModule drawer — Draft mode', () => {
  it('empty card: single capture box, no conversation pane, Launch bar present', () => {
    const { container, queryByTestId, getByText } = renderDrawer(makeData(makeTask({ title: '' })))
    expect(
      container.querySelector('textarea[placeholder="board.detail.capturePlaceholder"]'),
    ).toBeTruthy()
    // No title/content fields yet, no terminal.
    expect(container.querySelector('input[placeholder="board.detail.titlePlaceholder"]')).toBeNull()
    expect(queryByTestId('conversation')).toBeNull()
    expect(getByText('projectPanel.launchClaude')).toBeTruthy()
  })

  it('capture blur derives first-line title + notes (titleAuto) and requests an auto-title', () => {
    const { container, persist } = renderDrawer(makeData(makeTask({ title: '' })))
    const box = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="board.detail.capturePlaceholder"]',
    )!
    fireEvent.change(box, { target: { value: 'Account settings page\nUse the modal.\nAdd email.' } })
    fireEvent.blur(box)
    expect(persist).toHaveBeenCalledTimes(1)
    const saved = persist.mock.calls[0][0] as ProjectData
    expect(saved.tasks[0]).toMatchObject({
      title: 'Account settings page',
      notes: 'Use the modal.\nAdd email.',
      titleAuto: true,
    })
    expect(taskTitlePost).toHaveBeenCalledWith({ json: { path: '/tmp/proj', id: 't1' } })
  })

  it('single short line: title only, NO auto-title request (it already is the title)', () => {
    const { container, persist } = renderDrawer(makeData(makeTask({ title: '' })))
    const box = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="board.detail.capturePlaceholder"]',
    )!
    fireEvent.change(box, { target: { value: 'Fix the login flow' } })
    fireEvent.blur(box)
    const saved = persist.mock.calls[0][0] as ProjectData
    expect(saved.tasks[0]).toMatchObject({ title: 'Fix the login flow', titleAuto: true })
    expect(saved.tasks[0].notes).toBeUndefined()
    expect(taskTitlePost).not.toHaveBeenCalled()
  })

  it('titled card: full fields visible, conversation still not mounted, Launch wired', () => {
    const { container, queryByTestId, getByText, onLaunchTask } = renderDrawer(
      makeData(makeTask()),
    )
    expect(
      container.querySelector('input[placeholder="board.detail.titlePlaceholder"]'),
    ).toBeTruthy()
    expect(queryByTestId('conversation')).toBeNull()
    fireEvent.click(getByText('projectPanel.launchClaude'))
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
    expect((onLaunchTask.mock.calls[0][0] as ProjectTask).id).toBe('t1')
  })

  it('first keystroke in the title field clears titleAuto', () => {
    const { container, persist } = renderDrawer(makeData(makeTask({ titleAuto: true })))
    const title = container.querySelector<HTMLInputElement>(
      'input[placeholder="board.detail.titlePlaceholder"]',
    )!
    fireEvent.change(title, { target: { value: 'Saved titleX' } })
    expect(persist).toHaveBeenCalledTimes(1)
    const saved = persist.mock.calls[0][0] as ProjectData
    expect(saved.tasks[0].titleAuto).toBeUndefined()
    expect(saved.tasks[0].title).toBe('Saved title') // title itself commits on blur
  })
})

describe('BoardModule drawer — Session mode', () => {
  it('terminal owns the drawer: conversation mounts, fields collapsed behind the header', () => {
    const { container, getByTestId, getByTitle } = renderDrawer(makeData(makeTask()), {
      session: true,
    })
    expect(getByTestId('conversation')).toBeTruthy()
    // Compact header line (the board card also shows the title — query the
    // toggle button specifically).
    expect(getByTitle('board.detail.fieldsToggle').textContent).toContain('Saved title')
    expect(container.querySelector('input[placeholder="board.detail.titlePlaceholder"]')).toBeNull()
    // No Draft launch bar in session mode.
    expect(container.textContent).not.toContain('projectPanel.launchClaude')
  })

  it('chevron header expands the fields block (and the split grip appears)', () => {
    const { container, getByTitle } = renderDrawer(makeData(makeTask()), { session: true })
    fireEvent.click(getByTitle('board.detail.fieldsToggle'))
    expect(
      container.querySelector('input[placeholder="board.detail.titlePlaceholder"]'),
    ).toBeTruthy()
    expect(
      container.querySelector('[aria-label="board.detail.resizeSplit"]'),
    ).toBeTruthy()
  })

  it('status strip narrates branch, completion flow and PR', () => {
    const { container, getByText } = renderDrawer(
      makeData(
        makeTask({ branch: 'task/u2-105-account', prUrl: 'https://github.com/o/r/pull/42' }),
        { completionFlow: 'pr', targetBranch: 'main' },
      ),
      { session: true },
    )
    expect(getByText('task/u2-105-account')).toBeTruthy()
    expect(getByText('board.detail.flowPr')).toBeTruthy()
    const pr = container.querySelector('a[href="https://github.com/o/r/pull/42"]')
    expect(pr).toBeTruthy()
  })

  it('Draft launch bar shows the flow note too (merge flow on a git project)', () => {
    const { getByText } = renderDrawer(makeData(makeTask(), { targetBranch: 'develop' }))
    expect(getByText(/board\.detail\.flowMerge/)).toBeTruthy()
  })
})
