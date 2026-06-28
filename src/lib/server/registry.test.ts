import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir, homedir } from 'os'
import { join, resolve } from 'path'
import { createHash } from 'crypto'

import { getSettings, setSettings, getCanvas, setCanvas } from './store'
import {
  ensureProjectsMigrated,
  addProjectEntry,
  removeProjectEntry,
  updateProjectEntryPath,
  isDangerousImportTarget,
  linkSharedProjectToFolder,
  findLinkedFolder,
  __resetMigrationCacheForTests,
} from './registry'
import { isValidProjectPath } from './projectDataPath'
import type { ProjectEntry } from '../types'

const legacyId = (key: string) =>
  createHash('sha1').update(key).digest('hex').slice(0, 12)

let home: string

// Each test gets a throwaway OPEN GROUND home so store reads/writes a clean
// settings.json / canvas.json, and the per-home migration cache is reset.
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-reg-home-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const findByName = (projects: ProjectEntry[], name: string) =>
  projects.find((e) => e.path.endsWith('/' + name))

describe('ensureProjectsMigrated', () => {
  it('imports legacy root subdirs as registry entries and remaps canvas positions', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'og-reg-root-')))
    await mkdir(join(root, 'alpha'))
    await mkdir(join(root, 'beta'))
    await mkdir(join(root, 'node_modules')) // excluded
    await mkdir(join(root, '_archive', 'old'), { recursive: true })

    await setSettings({
      projectsRoot: root,
      archiveDirName: '_archive',
      excludePatterns: ['node_modules', '_archive'],
    })
    // Seed canvas positions keyed by the OLD sha1 ids.
    await setCanvas({
      positions: {
        [legacyId('alpha')]: { x: 11, y: 22 },
        [legacyId('beta')]: { x: 33, y: 44 },
        [legacyId('_archive/old')]: { x: 55, y: 66 },
        [legacyId('ghost')]: { x: 99, y: 99 }, // orphan — no folder
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      elements: [],
    })

    await ensureProjectsMigrated()

    const settings = await getSettings()
    const projects = settings.projects ?? []
    expect(projects).toHaveLength(3) // alpha, beta, _archive/old
    // Migrated entries reuse the deterministic legacy id (sha1, 12 hex) so the
    // existing canvas positions already match — and a crash-retry is idempotent.
    expect(findByName(projects, 'alpha')!.id).toBe(legacyId('alpha'))
    expect(findByName(projects, 'old')!.id).toBe(legacyId('_archive/old'))
    expect(settings.projectsMigratedAt).toBeTruthy()
    expect(settings.defaultWorkspace).toBe(root)

    const alpha = findByName(projects, 'alpha')!
    const beta = findByName(projects, 'beta')!
    const old = findByName(projects, 'old')!
    const canvas = await getCanvas()
    // positions re-keyed onto the new UUIDs, coordinates preserved exactly.
    expect(canvas.positions[alpha.id]).toEqual({ x: 11, y: 22 })
    expect(canvas.positions[beta.id]).toEqual({ x: 33, y: 44 })
    expect(canvas.positions[old.id]).toEqual({ x: 55, y: 66 })
    // orphan dropped; node_modules never imported, so 3 keys total.
    expect(Object.keys(canvas.positions)).toHaveLength(3)
  })

  it('is idempotent — a second run does not re-import, even after an entry is removed', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'og-reg-root-')))
    await mkdir(join(root, 'alpha'))
    await mkdir(join(root, 'beta'))
    await setSettings({ projectsRoot: root, archiveDirName: '_archive', excludePatterns: [] })

    await ensureProjectsMigrated()
    expect((await getSettings()).projects).toHaveLength(2)

    // User removes one, then a "new process" re-runs migration.
    const projects = (await getSettings()).projects!
    await removeProjectEntry(projects[0].path)
    __resetMigrationCacheForTests()
    await ensureProjectsMigrated()

    expect((await getSettings()).projects).toHaveLength(1) // NOT re-scanned to 2
  })

  it('fresh install (no projectsRoot) just stamps the sentinel and stays empty', async () => {
    await ensureProjectsMigrated()
    const settings = await getSettings()
    expect(settings.projects).toEqual([])
    expect(settings.projectsMigratedAt).toBeTruthy()
  })
})

describe('registry CRUD', () => {
  beforeEach(async () => {
    // Skip migration for these by stamping the sentinel.
    await setSettings({ projectsMigratedAt: new Date().toISOString(), projects: [] })
  })

  it('addProjectEntry registers a canonical path and is idempotent', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-reg-add-')))
    const a = await addProjectEntry(dir, 'hello')
    expect(a.path).toBe(dir)
    expect(a.description).toBe('hello')
    const b = await addProjectEntry(dir)
    expect(b.id).toBe(a.id) // same entry, not a duplicate
    expect((await getSettings()).projects).toHaveLength(1)
  })

  it('removeProjectEntry returns the entry and drops it (no disk change)', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-reg-rm-')))
    const a = await addProjectEntry(dir)
    const removed = await removeProjectEntry(dir)
    expect(removed?.id).toBe(a.id)
    expect((await getSettings()).projects).toHaveLength(0)
    expect(await removeProjectEntry(dir)).toBeNull()
  })

  it('updateProjectEntryPath preserves the id across a rename', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-reg-mv-')))
    const dir2 = await realpath(await mkdtemp(join(tmpdir(), 'og-reg-mv2-')))
    const a = await addProjectEntry(dir)
    const updated = await updateProjectEntryPath(dir, dir2)
    expect(updated?.id).toBe(a.id) // stable id
    expect(updated?.path).toBe(dir2)
    expect((await getSettings()).projects![0].path).toBe(dir2)
  })

  it('serializes concurrent adds — overlapping writes do not lose entries', async () => {
    const dirs = await Promise.all(
      Array.from({ length: 5 }, () =>
        mkdtemp(join(tmpdir(), 'og-reg-conc-')).then((p) => realpath(p)),
      ),
    )
    // Fire all five registrations at once; without the registry lock the
    // unlocked read-modify-write of settings.projects would drop most of them.
    await Promise.all(dirs.map((d) => addProjectEntry(d)))
    const persisted = (await getSettings()).projects ?? []
    expect(persisted).toHaveLength(5)
    expect(new Set(persisted.map((e) => e.path))).toEqual(new Set(dirs))
  })
})

describe('isDangerousImportTarget', () => {
  it('rejects filesystem root and home root', async () => {
    expect(await isDangerousImportTarget(resolve('/'), [])).toBe('filesystem-root')
    expect(await isDangerousImportTarget(await realpath(homedir()), [])).toBe('home-root')
  })

  it('rejects overlap with an existing entry (ancestor or descendant)', async () => {
    const entries: ProjectEntry[] = [
      { id: '1', path: '/Users/x/projects/app', addedAt: 't' },
    ]
    // descendant of an entry
    expect(await isDangerousImportTarget('/Users/x/projects/app/sub', entries)).toBe('overlap')
    // ancestor of an entry
    expect(await isDangerousImportTarget('/Users/x/projects', entries)).toBe('overlap')
    // exact duplicate counts as overlap (route handles 409 before this)
    expect(await isDangerousImportTarget('/Users/x/projects/app', entries)).toBe('overlap')
  })

  it('accepts an unrelated sibling directory', async () => {
    const entries: ProjectEntry[] = [
      { id: '1', path: '/Users/x/projects/app', addedAt: 't' },
    ]
    expect(await isDangerousImportTarget('/Users/x/projects/app-2', entries)).toBeNull()
    expect(await isDangerousImportTarget('/Users/x/other', entries)).toBeNull()
  })
})

describe('linkSharedProjectToFolder (member folder link)', () => {
  const PID = '55555555-5555-5555-5555-555555555555'
  const PID2 = '66666666-6666-6666-6666-666666666666'

  beforeEach(async () => {
    await setSettings({ projectsMigratedAt: new Date().toISOString(), projects: [] })
  })

  it('registers the chosen folder on the allowlist with the collabProjectId tag', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-link-')))
    const res = await linkSharedProjectToFolder(PID, dir)
    expect('entry' in res).toBe(true)
    if (!('entry' in res)) return
    expect(res.entry.path).toBe(dir) // canonical
    expect(res.entry.collabProjectId).toBe(PID)
    expect(res.entry.id).toBeTruthy()
    // The link is what puts the folder on the validateProjectPath allowlist —
    // Terminal/Claude can now spawn there. (The boundary is NOT weakened: only
    // this explicitly-linked path validates.)
    expect(await isValidProjectPath(dir)).toBe(true)
    expect(await isValidProjectPath(join(dir, '..'))).toBe(false)
    // Resolvable back by collabProjectId.
    expect(await findLinkedFolder(PID)).toBe(dir)
    expect(await findLinkedFolder(PID2)).toBeNull()
  })

  it('is idempotent when the SAME folder is re-linked', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-link-idem-')))
    const a = await linkSharedProjectToFolder(PID, dir)
    const b = await linkSharedProjectToFolder(PID, dir)
    expect('entry' in a && 'entry' in b).toBe(true)
    if ('entry' in a && 'entry' in b) expect(b.entry.id).toBe(a.entry.id)
    expect((await getSettings()).projects).toHaveLength(1)
  })

  it('rejects re-pointing an already-linked project at a different folder', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-link-a-')))
    const dir2 = await realpath(await mkdtemp(join(tmpdir(), 'og-link-b-')))
    await linkSharedProjectToFolder(PID, dir)
    const res = await linkSharedProjectToFolder(PID, dir2)
    expect(res).toEqual({ rejection: 'already-linked' })
    expect(await findLinkedFolder(PID)).toBe(dir) // unchanged
  })

  it('rejects a folder already registered as a plain project (duplicate)', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-link-dup-')))
    await addProjectEntry(dir)
    const res = await linkSharedProjectToFolder(PID, dir)
    expect(res).toEqual({ rejection: 'duplicate' })
  })

  it('rejects a folder that overlaps an existing project', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'og-link-ov-')))
    const child = join(parent, 'nested')
    await mkdir(child)
    await addProjectEntry(parent)
    const res = await linkSharedProjectToFolder(PID, child)
    expect(res).toEqual({ rejection: 'overlap' })
  })

  it('rejects the home root (dangerous target guard is reused)', async () => {
    const res = await linkSharedProjectToFolder(PID, await realpath(homedir()))
    expect(res).toEqual({ rejection: 'home-root' })
  })
})
