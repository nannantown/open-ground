// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask } from '@/lib/types'

// Phase-following drawer contract (BoardModule):
//   Draft (no terminal slot)
//     - empty card → ONE capture textarea; blur derives title (first line,
//       titleAuto) + notes, and fires the auto-title request for multi-line text
//     - card with text → full fields (content grows) + the run footer: the
//       per-card run settings (flow / model / effort, autosaved on the task)
//       and an explicit 実行 button. NOTHING launches by itself (the drawer
//       auto-launch died 2026-06-12) — 実行 calls onLaunchTask with the run
//       payload (live fields + overrides) and the server auto-starts the task
//     - an untitled card disables 実行; a missing project hides the footer
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
      project: {
        'task-title': { $post: (a: unknown) => taskTitlePost(a) },
        // PR-state chip (B023): the drawer asks once per open; answering
        // available:false keeps the strip exactly as these tests expect.
        'pr-info': {
          $post: () =>
            Promise.resolve({ json: () => Promise.resolve({ available: false }) }),
        },
      },
    },
  },
}))

import { BoardModule, type TaskLaunchResult } from './BoardModule'

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
  // Resolves { ok: true } = launch succeeded (the real ProjectPanel contract).
  // A bare vi.fn() returns undefined, which runTask would read as a FAILED
  // launch and flip the footer to the failure copy.
  const onLaunchTask = vi.fn(
    async (_t: ProjectTask, _opts?: { cwd?: string; run?: Record<string, unknown> }) => ({
      ok: true,
    }),
  )
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
  it('empty card: single capture box, no conversation pane, 実行 disabled, NO launch', async () => {
    const { container, queryByTestId, onLaunchTask, getByText } = renderDrawer(
      makeData(makeTask({ title: '' })),
    )
    await flush()
    expect(
      container.querySelector('textarea[placeholder="board.detail.capturePlaceholder"]'),
    ).toBeTruthy()
    // No title/content fields yet, no terminal.
    expect(container.querySelector('input[placeholder="board.detail.titlePlaceholder"]')).toBeNull()
    expect(queryByTestId('conversation')).toBeNull()
    // The run footer is there but inert: an untitled card can't run, and
    // nothing ever launches without the explicit click.
    expect((getByText('board.run.button') as HTMLButtonElement).disabled).toBe(true)
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

  it('titled card: full fields + run footer; NOTHING launches without the click', async () => {
    const { container, queryByTestId, onLaunchTask, getByText } = renderDrawer(
      makeData(makeTask()),
    )
    await flush()
    expect(
      container.querySelector('input[placeholder="board.detail.titlePlaceholder"]'),
    ).toBeTruthy()
    expect(queryByTestId('conversation')).toBeNull()
    // The old auto-launch is gone: opening the drawer spawns nothing.
    expect(onLaunchTask).not.toHaveBeenCalled()
    expect((getByText('board.run.button') as HTMLButtonElement).disabled).toBe(false)
    expect(getByText(/board\.run\.hint/)).toBeTruthy()
  })

  it('実行 launches with the run payload (live fields + per-card overrides)', async () => {
    const task = makeTask({
      notes: 'Do the thing',
      run: { flow: 'pr', model: 'fable', effort: 'xhigh' },
    })
    const { getByText, onLaunchTask } = renderDrawer(makeData(task))
    await flush()
    fireEvent.click(getByText('board.run.button'))
    await flush()
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
    const [calledTask, opts] = onLaunchTask.mock.calls[0]
    expect(calledTask.id).toBe('t1')
    expect(opts?.run).toEqual({
      title: 'Saved title',
      notes: 'Do the thing',
      attachmentIds: [],
      flow: 'pr',
      model: 'fable',
      effort: 'xhigh',
    })
  })

  it('changing a run setting persists it on the task (autosave)', async () => {
    const { container, persist } = renderDrawer(makeData(makeTask()))
    await flush()
    // Scope to the drawer — the board's own defaults strip has selects too.
    const selects = Array.from(container.querySelector('aside')!.querySelectorAll('select'))
    // git project → [flow, model, effort]; pick the effort select (last).
    const effort = selects[selects.length - 1] as HTMLSelectElement
    fireEvent.change(effort, { target: { value: 'max' } })
    expect(persist).toHaveBeenCalledTimes(1)
    const saved = persist.mock.calls[0][0] as ProjectData
    expect(saved.tasks[0].run).toEqual({ effort: 'max' })
  })

  it('done-column card: the run footer still renders (running again is explicit)', async () => {
    const { onLaunchTask, getByText } = renderDrawer(
      makeData(makeTask({ boardColumn: 'done', done: true })),
    )
    await flush()
    expect(onLaunchTask).not.toHaveBeenCalled()
    expect((getByText('board.run.button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('missing project: no run button, the missing note explains why', async () => {
    const { onLaunchTask, getByText, container } = renderDrawer(
      makeData(makeTask()),
      { missing: true },
    )
    await flush()
    expect(onLaunchTask).not.toHaveBeenCalled()
    expect(getByText(/board\.run\.missingFolder/)).toBeTruthy()
    expect(container.textContent).not.toContain('board.run.button')
  })

  it('a failed run shows the failure copy, and 実行 again retries', async () => {
    const onOpenDetail = vi.fn()
    const persist = vi.fn()
    // First launch fails (resolves { ok: false }), retry succeeds.
    const onLaunchTask = vi
      .fn(async (_t: ProjectTask): Promise<TaskLaunchResult> => ({ ok: true }))
      .mockResolvedValueOnce({ ok: false, reason: 'claudeMissing' })
      .mockResolvedValueOnce({ ok: true })
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
    expect(onLaunchTask).not.toHaveBeenCalled()
    fireEvent.click(getByText('board.run.button'))
    await flush()
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
    // Reason-specific copy (claudeMissing → install guidance).
    expect(getByText(/board\.run\.failedClaudeMissing/)).toBeTruthy()
    fireEvent.click(getByText('board.run.button'))
    await flush()
    expect(onLaunchTask).toHaveBeenCalledTimes(2)
    // A successful retry clears the failure copy.
    expect(queryByText(/board\.run\.failedClaudeMissing/)).toBeNull()
  })

  it('review card: no silent spawn — 実行 is the deliberate start (F031 holds)', async () => {
    const { getByText, onLaunchTask } = renderDrawer(
      makeData(makeTask({ boardColumn: 'review' })),
    )
    await flush()
    // Opening a review card is READING — never a silent spawn (F031).
    expect(onLaunchTask).not.toHaveBeenCalled()
    fireEvent.click(getByText('board.run.button'))
    await flush()
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
    expect((onLaunchTask.mock.calls[0][0] as ProjectTask).id).toBe('t1')
  })

  it('blocked card with a branch: the footer ALSO offers "Review with claude"', async () => {
    const { getByText, onLaunchTask } = renderDrawer(
      makeData(makeTask({ boardColumn: 'blocked', branch: 'task/x' })),
    )
    await flush()
    expect(onLaunchTask).not.toHaveBeenCalled()
    expect(getByText('board.detail.reviewWithClaude')).toBeTruthy()
    expect(getByText('board.run.button')).toBeTruthy()
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
        // Live attachment ids ride along (B022) — empty card, empty list.
        attachmentIds: [],
      }),
    })
    await flush()
  })

  it('restart failure (dead session) shows the run failure copy — never a raw i18n key', async () => {
    const onLaunchTask = vi
      .fn(
        async (
          _t: ProjectTask,
          _opts?: { cwd?: string; run?: Record<string, unknown> },
        ): Promise<TaskLaunchResult> => ({ ok: true }),
      )
      .mockResolvedValueOnce({ ok: false, reason: 'claudeMissing' })
    const { getByText, container } = render(
      <BoardModule
        data={makeData(makeTask())}
        project={baseProject}
        persist={vi.fn()}
        detailId="t1"
        onOpenDetail={vi.fn()}
        renderConversation={() => <div data-testid="conversation" />}
        hasTerminalSlot={() => true}
        liveTerminalId={() => null}
        onDeleteTask={vi.fn()}
        onLaunchTask={onLaunchTask}
      />,
    )
    await flush()
    fireEvent.click(getByText('board.detail.restartSession'))
    await flush()
    // The failure hint maps to the NEW board.run.* keys (the old
    // board.detail.autoLaunch* keys were deleted with the auto-launch).
    expect(getByText(/board\.run\.failedClaudeMissing/)).toBeTruthy()
    expect(container.textContent).not.toContain('board.detail.autoLaunch')
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

  it('Draft run hint shows the flow text too (merge flow on a git project)', async () => {
    const { getByText } = renderDrawer(makeData(makeTask(), { targetBranch: 'develop' }))
    await flush()
    expect(getByText(/board\.run\.hint/)).toBeTruthy()
    expect(getByText(/board\.detail\.flowMerge/)).toBeTruthy()
  })

  it("a card's run.flow override drives the flow text (PR wins over the merge default)", async () => {
    const { getByText } = renderDrawer(
      makeData(makeTask({ run: { flow: 'pr' } }), { targetBranch: 'main' }),
    )
    await flush()
    expect(getByText(/board\.detail\.flowPr/)).toBeTruthy()
  })
})

// ─── Undo / redo (B013) ──────────────────────────────────────────────────────
// History lives in BoardModule (the data+persist layer): local persists are
// coalesced snapshots, ⌘Z restores the previous tasks array THROUGH persist
// (so the undo itself syncs), Shift+⌘Z redoes, focused text fields keep the
// combo, and external tasks replacements reset the history (lastLocal
// pattern) — except the drawer delete, which is adopted as an undoable step.

const makeMultiData = (tasks: ProjectTask[]): ProjectData =>
  ({ description: '', tasks, notes: '', updatedAt: '' }) as ProjectData

const renderBoard = (data: ProjectData, detailId: string | null = null) => {
  const persist = vi.fn()
  const onDeleteTask = vi.fn()
  const props = (d: ProjectData, openId: string | null) => ({
    data: d,
    project: baseProject,
    persist,
    detailId: openId,
    onOpenDetail: vi.fn(),
    renderConversation: () => <div data-testid="conversation" />,
    hasTerminalSlot: () => false,
    liveTerminalId: () => null,
    onDeleteTask,
    onLaunchTask: vi.fn(async (_t: ProjectTask): Promise<TaskLaunchResult> => ({ ok: true })),
  })
  const utils = render(<BoardModule {...props(data, detailId)} />)
  return {
    ...utils,
    persist,
    onDeleteTask,
    rerenderWith: (d: ProjectData, openId: string | null = null) =>
      utils.rerender(<BoardModule {...props(d, openId)} />),
  }
}

describe('BoardModule — board undo/redo (B013)', () => {
  it('clear Done → ⌘Z restores the cleared cards (undo persists), ⇧⌘Z re-clears', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const a = makeTask({ id: 'a', title: 'A', boardColumn: 'todo' })
    const b = makeTask({ id: 'b', title: 'B', boardColumn: 'done', done: true })
    const { persist, getByText, getByTitle } = renderBoard(makeMultiData([a, b]))
    await flush()
    // Nothing to undo yet — the toolbar affordance starts disabled.
    expect((getByTitle('board.toolbar.undo') as HTMLButtonElement).disabled).toBe(true)
    expect((getByTitle('board.toolbar.redo') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(getByText('board.toolbar.clearDone'))
    expect(persist).toHaveBeenCalledTimes(1)
    expect((persist.mock.calls[0][0] as ProjectData).tasks.map(t => t.id)).toEqual(['a'])

    // ⌘Z — flushes the pending coalesced step and persists the pre-clear tasks.
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    expect(persist).toHaveBeenCalledTimes(2)
    expect((persist.mock.calls[1][0] as ProjectData).tasks.map(t => t.id)).toEqual(['a', 'b'])

    // Redo is now live — via the toolbar button this time.
    const redoBtn = getByTitle('board.toolbar.redo') as HTMLButtonElement
    expect(redoBtn.disabled).toBe(false)
    fireEvent.click(redoBtn)
    expect(persist).toHaveBeenCalledTimes(3)
    expect((persist.mock.calls[2][0] as ProjectData).tasks.map(t => t.id)).toEqual(['a'])
  })

  it('⌘Z is left to a focused text field (the search input keeps native undo)', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const a = makeTask({ id: 'a', title: 'A', boardColumn: 'done', done: true })
    const { persist, getByText, container } = renderBoard(makeMultiData([a]))
    await flush()
    fireEvent.click(getByText('board.toolbar.clearDone'))
    expect(persist).toHaveBeenCalledTimes(1)
    const search = container.querySelector<HTMLInputElement>(
      'input[placeholder="board.toolbar.searchPlaceholder"]',
    )!
    search.focus()
    fireEvent.keyDown(search, { key: 'z', metaKey: true })
    expect(persist).toHaveBeenCalledTimes(1) // untouched — the field owns ⌘Z
  })

  it('drawer delete is adopted into history — ⌘Z restores the deleted card', async () => {
    const before = makeData(makeTask()) // id t1, titled, todo
    const { persist, onDeleteTask, getByTitle, rerenderWith } = renderBoard(before, 't1')
    await flush()
    fireEvent.click(getByTitle('projectPanel.deleteTask'))
    expect(onDeleteTask).toHaveBeenCalledWith('t1')
    // ProjectPanel persisted the removal itself — the data prop comes back
    // without the task (an EXTERNAL change from this module's viewpoint).
    rerenderWith({ ...before, tasks: [] }, null)
    await flush()
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    const last = persist.mock.calls.at(-1)![0] as ProjectData
    expect(last.tasks.map(t => t.id)).toEqual(['t1'])
  })

  it('a re-render that KEEPS the tasks array identity preserves the history (poll no-op contract)', async () => {
    // ProjectPanel's 5s reloadProjectData now skips setData when the fetched
    // JSON equals lastSavedJson — the data prop re-arrives with the SAME tasks
    // identity. That must read as "nothing happened", not as an external
    // replacement that wipes the stacks.
    vi.stubGlobal('confirm', vi.fn(() => true))
    const a = makeTask({ id: 'a', title: 'A', boardColumn: 'done', done: true })
    const data = makeMultiData([a])
    const { persist, getByText, rerenderWith } = renderBoard(data)
    await flush()
    fireEvent.click(getByText('board.toolbar.clearDone'))
    expect(persist).toHaveBeenCalledTimes(1)
    // ProjectPanel adopts our own write (setData(next)) — the echo render
    // carries the tasks array WE emitted…
    const cleared = persist.mock.calls[0][0] as ProjectData
    rerenderWith(cleared)
    await flush()
    // …and the poll tick re-renders with the SAME object (the skip path keeps
    // identity instead of swapping in a content-equal fresh fetch).
    rerenderWith(cleared)
    await flush()
    // ⌘Z still restores the cleared card — the stacks survived the tick.
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    expect(persist).toHaveBeenCalledTimes(2)
    expect((persist.mock.calls[1][0] as ProjectData).tasks.map(t => t.id)).toEqual(['a'])
  })

  it('an UNFLAGGED external tasks replacement (remote sync) resets the history', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const a = makeTask({ id: 'a', title: 'A', boardColumn: 'done', done: true })
    const { persist, getByText, rerenderWith } = renderBoard(makeMultiData([a]))
    await flush()
    fireEvent.click(getByText('board.toolbar.clearDone'))
    expect(persist).toHaveBeenCalledTimes(1)
    // A wholesale replacement arrives (teammate's sync) — stacks drop.
    const remote = makeMultiData([makeTask({ id: 'remote', title: 'R' })])
    rerenderWith(remote)
    await flush()
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    expect(persist).toHaveBeenCalledTimes(1) // no undo across the reset
  })
})
