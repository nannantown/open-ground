import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// child_process.execFile is the ONLY OS seam POST /api/project/delete touches
// (it execFiles the buildTrashCommand pair). Mocking it keeps the suite
// hermetic — no osascript, no real Trash — and, crucially, lets us assert the
// negative: a rejected delete must never invoke the trash command at all. Were
// this unmocked, a regression of the bug under test would silently trash a real
// directory while the test ran. Everything else in the module graph (spawn, the
// git helpers) keeps its real implementation.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: execFileMock }
})

import { app } from '../../app'
import { buildTrashCommand } from '../project'
import {
  __resetMigrationCacheForTests,
  relocateProjectEntry,
} from '@/lib/server/registry'
import { getCanvas, getSettings, setCanvas } from '@/lib/server/store'
import { isValidProjectPath } from '@/lib/server/projectDataPath'
import { projectCentralDir, centralWorktreesDir } from '@/lib/server/paths'

// Route contract for POST /api/project/delete's ROOT-ONLY guard.
//
// validateProjectPath answers "is this at or under SOME registered project (or
// one of its central worktrees)?" — deliberately permissive, because reads and
// writes of project data legitimately address descendants. Delete trashes the
// path it is handed, so that predicate is too weak: `<root>/src` passes it,
// gets trashed, and then removeProjectEntry's exact-match lookup returns null —
// leaving the registry entry, the canvas card and the central data dir intact
// while the route answers ok:true. These tests pin the stronger rule: only an
// exact registered project root may be deleted.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  )

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-del-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-del-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  execFileMock.mockReset()
  // Default: the trash command "succeeds" (callback style — project.ts
  // promisifies execFile).
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const done = callArgs.find((a) => typeof a === 'function') as
      | ((e: Error | null, out?: unknown) => void)
      | undefined
    done?.(null, { stdout: '', stderr: '' })
  })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

/** Register a real folder as a project and give it central data (tasks.json),
 *  so "the central store survived / was reaped" is observable on disk. */
const makeProject = async (name: string): Promise<{ root: string; id: string }> => {
  const root = join(scratch, name)
  await mkdir(root)
  await writeFile(join(root, 'README.md'), `# ${name}\n`)
  expect((await app.request('/api/projects/import', json({ path: root }))).status).toBe(200)

  // Writing a task materializes ~/.openground/projects/<id>/tasks.json.
  expect(
    (await app.request('/api/project/tasks', json({ path: root, add: ['keep me'] }))).status,
  ).toBe(200)

  const entry = (await getSettings()).projects?.find((e) => e.path === root)
  expect(entry, 'import should register the folder under its canonical path').toBeTruthy()
  return { root, id: entry!.id }
}

const registeredPaths = async (): Promise<string[]> =>
  ((await getSettings()).projects ?? []).map((e) => e.path)

describe('POST /api/project/delete — only a registered project ROOT may be deleted', () => {
  it('rejects a descendant of a registered project without trashing anything', async () => {
    const { root, id } = await makeProject('proj')
    const child = join(root, 'src')
    await mkdir(child)
    await writeFile(join(child, 'index.ts'), 'export {}\n')

    const res = await app.request('/api/project/delete', json({ path: child }))

    // Rejected — and NOT with the old "ok:true while half-deleting" shape.
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/project root/i)

    // The trash command never ran: the child folder is untouched on disk.
    expect(execFileMock).not.toHaveBeenCalled()
    expect(await exists(child)).toBe(true)
    expect(await exists(join(child, 'index.ts'))).toBe(true)

    // …and the project is still fully intact: registry entry, central data.
    expect(await registeredPaths()).toEqual([root])
    expect(await exists(join(projectCentralDir(id), 'tasks.json'))).toBe(true)
  })

  it('rejects a dotfile/child path that would gut the repo (.git)', async () => {
    const { root } = await makeProject('proj')
    const gitDir = join(root, '.git')
    await mkdir(gitDir)

    const res = await app.request('/api/project/delete', json({ path: gitDir }))
    expect(res.status).toBe(403)
    // Pin WHICH guard rejected it: the root check, not the outer allowlist —
    // otherwise this test could go green for the wrong reason if
    // validateProjectPath ever started rejecting descendants on its own.
    expect((await res.json()).error).toMatch(/project root/i)
    expect(execFileMock).not.toHaveBeenCalled()
    expect(await exists(gitDir)).toBe(true)
  })

  it('rejects a central worktree path (validateProjectPath allows it; delete must not)', async () => {
    const { id } = await makeProject('proj')
    const wt = join(centralWorktreesDir(id), 'run-1')
    await mkdir(wt, { recursive: true })

    // Sanity: this path IS inside the security boundary — that is exactly why
    // validateProjectPath alone was the wrong guard for a destructive route.
    expect(await isValidProjectPath(wt)).toBe(true)

    const res = await app.request('/api/project/delete', json({ path: wt }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/project root/i)
    expect(execFileMock).not.toHaveBeenCalled()
    expect(await exists(wt)).toBe(true)
  })

  it('deletes a registered root: trashes it, unregisters it, reaps canvas position + central data', async () => {
    const { root, id } = await makeProject('proj')
    const before = await getCanvas()
    await setCanvas({ ...before, positions: { ...before.positions, [id]: { x: 10, y: 20 } } })

    const res = await app.request('/api/project/delete', json({ path: root }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    // Trashed exactly once, with the platform's own command for this root.
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const expected = buildTrashCommand(process.platform, root)
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]]
    expect(cmd).toBe(expected.cmd)
    expect(args).toEqual(expected.args)

    // Registry, canvas position and the central store are all gone.
    expect(await registeredPaths()).toEqual([])
    expect((await getCanvas()).positions[id]).toBeUndefined()
    expect(await exists(projectCentralDir(id))).toBe(false)
  })

  it('trashes the canonical root when handed a symlink to it (not the link itself)', async () => {
    const { root } = await makeProject('proj')
    const link = join(scratch, 'proj-link')
    await symlink(root, link)

    const res = await app.request('/api/project/delete', json({ path: link }))
    expect(res.status).toBe(200)

    // resolve() would have kept the link path and trashed the LINK, leaving the
    // real folder behind while the registry (which canonicalizes) called it gone.
    const [, args] = execFileMock.mock.calls[0] as [string, string[]]
    expect(args).toEqual(buildTrashCommand(process.platform, root).args)
    expect(args).not.toContain(link)
    expect(await registeredPaths()).toEqual([])
  })

  it('does not reap central data of a project that a racing relocate moved out from under the delete', async () => {
    const { root, id } = await makeProject('proj')
    const moved = join(scratch, 'proj-moved')
    await mkdir(moved)

    // The trash step is unlocked and can run for up to 30s. Drive the race
    // deterministically: relocate the entry BY ID (re-pointing it at a folder
    // that survives) from inside the trash call, i.e. after the handler already
    // captured the entry but before it unregisters by path.
    execFileMock.mockImplementation(async (...callArgs: unknown[]) => {
      const done = callArgs.find((a) => typeof a === 'function') as
        | ((e: Error | null, out?: unknown) => void)
        | undefined
      await relocateProjectEntry(id, moved)
      done?.(null, { stdout: '', stderr: '' })
    })

    const res = await app.request('/api/project/delete', json({ path: root }))
    expect(res.status).toBe(200)

    // The by-path removal no-ops (the entry no longer lives at `root`), so the
    // project is still registered — and its Board/Canvas store MUST survive.
    // Reaping the pre-trash id here would wipe a project still on the canvas.
    expect(await registeredPaths()).toEqual([moved])
    expect(await exists(join(projectCentralDir(id), 'tasks.json'))).toBe(true)
  })

  it('leaves the registry and central data intact when the trash command fails', async () => {
    const { root, id } = await makeProject('proj')
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const done = callArgs.find((a) => typeof a === 'function') as
        | ((e: Error) => void)
        | undefined
      done?.(Object.assign(new Error('trash failed'), { stderr: 'nope' }))
    })

    const res = await app.request('/api/project/delete', json({ path: root }))
    expect(res.status).toBe(500)

    expect(await registeredPaths()).toEqual([root])
    expect(await exists(join(projectCentralDir(id), 'tasks.json'))).toBe(true)
  })

  it('still 403s a path outside every registered project (unchanged boundary)', async () => {
    await makeProject('proj')
    const res = await app.request('/api/project/delete', json({ path: '/etc' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/not allowed/i)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
