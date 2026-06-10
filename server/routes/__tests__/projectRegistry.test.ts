import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { getSettings, setSettings } from '@/lib/server/store'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'

// Exercises the registry routes (import / remove / new / delete boundary)
// against the real Hono app, with OPENGROUND_HOME pointed at a throwaway dir
// per test so the registry starts empty and migration runs once per home.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-routes-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-routes-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

describe('POST /api/projects/import', () => {
  it('registers an existing folder and it shows up in /api/projects', async () => {
    const dir = join(scratch, 'app')
    await mkdir(dir)
    const res = await app.request('/api/projects/import', json({ path: dir }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path).toBe(dir)
    expect(body.id).toBeTruthy()

    const list = await app.request('/api/projects')
    const listed = (await list.json()).projects as { path: string }[]
    expect(listed.some((p) => p.path === dir)).toBe(true)

    expect((await getSettings()).projects).toHaveLength(1)
  })

  it('rejects a non-existent path (400) and a duplicate (409)', async () => {
    const dir = join(scratch, 'app')
    await mkdir(dir)
    expect((await app.request('/api/projects/import', json({ path: join(scratch, 'nope') }))).status).toBe(400)
    expect((await app.request('/api/projects/import', json({ path: dir }))).status).toBe(200)
    expect((await app.request('/api/projects/import', json({ path: dir }))).status).toBe(409)
  })

  it('a legacy-unmigrated user can import without the migration clobbering the new entry', async () => {
    // Simulate a not-yet-migrated upgrade: projectsRoot set with one subdir,
    // projectsMigratedAt unset. The import route must run migration first, so
    // the migration's full setSettings({projects}) replace can't drop the import.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'og-routes-legacy-')))
    await mkdir(join(root, 'legacy-a'))
    await setSettings({ projectsRoot: root, archiveDirName: '_archive', excludePatterns: [] })
    const extern = join(scratch, 'imported')
    await mkdir(extern)

    const res = await app.request('/api/projects/import', json({ path: extern }))
    expect(res.status).toBe(200)

    const settings = await getSettings()
    const paths = (settings.projects ?? []).map((e) => e.path)
    // both the migrated legacy project AND the freshly imported one survive
    expect(paths.some((p) => p.endsWith('/legacy-a'))).toBe(true)
    expect(paths).toContain(extern)
    await rm(root, { recursive: true, force: true })
  })

  it('rejects an overlapping import (400)', async () => {
    const parent = join(scratch, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    expect((await app.request('/api/projects/import', json({ path: parent }))).status).toBe(200)
    // child sits under an already-registered project → overlap
    const res = await app.request('/api/projects/import', json({ path: child }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/overlap/i)
  })
})

describe('POST /api/projects/new', () => {
  it('asks for a workspace when none is set, then creates + registers', async () => {
    const need = await app.request('/api/projects/new', json({ name: 'fresh' }))
    expect(need.status).toBe(400)
    expect((await need.json()).needsWorkspace).toBe(true)

    const ok = await app.request('/api/projects/new', json({ name: 'fresh', workspace: scratch }))
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.id).toBeTruthy()
    // folder created on disk
    expect((await stat(join(scratch, 'fresh'))).isDirectory()).toBe(true)
    // registered + workspace remembered
    const settings = await getSettings()
    expect(settings.projects).toHaveLength(1)
    expect(settings.defaultWorkspace).toBe(scratch)
  })

  it('rejects a name with a slash (400)', async () => {
    const res = await app.request('/api/projects/new', json({ name: 'a/b', workspace: scratch }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/projects/remove', () => {
  it('unregisters a project but leaves the folder on disk', async () => {
    const dir = join(scratch, 'app')
    await mkdir(dir)
    await app.request('/api/projects/import', json({ path: dir }))
    expect((await getSettings()).projects).toHaveLength(1)

    const res = await app.request('/api/projects/remove', json({ path: dir }))
    expect(res.status).toBe(200)
    expect((await getSettings()).projects).toHaveLength(0)
    // folder still exists
    expect((await stat(dir)).isDirectory()).toBe(true)
    // removing again → 404
    expect((await app.request('/api/projects/remove', json({ path: dir }))).status).toBe(404)
  })
})
