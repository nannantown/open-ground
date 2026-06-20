import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { listProjectBranches } from './gitBranches'

// Tests against REAL local git fixtures in a tmpdir (REAL-fixtures house
// style) — no mocks, no network. HOME isolation for ~/.openground is handled
// by the global setup; git config isolation is per-command via `-c` flags so a
// machine's commit.gpgsign / defaultBranch can't bend these assertions.

// Real `git` subprocesses flake under the 5s default when the machine is
// loaded; generous ceiling, passing tests still finish well under it.
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
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-gitbranches-')))
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

describe('listProjectBranches', () => {
  it('returns current branch first, rest alphabetical', async () => {
    const repo = await makeRepo('repo')
    await git(repo, ['branch', 'zeta'])
    await git(repo, ['branch', 'alpha'])
    await git(repo, ['branch', 'feat/voice'])

    const result = await listProjectBranches(repo)
    expect(result.current).toBe('main')
    expect(result.branches).toEqual(['main', 'alpha', 'feat/voice', 'zeta'])
  })

  it('reflects a checked-out non-default branch as current', async () => {
    const repo = await makeRepo('repo2')
    await git(repo, ['checkout', '-b', 'work'])

    const result = await listProjectBranches(repo)
    expect(result.current).toBe('work')
    expect(result.branches[0]).toBe('work')
    expect(result.branches).toContain('main')
  })

  it('returns empty for a non-git directory (no throw)', async () => {
    const dir = join(scratch, 'plain')
    await mkdir(dir)

    const result = await listProjectBranches(dir)
    expect(result).toEqual({ branches: [], current: null })
  })

  it('returns empty for a nonexistent directory (no throw)', async () => {
    const result = await listProjectBranches(join(scratch, 'nope'))
    expect(result).toEqual({ branches: [], current: null })
  })

  it('handles a fresh repo with no commits (no refs yet)', async () => {
    const dir = join(scratch, 'fresh')
    await mkdir(dir)
    await git(dir, ['init', '-b', 'main'])

    const result = await listProjectBranches(dir)
    // No commit → refs/heads is empty and --show-current still says "main",
    // but "main" isn't a real ref yet, so it must not be invented — and
    // `current` must be CLAMPED to membership in `branches` (the select
    // consumer indexes options by it).
    expect(result).toEqual({ branches: [], current: null })
  })

  it('detached HEAD → current is null, branches still listed', async () => {
    const repo = await makeRepo('repo3')
    await git(repo, ['branch', 'other'])
    const sha = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await git(repo, ['checkout', '--detach', sha])

    const result = await listProjectBranches(repo)
    expect(result.current).toBeNull()
    expect(result.branches).toEqual(['main', 'other'])
  })
})
