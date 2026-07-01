// @vitest-environment node
//
// REAL-GIT integration test for the commander engine's risky path (Phase 2).
//
// swarmOrchestrator.test.ts drives the loop with FAKE deps (no git, no worktrees).
// This file drives the SAME runDispatchPass / runIntegratePass against a REAL git
// repo with a REAL bare origin and the REAL classify / integrate / cleanup /
// commit-count deps (defaultDeps()), overriding ONLY:
//   • the board  → an in-memory Map (the real deps would talk to the HTTP API)
//   • the spawn  → a real worktree + a real commit (no `claude` PTY — the engine's
//                  orchestration, not claude itself, is under test here)
//   • liveness + heartbeat → controllable so the conservative DONE judgement fires
//   • killPty    → records (no real PTY exists to kill)
// Everything git — branch off origin/main, fast-forward / rebase / conflict
// detection, the push that lands the trunk, the worktree teardown — is REAL.
//
// This is the deterministic end-to-end proof of the order goal's observable
// conditions, minus the real-claude spawn (covered by the live smoke):
//   (2) a card moves todo→doing→review→done as the engine drives it, landing on a
//       REAL origin/main by fast-forward AND by rebase; a real conflict is refused.
//   (3) after a landing the worktree is GONE (force-removed even with untracked
//       scratch) and the worker PTY is killed — no zombie worktree / slot.
//   (5) a `blocked`-column card is NEVER dispatched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile, stat } from 'fs/promises'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import {
  runDispatchPass,
  runIntegratePass,
  defaultDeps,
  makeVerify,
  makeAdversarialReview,
  tscCheck,
  touchesSwarmPaths,
  swarmSafetyCheck,
  swarmSafetyConditional,
  lintCheck,
  testCheck,
  lintConditional,
  testConditional,
  runGateProcess,
  SWARM_SAFETY_TESTS,
  STALL_SILENCE_MS,
  STALL_NUDGE_COOLDOWN_MS,
  __resetOrchestratorForTests,
  emptyMetricsCounters,
  MAX_CONFLICT_REWORKS,
  type OrchestratorDeps,
  type IntegrationDeps,
  type ProjectEngine,
  type VerifyCheck,
} from './swarmOrchestrator'
import { createSwarmWorktree } from './swarmWorker'
import { initSelfSupplyRuntime } from './swarmSelfSupply'
import type { ProjectTask } from '../types'

// Every test here drives REAL git: init / clone / commit / branch / rebase / push
// plus real worktree add+remove, each 1–3s in isolation (the slowest, the conflict
// delegation, is ~3.3s). Vitest's DEFAULT 5000ms test timeout is therefore raced
// the moment the machine is loaded: under CPU saturation (many parallel vitest
// forks — exactly the all-branch integration gate running the full suite while
// other workers compute) the timeout TIMER ITSELF fires late, so a ~3.3s test that
// balloons past 5s flips between pass and fail purely by scheduling luck. That is
// the observed flakiness — and, because this same suite is what the gate (card
// 4e7f2151) runs to green-gate a branch, a default-timeout false-RED would bounce a
// healthy branch back to its worker. A generous ceiling makes the REAL-git path
// DETERMINISTIC without weakening any assertion: an unloaded run still finishes in
// ~1–3s; only the slow-under-load case gets headroom (60s is >15× the loaded-peak
// ~6.2s we measured). hookTimeout covers the same REAL-git work in before/afterEach
// (scratch mkdtemp + recursive rm of a tree that may hold git worktrees).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const execFile = promisify(execFileCb)
const git = (cwd: string, args: string[]) =>
  execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

// ── A real repo with a real bare origin (origin/main resolvable + pushable) ────
interface Repo {
  proj: string
  origin: string
}

let home: string
let scratch: string

const setupRepo = async (): Promise<Repo> => {
  const origin = join(scratch, 'origin.git')
  const proj = join(scratch, 'proj')
  await git(scratch, ['init', '--bare', '-b', 'main', origin])
  await git(scratch, ['init', '-b', 'main', proj])
  await git(proj, ['config', 'user.email', 'dev@test'])
  await git(proj, ['config', 'user.name', 'Dev']) // shared config — worktrees inherit
  await git(proj, ['remote', 'add', 'origin', origin])
  await writeFile(join(proj, 'README.md'), '# base\n')
  await git(proj, ['add', '-A'])
  await git(proj, ['commit', '-m', 'base'])
  await git(proj, ['push', '-u', 'origin', 'main']) // creates refs/remotes/origin/main
  await addProjectEntry(proj) // register so projectUUIDFromPath / centralWorktreesDir resolve
  return { proj, origin }
}

/** Same as setupRepo but the default branch is `master` (NO main / origin/main
 *  anywhere) and origin/HEAD → origin/master (exactly what `git clone` of a
 *  master-default repo leaves behind — resolveTarget reads this symbolic ref).
 *  This is the non-main-trunk repo that exposed the promote-gate bug: workers
 *  branch off HEAD (the master tip) yet the OLD countCommitsAhead measured only
 *  against the hardcoded origin/main (unresolvable here) → 0 → never promoted. */
const setupRepoMaster = async (): Promise<Repo> => {
  const origin = join(scratch, 'origin-master.git')
  const proj = join(scratch, 'proj-master')
  await git(scratch, ['init', '--bare', '-b', 'master', origin])
  await git(scratch, ['init', '-b', 'master', proj])
  await git(proj, ['config', 'user.email', 'dev@test'])
  await git(proj, ['config', 'user.name', 'Dev']) // shared config — worktrees inherit
  await git(proj, ['remote', 'add', 'origin', origin])
  await writeFile(join(proj, 'README.md'), '# base\n')
  await git(proj, ['add', '-A'])
  await git(proj, ['commit', '-m', 'base'])
  await git(proj, ['push', '-u', 'origin', 'master']) // creates refs/remotes/origin/master
  await git(proj, ['remote', 'set-head', 'origin', 'master']) // origin/HEAD → origin/master (what `git clone` sets)
  await addProjectEntry(proj)
  return { proj, origin }
}

/** Advance the REMOTE trunk out-of-band (a second clone pushes to origin/main),
 *  so a worker branched off the older trunk now diverges. `content` lands at
 *  `file` — disjoint from a worker's file → a clean rebase; same file → conflict. */
const advanceTrunk = async (origin: string, file: string, content: string): Promise<void> => {
  const other = await mkdtemp(join(scratch, 'other-'))
  await git(scratch, ['clone', origin, other])
  await git(other, ['config', 'user.email', 'other@test'])
  await git(other, ['config', 'user.name', 'Other'])
  await writeFile(join(other, file), content)
  await git(other, ['add', '-A'])
  await git(other, ['commit', '-m', `trunk: ${file}`])
  await git(other, ['push', 'origin', 'main'])
}

// ── In-memory board (the real deps would hit the HTTP API) ─────────────────────
const makeBoard = (cards: ProjectTask[]) => {
  const board = new Map<string, ProjectTask>(cards.map((c) => [c.id, { ...c }]))
  const col = (id: string) => board.get(id)?.boardColumn
  const boardDeps: Pick<
    OrchestratorDeps & IntegrationDeps,
    | 'fetchTasks'
    | 'moveToDoing'
    | 'moveToReview'
    | 'fetchReview'
    | 'moveToDone'
    | 'markConflict'
    | 'recoverCard'
  > = {
    fetchTasks: async () => Array.from(board.values()).map((c) => ({ ...c })),
    moveToDoing: async (_p, id, branch) => {
      const c = board.get(id)
      if (!c) return false
      c.boardColumn = 'doing'
      if (branch) c.branch = branch
      return true
    },
    moveToReview: async (_p, id, branch) => {
      const c = board.get(id)
      if (!c) return false
      c.boardColumn = 'review'
      if (branch) c.branch = branch
      return true
    },
    fetchReview: async () =>
      Array.from(board.values())
        .filter((c) => c.boardColumn === 'review')
        .map((c) => ({ ...c })),
    moveToDone: async (_p, id) => {
      const c = board.get(id)
      if (!c) return false
      c.boardColumn = 'done'
      return true
    },
    markConflict: async (_p, id, value) => {
      const c = board.get(id)
      if (!c) return false
      c.integrationConflict = value
      return true
    },
    recoverCard: async (_p, id, column) => {
      const c = board.get(id)
      if (!c) return false
      c.boardColumn = column
      c.done = false
      return true
    },
  }
  return { board, col, boardDeps }
}

/** A spawn that produces what a real claude worker leaves behind: a real `swarm/*`
 *  worktree off origin/main carrying ONE real commit, PLUS an UNTRACKED scratch
 *  file (logs/build output a real session drops) — the thing a non-force cleanup
 *  would refuse on. No real PTY: the terminalId is synthetic + tracked in `alive`. */
const makeSpawn = (
  proj: string,
  alive: Set<string>,
  opts: { file: (branch: string) => string; content?: string; scratch?: boolean } = {
    file: (b) => `${b.replace(/[^a-z0-9]/gi, '_')}.txt`,
  },
) =>
  (async ({ title, hint }: { title: string; hint?: string }) => {
    const wt = await createSwarmWorktree(proj, { hint })
    const name = opts.file(wt.branch)
    const filePath = join(wt.worktree, name)
    await mkdir(dirname(filePath), { recursive: true }) // allow nested paths (e.g. src/lib/server/swarm*.ts)
    await writeFile(filePath, opts.content ?? `work for ${title}\n`)
    await git(wt.worktree, ['add', '-A'])
    await git(wt.worktree, ['commit', '-m', `work: ${title}`])
    if (opts.scratch !== false) {
      await writeFile(join(wt.worktree, 'scratch.log'), 'uncommitted junk a non-force remove refuses\n')
    }
    const terminalId = `pty-${wt.branch}`
    alive.add(terminalId)
    return { terminalId, agentSessionId: 'sess', worktree: wt.worktree, branch: wt.branch }
  }) as OrchestratorDeps['spawnWorker']

const newEngine = (proj: string, over: Partial<ProjectEngine> = {}): ProjectEngine => ({
  path: proj,
  running: true,
  autoMerge: true,
  passInFlight: false,
  generation: 0,
  timer: null,
  workers: [],
  reviews: [],
  nudges: new Map(),
  conflictedBranches: new Set(),
  verifyFailed: new Map(),
  reviewFailed: new Map(),
  reviewDeferred: new Map(),
  lastIntegrateAt: 0,
  recoveries: new Map(),
  reworks: new Map(),
  reworkReasons: new Map(),
  conflictReworks: new Map(),
  stuckMoves: new Map(),
  rateLimited: new Map(),
  permissionWaits: new Map(),
  log: [],
  anomalies: [],
  selfSupply: initSelfSupplyRuntime(),
  notified: new Set(),
  pendingFatal: [],
  metrics: emptyMetricsCounters(),
  ...over,
})

const exists = (p: string) => stat(p).then(() => true).catch(() => false)

// The adversarial-review dep is FAKED to CLEAN ('integrate') here: these end-to-end
// tests exercise the REAL git landing mechanics (FF / rebase / conflict / verify
// gate), NOT the claude review panel (that's unit-tested separately in
// swarmOrchestrator.test.ts). Without this override the REAL makeAdversarialReview
// in defaultDeps() would spawn N real `claude` sessions in the scratch repo.
const reviewClean: NonNullable<IntegrationDeps['review']> = async () => ({
  decision: 'integrate',
  verdicts: [],
  mustFix: 0,
  clean: 3,
  reason: 'review faked clean (integration test)',
})

const todoCard = (id: string, over: Partial<ProjectTask> = {}): ProjectTask => ({
  id,
  title: `card ${id}`,
  done: false,
  createdAt: `2026-06-24T00:00:0${id.length}Z`,
  boardColumn: 'todo',
  ...over,
})

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-orch-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-orch-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  __resetOrchestratorForTests()
})
afterEach(async () => {
  __resetOrchestratorForTests()
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

describe('swarmOrchestrator — REAL git end-to-end', () => {
  it('(2)+(3) drives a card todo→doing→review→done with a REAL fast-forward, then leaves NO zombie', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const killed: string[] = []
    const { col, boardDeps } = makeBoard([todoCard('a')])
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      review: reviewClean,
      spawnWorker: makeSpawn(proj, alive, { file: (b) => `${b.replace(/[^a-z0-9]/gi, '_')}.txt`, scratch: true }),
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: (id) => {
        killed.push(id)
        alive.delete(id)
      },
    }
    const engine = newEngine(proj)

    // Pass 1 — dispatch: a real worktree + commit is created; the card moves to doing.
    await runDispatchPass(engine, deps)
    expect(col('a')).toBe('doing')
    expect(engine.workers).toHaveLength(1)
    const w = engine.workers[0]
    expect(w.branch).toMatch(/^swarm\//)
    const worktree = w.worktree
    expect(await exists(worktree)).toBe(true)
    // The branch really carries one commit ahead of the trunk (the REAL probe).
    expect(await deps.countCommitsAhead(proj, w.branch)).toBe(1)

    // Pass 2 — monitor promotes doing→review (commits + ready heartbeat).
    await runDispatchPass(engine, deps)
    expect(col('a')).toBe('review')

    // Integrate — REAL fast-forward push onto origin/main, then teardown.
    await runIntegratePass(engine, deps)
    expect(col('a')).toBe('done')

    // (2) the commit really landed on origin/main.
    const { stdout: trunkLog } = await git(proj, ['log', '--oneline', 'origin/main'])
    expect(trunkLog).toMatch(/work: card a/)
    expect(await deps.countCommitsAhead(proj, w.branch)).toBe(0) // branch fully merged

    // (3) no zombie: worktree force-removed (despite the untracked scratch),
    //     branch deleted, PTY killed by id, slot freed.
    expect(await exists(worktree)).toBe(false)
    const { stdout: branches } = await git(proj, ['branch', '--list', w.branch])
    expect(branches.trim()).toBe('')
    expect(killed).toEqual([w.terminalId])
    expect(engine.workers).toHaveLength(0)
    expect(engine.log.some((l) => l.message.startsWith('integrated (ff)'))).toBe(true)
  })

  it('(1) promotes a COMMITTED worker to review in a NON-MAIN (master) trunk repo, then LANDS it on origin/master', async () => {
    // Regression for the promote-gate bug: countCommitsAhead was hardcoded to
    // ['origin/main','main']. In a master-default repo (no main / origin/main
    // anywhere) the worker forks off HEAD (the master tip) and commits, but the
    // old probe resolved NEITHER base → returned 0 → classifyWorker saw
    // hasWork=false → the card sat in 'doing' forever (stall/runaway → re-dispatch
    // loop, work never reaching review). The integrate stage already resolved the
    // trunk via resolveTarget; this aligns the promote gate with it.
    const { proj } = await setupRepoMaster()
    const alive = new Set<string>()
    const killed: string[] = []
    const { col, boardDeps } = makeBoard([todoCard('m')])
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      review: reviewClean,
      spawnWorker: makeSpawn(proj, alive, { file: (b) => `${b.replace(/[^a-z0-9]/gi, '_')}.txt`, scratch: true }),
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: (id) => {
        killed.push(id)
        alive.delete(id)
      },
    }
    const engine = newEngine(proj)

    // Pass 1 — dispatch: a real worktree + commit off the master tip; card → doing.
    await runDispatchPass(engine, deps)
    expect(col('m')).toBe('doing')
    expect(engine.workers).toHaveLength(1)
    const w = engine.workers[0]
    // THE fix's unit: the branch is seen as 1 ahead of the MASTER trunk (origin/master),
    // not 0 against an unresolvable origin/main. This is the assertion that was RED before.
    expect(await deps.countCommitsAhead(proj, w.branch)).toBe(1)

    // Pass 2 — monitor PROMOTES doing→review (the observable condition (1)): the
    // committed worker is no longer stranded just because the trunk isn't `main`.
    await runDispatchPass(engine, deps)
    expect(col('m')).toBe('review')

    // Integrate — REAL fast-forward push onto origin/MASTER (resolveTarget handles
    // the non-main trunk on the integrate side too), card → done, no zombie.
    await runIntegratePass(engine, deps)
    expect(col('m')).toBe('done')
    const { stdout: trunkLog } = await git(proj, ['log', '--oneline', 'origin/master'])
    expect(trunkLog).toMatch(/work: card m/)
    expect(await deps.countCommitsAhead(proj, w.branch)).toBe(0) // fully merged into master
  })

  it('(2) lands a DIVERGED branch by a REAL rebase when the trunk moved under it', async () => {
    const { proj, origin } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      review: reviewClean,
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: () => {},
    }
    // Build a finished worker branch (off the ORIGINAL trunk) directly.
    const spawn = makeSpawn(proj, alive, { file: () => 'worker.txt', content: 'worker change\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card r', hint: 'r' })
    // Now move the trunk forward with a DISJOINT file → the branch diverges.
    await advanceTrunk(origin, 'trunk.txt', 'trunk change\n')
    // Seed the review card pointing at that branch.
    board.set('r', todoCard('r', { boardColumn: 'review', branch: res.branch }))

    await runIntegratePass(newEngine(proj), deps)
    expect(col('r')).toBe('done')
    // The worker's change AND the trunk's later change are BOTH on origin/main —
    // the rebase replayed worker.txt on top of the moved trunk and landed it.
    const { stdout: tree } = await git(proj, ['ls-tree', '-r', '--name-only', 'origin/main'])
    expect(tree).toMatch(/worker\.txt/)
    expect(tree).toMatch(/trunk\.txt/)
  })

  it('(1)(2)(3)(4) DELEGATES a real conflict to its worker to rebase, then LANDS the resolved branch by fast-forward (no force)', async () => {
    // The order goal's headline change (card 012a2848): a real rebase conflict is no
    // longer parked for a human — the engine hands it back to the branch's worker to
    // rebase ITS OWN branch + resolve + commit (no push, no force), then re-integrates.
    const { proj, origin } = await setupRepo()
    const alive = new Set<string>()
    const killed: string[] = []
    const { board, col, boardDeps } = makeBoard([])
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      review: reviewClean,
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: (id) => {
        killed.push(id)
        alive.delete(id)
      },
    }
    // Worker edits collide.txt; trunk then edits the SAME file differently → real conflict.
    const spawn = makeSpawn(proj, alive, { file: () => 'collide.txt', content: 'WORKER side\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card c', hint: 'c' })
    await advanceTrunk(origin, 'collide.txt', 'TRUNK side\n')
    board.set('c', todoCard('c', { boardColumn: 'review', branch: res.branch }))

    // The engine counts this worker live (a `claude` TUI lingers after /order finishes —
    // the common case that drives the IN-PLACE rebase delegation).
    const engine = newEngine(proj, {
      workers: [
        {
          terminalId: res.terminalId,
          branch: res.branch,
          worktree: res.worktree,
          taskId: 'c',
          taskTitle: 'card c',
          startedAt: '2026-06-29T00:00:00Z',
          stage: 'done',
        },
      ],
    })

    await git(proj, ['fetch', 'origin', 'main'])
    const trunkBefore = (await git(proj, ['rev-parse', 'origin/main'])).stdout.trim()

    // Pass 1 — conflict → DELEGATED (条件1). The card leaves review for doing (条件3: it
    // can't be double-integrated while resolving), the SEPARATE conflict budget is bumped,
    // the trunk is UNTOUCHED (条件2: the rebase was aborted, nothing pushed, no force), and
    // the live worker + its worktree are KEPT so it can fix in place.
    await runIntegratePass(engine, deps)
    expect(col('c')).toBe('doing')
    expect(engine.conflictReworks.get('c')).toBe(1)
    expect(engine.conflictReworks.get('c')).toBeLessThanOrEqual(MAX_CONFLICT_REWORKS)
    expect(engine.workers).toHaveLength(1) // live worker kept (not torn down)
    expect(await exists(res.worktree)).toBe(true)
    const trunkMid = (await git(proj, ['rev-parse', 'origin/main'])).stdout.trim()
    expect(trunkMid).toBe(trunkBefore) // failed integrate left the trunk exactly where it was

    // The worker does what it was told: rebase its OWN branch onto the moved trunk +
    // resolve + commit (NO push). Reproduce that end state in the REAL worktree (a merged
    // resolution), then the monitor re-promotes the card to review.
    await git(res.worktree, ['fetch', 'origin', 'main'])
    await git(res.worktree, ['reset', '--hard', 'origin/main'])
    await writeFile(join(res.worktree, 'collide.txt'), 'RESOLVED: worker + trunk\n')
    await git(res.worktree, ['add', '-A'])
    await git(res.worktree, ['commit', '-m', 'resolve: collide.txt rebased onto trunk'])
    board.set('c', { ...board.get('c')!, boardColumn: 'review' })

    // Pass 2 — the resolved branch now fast-forwards onto the trunk → the engine LANDS it
    // (条件4) and resets the conflict budget.
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(col('c')).toBe('done')
    expect(engine.conflictReworks.has('c')).toBe(false) // budget reset on a successful land

    // The land was a NORMAL push (NO force): the prior trunk is an ANCESTOR of the new one.
    await git(proj, ['fetch', 'origin', 'main'])
    await git(proj, ['merge-base', '--is-ancestor', trunkBefore, 'origin/main']) // throws if not an ancestor
    const { stdout: landed } = await git(proj, ['show', 'origin/main:collide.txt'])
    expect(landed).toContain('RESOLVED')
  }, 30_000) // two REAL integrate passes (rebase worktrees) — over the 5s default

  it('(1) auto-merge REFUSES a branch whose verification is RED — sends it back review→doing, trunk UNTOUCHED', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    // A REAL worker branch off origin/main carrying one commit (the to-be-landed work).
    const spawn = makeSpawn(proj, alive, { file: () => 'worker.txt', content: 'worker change\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card v', hint: 'v' })
    board.set('v', todoCard('v', { boardColumn: 'review', branch: res.branch }))

    // Capture the trunk so we can prove the RED verify left origin/main untouched.
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkBefore } = await git(proj, ['rev-parse', 'origin/main'])

    // The REAL verify dep (makeVerify) drives the REAL worktree+rebase mechanics;
    // a fake CHECK reports RED — proving the gate blocks the merge end-to-end
    // without needing a TypeScript toolchain in the throwaway repo.
    const checked: string[] = []
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      review: reviewClean,
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: () => {},
      instructRework: () => {}, // synthetic PTY in this fixture — keep the fix-in-place nudge inert
      verify: makeVerify({
        applicable: async () => true,
        run: async (dir) => {
          checked.push(dir) // the gate materialized a REAL rebased worktree to check
          return { ok: false, output: 'TS2322: fake type error' }
        },
      }),
    }
    // The engine OWNS this live worker, so a RED verify CONTINUES it in place — the card
    // is sent review→doing (差し戻し) for the same worker to fix on the same branch.
    const engine = newEngine(proj, {
      workers: [
        {
          terminalId: res.terminalId,
          branch: res.branch,
          worktree: res.worktree,
          taskId: 'v',
          taskTitle: 'card v',
          startedAt: new Date(0).toISOString(),
          stage: 'done',
        },
      ],
    })
    await runIntegratePass(engine, deps)

    // Sent back to rework: card → doing, nothing landed, the trunk never moved.
    expect(checked).toHaveLength(1) // the rebased tree was really built + checked
    expect(col('v')).toBe('doing')
    expect(engine.reworks.get('v')).toBe(1)
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkAfter } = await git(proj, ['rev-parse', 'origin/main'])
    expect(trunkAfter).toBe(trunkBefore)
    expect(engine.log.some((l) => l.message.includes('差し戻し review→doing'))).toBe(true)
    // The worker's branch is LEFT — the worker keeps working it (not cleaned up).
    const { stdout: branch } = await git(proj, ['branch', '--list', res.branch])
    expect(branch.trim()).not.toBe('')
    // The verify worktree was torn down — no zombie left behind.
    const { stdout: wts } = await git(proj, ['worktree', 'list'])
    expect(wts).not.toMatch(/\.verify-/)
  })

  it('(1) auto-merge LANDS a branch whose verification is GREEN (real worktree, real check)', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    const spawn = makeSpawn(proj, alive, { file: () => 'worker.txt', content: 'ok\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card g', hint: 'g' })
    board.set('g', todoCard('g', { boardColumn: 'review', branch: res.branch }))
    const checked: string[] = []
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      review: reviewClean,
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: () => {},
      verify: makeVerify({
        applicable: async () => true,
        run: async (dir) => {
          checked.push(dir)
          return { ok: true, output: '' }
        },
      }),
    }
    await runIntegratePass(newEngine(proj), deps)
    expect(checked).toHaveLength(1) // the gate ran a real check on the rebased tree
    expect(col('g')).toBe('done') // verified green → landed
    const { stdout: trunkLog } = await git(proj, ['log', '--oneline', 'origin/main'])
    expect(trunkLog).toMatch(/work: card g/)
  })

  it('(5) NEVER dispatches a blocked-column card', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const spawned: string[] = []
    const { col, boardDeps } = makeBoard([
      todoCard('blk', { boardColumn: 'blocked' }),
      todoCard('ok'),
    ])
    const baseSpawn = makeSpawn(proj, alive, { file: (b) => `${b.replace(/[^a-z0-9]/gi, '_')}.txt`, scratch: false })
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      review: reviewClean,
      spawnWorker: async (o) => {
        spawned.push(o.title)
        return baseSpawn(o)
      },
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => null,
      killPty: () => {},
    }
    await runDispatchPass(newEngine(proj), deps)
    // Only the todo card was dispatched; the blocked card was left untouched.
    expect(spawned).toEqual(['card ok'])
    expect(col('ok')).toBe('doing')
    expect(col('blk')).toBe('blocked')
  })

  it('(1)+(3) RECOVERS a crashed worker: REAL worktree torn down + card requeued, no zombie', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { col, boardDeps } = makeBoard([todoCard('a')])
    // A spawn that creates a REAL `swarm/*` worktree off origin/main but commits
    // NOTHING — a worker that died before producing any integrable work (the
    // bare-crash case: the conservative DONE rule must NOT promote it, but the
    // engine MUST recover it rather than strand the card + leak the worktree).
    const spawn = (async ({ hint }: { title: string; hint?: string }) => {
      const wt = await createSwarmWorktree(proj, { hint })
      const terminalId = `pty-${wt.branch}`
      alive.add(terminalId)
      return { terminalId, agentSessionId: 'sess', worktree: wt.worktree, branch: wt.branch }
    }) as OrchestratorDeps['spawnWorker']
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(), // REAL recoverWorker (removeSwarmWorktree) + countCommitsAhead
      ...boardDeps, // board-backed recoverCard (no HTTP server in the test)
      spawnWorker: spawn,
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => null,
      killPty: () => {},
    }
    const engine = newEngine(proj)

    // Pass 1 — dispatch: a real worktree is created (NO commit); card → doing.
    await runDispatchPass(engine, deps)
    expect(col('a')).toBe('doing')
    expect(engine.workers).toHaveLength(1)
    const { worktree, terminalId, branch } = engine.workers[0]
    expect(await exists(worktree)).toBe(true) // real worktree on disk
    expect(await deps.countCommitsAhead(proj, branch)).toBe(0) // nothing committed (bare crash)

    // The worker's `claude` PTY dies / is force-killed.
    alive.delete(terminalId)

    // Pass 2 — the engine detects the dead PTY and RECOVERS: the REAL worktree is
    // force-removed and the card is requeued to todo. No zombie remains.
    await runDispatchPass(engine, deps)
    expect(await exists(worktree)).toBe(false) // ← zombie worktree GONE from disk
    expect(col('a')).toBe('todo') // ← requeued, not stranded in doing
    expect(engine.workers).toHaveLength(0) // slot freed
    expect(engine.log.some((l) => l.message.startsWith('worker lost — card → todo'))).toBe(true)
  })

  it('(a)+(3) RECLAIMS a STALLED (alive but silent) worker: nudges, then REAL worktree torn down + card requeued', async () => {
    const { proj } = await setupRepo()
    const { col, boardDeps } = makeBoard([todoCard('a')])
    const nudged: string[] = []
    // A spawn that creates a REAL `swarm/*` worktree off origin/main; the worker
    // stays ALIVE the whole time (isAlive true) but produces NO heartbeat and NO PTY
    // output — the alive-but-unresponsive STALL the crash path can never catch.
    const spawn = (async ({ hint }: { title: string; hint?: string }) => {
      const wt = await createSwarmWorktree(proj, { hint })
      return { terminalId: `pty-${wt.branch}`, agentSessionId: 'sess', worktree: wt.worktree, branch: wt.branch }
    }) as OrchestratorDeps['spawnWorker']
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(), // REAL recoverWorker (removeSwarmWorktree)
      ...boardDeps,
      spawnWorker: spawn,
      isAlive: () => true, // ALIVE throughout — exercises the STALL path, not the crash path
      readHeartbeat: async () => null, // never beats
      lastOutputAt: () => null, // never emits output → silent on BOTH channels
      nudge: (id) => {
        nudged.push(id)
        return true
      },
      killPty: () => {},
    }
    const engine = newEngine(proj)

    // Pass 1 — dispatch: a real worktree is created; card → doing.
    await runDispatchPass(engine, deps)
    expect(col('a')).toBe('doing')
    expect(engine.workers).toHaveLength(1)
    const { worktree, startedAt } = engine.workers[0]
    expect(await exists(worktree)).toBe(true) // real worktree on disk
    const t0 = Date.parse(startedAt)

    // Pass 2 — silent past STALL_SILENCE_MS → NUDGE #1 (worktree untouched).
    await runDispatchPass(engine, deps, t0 + STALL_SILENCE_MS + 1)
    expect(nudged).toHaveLength(1)
    expect(await exists(worktree)).toBe(true)
    // Pass 3 — cooldown elapsed, still silent → NUDGE #2.
    await runDispatchPass(engine, deps, t0 + STALL_SILENCE_MS + STALL_NUDGE_COOLDOWN_MS + 2)
    expect(nudged).toHaveLength(2)
    expect(await exists(worktree)).toBe(true)
    // Pass 4 — budget spent, still silent → RECLAIM: the REAL worktree is force-removed.
    await runDispatchPass(engine, deps, t0 + STALL_SILENCE_MS + 2 * STALL_NUDGE_COOLDOWN_MS + 3)
    expect(await exists(worktree)).toBe(false) // ← zombie worktree GONE from disk
    expect(col('a')).toBe('todo') // ← requeued for one retry, not stranded in doing
    expect(engine.workers).toHaveLength(0) // slot freed
    expect(engine.log.some((l) => l.message.startsWith('worker stalled — reclaimed — card → todo'))).toBe(true)
  })
})

// ── tscCheck — the default verification check ─────────────────────────────────
// The (1) gate's real verdict source. `applicable` is a TS-PROJECT test (a
// tsconfig), NOT an environment test, so a non-TS repo is never blocked; but a TS
// project we can't actually compile (no node_modules) is reported RED, not waved
// through — the gate never silently auto-merges unverified TS.

describe('tscCheck — default verify check', () => {
  it('applicable: true only with a tsconfig.json (a non-TS project is never gated)', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-tsc-app-')))
    expect(await tscCheck.applicable(dir)).toBe(false) // no tsconfig → not a TS project
    await writeFile(join(dir, 'tsconfig.json'), '{}')
    expect(await tscCheck.applicable(dir)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('run: BLOCKS (ok:false) when node_modules is absent — never silently passes a TS project', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-tsc-run-')))
    const r = await tscCheck.run(dir) // no node_modules/.bin/tsc present
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/node_modules|tsc unavailable/)
    await rm(dir, { recursive: true, force: true })
  })

  it('run: passes (ok:true) a clean tree against the REAL tsc compiler', async () => {
    // A minimal worktree with a trivially-correct .ts file + THIS repo's whole
    // node_modules symlinked in (exactly what makeVerify does, so tsc resolves its
    // typescript package + libs) → a real `tsc --noEmit` goes green. Proves run()
    // actually invokes the compiler, not just the binary-presence check.
    const realNm = join(process.cwd(), 'node_modules')
    if (!(await stat(join(realNm, '.bin', 'tsc')).then(() => true).catch(() => false))) return
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-tsc-green-')))
    const { symlink, unlink } = await import('fs/promises')
    try {
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true } }),
      )
      await writeFile(join(dir, 'ok.ts'), 'export const n: number = 1\n')
      await symlink(realNm, join(dir, 'node_modules')) // whole tree, like makeVerify
      const r = await tscCheck.run(dir)
      expect(r.ok).toBe(true)
    } finally {
      // Drop the symlink BEFORE rm (defensive — rm never follows a symlinked dir,
      // but unlink the pointer first so the real node_modules can't be at risk).
      await unlink(join(dir, 'node_modules')).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── Swarm self-modification gate (card 34d42890) ─────────────────────────────
// A branch that touches swarm code must keep the A1 safety net (swarmSafety.*,
// card 8d778645) GREEN before it can auto-merge — the self-modification guard.
// The matcher is pure; the suite-runner check is exercised on its cheap branches;
// and the END-TO-END gate is driven through the REAL makeVerify composition (real
// diff detection + real worktree/rebase) with a FAKE safety check so the BEHAVIOR
// is deterministic and fast (the actual suite is green today — 50 tests in
// swarmSafety.test.ts — and is run via the REAL vitest path in production).

describe('touchesSwarmPaths — the swarm-code path matcher', () => {
  it('matches each enumerated swarm path, rejects unrelated + look-alikes', () => {
    // swarm code (the goal's three globs) → true
    expect(touchesSwarmPaths(['src/lib/server/swarmOrchestrator.ts'])).toBe(true)
    expect(touchesSwarmPaths(['src/lib/server/swarmIntegrate.ts'])).toBe(true)
    expect(touchesSwarmPaths(['src/lib/server/swarmSafety.test.ts'])).toBe(true) // the net itself
    expect(touchesSwarmPaths(['server/routes/swarm.ts'])).toBe(true)
    expect(touchesSwarmPaths(['server/routes/__tests__/swarmSafety.routes.test.ts'])).toBe(true) // the route net
    expect(touchesSwarmPaths(['src/components/canvas/modules/SwarmModule.tsx'])).toBe(true)
    expect(touchesSwarmPaths(['src/components/canvas/modules/SwarmSupplyPane.tsx'])).toBe(true)
    // one swarm file among many unrelated ones → still true
    expect(touchesSwarmPaths(['README.md', 'src/lib/server/swarmWorker.ts'])).toBe(true)
    // unrelated → false (condition 3: these branches must not be slowed)
    expect(touchesSwarmPaths([])).toBe(false)
    expect(touchesSwarmPaths(['README.md', 'src/App.tsx'])).toBe(false)
    expect(touchesSwarmPaths(['src/lib/server/projectData.ts'])).toBe(false) // not swarm*
    expect(touchesSwarmPaths(['server/routes/project.ts'])).toBe(false)
    expect(touchesSwarmPaths(['src/components/canvas/modules/BoardModule.tsx'])).toBe(false)
    // look-alikes the TIGHT anchors must REJECT (no over-broad matching)
    expect(touchesSwarmPaths(['src/lib/server/sub/swarmX.ts'])).toBe(false) // not directly under the dir
    expect(touchesSwarmPaths(['docs/swarm.ts'])).toBe(false) // wrong dir
    expect(touchesSwarmPaths(['server/routes/swarmObsolete.ts'])).toBe(false) // only swarm.ts exact
  })
})

describe('swarmSafetyCheck — the real swarm-safety suite runner', () => {
  it('applicable: true only when BOTH safety test files are present', async () => {
    const empty = await realpath(await mkdtemp(join(scratch, 'ss-empty-')))
    expect(await swarmSafetyCheck.applicable(empty)).toBe(false) // no files → not OPEN GROUND's source
    // both files present (empty stubs) → applicable
    const has = await realpath(await mkdtemp(join(scratch, 'ss-has-')))
    for (const t of SWARM_SAFETY_TESTS) {
      await mkdir(dirname(join(has, t)), { recursive: true })
      await writeFile(join(has, t), '')
    }
    expect(await swarmSafetyCheck.applicable(has)).toBe(true)
    // only ONE of the two present → NOT applicable (an incomplete net is not the net)
    const partial = await realpath(await mkdtemp(join(scratch, 'ss-partial-')))
    await mkdir(dirname(join(partial, SWARM_SAFETY_TESTS[0])), { recursive: true })
    await writeFile(join(partial, SWARM_SAFETY_TESTS[0]), '')
    expect(await swarmSafetyCheck.applicable(partial)).toBe(false)
  })

  it('run: RED when a safety file is MISSING in the branch (deletion/tamper never passes)', async () => {
    // A worktree whose net is incomplete (one file deleted) must NOT pass on the
    // survivors — vitest would silently skip the missing file, so run() guards on it.
    const dir = await realpath(await mkdtemp(join(scratch, 'ss-tampered-')))
    await mkdir(dirname(join(dir, SWARM_SAFETY_TESTS[0])), { recursive: true })
    await writeFile(join(dir, SWARM_SAFETY_TESTS[0]), '') // only ONE of the two present
    const r = await swarmSafetyCheck.run(dir)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/safety test missing/)
  })

  it('run: RED when vitest is unavailable (uninstalled project) — never waved through', async () => {
    // Net intact (both files present) but no node_modules/.bin/vitest → still RED.
    const dir = await realpath(await mkdtemp(join(scratch, 'ss-novitest-')))
    for (const t of SWARM_SAFETY_TESTS) {
      await mkdir(dirname(join(dir, t)), { recursive: true })
      await writeFile(join(dir, t), '')
    }
    const r = await swarmSafetyCheck.run(dir)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/vitest unavailable/)
  })
})

// ── lint + test quality-floor checks (card 4e7f2151) ─────────────────────────
// The two NEW always-on merge gates. Like tscCheck, each is `applicable` only to a
// project that actually carries the tooling (an eslint / vitest config) — a foreign
// repo the engine drives is never blocked on a gate it can't run — and `run` reports
// RED (never silently passes) when the binary is absent in the to-be-landed tree.
describe('lintCheck + testCheck — the project quality-floor verify checks', () => {
  it('lintCheck.applicable: true with an eslint config (eslintrc OR flat), false without', async () => {
    const none = await realpath(await mkdtemp(join(scratch, 'lint-none-')))
    expect(await lintCheck.applicable(none)).toBe(false) // no eslint setup → never blocked
    const rc = await realpath(await mkdtemp(join(scratch, 'lint-rc-')))
    await writeFile(join(rc, '.eslintrc.json'), '{}') // what OPEN GROUND uses
    expect(await lintCheck.applicable(rc)).toBe(true)
    const flat = await realpath(await mkdtemp(join(scratch, 'lint-flat-')))
    await writeFile(join(flat, 'eslint.config.js'), 'export default []')
    expect(await lintCheck.applicable(flat)).toBe(true)
  })

  it('lintCheck.run: RED when eslint is unavailable (uninstalled project) — never waved through', async () => {
    const dir = await realpath(await mkdtemp(join(scratch, 'lint-nobin-')))
    const r = await lintCheck.run(dir) // no node_modules/.bin/eslint
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/eslint unavailable/)
  })

  it('testCheck.applicable: true with a vitest/vite config, false without', async () => {
    const none = await realpath(await mkdtemp(join(scratch, 'test-none-')))
    expect(await testCheck.applicable(none)).toBe(false)
    const vt = await realpath(await mkdtemp(join(scratch, 'test-vt-')))
    await writeFile(join(vt, 'vitest.config.ts'), 'export default {}') // what OPEN GROUND uses
    expect(await testCheck.applicable(vt)).toBe(true)
    const vite = await realpath(await mkdtemp(join(scratch, 'test-vite-')))
    await writeFile(join(vite, 'vite.config.ts'), 'export default {}') // vitest reads vite config too
    expect(await testCheck.applicable(vite)).toBe(true)
  })

  it('testCheck.run: RED when vitest is unavailable (uninstalled project) — never waved through', async () => {
    const dir = await realpath(await mkdtemp(join(scratch, 'test-nobin-')))
    await writeFile(join(dir, 'vitest.config.ts'), 'export default {}')
    const r = await testCheck.run(dir) // no node_modules/.bin/vitest
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/vitest unavailable/)
  })
})

// ── runGateProcess — the fork-pool group reaper (card 4e7f2151 MUST-FIX) ─────────
// The two vitest gates + the eslint gate spawn a tool that FORKS a worker pool (vitest
// with no explicit pool uses the default FORK pool = child_process workers). execFile's
// `timeout` SIGTERMs ONLY the direct pid, so on a wedged-suite timeout — exactly when the
// suite is stuck and the forks are live — the fork workers ORPHAN, each spinning a core to
// machine saturation (this repo's documented hazard, feedback_vitest_no_midrun_kill).
// runGateProcess spawns the tool DETACHED (its own process group) and SIGKILLs the WHOLE
// group on the timeout path, reaping the tool AND its forks together — the same group-kill
// the engine's self-update path already does (electron/selfUpdate.js killProcessTree).
describe('runGateProcess — reaps the whole fork pool on a timeout (no orphaned workers)', () => {
  // Real-process proof with teeth, mirroring selfUpdate.test.ts's killProcessTree test: a
  // tool that forks a worker (the vitest-fork-worker stand-in) which INHERITS the tool's
  // group, then both wedge so the run hits its timeout. On timeout runGateProcess must kill
  // the GROUP — so the forked worker dies too. A parent-only kill (what execFile's timeout
  // does) would leave the worker orphaned; the worker's death is the proof the group, not
  // just the parent pid, was reaped. POSIX-only (the negative-pid group signal is POSIX).
  it.skipIf(process.platform === 'win32')(
    'group-kills the spawned tool AND its forked worker, and rejects fail-closed',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gate-reap-'))
      const workerPidFile = join(dir, 'worker.pid')
      // The "tool": forks a worker (NOT detached → inherits the tool's group), records its
      // pid, then BOTH wedge forever (never exit) — guaranteeing runGateProcess times out.
      const toolSrc =
        'const cp=require("child_process"),fs=require("fs");' +
        'const w=cp.spawn(process.execPath,["-e","setInterval(()=>{},1e9)"],{stdio:"ignore"});' +
        'fs.writeFileSync(process.env.WORKER_PIDFILE,String(w.pid));' +
        'setInterval(()=>{},1e9);'

      const isAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0) // signal 0 = existence probe, kills nothing
          return true
        } catch {
          return false
        }
      }
      const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
          if (pred()) return true
          await new Promise((r) => setTimeout(r, 25))
        }
        return pred()
      }

      let workerPid = -1
      let rejected = false
      try {
        // 8000ms timeout: must be comfortably longer than node child startup so the
        // forked worker REGISTERS its pid before the timeout reaps the whole tree —
        // under a loaded machine (saturated cores) a `node -e` cold start can take
        // well over a second, so the old 1500ms raced registration and flaked. The
        // wedged tool never exits cleanly, so the ONLY way out is still the timeout
        // path under test; we just give registration deterministic headroom (the
        // test now costs ~8s instead of ~1.5s — determinism over speed).
        const run = runGateProcess(process.execPath, ['-e', toolSrc], {
          cwd: dir,
          timeout: 8000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, WORKER_PIDFILE: workerPidFile },
        })
        // Capture the worker pid WHILE the tree is alive (well before the timeout reaps it).
        const ready = await waitFor(
          () => existsSync(workerPidFile) && readFileSync(workerPidFile, 'utf8').trim() !== '',
          15000, // condition-wait cap: returns the instant the pid lands; only the slow-under-load ceiling grows
        )
        expect(ready).toBe(true)
        workerPid = Number(readFileSync(workerPidFile, 'utf8').trim())
        expect(workerPid).toBeGreaterThan(0)
        expect(isAlive(workerPid)).toBe(true)

        // FAIL-CLOSED: a wedged suite that times out must REJECT (so the check returns RED,
        // never a silent pass). Resolving here would be the bug.
        await run.then(
          () => {
            throw new Error('runGateProcess resolved on a wedged tool — a timeout must reject')
          },
          () => {
            rejected = true
          },
        )
        expect(rejected).toBe(true)

        // The forked worker must be DEAD — the proof the whole GROUP was reaped, not just
        // the tool's direct pid (the orphan execFile's parent-only timeout-kill leaves).
        const workerDead = await waitFor(() => !isAlive(workerPid), 15000)
        expect(workerDead).toBe(true)
      } finally {
        // Defensive cleanup: never leak the worker if an assertion failed before the reap.
        try {
          if (workerPid > 0) process.kill(workerPid, 'SIGKILL')
        } catch {
          /* already gone */
        }
        rmSync(dir, { recursive: true, force: true })
      }
    },
    45000, // gate timeout (8s) + worker-death condition-wait (≤15s) + REAL-process headroom under load
  )
})

describe('swarmOrchestrator — swarm self-modification gate (verify)', () => {
  // verify = REAL makeVerify(fake-tsc, [swarm-safety w/ REAL diff gate + FAKE check]).
  // The diff detection + the appliesTo gate are REAL; only the (heavy) suite run is faked.
  const gateDeps = (
    proj: string,
    alive: Set<string>,
    boardDeps: ReturnType<typeof makeBoard>['boardDeps'],
    flags: { tsc: boolean; safety: boolean },
  ) => {
    const safetyRuns: string[] = []
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      review: reviewClean,
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: () => {},
      instructRework: () => {}, // synthetic PTY in this fixture — keep the nudge inert
      verify: makeVerify(
        {
          applicable: async () => true,
          run: async () => ({ ok: flags.tsc, output: flags.tsc ? '' : 'TS2322 fake type error' }),
        },
        [
          {
            label: 'swarm-safety',
            appliesTo: touchesSwarmPaths, // the REAL diff gate
            check: {
              applicable: async () => true,
              run: async (dir) => {
                safetyRuns.push(dir)
                return { ok: flags.safety, output: flags.safety ? '' : 'invariant A regression (fake)' }
              },
            },
          },
        ],
      ),
    }
    return { deps, safetyRuns }
  }

  it('(1)+(2) swarm change + safety RED → sent back review→doing, suite RAN, trunk UNTOUCHED', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    // A REAL worker branch whose ONLY change is a swarm file → touchesSwarmPaths.
    const spawn = makeSpawn(proj, alive, {
      file: () => 'src/lib/server/swarmFoo.ts',
      content: 'export const x = 1\n',
      scratch: false,
    })
    const res = await spawn({ projectPath: proj, title: 'swarm card', hint: 's' })
    board.set('s', todoCard('s', { boardColumn: 'review', branch: res.branch }))
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkBefore } = await git(proj, ['rev-parse', 'origin/main'])

    const { deps, safetyRuns } = gateDeps(proj, alive, boardDeps, { tsc: true, safety: false })
    const engine = newEngine(proj, {
      workers: [
        {
          terminalId: res.terminalId,
          branch: res.branch,
          worktree: res.worktree,
          taskId: 's',
          taskTitle: 'swarm card',
          startedAt: new Date(0).toISOString(),
          stage: 'done',
        },
      ],
    })
    await runIntegratePass(engine, deps)

    expect(safetyRuns).toHaveLength(1) // the swarm-safety suite REALLY ran (swarm touched)
    expect(col('s')).toBe('doing') // RED → 差し戻し (blocked from landing)
    expect(engine.reworks.get('s')).toBe(1)
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkAfter } = await git(proj, ['rev-parse', 'origin/main'])
    expect(trunkAfter).toBe(trunkBefore) // nothing landed on the trunk
    expect(engine.log.some((l) => l.message.includes('差し戻し review→doing'))).toBe(true)
    // the block reason names the SAFETY gate (not tsc) — proves WHICH gate stopped it
    expect(engine.log.some((l) => l.message.includes('swarm-safety'))).toBe(true)
  })

  it('(1) swarm change + safety GREEN → integrated (done), suite RAN', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    const spawn = makeSpawn(proj, alive, {
      file: () => 'src/lib/server/swarmFoo.ts',
      content: 'export const x = 2\n',
      scratch: false,
    })
    const res = await spawn({ projectPath: proj, title: 'swarm ok', hint: 'sg' })
    board.set('sg', todoCard('sg', { boardColumn: 'review', branch: res.branch }))
    const { deps, safetyRuns } = gateDeps(proj, alive, boardDeps, { tsc: true, safety: true })
    await runIntegratePass(newEngine(proj), deps)
    expect(safetyRuns).toHaveLength(1) // the suite ran (swarm touched) and was GREEN
    expect(col('sg')).toBe('done') // both gates green → landed
    const { stdout: trunkLog } = await git(proj, ['log', '--oneline', 'origin/main'])
    expect(trunkLog).toMatch(/work: swarm ok/)
  })

  it('(3) non-swarm change → swarm-safety suite is NOT run; branch lands on tsc alone', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    // A REAL worker branch whose change is a NON-swarm file (README.md exists in base).
    const spawn = makeSpawn(proj, alive, {
      file: () => 'README.md',
      content: '# changed by worker\n',
      scratch: false,
    })
    const res = await spawn({ projectPath: proj, title: 'doc card', hint: 'd' })
    board.set('d', todoCard('d', { boardColumn: 'review', branch: res.branch }))
    // safety:false would BLOCK *if* it ran — so a landing proves the suite was SKIPPED.
    const { deps, safetyRuns } = gateDeps(proj, alive, boardDeps, { tsc: true, safety: false })
    await runIntegratePass(newEngine(proj), deps)
    expect(safetyRuns).toHaveLength(0) // ← unrelated branch never pays for the suite
    expect(col('d')).toBe('done') // tsc green → landed normally
    const { stdout: trunkLog } = await git(proj, ['log', '--oneline', 'origin/main'])
    expect(trunkLog).toMatch(/work: doc card/)
  })
})

// ── lint/tsc/test quality-floor gate (card 4e7f2151) ─────────────────────────
// GENERALIZES B2: where B2 ran ONE suite (swarm-safety) ONLY for swarm-touching
// branches, the floor here runs lint + tsc + the FULL test suite for EVERY branch
// before it may auto-merge. The gate is driven through the REAL makeVerify composition
// wired EXACTLY like defaultDeps (tsc primary + [lint always-on, swarm-safety diff-gated,
// test always-on]); the diff detection + appliesTo gating are REAL — only the (heavy)
// check RUNS are faked so behavior is deterministic. Each fake records its label as it
// runs, so a test can assert WHICH gates ran and in what order (first-red-blocks).
describe('swarmOrchestrator — lint/tsc/test quality-floor gate (card 4e7f2151)', () => {
  const qualityGateDeps = (
    proj: string,
    alive: Set<string>,
    boardDeps: ReturnType<typeof makeBoard>['boardDeps'],
    flags: { tsc?: boolean; lint?: boolean; test?: boolean; safety?: boolean },
  ) => {
    const ran: string[] = []
    const reworkMsgs: string[] = []
    const fake = (label: string, ok: boolean, out: string): VerifyCheck => ({
      applicable: async () => true,
      run: async () => {
        ran.push(label)
        return { ok, output: ok ? '' : out }
      },
    })
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      review: reviewClean, // green-path lands without spawning the real claude panel
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: () => {},
      instructRework: (_id, msg) => {
        reworkMsgs.push(msg) // capture the worker's 差し戻し instruction (carries the failing gate)
      },
      // Mirror defaultDeps EXACTLY: tsc primary, then lint(always)/swarm-safety(diff)/test(always).
      verify: makeVerify(fake('tsc', flags.tsc ?? true, 'TS2322 fake type error'), [
        { label: 'lint', appliesTo: () => true, check: fake('lint', flags.lint ?? true, 'eslint: 3 problems (fake)') },
        {
          label: 'swarm-safety',
          appliesTo: touchesSwarmPaths, // the REAL diff gate (B2)
          check: fake('swarm-safety', flags.safety ?? true, 'invariant A regression (fake)'),
        },
        { label: 'test', appliesTo: () => true, check: fake('test', flags.test ?? true, '2 failed (fake)') },
      ]),
    }
    return { deps, ran, reworkMsgs }
  }

  it('wiring: lint + test are ALWAYS-ON (appliesTo ⇒ true); swarm-safety stays diff-gated', () => {
    // The generalization, asserted at the wiring level: the quality-floor checks fire for
    // EVERY branch (empty diff included), while B2's swarm-safety only fires for swarm code.
    expect(lintConditional.appliesTo([])).toBe(true)
    expect(testConditional.appliesTo([])).toBe(true)
    expect(lintConditional.appliesTo(['README.md'])).toBe(true)
    expect(testConditional.appliesTo(['README.md'])).toBe(true)
    expect(swarmSafetyConditional.appliesTo([])).toBe(false)
    expect(swarmSafetyConditional.appliesTo(['README.md'])).toBe(false)
    expect(swarmSafetyConditional.appliesTo(['src/lib/server/swarmFoo.ts'])).toBe(true)
    // the conditionals wrap the real exported checks (so defaultDeps runs the real lint/test)
    expect(lintConditional.check).toBe(lintCheck)
    expect(testConditional.check).toBe(testCheck)
  })

  it('(1)+(2) NON-swarm branch all-GREEN → LANDS; lint+test RAN, swarm-safety SKIPPED', async () => {
    // The core generalization: a branch touching NO swarm code still pays lint + test
    // (B2 would have run nothing but tsc here). All green → it lands by fast-forward.
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    const spawn = makeSpawn(proj, alive, { file: () => 'src/App.tsx', content: 'export const A = 1\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'ui card', hint: 'u' })
    board.set('u', todoCard('u', { boardColumn: 'review', branch: res.branch }))
    const { deps, ran } = qualityGateDeps(proj, alive, boardDeps, {}) // all green
    await runIntegratePass(newEngine(proj), deps)
    expect(col('u')).toBe('done') // verified green → landed
    expect(ran).toEqual(['tsc', 'lint', 'test']) // lint+test ran for a NON-swarm branch; swarm-safety skipped
    const { stdout: trunkLog } = await git(proj, ['log', '--oneline', 'origin/main'])
    expect(trunkLog).toMatch(/work: ui card/)
  })

  it('(3)+(4) NON-swarm branch with lint RED → 差し戻し review→doing, trunk UNTOUCHED, reason names "lint"', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    const spawn = makeSpawn(proj, alive, { file: () => 'src/App.tsx', content: 'export const B = 2\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'lint card', hint: 'l' })
    board.set('l', todoCard('l', { boardColumn: 'review', branch: res.branch }))
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkBefore } = await git(proj, ['rev-parse', 'origin/main'])
    const { deps, ran, reworkMsgs } = qualityGateDeps(proj, alive, boardDeps, { lint: false })
    // A LIVE worker the engine OWNS → a RED gate CONTINUES it in place (review→doing).
    const engine = newEngine(proj, {
      workers: [
        {
          terminalId: res.terminalId,
          branch: res.branch,
          worktree: res.worktree,
          taskId: 'l',
          taskTitle: 'lint card',
          startedAt: new Date(0).toISOString(),
          stage: 'done',
        },
      ],
    })
    await runIntegratePass(engine, deps)
    expect(col('l')).toBe('doing') // RED lint → 差し戻し, NOT merged
    expect(engine.reworks.get('l')).toBe(1)
    expect(ran).toEqual(['tsc', 'lint']) // first-red-blocks: tsc green, lint red, test never ran
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkAfter } = await git(proj, ['rev-parse', 'origin/main'])
    expect(trunkAfter).toBe(trunkBefore) // nothing landed
    // condition (4): the failing gate is named in BOTH the engine log AND the worker's instruction
    expect(engine.log.some((l) => l.message.includes('差し戻し review→doing') && l.message.includes('lint'))).toBe(true)
    expect(reworkMsgs.some((m) => m.includes('lint'))).toBe(true)
  })

  it('(3)+(4) NON-swarm branch with test RED → 差し戻し review→doing, trunk UNTOUCHED, reason names "test"', async () => {
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    const spawn = makeSpawn(proj, alive, { file: () => 'src/App.tsx', content: 'export const C = 3\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'test card', hint: 't' })
    board.set('t', todoCard('t', { boardColumn: 'review', branch: res.branch }))
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkBefore } = await git(proj, ['rev-parse', 'origin/main'])
    const { deps, ran, reworkMsgs } = qualityGateDeps(proj, alive, boardDeps, { test: false })
    const engine = newEngine(proj, {
      workers: [
        {
          terminalId: res.terminalId,
          branch: res.branch,
          worktree: res.worktree,
          taskId: 't',
          taskTitle: 'test card',
          startedAt: new Date(0).toISOString(),
          stage: 'done',
        },
      ],
    })
    await runIntegratePass(engine, deps)
    expect(col('t')).toBe('doing') // RED test → 差し戻し
    expect(engine.reworks.get('t')).toBe(1)
    expect(ran).toEqual(['tsc', 'lint', 'test']) // tsc+lint green, test red (full suite runs last)
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkAfter } = await git(proj, ['rev-parse', 'origin/main'])
    expect(trunkAfter).toBe(trunkBefore)
    expect(engine.log.some((l) => l.message.includes('差し戻し review→doing') && l.message.includes('test'))).toBe(true)
    expect(reworkMsgs.some((m) => m.includes('test'))).toBe(true)
  })

  it('(B2 contained) swarm branch runs lint + swarm-safety + test; all green → LANDS', async () => {
    // A swarm-touching branch pays the new quality floor AND B2's diff-gated swarm-safety
    // net — proving B2 is contained, not replaced (the safety gate STILL fires for it).
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    const spawn = makeSpawn(proj, alive, {
      file: () => 'src/lib/server/swarmFoo.ts',
      content: 'export const x = 1\n',
      scratch: false,
    })
    const res = await spawn({ projectPath: proj, title: 'swarm card', hint: 's' })
    board.set('s', todoCard('s', { boardColumn: 'review', branch: res.branch }))
    const { deps, ran } = qualityGateDeps(proj, alive, boardDeps, {}) // all green
    await runIntegratePass(newEngine(proj), deps)
    expect(col('s')).toBe('done')
    expect(ran).toEqual(['tsc', 'lint', 'swarm-safety', 'test']) // B2's gate STILL runs, alongside the floor
    const { stdout: trunkLog } = await git(proj, ['log', '--oneline', 'origin/main'])
    expect(trunkLog).toMatch(/work: swarm card/)
  })
})

// ── makeAdversarialReview — REAL panel orchestration (card a14329dc) ───────────
// Drives the REAL makeAdversarialReview (real worktree materialize + rebase + diff +
// tally) with an INJECTED runReviewer (no claude) so the panel/decision logic is
// exercised end-to-end deterministically — closing the gap between the pure
// tallyReview unit tests and the routing tests (which fake the whole `review` dep).
describe('makeAdversarialReview — REAL panel orchestration (injected reviewers, real git)', () => {
  const MUSTFIX = (note: string) => `reviewing the diff…\nOPENGROUND_REVIEW: MUST_FIX ${note} ::OG_REVIEW_END::`
  const CLEAN = 'looks fine to me\nOPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::'
  const ABSTAIN = 'the session hung and never emitted a verdict marker'
  // Deterministic per 1-based reviewer index, regardless of Promise.all timing.
  const byIndex = (m: Record<number, string>) => (a: { index: number }) => m[a.index] ?? CLEAN
  const tipOf = async (proj: string, branch: string) =>
    (await git(proj, ['rev-parse', `refs/heads/${branch}`])).stdout.trim()

  it('majority must-fix (2 of 3) → rework, must-fix note surfaced, REAL panel ran', async () => {
    const { proj } = await setupRepo()
    const spawn = makeSpawn(proj, new Set(), { file: () => 'worker.txt', content: 'change\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card a', hint: 'a' })
    await git(proj, ['fetch', 'origin', 'main'])
    const tip = await tipOf(proj, res.branch)
    let spawned = 0
    const review = makeAdversarialReview({
      reviewers: 3,
      runReviewer: async (a) => {
        spawned++
        return byIndex({ 1: MUSTFIX('off-by-one in the loop'), 2: MUSTFIX('null deref'), 3: CLEAN })(a)
      },
    })
    const r = await review(proj, res.branch, 'main', { tip })
    expect(r.decision).toBe('rework')
    expect(r.mustFix).toBe(2)
    expect(r.clean).toBe(1)
    expect(r.reason).toContain('off-by-one')
    expect(spawned).toBe(3) // a real 3-reviewer panel ran in the materialized worktree
  })

  it('unanimous clean → integrate', async () => {
    const { proj } = await setupRepo()
    const spawn = makeSpawn(proj, new Set(), { file: () => 'worker.txt', content: 'ok\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card c', hint: 'c' })
    await git(proj, ['fetch', 'origin', 'main'])
    const tip = await tipOf(proj, res.branch)
    const review = makeAdversarialReview({ reviewers: 3, runReviewer: async () => CLEAN })
    const r = await review(proj, res.branch, 'main', { tip })
    expect(r.decision).toBe('integrate')
    expect(r.clean).toBe(3)
    expect(r.mustFix).toBe(0)
  })

  it('all reviewers abstain (no marker) → defer — never a false clean', async () => {
    const { proj } = await setupRepo()
    const spawn = makeSpawn(proj, new Set(), { file: () => 'worker.txt', content: 'ok\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card x', hint: 'x' })
    await git(proj, ['fetch', 'origin', 'main'])
    const tip = await tipOf(proj, res.branch)
    const review = makeAdversarialReview({ reviewers: 3, runReviewer: async () => ABSTAIN })
    const r = await review(proj, res.branch, 'main', { tip })
    expect(r.decision).toBe('defer')
    expect(r.mustFix).toBe(0)
    expect(r.clean).toBe(0)
  })

  it('empty diff (tip already at trunk) → integrate WITHOUT spawning the panel', async () => {
    const { proj } = await setupRepo()
    await git(proj, ['fetch', 'origin', 'main'])
    const trunkSha = (await git(proj, ['rev-parse', 'origin/main'])).stdout.trim()
    let spawned = 0
    const review = makeAdversarialReview({
      reviewers: 3,
      runReviewer: async () => {
        spawned++
        return CLEAN
      },
    })
    const r = await review(proj, 'swarm/empty', 'main', { tip: trunkSha })
    expect(r.decision).toBe('integrate')
    expect(spawned).toBe(0) // nothing to review → no reviewer launched
  })

  it('skipIfTip === tip → rework (skipped), no panel spawned', async () => {
    const { proj } = await setupRepo()
    const spawn = makeSpawn(proj, new Set(), { file: () => 'worker.txt', content: 'ok\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card s', hint: 's' })
    await git(proj, ['fetch', 'origin', 'main'])
    const tip = await tipOf(proj, res.branch)
    let spawned = 0
    const review = makeAdversarialReview({
      reviewers: 3,
      runReviewer: async () => {
        spawned++
        return CLEAN
      },
    })
    const r = await review(proj, res.branch, 'main', { tip, skipIfTip: tip })
    expect(r.decision).toBe('rework')
    expect(r.skipped).toBe(true)
    expect(spawned).toBe(0) // unchanged tip → panel short-circuited
  })

  it('rebase conflict → integrate (deferred to integrate, panel not run)', async () => {
    const { proj, origin } = await setupRepo()
    const spawn = makeSpawn(proj, new Set(), { file: () => 'collide.txt', content: 'WORKER\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card k', hint: 'k' })
    await advanceTrunk(origin, 'collide.txt', 'TRUNK\n') // same file, diverging → rebase conflict
    await git(proj, ['fetch', 'origin', 'main'])
    const tip = await tipOf(proj, res.branch)
    let spawned = 0
    const review = makeAdversarialReview({
      reviewers: 3,
      runReviewer: async () => {
        spawned++
        return CLEAN
      },
    })
    const r = await review(proj, res.branch, 'main', { tip })
    expect(r.decision).toBe('integrate') // conflict is integrate's to own/stamp, not review's
    expect(spawned).toBe(0) // reviewers never ran (rebase failed before they could)
  })
})
