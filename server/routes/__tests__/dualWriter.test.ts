import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { ProjectData, ProjectTask } from '@/lib/types'

// Server-side half of the dual-writer contract that ProjectPanel's live board
// refresh relies on: an external move (swarm-board.sh / a terminal claude, both
// via POST /api/project/tasks while the app is up) must (1) be visible on the
// next GET and (2) bump the CAS `updatedAt` so a stale frontend snapshot can
// never overwrite it — a stale PUT gets a 409, not a silent clobber. The
// frontend half (adopt the GET, drop our own echo) is locked by
// src/lib/projectDataReconcile.test.ts.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const putJson = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-dw-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-dw-scratch-')))
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
const get = async (path: string): Promise<ProjectData> => {
  const res = await app.request(`/api/project?path=${encodeURIComponent(path)}`)
  expect(res.status).toBe(200)
  return (await res.json()) as ProjectData
}

describe('dual-writer repro: external move vs frontend snapshot', () => {
  it('GET (load) → external move bumps updatedAt + boardColumn; stale PUT is 409', async () => {
    const dir = await makeRegisteredDir('repro')
    const addRes = await app.request('/api/project/tasks', json({ path: dir, add: ['cardX'] }))
    const card = ((await addRes.json()).tasks as ProjectTask[]).find(t => t.title === 'cardX')!
    expect(card.boardColumn).toBe('todo')

    // Frontend's load snapshot
    const loaded = await get(dir)
    const u0 = loaded.updatedAt

    // External writer (swarm-board.sh move while app up → POST /api/project/tasks)
    const mv = await app.request('/api/project/tasks', json({ path: dir, setColumn: [{ id: card.id, column: 'done' }] }))
    expect(mv.status).toBe(200)

    // Poll GET: column changed AND updatedAt bumped past u0
    const polled = await get(dir)
    expect(polled.tasks.find(t => t.id === card.id)?.boardColumn).toBe('done')
    expect(polled.updatedAt).not.toBe(u0)
    expect(Date.parse(polled.updatedAt as string)).toBeGreaterThan(Date.parse(u0 as string))

    // Frontend stale persist (old snapshot, card still 'todo', old updatedAt) → 409, NO clobber
    const stale = await app.request(`/api/project?path=${encodeURIComponent(dir)}`, putJson(loaded))
    expect(stale.status).toBe(409)

    const after = await get(dir)
    expect(after.tasks.find(t => t.id === card.id)?.boardColumn).toBe('done')
  })
})
