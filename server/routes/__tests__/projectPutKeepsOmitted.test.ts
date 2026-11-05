import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { ProjectData } from '@/lib/types'
import { resolveSaveConflict } from '@/lib/modules/tabLayoutConflict'

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

  // Owner follow-up 2026-11-05: 「タブの並び替えした順序が更新後も継続されるか」.
  // Every board writer in a row — POST /api/project/tasks add + setColumn
  // (engine / president), a tasks-only PUT (president / commander), the app's
  // own full save — each followed by a fresh read (= a restart / update), must
  // leave the reordered row and the hidden tabs exactly as the owner set them.
  it('reordered + hidden tabs survive every board writer across restarts', async () => {
    const { dir } = await setup()
    const order = ['custom:d4ede482-8cfa-490f-a932-a563b9b95bb3', 'board', 'terminal']
    const check = async () => {
      const d = await get(dir) // fresh read from disk = next launch
      expect(d.tabOrder).toEqual(order)
      expect(d.disabledModules).toEqual(['canvas'])
      expect(d.customTabs).toEqual(['d4ede482-8cfa-490f-a932-a563b9b95bb3'])
      return d
    }
    const url = `/api/project?path=${encodeURIComponent(dir)}`
    for (let round = 0; round < 3; round++) {
      const r1 = await app.request('/api/project/tasks', req('POST', { path: dir, add: [`card ${round}`] }))
      expect(r1.status).toBe(200)
      let d = await check()
      const id = d.tasks[d.tasks.length - 1].id
      const r2 = await app.request(
        '/api/project/tasks',
        req('POST', { path: dir, setColumn: [{ id, column: 'doing' }] }),
      )
      expect(r2.status).toBe(200)
      d = await check()
      const r3 = await app.request(url, req('PUT', { path: dir, ifUpdatedAt: d.updatedAt, tasks: d.tasks }))
      expect(r3.status).toBe(200)
      d = await check()
      const r4 = await app.request(url, req('PUT', { ...d, notes: `n${round}` }))
      expect(r4.status).toBe(200)
      expect((await check()).tasks).toHaveLength(round + 1)
    }
  })

  // Commander rework 2026-11-05: the panel's own save 409s when the engine
  // wrote the Board between its poll and its debounced save. Adopting the
  // fresh copy wholesale dropped a just-made reorder. The panel's real 409
  // resolver must land the new layout on disk; cards stay server-wins.
  it('a reorder saved with a stale token after an engine add still lands on disk', async () => {
    const { dir, saved: loaded } = await setup()
    const url = `/api/project?path=${encodeURIComponent(dir)}`
    const add = await app.request('/api/project/tasks', req('POST', { path: dir, add: ['engine card'] }))
    expect(add.status).toBe(200)
    const newOrder = ['board', 'custom:d4ede482-8cfa-490f-a932-a563b9b95bb3', 'terminal']
    const draft: ProjectData = { ...loaded, tabOrder: newOrder, disabledModules: [] }
    const put = (body: ProjectData) => app.request(url, req('PUT', body))
    expect((await put(draft)).status).toBe(409)
    const out = await resolveSaveConflict(draft, JSON.stringify(loaded), { get: () => app.request(url), put })
    const disk = await get(dir)
    expect(disk.tabOrder).toEqual(newOrder)
    expect(disk.disabledModules).toEqual([])
    expect(disk.customTabs).toEqual(['d4ede482-8cfa-490f-a932-a563b9b95bb3'])
    expect(disk.tasks.map(t => t.title)).toEqual(['engine card'])
    expect(out?.tabOrder).toEqual(newOrder)
    expect(out?.updatedAt).toBe(disk.updatedAt)
  })

  it('a 409 with no layout change adopts the server copy and writes nothing', async () => {
    const { dir, saved: loaded } = await setup()
    const url = `/api/project?path=${encodeURIComponent(dir)}`
    await app.request('/api/project/tasks', req('POST', { path: dir, add: ['engine card'] }))
    const before = await get(dir)
    let puts = 0
    const out = await resolveSaveConflict({ ...loaded, notes: 'stale edit' }, JSON.stringify(loaded), {
      get: () => app.request(url),
      put: async b => { puts++; return app.request(url, req('PUT', b)) },
    })
    expect(puts).toBe(0)
    expect(out).toEqual(before)
    expect((await get(dir)).notes).toBe('memo')
  })
})
