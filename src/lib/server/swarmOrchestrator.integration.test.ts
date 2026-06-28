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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import {
  runDispatchPass,
  runIntegratePass,
  defaultDeps,
  makeVerify,
  tscCheck,
  STALL_SILENCE_MS,
  STALL_NUDGE_COOLDOWN_MS,
  __resetOrchestratorForTests,
  type OrchestratorDeps,
  type IntegrationDeps,
  type ProjectEngine,
} from './swarmOrchestrator'
import { createSwarmWorktree } from './swarmWorker'
import type { ProjectTask } from '../types'

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
    await writeFile(join(wt.worktree, name), opts.content ?? `work for ${title}\n`)
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
  lastIntegrateAt: 0,
  recoveries: new Map(),
  reworks: new Map(),
  stuckMoves: new Map(),
  rateLimited: new Map(),
  permissionWaits: new Map(),
  log: [],
  anomalies: [],
  ...over,
})

const exists = (p: string) => stat(p).then(() => true).catch(() => false)
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

  it('(2) lands a DIVERGED branch by a REAL rebase when the trunk moved under it', async () => {
    const { proj, origin } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
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

  it('(2) REFUSES a real conflict: card stays in review, stamped, trunk untouched', async () => {
    const { proj, origin } = await setupRepo()
    const alive = new Set<string>()
    const { board, col, boardDeps } = makeBoard([])
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      isAlive: (id) => alive.has(id),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: () => {},
    }
    // Worker edits collide.txt; trunk then edits the SAME file differently.
    const spawn = makeSpawn(proj, alive, { file: () => 'collide.txt', content: 'WORKER side\n', scratch: false })
    const res = await spawn({ projectPath: proj, title: 'card c', hint: 'c' })
    await advanceTrunk(origin, 'collide.txt', 'TRUNK side\n')
    board.set('c', todoCard('c', { boardColumn: 'review', branch: res.branch }))

    // Capture the REAL current trunk (after the out-of-band advance is fetched in)
    // so we can prove the FAILED integration left origin/main exactly where it was.
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkBefore } = await git(proj, ['rev-parse', 'origin/main'])
    const engine = newEngine(proj)
    await runIntegratePass(engine, deps)

    // The card is NOT advanced; it is stamped + remembered for manual integration.
    expect(col('c')).toBe('review')
    expect(board.get('c')?.integrationConflict).toBe(true)
    expect(engine.conflictedBranches.has(res.branch)).toBe(true)
    // The trunk was never moved (the rebase conflict was aborted — nothing pushed).
    await git(proj, ['fetch', 'origin', 'main'])
    const { stdout: trunkAfter } = await git(proj, ['rev-parse', 'origin/main'])
    expect(trunkAfter).toBe(trunkBefore)
    // The worker's branch + worktree are LEFT for the human (not cleaned up).
    const { stdout: branch } = await git(proj, ['branch', '--list', res.branch])
    expect(branch.trim()).not.toBe('')
  })

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
