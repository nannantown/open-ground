// @vitest-environment jsdom
//
// ── 実行 は swarm がオンなら worker に振る / 完了は記録であって発射台ではない ──
//
// TWO owner decisions from 2026-08-26, pinned together because they are the same
// question asked twice: what should the 実行 button DO on this card?
//
// 1. WITH THE SWARM ON, it hands the card to a worker. The two paths were the
//    same intent with different machinery, and the difference was not a runtime
//    detail: a worker gets a REAL isolated worktree the server cuts, runs on the
//    SDK runtime (the PTY worker pool is gone), and lands in 判断待ち for the
//    commander. The terminal path only ASKS claude, in prose, to cut a task/
//    branch and merge itself back — isolation as a request, not a fact. Running
//    a card two different ways meant a second execution protocol nobody
//    maintained.
//    ⚠ The LIVE fields ride the request. The route reads the card from
//    tasks.json and drawer edits are debounced, so a card written and run in the
//    same breath would dispatch after a stale goal — or an empty one.
//
// 2. ON A DONE CARD IT DOES NOT EXIST. 「doneになってたらサマリーとかだけでよくない？」
//    A finished card is a record; the drawer shows what it left behind.
//
// MUTATIONS that turn this red: drop the `swarmVisible` branch in runTask (back
// to onLaunchTask); send only { path, taskId } without the live fields; render
// the run footer for a done card.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/components/canvas/CollabPresence', () => ({
  CollabPresence: () => null,
  usePublishPresence: () => {},
}))
vi.mock('@/lib/api-client', () => ({
  api: {
    api: {
      settings: { $get: () => Promise.resolve({ json: () => Promise.resolve({}) }) },
      project: {
        'task-title': { $post: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ title: null }) }) },
        'pr-info': { $post: () => Promise.resolve({ json: () => Promise.resolve({ available: false }) }) },
      },
    },
  },
}))

import { BoardModule } from './BoardModule'

const makeTask = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: 't1',
  title: 'Saved title',
  notes: 'Do the work',
  done: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  boardColumn: 'todo',
  ...over,
})

const makeData = (task: ProjectTask): ProjectData =>
  ({ description: '', tasks: [task], notes: '', updatedAt: '' }) as ProjectData

const project = { id: 'p1', name: 'proj', path: '/tmp/proj', hasGit: true } as ProjectMeta

const renderDrawer = (data: ProjectData, opts: { swarmVisible?: boolean } = {}) => {
  const onLaunchTask = vi.fn(async () => ({ ok: true }))
  const utils = render(
    <BoardModule
      data={data}
      project={project}
      persist={vi.fn()}
      detailId="t1"
      onOpenDetail={vi.fn()}
      renderConversation={() => <div data-testid="conversation" />}
      hasTerminalSlot={() => false}
      liveTerminalId={() => null}
      onDeleteTask={vi.fn()}
      onLaunchTask={onLaunchTask}
      swarmVisible={opts.swarmVisible ?? false}
    />,
  )
  return { ...utils, onLaunchTask }
}

const flush = () => act(async () => {})

type Req = { url: string; body: Record<string, unknown> }
let reqs: Req[] = []
const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : ((input as Request)?.url ?? '')
  reqs.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} })
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
})

beforeEach(() => {
  localStorage.clear()
  reqs = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('実行 with the swarm ON', () => {
  it('dispatches a WORKER instead of opening a terminal', async () => {
    const { getByText, onLaunchTask } = renderDrawer(makeData(makeTask()), { swarmVisible: true })
    await flush()
    fireEvent.click(getByText('board.run.button'))
    await flush()

    const worker = reqs.find(r => r.url === '/api/swarm/worker')
    expect(worker, '実行 must hand the card to a worker when the swarm is on').toBeTruthy()
    // …and NOT also spawn the terminal path. Two runtimes on one card is the
    // twin-dispatch hazard, not a fallback.
    expect(onLaunchTask).not.toHaveBeenCalled()
  })

  it('carries the LIVE title and content, not just the id (the drawer debounces its writes)', async () => {
    const { getByText } = renderDrawer(makeData(makeTask()), { swarmVisible: true })
    await flush()
    fireEvent.click(getByText('board.run.button'))
    await flush()

    const worker = reqs.find(r => r.url === '/api/swarm/worker')!
    expect(worker.body.taskId).toBe('t1') // identity: the claim + twin guard
    expect(worker.body.title).toBe('Saved title') // goal: what is on screen NOW
    expect(worker.body.notes).toBe('Do the work')
    expect(worker.body.path).toBe('/tmp/proj')
  })

  it('with the swarm OFF it still opens the terminal — nothing else can finish the card', async () => {
    const { getByText, onLaunchTask } = renderDrawer(makeData(makeTask()), { swarmVisible: false })
    await flush()
    fireEvent.click(getByText('board.run.button'))
    await flush()

    expect(onLaunchTask).toHaveBeenCalled()
    expect(reqs.some(r => r.url === '/api/swarm/worker')).toBe(false)
  })

  it('hides the per-card run settings, which a worker answers to none of', async () => {
    // Flow, model and effort are decided elsewhere once the card is a worker:
    // the flow is always 判断待ち→commander, and the model comes from the supply
    // officer's card-weight policy. A picker that changes nothing is worse than
    // no picker.
    const on = renderDrawer(makeData(makeTask()), { swarmVisible: true })
    await flush()
    expect(on.queryByText('board.run.settingsLabel')).toBeNull()
    cleanup()

    const off = renderDrawer(makeData(makeTask()), { swarmVisible: false })
    await flush()
    expect(off.queryByText('board.run.settingsLabel')).toBeTruthy()
  })
})

describe('a 完了 card is a record, not a launcher', () => {
  it('offers no 実行 and no run settings', async () => {
    const { queryByText } = renderDrawer(
      makeData(makeTask({ boardColumn: 'done', done: true })),
    )
    await flush()
    expect(queryByText('board.run.button')).toBeNull()
    expect(queryByText('board.run.settingsLabel')).toBeNull()
  })

  it('shows what the card actually left behind, and only that', async () => {
    const { queryByText, getByText } = renderDrawer(
      makeData(
        makeTask({
          boardColumn: 'done',
          done: true,
          branch: 'swarm/card-9',
          reviewedBy: 'commander',
          reworkCount: 2,
        }),
      ),
    )
    await flush()
    expect(getByText('board.done.heading')).toBeTruthy()
    expect(getByText('swarm/card-9')).toBeTruthy()
    expect(getByText('commander')).toBeTruthy()
    expect(getByText('board.done.rework')).toBeTruthy()
    // Nothing was recorded about a PR, so no PR row is invented.
    expect(queryByText('board.done.pr')).toBeNull()
    expect(queryByText('board.done.none')).toBeNull()
  })

  it('says so plainly when there is nothing beyond the content', async () => {
    const { getByText, queryByText } = renderDrawer(
      makeData(makeTask({ boardColumn: 'done', done: true, createdAt: '' })),
    )
    await flush()
    expect(getByText('board.done.none')).toBeTruthy()
    expect(queryByText('board.done.branch')).toBeNull()
  })
})
