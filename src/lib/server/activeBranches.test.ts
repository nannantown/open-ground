import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { listActiveBranches } from './activeBranches'

// Tests against REAL local git fixtures + REAL worktrees in a tmpdir
// (gitBranches.test.ts house style) — no mocks, no network. Git config is
// isolated per-command via `-c` flags so a machine's commit.gpgsign /
// defaultBranch can't bend these assertions.

vi.setConfig({ testTimeout: 30_000 })

const execFile = promisify(execFileCb)

/** Run git in a fixture dir with a self-contained identity/config. */
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

let scratch: string

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-activebranches-')))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** git init -b main + one commit, so refs/heads exists. */
async function makeRepo(name: string): Promise<string> {
  const dir = join(scratch, name)
  await mkdir(dir)
  await git(dir, ['init', '-b', 'main'])
  await writeFile(join(dir, 'README.md'), '# fixture\n')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'init'])
  return dir
}

const names = (r: Awaited<ReturnType<typeof listActiveBranches>>) =>
  r.branches.map((b) => b.name)
const byName = (
  r: Awaited<ReturnType<typeof listActiveBranches>>,
  name: string,
) => r.branches.find((b) => b.name === name)

describe('listActiveBranches', () => {
  it('lists every local branch current-first then alphabetical', async () => {
    const repo = await makeRepo('repo')
    await git(repo, ['branch', 'zeta'])
    await git(repo, ['branch', 'alpha'])
    await git(repo, ['branch', 'feat/voice'])

    const result = await listActiveBranches(repo)
    expect(result.isGit).toBe(true)
    expect(names(result)).toEqual(['main', 'alpha', 'feat/voice', 'zeta'])
  })

  it('marks the checked-out branch current with a worktree path; others null', async () => {
    const repo = await makeRepo('repo2')
    await git(repo, ['branch', 'idle'])

    const result = await listActiveBranches(repo)
    const main = byName(result, 'main')
    const idle = byName(result, 'idle')
    expect(main?.current).toBe(true)
    // The main working tree counts as the branch's active worktree.
    expect(main?.worktreePath).toBeTruthy()
    // A plain head with no worktree is listed but has no active location.
    expect(idle?.current).toBe(false)
    expect(idle?.worktreePath).toBeNull()
  })

  it('annotates a branch checked out in a linked worktree', async () => {
    const repo = await makeRepo('repo3')
    const wt = join(scratch, 'wt-feature')
    await git(repo, ['worktree', 'add', '-b', 'feature', wt])

    const result = await listActiveBranches(repo)
    expect(names(result)).toEqual(['main', 'feature'])
    const feature = byName(result, 'feature')
    // feature lives in the linked worktree, not the panel's own path.
    expect(feature?.current).toBe(false)
    expect(feature?.worktreePath).toBeTruthy()
    expect(feature?.worktreePath).toContain('wt-feature')
    // main is still the project path's own branch.
    expect(byName(result, 'main')?.current).toBe(true)
  })

  it('returns { isGit:false, branches:[] } for a non-git directory', async () => {
    const dir = join(scratch, 'plain')
    await mkdir(dir)
    expect(await listActiveBranches(dir)).toEqual({ isGit: false, branches: [] })
  })

  it('returns { isGit:false, branches:[] } for a nonexistent directory', async () => {
    expect(await listActiveBranches(join(scratch, 'nope'))).toEqual({
      isGit: false,
      branches: [],
    })
  })

  it('detached HEAD → no branch is current, branches still listed', async () => {
    const repo = await makeRepo('repo4')
    await git(repo, ['branch', 'other'])
    const sha = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await git(repo, ['checkout', '--detach', sha])

    const result = await listActiveBranches(repo)
    expect(result.isGit).toBe(true)
    expect(names(result).sort()).toEqual(['main', 'other'])
    expect(result.branches.every((b) => !b.current)).toBe(true)
  })
})
