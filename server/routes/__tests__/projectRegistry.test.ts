import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { getSettings, setSettings } from '@/lib/server/store'
import {
  __resetMigrationCacheForTests,
  setProjectDisplayName,
} from '@/lib/server/registry'
import { readProjectData, writeProjectData } from '@/lib/server/projectData'

// Spy-wrap the project-data module so one test can force writeProjectData to fail
// (exercising /api/projects/new's orphan-folder rollback) while every other test
// keeps the real implementation (passthrough spy).
vi.mock('@/lib/server/projectData', { spy: true })

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
  vi.restoreAllMocks()
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

  it('creates with a description and persists it to the central data + registry', async () => {
    const res = await app.request(
      '/api/projects/new',
      json({ name: 'described', workspace: scratch, description: 'Track my tasks' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBeTruthy()
    // folder created on disk AND registered — no orphan (the bug this fixes left
    // the folder unregistered because writeProjectData threw before the register).
    expect((await stat(join(scratch, 'described'))).isDirectory()).toBe(true)
    const settings = await getSettings()
    expect(settings.projects).toHaveLength(1)
    // description persisted to the project's CENTRAL data — the source scan.ts
    // reads to render the card body (descriptionForLang(data)).
    const data = await readProjectData(join(scratch, 'described'))
    expect(data.description).toBe('Track my tasks')
    // …and mirrored onto the registry entry (scan.ts's missing-card fallback).
    expect(settings.projects?.[0]?.description).toBe('Track my tasks')
  })

  it('leaves no orphan folder when the central-data write fails after registration', async () => {
    // Force the post-registration writeProjectData to throw, exercising the
    // rollback: the folder we created AND the registry entry must both be undone,
    // so a 409-blocking orphan can't linger and a same-name retry still works.
    vi.mocked(writeProjectData).mockRejectedValueOnce(new Error('simulated disk failure'))

    const res = await app.request(
      '/api/projects/new',
      json({ name: 'doomed', workspace: scratch, description: 'will roll back' }),
    )
    expect(res.status).toBe(500)
    // no orphan folder left on disk
    await expect(stat(join(scratch, 'doomed'))).rejects.toMatchObject({ code: 'ENOENT' })
    // registry rolled back — nothing stranded under a dead folder
    expect((await getSettings()).projects ?? []).toHaveLength(0)
    // …and because the orphan was cleaned up, a same-name create now succeeds
    // (the original bug failed here with a 409 "already exists" forever).
    const retry = await app.request(
      '/api/projects/new',
      json({ name: 'doomed', workspace: scratch }),
    )
    expect(retry.status).toBe(200)
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

describe('POST /api/projects/display-name', () => {
  // Helper: the card/header name GET /api/projects derives for a given path.
  const nameOf = async (path: string): Promise<string | undefined> => {
    const list = (await (await app.request('/api/projects')).json()).projects as {
      path: string
      name: string
    }[]
    return list.find((p) => p.path === path)?.name
  }

  it('sets a cosmetic name that shows in /api/projects, leaving the folder', async () => {
    const dir = join(scratch, 'my-app')
    await mkdir(dir)
    await app.request('/api/projects/import', json({ path: dir }))
    // Default name is the folder basename.
    expect(await nameOf(dir)).toBe('my-app')

    const res = await app.request(
      '/api/projects/display-name',
      json({ path: dir, displayName: 'Customer Portal' }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe('Customer Portal')
    // The card now shows the display name; the folder on disk is untouched.
    expect(await nameOf(dir)).toBe('Customer Portal')
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect((await getSettings()).projects?.[0]?.displayName).toBe('Customer Portal')
  })

  it('a blank name clears the override, reverting to the folder name', async () => {
    const dir = join(scratch, 'reverts')
    await mkdir(dir)
    await app.request('/api/projects/import', json({ path: dir }))
    await app.request('/api/projects/display-name', json({ path: dir, displayName: 'Renamed' }))
    expect(await nameOf(dir)).toBe('Renamed')

    const res = await app.request(
      '/api/projects/display-name',
      json({ path: dir, displayName: '   ' }),
    )
    expect(res.status).toBe(200)
    expect(await nameOf(dir)).toBe('reverts')
    // The field is dropped, not stored as "".
    expect((await getSettings()).projects?.[0]).not.toHaveProperty('displayName')
  })

  it('rejects an over-long name (400) and an unregistered path (403)', async () => {
    const dir = join(scratch, 'app')
    await mkdir(dir)
    await app.request('/api/projects/import', json({ path: dir }))

    const tooLong = await app.request(
      '/api/projects/display-name',
      json({ path: dir, displayName: 'x'.repeat(65) }),
    )
    expect(tooLong.status).toBe(400)

    // A path not under any registered project is rejected by validateProjectPath.
    const outside = await app.request(
      '/api/projects/display-name',
      json({ path: join(scratch, 'not-registered'), displayName: 'Nope' }),
    )
    expect(outside.status).toBe(403)
  })

  it('setProjectDisplayName returns null for an unregistered path', async () => {
    const dir = join(scratch, 'ghost')
    await mkdir(dir)
    expect(await setProjectDisplayName(dir, 'Whatever')).toBeNull()
  })
})
