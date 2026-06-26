import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, stat, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  sweepSwarmBranches,
  sweepSwarmHeartbeats,
  swarmRepoKey,
  runSwarmJanitor,
} from './swarmJanitor'

// Tests against REAL local git fixtures in a tmpdir (mergedBranches /
// swarmIntegrate house style) — no mocks, no network. The "remote" is a local
// BARE repo so the remote-branch sweep exercises a real `push --delete`. The
// heartbeat sweep runs with OPENGROUND_HOME pinned to the scratch dir so it
// never touches the real ~/.openground.

vi.setConfig({ testTimeout: 60_000 })

const execFile = promisify(execFileCb)

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

let scratch: string
let savedHome: string | undefined

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-swarm-janitor-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = join(scratch, 'home')
})
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENGROUND_HOME
  else process.env.OPENGROUND_HOME = savedHome
  await rm(scratch, { recursive: true, force: true })
})

/** A bare "origin" with one commit on main, plus a `project` clone (where the
 *  janitor runs). Returns both paths. */
async function makeRemote(): Promise<{ origin: string; project: string }> {
  const origin = join(scratch, 'origin.git')
  await mkdir(origin)
  await git(origin, ['init', '--bare', '-b', 'main'])

  const seed = join(scratch, 'seed')
  await mkdir(seed)
  await git(seed, ['init', '-b', 'main'])
  await git(seed, ['remote', 'add', 'origin', origin])
  await writeFile(join(seed, 'README'), 'base\n')
  await git(seed, ['add', '.'])
  await git(seed, ['commit', '-m', 'C0'])
  await git(seed, ['push', 'origin', 'main'])

  const project = join(scratch, 'project')
  await git(scratch, ['clone', origin, project])
  // origin/HEAD so resolveTarget finds 'main'.
  await git(project, ['remote', 'set-head', 'origin', 'main'])
  return { origin, project }
}

/** Make a `swarm/<name>` branch with `commits` extra commits on top of main,
 *  then return to main. 0 commits ⇒ an "empty" branch (tip == main). */
async function makeSwarmBranch(project: string, name: string, commits: number): Promise<void> {
  const branch = `swarm/${name}`
  await git(project, ['branch', branch, 'main'])
  if (commits > 0) {
    await git(project, ['checkout', branch])
    for (let i = 0; i < commits; i++) {
      await writeFile(join(project, `${name}-${i}.txt`), `c${i}\n`)
      await git(project, ['add', '.'])
      await git(project, ['commit', '-m', `${name} c${i}`])
    }
    await git(project, ['checkout', 'main'])
  }
}

/** Fast-forward main to a branch's tip AND push to origin — mirroring real swarm
 *  integration, where a landed branch reaches origin/main (the trunk ref the
 *  janitor judges "merged" against, preferring the freshest remote-tracking
 *  ref). Without the push, a locally-merged branch reads 'open' (correct,
 *  conservative behaviour — kept until the merge reaches origin). */
async function mergeIntoMain(project: string, branch: string): Promise<void> {
  await git(project, ['checkout', 'main'])
  await git(project, ['merge', '--ff-only', branch])
  await git(project, ['push', 'origin', 'main'])
}

const localBranches = async (project: string): Promise<string[]> =>
  (await git(project, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']))
    .split('\n').map((l) => l.trim()).filter(Boolean)

describe('sweepSwarmBranches — local', () => {
  it('deletes a MERGED swarm branch and keeps the UNMERGED one (the warning list)', async () => {
    const { project } = await makeRemote()
    await makeSwarmBranch(project, 'merged', 2)
    await makeSwarmBranch(project, 'open', 2)
    await mergeIntoMain(project, 'swarm/merged') // only this one lands

    const res = await sweepSwarmBranches(project)

    expect(res.deletedLocal).toEqual(['swarm/merged'])
    expect(res.kept).toEqual([{ branch: 'swarm/open', reason: 'unmerged' }])
    const left = await localBranches(project)
    expect(left).toContain('swarm/open')
    expect(left).not.toContain('swarm/merged')
  })

  it('deletes an EMPTY swarm branch (no commits — tip == trunk)', async () => {
    const { project } = await makeRemote()
    await makeSwarmBranch(project, 'empty', 0) // tip == main ⇒ ancestor ⇒ merged

    const res = await sweepSwarmBranches(project)

    expect(res.deletedLocal).toEqual(['swarm/empty'])
    expect(await localBranches(project)).not.toContain('swarm/empty')
  })

  it('NEVER touches non-swarm branches even when merged', async () => {
    const { project } = await makeRemote()
    await git(project, ['branch', 'feature/keep', 'main']) // empty, merged, but NOT swarm/*
    await makeSwarmBranch(project, 'gone', 0)

    const res = await sweepSwarmBranches(project)

    expect(res.deletedLocal).toEqual(['swarm/gone'])
    expect(await localBranches(project)).toContain('feature/keep')
  })

  it('keeps a CHECKED-OUT swarm branch (active worker) and flags dirty', async () => {
    const { project } = await makeRemote()
    await makeSwarmBranch(project, 'active', 0) // empty ⇒ would be merged/deletable
    // Check it out in a separate worktree and dirty it.
    const wt = join(scratch, 'wt-active')
    await git(project, ['worktree', 'add', wt, 'swarm/active'])
    await writeFile(join(wt, 'uncommitted.txt'), 'wip\n')

    const res = await sweepSwarmBranches(project)

    expect(res.deletedLocal).toEqual([])
    expect(res.kept).toEqual([{ branch: 'swarm/active', reason: 'checked-out', dirty: true }])
    expect(await localBranches(project)).toContain('swarm/active')
  })

  it('deletes a MERGED branch even when HEAD is on a NON-trunk branch (upstream anchor)', async () => {
    const { project } = await makeRemote()
    await makeSwarmBranch(project, 'merged', 1)
    await mergeIntoMain(project, 'swarm/merged')
    // Sit HEAD on an unrelated branch so `branch -d`'s default HEAD-merge check
    // would NOT see swarm/merged as merged — the trunk upstream anchor must.
    await git(project, ['checkout', '-b', 'sidebar', 'main'])

    const res = await sweepSwarmBranches(project)

    expect(res.deletedLocal).toEqual(['swarm/merged'])
  })

  it('does NOT force-delete unmerged by default, but DOES with force:true (user-explicit)', async () => {
    const { project } = await makeRemote()
    await makeSwarmBranch(project, 'risky', 3) // unmerged, has commits

    const safe = await sweepSwarmBranches(project)
    expect(safe.deletedLocal).toEqual([])
    expect(safe.kept).toEqual([{ branch: 'swarm/risky', reason: 'unmerged' }])
    expect(await localBranches(project)).toContain('swarm/risky')

    const forced = await sweepSwarmBranches(project, { force: true })
    expect(forced.deletedLocal).toEqual(['swarm/risky'])
    expect(await localBranches(project)).not.toContain('swarm/risky')
  })

  it('returns empty + throws nothing on a non-repo dir', async () => {
    const notRepo = join(scratch, 'plain')
    await mkdir(notRepo)
    const res = await sweepSwarmBranches(notRepo)
    expect(res).toEqual({ deletedLocal: [], deletedRemote: [], kept: [] })
  })
})

describe('sweepSwarmBranches — remote (opt-in, non-force)', () => {
  it('deletes MERGED origin/swarm/* and keeps the unmerged remote one', async () => {
    const { origin, project } = await makeRemote()
    // Two swarm branches pushed to origin; only one merged into origin/main.
    await makeSwarmBranch(project, 'rmerged', 1)
    await makeSwarmBranch(project, 'ropen', 1)
    await git(project, ['push', 'origin', 'swarm/rmerged'])
    await git(project, ['push', 'origin', 'swarm/ropen'])
    await mergeIntoMain(project, 'swarm/rmerged') // pushes main ⇒ origin/main contains rmerged
    await git(project, ['fetch', 'origin']) // ensure all origin/* tracking refs present

    // Default (no deleteRemote) leaves the remote untouched.
    const noRemote = await sweepSwarmBranches(project)
    expect(noRemote.deletedRemote).toEqual([])

    const res = await sweepSwarmBranches(project, { deleteRemote: true })
    expect(res.deletedRemote).toEqual(['swarm/rmerged'])

    const originRefs = await git(origin, ['for-each-ref', 'refs/heads', '--format=%(refname:short)'])
    expect(originRefs).toContain('swarm/ropen')
    expect(originRefs).not.toContain('swarm/rmerged')
  })
})

// ── heartbeat sweep ──────────────────────────────────────────────────────────

/** Write a heartbeat JSON into the repo's swarm dir; returns the file path. */
async function writeBeat(
  project: string,
  branch: string,
  body: { worktree?: string; updatedAt: string; readyToMerge?: boolean },
): Promise<{ dir: string; file: string }> {
  const key = (await swarmRepoKey(project))!
  const dir = join(process.env.OPENGROUND_HOME!, 'swarm', key)
  await mkdir(dir, { recursive: true })
  const file = `${branch.replace(/\//g, '-')}.json`
  await writeFile(
    join(dir, file),
    JSON.stringify({ branch, task: 't', phase: 'implement', blockers: '', ...body }),
  )
  return { dir, file }
}

const iso = (msAgo: number, now: number) => new Date(now - msAgo).toISOString()

describe('sweepSwarmHeartbeats', () => {
  it('sweeps a STALE heartbeat whose branch is gone, keeps a FRESH one', async () => {
    const { project } = await makeRemote()
    const now = Date.parse('2026-06-25T12:00:00Z')
    // Stale + branch never existed ⇒ orphan.
    await writeBeat(project, 'swarm/dead', { updatedAt: iso(60 * 60_000, now) })
    // Fresh ⇒ keep regardless of branch existence (a live worker writing it).
    await writeBeat(project, 'swarm/live', { updatedAt: iso(1_000, now) })

    const res = await sweepSwarmHeartbeats(project, { now })

    expect(res.swept).toEqual(['swarm-dead.json'])
    expect(res.kept).toEqual(['swarm-live.json'])
  })

  it('keeps a stale heartbeat whose branch AND worktree both still exist', async () => {
    const { project } = await makeRemote()
    const now = Date.parse('2026-06-25T12:00:00Z')
    await makeSwarmBranch(project, 'alive', 1) // branch exists
    const wt = join(scratch, 'wt-alive')
    await git(project, ['worktree', 'add', wt, 'swarm/alive'])
    await writeBeat(project, 'swarm/alive', { worktree: wt, updatedAt: iso(60 * 60_000, now) })

    const res = await sweepSwarmHeartbeats(project, { now })

    expect(res.swept).toEqual([])
    expect(res.kept).toEqual(['swarm-alive.json'])
  })

  it('sweeps a stale heartbeat whose worktree is gone (branch also absent)', async () => {
    const { project } = await makeRemote()
    const now = Date.parse('2026-06-25T12:00:00Z')
    await writeBeat(project, 'swarm/zombie', {
      worktree: join(scratch, 'vanished-worktree'),
      updatedAt: iso(60 * 60_000, now),
    })

    const res = await sweepSwarmHeartbeats(project, { now })
    expect(res.swept).toEqual(['swarm-zombie.json'])
  })

  it('keeps a corrupt-but-RECENT heartbeat (mid-write), sweeps a corrupt-and-OLD one', async () => {
    const { project } = await makeRemote()
    const key = (await swarmRepoKey(project))!
    const dir = join(process.env.OPENGROUND_HOME!, 'swarm', key)
    await mkdir(dir, { recursive: true })
    const fresh = join(dir, 'swarm-fresh-corrupt.json')
    const old = join(dir, 'swarm-old-corrupt.json')
    await writeFile(fresh, '{ not json')
    await writeFile(old, '{ also not json')
    // A corrupt file has no parseable updatedAt ⇒ freshness falls back to the
    // file's mtime. Drive `now` off the REAL mtime (same clock) so the test is
    // wall-clock-independent: age the OLD file past the stale window.
    const freshMtime = (await stat(fresh)).mtimeMs
    const oldTime = new Date(freshMtime - 60 * 60_000)
    await utimes(old, oldTime, oldTime)
    const now = freshMtime + 1_000

    const res = await sweepSwarmHeartbeats(project, { now })
    expect(res.kept).toEqual(['swarm-fresh-corrupt.json'])
    expect(res.swept).toEqual(['swarm-old-corrupt.json'])
  })

  it('KEEPS a stale heartbeat with a LIVE branch but no worktree field (absent field ≠ gone)', async () => {
    const { project } = await makeRemote()
    const now = Date.parse('2026-06-25T12:00:00Z')
    await makeSwarmBranch(project, 'nowt', 1) // branch exists; heartbeat omits worktree
    await writeBeat(project, 'swarm/nowt', { updatedAt: iso(60 * 60_000, now) })

    const res = await sweepSwarmHeartbeats(project, { now })
    expect(res.swept).toEqual([])
    expect(res.kept).toEqual(['swarm-nowt.json'])
  })

  it('sweeps a stale heartbeat with a live branch but its worktree is GONE on disk (OR contract)', async () => {
    const { project } = await makeRemote()
    const now = Date.parse('2026-06-25T12:00:00Z')
    await makeSwarmBranch(project, 'wtgone', 1) // branch exists, but worktree dir removed
    await writeBeat(project, 'swarm/wtgone', {
      worktree: join(scratch, 'removed-worktree'),
      updatedAt: iso(60 * 60_000, now),
    })

    const res = await sweepSwarmHeartbeats(project, { now })
    expect(res.swept).toEqual(['swarm-wtgone.json'])
  })

  it('no-ops cleanly when the swarm dir does not exist', async () => {
    const { project } = await makeRemote()
    const res = await sweepSwarmHeartbeats(project)
    expect(res).toEqual({ swept: [], kept: [] })
  })
})

describe('runSwarmJanitor', () => {
  it('runs all three sweeps and returns a combined report (terminals empty pool)', async () => {
    const { project } = await makeRemote()
    const now = Date.parse('2026-06-25T12:00:00Z')
    await makeSwarmBranch(project, 'done', 0) // empty ⇒ merged ⇒ deletable
    await makeSwarmBranch(project, 'wip', 2) // unmerged ⇒ kept
    await writeBeat(project, 'swarm/old', { updatedAt: iso(60 * 60_000, now) })

    const report = await runSwarmJanitor(project, { heartbeats: { now } })

    expect(report.branches.deletedLocal).toEqual(['swarm/done'])
    expect(report.branches.kept).toEqual([{ branch: 'swarm/wip', reason: 'unmerged' }])
    expect(report.heartbeats.swept).toEqual(['swarm-old.json'])
    // Empty terminal pool (no fake sessions injected here) ⇒ nothing swept.
    expect(report.terminals).toEqual({ swept: [], kept: 0 })
  })
})
