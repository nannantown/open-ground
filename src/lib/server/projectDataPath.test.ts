import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { projectUUIDFromPath, isValidProjectPath, resetRegistryRootsMemo } from './projectDataPath'
import { removeProjectEntry } from './registry'
import { getSettings, setSettings } from './store'
import { projectCentralDir, centralWorktreesDir } from './paths'
import { readProjectData, writeProjectData } from './projectData'
import { createCanvas } from './canvasData'
import { registerTestProject } from '../../test/registerProject'

// The central-store resolver + the security boundary share one predicate
// (projectUUIDFromPath). These lock in the must-fixes from the design review:
// canonicalization, central-worktree resolution, throw-on-miss, and the rule
// that the bare central data root is NOT a valid project path.

describe('projectUUIDFromPath', () => {
  let dir: string
  let uuid: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-pdp-'))
    uuid = await registerTestProject(dir)
  })

  it('resolves a registered root, a trailing slash, and a symlink to the same uuid', async () => {
    expect(await projectUUIDFromPath(dir)).toBe(uuid)
    expect(await projectUUIDFromPath(dir + sep)).toBe(uuid)
    const linkDir = await mkdtemp(join(tmpdir(), 'og-link-'))
    const link = join(linkDir, 'alias')
    await symlink(dir, link)
    expect(await projectUUIDFromPath(link)).toBe(uuid)
  })

  it('resolves a central worktree subpath back to the owning uuid', async () => {
    const wt = join(centralWorktreesDir(uuid), 'run-1')
    await mkdir(wt, { recursive: true })
    expect(await projectUUIDFromPath(wt)).toBe(uuid)
    expect(await projectUUIDFromPath(join(wt, 'src', 'index.ts'))).toBe(uuid)
  })

  it('THROWS for an unregistered path (never builds projects/undefined/)', async () => {
    const stray = await mkdtemp(join(tmpdir(), 'og-stray-'))
    await expect(projectUUIDFromPath(stray)).rejects.toThrow(/no registered project/)
  })
})

describe('isValidProjectPath (security boundary)', () => {
  let dir: string
  let uuid: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-val-'))
    uuid = await registerTestProject(dir)
  })

  it('accepts the registered root and a central worktree path', async () => {
    expect(await isValidProjectPath(dir)).toBe(true)
    const wt = join(centralWorktreesDir(uuid), 'run-x')
    await mkdir(wt, { recursive: true })
    expect(await isValidProjectPath(wt)).toBe(true)
  })

  it('REJECTS the bare central data root and its non-worktree subdirs', async () => {
    expect(await isValidProjectPath(projectCentralDir(uuid))).toBe(false)
    expect(await isValidProjectPath(join(projectCentralDir(uuid), 'canvases'))).toBe(false)
    expect(await isValidProjectPath(join(projectCentralDir(uuid), 'task-attachments'))).toBe(false)
  })

  it('REJECTS a worktrees-evil sibling, a foreign uuid, and an unregistered path', async () => {
    expect(await isValidProjectPath(centralWorktreesDir(uuid) + '-evil')).toBe(false)
    expect(
      await isValidProjectPath(join(centralWorktreesDir('forged-uuid-0000'), 'x')),
    ).toBe(false)
    const stray = await mkdtemp(join(tmpdir(), 'og-stray2-'))
    expect(await isValidProjectPath(stray)).toBe(false)
  })
})

describe('no repo pollution', () => {
  it('writes per-project data to the central store, leaving zero files in the repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'og-nopol-'))
    const uuid = await registerTestProject(dir)

    await writeProjectData(dir, {
      description: '',
      tasks: [{ id: 't1', title: 'T', done: false, createdAt: 'x', boardColumn: 'todo' }],
      notes: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await createCanvas(dir)

    // The repo working tree stays clean — no .openground/ is ever created.
    await expect(stat(join(dir, '.openground'))).rejects.toThrow()

    // The data lives centrally (disk check — git-status alone wouldn't catch a
    // gitignored write, so the on-disk assertion is load-bearing).
    await expect(stat(join(projectCentralDir(uuid), 'tasks.json'))).resolves.toBeDefined()
    await expect(stat(join(projectCentralDir(uuid), 'canvases-index.json'))).resolves.toBeDefined()

    // And it round-trips through the resolver.
    const back = await readProjectData(dir)
    expect(back.tasks[0].id).toBe('t1')
  })
})

// The canonical roots of an unchanged registry are reused for a few seconds
// (2026-10-06): GET /api/ground/lamps resolved ~5 paths per project every 5 s,
// each re-realpathing every registered root — O(N²), ≈470 ms of CPU per poll on
// the owner's machine. The REGISTRY itself is still read fresh on every call.
describe('registry roots memo', () => {
  // MUTATION that turns this red: key the memo on time alone (drop the entries
  // from the key) — the removed project would still be accepted.
  it('refuses a project the moment it is removed, even right after a lookup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'og-memo-rm-'))
    await registerTestProject(dir)
    expect(await isValidProjectPath(dir)).toBe(true)
    await removeProjectEntry(dir)
    expect(await isValidProjectPath(dir)).toBe(false)
  })

  // The one thing that may age: the filesystem's answer for an UNCHANGED entry.
  // A registered root stored as a symlink (hand-edited settings) keeps its old
  // canonical form until the window passes. MUTATION that turns this red:
  // remove the memo (every call re-realpaths, so the re-point shows at once).
  it('reuses the canonical roots of an unchanged registry within the window', async () => {
    const a = await mkdtemp(join(tmpdir(), 'og-memo-a-'))
    const b = await mkdtemp(join(tmpdir(), 'og-memo-b-'))
    const linkDir = await mkdtemp(join(tmpdir(), 'og-memo-link-'))
    const link = join(linkDir, 'proj')
    await symlink(a, link)
    const projects = (await getSettings()).projects ?? []
    await setSettings({ projects: [...projects, { id: 'memo-sym', path: link, addedAt: new Date().toISOString() }] })
    resetRegistryRootsMemo()
    expect(await projectUUIDFromPath(join(a, 'x'))).toBe('memo-sym')
    await rm(link)
    await symlink(b, link)
    // Within the window: still the old canonical root.
    await expect(projectUUIDFromPath(join(b, 'x'))).rejects.toThrow(/no registered project/)
    resetRegistryRootsMemo()
    expect(await projectUUIDFromPath(join(b, 'x'))).toBe('memo-sym')
    expect(await isValidProjectPath(join(a, 'x'))).toBe(false)
  })
})
