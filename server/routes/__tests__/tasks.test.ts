import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { ProjectTask } from '@/lib/types'

// Route-level contract for POST /api/project/tasks — the endpoint a Board-card
// claude session drives via curl (taskPrompt). Pins the ops it documents:
// add / markDone / setColumn, and setPrUrl's validation (http(s) only,
// clear-on-empty, junk rejected) — a claude session pastes the URL itself, so
// the route is the only guard between a typo and a permanent bogus link.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-tasks-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-tasks-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})

afterEach(async () => {
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
  const data = await res.json()
  const task = (data.tasks as ProjectTask[]).find((t) => t.title === title)
  expect(task).toBeTruthy()
  return task as ProjectTask
}

const getTask = async (path: string, id: string): Promise<ProjectTask | undefined> => {
  const res = await app.request(`/api/project?path=${encodeURIComponent(path)}`)
  expect(res.status).toBe(200)
  return ((await res.json()).tasks as ProjectTask[]).find((t) => t.id === id)
}

describe('POST /api/project/tasks — core ops', () => {
  it('add creates a todo board card; markDone sets done + done column', async () => {
    const dir = await makeRegisteredDir('core')
    const task = await addTask(dir, 'Ship it')
    expect(task.boardColumn).toBe('todo')
    expect(task.done).toBe(false)

    const res = await app.request('/api/project/tasks', json({ path: dir, markDone: [task.id] }))
    expect(res.status).toBe(200)
    const after = await getTask(dir, task.id)
    expect(after?.done).toBe(true)
    expect(after?.boardColumn).toBe('done')
  })

  it('setColumn moves the card; done tracks the column', async () => {
    const dir = await makeRegisteredDir('move')
    const task = await addTask(dir, 'Review me')
    await app.request(
      '/api/project/tasks',
      json({ path: dir, setColumn: [{ id: task.id, column: 'review' }] }),
    )
    let t = await getTask(dir, task.id)
    expect(t?.boardColumn).toBe('review')
    expect(t?.done).toBe(false)

    // Junk column names are ignored, not 500s.
    const res = await app.request(
      '/api/project/tasks',
      json({ path: dir, setColumn: [{ id: task.id, column: '../../etc' }] }),
    )
    expect(res.status).toBe(200)
    t = await getTask(dir, task.id)
    expect(t?.boardColumn).toBe('review')
  })
})

describe('POST /api/project/tasks — setPrUrl validation', () => {
  it('records an https PR URL; empty string clears it', async () => {
    const dir = await makeRegisteredDir('pr')
    const task = await addTask(dir, 'PR task')
    const url = 'https://github.com/o/r/pull/42'

    await app.request('/api/project/tasks', json({ path: dir, setPrUrl: [{ id: task.id, url }] }))
    expect((await getTask(dir, task.id))?.prUrl).toBe(url)

    await app.request('/api/project/tasks', json({ path: dir, setPrUrl: [{ id: task.id, url: '' }] }))
    expect((await getTask(dir, task.id))?.prUrl).toBeUndefined()
  })

  it('rejects non-http(s) schemes, unparseable URLs, and over-long URLs', async () => {
    const dir = await makeRegisteredDir('pr-bad')
    const task = await addTask(dir, 'Guarded')
    const good = 'https://github.com/o/r/pull/1'
    await app.request('/api/project/tasks', json({ path: dir, setPrUrl: [{ id: task.id, url: good }] }))

    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://', // unparseable
      'not a url',
      `https://github.com/${'a'.repeat(600)}`, // > 500 chars
    ]) {
      const res = await app.request(
        '/api/project/tasks',
        json({ path: dir, setPrUrl: [{ id: task.id, url: bad }] }),
      )
      expect(res.status).toBe(200) // ignored, never a 500
      expect((await getTask(dir, task.id))?.prUrl).toBe(good) // unchanged
    }
  })

  it('unknown task id is a no-op, not an error', async () => {
    const dir = await makeRegisteredDir('pr-miss')
    const res = await app.request(
      '/api/project/tasks',
      json({ path: dir, setPrUrl: [{ id: 'nope', url: 'https://x.test/pr/1' }] }),
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /api/project/task-title — guards (no claude spawn)', () => {
  // Only the pre-generation guards: every case below must return BEFORE the
  // route probes/spawns the claude CLI (a test must never bill a session).
  it('hand-titled card (no titleAuto) is a null no-op', async () => {
    const dir = await makeRegisteredDir('title-manual')
    const task = await addTask(dir, 'Hand written title')
    const res = await app.request('/api/project/task-title', json({ path: dir, id: task.id }))
    expect(res.status).toBe(200)
    expect((await res.json()).title).toBeNull()
  })

  it('unknown id → 404; missing fields → 400; unregistered path → 403', async () => {
    const dir = await makeRegisteredDir('title-guards')
    expect((await app.request('/api/project/task-title', json({ path: dir, id: 'nope' }))).status).toBe(404)
    expect((await app.request('/api/project/task-title', json({ path: dir }))).status).toBe(400)
    expect(
      (await app.request('/api/project/task-title', json({ path: '/etc', id: 'x' }))).status,
    ).toBe(403)
  })
})

describe('POST /api/project/tasks — setBranch validation', () => {
  it('records a plausible branch name; empty string clears it', async () => {
    const dir = await makeRegisteredDir('branch')
    const task = await addTask(dir, 'Branch task')

    await app.request(
      '/api/project/tasks',
      json({ path: dir, setBranch: [{ id: task.id, branch: 'task/u2-105-account-settings' }] }),
    )
    expect((await getTask(dir, task.id))?.branch).toBe('task/u2-105-account-settings')

    await app.request(
      '/api/project/tasks',
      json({ path: dir, setBranch: [{ id: task.id, branch: '' }] }),
    )
    expect((await getTask(dir, task.id))?.branch).toBeUndefined()
  })

  it('rejects whitespace/shell-noise/over-long names without erroring', async () => {
    const dir = await makeRegisteredDir('branch-bad')
    const task = await addTask(dir, 'Guarded branch')
    const good = 'task/fix-login'
    await app.request(
      '/api/project/tasks',
      json({ path: dir, setBranch: [{ id: task.id, branch: good }] }),
    )

    for (const bad of [
      'has space',
      '-leading-dash',
      'semi;colon',
      'back`tick`',
      `task/${'a'.repeat(250)}`, // > 200 chars
    ]) {
      const res = await app.request(
        '/api/project/tasks',
        json({ path: dir, setBranch: [{ id: task.id, branch: bad }] }),
      )
      expect(res.status).toBe(200) // ignored, never a 500
      expect((await getTask(dir, task.id))?.branch).toBe(good) // unchanged
    }
  })
})
