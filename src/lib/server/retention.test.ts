import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath, utimes, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  pruneOldRunFiles,
  pruneOldAttachments,
  pruneGhostHeartbeats,
  pruneOrphanCentralWorktrees,
  findOrphanCentralDataDirs,
  sweepCrossRepoResidue,
  GHOST_HEARTBEAT_HOURS,
  RAW_RETENTION_DAYS,
} from './retention'
import { runsDir, openGroundHome, projectsDataRootDir, centralWorktreesDir } from './paths'
import { projectDataDir } from './projectDataPath'
import { registerTestProject } from '../../test/registerProject'

// Retention safety (goal condition 3): the boot sweep must NEVER delete LIVE
// data. It is scoped to the EPISODIC layer only — the legacy run cache
// (~/.openground/runs/*.json) and per-project task-attachments/. tasks.json,
// canvases, and the canvas index must be untouchable by it. HOME is the
// throwaway test home (setup-home.ts), so runsDir() and projectDataDir() resolve
// under tmpdir, never the real ~/.openground.
//
// Determinism: the retention window is RAW_RETENTION_DAYS (14d). Every age here
// is FAR from that boundary — "old" = 30d ago, "recent" = 1h ago — so a busy CPU
// can never flip a near-boundary case (the card 9961d28d flaky lesson). Ages are
// pinned with utimes (mtime) and explicit past/future ISO `finishedAt`, never
// real sleeps.

const DAY_MS = 24 * 60 * 60 * 1000
const OLD = () => new Date(Date.now() - 30 * DAY_MS) // well past the 14d window
const RECENT = () => new Date(Date.now() - 60 * 60 * 1000) // 1h ago, well inside

const setMtime = async (path: string, when: Date) => {
  await utimes(path, when, when)
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('pruneOldRunFiles — run-cache retention safety', () => {
  beforeEach(async () => {
    // Each test in this file shares the per-worker HOME; reset runsDir so a
    // previous test's files can't leak into this one's sweep.
    await rm(runsDir(), { recursive: true, force: true })
    await mkdir(runsDir(), { recursive: true })
  })
  afterEach(async () => {
    await rm(runsDir(), { recursive: true, force: true }).catch(() => {})
  })

  const writeRun = async (
    name: string,
    body: unknown | string,
    mtime?: Date,
  ): Promise<string> => {
    const full = join(runsDir(), name)
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    await writeFile(full, text, 'utf8')
    if (mtime) await setMtime(full, mtime)
    return full
  }

  it('deletes a finished run older than the retention window', async () => {
    const f = await writeRun('old-finished.json', {
      finishedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    })
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(1)
    expect(await exists(f)).toBe(false)
  })

  it('keeps a finished run inside the retention window', async () => {
    const f = await writeRun('recent-finished.json', {
      finishedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(0)
    expect(await exists(f)).toBe(true)
  })

  it('NEVER deletes an in-flight run (no finishedAt), even with an ancient mtime', async () => {
    // The critical "don't delete live data" guarantee: a parseable run with no
    // finishedAt is skipped outright (the `continue`), never aged out by mtime.
    const f = await writeRun('in-flight.json', { startedAt: 'x' }, OLD())
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(0)
    expect(await exists(f)).toBe(true)
  })

  it('deletes a CORRUPT run file only when its mtime is old (recovery: aged-out cache)', async () => {
    const oldCorrupt = await writeRun('old-corrupt.json', '{not valid json', OLD())
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(1)
    expect(await exists(oldCorrupt)).toBe(false)
  })

  it('KEEPS a corrupt run file whose mtime is recent (could be a fresh write)', async () => {
    const freshCorrupt = await writeRun('fresh-corrupt.json', '{half-writ', RECENT())
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(0)
    expect(await exists(freshCorrupt)).toBe(true)
  })

  it('ignores non-.json files entirely (never deletes them, regardless of age)', async () => {
    const notJson = await writeRun('notes.txt', 'arbitrary', OLD())
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(0)
    expect(await exists(notJson)).toBe(true)
  })

  it('returns 0 without throwing when runsDir does not exist', async () => {
    await rm(runsDir(), { recursive: true, force: true })
    await expect(pruneOldRunFiles()).resolves.toBe(0)
  })

  it('a single corrupt/old file does not stop the sweep from pruning the rest', async () => {
    await writeRun('a-old.json', { finishedAt: new Date(Date.now() - 30 * DAY_MS).toISOString() })
    await writeRun('b-inflight.json', { startedAt: 'x' }, OLD()) // kept
    await writeRun('c-old.json', { finishedAt: new Date(Date.now() - 30 * DAY_MS).toISOString() })
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(2)
    expect(await exists(join(runsDir(), 'b-inflight.json'))).toBe(true)
  })
})

describe('pruneOldAttachments — per-project attachment retention safety', () => {
  let dir: string
  let dataDir: string
  let attachDir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-retain-'))
    await registerTestProject(dir)
    dataDir = await projectDataDir(dir)
    attachDir = join(dataDir, 'task-attachments')
    await mkdir(attachDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('deletes an attachment older than the window, keeps a recent one', async () => {
    const old = join(attachDir, 'old.png')
    const recent = join(attachDir, 'recent.png')
    await writeFile(old, 'x', 'utf8')
    await writeFile(recent, 'y', 'utf8')
    await setMtime(old, OLD())
    await setMtime(recent, RECENT())
    const removed = await pruneOldAttachments(dir)
    expect(removed).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(recent)).toBe(true)
  })

  it('returns 0 without throwing when task-attachments dir is absent', async () => {
    await rm(attachDir, { recursive: true, force: true })
    await expect(pruneOldAttachments(dir)).resolves.toBe(0)
  })

  it('a subdirectory inside task-attachments is never deleted (unlink EISDIR is skipped)', async () => {
    const sub = join(attachDir, 'nested')
    await mkdir(sub, { recursive: true })
    await setMtime(sub, OLD())
    const removed = await pruneOldAttachments(dir)
    expect(removed).toBe(0)
    expect(await exists(sub)).toBe(true)
  })
})

// THE goal-condition-3 guarantee: running the FULL boot sweep leaves every piece
// of LIVE project data (board tasks, canvases, the canvas index, notes) exactly
// where it was. Retention's blast radius is runs/ + task-attachments/ ONLY.
describe('retention never touches live project data', () => {
  let dir: string
  let dataDir: string
  beforeEach(async () => {
    await rm(runsDir(), { recursive: true, force: true })
    await mkdir(runsDir(), { recursive: true })
    dir = await mkdtemp(join(tmpdir(), 'og-retain-live-'))
    await registerTestProject(dir)
    dataDir = await projectDataDir(dir)
    await mkdir(join(dataDir, 'canvases'), { recursive: true })
    await mkdir(join(dataDir, 'task-attachments'), { recursive: true })
  })
  afterEach(async () => {
    await rm(runsDir(), { recursive: true, force: true }).catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('leaves tasks.json / canvases / canvas index intact while pruning only the episodic layer', async () => {
    // Live data — all aged ancient on disk to prove age is NOT the deletion
    // criterion for these paths (they live outside retention's scope entirely).
    const tasksFile = join(dataDir, 'tasks.json')
    const canvasFile = join(dataDir, 'canvases', 'c1.json')
    const indexFile = join(dataDir, 'canvases-index.json')
    await writeFile(tasksFile, JSON.stringify({ tasks: [{ id: 't1' }], updatedAt: 'x' }), 'utf8')
    await writeFile(canvasFile, JSON.stringify({ id: 'c1', rev: 3 }), 'utf8')
    await writeFile(indexFile, JSON.stringify({ order: ['c1'], activeId: 'c1' }), 'utf8')
    for (const f of [tasksFile, canvasFile, indexFile]) await setMtime(f, OLD())

    // Episodic layer — old, should be pruned.
    await writeFile(
      join(runsDir(), 'old.json'),
      JSON.stringify({ finishedAt: new Date(Date.now() - 30 * DAY_MS).toISOString() }),
      'utf8',
    )
    const oldAttach = join(dataDir, 'task-attachments', 'old.bin')
    await writeFile(oldAttach, 'x', 'utf8')
    await setMtime(oldAttach, OLD())

    const removedRuns = await pruneOldRunFiles()
    const removedAttach = await pruneOldAttachments(dir)

    // Episodic layer pruned…
    expect(removedRuns).toBe(1)
    expect(removedAttach).toBe(1)
    expect(await exists(oldAttach)).toBe(false)
    // …but every piece of LIVE data survives untouched.
    expect(await exists(tasksFile)).toBe(true)
    expect(await exists(canvasFile)).toBe(true)
    expect(await exists(indexFile)).toBe(true)
    expect(JSON.parse(await readFile(tasksFile, 'utf8')).tasks).toHaveLength(1)
  })

  it('the retention window constant is the documented 14 days', () => {
    expect(RAW_RETENTION_DAYS).toBe(14)
  })
})

// ── Cross-repo residue sweep ──────────────────────────────────────────────────
// The boot sweep that reaches repos NO cockpit is running in (the per-repo
// janitor can't). Safety contract under test: a live heartbeat (its worktree
// exists), a fresh heartbeat (< 48h), a dirty orphan worktree, a LIVE worktree,
// and registered central data ALL survive; only provably-dead residue goes.
//
// Every case here swaps OPENGROUND_HOME to a per-test scratch home (the
// swarmJanitor.test.ts pattern) so the registry starts EMPTY — assertions on
// "everything under ~/.openground" are then fully deterministic. Ages are far
// from the 48h boundary: "old" = 30d, "fresh" = 1h (the flaky-CPU lesson).

const execFile = promisify(execFileCb)

/** Real git with hermetic identity (no reliance on the runner's gitconfig). */
const git = async (cwd: string, args: string[]): Promise<string> =>
  (
    await execFile(
      'git',
      [
        '-c', 'user.name=OG Test',
        '-c', 'user.email=og-test@example.com',
        '-c', 'commit.gpgsign=false',
        '-c', 'init.defaultBranch=main',
        ...args,
      ],
      { cwd },
    )
  ).stdout

describe('cross-repo residue sweep', () => {
  let scratch: string
  let savedHome: string | undefined
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-residue-')))
    savedHome = process.env.OPENGROUND_HOME
    process.env.OPENGROUND_HOME = join(scratch, 'home')
    await mkdir(join(scratch, 'home'), { recursive: true })
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    warnSpy.mockRestore()
    if (savedHome === undefined) delete process.env.OPENGROUND_HOME
    else process.env.OPENGROUND_HOME = savedHome
    await rm(scratch, { recursive: true, force: true })
  })

  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  /** A heartbeat file under the (hash-keyed) swarm dir, aged via mtime. */
  const writeHeartbeat = async (
    key: string,
    name: string,
    body: unknown | string,
    mtime?: Date,
  ): Promise<string> => {
    const dir = join(openGroundHome(), 'swarm', key)
    await mkdir(dir, { recursive: true })
    const full = join(dir, name)
    await writeFile(full, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    if (mtime) await setMtime(full, mtime)
    return full
  }

  /** A registered project backed by a REAL git repo (one tracked commit, so
   *  `git worktree add` checkouts have content). Returns repo path + uuid. */
  const mkRegisteredRepo = async (name: string): Promise<{ repo: string; uuid: string }> => {
    const repo = join(scratch, name)
    await mkdir(repo, { recursive: true })
    await git(repo, ['init', '-q'])
    await writeFile(join(repo, 'seed.txt'), 'seed', 'utf8')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-q', '-m', 'seed'])
    const uuid = await registerTestProject(repo)
    return { repo, uuid }
  }

  describe('pruneGhostHeartbeats — (a) ghost heartbeats + (b) empty key dirs', () => {
    it('sweeps an OLD heartbeat whose worktree is gone; the emptied key dir goes too', async () => {
      const f = await writeHeartbeat(
        'dead_repo-12345678',
        'swarm-w1.json',
        { branch: 'swarm/w1', worktree: join(scratch, 'no-such-worktree'), updatedAt: OLD().toISOString() },
        OLD(),
      )
      const report = await pruneGhostHeartbeats()
      expect(report.removedFiles).toEqual([f])
      expect(await exists(f)).toBe(false)
      // (b) the key dir emptied by the sweep is removed with it
      expect(report.removedDirs).toEqual([join(openGroundHome(), 'swarm', 'dead_repo-12345678')])
      expect(await exists(join(openGroundHome(), 'swarm', 'dead_repo-12345678'))).toBe(false)
    })

    it('keeps a FRESH heartbeat even when its worktree is gone (48h grace)', async () => {
      const f = await writeHeartbeat(
        'k-1',
        'swarm-w1.json',
        { worktree: join(scratch, 'gone'), updatedAt: RECENT().toISOString() },
        RECENT(),
      )
      const report = await pruneGhostHeartbeats()
      expect(report.removedFiles).toEqual([])
      expect(await exists(f)).toBe(true)
    })

    it('keeps an ancient heartbeat whose worktree still EXISTS (live workplace, age is irrelevant)', async () => {
      const wt = join(scratch, 'alive-worktree')
      await mkdir(wt, { recursive: true })
      const f = await writeHeartbeat('k-2', 'swarm-w2.json', { worktree: wt, updatedAt: OLD().toISOString() }, OLD())
      const report = await pruneGhostHeartbeats()
      expect(report.removedFiles).toEqual([])
      expect(await exists(f)).toBe(true)
      // its dir is non-empty → never rmdir'd
      expect(report.removedDirs).toEqual([])
    })

    it('a fresh updatedAt protects a file even when its mtime is ancient (newest signal wins)', async () => {
      const f = await writeHeartbeat(
        'k-3',
        'swarm-w3.json',
        { worktree: join(scratch, 'gone'), updatedAt: RECENT().toISOString() },
        OLD(), // mtime says old — updatedAt says fresh
      )
      const report = await pruneGhostHeartbeats()
      expect(report.removedFiles).toEqual([])
      expect(await exists(f)).toBe(true)
    })

    it('sweeps an OLD corrupt heartbeat, keeps a fresh corrupt one (mid-write protection)', async () => {
      const oldCorrupt = await writeHeartbeat('k-4', 'a.json', '{not json', OLD())
      const freshCorrupt = await writeHeartbeat('k-4', 'b.json', '{half-writ', RECENT())
      const report = await pruneGhostHeartbeats()
      expect(report.removedFiles).toEqual([oldCorrupt])
      expect(await exists(oldCorrupt)).toBe(false)
      expect(await exists(freshCorrupt)).toBe(true)
    })

    it('a RELATIVE worktree path is no liveness signal (malformed/foreign) — old file goes', async () => {
      const f = await writeHeartbeat('k-5', 'w.json', { worktree: 'not/absolute', updatedAt: OLD().toISOString() }, OLD())
      const report = await pruneGhostHeartbeats()
      expect(report.removedFiles).toEqual([f])
    })

    it('never touches non-.json files; a dir holding one is never removed', async () => {
      const note = await writeHeartbeat('k-6', 'README.txt', 'keep me', OLD())
      const ghost = await writeHeartbeat('k-6', 'g.json', { worktree: join(scratch, 'gone') }, OLD())
      const report = await pruneGhostHeartbeats()
      expect(await exists(ghost)).toBe(false)
      expect(await exists(note)).toBe(true)
      expect(report.removedDirs).toEqual([]) // dir still holds README.txt
      expect(await exists(join(openGroundHome(), 'swarm', 'k-6'))).toBe(true)
    })

    it('a key dir left with only Finder droppings (.DS_Store) is still removed', async () => {
      const ghost = await writeHeartbeat('k-7', 'g.json', { worktree: join(scratch, 'gone') }, OLD())
      await writeHeartbeat('k-7', '.DS_Store', 'finder junk', OLD())
      const report = await pruneGhostHeartbeats()
      expect(await exists(ghost)).toBe(false)
      expect(report.removedDirs).toEqual([join(openGroundHome(), 'swarm', 'k-7')])
      expect(await exists(join(openGroundHome(), 'swarm', 'k-7'))).toBe(false)
    })

    it('returns an empty report when no swarm dir exists at all', async () => {
      await expect(pruneGhostHeartbeats()).resolves.toEqual({ removedFiles: [], removedDirs: [] })
    })

    it('the ghost-heartbeat grace window is the documented 48 hours', () => {
      expect(GHOST_HEARTBEAT_HOURS).toBe(48)
    })
  })

  describe('pruneOrphanCentralWorktrees — (c) orphan central worktree dirs', () => {
    it('keeps a LIVE worktree (listed by the repo), removes an effectively-empty orphan, keeps+warns a DIRTY orphan', { timeout: 30_000 }, async () => {
      const { repo, uuid } = await mkRegisteredRepo('repo-a')
      const wtRoot = centralWorktreesDir(uuid)
      await mkdir(wtRoot, { recursive: true })

      // live: a real worktree the repo still lists
      const live = join(wtRoot, 'live')
      await git(repo, ['worktree', 'add', '-q', '--detach', live])

      // dirty orphan: real worktree + uncommitted file, then its metadata is
      // destroyed (the `git worktree prune`-style leftover)
      const dirty = join(wtRoot, 'dirty')
      await git(repo, ['worktree', 'add', '-q', '--detach', dirty])
      await writeFile(join(dirty, 'uncommitted.txt'), 'unsaved work', 'utf8')
      await rm(join(repo, '.git', 'worktrees', 'dirty'), { recursive: true, force: true })

      // effectively-empty orphans: a bare dir, and a husk holding only a dead gitfile
      const empty = join(wtRoot, 'empty')
      await mkdir(empty, { recursive: true })
      const husk = join(wtRoot, 'husk')
      await mkdir(husk, { recursive: true })
      await writeFile(join(husk, '.git'), `gitdir: ${join(scratch, 'nowhere', '.git', 'worktrees', 'husk')}\n`, 'utf8')

      const report = await pruneOrphanCentralWorktrees()

      expect(report.removed.sort()).toEqual([empty, husk].sort())
      expect(await exists(empty)).toBe(false)
      expect(await exists(husk)).toBe(false)

      expect(report.warned).toEqual([dirty])
      expect(await exists(join(dirty, 'uncommitted.txt'))).toBe(true) // unsaved work untouched
      expect(warnSpy).toHaveBeenCalledTimes(1)

      expect(await exists(live)).toBe(true) // live worktree untouched
      expect(await exists(join(live, 'seed.txt'))).toBe(true)
    })

    it('repo itself GONE: empty orphan dirs go, a checked-out one is kept (uncommitted state unprovable)', { timeout: 30_000 }, async () => {
      const { repo, uuid } = await mkRegisteredRepo('repo-b')
      const wtRoot = centralWorktreesDir(uuid)
      await mkdir(wtRoot, { recursive: true })
      const checkout = join(wtRoot, 'checkout')
      await git(repo, ['worktree', 'add', '-q', '--detach', checkout])
      const empty = join(wtRoot, 'empty')
      await mkdir(empty, { recursive: true })

      await rm(repo, { recursive: true, force: true }) // the whole repo vanishes

      const report = await pruneOrphanCentralWorktrees()
      expect(report.removed).toEqual([empty])
      expect(await exists(empty)).toBe(false)
      expect(report.warned).toEqual([checkout])
      expect(await exists(join(checkout, 'seed.txt'))).toBe(true)
    })

    it('a FOREIGN repo\'s live worktree sitting here is kept + warned, even when effectively empty', { timeout: 30_000 }, async () => {
      const { uuid } = await mkRegisteredRepo('repo-g')
      const wtRoot = centralWorktreesDir(uuid)
      await mkdir(wtRoot, { recursive: true })
      // A foreign repo with an EMPTY tree (no tracked files), so its worktree
      // checkout is just the `.git` gitfile — effectivelyEmpty would say yes.
      // Only the live-metadata branch (rev-parse toplevel === the dir) stands
      // between this live foreign worktree and deletion; pin it.
      const foreign = join(scratch, 'foreign-repo')
      await mkdir(foreign, { recursive: true })
      await git(foreign, ['init', '-q'])
      await git(foreign, ['commit', '-q', '--allow-empty', '-m', 'empty'])
      const squatter = join(wtRoot, 'foreign-live')
      await git(foreign, ['worktree', 'add', '-q', '--detach', squatter])

      const report = await pruneOrphanCentralWorktrees()
      expect(report.removed).toEqual([])
      expect(report.warned).toEqual([squatter])
      expect(await exists(squatter)).toBe(true)
    })

    it('a dir whose .git is a real DIRECTORY (an embedded repo, not a worktree gitfile) is kept + warned', { timeout: 30_000 }, async () => {
      const { uuid } = await mkRegisteredRepo('repo-f')
      const wtRoot = centralWorktreesDir(uuid)
      const nested = join(wtRoot, 'nested')
      // A corrupt-but-real embedded repo: .git DIR with no HEAD → rev-parse
      // fails (metadata "dead"), but the dir may hold real history — keep.
      await mkdir(join(nested, '.git'), { recursive: true })
      const report = await pruneOrphanCentralWorktrees()
      expect(report.removed).toEqual([])
      expect(report.warned).toEqual([nested])
      expect(await exists(nested)).toBe(true)
    })

    it('an UNREGISTERED uuid\'s worktrees are never touched (that data belongs to (d))', async () => {
      const foreign = join(projectsDataRootDir(), '00000000-dead-dead-dead-000000000000', 'worktrees', 'junk')
      await mkdir(foreign, { recursive: true }) // effectively empty — would be deleted if in scope
      const report = await pruneOrphanCentralWorktrees()
      expect(report.removed).toEqual([])
      expect(report.warned).toEqual([])
      expect(await exists(foreign)).toBe(true)
    })
  })

  describe('findOrphanCentralDataDirs — (d) detection only, never deletion', () => {
    it('reports an unregistered data dir in ONE warn line and leaves it on disk; registered dirs are not reported', { timeout: 30_000 }, async () => {
      const { uuid } = await mkRegisteredRepo('repo-c')
      await mkdir(join(projectsDataRootDir(), uuid), { recursive: true })
      const orphan = join(projectsDataRootDir(), 'aaaaaaaa-0000-0000-0000-000000000000')
      await mkdir(join(orphan, 'canvases'), { recursive: true })
      await writeFile(join(orphan, 'tasks.json'), '{"tasks":[]}', 'utf8')

      const orphans = await findOrphanCentralDataDirs()
      expect(orphans).toEqual(['aaaaaaaa-0000-0000-0000-000000000000'])
      expect(await exists(join(orphan, 'tasks.json'))).toBe(true) // NEVER auto-deleted
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0][0])).toContain('NOT auto-deleted')
    })

    it('reports nothing (and stays silent) when every data dir is registered', { timeout: 30_000 }, async () => {
      const { uuid } = await mkRegisteredRepo('repo-d')
      await mkdir(join(projectsDataRootDir(), uuid), { recursive: true })
      await expect(findOrphanCentralDataDirs()).resolves.toEqual([])
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  describe('sweepCrossRepoResidue — the boot sweep end to end (goal condition)', () => {
    it('removes ghost heartbeat + empty orphan worktree; keeps live heartbeat, dirty orphan, live worktree, registered data', { timeout: 30_000 }, async () => {
      const { repo, uuid } = await mkRegisteredRepo('repo-e')
      const wtRoot = centralWorktreesDir(uuid)
      await mkdir(wtRoot, { recursive: true })

      // live worktree + a live (fresh, existing-worktree) heartbeat pointing at it
      const live = join(wtRoot, 'live')
      await git(repo, ['worktree', 'add', '-q', '--detach', live])
      const liveHb = await writeHeartbeat('k-int', 'live.json', { worktree: live, updatedAt: RECENT().toISOString() }, RECENT())
      // ghost heartbeat: old + worktree long gone
      const ghostHb = await writeHeartbeat('k-int', 'ghost.json', { worktree: join(scratch, 'gone') }, OLD())
      // ancient heartbeat whose worktree EXISTS — stalled-but-alive, must survive
      const stalledHb = await writeHeartbeat('k-int', 'stalled.json', { worktree: live, updatedAt: OLD().toISOString() }, OLD())

      // orphan worktrees: one empty (goes), one dirty (stays)
      const empty = join(wtRoot, 'empty')
      await mkdir(empty, { recursive: true })
      const dirty = join(wtRoot, 'dirty')
      await git(repo, ['worktree', 'add', '-q', '--detach', dirty])
      await writeFile(join(dirty, 'wip.txt'), 'unsaved', 'utf8')
      await rm(join(repo, '.git', 'worktrees', 'dirty'), { recursive: true, force: true })

      // registered central data (must survive) + an unregistered orphan (warned only)
      const tasks = join(projectsDataRootDir(), uuid, 'tasks.json')
      await writeFile(tasks, '{"tasks":[{"id":"t1"}]}', 'utf8')
      const orphanData = join(projectsDataRootDir(), 'bbbbbbbb-0000-0000-0000-000000000000')
      await mkdir(orphanData, { recursive: true })

      const report = await sweepCrossRepoResidue()

      // (a)+(b): ghost gone; live + stalled-alive heartbeats survive, so the key dir stays
      expect(report.heartbeats.removedFiles).toEqual([ghostHb])
      expect(await exists(ghostHb)).toBe(false)
      expect(await exists(liveHb)).toBe(true)
      expect(await exists(stalledHb)).toBe(true)
      expect(report.heartbeats.removedDirs).toEqual([])

      // (c): empty orphan gone; dirty orphan + live worktree survive
      expect(report.worktrees.removed).toEqual([empty])
      expect(await exists(empty)).toBe(false)
      expect(report.worktrees.warned).toEqual([dirty])
      expect(await exists(join(dirty, 'wip.txt'))).toBe(true)
      expect(await exists(join(live, 'seed.txt'))).toBe(true)

      // (d): detected, never deleted — and registered data untouched
      expect(report.orphanDataDirs).toEqual(['bbbbbbbb-0000-0000-0000-000000000000'])
      expect(await exists(orphanData)).toBe(true)
      expect(JSON.parse(await readFile(tasks, 'utf8')).tasks).toHaveLength(1)
    })
  })
})
