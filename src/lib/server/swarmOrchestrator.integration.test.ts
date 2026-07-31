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
import { mkdtemp, mkdir, rm, realpath, writeFile, readFile, stat, utimes } from 'fs/promises'
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
  commitWipBeforeTeardown,
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
  MAX_EXEC_MS,
  // RESURRECTION reflex (card B): the real manager heartbeat seam + freshness rule,
  // and the state-machine constants — exercised end-to-end against real files below.
  writeManagerHeartbeat,
  readManagerHeartbeatAt,
  isManagerHeartbeatFresh,
  MANAGER_HEARTBEAT_STALE_MS,
  MANAGER_RESUME_GRACE_MS,
  MAX_MANAGER_RESUME_ATTEMPTS,
  // The presence probe itself (2026-07-18): absent / idle / active off the REAL
  // sessions store + manager.json + transcript, with only the PTY signal injected.
  defaultManagerPresence,
  defaultManagerDeliveryAt,
  sessionBackgroundTaskAt,
  managerIntegrationStalled,
  defaultNudgeManager,
  STALL_ESCALATE_DELAY_MS,
  STALL_ECHO_GUARD_MS,
  // Commander-presence display read (検品可視化): the full heartbeat snapshot the
  // Swarm tab renders — exercised against the REAL file + real repo key below.
  readManagerHeartbeatInfo,
  getOrchestratorState,
  __resetOrchestratorForTests,
  emptyMetricsCounters,
  type OrchestratorDeps,
  type IntegrationDeps,
  type ProjectEngine,
  type VerifyCheck,
} from './swarmOrchestrator'
import { createSwarmWorktree } from './swarmWorker'
import { recordSwarmSession } from './swarmSessions'
import { sessionJsonlPath, sessionSubagentsDir } from './transcript'
import { isTierCooling, __resetQuotaForTest } from './swarmQuota'
import { initSelfSupplyRuntime } from './swarmSelfSupply'
import { initOverseerRuntime } from './swarmOverseer'
import type { ProjectTask, SwarmFatalNotification } from '../types'

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
let savedClaudeCfg: string | undefined
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
  highRiskHolds: new Map(),
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
  overseer: initOverseerRuntime(),
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

// MANAGER-ONLY INTEGRATION (2026-07-15): the integrate pass now WAKES the commander
// instead of merging. The REAL defaultWakeManager spawns a `claude` PTY
// (spawnSwarmManager) — an integration test must never do that — so these tests fake
// the wake: managerPresence:'absent' (no desk ⇒ the engine spawns one) and wakeManager
// records the branches it was asked to wake. nudgeManager must never fire on this path
// (it is the LIVE-desk response) — it throws so a regression that routes an absent desk
// through the nudge is loud rather than silent. Returns the recorder + the deps to
// spread over defaultDeps().
const wakeFake = (): {
  woke: string[]
  deps: Pick<IntegrationDeps, 'managerPresence' | 'nudgeManager' | 'wakeManager'>
} => {
  const woke: string[] = []
  return {
    woke,
    deps: {
      managerPresence: async () => 'absent',
      nudgeManager: async () => {
        throw new Error('nudgeManager must not be called when the desk is absent')
      },
      wakeManager: async (_p, cards) => {
        for (const c of cards) woke.push(c.branch)
        return true
      },
    },
  }
}

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
  // Pin claude's config as well: this file reaches claudeTrust (via
  // ensureClaudeFolderTrusted / removeClaudeFolderTrust), whose path is
  // CLAUDE_CONFIG_PATH ?? homedir()/.claude.json — a homedir anchor that
  // OPENGROUND_HOME cannot move. Unpinned, these cases read and REWRITE the
  // user's real ~/.claude.json (their claude OAuth tokens live there).
  // Caught 2026-07-19 by the production-home fence; it had been live and silent.
  savedClaudeCfg = process.env.CLAUDE_CONFIG_PATH
  process.env.CLAUDE_CONFIG_PATH = join(home, '.claude.json')
  __resetMigrationCacheForTests()
  __resetOrchestratorForTests()
})
afterEach(async () => {
  __resetOrchestratorForTests()
  if (savedClaudeCfg === undefined) delete process.env.CLAUDE_CONFIG_PATH
  else process.env.CLAUDE_CONFIG_PATH = savedClaudeCfg
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

describe('swarmOrchestrator — REAL git end-to-end', () => {
  it('(2) drives a card todo→doing→review with REAL git, then WAKES the commander and NEVER FF-pushes (完了条件1+2)', async () => {
    // MANAGER-ONLY INTEGRATION (2026-07-15): the engine drives dispatch + monitor
    // (still its job) but NO LONGER integrates. Once the worker is ready (review), the
    // integrate pass WAKES the commander and leaves origin/main EXACTLY where it was —
    // the structural guarantee that the engine's readiness can never move the trunk.
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const killed: string[] = []
    const wake = wakeFake()
    const { col, boardDeps } = makeBoard([todoCard('a')])
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      ...wake.deps,
      spawnWorker: makeSpawn(proj, alive, { file: (b) => `${b.replace(/[^a-z0-9]/gi, '_')}.txt`, scratch: true }),
      isAlive: (w) => alive.has(w.terminalId!),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      // killPty now takes the WORKER (workerRuntime seam), not a bare id. For a
      // PTY worker the key IS terminalId, so the assertions are unchanged.
      killPty: (w) => {
        const id = w.terminalId!
        killed.push(id)
        alive.delete(id)
      },
    }
    const engine = newEngine(proj)

    const trunkBefore = (await git(proj, ['rev-parse', 'origin/main'])).stdout.trim()

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

    // Integrate — the engine WAKES the commander for the ready branch and does NOTHING
    // to the trunk. The card stays in review (the commander owns the merge), the
    // worktree + branch + PTY are all UNTOUCHED, and origin/main has not moved.
    await runIntegratePass(engine, deps)
    expect(col('a')).toBe('review') // NOT done — the engine never merges
    expect(wake.woke).toEqual([w.branch]) // it woke the commander for this branch (完了条件2)

    // 完了条件1: origin/main is EXACTLY where it was — the engine FF-pushed nothing.
    const trunkAfter = (await git(proj, ['rev-parse', 'origin/main'])).stdout.trim()
    expect(trunkAfter).toBe(trunkBefore)
    const { stdout: trunkLog } = await git(proj, ['log', '--oneline', 'origin/main'])
    expect(trunkLog).not.toMatch(/work: card a/) // the worker's commit is NOT on the trunk
    expect(await deps.countCommitsAhead(proj, w.branch)).toBe(1) // still 1 ahead — nothing merged

    // The branch's worktree + PTY are kept (the commander tears them down on merge).
    expect(await exists(worktree)).toBe(true)
    expect(killed).toEqual([]) // the engine killed no PTY — it did not land anything
    expect(engine.log.some((l) => l.message.includes('マネージャーを起こしました'))).toBe(true)
    expect(engine.log.some((l) => l.message.startsWith('integrated (ff)'))).toBe(false)
  })

  it('(1) promotes a COMMITTED worker to review in a NON-MAIN (master) trunk repo, then WAKES the commander', async () => {
    // Regression for the promote-gate bug: countCommitsAhead was hardcoded to
    // ['origin/main','main']. In a master-default repo (no main / origin/main
    // anywhere) the worker forks off HEAD (the master tip) and commits, but the
    // old probe resolved NEITHER base → returned 0 → classifyWorker saw
    // hasWork=false → the card sat in 'doing' forever (stall/runaway → re-dispatch
    // loop, work never reaching review). The promote gate resolves the non-main trunk
    // via resolveTarget. (2026-07-15: the engine no longer LANDS — it wakes the
    // commander — but the promote-gate regression this fixes is still engine work.)
    const { proj } = await setupRepoMaster()
    const alive = new Set<string>()
    const wake = wakeFake()
    const { col, boardDeps } = makeBoard([todoCard('m')])
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      ...wake.deps,
      spawnWorker: makeSpawn(proj, alive, { file: (b) => `${b.replace(/[^a-z0-9]/gi, '_')}.txt`, scratch: true }),
      isAlive: (w) => alive.has(w.terminalId!),
      readHeartbeat: async () => ({ ready: true, blocked: false }),
      killPty: () => {},
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

    // Integrate — the engine wakes the commander (resolveTarget resolved origin/master
    // as the trunk so the wake fires), and does NOT land: the card stays in review and
    // origin/master is untouched.
    const trunkBefore = (await git(proj, ['rev-parse', 'origin/master'])).stdout.trim()
    await runIntegratePass(engine, deps)
    expect(col('m')).toBe('review') // NOT done — the engine never merges
    expect(wake.woke).toEqual([w.branch])
    expect((await git(proj, ['rev-parse', 'origin/master'])).stdout.trim()).toBe(trunkBefore)
    expect(await deps.countCommitsAhead(proj, w.branch)).toBe(1) // still ahead — nothing merged
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
      isAlive: (w) => alive.has(w.terminalId!),
      readHeartbeat: async () => null,
      killPty: () => {},
    }
    await runDispatchPass(newEngine(proj), deps)
    // Only the todo card was dispatched; the blocked card was left untouched.
    expect(spawned).toEqual(['card ok'])
    expect(col('ok')).toBe('doing')
    expect(col('blk')).toBe('blocked')
  })

  it('a crash WITH salvaged work goes to BLOCKED, not todo — the salvage counts as commits (twin guard)', async () => {
    // 2026-07-29. `probe` is taken BEFORE the teardown, so it cannot know the
    // teardown just added a WIP commit to this worker's branch. recoveryColumn's
    // twin fix keys on exactly that number (`commitsAhead > 0 ⇒ blocked`) because
    // a card whose branch already holds commits must NOT return to `todo`, where
    // the next dispatch mints a SECOND worktree/branch for the same work and
    // orphans the first (the twin class, 0723). Feeding it the stale zero
    // re-opened that door for precisely the workers whose branch we just wrote to.
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { col, boardDeps } = makeBoard([todoCard('a')])
    const spawn = (async ({ hint }: { title: string; hint?: string }) => {
      const wt = await createSwarmWorktree(proj, { hint })
      const terminalId = `pty-${wt.branch}`
      alive.add(terminalId)
      // The worker produced REAL work but never committed it — the salvage case.
      await writeFile(join(wt.worktree, 'answer.ts'), 'export const answer = 42\n')
      return { terminalId, agentSessionId: 'sess', worktree: wt.worktree, branch: wt.branch }
    }) as OrchestratorDeps['spawnWorker']
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(), // REAL recoverWorker ⇒ REAL commitWipBeforeTeardown
      ...boardDeps,
      spawnWorker: spawn,
      isAlive: (w) => alive.has(w.terminalId!),
      readHeartbeat: async () => null,
      killPty: () => {},
    }
    const engine = newEngine(proj)

    await runDispatchPass(engine, deps)
    const { worktree, terminalId, branch } = engine.workers[0]
    expect(await deps.countCommitsAhead(proj, branch)).toBe(0) // nothing committed YET

    alive.delete(terminalId) // the PTY dies with the work still uncommitted

    await runDispatchPass(engine, deps)
    expect(await exists(worktree)).toBe(false)
    // The salvage landed on the branch…
    expect(await deps.countCommitsAhead(proj, branch)).toBe(1)
    expect(engine.log.some((l) => l.message.includes('auto-saved as a WIP commit'))).toBe(true)
    // …so the card must NOT be re-dispatchable. Pre-fix this was 'todo' and the
    // next pass forked a twin, stranding the branch we had just salvaged onto.
    expect(col('a')).toBe('blocked')
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
      isAlive: (w) => alive.has(w.terminalId!),
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

  it('SALVAGES uncommitted work as a WIP commit before tearing a RUNAWAY worker down (2026-07-12 全損)', async () => {
    // THE ACCIDENT, reproduced end-to-end on real git: a worker had finished its
    // implementation but had NOT committed it (the old discipline said commit AFTER
    // the completion gate, and the gate was still running) when the execution-time
    // ceiling fired. Teardown force-removes the worktree — `--force` is mandatory
    // for a dirty tree — so 15 files / 47KB ceased to exist. The engine must now
    // COMMIT what it finds before it removes anything.
    const { proj } = await setupRepo()
    const { col, boardDeps } = makeBoard([todoCard('a')])
    // A worker that creates a REAL worktree and commits NOTHING — it just works.
    const spawn = (async ({ hint }: { title: string; hint?: string }) => {
      const wt = await createSwarmWorktree(proj, { hint })
      return { terminalId: `pty-${wt.branch}`, agentSessionId: 'sess', worktree: wt.worktree, branch: wt.branch }
    }) as OrchestratorDeps['spawnWorker']
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(), // REAL recoverWorker ⇒ REAL commitWipBeforeTeardown + worktree removal
      ...boardDeps,
      spawnWorker: spawn,
      isAlive: () => true, // BUSY throughout — only the runaway ceiling can stop it
      readHeartbeat: async () => null,
      killPty: () => {},
    }
    const engine = newEngine(proj)

    // Pass 1 — dispatch: a real worktree on a real `swarm/*` branch, nothing committed.
    await runDispatchPass(engine, deps)
    expect(engine.workers).toHaveLength(1)
    const { worktree, branch, startedAt } = engine.workers[0]
    expect(await deps.countCommitsAhead(proj, branch)).toBe(0)

    // The worker DOES THE WORK — an edit and a new file — and commits none of it.
    await writeFile(join(worktree, 'README.md'), '# base\nthe finished implementation\n')
    await writeFile(join(worktree, 'newFeature.ts'), 'export const answer = 42\n')

    // Pass 2 — the execution ceiling fires while it is still busy ⇒ runaway teardown.
    const now = Date.parse(startedAt) + MAX_EXEC_MS + 1
    await runDispatchPass(engine, deps, now)

    // The worktree is gone and the card parked — the reclaim itself is UNCHANGED …
    expect(await exists(worktree)).toBe(false)
    expect(col('a')).toBe('blocked') // a re-run would overrun again ⇒ a human looks
    expect(engine.workers).toHaveLength(0)

    // … but THE WORK SURVIVES: it was committed to the worker's branch first.
    expect(await deps.countCommitsAhead(proj, branch)).toBe(1)
    const { stdout: subject } = await git(proj, ['log', '-1', '--format=%s', branch])
    expect(subject).toContain('WIP')
    expect(subject).toContain('runaway') // the reclaim REASON is in the message
    // The actual bytes are on the branch — the edit AND the untracked new file
    // (`git add -A`), readable from the shared repo after the worktree is gone.
    const { stdout: added } = await git(proj, ['show', `${branch}:newFeature.ts`])
    expect(added).toBe('export const answer = 42\n')
    const { stdout: edited } = await git(proj, ['show', `${branch}:README.md`])
    expect(edited).toContain('the finished implementation')
    // The commander is TOLD: a re-dispatch branches fresh, so this log line is the
    // only way the owner learns there is salvaged work sitting on the old branch.
    expect(engine.log.some((l) => l.message.includes('auto-saved as a WIP commit'))).toBe(true)
  })

  it('NO-OPs on a clean worktree — an empty reclaim never manufactures a commit', async () => {
    // The other half of the contract: the salvage must be invisible when there is
    // nothing to save. A crashed worker with a CLEAN tree is torn down exactly as
    // before — no WIP commit, no phantom "work" for the commander to review.
    const { proj } = await setupRepo()
    const alive = new Set<string>()
    const { boardDeps } = makeBoard([todoCard('a')])
    const spawn = (async ({ hint }: { title: string; hint?: string }) => {
      const wt = await createSwarmWorktree(proj, { hint })
      const terminalId = `pty-${wt.branch}`
      alive.add(terminalId)
      return { terminalId, agentSessionId: 'sess', worktree: wt.worktree, branch: wt.branch }
    }) as OrchestratorDeps['spawnWorker']
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      spawnWorker: spawn,
      isAlive: (w) => alive.has(w.terminalId!),
      readHeartbeat: async () => null,
      killPty: () => {},
    }
    const engine = newEngine(proj)
    await runDispatchPass(engine, deps)
    const { worktree, branch, terminalId } = engine.workers[0]
    alive.delete(terminalId) // dies with a spotless tree

    await runDispatchPass(engine, deps)
    expect(await exists(worktree)).toBe(false)
    expect(await deps.countCommitsAhead(proj, branch)).toBe(0) // ← nothing invented
    expect(engine.log.some((l) => l.message.includes('auto-saved as a WIP commit'))).toBe(false)
  })

  it('FAIL-CLOSED: keeps the worktree (failed:true) when git status is UNAVAILABLE — never removes unprovable work', async () => {
    // The load-bearing CC2 invariant (未コミットの成果がある worktree は絶対に消さない):
    // teardown force-removes the tree, so the ONLY guard is that commitWipBeforeTeardown
    // proves it clean (or commits it) FIRST. When git cannot even report status the
    // guard must FAIL CLOSED — report `failed` so the caller KEEPS the tree — never
    // "unreadable ⇒ clean ⇒ remove" (a fail-closed check that silently degrades to
    // fail-open is the exact trap in reference_failclosed_guard_defeated_by_tolerant_reader).
    const dir = await mkdtemp(join(tmpdir(), 'og-wip-brokengit-'))
    try {
      await writeFile(join(dir, 'work.ts'), 'export const answer = 42\n') // real, uncommitted work
      // A broken gitfile: `git status` follows the gitdir pointer, finds nothing, and
      // errors — deterministically, independent of any parent repo above tmpdir.
      await writeFile(join(dir, '.git'), 'gitdir: /openground/no/such/gitdir\n')
      const res = await commitWipBeforeTeardown(dir, 'crash')
      expect(res.failed).toBe(true) // ← unprovable ⇒ KEEP (defaultRecoverWorker won't remove)
      expect(res.committed).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('FAIL-CLOSED on a DETACHED HEAD: the commit would be unreachable, so it is NOT reported as saved', async () => {
    // 2026-07-29. `git commit` succeeding proves the objects were written — not
    // that anything will still point at them. On a detached HEAD (a worker
    // interrupted mid-rebase / mid-bisect) the commit lands on NO branch, and the
    // caller's very next act is `git worktree remove --force`, which drops the
    // only reference. The work becomes unreachable — and because we used to
    // return committed:true, the caller tore the tree down BELIEVING the salvage
    // had worked. Reporting success while destroying the work is worse than not
    // trying: this function's whole contract is that a reclaim never destroys
    // uncommitted work (02 章 §6).
    const dir = await mkdtemp(join(tmpdir(), 'og-wip-detached-'))
    try {
      const g = (args: string[]) =>
        execFile('git', args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      await g(['init', '-q', '-b', 'main', '.'])
      await g(['config', 'user.email', 'dev@test'])
      await g(['config', 'user.name', 'Dev'])
      await writeFile(join(dir, 'base.ts'), 'export const a = 1\n')
      await g(['add', '-A'])
      await g(['commit', '-m', 'base'])
      // Detach — exactly the state a worker interrupted mid-rebase is left in.
      const head = (await g(['rev-parse', 'HEAD'])).stdout.trim()
      await g(['checkout', '--detach', head])
      await writeFile(join(dir, 'work.ts'), 'export const answer = 42\n') // real work

      const res = await commitWipBeforeTeardown(dir, 'crash')

      // FAIL-CLOSED: the caller must KEEP this worktree — it holds the only
      // reachable copy. Pre-fix this returned { committed: true } and the tree
      // was force-removed with the work inside it.
      expect(res.committed).toBe(false)
      expect(res.failed).toBe(true)
      expect(res.reason).toMatch(/detached/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports the BRANCH a successful salvage landed on (the reachability proof)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'og-wip-branch-'))
    try {
      const g = (args: string[]) =>
        execFile('git', args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      await g(['init', '-q', '-b', 'swarm/x', '.'])
      await g(['config', 'user.email', 'dev@test'])
      await g(['config', 'user.name', 'Dev'])
      await writeFile(join(dir, 'base.ts'), 'export const a = 1\n')
      await g(['add', '-A'])
      await g(['commit', '-m', 'base'])
      await writeFile(join(dir, 'work.ts'), 'export const answer = 42\n')

      const res = await commitWipBeforeTeardown(dir, 'crash')
      expect(res.committed).toBe(true)
      // The branch name is what lets the caller count this commit toward
      // commitsAhead before choosing the card's recovery column (twin guard).
      expect(res.branch).toBe('swarm/x')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is a safe NO-OP (not failed) when the worktree is already GONE — nothing to save, nothing to keep', async () => {
    // Distinct from the fail-closed case: a pruned/never-created tree is not a failure
    // — the idempotent teardown must be allowed to proceed, not stall on a phantom.
    const res = await commitWipBeforeTeardown(join(tmpdir(), 'og-wip-absent-zzzzzz'), 'crash')
    expect(res).toEqual({ committed: false })
  })

  it('(a)+(3) RECLAIMS a STALLED (alive but silent) worker: nudges, then REAL worktree torn down + card requeued', async () => {
    const { proj } = await setupRepo()
    const { col, boardDeps } = makeBoard([todoCard('a')])
    const nudged: string[] = []
    const escalated: string[] = []
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
      nudge: (w) => {
        const id = w.terminalId!
        nudged.push(id)
        return true
      },
      // Fake (no real ESC write / no real 3s delay) so the escalation step stays
      // deterministic and fast in this integration test.
      escalate: async (w) => {
        escalated.push(w.terminalId!)
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
    // Pass 4 — nudge budget spent, still silent → ESCALATE (ESC+continue), one shot,
    // NOT a reclaim yet (the worktree survives).
    await runDispatchPass(engine, deps, t0 + STALL_SILENCE_MS + 2 * STALL_NUDGE_COOLDOWN_MS + 3)
    expect(escalated).toHaveLength(1)
    expect(await exists(worktree)).toBe(true)
    // Pass 5 — cooldown elapsed since the escalation, STILL silent → RECLAIM: the
    // REAL worktree is force-removed.
    await runDispatchPass(engine, deps, t0 + STALL_SILENCE_MS + 3 * STALL_NUDGE_COOLDOWN_MS + 4)
    expect(await exists(worktree)).toBe(false) // ← zombie worktree GONE from disk
    expect(col('a')).toBe('todo') // ← requeued for one retry, not stranded in doing
    expect(engine.workers).toHaveLength(0) // slot freed
    expect(engine.log.some((l) => l.message.startsWith('worker stalled — reclaimed — card → todo'))).toBe(true)
  })
})

// ── RESURRECTION reflex — REAL heartbeat end-to-end (card B, 受け入れの肝) ─────────
// The owner's complaint: the commander (opus) STOPS under a big diff (context
// overflow / API error / hang) and nobody notices, so integration stalls. Card B's
// answer: the commander beats a heartbeat while it works; the engine watches it and
// re-wakes a desk that goes silent, giving up (fatal escalation) only after it keeps
// dying. This test fixes that reflex against REAL files — the manager heartbeat is
// written/read through the actual seam in the isolated tmp HOME, and the detection is
// the REAL freshness rule. spawnSwarmManager is the wakeManager seam (mocked): an
// integration test must NEVER launch a real claude.
//
// 受け入れの肝: HOME-isolated, STOP the manager heartbeat → the engine DETECTS it →
// spawnSwarmManager(mock) is called → after MAX consecutive failures it fires ONE
// 'manager-unrevivable' fatal notification (完了条件2+3+5).
describe('runIntegratePass — RESURRECTION reflex, REAL manager heartbeat (受け入れの肝, 完了条件2-5)', () => {
  it('心拍を止める → 検知 → spawnSwarmManager(モック)を呼ぶ → 3連続失敗で fatal 通知', async () => {
    const { proj } = await setupRepo()

    // A REAL persisted commander session — without it the presence probe short-circuits
    // to 'absent' on the store alone and the PTY signal would never be consulted.
    await recordSwarmSession(proj, 'manager', 'manager-session-uuid')

    // The commander's heartbeat is a REAL file under the isolated HOME
    // (~/.openground/swarm/<repoKey>/manager.json). It beat ONCE, then STOPPED.
    const t0 = 1_700_000_000_000
    expect(await writeManagerHeartbeat(proj, { phase: 'integrate' }, t0)).toBe(true)

    // "心拍を止める → 検知", nothing faked: fresh right after the beat, HUNG once `now`
    // crosses the stale window — the real read-back + the real freshness rule.
    expect(isManagerHeartbeatFresh(await readManagerHeartbeatAt(proj), t0 + 5 * 60_000)).toBe(true)
    expect(
      isManagerHeartbeatFresh(await readManagerHeartbeatAt(proj), t0 + MANAGER_HEARTBEAT_STALE_MS + 1),
    ).toBe(false)

    // spawnSwarmManager is the wakeManager seam — count it, NEVER launch claude. The
    // resurrected desk never comes up (the PTY stays gone), so every grace-spaced pass
    // re-detects an absent desk and re-wakes, until the reflex gives up.
    let spawnCalls = 0
    // The commander PROCESS's existence, driven through the test (the PTY pool is
    // process-global, so an integration test injects this one probe rather than
    // spawning a real claude). Everything else — sessions store, manager.json,
    // transcript — is read for real off the isolated HOME.
    let deskLive = true
    let deskPaintAt: number | null = null
    const fatals: SwarmFatalNotification[] = []
    const { boardDeps } = makeBoard([todoCard('a', { boardColumn: 'review', branch: 'swarm/a' })])
    const deps: OrchestratorDeps & IntegrationDeps = {
      ...defaultDeps(),
      ...boardDeps,
      // Part A readiness runs on the real repo; swarm/a isn't a real ref, so pin the
      // seams the resurrection reflex doesn't exercise.
      prepareTarget: async () => 'main',
      classify: async () => 'ff',
      // REAL presence detection, REAL files: defaultManagerPresence reads the actual
      // sessions store + manager.json under the isolated HOME. Only the PTY probe is
      // injected — `deskLive` models the commander PROCESS existing or not, which is
      // what this test drives (present-and-beating → died → resurrected).
      managerPresence: async (p, now) =>
        defaultManagerPresence(p, now, {
          activity: () => ({
            live: deskLive,
            lastOutputAt: deskPaintAt,
            terminalId: deskLive ? 'pty-manager' : null,
          }),
        }),
      // A desk that is GONE must be spawned, never nudged (nothing to nudge) — throw so
      // a regression that routes 'absent' through the nudge path is loud, not silent.
      nudgeManager: async () => {
        throw new Error('nudgeManager must not be called when the desk is absent')
      },
      // The spawnSwarmManager boundary (mock).
      wakeManager: async () => {
        spawnCalls += 1
        return true
      },
      notify: (n) => fatals.push(n),
    }
    const engine = newEngine(proj)
    // Drive a pass at wall-clock `now`, bypassing the 15s TICK throttle (its own tests
    // cover cadence) so ONLY the resurrection grace window governs re-wakes.
    const pass = async (now: number): Promise<void> => {
      engine.lastIntegrateAt = 0
      await runIntegratePass(engine, deps, now)
    }

    // 1) Desk up and STILL beating (5 min old) → healthy → NO resurrection.
    await pass(t0 + 5 * 60_000)
    expect(spawnCalls).toBe(0)

    // 2) The commander PROCESS dies (PTY gone) and the heartbeat goes stale with it →
    //    'absent' → resurrect, up to MAX, one wake per grace window.
    const STALE = MANAGER_HEARTBEAT_STALE_MS
    const GRACE = MANAGER_RESUME_GRACE_MS
    deskLive = false
    let now = t0 + STALE + 60_000
    for (let i = 0; i < MAX_MANAGER_RESUME_ATTEMPTS; i++) {
      await pass(now)
      now += GRACE + 1000
    }
    expect(spawnCalls).toBe(MAX_MANAGER_RESUME_ATTEMPTS) // spawnSwarmManager(mock) called 3×
    expect(fatals).toHaveLength(0) // not given up yet

    // 3) Still silent after MAX attempts → GIVE UP: fatal escalation, NO 4th spawn.
    await pass(now)
    expect(spawnCalls).toBe(MAX_MANAGER_RESUME_ATTEMPTS) // the token-burn loop is broken
    expect(fatals.map((n) => n.event)).toEqual(['manager-unrevivable'])
    expect(fatals[0].projectPath).toBe(proj)

    // 4) The commander RECOVERS — a desk comes back up and beats again → detection
    //    clears → self-heals, and the one-shot fatal is not re-fired.
    now += GRACE + 1000
    deskLive = true
    expect(await writeManagerHeartbeat(proj, { phase: 'integrate' }, now)).toBe(true)
    await pass(now)
    expect(spawnCalls).toBe(MAX_MANAGER_RESUME_ATTEMPTS) // no wake — the desk is alive again
    expect(fatals).toHaveLength(1) // still one-shot
    expect(engine.managerResume?.attempts).toBe(0) // reflex disarmed by the sighting of health

    // 5) THE 2026-07-18 REGRESSION, against real files: the desk is UP but has gone
    //    quiet — the beat is now hours stale (the commander only beats while integrating)
    //    and the PTY has not painted. The old probe ANDed live-PTY with beat freshness,
    //    so this exact state was read as HUNG and "resuscitated" three times before
    //    firing a FALSE fatal. It must now read 'idle': the desk is alive, so nothing is
    //    spawned and nothing escalates.
    now += 6 * 60 * 60_000 // hours later — far past any staleness window
    deskPaintAt = null
    expect(
      await defaultManagerPresence(proj, now, {
        activity: () => ({ live: true, lastOutputAt: null, terminalId: 'pty-manager' }),
      }),
    ).toBe('idle')
    // …and one paint is enough to make it unambiguously 'active' again.
    expect(
      await defaultManagerPresence(proj, now, {
        activity: () => ({ live: true, lastOutputAt: now - 30_000, terminalId: 'pty-manager' }),
      }),
    ).toBe('active')
  })
})

// ── The echo discount ITSELF, against real files (2026-07-18) ──────────────────
// These exist because the unit tests around echoUntil could not fail: every one of them
// injects a managerPresence fake and re-implements the discount on the test side, so they
// pin only that the CALLER passes a cutoff — never that defaultManagerPresence honours it.
// Deleting the discount (`realPaint = painted`) left all 507 of them green. The rule has
// to be asserted where it actually lives.
describe('defaultManagerPresence — the echo discount (echoUntil) is honoured', () => {
  it('ignores paint inside the echo window, and still counts paint past it', async () => {
    const { proj } = await setupRepo()
    await recordSwarmSession(proj, 'manager', 'manager-session-uuid')
    // A beat that EXISTS but went stale — the production shape (the commander beats only
    // while integrating), so the verdict has to come from the PTY/transcript channels.
    const t0 = 1_700_000_000_000
    expect(await writeManagerHeartbeat(proj, { phase: 'integrate' }, t0)).toBe(true)
    const now = t0 + 6 * 60 * 60_000 // hours later — far past any staleness window
    const wroteAt = now - 60_000 // when WE last wrote into that PTY (nudge or spawn)
    const echoUntil = wroteAt + STALL_ECHO_GUARD_MS

    // (a) The desk's only paint is our own write bouncing back off the TUI. Recent, but
    //     not life — discounting it is the whole point, and it is what lets the nudge
    //     budget empty (§7-10) and the resurrection guard fire (§7-12).
    expect(
      await defaultManagerPresence(proj, now, {
        activity: () => ({ live: true, lastOutputAt: wroteAt, terminalId: 'pty-manager' }),
        echoUntil,
      }),
    ).toBe('idle')

    // (b) Paint that lands PAST the guard is real work and must still count — otherwise
    //     the discount would gag a desk that genuinely answered.
    expect(
      await defaultManagerPresence(proj, now, {
        activity: () => ({ live: true, lastOutputAt: echoUntil + 1, terminalId: 'pty-manager' }),
        echoUntil,
      }),
    ).toBe('active')

    // (c) With nothing of ours to discount, that same early paint counts as it always did.
    expect(
      await defaultManagerPresence(proj, now, {
        activity: () => ({ live: true, lastOutputAt: wroteAt, terminalId: 'pty-manager' }),
        echoUntil: 0,
      }),
    ).toBe('active')
  })
})

// ── DELIVERY evidence: what the stall check judges a painting desk against ─────
//    (2026-07-22 差し戻し). The first cut used the HEARTBEAT ALONE, which is wrong
//    about how the commander works: /og-manage beats once at the head of a branch and
//    then runs tsc + npm test + adversarial reviewers INSIDE that one turn, unable to
//    curl a beat for tens of minutes. Judging it on the beat would ESC-interrupt the
//    reviewers it is running. Real files here, because the whole point is which files
//    claude actually writes while working.
describe('defaultManagerDeliveryAt — sub-agent transcripts count as work (the 差し戻し)', () => {
  // homedir() is where claude's transcript tree lives, and OPENGROUND_HOME cannot move
  // it — so pin $HOME (POSIX os.homedir() honours it) rather than writing into the
  // developer's real ~/.claude.
  let savedHome: string | undefined
  let fakeHome: string
  beforeEach(async () => {
    savedHome = process.env.HOME
    fakeHome = await realpath(await mkdtemp(join(tmpdir(), 'og-claude-home-')))
    process.env.HOME = fakeHome
  })
  afterEach(async () => {
    // Restore the captured $HOME — never `delete process.env.HOME`: unsetting it
    // aims every later write in this worker at the user's REAL home (the
    // 2026-07-18 data-loss vector the testHomeEnvGuard forbids). Under vitest
    // $HOME is always set, so savedHome is always a string; the guard is fine
    // with a plain restore.
    if (savedHome !== undefined) process.env.HOME = savedHome
    await rm(fakeHome, { recursive: true, force: true })
  })

  const SID = 'manager-session-uuid'
  const touch = async (file: string, at: number) => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '{}\n')
    await utimes(file, new Date(at), new Date(at))
  }

  it('returns the NEWEST of heartbeat / session transcript / sub-agent transcripts', async () => {
    const { proj } = await setupRepo()
    await recordSwarmSession(proj, 'manager', SID)
    const t = Date.parse('2026-07-22T10:31:00Z')
    // The exact shape of a commander mid-branch: it beat at the head 45 minutes ago, its
    // own transcript froze when it launched the reviewers 40 minutes ago, and only the
    // sub-agent files have moved since (measured: they are appended incrementally).
    await writeManagerHeartbeat(proj, { phase: 'merge' }, t - 45 * 60_000)
    await touch(sessionJsonlPath(proj, SID), t - 40 * 60_000)
    await touch(join(sessionSubagentsDir(proj, SID), 'agent-abc123.jsonl'), t - 60_000)
    const at = await defaultManagerDeliveryAt(proj, {
      activity: () => ({ live: true, lastOutputAt: t, terminalId: 'pty-manager' }),
    })
    expect(at).not.toBeNull()
    // The reviewer's file is the newest → the desk is WORKING, and by a wide margin the
    // stall window would otherwise have declared it stopped.
    expect(Math.abs(at! - (t - 60_000))).toBeLessThan(1500)
    // …and PAINT is not in the mix at all: `lastOutputAt: t` is newer than everything
    // above, and the answer must still be the sub-agent's mtime. Paint reading as
    // delivery is the exact bug this whole card exists to remove.
    expect(at!).toBeLessThan(t)
  })

  it('falls back to the heartbeat when no transcript exists, and is null when nothing does', async () => {
    const { proj } = await setupRepo()
    await recordSwarmSession(proj, 'manager', SID)
    const t = Date.parse('2026-07-22T10:31:00Z')
    // Nothing written anywhere ⇒ no evidence ⇒ null (the fail-open: never "stalled").
    expect(
      await defaultManagerDeliveryAt(proj, {
        activity: () => ({ live: true, lastOutputAt: t, terminalId: 'pty-manager' }),
      }),
    ).toBeNull()
    // A beat alone still answers — the channel is not dropped, only joined by the others.
    await writeManagerHeartbeat(proj, { phase: 'merge' }, t)
    const at = await defaultManagerDeliveryAt(proj, {
      activity: () => ({ live: true, lastOutputAt: t, terminalId: 'pty-manager' }),
    })
    expect(Math.abs(at! - t)).toBeLessThan(1500)
  })

  it('a desk that SPOKE AND STOPPED freezes every channel at once — the incident, detected', async () => {
    const { proj } = await setupRepo()
    await recordSwarmSession(proj, 'manager', SID)
    // 10:31 統合完了: beat, transcript and (finished) reviewer files all stamp 10:31 and
    // then nothing moves, while the TUI keeps the desk looking 'active'. 11:11 is where
    // the 40-minute window puts the poke — versus 11:51 when the owner did it by hand.
    const spokeAt = Date.parse('2026-07-22T10:31:00Z')
    await writeManagerHeartbeat(proj, { phase: 'merge' }, spokeAt)
    await touch(sessionJsonlPath(proj, SID), spokeAt)
    await touch(join(sessionSubagentsDir(proj, SID), 'agent-abc123.jsonl'), spokeAt)
    const at = await defaultManagerDeliveryAt(proj, {
      activity: () => ({ live: true, lastOutputAt: Date.parse('2026-07-22T11:11:00Z'), terminalId: 'p' }),
    })
    expect(Math.abs(at! - spokeAt)).toBeLessThan(1500)
    expect(
      managerIntegrationStalled({
        waitingSinceMs: Date.parse('2026-07-22T10:37:00Z'), // the first promotion
        deliveryAtMs: at,
        now: Date.parse('2026-07-22T11:17:00Z'), // 40 min after the cards landed
      }),
    ).toBe(true)
  })
})

// ── The FOURTH liveness channel: a background task in flight (2026-07-27) ──────
//    Real transcript records, because the ONLY thing this resolver knows is which
//    records claude actually writes — the shapes below are transcribed from the two
//    workers the engine killed on 2026-07-27 (gap-7 / gap-4), not invented. If claude
//    ever renames `run_in_background` or the `<tool-use-id>` notification block, THIS
//    is the test that must fail, loudly, instead of the channel silently going dark and
//    the reclaim ladder quietly resuming.
describe('sessionBackgroundTaskAt — the in-flight completion gate, read from the transcript', () => {
  let savedHome: string | undefined
  let fakeHome: string
  beforeEach(async () => {
    savedHome = process.env.HOME
    fakeHome = await realpath(await mkdtemp(join(tmpdir(), 'og-claude-home-')))
    process.env.HOME = fakeHome
  })
  afterEach(async () => {
    // Never `delete process.env.HOME` — see the note in the delivery block above.
    if (savedHome !== undefined) process.env.HOME = savedHome
    await rm(fakeHome, { recursive: true, force: true })
  })

  const SID = 'worker-session-uuid'
  const CWD = '/tmp/og-worker-worktree'
  const START = Date.parse('2026-07-27T10:00:52.003Z') // gap-7's real launch stamp
  const TOOL_ID = 'toolu_012rtVNy8uKsWUfPSjKYwgD5' // …and its real tool_use id

  /** An `assistant` record launching a background Bash — the START marker. */
  const bgStart = (id: string, atIso: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: atIso,
      sessionId: SID,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running the full suite; I will report when it finishes.' },
          { type: 'tool_use', id, name: 'Bash', input: { command: 'npm test > /tmp/out 2>&1', run_in_background: true } },
        ],
      },
    })

  /** A `queue-operation` carrying the task notification — the END marker. `status` is
   *  cosmetic here on purpose: completed / failed / killed all mean NOT PENDING. */
  const bgEnd = (id: string, atIso: string, status = 'completed') =>
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: atIso,
      sessionId: SID,
      content: `<task-notification>\n<task-id>b65agguu1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
    })

  /** Ordinary traffic the scan must ignore (and must not choke on). */
  const noise = [
    JSON.stringify({ type: 'user', timestamp: '2026-07-27T10:00:34.735Z', message: { role: 'user', content: 'go' } }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: '2026-07-27T10:00:58.132Z', durationMs: 1000 }),
    JSON.stringify({ type: 'last-prompt', sessionId: SID, lastPrompt: 'go' }), // no timestamp at all
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-27T09:59:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'git status' } }] },
    }), // FOREGROUND Bash — no run_in_background ⇒ not a background task
  ]

  const writeTranscript = async (lines: string[]) => {
    const file = sessionJsonlPath(CWD, SID)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, lines.join('\n') + '\n')
  }

  it('returns the START stamp of a task with no completion notification (the killed workers exactly)', async () => {
    // gap-7's transcript as the engine saw it at 10:16: the launch is on disk, the
    // notification is NOT — because the suite was still running. The engine had every
    // byte it needed to know the worker was alive; it just never looked.
    await writeTranscript([...noise, bgStart(TOOL_ID, '2026-07-27T10:00:52.003Z')])
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(START)
  })

  it('returns null once the notification names that tool-use id (completed, failed OR killed)', async () => {
    for (const status of ['completed', 'failed', 'killed']) {
      await writeTranscript([...noise, bgStart(TOOL_ID, '2026-07-27T10:00:52.003Z'), bgEnd(TOOL_ID, '2026-07-27T10:20:33.084Z', status)])
      expect(await sessionBackgroundTaskAt(CWD, SID)).toBeNull()
    }
  })

  it('returns the NEWEST unresolved task, so one that never reports back cannot SHADOW a fresh one', async () => {
    // The hole this pins: a worker leaves a long-lived background task unresolved (a dev
    // server, a `tail -f`, anything whose notification was lost) and then runs its
    // completion gate. Answering with the OLDEST would report a task that started hours
    // ago, blow the grace, and reclaim the worker MID-TEST — the exact bug, reopened.
    const fresh = Date.parse('2026-07-27T10:00:52.003Z')
    await writeTranscript([
      bgStart('toolu_devserver', '2026-07-27T06:00:00.000Z'), // never acknowledged
      bgStart('toolu_npmtest', '2026-07-27T10:00:52.003Z'), // the completion gate, running
    ])
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(fresh)
  })

  it('a resolved fresh task does NOT hide an older one that is still in flight', async () => {
    // The converse: newest-unresolved means RESOLVED tasks are skipped entirely, so the
    // still-running older one is what answers — the worker is genuinely still busy.
    const older = Date.parse('2026-07-27T09:30:00.000Z')
    await writeTranscript([
      bgStart('toolu_older', '2026-07-27T09:30:00.000Z'),
      bgStart('toolu_newer', '2026-07-27T10:00:52.003Z'),
      bgEnd('toolu_newer', '2026-07-27T10:05:00.000Z'),
    ])
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(older)
  })

  it('ignores foreground tools and non-task traffic (no false life)', async () => {
    await writeTranscript(noise)
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBeNull()
  })

  // ── START B: the harness backgrounds a foreground Bash on timeout ───────────────
  // The shape the FIRST cut of this channel could not see, and the reason it still let
  // workers die: the `tool_use` record has NO `run_in_background` key — nothing about it
  // says "background". Only the tool_result announcing the move does. Transcribed from
  // gap-4's own record (toolu_016eNGirNrZE6cYbt7vX382s: foreground 08:50:49, auto-moved
  // 09:00:56, finished 09:20:52 — a 20-minute `npm test` the first parser was blind to).
  const AUTO_ID = 'toolu_016eNGirNrZE6cYbt7vX382s'
  const AUTO_MOVED_AT = Date.parse('2026-07-27T09:00:56.695Z')

  /** The FOREGROUND launch — note `input` has no `run_in_background` at all. */
  const fgStart = (id: string, atIso: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: atIso,
      sessionId: SID,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test 2>&1 | tail -20', description: 'Full suite', timeout: 600000 } }],
      },
    })

  /** The tool_result that announces the auto-move — the ONLY evidence this is now a
   *  background task. Verbatim wording from the real transcript. */
  const autoMoved = (id: string, atIso: string) =>
    JSON.stringify({
      type: 'user',
      timestamp: atIso,
      sessionId: SID,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: `Command did not complete within its 600s timeout and was moved to the background (ID: b919f2uwt). Output is being written to: /tmp/out`,
          },
        ],
      },
    })

  it('detects an AUTO-BACKGROUNDED task — the tool_use has no run_in_background at all', async () => {
    await writeTranscript([...noise, fgStart(AUTO_ID, '2026-07-27T08:50:49.782Z'), autoMoved(AUTO_ID, '2026-07-27T09:00:56.695Z')])
    // Stamped when it BECAME a background task, not when the foreground command began:
    // until the move, the foreground Bash was holding the turn open.
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(AUTO_MOVED_AT)
  })

  it('an auto-backgrounded task is resolved by the SAME notification shape (no END change needed)', async () => {
    // It keeps its original tool_use id, so the `<tool-use-id>` match works unchanged —
    // this is what made the fix a start-side-only change.
    await writeTranscript([
      ...noise,
      fgStart(AUTO_ID, '2026-07-27T08:50:49.782Z'),
      autoMoved(AUTO_ID, '2026-07-27T09:00:56.695Z'),
      bgEnd(AUTO_ID, '2026-07-27T09:20:52.923Z'),
    ])
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBeNull()
  })

  it('does NOT mistake a tool_result that merely QUOTES the phrase for a real auto-move', async () => {
    // A tool_result is also what `Read` returns, so "was moved to the background" appearing
    // in a result is prose, not evidence. A phantom start never resolves — it would hand a
    // genuinely stuck worker the entire grace. The survey found three such results already
    // on disk (transcript dumps, and the investigation for this very fix), and the doc that
    // explains this channel quotes the phrase too. Hence the anchored sentence match.
    const quoting = (text: string) =>
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-27T09:00:56.695Z',
        sessionId: SID,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: text }] },
      })
    for (const text of [
      '=== rec 226 (the tool_use with NO run_in_background) ===\nwas moved to the background', // a real impostor, verbatim
      '   1\t// the CLI says it was moved to the background when it times out', // a Read of source
      'Some log line. Command did not complete within its 600s timeout and was moved to the background (ID: b1).', // not at the start
    ]) {
      await writeTranscript([...noise, quoting(text)])
      expect(await sessionBackgroundTaskAt(CWD, SID)).toBeNull()
    }
    // …while the genuine announcement — the whole result text, from its first character —
    // is still recognised. (Timeout values seen on disk: 120/180/300/420/600s.)
    await writeTranscript([...noise, fgStart(AUTO_ID, '2026-07-27T08:50:49.782Z'), autoMoved(AUTO_ID, '2026-07-27T09:00:56.695Z')])
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(AUTO_MOVED_AT)
  })

  it('a foreground Bash that never times out is NOT a background task (no false life)', async () => {
    // The mutation control for the above: same launch record, no auto-move announcement.
    await writeTranscript([...noise, fgStart(AUTO_ID, '2026-07-27T08:50:49.782Z')])
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBeNull()
  })

  it('re-reads only when (size, mtime) change — the memo the 3s tick depends on', async () => {
    // The stall gate keeps this resolver being called EVERY 3s tick for the whole grace,
    // against a worker that is (by definition of the case) appending nothing — so without
    // a memo it re-parses the same multi-MB file ~900 times per worker. This pins both
    // halves: that the memo exists, and exactly what invalidates it.
    const file = sessionJsonlPath(CWD, SID)
    const LATER = Date.parse('2026-07-27T11:00:52.003Z')
    // Two versions with IDENTICAL byte length (only the hour digit differs), so `size`
    // cannot distinguish them and `mtime` is the whole test. Both mtimes are STAMPED
    // explicitly rather than restored — a filesystem's sub-millisecond mtime cannot be
    // round-tripped through a Date, so "set both to the same value" is the only way to
    // make byte-identical staleness reproducible.
    const pinned = new Date('2026-07-27T12:00:00.000Z')
    const bumped = new Date('2026-07-27T12:00:02.000Z')
    await writeTranscript([...noise, bgStart(TOOL_ID, '2026-07-27T10:00:52.003Z')])
    await utimes(file, pinned, pinned)
    const sizeA = (await stat(file)).size
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(START)

    await writeTranscript([...noise, bgStart(TOOL_ID, '2026-07-27T11:00:52.003Z')])
    await utimes(file, pinned, pinned) // same size AND same mtime ⇒ indistinguishable
    expect((await stat(file)).size).toBe(sizeA)
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(START) // MEMO HIT (stale by construction)

    await utimes(file, pinned, bumped) // what a real append would do
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(LATER) // invalidated → re-parsed
  })

  it('an ordinary append (the completion notification landing) invalidates the memo', async () => {
    await writeTranscript([...noise, bgStart(TOOL_ID, '2026-07-27T10:00:52.003Z')])
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(START)
    await writeTranscript([...noise, bgStart(TOOL_ID, '2026-07-27T10:00:52.003Z'), bgEnd(TOOL_ID, '2026-07-27T10:20:33.084Z')])
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBeNull() // the real-world transition
  })

  it('a vanished transcript drops the memoised answer (a torn-down worker is not remembered alive)', async () => {
    await writeTranscript([...noise, bgStart(TOOL_ID, '2026-07-27T10:00:52.003Z')])
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(START)
    await rm(sessionJsonlPath(CWD, SID))
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBeNull()
  })

  it('never throws: a missing transcript, or a half-written trailing line, yields no signal', async () => {
    // Missing file — a worker whose session has not written yet.
    expect(await sessionBackgroundTaskAt(CWD, 'no-such-session')).toBeNull()
    // A torn last line (claude appending as we read) must not lose the records before it.
    await writeTranscript([...noise, bgStart(TOOL_ID, '2026-07-27T10:00:52.003Z')])
    const file = sessionJsonlPath(CWD, SID)
    await writeFile(file, (await readFile(file, 'utf8')) + '{"type":"queue-operation","content":"<task-noti')
    expect(await sessionBackgroundTaskAt(CWD, SID)).toBe(START)
  })
})

// ── A repo that has NEVER integrated still gets a usable presence verdict ──────
describe('defaultManagerPresence — a never-written heartbeat is not evidence of health', () => {
  it('reads a live-but-silent desk as idle even with NO manager.json (so it can be nudged)', async () => {
    const { proj } = await setupRepo()
    await recordSwarmSession(proj, 'manager', 'manager-session-uuid')
    // No writeManagerHeartbeat at all — the state of every repo before its first
    // integration. isManagerHeartbeatFresh(null) is deliberately "fresh" (the old probe
    // must not tear down a hand-started desk), and honouring that here would return
    // 'active' on the beat alone, so the PTY/transcript channels would never be reached
    // and such a desk could NEVER be poked. Dropping the fail-open is safe now that
    // 'idle' only pokes.
    const now = 1_700_000_000_000
    expect(
      await defaultManagerPresence(proj, now, {
        activity: () => ({ live: true, lastOutputAt: null, terminalId: 'pty-manager' }),
      }),
    ).toBe('idle')
    // A desk with no beat but REAL recent paint is still unambiguously working.
    expect(
      await defaultManagerPresence(proj, now, {
        activity: () => ({ live: true, lastOutputAt: now - 30_000, terminalId: 'pty-manager' }),
      }),
    ).toBe('active')
    // …and with no PTY at all it is still 'absent' (the spawn path is unchanged).
    expect(
      await defaultManagerPresence(proj, now, {
        activity: () => ({ live: false, lastOutputAt: null, terminalId: null }),
      }),
    ).toBe('absent')
  })
})

// ── The poke itself: ESC first, then the instruction (2026-07-18) ──────────────
// A bare line+CR would append to whatever is already sitting in the desk's input box
// and submit the concatenation — and the commander desk runs with
// `--dangerously-skip-permissions`, so there is no approval gate to catch the mess. The
// "a desk being typed into paints, so it reads 'active'" argument only covers typing
// happening RIGHT NOW; a prompt typed and then LEFT ages out and reads 'idle'. So the
// poke uses the full defaultEscalate shape (ESC → settle → instruction), not just its
// tail. Exercised against the REAL sessions store under the isolated HOME.
describe('defaultNudgeManager — the live-desk poke clears pending input first', () => {
  it('writes ESC, waits STALL_ESCALATE_DELAY_MS, then the instruction + CR', async () => {
    const { proj } = await setupRepo()
    await recordSwarmSession(proj, 'manager', 'manager-session-uuid')
    const writes: string[] = []
    const waits: number[] = []
    const ok = await defaultNudgeManager(proj, {
      write: (id, data) => {
        writes.push(`${id}:${data}`)
        return true
      },
      sleep: async (ms) => {
        waits.push(ms)
      },
      activity: () => ({ live: true, lastOutputAt: null, terminalId: 'pty-manager' }),
    })
    expect(ok).toBe(true)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toBe('pty-manager:\x1b') // the interrupt — BEFORE any text
    expect(writes[1]).toMatch(/\r$/) // the instruction, CR-terminated
    expect(writes[1]).toContain('統合待ちのカードがあります')
    expect(waits).toEqual([STALL_ESCALATE_DELAY_MS])
  })

  it('returns false without waiting or typing when the ESC write misses (PTY gone)', async () => {
    const { proj } = await setupRepo()
    await recordSwarmSession(proj, 'manager', 'manager-session-uuid')
    let slept = false
    const writes: string[] = []
    const ok = await defaultNudgeManager(proj, {
      write: (_id, data) => {
        writes.push(data)
        return false
      },
      sleep: async () => {
        slept = true
      },
      activity: () => ({ live: true, lastOutputAt: null, terminalId: 'pty-manager' }),
    })
    expect(ok).toBe(false)
    expect(writes).toEqual(['\x1b']) // never got as far as the instruction
    expect(slept).toBe(false)
  })
})

// ── Commander-presence display read (検品可視化, card 2026-07-17) ───────────────
// The Swarm tab explains the post-worker quiet minutes ("the commander is
// inspecting") off the SAME manager.json the resurrection reflex reads — but via
// its OWN display snapshot: full record (phase/note/updatedAt) + a server-clock
// freshness verdict, whole-or-null on anything unreadable (the reflex's null=fresh
// fail-open must NOT leak into rendering, where absent = standby). Exercised
// against the REAL file under the isolated HOME + the real repo key.
describe('readManagerHeartbeatInfo — the presence snapshot the Swarm tab renders', () => {
  it('reads the REAL beat back whole — phase/note pass through, freshness on the server clock', async () => {
    const { proj } = await setupRepo()
    const t0 = 1_700_000_000_000
    expect(await writeManagerHeartbeat(proj, { phase: 'merge', note: '検品中 — swarm/x' }, t0)).toBe(true)

    // Inside the 10-min window → fresh (active), age measured from the injected clock.
    const fresh = await readManagerHeartbeatInfo(proj, t0 + 3 * 60_000)
    expect(fresh).toEqual({
      phase: 'merge',
      note: '検品中 — swarm/x',
      updatedAt: new Date(t0).toISOString(),
      ageMs: 3 * 60_000,
      fresh: true,
    })

    // Past the stale window → the SAME record, no longer fresh (standby wording).
    const stale = await readManagerHeartbeatInfo(proj, t0 + MANAGER_HEARTBEAT_STALE_MS + 1)
    expect(stale?.fresh).toBe(false)
    expect(stale?.note).toBe('検品中 — swarm/x')

    // A skewed FUTURE stamp clamps to "just now" — never a negative age.
    const skewed = await readManagerHeartbeatInfo(proj, t0 - 60_000)
    expect(skewed?.ageMs).toBe(0)
    expect(skewed?.fresh).toBe(true)
  })

  it('degrades to null on absent / corrupt / non-repo — nothing to show, never a throw (完了条件4)', async () => {
    const { proj } = await setupRepo()
    // Never beat → null (display "standby"), NOT the reflex's null=fresh fail-open.
    expect(await readManagerHeartbeatInfo(proj)).toBeNull()
    // Hand-corrupted file → null (fail-safe).
    expect(await writeManagerHeartbeat(proj, { phase: 'merge' })).toBe(true)
    const file = join(home, 'swarm')
    const { readdirSync } = await import('fs')
    const repoDir = readdirSync(file)[0]
    await writeFile(join(file, repoDir, 'manager.json'), '{ torn')
    expect(await readManagerHeartbeatInfo(proj)).toBeNull()
    // A path that is not a git repo (no repo key derivable) → null.
    expect(await readManagerHeartbeatInfo(join(scratch, 'not-a-repo'))).toBeNull()
  })

  it('getOrchestratorState CARRIES the presence — even with NO engine this session (restart reality)', async () => {
    const { proj } = await setupRepo()
    const t0 = Date.now()
    expect(await writeManagerHeartbeat(proj, { phase: 'status', note: '統合完了・待機' }, t0)).toBe(true)

    // No engine was ever started for this project (exactly the post-restart state):
    // the empty stopped state still carries the commander heartbeat, because a
    // human-opened desk beats without an engine and the presence line must show it.
    const state = await getOrchestratorState(proj)
    expect(state.running).toBe(false)
    expect(state.manager?.phase).toBe('status')
    expect(state.manager?.note).toBe('統合完了・待機')
    expect(state.manager?.fresh).toBe(true) // just written — well inside the window

    // And a project with NO heartbeat reads back null (absent, not an error).
    const { proj: bare } = await setupRepoMaster()
    expect((await getOrchestratorState(bare)).manager).toBeNull()
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
    // swarm code (the goal's enumerated globs) → true
    expect(touchesSwarmPaths(['src/lib/server/swarmOrchestrator.ts'])).toBe(true)
    expect(touchesSwarmPaths(['src/lib/server/swarmIntegrate.ts'])).toBe(true)
    expect(touchesSwarmPaths(['src/lib/server/swarmSafety.test.ts'])).toBe(true) // the net itself
    expect(touchesSwarmPaths(['server/routes/swarm.ts'])).toBe(true)
    expect(touchesSwarmPaths(['server/routes/project.ts'])).toBe(true) // Board API — the swarm contract surface (docs/commander/05)
    expect(touchesSwarmPaths(['server/routes/__tests__/swarmSafety.routes.test.ts'])).toBe(true) // the route net
    expect(touchesSwarmPaths(['src/components/canvas/modules/SwarmModule.tsx'])).toBe(true)
    expect(touchesSwarmPaths(['src/components/canvas/modules/SwarmSupplyPane.tsx'])).toBe(true)
    // server/index.ts (2026-07-22, card 2) — the one place resumeEngines() is
    // wired in (the process.send gate + the boot-time call), outside every
    // other glob above; without this entry a diff dropping that wiring would
    // touch NO swarm path and never trip the safety gate.
    expect(touchesSwarmPaths(['server/index.ts'])).toBe(true)
    // one swarm file among many unrelated ones → still true
    expect(touchesSwarmPaths(['README.md', 'src/lib/server/swarmWorker.ts'])).toBe(true)
    // unrelated → false (condition 3: these branches must not be slowed)
    expect(touchesSwarmPaths([])).toBe(false)
    expect(touchesSwarmPaths(['README.md', 'src/App.tsx'])).toBe(false)
    expect(touchesSwarmPaths(['src/lib/server/projectData.ts'])).toBe(false) // not swarm*
    expect(touchesSwarmPaths(['src/components/canvas/modules/BoardModule.tsx'])).toBe(false)
    // look-alikes the TIGHT anchors must REJECT (no over-broad matching)
    expect(touchesSwarmPaths(['src/lib/server/sub/swarmX.ts'])).toBe(false) // not directly under the dir
    expect(touchesSwarmPaths(['docs/swarm.ts'])).toBe(false) // wrong dir
    expect(touchesSwarmPaths(['server/routes/swarmObsolete.ts'])).toBe(false) // only swarm.ts exact
    expect(touchesSwarmPaths(['server/routes/projectMeta.ts'])).toBe(false) // only project.ts exact
  })
})

describe('swarmSafetyCheck — the real swarm-safety suite runner', () => {
  it('applicable: true only when EVERY safety test file is present', async () => {
    const empty = await realpath(await mkdtemp(join(scratch, 'ss-empty-')))
    expect(await swarmSafetyCheck.applicable(empty)).toBe(false) // no files → not OPEN GROUND's source
    // every file present (empty stubs) → applicable
    const has = await realpath(await mkdtemp(join(scratch, 'ss-has-')))
    for (const t of SWARM_SAFETY_TESTS) {
      await mkdir(dirname(join(has, t)), { recursive: true })
      await writeFile(join(has, t), '')
    }
    expect(await swarmSafetyCheck.applicable(has)).toBe(true)
    // only ONE of them present → NOT applicable (an incomplete net is not the net)
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
    await writeFile(join(dir, SWARM_SAFETY_TESTS[0]), '') // only ONE of them present
    const r = await swarmSafetyCheck.run(dir)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/safety test missing/)
  })

  it('run: RED when vitest is unavailable (uninstalled project) — never waved through', async () => {
    // Net intact (every file present) but no node_modules/.bin/vitest → still RED.
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

  // The reviewer arm of the quota sensor (2026-07-09). The monitor only watches
  // WORKER screens, so before this a panel that walked into the wall first cooled
  // nothing: three abstentions → "多数決つかず [must-fix 0 / clean 0]" → the defer
  // streak burned to needs-human → the next panel spawned on the same dry tier.
  describe('a reviewer that hits the model limit', () => {
    // Verbatim CLI notice — the same fixture the classifier pins.
    const LIMITED =
      "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
    beforeEach(() => __resetQuotaForTest())
    afterEach(() => __resetQuotaForTest())

    it('cools the panel tier and defers as an ENGINE park (not a review failure)', async () => {
      const { proj } = await setupRepo()
      const spawn = makeSpawn(proj, new Set(), { file: () => 'worker.txt', content: 'ok\n', scratch: false })
      const res = await spawn({ projectPath: proj, title: 'card q', hint: 'q' })
      await git(proj, ['fetch', 'origin', 'main'])
      const tip = await tipOf(proj, res.branch)
      expect(isTierCooling('fable', Date.now())).toBe(false)

      const review = makeAdversarialReview({ reviewers: 3, model: 'fable', runReviewer: async () => LIMITED })
      const r = await review(proj, res.branch, 'main', { tip })

      expect(r.decision).toBe('defer') // never merge un-reviewed
      // An exhausted panel is an engine hold, so it must NOT burn MAX_REVIEW_DEFERS.
      expect(r.skippedForPark).toBe(true)
      expect(r.reason).toContain('fable')
      // The sighting landed in the cooling table ⇒ the next panel AND every worker
      // dispatch now resolve one rung down the ladder.
      expect(isTierCooling('fable', Date.now())).toBe(true)
      expect(isTierCooling('opus', Date.now())).toBe(false)
    })

    it('does NOT cool when the reviewer VOTED while quoting the limit wording (e.g. reviewing this patch)', async () => {
      const { proj } = await setupRepo()
      const spawn = makeSpawn(proj, new Set(), { file: () => 'worker.txt', content: 'ok\n', scratch: false })
      const res = await spawn({ projectPath: proj, title: 'card r', hint: 'r' })
      await git(proj, ['fetch', 'origin', 'main'])
      const tip = await tipOf(proj, res.branch)

      const review = makeAdversarialReview({
        reviewers: 3,
        model: 'fable',
        runReviewer: async () => `the diff adds the pattern for "${LIMITED}"\n${CLEAN}`,
      })
      const r = await review(proj, res.branch, 'main', { tip })

      // A real verdict was cast — the transcript merely mentions the notice.
      expect(r.decision).toBe('integrate')
      expect(r.clean).toBe(3)
      expect(isTierCooling('fable', Date.now())).toBe(false)
    })

    // The precision hole this pair pins shut: "abstained × the transcript CONTAINS
    // limit wording" was the whole test, so a reviewer reading the rate-limit code
    // (swarmQuota.ts / this arm) quoted the notice, fumbled its verdict marker, and
    // cooled a perfectly healthy tier for 20 minutes. Quoting is now separated from
    // dying by two independent conditions — see the sensor's comment.
    it('does NOT cool when EVERY reviewer abstained but only QUOTED the wording mid-transcript', async () => {
      const { proj } = await setupRepo()
      const spawn = makeSpawn(proj, new Set(), { file: () => 'worker.txt', content: 'ok\n', scratch: false })
      const res = await spawn({ projectPath: proj, title: 'card q2', hint: 'q2' })
      await git(proj, ['fetch', 'origin', 'main'])
      const tip = await tipOf(proj, res.branch)

      // What a reviewer of THIS patch actually prints: the diff's verbatim fixture,
      // then a page of analysis, then a verdict line whose end token never lands
      // (⇒ abstention). The notice is quoted, but the session lived on past it.
      const QUOTING_ABSTAINER = [
        'Reading the diff against origin/main…',
        `+  // The CLI's PER-MODEL exhaustion notice, verbatim: "${LIMITED}"`,
        '+  /reached your .{0,40}\\blimit\\b/,',
        ...Array.from(
          { length: 12 },
          (_, i) =>
            `Hunk ${i + 1}: the guard holds for the empty-string case and the pattern list stays anchored, so nothing regresses here.`,
        ),
        'OPENGROUND_REVIEW: CLEAN', // marker opened, never closed → no verdict scraped
      ].join('\n')

      const review = makeAdversarialReview({ reviewers: 3, model: 'fable', runReviewer: async () => QUOTING_ABSTAINER })
      const r = await review(proj, res.branch, 'main', { tip })

      // A healthy tier stays healthy — the swarm keeps its top model.
      expect(isTierCooling('fable', Date.now())).toBe(false)
      // Un-decided panel ⇒ an ordinary defer that DOES belong to the review streak
      // (it is the panel failing, not the engine holding for quota).
      expect(r.decision).toBe('defer')
      expect(r.skippedForPark).toBeFalsy()
      expect(r.reason).toContain('多数決つかず')
    })

    it('does NOT cool when one reviewer died at the wall but ANOTHER on the same tier voted', async () => {
      const { proj } = await setupRepo()
      const spawn = makeSpawn(proj, new Set(), { file: () => 'worker.txt', content: 'ok\n', scratch: false })
      const res = await spawn({ projectPath: proj, title: 'card q3', hint: 'q3' })
      await git(proj, ['fetch', 'origin', 'main'])
      const tip = await tipOf(proj, res.branch)

      // Reviewer 1's transcript ENDS in the notice — on its own that is a sighting.
      // But reviewers 2+3 completed full reviews on the SAME tier, concurrently:
      // positive proof it still serves sessions. Cooling waits for a panel that
      // nobody got through (the next one, if the tier really is going dry).
      const review = makeAdversarialReview({
        reviewers: 3,
        model: 'fable',
        runReviewer: async (a) => byIndex({ 1: LIMITED })(a),
      })
      const r = await review(proj, res.branch, 'main', { tip })

      expect(isTierCooling('fable', Date.now())).toBe(false)
      expect(r.decision).toBe('integrate') // 2 of 3 clean — a real majority
      expect(r.clean).toBe(2)
    })
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
