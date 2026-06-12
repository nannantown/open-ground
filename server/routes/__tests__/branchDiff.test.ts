import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'

// Route-level contract for GET /api/project/branch-changes and
// GET /api/project/file-diff. The load-bearing part is the security edge:
// unregistered paths are 403'd (validateProjectPath — the registry is the
// allowlist) and `file` traversal (`..` / absolute) is 400'd BEFORE anything
// reaches git. Fixture pattern: tasks.test.ts (tmp home + /api/projects/import)
// plus a real tmpdir git repo (mergedBranches.test.ts).

vi.setConfig({ testTimeout: 30_000 })

const execFile = promisify(execFileCb)

const git = async (cwd: string, args: string[]): Promise<string> =>
  (
    await execFile(
      'git',
      [
        '-c', 'user.name=OG Test',
        '-c', 'user.email=og-test@example.com',
        '-c', 'commit.gpgsign=false',
        ...args,
      ],
      { cwd },
    )
  ).stdout

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-bdiff-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-bdiff-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

/** Register a dir as a project AND make it a git repo with one commit. */
const makeRegisteredRepo = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await git(dir, ['init', '-b', 'main'])
  await writeFile(join(dir, 'README.md'), '# fixture\noriginal line\n')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'init'])
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
  return dir
}

const fileDiffUrl = (path: string, file: string, scope = 'working') =>
  `/api/project/file-diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}&scope=${scope}`

describe('GET /api/project/file-diff — security edges', () => {
  it('rejects `..` traversal in file with 400 (never reaches git)', async () => {
    const dir = await makeRegisteredRepo('trav')
    for (const evil of ['../../etc/passwd', 'a/../../b.txt', '..\\win.txt', 'a/..']) {
      const res = await app.request(fileDiffUrl(dir, evil))
      expect(res.status, evil).toBe(400)
      expect((await res.json()).error).toMatch(/invalid file path/i)
    }
  })

  it('rejects absolute file paths with 400', async () => {
    const dir = await makeRegisteredRepo('abs')
    const res = await app.request(fileDiffUrl(dir, '/etc/passwd'))
    expect(res.status).toBe(400)
  })

  it('rejects a missing/empty file param with 400 and a bad scope with 400', async () => {
    const dir = await makeRegisteredRepo('params')
    expect((await app.request(fileDiffUrl(dir, ''))).status).toBe(400)
    expect((await app.request(fileDiffUrl(dir, 'README.md', 'sneaky'))).status).toBe(400)
  })

  it('403s an unregistered project path (validateProjectPath)', async () => {
    const outside = join(scratch, 'not-registered')
    await mkdir(outside)
    const res = await app.request(fileDiffUrl(outside, 'README.md'))
    expect(res.status).toBe(403)
  })

  it('happy path: working diff of a modified file comes back', async () => {
    const dir = await makeRegisteredRepo('happy')
    await writeFile(join(dir, 'README.md'), '# fixture\nCHANGED\n')
    const res = await app.request(fileDiffUrl(dir, 'README.md'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.truncated).toBe(false)
    expect(body.diff).toContain('+CHANGED')
  })
})

describe('GET /api/project/branch-changes', () => {
  it('403s an unregistered path; 400s a missing path', async () => {
    const outside = join(scratch, 'loose')
    await mkdir(outside)
    expect(
      (await app.request(`/api/project/branch-changes?path=${encodeURIComponent(outside)}`)).status,
    ).toBe(403)
    expect((await app.request('/api/project/branch-changes')).status).toBe(400)
  })

  it('answers the full shape for a registered git repo', async () => {
    const dir = await makeRegisteredRepo('shape')
    await writeFile(join(dir, 'untracked.txt'), 'new\n')
    const res = await app.request(
      `/api/project/branch-changes?path=${encodeURIComponent(dir)}`,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.isGit).toBe(true)
    expect(body.branch).toBe('main')
    expect(body.target).toBe('main')
    expect(body.sameBranch).toBe(true)
    expect(body.working).toEqual([{ status: '??', path: 'untracked.txt' }])
    expect(body.committed).toEqual([])
  })

  it('a registered NON-git folder answers { isGit: false }', async () => {
    const dir = join(scratch, 'plain')
    await mkdir(dir)
    await writeFile(join(dir, 'README.md'), 'hi\n')
    const imp = await app.request('/api/projects/import', json({ path: dir }))
    expect(imp.status).toBe(200)
    const res = await app.request(
      `/api/project/branch-changes?path=${encodeURIComponent(dir)}`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isGit: false })
  })
})
