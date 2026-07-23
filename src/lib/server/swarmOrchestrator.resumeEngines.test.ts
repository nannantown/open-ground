import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  resumeEngines,
  getOrchestratorState,
  startOrchestrator,
  defaultDeps,
  __resetOrchestratorForTests,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { writeEngineIntent, readEngineIntent } from './swarmEnginePersistence'
import { canonicalize } from './canonicalize'
import { rememberSwarmManualStop, forgetSwarmManualStop } from './store'
import { settingsFile, engineBootsFile } from './paths'
import type { AppNotification, SwarmInfoNotification } from '../types'

// resumeEngines() is card 2's boot re-hydration entry point
// (docs/ENGINE_PERSISTENCE_PLAN.md §4). These tests register REAL project
// directories (empty — no tasks.json) so writeEngineIntent/readEngineIntent's
// projectDataFile resolution succeeds, and drive resumeEngines with an
// injected listProjectPaths so no real registry sweep is needed.
//
// Real fs + canonicalize + settings I/O under load can occasionally exceed
// vitest's 5s default (reference_vitest_5s_default_is_the_flake_root). Pinned
// to the canonical ceiling (vitest.config.ts's 60s); a shorter value here would
// silently re-cap that global back down (setConfig runs after the global config).
vi.setConfig({ testTimeout: 60_000 })

const preflightMock = vi.hoisted(() => ({ ok: true }))
vi.mock('./claudePreflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claudePreflight')>()
  return {
    ...actual,
    claudeRunPreflight: async () => (preflightMock.ok ? { ok: true } : { ok: false, body: { error: 'not ready' } }),
  }
})

// A successful resume fires runEnginePass fire-and-forget (`void … .catch(() =>
// {})`), which — with the REAL defaultDeps() — hits `fetchTasks`'s actual HTTP
// call to the loopback API (no server listening in a unit test), silently
// swallowed by that `.catch`. Harmless-but-real network I/O in a test is still
// undesirable (slow, and a false pass if something IS listening on that port).
// Override just `fetchTasks` to a pure empty-board stub — with zero cards,
// dispatch/monitor/integrate never reach any of the OTHER deps (spawnWorker,
// moveToDoing, …), so nothing else needs stubbing.
const safeDeps = (): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({
  ...defaultDeps(),
  fetchTasks: async () => [],
})

let projA = ''
let projB = ''
let uuidA = ''
let uuidB = ''

beforeEach(async () => {
  __resetOrchestratorForTests()
  preflightMock.ok = true
  projA = await mkdtemp(join(tmpdir(), 'og-resume-a-'))
  projB = await mkdtemp(join(tmpdir(), 'og-resume-b-'))
  uuidA = randomUUID()
  uuidB = randomUUID()
  await writeFile(
    settingsFile(),
    JSON.stringify({
      projects: [
        { id: uuidA, path: projA, addedAt: '2026-01-01T00:00:00.000Z' },
        { id: uuidB, path: projB, addedAt: '2026-01-01T00:00:00.000Z' },
      ],
    }),
  )
  await rm(engineBootsFile(), { recursive: true, force: true })
})

afterEach(async () => {
  __resetOrchestratorForTests()
  const keyA = await canonicalize(projA)
  const keyB = await canonicalize(projB)
  await forgetSwarmManualStop(keyA)
  await forgetSwarmManualStop(keyB)
  await rm(projA, { recursive: true, force: true })
  await rm(projB, { recursive: true, force: true })
  await writeFile(settingsFile(), JSON.stringify({ projects: [] }))
  await rm(engineBootsFile(), { recursive: true, force: true })
})

// Actual notification helper uses OPENGROUND_HOME which is the whole-suite tmp
// dir pinned by src/test/setup-home.ts — re-resolve it fresh each read since
// setup-home re-pins it around every test.
const swarmNotificationsPath = () => join(process.env.OPENGROUND_HOME ?? '', 'swarm-notifications.json')
const readNotificationsFresh = async (): Promise<AppNotification[]> => {
  try {
    const raw = JSON.parse(await readFile(swarmNotificationsPath(), 'utf8')) as { items: AppNotification[] }
    return raw.items
  } catch {
    return []
  }
}

describe('resumeEngines — boot re-hydration (card 2)', () => {
  it('resumes a project whose engine.json says desiredRunning:true', async () => {
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA] })
    const keyA = await canonicalize(projA)
    expect(result.suppressed).toBe(false)
    expect(result.resumed).toContain(keyA)
    const state = await getOrchestratorState(projA, safeDeps())
    expect(state.running).toBe(true)
  })

  it('PIN (must-fix C, 2nd rework): overseer:true in engine.json is NEVER read back to auto-arm the overseer on boot resume — a confirmed, owner-approved invariant, not a stray omission', async () => {
    // This is the ONE field resumeEngines() deliberately does not honor (see
    // its own doc comment + docs/ENGINE_PERSISTENCE_PLAN.md §2 + OVERSEER_DESIGN.md
    // K2): overseer drives brain PTY spawns, worker PTY injection, and janitor's
    // destructive git ops, and a restart is its one dependency-free kill switch
    // (L9-③) — auto-arming it from a machine-driven boot would defeat that.
    // Without a pin, adding `engine.overseer.enabled = intent.overseer` to
    // resumeEngines is a ONE-LINE, easy-to-miss regression that the rest of the
    // suite does not catch (confirmed by mutation: adding that line leaves every
    // OTHER test in this file green).
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: true })
    const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA] })
    expect(result.resumed).toHaveLength(1) // the drain itself still resumes...
    const state = await getOrchestratorState(projA, safeDeps())
    expect(state.running).toBe(true)
    expect(state.overseer).toBe(false) // ...but the overseer must NOT be armed
  })

  it('leaves a project with NO engine.json (never started) untouched', async () => {
    const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA] })
    expect(result.resumed).toHaveLength(0)
    const state = await getOrchestratorState(projA, safeDeps())
    expect(state.running).toBe(false)
  })

  it('an EXPLICIT desiredRunning:false (a prior stopOrchestrator) stays OFF — this is the direct observation of completion condition ⑤, not just the absent-file case above', async () => {
    await writeEngineIntent(projA, { desiredRunning: false, selfSupply: true, overseer: false })
    const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA] })
    expect(result.resumed).toHaveLength(0)
    const state = await getOrchestratorState(projA, safeDeps())
    expect(state.running).toBe(false)
  })

  it('a persisted manual-stop record wins over desiredRunning (supremacy)', async () => {
    const keyA = await canonicalize(projA)
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    await rememberSwarmManualStop(keyA)
    const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA] })
    expect(result.resumed).not.toContain(keyA)
    const state = await getOrchestratorState(projA, safeDeps())
    expect(state.running).toBe(false)
  })

  it('a preflight failure skips resume without throwing (fail-quiet, not fatal)', async () => {
    preflightMock.ok = false
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA] })
    expect(result.resumed).toHaveLength(0)
    expect(result.suppressed).toBe(false)
  })

  it('resumes multiple projects independently and fires ONE summarizing info notification', async () => {
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    await writeEngineIntent(projB, { desiredRunning: true, selfSupply: true, overseer: false })
    const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA, projB] })
    expect(result.resumed).toHaveLength(2)
    const notifications = await readNotificationsFresh()
    const info = notifications.find((n) => n.kind === 'swarm-info' && n.swarmInfo?.event === 'engine-resumed')
    expect(info).toBeTruthy()
    expect((info?.swarmInfo as SwarmInfoNotification | undefined)?.detail).toContain('2')
  })

  it('a corrupt engine.json is treated as not-running (fail-quiet-to-OFF), never throws', async () => {
    // No writeEngineIntent call at all — readEngineIntent's own corrupt-file
    // coverage lives in swarmEnginePersistence.test.ts; here we just confirm
    // resumeEngines composes with the default (never-started) case cleanly.
    const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA, projB] })
    expect(result.resumed).toHaveLength(0)
    expect(result.suppressed).toBe(false)
  })

  it('crash-loop breaker: 3 boots of the same version within 10 minutes suppresses resume + fires a fatal notification', async () => {
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const now = 1_000_000
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA], now, appVersion: '9.9.9' })
    await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [projA],
      now: now + 1000,
      appVersion: '9.9.9',
    })
    const third = await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [projA],
      now: now + 2000,
      appVersion: '9.9.9',
    })
    expect(third.suppressed).toBe(true)
    expect(third.resumed).toHaveLength(0)
    const notifications = await readNotificationsFresh()
    const fatal = notifications.find(
      (n) => n.kind === 'swarm-fatal' && n.swarmFatal?.event === 'engine-resume-suppressed',
    )
    expect(fatal).toBeTruthy()
  })

  it('a VERSION BUMP resets the breaker window (self-update cutover is not a crash loop)', async () => {
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const now = 2_000_000
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA], now, appVersion: '1.0.0' })
    await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [projA],
      now: now + 1000,
      appVersion: '1.0.0',
    })
    // A NEW version's first boot — must NOT inherit the old version's trip count.
    const bumped = await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [projA],
      now: now + 2000,
      appVersion: '1.1.0',
    })
    expect(bumped.suppressed).toBe(false)
  })

  it('FAIL-CLOSED: if the boot ring itself cannot be persisted, resumeEngines suppresses this boot (never resumes with an unrecordable breaker)', async () => {
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    // Directing engine-boots.json AT a directory makes recordEngineBoot's write
    // fail — recordEngineBoot itself is covered in swarmEnginePersistence.test.ts;
    // this test is the end-to-end proof that resumeEngines actually WIRES that
    // failure into "refuse to resume", not just "log and carry on".
    const dir = engineBootsFile()
    await mkdir(dir, { recursive: true })
    try {
      const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA] })
      expect(result.suppressed).toBe(true)
      expect(result.resumed).toHaveLength(0)
      const notifications = await readNotificationsFresh()
      const fatal = notifications.find(
        (n) => n.kind === 'swarm-fatal' && n.swarmFatal?.event === 'engine-resume-suppressed',
      )
      expect(fatal).toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('nit fix (2nd rework): manually pressing ON after a SUPPRESSED boot resume backfills selfSupply from the persisted intent instead of clobbering it with false', async () => {
    // Set up exactly the gap the reviewer found: a persisted intent that says
    // selfSupply was ON, but this boot's resumeEngines() never got to touch the
    // project (breaker tripped) — so the in-memory engine, once it eventually
    // gets created, starts from the ProjectEngine defaults (selfSupply: false).
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: true, overseer: false })
    const now = 5_000_000
    // Trip the breaker with THREE EMPTY-PROJECT-LIST boots first — projA must
    // never actually get resumed by these (an empty list can't touch it), only
    // fill the boot ring so the FOURTH call (which finally includes projA) is
    // the one that's suppressed. (Including projA in the tripping calls would
    // let call #1/#2 — pre-trip — actually resume it for real, which is a
    // different scenario than the one this test targets: NEVER having gotten a
    // chance to resume before the owner presses ON by hand.)
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [], now, appVersion: '7.0.0' })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [], now: now + 1000, appVersion: '7.0.0' })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [], now: now + 2000, appVersion: '7.0.0' })
    const suppressedBoot = await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [projA],
      now: now + 3000,
      appVersion: '7.0.0',
    })
    expect(suppressedBoot.suppressed).toBe(true)
    expect((await getOrchestratorState(projA, safeDeps())).running).toBe(false)
    // The persisted intent is untouched by the suppression itself.
    expect((await readEngineIntent(projA)).selfSupply).toBe(true)

    // Owner manually presses ON (unaware the automatic resume was held back).
    const state = await startOrchestrator(projA, safeDeps())
    expect(state.running).toBe(true)
    expect(state.selfSupply).toBe(true) // backfilled — NOT silently reset to false
    // ...and the write-through this triggers doesn't re-lose it either.
    expect((await readEngineIntent(projA)).selfSupply).toBe(true)
  })

  // ── card 3 — RECONCILE-FIRST, SPAWN FROZEN (completion condition ②) ──────────
  it('condition ②: the dispatch pass is FROZEN until the roster reconcile resolves (reconcile-first)', async () => {
    // The freeze is the `await reconcile(key)` that sits BEFORE runEnginePass is kicked
    // in resumeEngines (swarmOrchestrator.ts). This test proves the CAUSAL ORDER — the
    // dispatch pass's very first act (`fetchTasks`) may not run until reconcile has
    // RESOLVED — WITHOUT any wall-clock window, so it is immune to event-loop load
    // (earlier resume tests otherwise congest it; see __resetOrchestratorForTests).
    //
    // How: the injected reconcile blocks on a gate and flips `reconcileResolved` only
    // AFTER it is released; `fetchTasks` records whether it was called while that flag
    // was still false. Correct code (`await reconcile`) makes fetchTasks STRUCTURALLY
    // later than reconcile's resolution → the flag is always true by then → the probe
    // stays false. TEETH: change `await reconcile(key)` to `void reconcile(key)` (or
    // move it after the runEnginePass kick) and runEnginePass is fired while reconcile
    // is still parked, so fetchTasks runs with `reconcileResolved` false → the probe
    // trips and the final `toBe(false)` goes RED. (Verified by mutation, 2026-07-23.)
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })

    let releaseReconcile = (): void => {}
    const reconcileGate = new Promise<void>((r) => {
      releaseReconcile = r
    })
    let signalReconcileReached = (): void => {}
    const reconcileReached = new Promise<void>((r) => {
      signalReconcileReached = r
    })
    let reconcileResolved = false
    let fetchedBeforeReconcileResolved = false
    let signalSpawned = (): void => {}
    const spawned = new Promise<void>((r) => {
      signalSpawned = r
    })
    const spawnCalls: string[] = []

    const deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = {
      ...defaultDeps(),
      // The dispatch pass's FIRST act. If it ever runs before reconcile has resolved,
      // the freeze is broken — record that. One todo card, so the pass WOULD spawn.
      fetchTasks: async () => {
        if (!reconcileResolved) fetchedBeforeReconcileResolved = true
        return [{ id: 'card-1', title: 'freeze me', boardColumn: 'todo' } as never]
      },
      moveToDoing: async () => true,
      isAlive: () => true,
      spawnWorker: async () => {
        spawnCalls.push('spawn')
        signalSpawned()
        return { terminalId: 't1', agentSessionId: 's1', worktree: '/wt/1', branch: 'swarm/1', model: 'fable' }
      },
    }

    const resumeP = resumeEngines(deps, {
      listProjectPaths: async () => [projA],
      reconcileRoster: async () => {
        signalReconcileReached() // resumeEngines has REACHED reconcile (past the fs gates)
        await reconcileGate // ← the boot hangs HERE until the test releases it
        reconcileResolved = true
      },
    })

    // Wait until resumeEngines is AT reconcile (this decouples the drain below from the
    // variable-length fs gate path before reconcile). Now: correct code is PARKED on
    // `await reconcile` (runEnginePass NOT kicked); the MUTATION has already kicked
    // runEnginePass, whose fetchTasks is heading to run with reconcileResolved false.
    await reconcileReached
    // Drain a handful of MACROTASK boundaries (setTimeout(0)) — only enough to cover
    // the mutation's runEnginePass→fetchTasks hop, NOT resumeEngines' whole path. Frozen
    // path: parked ⇒ these are no-ops ⇒ fetchTasks never runs. Hop-count based, so it is
    // immune to machine load.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))

    // Release → reconcile resolves → the pass runs its (now-legitimate) fetchTasks and
    // spawns. `await spawned` guarantees the pass actually reached dispatch.
    releaseReconcile()
    await resumeP
    await spawned

    expect(fetchedBeforeReconcileResolved).toBe(false) // FROZEN — the reconcile-first order held
    expect(spawnCalls).toHaveLength(1) // …and dispatch DID proceed once reconcile resolved
  })
})
