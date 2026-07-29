import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readRoster,
  writeRoster,
  upsertRosterEntry,
  removeRosterEntry,
  classifyRosterEntry,
  reconcileRoster,
  rosterFile,
  type RosterEntry,
  type RosterReconcileDeps,
} from './swarmWorkerRoster'
import { swarmRepoKey } from './swarmJanitor'
import type { ProjectTask } from '../types'

// Real git fixtures in a tmpdir (swarmJanitor house style) — swarmWorkerRoster
// resolves its file through swarmRepoKey (`git rev-parse`), so the round-trip needs
// a real repo. OPENGROUND_HOME is pinned to the scratch dir so nothing touches the
// real ~/.openground (feedback_tests_isolate_home). The classification + reconcile
// probes are FAKED, so no worktrees/branches need to actually exist.
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
let project: string
let savedHome: string | undefined

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-roster-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = join(scratch, 'home')
  await mkdir(process.env.OPENGROUND_HOME, { recursive: true })
  project = join(scratch, 'proj')
  await mkdir(project, { recursive: true })
  await git(project, ['init'])
})

afterEach(async () => {
  // Restore only — NEVER `delete process.env.OPENGROUND_HOME` (src/testHomeEnvGuard
  // .test.ts statically forbids it; setup-home.ts always keeps it set, so savedHome
  // is defined and the restore is all that's needed — swarmJanitor.test.ts pattern).
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
  await rm(scratch, { recursive: true, force: true })
})

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  sessionId: 'sess-1',
  taskId: 'task-1',
  branch: 'swarm/a',
  worktree: join(scratch, 'wt', 'a'),
  tier: 'fable',
  spawnAt: 1000,
  workedMs: 5000,
  reworkCount: 0,
  ...over,
})

describe('swarmWorkerRoster — persistence (card 3)', () => {
  it('round-trips a full entry through write → read', async () => {
    const e = entry()
    expect(await writeRoster(project, [e])).toBe(true)
    expect(await readRoster(project)).toEqual([e])
  })

  it('lives at ~/.openground/swarm/<repoKey>/roster.json (heartbeat neighbour, not projectDataDir)', async () => {
    const key = (await swarmRepoKey(project))!
    expect(await rosterFile(project)).toBe(join(process.env.OPENGROUND_HOME!, 'swarm', key, 'roster.json'))
  })

  it('FAIL-OPEN: writeRoster on a NON-git path returns false, never throws', async () => {
    const notARepo = join(scratch, 'plain')
    await mkdir(notARepo, { recursive: true })
    await expect(writeRoster(notARepo, [entry()])).resolves.toBe(false)
  })

  it('FAIL-QUIET: a missing roster reads as []', async () => {
    expect(await readRoster(project)).toEqual([])
  })

  it('FAIL-QUIET / condition ④ degrade: a CORRUPT roster reads as [] (never throws)', async () => {
    const path = (await rosterFile(project))!
    await mkdir(join(process.env.OPENGROUND_HOME!, 'swarm', (await swarmRepoKey(project))!), { recursive: true })
    await writeFile(path, '{ this is not json …')
    await expect(readRoster(project)).resolves.toEqual([])
  })

  it('tolerant parse: an entry missing worktree/branch is dropped; negative/NaN numbers floor to 0', async () => {
    const path = (await rosterFile(project))!
    await mkdir(join(process.env.OPENGROUND_HOME!, 'swarm', (await swarmRepoKey(project))!), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        workers: [
          { branch: 'swarm/x' }, // no worktree → dropped
          { worktree: '/wt/y' }, // no branch → dropped
          { worktree: '/wt/z', branch: 'swarm/z', workedMs: -9, spawnAt: 'nope', reworkCount: 3 },
        ],
      }),
    )
    const got = await readRoster(project)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ worktree: '/wt/z', branch: 'swarm/z', workedMs: 0, spawnAt: 0, reworkCount: 3 })
  })

  it('upsert replaces by worktree (identity), not appends', async () => {
    await writeRoster(project, [entry({ workedMs: 1 })])
    await upsertRosterEntry(project, entry({ workedMs: 999 }))
    const got = await readRoster(project)
    expect(got).toHaveLength(1)
    expect(got[0].workedMs).toBe(999)
  })

  it('condition ③: removeRosterEntry drops the entry for a worktree', async () => {
    const a = entry({ worktree: join(scratch, 'wt', 'a'), branch: 'swarm/a' })
    const b = entry({ worktree: join(scratch, 'wt', 'b'), branch: 'swarm/b' })
    await writeRoster(project, [a, b])
    await removeRosterEntry(project, a.worktree)
    const got = await readRoster(project)
    expect(got.map((e) => e.worktree)).toEqual([b.worktree])
  })
})

describe('swarmWorkerRoster — classifyRosterEntry (pure, condition ①)', () => {
  it('vanished worktree wins over everything (precedence #1)', () => {
    expect(
      classifyRosterEntry({ worktreeExists: false, cardActive: true, branchAhead: true, heartbeatReady: true, cardInReview: false }),
    ).toBe('vanished')
    // TEETH: worktree-gone AND card-gone must still be 'vanished' (the worktree check
    // is FIRST). Swap the two guards in classifyRosterEntry and THIS case flips to
    // 'card-gone' — the discriminating case the all-true variant above can't catch.
    expect(
      classifyRosterEntry({ worktreeExists: false, cardActive: false, branchAhead: false, heartbeatReady: false, cardInReview: false }),
    ).toBe('vanished')
  })
  it('card gone (worktree alive) → card-gone (precedence #2)', () => {
    expect(
      classifyRosterEntry({ worktreeExists: true, cardActive: false, branchAhead: true, heartbeatReady: true, cardInReview: false }),
    ).toBe('card-gone')
  })
  it('branch ahead + heartbeat ready → ready (precedence #3)', () => {
    expect(
      classifyRosterEntry({ worktreeExists: true, cardActive: true, branchAhead: true, heartbeatReady: true, cardInReview: true }),
    ).toBe('ready')
  })
  it('alive + active + not-yet-ready → in-progress (resume candidate, default)', () => {
    expect(
      classifyRosterEntry({ worktreeExists: true, cardActive: true, branchAhead: true, heartbeatReady: false, cardInReview: false }),
    ).toBe('in-progress')
    expect(
      classifyRosterEntry({ worktreeExists: true, cardActive: true, branchAhead: false, heartbeatReady: true, cardInReview: false }),
    ).toBe('in-progress')
  })
})

describe('swarmWorkerRoster — reconcileRoster (boot, condition ①/④)', () => {
  const card = (id: string, col: string): ProjectTask =>
    ({ id, title: id, boardColumn: col } as unknown as ProjectTask)

  it('classifies all 4 branches observably AND prunes to resume candidates only', async () => {
    const vanished = entry({ worktree: join(scratch, 'wt', 'gone'), branch: 'swarm/gone', taskId: 'c-gone-wt' })
    const cardGone = entry({ worktree: join(scratch, 'wt', 'cg'), branch: 'swarm/cg', taskId: 'c-deleted' })
    const ready = entry({ worktree: join(scratch, 'wt', 'rd'), branch: 'swarm/rd', taskId: 'c-ready' })
    const inProg = entry({ worktree: join(scratch, 'wt', 'ip'), branch: 'swarm/ip', taskId: 'c-work' })
    await writeRoster(project, [vanished, cardGone, ready, inProg])

    const deps: RosterReconcileDeps = {
      // card-deleted is simply ABSENT from the board; ready is in review, work in doing.
      fetchTasks: async () => [card('c-ready', 'review'), card('c-work', 'doing')],
      countCommitsAhead: async (_p, branch) => (branch === 'swarm/rd' ? 2 : 0),
      heartbeatReady: async (_p, branch) => branch === 'swarm/rd',
      worktreeExists: async (wt) => wt !== vanished.worktree,
    }

    const result = await reconcileRoster(project, deps)
    expect(result.vanished.map((e) => e.taskId)).toEqual(['c-gone-wt'])
    expect(result.cardGone.map((e) => e.taskId)).toEqual(['c-deleted'])
    expect(result.ready.map((e) => e.taskId)).toEqual(['c-ready'])
    expect(result.resumeCandidates.map((e) => e.taskId)).toEqual(['c-work'])

    // Pruned: only the resume candidate survives on disk.
    const onDisk = await readRoster(project)
    expect(onDisk.map((e) => e.taskId)).toEqual(['c-work'])
  })

  it('a card moved to a NON-active column (done/blocked) while stopped is card-gone (移動)', async () => {
    const moved = entry({ worktree: join(scratch, 'wt', 'mv'), branch: 'swarm/mv', taskId: 'c-moved' })
    await writeRoster(project, [moved])
    const deps: RosterReconcileDeps = {
      fetchTasks: async () => [card('c-moved', 'done')], // human dragged it to done
      countCommitsAhead: async () => 5,
      heartbeatReady: async () => true,
      worktreeExists: async () => true,
    }
    const result = await reconcileRoster(project, deps)
    expect(result.cardGone.map((e) => e.taskId)).toEqual(['c-moved'])
    expect(result.ready).toHaveLength(0)
  })

  it('condition ④ degrade: a corrupt roster reconciles to an all-empty result, never throws', async () => {
    const path = (await rosterFile(project))!
    await mkdir(join(process.env.OPENGROUND_HOME!, 'swarm', (await swarmRepoKey(project))!), { recursive: true })
    await writeFile(path, 'not json at all')
    const deps: RosterReconcileDeps = {
      fetchTasks: async () => {
        throw new Error('should not even be reached')
      },
      countCommitsAhead: async () => 0,
      heartbeatReady: async () => false,
      worktreeExists: async () => true,
    }
    const result = await reconcileRoster(project, deps)
    expect(result).toEqual({ resumeCandidates: [], ready: [], vanished: [], cardGone: [] })
  })

  // CONTRACT CHANGED (2026-07-29). This case used to assert that a Board read
  // failure "degrades every card to card-gone (conservative)" — and the prune at
  // the end of reconcileRoster then wrote the roster back EMPTY. That is the
  // opposite of conservative: a transient blip at boot (the loopback API not up
  // yet) permanently destroyed the memory of every LIVE worker, and the next boot
  // had nothing left to recover from. Absence of evidence was persisted as
  // evidence of absence. A failed read now concludes NOTHING and preserves the
  // file; the empty result still freezes adoption for this boot, which the caller
  // already handles.
  it('a Board read failure concludes NOTHING and never throws', async () => {
    const e = entry({ worktree: join(scratch, 'wt', 'x'), branch: 'swarm/x', taskId: 'c-x' })
    await writeRoster(project, [e])
    const deps: RosterReconcileDeps = {
      fetchTasks: async () => {
        throw new Error('board down')
      },
      countCommitsAhead: async () => 3,
      heartbeatReady: async () => true,
      worktreeExists: async () => true,
    }
    const result = await reconcileRoster(project, deps)
    expect(result.cardGone).toEqual([]) // no verdict was reached about any card
    expect(result.resumeCandidates).toEqual([])
    expect(await readRoster(project)).toHaveLength(1) // and the memory survives
  })
})

// ── 束B: two ways the roster was destroyed by NON-evidence (2026-07-29) ───────
describe('reconcileRoster — a Board blip must not erase the roster', () => {
  it('a failed Board read leaves the file INTACT and adopts nobody', async () => {
    const entry: RosterEntry = {
      sessionId: 's1',
      taskId: 'card-1',
      branch: 'swarm/a',
      worktree: join(scratch, 'wt-a'),
      tier: 'sonnet',
      spawnAt: 1,
      workedMs: 10,
      reworkCount: 0,
    }
    await writeRoster(project, [entry])

    const res = await reconcileRoster(project, {
      // The blip: the loopback Board API is not up yet at boot.
      fetchTasks: async () => {
        throw new Error('ECONNREFUSED')
      },
      countCommitsAhead: async () => 1,
      heartbeatReady: async () => false,
      worktreeExists: async () => true,
    })

    // Nobody is adopted this boot (the caller's freeze already handles that)…
    expect(res.resumeCandidates).toEqual([])
    expect(res.cardGone).toEqual([]) // …and NOTHING was concluded about the cards
    // …but the memory survives, so the NEXT boot can still recover the worker.
    // Pre-fix this read back as [] — a transient blip was written to disk as
    // "every card is gone", permanently.
    expect(await readRoster(project)).toHaveLength(1)
  })
})

describe('classifyRosterEntry — a sticky ready heartbeat is not a handover', () => {
  it('card back in doing (差し戻し) + stale ready heartbeat → in-progress, NOT ready', () => {
    // swarm-beat.sh writes readyToMerge:true once and never unsets it, so a
    // worker that delivered, got sent back, and is working again still reports
    // ready. Pre-fix that read as 'ready' → the row was pruned → the doing card
    // had no owner (selectDispatch reads todo only; reclaim walks engine.workers)
    // and sat there forever beside a live worktree.
    expect(
      classifyRosterEntry({
        worktreeExists: true,
        cardActive: true,
        branchAhead: true,
        heartbeatReady: true,
        cardInReview: false,
      }),
    ).toBe('in-progress')
  })

  it('card actually in review + ready heartbeat → ready (the real handover)', () => {
    expect(
      classifyRosterEntry({
        worktreeExists: true,
        cardActive: true,
        branchAhead: true,
        heartbeatReady: true,
        cardInReview: true,
      }),
    ).toBe('ready')
  })
})
