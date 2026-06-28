// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask } from '@/lib/types'

// Phase-following drawer contract (BoardModule) — CONTENT-FIRST (2026-06-13):
//   Draft (no terminal slot)
//     - one content textarea (autofocused) is the hero field; there is NO
//       title input (the title is auto-generated on Run). Images paste/drop
//       into the content; assignee/depends/due hide behind an Options
//       disclosure. The run footer holds the per-card run settings (flow /
//       model / effort, autosaved) + an explicit 実行 button. NOTHING launches
//       by itself — 実行 calls onLaunchTask with the run payload.
//     - a card with NO content disables 実行; a missing project hides the footer
//     - 実行 on a title-less card derives a provisional title from the first
//       line of content (kept whole), persists it titleAuto, and asks for a
//       haiku title for multi-line content — the title lands on the card later
//     - the conversation pane is NOT mounted at all
//   Session (slot exists)
//     - terminal pane mounts; fields collapse behind the one-line header
//     - the header shows the title + a ✦ regenerate button (the one place
//       manual title regeneration lives now); no title input
//     - status strip narrates branch / completion flow / PR
//     - "Insert task into input" pastes the task into the live PTY unsent
//       (POST /api/terminal/:id/paste-task); disabled without a live PTY
//     - chevron header expands the fields block (content textarea, no title)

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
// Presence overlay reads useAuth; this suite renders BoardModule bare (no
// AuthProvider) and tests drawer behavior, not presence — so stub it out.
vi.mock('@/components/canvas/CollabPresence', () => ({
  CollabPresence: () => null,
  usePublishPresence: () => {},
}))
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

// A "normal" card now carries CONTENT (the primary field) — without it the
// content-first Run gate would disable 実行. Tests that need a truly empty
// card override notes: undefined.
const makeTask = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: 't1',
  title: 'Saved title',
  notes: 'Do the work',
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
  it('empty card: content textarea (no title input), no conversation, 実行 disabled, NO launch', async () => {
    const { container, queryByTestId, onLaunchTask, getByText } = renderDrawer(
      makeData(makeTask({ title: '', notes: undefined })),
    )
    await flush()
    // The content textarea is the hero field, autofocused.
    const content = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="board.detail.notesPlaceholder"]',
    )
    expect(content).toBeTruthy()
    // No title input anywhere in the content-first drawer.
    expect(container.querySelector('input[placeholder="board.detail.titlePlaceholder"]')).toBeNull()
    expect(queryByTestId('conversation')).toBeNull()
    // The run footer is there but inert: a content-less card can't run, and
    // nothing ever launches without the explicit click.
    expect((getByText('board.run.button') as HTMLButtonElement).disabled).toBe(true)
    expect(onLaunchTask).not.toHaveBeenCalled()
  })

  it('実行 on a title-less card derives a provisional title from the first line + asks for a haiku', async () => {
    const { getByText, onLaunchTask, persist } = renderDrawer(
      makeData(makeTask({ title: '', notes: 'Account settings page\nUse the modal.\nAdd email.' })),
    )
    await flush()
    fireEvent.click(getByText('board.run.button'))
    await flush()
    // The launch payload carries the provisional title (first line) — the
    // server prompt contract still needs one; the content stays whole.
    const [, opts] = onLaunchTask.mock.calls[0]
    expect(opts?.run).toMatchObject({
      title: 'Account settings page',
      notes: 'Account settings page\nUse the modal.\nAdd email.',
    })
    // It is persisted titleAuto so the haiku pass can refine it, and the
    // multi-line content triggers that pass.
    const saved = persist.mock.calls.find(
      c => (c[0] as ProjectData).tasks[0].title === 'Account settings page',
    )?.[0] as ProjectData
    expect(saved.tasks[0]).toMatchObject({ title: 'Account settings page', titleAuto: true })
    expect(taskTitlePost).toHaveBeenCalledWith({ json: { path: '/tmp/proj', id: 't1' } })
  })

  it('実行 on a single-short-line card: that line IS the title, NO haiku request', async () => {
    const { getByText, onLaunchTask } = renderDrawer(
      makeData(makeTask({ title: '', notes: 'Fix the login flow' })),
    )
    await flush()
    fireEvent.click(getByText('board.run.button'))
    await flush()
    const [, opts] = onLaunchTask.mock.calls[0]
    expect((opts?.run as { title: string }).title).toBe('Fix the login flow')
    expect(taskTitlePost).not.toHaveBeenCalled()
  })

  it('card with content: content field shown, no title input, 実行 enabled, NO launch', async () => {
    const { container, queryByTestId, onLaunchTask, getByText } = renderDrawer(
      makeData(makeTask()),
    )
    await flush()
    expect(
      container.querySelector('textarea[placeholder="board.detail.notesPlaceholder"]'),
    ).toBeTruthy()
    expect(container.querySelector('input[placeholder="board.detail.titlePlaceholder"]')).toBeNull()
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
    const { container, persist, getByText } = renderDrawer(makeData(makeTask()))
    await flush()
    // Run settings are collapsed by default now — open the disclosure first.
    fireEvent.click(getByText('board.run.settingsLabel'))
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

  it('a signed-out run shows the sign-in CTA, which opens the single login terminal (not another spawn)', async () => {
    const onClaudeLogin = vi.fn()
    const onLaunchTask = vi
      .fn(async (_t: ProjectTask): Promise<TaskLaunchResult> => ({ ok: true }))
      .mockResolvedValueOnce({ ok: false, reason: 'claudeLoggedOut' })
    const { getByText, queryByText } = render(
      <BoardModule
        data={makeData(makeTask())}
        project={baseProject}
        persist={vi.fn()}
        detailId="t1"
        onOpenDetail={vi.fn()}
        renderConversation={() => <div data-testid="conversation" />}
        hasTerminalSlot={() => false}
        liveTerminalId={() => null}
        onDeleteTask={vi.fn()}
        onLaunchTask={onLaunchTask}
        claudeLoggedIn={false}
        onClaudeLogin={onClaudeLogin}
      />,
    )
    await flush()
    fireEvent.click(getByText('board.run.button'))
    await flush()
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
    // Signed-out copy (sign-in guidance), NOT the install-claude copy.
    expect(getByText(/board\.run\.failedClaudeLoggedOut/)).toBeTruthy()
    expect(queryByText(/board\.run\.failedClaudeMissing/)).toBeNull()
    // The CTA routes to the ONE sign-in terminal — it must NOT re-run the task
    // (re-running while signed out is exactly what opened OAuth repeatedly).
    fireEvent.click(getByText('board.run.signIn'))
    expect(onClaudeLogin).toHaveBeenCalledTimes(1)
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
  })

  it('while signed out, the fire-and-forget auto-title spawn is skipped (claudeLoggedIn=false)', async () => {
    taskTitlePost.mockClear()
    const onLaunchTask = vi.fn(
      async (_t: ProjectTask): Promise<TaskLaunchResult> => ({ ok: true }),
    )
    const { getByText } = render(
      <BoardModule
        data={makeData(
          makeTask({ title: '', notes: 'Account settings page\nUse the modal.\nAdd email.' }),
        )}
        project={baseProject}
        persist={vi.fn()}
        detailId="t1"
        onOpenDetail={vi.fn()}
        renderConversation={() => <div data-testid="conversation" />}
        hasTerminalSlot={() => false}
        liveTerminalId={() => null}
        onDeleteTask={vi.fn()}
        onLaunchTask={onLaunchTask}
        claudeLoggedIn={false}
      />,
    )
    await flush()
    fireEvent.click(getByText('board.run.button'))
    await flush()
    // The run still goes (the server gate is the real guard), but the SECOND,
    // automatic title spawn — the extra OAuth tab — must not even be requested.
    expect(onLaunchTask).toHaveBeenCalledTimes(1)
    expect(taskTitlePost).not.toHaveBeenCalled()
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

  it('Options disclosure: assignee/depends/due hide until expanded', async () => {
    const { getByText, queryByText } = renderDrawer(makeData(makeTask()))
    await flush()
    // Collapsed by default — the assignee add chip is not in the DOM yet.
    expect(queryByText('board.detail.assigneeAdd')).toBeNull()
    fireEvent.click(getByText('board.detail.optionsLabel'))
    // Expanded — the option fields are now reachable.
    expect(getByText('board.detail.assigneeLabel')).toBeTruthy()
    expect(getByText('board.detail.dependsLabel')).toBeTruthy()
    expect(getByText('board.detail.dueLabel')).toBeTruthy()
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

  it('chevron header expands the fields block — content textarea, no title input', async () => {
    const { container, getByTitle } = renderDrawer(makeData(makeTask()), { session: true })
    await flush()
    fireEvent.click(getByTitle('board.detail.fieldsToggle'))
    expect(
      container.querySelector('textarea[placeholder="board.detail.notesPlaceholder"]'),
    ).toBeTruthy()
    expect(container.querySelector('input[placeholder="board.detail.titlePlaceholder"]')).toBeNull()
    expect(
      container.querySelector('[aria-label="board.detail.resizeSplit"]'),
    ).toBeTruthy()
  })

  it('header ✦ regenerates the title (force) — the one manual regenerate left', async () => {
    const { getByTitle } = renderDrawer(makeData(makeTask()), { session: true })
    await flush()
    fireEvent.click(getByTitle('board.detail.regenTitle'))
    await flush()
    expect(taskTitlePost).toHaveBeenCalledWith({
      json: { path: '/tmp/proj', id: 't1', force: true },
    })
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
    expect(getByText('board.detail.flowPrReview')).toBeTruthy()
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
        notes: 'Do the work',
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

// ─── Shared multi-card board harness ─────────────────────────────────────────
// renderBoard mounts a BoardModule over makeMultiData's task list; reused by the
// suites below.

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

// The run-defaults strip (board-wide launch profile) is set-once chrome, so it
// opens COLLAPSED — the label is a disclosure toggle, the pickers render only
// when expanded, and the choice persists per project. The permission select is
// unique to this strip (the drawer's per-card run settings have no permission
// picker), so its 'default' option is a clean probe for "are the pickers shown".
describe('BoardModule — run-defaults strip disclosure', () => {
  it('collapsed by default: the label toggle shows but the pickers stay hidden', () => {
    const { getByText, queryByText } = renderBoard(makeMultiData([makeTask()]))
    const toggle = getByText('board.defaults.label')
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(queryByText('projectPanel.settingsPermDefault')).toBeNull()
  })

  it('expands on click to reveal the pickers, and the choice persists per project', () => {
    const { getByText, queryByText } = renderBoard(makeMultiData([makeTask()]))
    fireEvent.click(getByText('board.defaults.label'))
    expect(queryByText('projectPanel.settingsPermDefault')).toBeTruthy()
    expect(getByText('board.defaults.label').getAttribute('aria-expanded')).toBe('true')
    // Persisted so the board reopens expanded for THIS project (id 'p1').
    expect(localStorage.getItem('openground.board.defaultsOpen.p1')).toBe('1')
    // Toggling again collapses and clears the flag.
    fireEvent.click(getByText('board.defaults.label'))
    expect(queryByText('projectPanel.settingsPermDefault')).toBeNull()
    expect(localStorage.getItem('openground.board.defaultsOpen.p1')).toBe('0')
  })

  it('honors a persisted expanded state on mount', () => {
    localStorage.setItem('openground.board.defaultsOpen.p1', '1')
    const { queryByText } = renderBoard(makeMultiData([makeTask()]))
    expect(queryByText('projectPanel.settingsPermDefault')).toBeTruthy()
  })
})
