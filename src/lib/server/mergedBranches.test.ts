import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkMergedBranches } from './mergedBranches'

// Tests against REAL local git fixtures in a tmpdir (gitBranches.test.ts house
// style) — no mocks, no network. The fixtures have no real remote, so the
// best-effort `git fetch origin <target>` inside checkMergedBranches simply
// fails silently — exactly the offline path the module promises to survive.

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
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-merged-')))
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

/** Commit a file on the CURRENT branch. */
async function commit(dir: string, file: string, msg: string): Promise<void> {
  await writeFile(join(dir, file), `${msg}\n`)
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', msg])
}

describe('checkMergedBranches', () => {
  it('classifies merged vs open vs unknown against main', async () => {
    const repo = await makeRepo('repo')
    // merged: branch with a commit, merged back into main.
    await git(repo, ['checkout', '-b', 'task/landed'])
    await commit(repo, 'landed.txt', 'landed work')
    await git(repo, ['checkout', 'main'])
    await git(repo, ['merge', '--no-ff', 'task/landed', '-m', 'merge landed'])
    // open: branch with a commit main never saw.
    await git(repo, ['checkout', '-b', 'task/open'])
    await commit(repo, 'open.txt', 'open work')
    await git(repo, ['checkout', 'main'])

    const result = await checkMergedBranches(repo, [
      'task/landed',
      'task/open',
      'task/never-existed',
    ])
    expect(result).toEqual({
      'task/landed': 'merged',
      'task/open': 'open',
      'task/never-existed': 'unknown',
    })
  })

  it('classifies a REBASE-merged branch (SHA differs from main) as merged via patch-id fallback', async () => {
    const repo = await makeRepo('repo-rebased')
    await git(repo, ['checkout', '-b', 'swarm/feat'])
    await commit(repo, 'feat1.txt', 'feat one')
    await commit(repo, 'feat2.txt', 'feat two')
    await git(repo, ['checkout', 'main'])
    // main diverges so the eventual rebase actually replays (new SHAs), not a no-op FF.
    await commit(repo, 'main-progress.txt', 'main moved on')
    // Simulate the manager rebasing swarm/feat onto main and landing it — the
    // branch itself is left at its ORIGINAL (pre-rebase) commits, exactly like
    // a real rebase-and-push workflow where the source branch isn't force-updated.
    await git(repo, ['checkout', '-b', '_rebased', 'swarm/feat'])
    await git(repo, ['rebase', 'main'])
    await git(repo, ['checkout', 'main'])
    await git(repo, ['merge', '--ff-only', '_rebased'])

    // merge-base --is-ancestor must NOT see swarm/feat as an ancestor (different SHAs).
    await expect(
      execFile('git', ['merge-base', '--is-ancestor', 'swarm/feat', 'main'], { cwd: repo }),
    ).rejects.toThrow()

    const result = await checkMergedBranches(repo, ['swarm/feat'])
    expect(result['swarm/feat']).toBe('merged')
  })

  it('keeps a branch with a commit absent from main as open (patch-id fallback does not over-merge)', async () => {
    const repo = await makeRepo('repo-still-open')
    await commit(repo, 'main-progress.txt', 'main moved on')
    await git(repo, ['checkout', '-b', 'swarm/wip'])
    await commit(repo, 'wip.txt', 'not yet merged anywhere')

    const result = await checkMergedBranches(repo, ['swarm/wip'])
    expect(result['swarm/wip']).toBe('open')
  })

  it('a branch pointing AT main tip counts as merged (fresh branch, no commits)', async () => {
    const repo = await makeRepo('repo-same')
    await git(repo, ['branch', 'task/fresh'])
    const result = await checkMergedBranches(repo, ['task/fresh'])
    expect(result['task/fresh']).toBe('merged')
  })

  it('honours an explicit targetBranch over the default', async () => {
    const repo = await makeRepo('repo-target')
    await git(repo, ['checkout', '-b', 'develop'])
    await git(repo, ['checkout', '-b', 'task/x'])
    await commit(repo, 'x.txt', 'x work')
    await git(repo, ['checkout', 'develop'])
    await git(repo, ['merge', '--no-ff', 'task/x', '-m', 'merge x'])
    await git(repo, ['checkout', 'main'])

    // Merged into develop, NOT into main.
    expect((await checkMergedBranches(repo, ['task/x'], 'develop'))['task/x']).toBe(
      'merged',
    )
    expect((await checkMergedBranches(repo, ['task/x'], 'main'))['task/x']).toBe('open')
  })

  it('falls back to origin/HEAD when no targetBranch is given', async () => {
    const repo = await makeRepo('repo-head')
    // Default branch is 'trunk' here — 'main' must NOT be assumed.
    await git(repo, ['branch', '-m', 'main', 'trunk'])
    await git(repo, ['checkout', '-b', 'task/y'])
    await commit(repo, 'y.txt', 'y work')
    await git(repo, ['checkout', 'trunk'])
    await git(repo, ['merge', '--no-ff', 'task/y', '-m', 'merge y'])
    // Simulate a clone's remote-tracking state: origin/trunk + origin/HEAD.
    const tip = (await git(repo, ['rev-parse', 'trunk'])).trim()
    await git(repo, ['update-ref', 'refs/remotes/origin/trunk', tip])
    await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'])

    const result = await checkMergedBranches(repo, ['task/y'])
    expect(result['task/y']).toBe('merged')
  })

  it('finds a branch tip that exists ONLY as a remote-tracking ref', async () => {
    const repo = await makeRepo('repo-remote')
    await git(repo, ['checkout', '-b', 'task/remote-only'])
    await commit(repo, 'r.txt', 'remote work')
    await git(repo, ['checkout', 'main'])
    await git(repo, ['merge', '--no-ff', 'task/remote-only', '-m', 'merge remote'])
    // Move the tip to a remote-tracking ref and delete the local branch — the
    // reviewer-machine shape (only origin/<branch> exists).
    const tip = (await git(repo, ['rev-parse', 'task/remote-only'])).trim()
    await git(repo, ['update-ref', 'refs/remotes/origin/task/remote-only', tip])
    await git(repo, ['branch', '-D', 'task/remote-only'])

    const result = await checkMergedBranches(repo, ['task/remote-only'], 'main')
    expect(result['task/remote-only']).toBe('merged')
  })

  it('returns unknown for invalid branch names (never reach git argv)', async () => {
    const repo = await makeRepo('repo-bad')
    const result = await checkMergedBranches(
      repo,
      ['-rf', 'a..b', '', 'has space', 'task/ok-but-missing'],
      'main',
    )
    expect(result).toEqual({
      '-rf': 'unknown',
      'a..b': 'unknown',
      '': 'unknown',
      'has space': 'unknown',
      'task/ok-but-missing': 'unknown',
    })
  })

  it('an invalid targetBranch yields all-unknown (no judgment attempted)', async () => {
    const repo = await makeRepo('repo-bad-target')
    await git(repo, ['branch', 'task/z'])
    const result = await checkMergedBranches(repo, ['task/z'], '--upload-pack=evil')
    expect(result['task/z']).toBe('unknown')
  })

  it('a nonexistent target branch yields all-unknown (judgment skipped)', async () => {
    const repo = await makeRepo('repo-no-target')
    await git(repo, ['branch', 'task/z'])
    const result = await checkMergedBranches(repo, ['task/z'], 'release/nope')
    expect(result['task/z']).toBe('unknown')
  })

  it('degrades to all-unknown on a non-git directory (no throw)', async () => {
    const dir = join(scratch, 'plain')
    await mkdir(dir)
    const result = await checkMergedBranches(dir, ['task/a', 'task/b'])
    expect(result).toEqual({ 'task/a': 'unknown', 'task/b': 'unknown' })
  })

  it('handles an empty branch list without touching git', async () => {
    const result = await checkMergedBranches(join(scratch, 'nope'), [])
    expect(result).toEqual({})
  })
})
