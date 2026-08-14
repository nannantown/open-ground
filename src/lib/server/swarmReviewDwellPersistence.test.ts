// swarmReviewDwellPersistence.test.ts — the REVIEW DWELL CLOCK across a restart
// (2026-08-14).
//
// THE INCIDENT. `ProjectEngine.reviewSeenAt` — branch → "first seen waiting in
// review" — is the dwell half of the stall check (MANAGER_INTEGRATION_STALL_MS):
// it answers "has this work sat long enough that a working commander would have
// produced SOMETHING?". It lived only in memory, and the comment saying that was
// safe ("a restart relaunches the engine OFF") stopped being true the day
// resumeEngines started honouring `desiredRunning`. So every app restart
// re-stamped every waiting branch as "arrived just now" and rewound the
// 40-minute window from zero. On a day with three releases it rewound three
// times — the commander desk sat idle with two cards in review and was never
// once judged stalled, so the owner was never told. The engine restarts on every
// self-update, i.e. exactly during the stretch most likely to leave work
// waiting: the clock that measures the stall was being reset by the loop it
// exists to catch.
//
// This file guards the DISK half — the mirror out of runIntegratePass and the
// seed back in resumeEngines. The in-memory half (an engine that STARTS with an
// old stamp judges the queue stalled on its first pass, and one that does not
// says nothing) is pinned beside the other manager-reflex tests in
// swarmOrchestrator.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  runIntegratePass,
  resumeEngines,
  defaultDeps,
  emptyMetricsCounters,
  __seedEngineForTests,
  __resetOrchestratorForTests,
  MANAGER_INTEGRATION_STALL_MS,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { initSelfSupplyRuntime } from './swarmSelfSupply'
import { initOverseerRuntime } from './swarmOverseer'
import { readEngineIntent, writeEngineIntent } from './swarmEnginePersistence'
import { projectDataFile } from './projectDataPath'
import { canonicalize } from './canonicalize'
import { settingsFile, engineBootsFile } from './paths'
import type { ProjectTask } from '../types'

// Real fs + canonicalize + settings I/O under load can exceed vitest's 5s
// default (reference_vitest_5s_default_is_the_flake_root).
vi.setConfig({ testTimeout: 60_000 })

// resumeEngines gates each project on `claude` being ready; nothing here spawns
// anything, so answer yes without touching the real CLI.
vi.mock('./claudePreflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claudePreflight')>()
  return { ...actual, claudeRunPreflight: async () => ({ ok: true }) }
})

const T0 = 10_000_000

let proj = ''
let key = ''

const newEngine = (over: Partial<ProjectEngine> = {}): ProjectEngine => ({
  path: key,
  running: true,
  passInFlight: false,
  generation: 0,
  timer: null,
  workers: [],
  reviews: [],
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
  nudges: new Map(),
  log: [],
  anomalies: [],
  selfSupply: initSelfSupplyRuntime(),
  overseer: initOverseerRuntime(),
  notified: new Set(),
  pendingFatal: [],
  metrics: emptyMetricsCounters(),
  ...over,
})

const reviewCard = (id: string, branch: string): ProjectTask =>
  ({ id, title: `task ${id}`, boardColumn: 'review', branch }) as ProjectTask

/** Part-B deps that reach NOTHING real: the desk is reported healthy and working,
 *  so the pass classifies, mirrors the clock, and returns without poking, waking
 *  or notifying anything. Built off defaultDeps so the unrelated required seams
 *  are present; every one this pass could touch is overridden. */
const intDeps = (
  reviews: ProjectTask[],
  over: Partial<IntegrationDeps> = {},
): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({
  ...defaultDeps(),
  fetchTasks: async () => [],
  fetchReview: async () => reviews,
  prepareTarget: async () => 'main',
  classify: async () => 'ff',
  managerPresence: async () => 'active',
  managerDeliveryAt: async () => Date.now(),
  notifyManagerReady: async () => true,
  nudgeManager: async () => true,
  wakeManager: async () => true,
  notify: () => {},
  ...over,
})

/** The pass throttle is per-engine wall-clock; reset it so each call really runs. */
const passAt = (engine: ProjectEngine, deps: IntegrationDeps, now: number): Promise<void> => {
  engine.lastIntegrateAt = 0
  return runIntegratePass(engine, deps, now)
}

beforeEach(async () => {
  __resetOrchestratorForTests()
  proj = await mkdtemp(join(tmpdir(), 'og-dwell-'))
  key = await canonicalize(proj)
  await writeFile(
    settingsFile(),
    JSON.stringify({ projects: [{ id: randomUUID(), path: proj, addedAt: '2026-01-01T00:00:00.000Z' }] }),
  )
  await rm(engineBootsFile(), { recursive: true, force: true })
})

afterEach(async () => {
  __resetOrchestratorForTests()
  await rm(proj, { recursive: true, force: true })
  await writeFile(settingsFile(), JSON.stringify({ projects: [] }))
  await rm(engineBootsFile(), { recursive: true, force: true })
})

describe('review dwell clock — the disk mirror (runIntegratePass)', () => {
  it('a branch arriving in review is MIRRORED into engine.json', async () => {
    const engine = newEngine()
    await passAt(engine, intDeps([reviewCard('a', 'swarm/a')]), T0)
    expect(engine.reviewSeenAt?.get('swarm/a')).toBe(T0)
    expect((await readEngineIntent(proj)).reviewWaitingSince).toEqual({ 'swarm/a': T0 })
  })

  it('the mirror is PRUNED when the branch leaves review — a drained queue stops the clock', async () => {
    const engine = newEngine()
    await passAt(engine, intDeps([reviewCard('a', 'swarm/a')]), T0)
    expect((await readEngineIntent(proj)).reviewWaitingSince).toBeTruthy()
    // The commander integrates it; the card leaves review.
    await passAt(engine, intDeps([]), T0 + 60_000)
    expect(engine.reviewSeenAt?.size).toBe(0)
    // Without this the NEXT boot would resume a dwell for a branch that landed long
    // ago, and judge a perfectly healthy commander stalled the moment it came up.
    expect((await readEngineIntent(proj)).reviewWaitingSince).toBeUndefined()
  })

  it('an UNCHANGED set writes nothing — the mirror is a state-transition write, not a per-pass one', async () => {
    const engine = newEngine()
    await passAt(engine, intDeps([reviewCard('a', 'swarm/a')]), T0)
    // Plant a sentinel ON DISK. A pass that writes would overwrite it with the real
    // clock; a pass that correctly skips leaves it exactly as found. (Reading the
    // file's own `updatedAt` cannot answer this — two writes inside one millisecond
    // are indistinguishable, and the integrate pass runs every 15 seconds.)
    const file = await projectDataFile(proj, 'engine.json')
    const planted = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    planted.reviewWaitingSince = { 'swarm/sentinel': 1 }
    await writeFile(file, JSON.stringify(planted))
    // Same card, still waiting, three more passes.
    for (let i = 1; i <= 3; i++) await passAt(engine, intDeps([reviewCard('a', 'swarm/a')]), T0 + i * 60_000)
    expect((await readEngineIntent(proj)).reviewWaitingSince).toEqual({ 'swarm/sentinel': 1 })
    // …and the moment the set really changes, the mirror catches up.
    await passAt(engine, intDeps([reviewCard('a', 'swarm/a'), reviewCard('b', 'swarm/b')]), T0 + 600_000)
    expect((await readEngineIntent(proj)).reviewWaitingSince).toEqual({
      'swarm/a': T0,
      'swarm/b': T0 + 600_000,
    })
  })

  it('a disk that cannot be written NEVER blocks the pass — the in-memory clock is the truth', async () => {
    // FAIL-OPEN (the plan's §3 rule). An engine on a path the registry does not know
    // cannot resolve a data dir at all, which is the harshest version of "the mirror
    // is unavailable": the pass must still classify, still stamp, still return.
    const orphan = newEngine({ path: '/nowhere/not-registered' })
    await expect(passAt(orphan, intDeps([reviewCard('a', 'swarm/a')]), T0)).resolves.toBeUndefined()
    expect(orphan.reviewSeenAt?.get('swarm/a')).toBe(T0) // in-memory clock unaffected
    expect(orphan.log.filter((l) => l.message.includes('review dwell clock persist failed'))).toHaveLength(1)
    // …and said ONCE, not once per pass, however long the disk stays broken.
    for (let i = 1; i <= 5; i++) {
      await passAt(orphan, intDeps([reviewCard('a', 'swarm/a'), reviewCard(`x${i}`, `swarm/x${i}`)]), T0 + i * 1000)
    }
    expect(orphan.log.filter((l) => l.message.includes('review dwell clock persist failed'))).toHaveLength(1)
  })
})

describe('review dwell clock — the seed back (resumeEngines)', () => {
  /** resumeEngines kicks a fire-and-forget pass; a `fetchReview` that throws makes
   *  that pass bail BEFORE the clock sweep (it logs a warn and returns), so the
   *  assertions below observe the SEED and nothing downstream of it. */
  const resumeDeps = (): OrchestratorDeps & IntegrationDeps & AnomalyDeps =>
    intDeps([], {
      fetchReview: async () => {
        throw new Error('board unavailable in this test')
      },
    })

  it('a persisted dwell is SEEDED into the resumed engine — the restart does not rewind the window', async () => {
    const waitingSince = T0 - MANAGER_INTEGRATION_STALL_MS - 60_000
    await writeEngineIntent(proj, {
      desiredRunning: true,
      selfSupply: false,
      overseer: false,
      reviewWaitingSince: { 'swarm/a': waitingSince },
    })
    // Seed the engine object so this test holds the reference resumeEngines will use
    // (getOrCreateEngine returns an existing entry keyed by the canonical path).
    const engine = newEngine({ running: false })
    __seedEngineForTests(engine)

    const result = await resumeEngines(resumeDeps(), {
      listProjectPaths: async () => [proj],
      reconcileRoster: async () => {},
    })

    expect(result.resumed).toContain(key)
    // THE FIX: the resumed engine already knows this branch has been waiting 41
    // minutes. Without the seed it holds nothing, the first pass stamps `now`, and
    // the stall window starts over — which is the bug, once per restart.
    expect(engine.reviewSeenAt?.get('swarm/a')).toBe(waitingSince)
    engine.running = false // stop the chain this test kicked
  })

  it('an ABSENT or CORRUPT persisted clock degrades to today\'s behaviour — never a failed resume', async () => {
    // Fail-open in the read direction: the file is hand-editable on disk, and a
    // clock that cannot be trusted must cost only the head start, never the boot.
    await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: false })
    const file = await projectDataFile(proj, 'engine.json')
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    // Every shape a torn/edited file can take: wrong type, wrong value types, junk.
    raw.reviewWaitingSince = { 'swarm/a': 'yesterday', '': 5, 'swarm/b': -1, 'swarm/c': null }
    await writeFile(file, JSON.stringify(raw))

    const engine = newEngine({ running: false })
    __seedEngineForTests(engine)
    const result = await resumeEngines(resumeDeps(), {
      listProjectPaths: async () => [proj],
      reconcileRoster: async () => {},
    })
    expect(result.resumed).toContain(key) // the resume itself is untouched
    expect(engine.reviewSeenAt?.size ?? 0).toBe(0) // …and no bogus dwell was seeded
    engine.running = false
  })

  it('a stale entry for a branch that already left review is dropped by the first pass', async () => {
    // The seed is a head start, not a verdict: the pass's own `present` sweep is
    // still what decides which branches are waiting, so a branch integrated while
    // the app was closed cannot hold the clock back.
    await writeEngineIntent(proj, {
      desiredRunning: true,
      selfSupply: false,
      overseer: false,
      reviewWaitingSince: { 'swarm/gone': T0 - 3 * MANAGER_INTEGRATION_STALL_MS, 'swarm/a': T0 - 60_000 },
    })
    const engine = newEngine({ running: false })
    __seedEngineForTests(engine)
    await resumeEngines(resumeDeps(), { listProjectPaths: async () => [proj], reconcileRoster: async () => {} })
    expect(engine.reviewSeenAt?.size).toBe(2)

    engine.running = true
    await passAt(engine, intDeps([reviewCard('a', 'swarm/a')]), T0)
    expect(engine.reviewSeenAt?.has('swarm/gone')).toBe(false)
    expect(engine.reviewSeenAt?.get('swarm/a')).toBe(T0 - 60_000) // the LIVE one keeps its dwell
    expect((await readEngineIntent(proj)).reviewWaitingSince).toEqual({ 'swarm/a': T0 - 60_000 })
    engine.running = false
  })
})
