import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, stat, symlink } from 'fs/promises'
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
import { listActiveTerminalCwds } from './terminal'
import {
  spawnSdkSession,
  terminateSdkSession,
  __resetSdkSessionsForTests,
  type SdkQueryFn,
} from './sdkSession'
import { registerTestProject } from '../../test/registerProject'

// The live-desk guard reads BOTH pools (liveDeskCwds.ts). The PTY half is mocked
// so the engine tests drive the live-cwd list directly (no real node-pty spawn),
// defaulting to [] (empty pool) so every pre-existing test behaves exactly as
// before. The SDK half is the REAL pool — its queryFn is injectable, so a live
// session can be seated without a real claude, which is what lets the regression
// below be driven end to end instead of through a second mock.
vi.mock('./terminal', () => ({ listActiveTerminalCwds: vi.fn(() => [] as string[]) }))
const liveCwdsMock = vi.mocked(listActiveTerminalCwds)

/** A session that stays open forever — a worker mid-task. */
const liveQuery: SdkQueryFn = () => ({
  async *[Symbol.asyncIterator]() {
    await new Promise(() => {})
    yield undefined // unreachable; a generator needs a yield
  },
})

// Engine tests against REAL git repos + REAL worktrees (gitBranches
// flavor): the repo lives in a tmpdir and is REGISTERED via the test registry
// helper (projectUUIDFromPath needs an owning entry — same harness as
// projectDataPath.test.ts), so its central worktrees dir resolves under the
// suite's isolated OPENGROUND_HOME (setup-home.ts), never the real one. Git's
// global/system config is kept out via HOME redirection (gitBranches.test.ts
// pattern) so commit.gpgsign etc. can't bend the fixtures.

// Real `git` subprocesses; kept per-file so the I/O-heavy intent stays visible
// at the top of the file, but the value matches the canonical ceiling in
// vitest.config.ts (60s) — a shorter value here would re-cap what it raised.
vi.setConfig({ testTimeout: 60_000 })

const execFile = promisify(execFileCb)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd })).stdout

let scratch: string
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  liveCwdsMock.mockReturnValue([]) // empty pool unless a test opts in
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
    if (value !== undefined) process.env[key] = value
    // NEVER unset the home vars: empty means the user's REAL ~/.openground
    // (paths.ts openGroundHome), and vitest reuses workers across files.
    else if (!['OPENGROUND_HOME', 'HOME'].includes(key)) delete process.env[key]
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

// ── Live-PTY guard ────────────────────────────────────────────────────────────
// A clean worktree that a running claude PTY occupies must NEVER be removed.
// The pool stores each PTY's RAW spawn cwd (terminal.ts keeps opts.cwd verbatim),
// so its normalization form can differ from the canonicalized worktree dir. The
// regression these lock: liveCwds are canonicalized to the same form before the
// match, so a symlink-only difference can't make a live worktree look removable.

describe('cleanProjectWorktrees — live PTY guard', () => {
  it('protects a clean worktree a live PTY occupies even when the pool reports a non-canonical (symlinked) cwd', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')

    // Reproduce the bug's preconditions: an alias of the central dir via a
    // symlink, so `<alias>/task-a` is a DIFFERENT string than the canonical
    // worktree dir yet resolves to it — exactly what a raw spawn cwd looks like
    // when HOME (or /var) is symlinked. The old code compared this raw form
    // against the canonical wt.dir, missed, and removed the live worktree.
    const aliasRoot = join(scratch, 'central-alias')
    await symlink(central, aliasRoot)
    const aliasCwd = join(aliasRoot, 'task-a')
    expect(aliasCwd).not.toBe(clean) // different string …
    expect(await canonicalize(aliasCwd)).toBe(clean) // … same real path
    liveCwdsMock.mockReturnValue([aliasCwd])

    const result = await cleanProjectWorktrees(dir)
    expect(result.removed).toEqual([])
    expect(result.skippedDirty).toEqual([clean])
    expect(await exists(clean)).toBe(true) // survived — not pulled out from under the session
  })

  it('protects a worktree when a live PTY sits in a SUBDIRECTORY of it (sep-terminated prefix)', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')
    const subdir = join(clean, 'src', 'nested')
    await mkdir(subdir, { recursive: true })
    liveCwdsMock.mockReturnValue([subdir]) // already canonical here; prefix branch

    const result = await cleanProjectWorktrees(dir)
    expect(result.removed).toEqual([])
    expect(result.skippedDirty).toEqual([clean])
    expect(await exists(clean)).toBe(true)
  })

  // THE regression this pair exists for (2026-07-31). The guard consulted the
  // PTY pool ONLY. An SDK worker has no PTY entry, so with the Agent SDK worker
  // dial on, every SDK worker's worktree read as abandoned — clean tree, no PTY
  // — and got `git worktree remove`d while claude was still working in it. The
  // module's own comment states the rule it was breaking: deleting a running
  // session's cwd out from under it is never acceptable.
  it('protects a clean worktree a live SDK session occupies (no PTY anywhere)', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')
    liveCwdsMock.mockReturnValue([]) // the PTY pool is EMPTY — as it is for an SDK worker
    const s = spawnSdkSession({ cwd: clean, options: {}, queryFn: liveQuery })
    try {
      const result = await cleanProjectWorktrees(dir)
      expect(result.removed).toEqual([])
      expect(result.skippedDirty).toEqual([clean])
      expect(await exists(clean)).toBe(true)
    } finally {
      terminateSdkSession(s.id)
      __resetSdkSessionsForTests()
    }
  })

  it('protects it when the live SDK session sits in a SUBDIRECTORY of the worktree', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')
    const subdir = join(clean, 'src', 'nested')
    await mkdir(subdir, { recursive: true })
    liveCwdsMock.mockReturnValue([])
    const s = spawnSdkSession({ cwd: subdir, options: {}, queryFn: liveQuery })
    try {
      const result = await cleanProjectWorktrees(dir)
      expect(result.removed).toEqual([])
      expect(await exists(clean)).toBe(true)
    } finally {
      terminateSdkSession(s.id)
      __resetSdkSessionsForTests()
    }
  })

  it('an SDK session in an UNRELATED dir does not spuriously protect (guard still discriminates)', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')
    liveCwdsMock.mockReturnValue([])
    const s = spawnSdkSession({
      cwd: join(scratch, 'somewhere-else'),
      options: {},
      queryFn: liveQuery,
    })
    try {
      const result = await cleanProjectWorktrees(dir)
      expect(result.removed).toEqual([clean])
      expect(await exists(clean)).toBe(false)
    } finally {
      terminateSdkSession(s.id)
      __resetSdkSessionsForTests()
    }
  })

  it('still removes the same clean worktree when the pool is empty (negative control — removal path intact)', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')
    liveCwdsMock.mockReturnValue([])

    const result = await cleanProjectWorktrees(dir)
    expect(result.removed).toEqual([clean])
    expect(await exists(clean)).toBe(false)
  })

  it('removes a clean worktree when the only live PTY is an UNRELATED dir (guard is not always-on)', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')
    // A live session somewhere else (e.g. another project / the main tree) must
    // not spuriously protect this worktree — proves isLive still discriminates.
    liveCwdsMock.mockReturnValue([join(scratch, 'somewhere-else')])

    const result = await cleanProjectWorktrees(dir)
    expect(result.removed).toEqual([clean])
    expect(await exists(clean)).toBe(false)
  })

  it('a sibling worktree whose path is a prefix-without-sep of a live cwd is NOT protected (no -evil match)', async () => {
    const { dir, central } = await makeProject()
    const clean = await addCentralWorktree(dir, central, 'task-a', 'task/a')
    // Live cwd = "<clean>-live": shares the string prefix but is a different
    // worktree. The sep-terminated check must not treat `clean` as live.
    liveCwdsMock.mockReturnValue([clean + '-live'])

    const result = await cleanProjectWorktrees(dir)
    expect(result.removed).toEqual([clean])
    expect(await exists(clean)).toBe(false)
  })
})
