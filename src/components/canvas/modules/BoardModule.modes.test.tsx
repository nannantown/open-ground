// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask } from '@/lib/types'

// Phase-following drawer contract (BoardModule):
//   Draft (no terminal slot)
//     - empty card → ONE capture textarea; blur derives title (first line,
//       titleAuto) + notes, and fires the auto-title request for multi-line text
//     - card with text → full fields (content grows); claude AUTO-LAUNCHES
//       (plain, no prompt sent) — there is no Launch button anymore
//     - an untitled card / a done-column card / a missing project never
//       auto-launches
//     - the conversation pane is NOT mounted at all
//   Session (slot exists)
//     - terminal pane mounts; fields collapse behind the one-line header
//     - status strip narrates branch / completion flow / PR
//     - "Insert task into input" pastes the task into the live PTY unsent
//       (POST /api/terminal/:id/paste-task); disabled without a live PTY
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

const baseProject = { id: 'p1', name: 'proj', path: '/tmp/proj', hasGit: true } as ProjectMeta

const renderDrawer = (
  data: ProjectData,
  opts: { session?: boolean; ptyId?: string | null; missing?: boolean } = {},
) => {
  const onOpenDetail = vi.fn()
  const persist = vi.fn()
  // Resolves true = launch succeeded (the real ProjectPanel contract). A bare
  // vi.fn() returns undefined, which the auto-launch effect would read as a
  // FAILED launch and flip the footer to the retry CTA.
  const onLaunchTask = vi.fn(async (_t: ProjectTask) => true)
  const project = opts.missing ? ({ ...baseProject, missing: true } as ProjectMeta) : baseProject
  const utils = render(
    <BoardModule
      data={data}
      project={project}
      persist={persist}
      detailId="t1"
      onOpenDetail={onOpenDetail}
      renderConversation={() => <div data-testid="conversation" />}
      hasTerminalSlot={() => opts.session ?? false}
      liveTerminalId={() => opts.ptyId ?? null}
      onDeleteTask={vi.fn()}
      onLaunchTask={onLaunchTask}
    />,
  )
  return { ...utils, onOpenDetail, persist, onLaunchTask }
}

// Flush the auto-launch effect's async tail (launchDetail awaits onLaunchTask
// and clears `launching` in a microtask) so React state settles inside act.
const flush = () => act(async () => {})

const fetchMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
)

beforeEach(() => {
  localStorage.clear()
  taskTitlePost.mockClear()
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BoardModule drawer — Draft mode', () => {
  it('empty card: single capture box, no conversation pane, no Launch button, NO auto-launch', async () => {
    const { container, queryByTestId, onLaunchTask } = renderDrawer(
      makeData(makeTask({ title: '' })),
    )
    await flush()
    expect(
      container.querySelector('textarea[placeholder="board.detail.capturePlaceholder"]'),
    ).toBeTruthy()
    // No title/content fields yet, no terminal, no launch affordance.
    expect(container.querySelector('input[placeholder="board.detail.titlePlaceholder"]')).toBeNull()
    expect(queryByTestId('conversation')).toBeNull()
    expect(container.textContent).not.toContain('projectPanel.launchClaude')
    // A just-created untitled card must NOT auto-launch — claude starts only
    // once a title exists.
    expect(onLaunchTask).not.toHaveBeenCalled()
  })

  it('capture blur derives first-line title + notes (titleAuto) and requests an auto-title', async () => {
    const { container, persist } = renderDrawer(makeData(makeTask({ title: '' })))
    await flush()
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

  it('single short line: title only, NO auto-title request (it already is the title)', async () => {
    const { container, persist } = renderDrawer(makeData(makeTask({ title: '' })))
    await flush()
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

  it('titled card: full fields visible, no Launch button, claude AUTO-LAUNCHES once', async () => {
    const { container, queryByTestId, onLaunchTask } = renderDrawer(makeData(makeTask()))
    await flush()
    expect(
      container.querySelector('input[placeholder="board.detail.titlePlaceholder"]'),
    ).toBeTruthy()
    expect(queryByTestId('conversation')).toBeNull()
    expect(container.textContent).not.toContain('projectPanel.launchClaude')
    // Auto-launch fired exactly once for the titled card.
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
    expect((onLaunchTask.mock.calls[0][0] as ProjectTask).id).toBe('t1')
    await flush()
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
  })

  it('done-column card never auto-launches and shows the done note (not a launch promise)', async () => {
    const { onLaunchTask, getByText, container } = renderDrawer(
      makeData(makeTask({ boardColumn: 'done', done: true })),
    )
    await flush()
    expect(onLaunchTask).not.toHaveBeenCalled()
    expect(getByText(/board\.detail\.autoLaunchDone/)).toBeTruthy()
    expect(container.textContent).not.toContain('board.detail.autoLaunchHint')
  })

  it('missing project never auto-launches and shows the missing note', async () => {
    const { onLaunchTask, getByText, container } = renderDrawer(
      makeData(makeTask()),
      { missing: true },
    )
    await flush()
    expect(onLaunchTask).not.toHaveBeenCalled()
    expect(getByText(/board\.detail\.autoLaunchMissing/)).toBeTruthy()
    expect(container.textContent).not.toContain('board.detail.autoLaunchHint')
  })

  it('a failed auto-launch shows a retry CTA, and retry re-invokes the launch', async () => {
    const onOpenDetail = vi.fn()
    const persist = vi.fn()
    // First launch fails (resolves false), retry succeeds.
    const onLaunchTask = vi
      .fn(async (_t: ProjectTask) => true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const { getByText, queryByText } = render(
      <BoardModule
        data={makeData(makeTask())}
        project={baseProject}
        persist={persist}
        detailId="t1"
        onOpenDetail={onOpenDetail}
        renderConversation={() => <div data-testid="conversation" />}
        hasTerminalSlot={() => false}
        liveTerminalId={() => null}
        onDeleteTask={vi.fn()}
        onLaunchTask={onLaunchTask}
      />,
    )
    await flush()
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
    // Failure surfaces a retry CTA, not the "will auto-launch" promise.
    const retry = getByText('board.detail.autoLaunchRetry')
    expect(queryByText(/board\.detail\.autoLaunchHint/)).toBeNull()
    fireEvent.click(retry)
    await flush()
    expect(onLaunchTask).toHaveBeenCalledTimes(2)
  })

  it('first keystroke in the title field clears titleAuto', async () => {
    const { container, persist } = renderDrawer(makeData(makeTask({ titleAuto: true })))
    await flush()
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
  it('terminal owns the drawer: conversation mounts, fields collapsed behind the header', async () => {
    const { container, getByTestId, getByTitle } = renderDrawer(makeData(makeTask()), {
      session: true,
    })
    await flush()
    expect(getByTestId('conversation')).toBeTruthy()
    // Compact header line (the board card also shows the title — query the
    // toggle button specifically).
    expect(getByTitle('board.detail.fieldsToggle').textContent).toContain('Saved title')
    expect(container.querySelector('input[placeholder="board.detail.titlePlaceholder"]')).toBeNull()
    // No launch button in session mode either.
    expect(container.textContent).not.toContain('projectPanel.launchClaude')
  })

  it('chevron header expands the fields block (and the split grip appears)', async () => {
    const { container, getByTitle } = renderDrawer(makeData(makeTask()), { session: true })
    await flush()
    fireEvent.click(getByTitle('board.detail.fieldsToggle'))
    expect(
      container.querySelector('input[placeholder="board.detail.titlePlaceholder"]'),
    ).toBeTruthy()
    expect(
      container.querySelector('[aria-label="board.detail.resizeSplit"]'),
    ).toBeTruthy()
  })

  it('status strip narrates branch, completion flow and PR', async () => {
    const { container, getByText } = renderDrawer(
      makeData(
        makeTask({ branch: 'task/u2-105-account', prUrl: 'https://github.com/o/r/pull/42' }),
        { completionFlow: 'pr', targetBranch: 'main' },
      ),
      { session: true },
    )
    await flush()
    expect(getByText('task/u2-105-account')).toBeTruthy()
    expect(getByText('board.detail.flowPr')).toBeTruthy()
    const pr = container.querySelector('a[href="https://github.com/o/r/pull/42"]')
    expect(pr).toBeTruthy()
  })

  it('"Insert task into input" posts paste-task to the live PTY (unsent paste)', async () => {
    const { getByText } = renderDrawer(makeData(makeTask()), {
      session: true,
      ptyId: 'pty-9',
    })
    await flush()
    const btn = getByText('board.detail.insertTask') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The body now carries the LIVE title/notes so the server pastes what's on
    // screen, not a debounced/stale disk copy.
    expect(fetchMock).toHaveBeenCalledWith('/api/terminal/pty-9/paste-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/tmp/proj',
        taskId: 't1',
        title: 'Saved title',
        notes: '',
      }),
    })
    await flush()
  })

  it('"Insert task into input" is disabled without a live PTY (exited session)', async () => {
    const { getByText } = renderDrawer(makeData(makeTask()), {
      session: true,
      ptyId: null,
    })
    await flush()
    const btn = getByText('board.detail.insertTask') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Draft auto-launch note shows the flow text too (merge flow on a git project)', async () => {
    const { getByText } = renderDrawer(makeData(makeTask(), { targetBranch: 'develop' }))
    await flush()
    expect(getByText(/board\.detail\.autoLaunchHint/)).toBeTruthy()
    expect(getByText(/board\.detail\.flowMerge/)).toBeTruthy()
  })
})
