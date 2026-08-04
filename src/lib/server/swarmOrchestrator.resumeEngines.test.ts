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
  resumeStartedAtMs,
  MAX_EXEC_MS,
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

  it('an OFF pressed DURING the reconcile aborts the resume — no spawn into a stopped engine', async () => {
    // 2026-07-29. The manual-stop / preflight checks happen BEFORE the reconcile,
    // and the reconcile is not instant: it stats worktrees, shells out to git per
    // roster entry, and reads the Board over loopback — seconds to minutes. An
    // owner who opens the app and immediately switches 自動運転 OFF lands inside
    // that window. The loop then adopted-and-respawned `claude` PTYs into an
    // engine the owner had just stopped — and because scheduleNext DOES honour
    // `running`, the tick chain never started, so those workers ran with NOBODY
    // monitoring them (no stall detection, no runaway clock, no reclaim).
    const keyA = await canonicalize(projA)
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })

    const result = await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [projA],
      // The owner presses OFF while the reconcile is in flight.
      reconcileRoster: async () => {
        await rememberSwarmManualStop(keyA)
      },
    })

    expect(result.resumed).not.toContain(keyA)
    const state = await getOrchestratorState(projA, safeDeps())
    expect(state.running).toBe(false)
    await forgetSwarmManualStop(keyA)
  })

  it('a preflight failure skips resume without throwing — and TELLS THE OWNER', async () => {
    // ⚠ THIS TEST CHANGED SIDES (2026-08-04). It was named
    // "(fail-quiet, not fatal)" and pinned the SILENCE as intended: no
    // notification, no journal line (this branch runs before getOrCreateEngine,
    // so there is no engine log yet), and no retry — the background auto-drain
    // sweep is opt-in behind an env var and drain-tick is a pure read.
    //
    // The owner closes the app with autonomy ON. At the next launch `claude` is
    // momentarily not ready — a Finder-launched .app still resolving its
    // login-shell PATH, a re-auth, a CLI upgrade. Autonomy stays OFF for the
    // whole session, the todo cards sit, and nothing anywhere says why. The only
    // surface was the Swarm tab's "autonomy was on — resume?" banner, which
    // looks IDENTICAL to the one shown when the owner turned it off by hand.
    //
    // The two sibling suppression branches (disk fault, crash-loop breaker) both
    // raise 'engine-resume-suppressed'; this one — the likeliest of the three —
    // was the only mute one.
    preflightMock.ok = false
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const result = await resumeEngines(safeDeps(), { listProjectPaths: async () => [projA] })
    expect(result.resumed).toHaveLength(0)
    // `suppressed` stays false: that flag means "the whole boot was suppressed",
    // and here every OTHER project may still resume normally.
    expect(result.suppressed).toBe(false)

    const notifications = await readNotificationsFresh()
    const fatal = notifications.find(
      (n) => n.kind === 'swarm-fatal' && n.swarmFatal?.event === 'engine-resume-suppressed',
    )
    expect(fatal, 'a project that failed to resume must not do so in silence').toBeTruthy()
    expect(fatal?.swarmFatal?.projectPath).toBe(projA)
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

// ── card 4: worker conversation resume (--resume respawn) ────────────────────
// resumeEngines now CONSUMES reconcile's `resumeCandidates`: each proven one is
// `--resume`-respawned into the SAME worktree and adopted into engine.workers
// BEFORE the first pass. These drive that wiring with injected reconcile + proof +
// spawnWorker fakes (no real ~/.claude JSONL, no real PTY).
describe('resumeEngines — worker conversation resume (card 4)', () => {
  const ENTRY = {
    sessionId: 'sess-1111-2222-3333-4444',
    taskId: 'card-1',
    branch: 'swarm/resume-1',
    worktree: '/central/wt/resume-1',
    tier: 'fable',
    spawnAt: 1_700_000_000_000,
    workedMs: 42_000,
    reworkCount: 2,
  }
  // A full RosterReconcileResult with just the resume candidates filled in.
  const reconcileYielding = (candidates: (typeof ENTRY)[]) => async () => ({
    resumeCandidates: candidates,
    ready: [],
    vanished: [],
    cardGone: [],
  })

  // A spawnWorker spy: a RESUME call carries resumeSessionId (→ agentSessionId), a
  // FRESH dispatch call does not — so a twin is visible as a call with no resumeId.
  const spawnSpy = () => {
    const calls: Array<{ resumeSessionId?: string; worktree?: string; title: string }> = []
    const fn = async (opts: {
      title: string
      worktree?: string
      resumeSessionId?: string
    }): Promise<Awaited<ReturnType<OrchestratorDeps['spawnWorker']>>> => {
      calls.push({ resumeSessionId: opts.resumeSessionId, worktree: opts.worktree, title: opts.title })
      return {
        terminalId: opts.resumeSessionId ? 't-resume' : 't-fresh',
        agentSessionId: opts.resumeSessionId ?? 'fresh-sid',
        worktree: opts.worktree ?? '/central/wt/fresh',
        branch: opts.resumeSessionId ? ENTRY.branch : 'swarm/fresh',
        model: 'fable',
      }
    }
    return { calls, fn }
  }

  // Deps with a live pool (isAlive→true so an adopted worker survives + shows in the
  // state view) + inert board writes. Callers override spawnWorker / fetchTasks.
  const liveDeps = (
    over: Partial<OrchestratorDeps & IntegrationDeps & AnomalyDeps> = {},
  ): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({
    ...defaultDeps(),
    fetchTasks: async () => [],
    isAlive: () => true,
    moveToDoing: async () => true,
    countCommitsAhead: async () => 0,
    readHeartbeat: async () => null,
    ...over,
  })

  it('condition ①: a PROVEN candidate is `--resume` respawned (persisted id + SAME worktree) and adopted into engine.workers', async () => {
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const spy = spawnSpy()
    const deps = liveDeps({
      spawnWorker: spy.fn,
      // card in 'doing' ⇒ the fired pass neither reclaims (alive) nor twin-dispatches.
      fetchTasks: async () => [{ id: 'card-1', title: 'resume me', boardColumn: 'doing' } as never],
    })
    await resumeEngines(deps, {
      listProjectPaths: async () => [projA],
      reconcileRoster: reconcileYielding([ENTRY]),
      proveResumable: async () => true,
    })
    // the --resume intent reached the spawn: persisted session id + the SAME worktree
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0].resumeSessionId).toBe(ENTRY.sessionId)
    expect(spy.calls[0].worktree).toBe(ENTRY.worktree)
    // adopted into engine.workers (state view; isAlive→true surfaces it)
    const state = await getOrchestratorState(projA, liveDeps())
    const w = state.workers.find((x) => x.taskId === 'card-1')
    expect(w).toBeTruthy()
    expect(w?.sessionId).toBe(ENTRY.sessionId)
    expect(w?.branch).toBe(ENTRY.branch)
    expect(w?.reworkCount).toBe(ENTRY.reworkCount) // carried across the restart
  })

  it('condition ②: an UNPROVEN candidate (missing/empty/orphan-fresh transcript) FALLS BACK — no --resume, left to crash reclaim', async () => {
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const spy = spawnSpy()
    await resumeEngines(liveDeps({ spawnWorker: spy.fn }), {
      listProjectPaths: async () => [projA],
      reconcileRoster: reconcileYielding([ENTRY]),
      proveResumable: async () => false, // transcript missing / empty / orphan-fresh
    })
    expect(spy.calls).toHaveLength(0) // no resume spawn — the card falls to reclaim
    const state = await getOrchestratorState(projA, liveDeps())
    expect(state.workers.find((x) => x.taskId === 'card-1')).toBeUndefined()
  })

  it('a candidate with NO captured session id cannot resume — no spawn (older roster row / lost id)', async () => {
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const spy = spawnSpy()
    await resumeEngines(liveDeps({ spawnWorker: spy.fn }), {
      listProjectPaths: async () => [projA],
      reconcileRoster: reconcileYielding([{ ...ENTRY, sessionId: '' }]),
      proveResumable: async () => true, // even if "provable", no id ⇒ nothing to --resume
    })
    expect(spy.calls).toHaveLength(0)
  })

  it('a resume spawn that THROWS (a preflight / guard-wiring refusal, a gone worktree) falls back WITHOUT crashing the boot', async () => {
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const throwingSpawn = async (): Promise<Awaited<ReturnType<OrchestratorDeps['spawnWorker']>>> => {
      throw new Error('L4 guard wiring failed verification — worker spawn refused')
    }
    const result = await resumeEngines(liveDeps({ spawnWorker: throwingSpawn }), {
      listProjectPaths: async () => [projA],
      reconcileRoster: reconcileYielding([ENTRY]),
      proveResumable: async () => true,
    })
    // the engine still RESUMED (the drain) — only the worker fell to reclaim
    expect(result.resumed).toContain(await canonicalize(projA))
    const state = await getOrchestratorState(projA, liveDeps())
    expect(state.workers.find((x) => x.taskId === 'card-1')).toBeUndefined()
  })

  it('condition ③ (preflight gate): a project whose claude preflight FAILS never reaches resume — no spawn', async () => {
    // Resume adoption sits DOWNSTREAM of the per-project claudeRunPreflight gate
    // (and the resume spawn itself re-preflights via defaultSpawnWorker + arms the
    // L4 guard via spawnSwarmWorker). MUTATION: drop `if (!pre.ok) continue` in
    // resumeEngines and this project would resume + spawn despite no usable claude
    // ⇒ RED.
    preflightMock.ok = false
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const spy = spawnSpy()
    const result = await resumeEngines(liveDeps({ spawnWorker: spy.fn }), {
      listProjectPaths: async () => [projA],
      reconcileRoster: reconcileYielding([ENTRY]),
      proveResumable: async () => true,
    })
    expect(result.resumed).toHaveLength(0) // preflight failed ⇒ project skipped
    expect(spy.calls).toHaveLength(0) // …so no resume spawn
  })

  it('地雷 (b745aeb3 nit#1): a still-TODO resume candidate is adopted BEFORE the first dispatch pass, so it is NOT twin-spawned', async () => {
    // A resume candidate whose card is TODO (a human moved it back) is ALSO
    // dispatchable — so the order matters. Correct code adopts the resumed worker
    // into engine.workers first, so the fired dispatch pass COUNTS card-1 and skips
    // it: exactly ONE spawn (the --resume), one worker. TEETH: move
    // `adoptResumeCandidates` to AFTER `void runEnginePass(engine, deps)` (or drop
    // it) and the pass dispatches a FRESH twin onto card-1 → a SECOND spawn with no
    // resumeSessionId + a 2nd worker ⇒ this goes RED.
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    const spy = spawnSpy()
    const deps = liveDeps({
      spawnWorker: spy.fn,
      fetchTasks: async () => [{ id: 'card-1', title: 'resume me', boardColumn: 'todo' } as never],
    })
    await resumeEngines(deps, {
      listProjectPaths: async () => [projA],
      reconcileRoster: reconcileYielding([ENTRY]),
      proveResumable: async () => true,
    })
    // Let the fired runEnginePass run its full monitor+dispatch pass — a twin would
    // spawn HERE under the mutation. Hop-count drain (immune to machine load), like
    // the freeze test above.
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0))
    expect(spy.calls).toHaveLength(1) // only the --resume; no fresh twin on card-1
    expect(spy.calls[0].resumeSessionId).toBe(ENTRY.sessionId)
    const state = await getOrchestratorState(
      projA,
      liveDeps({ fetchTasks: async () => [{ id: 'card-1', title: 'x', boardColumn: 'todo' } as never] }),
    )
    expect(state.workers.filter((x) => x.taskId === 'card-1')).toHaveLength(1)
  })

  // ── must-fix (2026-07-24 敵対レビュー): the resumed worker's execution BUDGET ──
  // isRunaway measures MAX_EXEC_MS from the adopted `startedAt`, and the credits that
  // repay idleness (rateLimitHeldMs / integrationWaitMs) are IN-MEMORY ⇒ empty after a
  // restart. Anchoring at the raw `spawnAt` therefore bills the app's DOWNTIME as
  // execution time: worker dispatched 20:00, worked 20m, app closed overnight, resumed
  // 08:00 ⇒ "12h20m old" ⇒ 暴走 on the FIRST monitor pass ⇒ worktree torn down + card
  // parked in blocked. main has no such destruction (it never resumes, so a surviving
  // `doing` card is left alone), so that would break plan §5's "worst case = same as
  // today". resumeStartedAtMs anchors at `now - workedMs` (card 3's ledger) instead.
  //
  // Both boot tests hold the worker BUSY (fresh output + fresh heartbeat) so the STALL
  // arm is silent and the only reachable recovery is the execution ceiling — that
  // keeps what each assertion pins unambiguous.
  const busyDeps = (
    over: Partial<OrchestratorDeps & IntegrationDeps & AnomalyDeps> = {},
  ): OrchestratorDeps & IntegrationDeps & AnomalyDeps =>
    liveDeps({
      lastOutputAt: () => Date.now() - 1_000,
      readHeartbeat: async () => ({ ready: false, blocked: false, at: new Date(Date.now() - 1_000).toISOString() }),
      ...over,
    })

  /** Drive one REAL boot: adopt `entry`, then let the fired dispatch pass run far
   *  enough to have ruled on the resumed worker. The board carries a SECOND, todo card
   *  whose FRESH spawn is the terminator — monitorWorkers runs BEFORE dispatch
   *  (swarmOrchestrator.ts:6730), so observing that fresh spawn proves the monitor has
   *  already decided about card-1. No wall-clock wait ⇒ immune to machine load, and it
   *  fires on BOTH branches (a torn-down worker still leaves card-2 dispatchable), so a
   *  regression fails on the assertion instead of hanging. */
  const bootAndAwaitMonitor = async (entry: typeof ENTRY) => {
    const recoveredCards: { taskId: string; column: string }[] = []
    const tornDown: string[] = []
    let signalFresh = (): void => {}
    const freshSpawned = new Promise<void>((r) => {
      signalFresh = r
    })
    const spy = spawnSpy()
    const deps = busyDeps({
      spawnWorker: async (opts) => {
        const res = await spy.fn(opts)
        if (!opts.resumeSessionId) signalFresh() // the terminator: monitor is already past
        return res
      },
      fetchTasks: async () => [
        { id: 'card-1', title: 'resume me', boardColumn: 'doing' } as never,
        { id: 'card-2', title: 'terminator', boardColumn: 'todo' } as never,
      ],
      recoverCard: async (_p, taskId, column) => {
        recoveredCards.push({ taskId, column })
        return true
      },
      recoverWorker: async ({ worktree }) => {
        tornDown.push(worktree)
        return { removed: true }
      },
    })
    await writeEngineIntent(projA, { desiredRunning: true, selfSupply: false, overseer: false })
    await resumeEngines(deps, {
      listProjectPaths: async () => [projA],
      reconcileRoster: reconcileYielding([entry]),
      proveResumable: async () => true,
    })
    await freshSpawned
    return { recoveredCards, tornDown, spy }
  }

  it("must-fix: a RESUMED worker is NOT judged 暴走 on its first monitor pass — the app's DOWNTIME is not billed as execution time", async () => {
    // ENTRY.spawnAt is ~2.7 years back (the app was closed for that span), but card 3's
    // ledger says this worker only ever WORKED one minute.
    // TEETH (measured 2026-07-24): restore `startedAt: new Date(entry.spawnAt || now)`
    // in adoptResumeCandidates and the first pass reads the worker as 2.7 years old ⇒
    // 暴走 ⇒ tornDown ['/central/wt/resume-1'] + card-1 recovered to 'blocked' ⇒ RED.
    const { recoveredCards, tornDown } = await bootAndAwaitMonitor({ ...ENTRY, workedMs: 60_000 })
    expect(tornDown).toEqual([]) // the worktree (and its uncommitted work) survives
    expect(recoveredCards).toEqual([]) // the card stays in doing — never parked in blocked
  })

  it('…and the restart is NOT an amnesty: a worker whose PERSISTED work already exceeds the ceiling is still judged 暴走 on the first pass', async () => {
    // The other direction of the same anchor — carrying workedMs forward is what stops a
    // restart from resetting the runaway clock and handing out an unbounded fresh budget.
    // TEETH (measured 2026-07-24): "fix" the must-fix by resetting the clock instead
    // (`startedAt: new Date(now)`) and this worker looks 0m old ⇒ no 暴走 ⇒ both
    // assertions go RED. So the pair pins the anchor to exactly `now - workedMs`.
    const { recoveredCards, tornDown } = await bootAndAwaitMonitor({ ...ENTRY, workedMs: MAX_EXEC_MS + 60_000 })
    expect(tornDown).toEqual([ENTRY.worktree])
    expect(recoveredCards).toEqual([{ taskId: 'card-1', column: 'blocked' }])
  })

  it('resumeStartedAtMs: the carried credit is CLAMPED to the real elapsed span (a corrupt ledger can never claim more budget than wall-clock)', () => {
    const now = 1_800_000_000_000
    const e = (over: Partial<typeof ENTRY>) => ({ ...ENTRY, ...over })
    // ordinary resume: anchored at accumulated WORK, not at dispatch
    expect(resumeStartedAtMs(e({ spawnAt: now - 3 * 3_600_000, workedMs: 60_000 }), now)).toBe(now - 60_000)
    // an inflated/corrupt ledger clamps to elapsed ⇒ at worst the ORIGINAL spawnAt, never older
    expect(resumeStartedAtMs(e({ spawnAt: now - 600_000, workedMs: 9_999_999_999 }), now)).toBe(now - 600_000)
    // no ledger (a roster row predating card 3) ⇒ a fresh budget — the same one the
    // crash reclaim this resume replaces would have given
    expect(resumeStartedAtMs(e({ spawnAt: now - 600_000, workedMs: 0 }), now)).toBe(now)
    // a never-recorded spawnAt degrades to `now`, not to 1970
    expect(resumeStartedAtMs(e({ spawnAt: 0, workedMs: 60_000 }), now)).toBe(now)
    // a clock that ran backwards cannot mint budget
    expect(resumeStartedAtMs(e({ spawnAt: now + 60_000, workedMs: 60_000 }), now)).toBe(now)
  })
})
