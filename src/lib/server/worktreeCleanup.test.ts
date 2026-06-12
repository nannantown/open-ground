import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseWorktreePorcelain,
  isUnderCentralDir,
  listProjectWorktrees,
  cleanProjectWorktrees,
} from './worktreeCleanup'
import { centralWorktreesDir } from './paths'
import { canonicalize } from './canonicalize'
import { registerTestProject } from '../../test/registerProject'

// Engine tests against REAL git repos + REAL worktrees (gitBranches/gitShare
// flavor): the repo lives in a tmpdir and is REGISTERED via the test registry
// helper (projectUUIDFromPath needs an owning entry — same harness as
// projectDataPath.test.ts), so its central worktrees dir resolves under the
// suite's isolated OPENGROUND_HOME (setup-home.ts), never the real one. Git's
// global/system config is kept out via HOME redirection (gitShare.test.ts
// pattern) so commit.gpgsign etc. can't bend the fixtures.

vi.setConfig({ testTimeout: 30_000 })

const execFile = promisify(execFileCb)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd })).stdout

let scratch: string
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-wtclean-')))
  savedEnv = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  }
  const gitHome = join(scratch, 'githome')
  await mkdir(gitHome)
  await writeFile(
    join(gitHome, '.gitconfig'),
    '[user]\n\tname = OG Test\n\temail = og-test@example.com\n' +
      '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
  )
  process.env.HOME = gitHome
  process.env.XDG_CONFIG_HOME = join(gitHome, '.config')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(scratch, { recursive: true, force: true })
})

/** A registered repo with one commit; returns { dir, uuid, central }. */
const makeProject = async () => {
  const dir = join(scratch, 'repo')
  await mkdir(dir)
  await git(dir, ['init'])
  await writeFile(join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'init'])
  const uuid = await registerTestProject(dir)
  const central = centralWorktreesDir(uuid)
  await mkdir(central, { recursive: true })
  return { dir, uuid, central }
}

/** `git worktree add <central>/<name> -b <branch>` from the main repo. */
const addCentralWorktree = async (
  repo: string,
  central: string,
  name: string,
  branch: string,
): Promise<string> => {
  const wt = join(central, name)
  await git(repo, ['worktree', 'add', '-b', branch, wt])
  return canonicalize(wt)
}

const exists = async (p: string) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// ── Pure parts ───────────────────────────────────────────────────────────────

describe('parseWorktreePorcelain', () => {
  it('extracts dir + short branch per stanza, null branch on detached HEAD', () => {
    const out = [
      'worktree /Users/x/repo',
      'HEAD aaaa',
      'branch refs/heads/main',
      '',
      'worktree /Users/x/.openground/projects/u/worktrees/task-fix',
      'HEAD bbbb',
      'branch refs/heads/task/fix',
      '',
      'worktree /Users/x/.openground/projects/u/worktrees/detached',
      'HEAD cccc',
      'detached',
      '',
    ].join('\n')
    expect(parseWorktreePorcelain(out)).toEqual([
      { dir: '/Users/x/repo', branch: 'main' },
      { dir: '/Users/x/.openground/projects/u/worktrees/task-fix', branch: 'task/fix' },
      { dir: '/Users/x/.openground/projects/u/worktrees/detached', branch: null },
    ])
  })

  it('handles empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([])
  })
})

describe('isUnderCentralDir', () => {
  it('matches the dir itself and descendants, sep-terminated (no -evil sibling)', () => {
    expect(isUnderCentralDir('/a/worktrees', '/a/worktrees')).toBe(true)
    expect(isUnderCentralDir('/a/worktrees/task-x', '/a/worktrees')).toBe(true)
    expect(isUnderCentralDir('/a/worktrees-evil', '/a/worktrees')).toBe(false)
    expect(isUnderCentralDir('/a', '/a/worktrees')).toBe(false)
  })
})

// ── Real-git engine ──────────────────────────────────────────────────────────

describe('listProjectWorktrees', () => {
  it('lists ONLY central worktrees (never the main tree or outside ones), with branch + dirty', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')
    const dirty = await addCentralWorktree(dir, central, 'review-b', 'review/b')
    await writeFile(join(dirty, 'wip.txt'), 'uncommitted\n')
    // A worktree OUTSIDE the central dir must be invisible to this module.
    await git(dir, ['worktree', 'add', '-b', 'feat/outside', join(scratch, 'outside-wt')])

    const list = await listProjectWorktrees(dir)
    expect(list.map((w) => w.dir).sort()).toEqual([clean, dirty].sort())
    expect(list.find((w) => w.dir === clean)).toEqual({
      dir: clean,
      branch: 'task/a',
      dirty: false,
    })
    expect(list.find((w) => w.dir === dirty)).toEqual({
      dir: dirty,
      branch: 'review/b',
      dirty: true,
    })
  })

  it('returns [] for a registered non-git folder', async () => {
    const dir = join(scratch, 'plain')
    await mkdir(dir)
    await registerTestProject(dir)
    expect(await listProjectWorktrees(dir)).toEqual([])
  })

  it('throws for an unregistered path (no registry entry → no central dir)', async () => {
    const stray = join(scratch, 'stray')
    await mkdir(stray)
    await expect(listProjectWorktrees(stray)).rejects.toThrow(/no registered project/)
  })
})

describe('cleanProjectWorktrees', () => {
  it('removes clean central worktrees, SKIPS dirty ones, leaves main tree + outside untouched', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')
    const dirtyUntracked = await addCentralWorktree(dir, central, 'task-b', 'task/b')
    await writeFile(join(dirtyUntracked, 'wip.txt'), 'uncommitted\n')
    const dirtyModified = await addCentralWorktree(dir, central, 'review-c', 'review/c')
    await writeFile(join(dirtyModified, 'README.md'), 'edited\n')
    const outside = join(scratch, 'outside-wt')
    await git(dir, ['worktree', 'add', '-b', 'feat/outside', outside])

    const result = await cleanProjectWorktrees(dir)
    expect(result.removed).toEqual([clean])
    expect(result.skippedDirty.sort()).toEqual([dirtyModified, dirtyUntracked].sort())

    // Disk reflects the report; dirty work and everything non-central survive.
    expect(await exists(clean)).toBe(false)
    expect(await exists(join(dirtyUntracked, 'wip.txt'))).toBe(true)
    expect(await exists(join(dirtyModified, 'README.md'))).toBe(true)
    expect(await exists(outside)).toBe(true)
    expect(await exists(join(dir, 'README.md'))).toBe(true)

    // git's own bookkeeping agrees (removed one is pruned from the list).
    const after = await listProjectWorktrees(dir)
    expect(after.map((w) => w.dir).sort()).toEqual([dirtyModified, dirtyUntracked].sort())

    // Idempotent: a second pass removes nothing and still skips the dirty pair.
    const again = await cleanProjectWorktrees(dir)
    expect(again.removed).toEqual([])
    expect(again.skippedDirty.sort()).toEqual([dirtyModified, dirtyUntracked].sort())
  })

  it('no central worktrees → { removed: [], skippedDirty: [] }', async () => {
    const { dir } = await makeProject()
    expect(await cleanProjectWorktrees(dir)).toEqual({ removed: [], skippedDirty: [] })
  })
})
