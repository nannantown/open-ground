import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import {
  runBoundaryClearTick,
  pendingBoundaryClears,
  stopBoundaryClearLoop,
  __resetBoundaryClearForTests,
  type BoundaryClearDeps,
} from '@/lib/server/boundaryClear'
import type { TaskBoundPane } from '@/lib/server/terminal'
import type { ProjectTask } from '@/lib/types'

// END-TO-END demonstration of the card's headline claim:
//   "a card landing in `done` makes the next task start on a clean context."
//
// Driven through the REAL HTTP route the Board (and a card's own claude session,
// via curl) actually posts to — not a hand-called helper — so what is proven here
// is the shipped chain: POST /api/project/tasks → persisted `done` transition →
// queued boundary clear → `/clear` on the pane bound to THAT card.
//
// The PTY pool is the one seam faked: spawning a real `claude` needs a
// subscription login and a TUI, and the spike already established on real
// hardware that this exact byte sequence executes (CONTEXT_MANAGEMENT_PLAN
// §3-B1). What was NOT yet demonstrated — and is what this file demonstrates —
// is OG's half: that a Board transition resolves to the right pane and leaves
// every other pane alone.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

// The fake pool, shared by the deps below.
let panes: Map<string, TaskBoundPane[]>
let writes: { id: string; data: string }[]
let deps: BoundaryClearDeps

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-bclear-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-bclear-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  __resetBoundaryClearForTests()
  panes = new Map()
  writes = []
  deps = {
    panesForTask: (taskId) => panes.get(taskId) ?? [],
    write: (id, data) => {
      writes.push({ id, data })
      return true
    },
    unbind: () => {},
    now: () => 1_000_000,
  }
})

afterEach(async () => {
  __resetBoundaryClearForTests()
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const makeRegisteredDir = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await writeFile(join(dir, 'README.md'), `# ${name}\n`)
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
  return dir
}

const addTask = async (path: string, title: string): Promise<ProjectTask> => {
  const res = await app.request('/api/project/tasks', json({ path, add: [title] }))
  expect(res.status).toBe(200)
  const task = ((await res.json()).tasks as ProjectTask[]).find((t) => t.title === title)
  return task as ProjectTask
}

// Post, then STOP the background drain the route just armed.
//
// The route legitimately starts the real 2s loop, and that loop runs against the
// real (empty) PTY pool — so if it fired mid-test it would resolve every queued
// card as `no-pane` and empty the queue under the assertions below. It does not
// fire today only because these tests finish inside one tick, which is precisely
// the kind of load-dependent pass this repo has been bitten by before. Ticks here
// are driven by hand instead, so the timing is not part of the contract.
const post = async (body: unknown): Promise<Response> => {
  const res = await app.request('/api/project/tasks', json(body))
  stopBoundaryClearLoop()
  return res
}

const idlePane = (id: string): TaskBoundPane => ({ id, status: 'waiting', menuOpen: false })
const workingPane = (id: string): TaskBoundPane => ({ id, status: 'working', menuOpen: false })

describe('Board `done` → task-boundary context clear (through the real route)', () => {
  it('a card moved to done queues a clear, and the next task starts clean', async () => {
    const path = await makeRegisteredDir('proj-a')
    const card = await addTask(path, 'first task')
    panes.set(card.id, [idlePane('pane-1')])

    const res = await post({ path, setColumn: [{ id: card.id, column: 'done' }] })
    expect(res.status).toBe(200)

    // The route queued the intent; nothing was written to a PTY from inside the
    // request (the Board response must never wait on a terminal).
    expect(pendingBoundaryClears()).toEqual([card.id])
    expect(writes).toEqual([])

    // The background pass delivers it: line cleared, then the slash command.
    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: card.id, outcome: 'cleared' }])
    expect(writes).toEqual([
      { id: 'pane-1', data: '\x15' },
      { id: 'pane-1', data: '/clear\r' },
    ])
  })

  it('markDone — the curl a card\'s own session fires on completion — also clears', async () => {
    // The path a Board-card claude session uses to close its own card. It has to
    // behave identically to a drag into `done`, or the automatic route (the one
    // that actually runs unattended) would be the one that silently does nothing.
    const path = await makeRegisteredDir('proj-b')
    const card = await addTask(path, 'self-closing task')
    panes.set(card.id, [idlePane('pane-1')])

    expect((await post({ path, markDone: [card.id] })).status).toBe(200)
    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: card.id, outcome: 'cleared' }])
    expect(writes.map((w) => w.data)).toEqual(['\x15', '/clear\r'])
  })

  it('does NOT clear a pane working on a different card in the same project', async () => {
    // The mis-clear that a cwd-based lookup would cause: two cards running side
    // by side in one project, one finishes, and the other's live context is
    // thrown away. This is the single most valuable assertion in the file.
    const path = await makeRegisteredDir('proj-c')
    const finished = await addTask(path, 'finished task')
    const ongoing = await addTask(path, 'ongoing task')
    panes.set(finished.id, [idlePane('pane-done')])
    panes.set(ongoing.id, [idlePane('pane-busy')])

    await post({ path, setColumn: [{ id: finished.id, column: 'done' }] })
    runBoundaryClearTick(deps)

    expect(writes.map((w) => w.id)).toEqual(['pane-done', 'pane-done'])
  })

  it('re-saving a card that is ALREADY done does not clear again', async () => {
    // Transition, not state. A card sitting in `done` gets re-saved whenever any
    // unrelated field changes (setBranch, a PR link, a collab echo) — treating
    // that as a boundary would clear a pane the owner had since reused.
    const path = await makeRegisteredDir('proj-d')
    const card = await addTask(path, 'already done')
    panes.set(card.id, [idlePane('pane-1')])

    await post({ path, setColumn: [{ id: card.id, column: 'done' }] })
    expect(runBoundaryClearTick(deps)).toEqual([{ taskId: card.id, outcome: 'cleared' }])
    writes.length = 0

    await post({ path, setColumn: [{ id: card.id, column: 'done' }] })
    await post({ path, setBranch: [{ id: card.id, branch: 'feat/x' }] })
    expect(pendingBoundaryClears()).toEqual([])
    expect(runBoundaryClearTick(deps)).toEqual([])
    expect(writes).toEqual([])
  })

  it('a card pulled back out of done cancels its pending clear', async () => {
    const path = await makeRegisteredDir('proj-e')
    const card = await addTask(path, 'reopened task')
    panes.set(card.id, [workingPane('pane-1')]) // still busy — the clear waits

    await post({ path, setColumn: [{ id: card.id, column: 'done' }] })
    expect(pendingBoundaryClears()).toEqual([card.id])

    await post({ path, setColumn: [{ id: card.id, column: 'doing' }] })
    expect(pendingBoundaryClears()).toEqual([])

    panes.set(card.id, [idlePane('pane-1')])
    expect(runBoundaryClearTick(deps)).toEqual([])
    expect(writes).toEqual([])
  })

  it('差し戻し (rework) cancels the clear too', async () => {
    // review→doing via the rework op. The card is being worked again, so the
    // boundary never happened and its context must survive.
    const path = await makeRegisteredDir('proj-f')
    const card = await addTask(path, 'reworked task')
    panes.set(card.id, [workingPane('pane-1')])

    await post({ path, setColumn: [{ id: card.id, column: 'done' }] })
    expect(pendingBoundaryClears()).toEqual([card.id])

    expect((await post({ path, rework: [{ id: card.id }] })).status).toBe(200)
    expect(pendingBoundaryClears()).toEqual([])
  })

  it('a done+rework in ONE request nets out to no clear', async () => {
    // Both batches run inside a single mutate; the crossings are read off after
    // all of them, so the NET column decides — not whichever batch ran last.
    const path = await makeRegisteredDir('proj-g')
    const card = await addTask(path, 'net-out task')
    panes.set(card.id, [idlePane('pane-1')])

    const res = await post({
      path,
      setColumn: [{ id: card.id, column: 'done' }],
      rework: [{ id: card.id }],
    })
    expect(res.status).toBe(200)
    expect(pendingBoundaryClears()).toEqual([])
    expect(writes).toEqual([])
  })

  it('a brand-new card added straight into the board queues nothing', async () => {
    const path = await makeRegisteredDir('proj-h')
    await post({ path, add: ['fresh card'] })
    expect(pendingBoundaryClears()).toEqual([])
  })

  it('a rejected setColumn (unknown id) queues nothing', async () => {
    const path = await makeRegisteredDir('proj-i')
    const res = await post({ path, setColumn: [{ id: 'no-such-card', column: 'done' }] })
    expect(res.status).toBe(200)
    expect((await res.json()).results.setColumn[0].ok).toBe(false)
    expect(pendingBoundaryClears()).toEqual([])
  })
})
