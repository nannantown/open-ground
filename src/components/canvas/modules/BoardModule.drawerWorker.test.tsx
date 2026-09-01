// @vitest-environment jsdom
//
// ── 実行中カードのドロワーは worker の実態を映す (2026-09-01) ──────────────────
//
// Owner report (the second half of the weekly-limit incident): a doing card,
// opened in the drawer, showed the PROMPT and a 実行 button as if nothing had
// ever run — while its worker (a manual 実行 dispatch, so never in
// engine.workers) sat parked in the Swarm tab. Two lies in one panel: the
// virgin face, and a Run whose only possible outcome is the server's 409 (the
// card is already claimed).
//
// The contract pinned here, for a DOING card with the swarm on:
//   · a LIVE desk in the union list (GET /api/swarm/workers — the Swarm tab's
//     own source) renders the worker's screen, exactly like an engine-owned
//     worker already did;
//   · nobody live renders the 中断 notice — and NO 実行 button;
//   · an ordinary todo card keeps its draft + 実行 (the sweep must not eat the
//     normal launch path).
//
// MUTATIONS that turn this red: match union rows without requiring a live id
// (dead remains would render a screen); drop the swarm-doing footer branch
// (Run comes back on an interrupted card); key the probe off engine ownership
// only (manual workers lose their screen again).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask, SwarmWorkerRecord } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/components/canvas/CollabPresence', () => ({
  CollabPresence: () => null,
  usePublishPresence: () => {},
}))
// The two screen surfaces — presence is what these tests assert, not innards
// (the real panes open SSE streams jsdom has no server for).
vi.mock('@/components/canvas/modules/SwarmWorkerPane', () => ({
  SwarmWorkerPane: () => <div data-testid="pty-worker-screen" />,
}))
vi.mock('./SdkWorkerPane', () => ({
  SdkWorkerPane: () => <div data-testid="sdk-worker-screen" />,
}))

/** Mutable union-list the mocked GET /api/swarm/workers serves per test. */
let unionRows: SwarmWorkerRecord[] = []
vi.mock('@/lib/api-client', () => ({
  api: {
    api: {
      settings: { $get: () => Promise.resolve({ json: () => Promise.resolve({}) }) },
      project: {
        'task-title': {
          $post: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ title: null }) }),
        },
        'pr-info': {
          $post: () => Promise.resolve({ json: () => Promise.resolve({ available: false }) }),
        },
      },
      swarm: {
        workers: {
          $get: () =>
            Promise.resolve({ ok: true, json: () => Promise.resolve({ workers: unionRows }) }),
        },
      },
    },
  },
}))

import { BoardModule } from './BoardModule'

const makeTask = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: 't1',
  title: 'Stuck card',
  notes: 'goal text',
  done: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  boardColumn: 'doing',
  branch: 'swarm/t1-x',
  ...over,
})

const makeData = (task: ProjectTask): ProjectData =>
  ({ description: '', tasks: [task], notes: '', updatedAt: '' }) as ProjectData

const project = { id: 'p1', name: 'proj', path: '/tmp/proj', hasGit: true } as ProjectMeta

const renderDrawer = (data: ProjectData) =>
  render(
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
      onLaunchTask={vi.fn(async () => ({ ok: true }))}
      swarmVisible
    />,
  )

const flush = () => act(async () => {})

beforeEach(() => {
  localStorage.clear()
  unionRows = []
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
    ),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the drawer on a doing card under swarm', () => {
  it('shows the 中断 notice — and NO 実行 button — when nobody is live behind the card', async () => {
    // The union still lists the worker's REMAINS (roster/heartbeat row, no live
    // session id) — exactly the post-restart state. Remains are not a screen.
    unionRows = [{ worktree: '/wt/t1', branch: 'swarm/t1-x', taskId: 't1' }]
    const { getByText, queryByText, queryByTestId } = renderDrawer(makeData(makeTask()))
    await flush()
    expect(getByText('board.run.interrupted')).toBeTruthy()
    expect(queryByText('board.run.button')).toBeNull()
    expect(queryByTestId('sdk-worker-screen')).toBeNull()
    expect(queryByTestId('pty-worker-screen')).toBeNull()
  })

  it("renders the live worker's screen for a MANUAL (non-engine) SDK worker", async () => {
    unionRows = [
      {
        worktree: '/wt/t1',
        branch: 'swarm/t1-x',
        taskId: 't1',
        runtime: 'sdk',
        sdkSessionId: 'sdk-live-1',
      },
    ]
    const { queryByText, findByTestId } = renderDrawer(makeData(makeTask()))
    await flush()
    expect(await findByTestId('sdk-worker-screen')).toBeTruthy()
    expect(queryByText('board.run.button')).toBeNull()
    expect(queryByText('board.run.interrupted')).toBeNull()
  })

  it('matches by the card BRANCH too — a union row with no taskId still counts', async () => {
    unionRows = [
      { worktree: '/wt/t1', branch: 'swarm/t1-x', runtime: 'sdk', sdkSessionId: 'sdk-live-2' },
    ]
    const { findByTestId } = renderDrawer(makeData(makeTask()))
    await flush()
    expect(await findByTestId('sdk-worker-screen')).toBeTruthy()
  })

  it('an ordinary TODO card keeps its draft and its 実行 button', async () => {
    const { getByText, queryByText } = renderDrawer(
      makeData(makeTask({ boardColumn: 'todo', branch: undefined })),
    )
    await flush()
    expect(getByText('board.run.button')).toBeTruthy()
    expect(queryByText('board.run.interrupted')).toBeNull()
  })

  it('a BRANCHLESS doing card (hand-dragged — no dispatch evidence) keeps its 実行 button', async () => {
    // The branch is the dispatch receipt: without one no worker ever existed
    // for this card, so there is nothing to call 中断 and Run is the honest
    // offer. (BoardModule.worker.test.tsx pins the same contract from the
    // engine-poll side; this is the union-probe side.)
    const { getByText, queryByText } = renderDrawer(
      makeData(makeTask({ branch: undefined })),
    )
    await flush()
    expect(getByText('board.run.button')).toBeTruthy()
    expect(queryByText('board.run.interrupted')).toBeNull()
    expect(queryByText('board.run.checkingWorker')).toBeNull()
  })
})
