import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { ProjectData } from '@/lib/types'

// Owner report 2026-11-04: 「アップデートしたら、追加したタブ(SNSハブの SNS)が
// 外れている」. Measured cause: the president agent added a card with a PUT
// /api/project body of only { path, ifUpdatedAt, tasks } — and PUT wrote that
// body as the WHOLE file, erasing customTabs / tabOrder / description. The open
// panel still held the old copy, so the tab only went missing on the next
// launch. Guard: a field the writer did not send keeps its stored value.
// Read back through GET /api/project (the production reader).

const req = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-keep-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-keep-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const setup = async (): Promise<{ dir: string; saved: ProjectData }> => {
  const dir = join(scratch, 'sns-hub')
  await mkdir(dir)
  await writeFile(join(dir, 'README.md'), '# sns-hub\n')
  expect((await app.request('/api/projects/import', req('POST', { path: dir }))).status).toBe(200)
  const full: ProjectData = {
    description: 'SNS hub',
    tasks: [],
    notes: 'memo',
    updatedAt: '',
    customTabs: ['d4ede482-8cfa-490f-a932-a563b9b95bb3'],
    tabOrder: ['custom:d4ede482-8cfa-490f-a932-a563b9b95bb3', 'board', 'terminal'],
    disabledModules: ['canvas'],
  }
  const res = await app.request(`/api/project?path=${encodeURIComponent(dir)}`, req('PUT', full))
  expect(res.status).toBe(200)
  return { dir, saved: (await res.json()) as ProjectData }
}

const get = async (dir: string): Promise<ProjectData> =>
  (await (await app.request(`/api/project?path=${encodeURIComponent(dir)}`)).json()) as ProjectData

describe('PUT /api/project never erases a field the writer did not send', () => {
  it('the incident body { path, ifUpdatedAt, tasks } keeps the attached tab, order and description', async () => {
    const { dir, saved } = await setup()
    const card = {
      id: 'c1', title: 'new card', notes: 'n', done: false,
      createdAt: '2026-11-02T00:00:00.000Z', boardColumn: 'todo',
    }
    const res = await app.request(
      `/api/project?path=${encodeURIComponent(dir)}`,
      req('PUT', { path: dir, ifUpdatedAt: saved.updatedAt, tasks: [card] }),
    )
    expect(res.status).toBe(200)
    // Simulate the next launch: a fresh read from disk.
    const after = await get(dir)
    expect(after.tasks.map(t => t.id)).toEqual(['c1'])
    expect(after.customTabs).toEqual(['d4ede482-8cfa-490f-a932-a563b9b95bb3'])
    expect(after.tabOrder).toEqual(['custom:d4ede482-8cfa-490f-a932-a563b9b95bb3', 'board', 'terminal'])
    expect(after.disabledModules).toEqual(['canvas'])
    expect(after.description).toBe('SNS hub')
    expect(after.notes).toBe('memo')
  })

  it('a stale ifUpdatedAt is honoured as the CAS token (409, cards not clobbered)', async () => {
    const { dir, saved } = await setup()
    const ok = await app.request(
      `/api/project?path=${encodeURIComponent(dir)}`,
      req('PUT', { ...saved, notes: 'moved on' }),
    )
    expect(ok.status).toBe(200)
    const stale = await app.request(
      `/api/project?path=${encodeURIComponent(dir)}`,
      req('PUT', { path: dir, ifUpdatedAt: saved.updatedAt, tasks: [] }),
    )
    expect(stale.status).toBe(409)
    const after = await get(dir)
    expect(after.notes).toBe('moved on')
  })

  it('omitting tasks keeps the stored cards', async () => {
    const { dir, saved } = await setup()
    const card = { id: 'k', title: 'keep', done: false, createdAt: '2026-11-02T00:00:00.000Z', boardColumn: 'todo' }
    const r1 = await app.request(`/api/project?path=${encodeURIComponent(dir)}`, req('PUT', { ...saved, tasks: [card] }))
    const s1 = (await r1.json()) as ProjectData
    const r2 = await app.request(`/api/project?path=${encodeURIComponent(dir)}`, req('PUT', { updatedAt: s1.updatedAt, notes: 'x' }))
    expect(r2.status).toBe(200)
    expect((await get(dir)).tasks.map(t => t.id)).toEqual(['k'])
  })

  it('repeated partial writes (one per restart) never wear the tab away', async () => {
    const { dir } = await setup()
    for (let i = 0; i < 5; i++) {
      const cur = await get(dir)
      const res = await app.request(
        `/api/project?path=${encodeURIComponent(dir)}`,
        req('PUT', { tasks: cur.tasks, updatedAt: cur.updatedAt }),
      )
      expect(res.status).toBe(200)
    }
    expect((await get(dir)).customTabs).toEqual(['d4ede482-8cfa-490f-a932-a563b9b95bb3'])
  })

  it('an explicit value still wins: detaching sends customTabs: [] and it sticks', async () => {
    const { dir, saved } = await setup()
    const res = await app.request(
      `/api/project?path=${encodeURIComponent(dir)}`,
      req('PUT', { ...saved, customTabs: [], tabOrder: ['board', 'terminal'] }),
    )
    expect(res.status).toBe(200)
    const after = await get(dir)
    expect(after.customTabs).toEqual([])
    expect(after.tabOrder).toEqual(['board', 'terminal'])
  })
})
