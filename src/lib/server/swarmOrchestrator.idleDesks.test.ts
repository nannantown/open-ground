// swarmOrchestrator.idleDesks.test.ts — desks that cost nothing while waiting
// (docs/AUTONOMY-SPEC.md R-D3, unit U4, 2026-11-28).
//
// MEASURED (spec §1.2): every app start revived the president and the commander
// of each project whose engine.json carried `supplyDesired` / `managerDesired`,
// each with an auto-sent resume prompt — one full turn over the whole context per
// desk per start, whether or not anything was waiting. And a commander that stayed
// up was never measured against the context cap (the cap ran only at spawn), so
// every wake re-read a conversation that kept growing.
//
// The contract pinned here:
//   (a) boot spawns no commander; `managerDesired` stays recorded; the first real
//       need (here: a review-ready card) wakes the absent commander on the next
//       integrate pass, once;
//   (b) the president is revived QUIET — the boot asks its launch to send nothing;
//   (c) at a wake, an idle SDK commander over the commander cap is closed through
//       the unresponsive-desk teardown instead of being woken into the big context;
//       a busy (or under-cap) desk is woken exactly as before; one conversation is
//       closed at most once.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

vi.setConfig({ testTimeout: 60_000 })

// Nothing here may launch a real `claude`.
vi.mock('./claudePreflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claudePreflight')>()
  return { ...actual, claudeRunPreflight: async () => ({ ok: true }) }
})
// The boot path's default commander launcher. A spy, so "the boot did not spawn
// a commander" is an observation rather than the absence of an injected option.
const spawnManagerSpy = vi.hoisted(() => vi.fn(async () => ({ terminalId: '', runtime: 'sdk', agentSessionId: '', resumed: false })))
vi.mock('./swarmManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./swarmManager')>()
  return { ...actual, spawnSwarmManager: spawnManagerSpy }
})

import {
  runIntegratePass,
  resumeEngines,
  defaultDeps,
  emptyMetricsCounters,
  __seedEngineForTests,
  __resetOrchestratorForTests,
  MANAGER_NUDGE_INTERVAL_MS,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { initOverseerRuntime } from './swarmOverseer'
import { readEngineIntent, writeEngineIntent } from './swarmEnginePersistence'
import { canonicalize } from './canonicalize'
import { rememberSwarmManualStop, forgetSwarmManualStop } from './store'
import { settingsFile, engineBootsFile } from './paths'
import type { ProjectTask } from '../types'

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
  overseer: initOverseerRuntime(),
  notified: new Set(),
  pendingFatal: [],
  metrics: emptyMetricsCounters(),
  ...over,
})

const reviewCard = (id: string, branch: string): ProjectTask =>
  ({ id, title: `task ${id}`, boardColumn: 'review', branch }) as ProjectTask

/** Part-B deps that reach nothing real. Every seam this pass can touch is a fake. */
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
  isOnline: async () => true,
  managerDeskRuntime: async () => 'sdk',
  recycleManagerDesk: async () => true,
  managerDeskOverCap: async () => null,
  notify: () => {},
  ...over,
})

/** The pass throttle is per-engine wall-clock; reset it so each call really runs. */
const passAt = (engine: ProjectEngine, deps: IntegrationDeps, now: number): Promise<void> => {
  engine.lastIntegrateAt = 0
  return runIntegratePass(engine, deps, now)
}

/** The boot's own fire-and-forget pass must not wake anything: its review read throws,
 *  so it bails before the commander reflex (what the boot did is all that is observed). */
const bootDeps = (): OrchestratorDeps & IntegrationDeps & AnomalyDeps =>
  intDeps([], {
    fetchReview: async () => {
      throw new Error('board unavailable in this test')
    },
  })

beforeEach(async () => {
  __resetOrchestratorForTests()
  spawnManagerSpy.mockClear()
  proj = await mkdtemp(join(tmpdir(), 'og-idle-desks-'))
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

describe('boot with no commander need (R-D3a)', () => {
  it('spawns no commander, keeps managerDesired, and the first review-ready card wakes it once', async () => {
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false, managerDesired: true })
    const engine = newEngine({ running: false })
    __seedEngineForTests(engine)
    const result = await resumeEngines(bootDeps(), { listProjectPaths: async () => [proj], reconcileRoster: async () => {} })
    expect(result.resumed).toContain(key)
    expect(spawnManagerSpy, 'an idle start must not bill a commander turn').not.toHaveBeenCalled()
    expect((await readEngineIntent(proj)).managerDesired, 'the wish stays recorded').toBe(true)
    // Void the boot's own pass chain; the passes below are driven by hand.
    engine.generation += 1
    engine.running = true

    const woke: string[] = []
    const absent = intDeps([reviewCard('a', 'swarm/a')], {
      managerPresence: async () => 'absent',
      wakeManager: async (p) => {
        woke.push(p)
        return true
      },
    })
    await passAt(engine, absent, T0)
    expect(woke, 'the first need starts the absent commander within one pass').toEqual([key])
    await passAt(engine, absent, T0 + 15_000)
    expect(woke, 'once — the boot grace holds the next pass').toHaveLength(1)
    engine.running = false
  })

  it('no boot path spawns one: autonomy off, or paused by hand, the commander still waits for a need', async () => {
    // The two shapes the 2026-08-26 boot revival was careful to cover (the owner
    // talking to the commander with autonomy off; a paused engine). Both are now
    // served by the relay that carries the owner's words (manager/say wakes it).
    await writeEngineIntent(proj, { desiredRunning: false, overseer: false, managerDesired: true })
    await resumeEngines(bootDeps(), { listProjectPaths: async () => [proj] })
    await rememberSwarmManualStop(key)
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false, managerDesired: true })
    await resumeEngines(bootDeps(), { listProjectPaths: async () => [proj] })
    await forgetSwarmManualStop(key)
    expect(spawnManagerSpy).not.toHaveBeenCalled()
    expect((await readEngineIntent(proj)).managerDesired).toBe(true)
  })

  it('the president comes back QUIET: the boot asks its launch to send nothing', async () => {
    await writeEngineIntent(proj, { desiredRunning: false, overseer: false, supplyDesired: true })
    const launches: unknown[] = []
    await resumeEngines(bootDeps(), {
      listProjectPaths: async () => [proj],
      spawnSupply: async (o) => {
        launches.push(o)
      },
    })
    expect(launches).toEqual([{ projectPath: proj, quiet: true }])
  })
})

describe('cap at wake (R-D3b)', () => {
  const OVER = { agentSessionId: 'big-conversation', tokens: 150_000 }

  it('an idle SDK commander over the cap is CLOSED instead of being woken into its context', async () => {
    const engine = newEngine()
    const recycled: unknown[] = []
    const offered: unknown[] = []
    await passAt(
      engine,
      intDeps([reviewCard('a', 'swarm/a')], {
        managerDeskOverCap: async () => OVER,
        recycleManagerDesk: async (p, o) => {
          recycled.push([p, o])
          return true
        },
        notifyManagerReady: async (_p, n) => {
          offered.push(n)
          return true
        },
      }),
      T0,
    )
    expect(recycled, 'closed through the unresponsive-desk teardown, idle-only').toEqual([[key, { idleOnly: true }]])
    expect(offered, 'nothing typed into the over-cap conversation').toEqual([])
    expect(engine.log.some((l) => l.message.includes('150,000'))).toBe(true)
  })

  it('a desk the seam does not report (busy, under the cap, PTY) is woken exactly as before', async () => {
    const engine = newEngine()
    const recycled: unknown[] = []
    const offered: unknown[] = []
    await passAt(
      engine,
      intDeps([reviewCard('a', 'swarm/a')], {
        managerDeskOverCap: async () => null,
        recycleManagerDesk: async (p) => {
          recycled.push(p)
          return true
        },
        notifyManagerReady: async (_p, n) => {
          offered.push(n)
          return true
        },
      }),
      T0,
    )
    expect(recycled).toEqual([])
    expect(offered).toHaveLength(1)
  })

  it('one conversation is closed at most once — a reopen that resumed it anyway is woken, not looped', async () => {
    const engine = newEngine()
    const recycled: unknown[] = []
    const offered: unknown[] = []
    const deps = (cards: ProjectTask[]) =>
      intDeps(cards, {
        managerDeskOverCap: async () => OVER,
        recycleManagerDesk: async (p) => {
          recycled.push(p)
          return true
        },
        notifyManagerReady: async (_p, n) => {
          offered.push(n)
          return true
        },
      })
    await passAt(engine, deps([reviewCard('a', 'swarm/a')]), T0)
    await passAt(engine, deps([reviewCard('a', 'swarm/a'), reviewCard('b', 'swarm/b')]), T0 + 60_000)
    expect(recycled).toHaveLength(1)
    expect(offered, 'the second wake goes through').toHaveLength(1)
  })

  it('an idle SDK commander over the cap is closed at the NUDGE too, and not poked', async () => {
    const engine = newEngine()
    let over: typeof OVER | null = null
    const recycled: unknown[] = []
    const nudged: string[] = []
    const deps = intDeps([reviewCard('a', 'swarm/a')], {
      managerPresence: async () => 'idle',
      managerDeskOverCap: async () => over,
      recycleManagerDesk: async (p) => {
        recycled.push(p)
        return true
      },
      nudgeManager: async (p) => {
        nudged.push(p)
        return true
      },
    })
    // First pass: the notice lands (under the cap then) and the quiet desk is poked once.
    await passAt(engine, deps, T0)
    expect(nudged).toHaveLength(1)
    // The conversation has since grown past the cap; the next poke is a wake into it.
    over = OVER
    await passAt(engine, deps, T0 + MANAGER_NUDGE_INTERVAL_MS + 1)
    expect(recycled).toEqual([key])
    expect(nudged, 'the desk being closed is not poked').toHaveLength(1)
  })
})
