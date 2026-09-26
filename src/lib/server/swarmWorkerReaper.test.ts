import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, stat, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { centralWorktreesDir } from './paths'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import {
  reapFinishedWorkers,
  defaultReapDeps,
  REAP_GRACE_MS,
  type ReapFinishedWorkersDeps,
} from './swarmWorkerReaper'
import { swarmRepoKey } from './swarmJanitor'
import { createTerminal, killTerminal, listActiveTerminalCwds } from './terminal'

// Guards for the finished-worker reaper against REAL git fixtures: the thing that
// matters is whether the worktree directory is still on disk afterwards, so the
// real listWorktrees / checkMerged / removeSwarmWorktree run. Only the engine /
// Board / live-session reads are injected. HOME and claude config are pinned to
// the scratch dir (removeSwarmWorktree touches ~/.claude.json trust entries).

vi.setConfig({ testTimeout: 60_000 })

const execFile = promisify(execFileCb)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (
    await execFile(
      'git',
      ['-c', 'user.name=OG Test', '-c', 'user.email=og-test@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd },
    )
  ).stdout

let scratch: string
let savedHome: string | undefined
let savedClaudeCfg: string | undefined

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-worker-reaper-')))
  savedHome = process.env.OPENGROUND_HOME
  savedClaudeCfg = process.env.CLAUDE_CONFIG_PATH
  const home = join(scratch, 'home')
  await mkdir(home, { recursive: true })
  process.env.OPENGROUND_HOME = home
  process.env.CLAUDE_CONFIG_PATH = join(home, '.claude.json')
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  // Restore, never delete (testHomeGuard.ts).
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
  if (savedClaudeCfg === undefined) delete process.env.CLAUDE_CONFIG_PATH
  else process.env.CLAUDE_CONFIG_PATH = savedClaudeCfg
  __resetMigrationCacheForTests()
  await rm(scratch, { recursive: true, force: true })
})

/** Bare origin + registered project clone; returns the project and its central dir. */
async function makeProject(): Promise<{ project: string; central: string }> {
  const origin = join(scratch, 'origin.git')
  await mkdir(origin)
  await git(origin, ['init', '--bare', '-b', 'main'])
  const project = join(scratch, 'project')
  await git(scratch, ['clone', origin, project])
  await git(project, ['checkout', '-b', 'main'])
  await writeFile(join(project, 'README'), 'base\n')
  await git(project, ['add', '.'])
  await git(project, ['commit', '-m', 'C0'])
  await git(project, ['push', 'origin', 'main'])
  await git(project, ['remote', 'set-head', 'origin', 'main'])
  const entry = await addProjectEntry(project)
  await mkdir(centralWorktreesDir(entry.id), { recursive: true })
  return { project, central: await realpath(centralWorktreesDir(entry.id)) }
}

/** A worker worktree on swarm/<name> with one commit; `integrate` lands it on origin/main. */
async function makeWorker(project: string, central: string, name: string, integrate: boolean): Promise<string> {
  const wt = join(central, name)
  await git(project, ['worktree', 'add', '-b', `swarm/${name}`, wt, 'origin/main'])
  await writeFile(join(wt, `${name}.txt`), 'work\n')
  await git(wt, ['add', '.'])
  await git(wt, ['commit', '-m', `work ${name}`])
  if (integrate) await git(wt, ['push', 'origin', 'HEAD:main'])
  return wt
}

const exists = (p: string) => stat(p).then(() => true, () => false)

/** Real git/FS deps; engine, Board, sessions and clock are the test's. */
const deps = (over: Partial<ReapFinishedWorkersDeps> = {}): ReapFinishedWorkersDeps => ({
  ...defaultReapDeps(),
  liveCwds: async () => [],
  roster: async () => [],
  cardColumns: async () => new Map(),
  heartbeatTimes: async () => new Map(),
  createdMs: async () => 0, // created long ago
  recentlyActive: async () => false,
  now: () => Date.now(),
  ...over,
})

describe('reapFinishedWorkers', () => {
  it('removes a finished worker whose work is already in main', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'landed', true)
    const res = await reapFinishedWorkers(project, deps())
    expect(res.removedDirs).toEqual([wt])
    expect(await exists(wt)).toBe(false)
  })

  it('keeps a worker with commits that are not in main yet', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'open', false)
    const res = await reapFinishedWorkers(project, deps())
    expect(res.kept).toEqual([{ worktree: wt, reason: 'unmerged' }])
    expect(await exists(wt)).toBe(true)
  })

  it('keeps a worker a session is still working in', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'busy', true)
    const res = await reapFinishedWorkers(project, deps({ liveCwds: async () => [wt] }))
    expect(res.kept).toEqual([{ worktree: wt, reason: 'live' }])
    expect(await exists(wt)).toBe(true)
  })

  it('keeps uncommitted changes even when the commits are in main', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'dirty', true)
    await writeFile(join(wt, 'unsaved.txt'), 'x\n')
    const res = await reapFinishedWorkers(project, deps())
    expect(res.kept).toEqual([{ worktree: wt, reason: 'dirty' }])
    expect(await exists(wt)).toBe(true)
  })

  it('engine-held worker: removed once its card is done, kept while it is in review', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'held', true)
    const roster = async () => [{ worktree: wt, taskId: 'card-1' }]
    const live = async () => [wt] // idle session still up after the worker finished
    const review = await reapFinishedWorkers(
      project,
      deps({ roster, liveCwds: live, cardColumns: async () => new Map([['card-1', 'review']]) }),
    )
    expect(review.kept).toEqual([{ worktree: wt, reason: 'engine-owned' }])
    const done = await reapFinishedWorkers(
      project,
      deps({ roster, liveCwds: live, cardColumns: async () => new Map([['card-1', 'done']]) }),
    )
    expect(done.removedDirs).toEqual([wt])
    expect(await exists(wt)).toBe(false)
  })

  it('keeps a recently active worker the engine does not hold (spawn window)', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'fresh', true)
    const now = Date.now()
    const res = await reapFinishedWorkers(project, deps({ createdMs: async () => now - REAP_GRACE_MS + 60_000 }))
    expect(res.kept).toEqual([{ worktree: wt, reason: 'recent' }])
    expect(await exists(wt)).toBe(true)
  })

  it('a session working in a SUBDIRECTORY of the worktree still keeps it', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'deep', true)
    const res = await reapFinishedWorkers(project, deps({ liveCwds: async () => [join(wt, 'src')] }))
    expect(res.kept).toEqual([{ worktree: wt, reason: 'live' }])
  })

  it('engine-held worker whose session moved recently is kept even with its card done', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'moving', true)
    const res = await reapFinishedWorkers(
      project,
      deps({
        roster: async () => [{ worktree: wt, taskId: 'c' }],
        cardColumns: async () => new Map([['c', 'done']]),
        recentlyActive: async () => true,
      }),
    )
    expect(res.kept).toEqual([{ worktree: wt, reason: 'busy' }])
    expect(await exists(wt)).toBe(true)
  })

  it('unreadable engine roster or Board never reads as "finished"', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'unknown', true)
    const noRoster = await reapFinishedWorkers(project, deps({ roster: async () => { throw new Error('x') } }))
    expect(noRoster.removedDirs).toEqual([])
    const noBoard = await reapFinishedWorkers(
      project,
      deps({ roster: async () => [{ worktree: wt, taskId: 'c' }], cardColumns: async () => null }),
    )
    expect(noBoard.kept).toEqual([{ worktree: wt, reason: 'engine-owned' }])
    expect(await exists(wt)).toBe(true)
  })

  it('the engine picking the worker up between the check and the removal keeps it', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'adopted', true)
    let calls = 0
    const res = await reapFinishedWorkers(
      project,
      deps({ roster: async () => (calls++ === 0 ? [] : [{ worktree: wt, taskId: 'c' }]) }),
    )
    expect(res.kept).toEqual([{ worktree: wt, reason: 'engine-owned' }])
    expect(await exists(wt)).toBe(true)
  })

  it('a fresh heartbeat on disk keeps a worker nobody holds (real heartbeat read)', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'beating', true)
    const dir = join(process.env.OPENGROUND_HOME as string, 'swarm', (await swarmRepoKey(project)) as string)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'swarm-beating.json'),
      JSON.stringify({ branch: 'swarm/beating', worktree: wt, phase: 'done', updatedAt: new Date().toISOString() }),
    )
    const { heartbeatTimes: _drop, ...rest } = deps()
    const res = await reapFinishedWorkers(project, { ...rest, heartbeatTimes: defaultReapDeps().heartbeatTimes })
    expect(res.kept).toEqual([{ worktree: wt, reason: 'recent' }])
    expect(await exists(wt)).toBe(true)
  })

  it('the worktree\'s own node_modules symlink is not uncommitted work, and its target survives', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'linked', true)
    // Stand-in for the primary checkout's node_modules the worker links to.
    const shared = join(scratch, 'primary-node_modules')
    await mkdir(join(shared, 'some-pkg'), { recursive: true })
    await writeFile(join(shared, 'some-pkg', 'index.js'), 'module.exports = 1\n')
    await symlink(shared, join(wt, 'node_modules'))
    const res = await reapFinishedWorkers(project, deps())
    expect(res.removedDirs).toEqual([wt])
    expect(await exists(wt)).toBe(false)
    expect(await exists(join(shared, 'some-pkg', 'index.js'))).toBe(true)
  })

  // ── Real session pool: "never stop a worker nobody holds" ──
  // The other tests inject the liveness SNAPSHOT. This one puts a real PTY in the
  // worktree AFTER the snapshot (a session that appeared mid-pass) so the only
  // thing standing between it and removal is removeSwarmWorktree's own
  // refuseIfOccupied check against the real pools.
  it.skipIf(process.platform === 'win32')(
    'a real session in a worktree nobody holds is neither stopped nor removed',
    async () => {
      const { project, central } = await makeProject()
      const wt = await makeWorker(project, central, 'occupied', true)
      const term = createTerminal({ cwd: wt, shell: '/bin/sh', hidden: true })
      try {
        const res = await reapFinishedWorkers(project, deps({ liveCwds: async () => [] }))
        expect(res.kept).toEqual([{ worktree: wt, reason: 'remove-refused' }])
        expect(await exists(wt)).toBe(true)
        expect(listActiveTerminalCwds()).toContain(wt)
      } finally {
        killTerminal(term.id)
      }
    },
  )

  // ── Saved roster (real reader) ──
  const writeSavedRoster = async (project: string, text: string) => {
    const dir = join(process.env.OPENGROUND_HOME as string, 'swarm', (await swarmRepoKey(project)) as string)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'roster.json'), text)
  }
  const realRoster = () => ({ roster: defaultReapDeps().roster })

  it('a corrupt saved roster removes nothing (cannot tell who the engine holds)', async () => {
    const { project, central } = await makeProject()
    const wt = await makeWorker(project, central, 'corrupt', true)
    await writeSavedRoster(project, '{"workers": [ {"worktree": ')
    const res = await reapFinishedWorkers(project, deps(realRoster()))
    expect(res.removedDirs).toEqual([])
    expect(await exists(wt)).toBe(true)
  })

  it('a saved roster row keeps its worker; no roster file at all is an empty roster', async () => {
    const { project, central } = await makeProject()
    const held = await makeWorker(project, central, 'saved', true)
    await writeSavedRoster(project, JSON.stringify({ workers: [{ worktree: held, taskId: 'c' }] }))
    const kept = await reapFinishedWorkers(project, deps(realRoster()))
    expect(kept.kept).toEqual([{ worktree: held, reason: 'engine-owned' }])
    await rm(join(process.env.OPENGROUND_HOME as string, 'swarm'), { recursive: true, force: true })
    const gone = await reapFinishedWorkers(project, deps(realRoster()))
    expect(gone.removedDirs).toEqual([held])
  })
})
