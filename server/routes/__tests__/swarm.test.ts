import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { __resetOrchestratorForTests } from '@/lib/server/swarmOrchestrator'
import {
  __resetQuotaForTest,
  __simulateRestartForTest,
  flushQuotaPersist,
} from '@/lib/server/swarmQuota'
import { swarmQuotaFile } from '@/lib/server/paths'
import { setSettings } from '@/lib/server/store'
import { createSwarmFatalNotification } from '@/lib/server/swarmNotifications'
import type { SwarmOrchestratorState, AppNotificationsResponse, SwarmQuotaResponse } from '@/lib/types'

// POST /api/swarm/worker + /worktree/remove against the real Hono app, with
// OPENGROUND_HOME on a throwaway dir so the registry (the validateProjectPath
// allowlist) starts empty. The in-app swarm is OWNER-ONLY: both routes gate on
// the signed-in app-login role at the very top, so every test signs in as the
// owner (env override below, network-free) before exercising the VALIDATION
// branches — which all run BEFORE the claude preflight / any git, so no `claude`
// CLI and no real repo are needed. The dedicated "owner gate" block proves the
// non-owner/signed-out → 403 and owner → passes branches. The happy path
// (worktree + PTY + /order) is curl-verified on the real machine.

const OWNER = 'owner@example.com'
const TESTER = 'tester@example.com'

// Roles ship with NO built-in emails; grant them through the env override so
// these route tests stay network-free (the override skips the og_roles lookup).
// setup-home.ts clears these for a hermetic baseline, so set them here.
process.env.OPENGROUND_OWNER_EMAILS = OWNER
process.env.OPENGROUND_TESTER_EMAILS = TESTER

const signInAs = (email: string) =>
  writeSession({
    user: { id: 'test-user', email, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
  })

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-swarm-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-swarm-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  // Sign in as the owner so the owner gate passes and the validation branches
  // below are reachable. Must come AFTER OPENGROUND_HOME so the session lands in
  // this test's throwaway home.
  await signInAs(OWNER)
})
afterEach(async () => {
  // Drop any engine + its pending timer chain so a started orchestrator can't
  // leak a setTimeout into the next test.
  __resetOrchestratorForTests()
  await clearSession()
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const register = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
}

describe('POST /api/swarm/worker (validation)', () => {
  it('400 when path is missing', async () => {
    const res = await app.request('/api/swarm/worker', json({ title: 'x' }))
    expect(res.status).toBe(400)
  })

  it('403 when the path is not a registered project (the allowlist holds)', async () => {
    const dir = join(scratch, 'unregistered')
    await mkdir(dir, { recursive: true })
    const res = await app.request('/api/swarm/worker', json({ path: dir, title: 'x' }))
    expect(res.status).toBe(403)
  })

  it('400 when neither taskId nor title is given', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    const res = await app.request('/api/swarm/worker', json({ path: dir }))
    expect(res.status).toBe(400)
  })

  it('400 when the title is blank (no card)', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    const res = await app.request('/api/swarm/worker', json({ path: dir, title: '   ' }))
    expect(res.status).toBe(400)
  })

  it('404 when the taskId is not on the board', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    const res = await app.request('/api/swarm/worker', json({ path: dir, taskId: 'nope' }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/swarm/supply (validation)', () => {
  // Supply reads no card (it IS the desk that fills the board), so its only
  // pre-spawn validation is owner gate (below) → path required → registry
  // allowlist. These branches all run BEFORE the claude preflight / any spawn,
  // so no `claude` CLI is needed. The happy path (PTY + /supply) is
  // curl-verified on the real machine, like the worker spawn.
  it('400 when path is missing', async () => {
    const res = await app.request('/api/swarm/supply', json({}))
    expect(res.status).toBe(400)
  })

  it('403 when the path is not a registered project (the allowlist holds)', async () => {
    const dir = join(scratch, 'unregistered')
    await mkdir(dir, { recursive: true })
    const res = await app.request('/api/swarm/supply', json({ path: dir }))
    expect(res.status).toBe(403)
  })
})

describe('POST /api/swarm/worktree/remove (validation + central-only guard)', () => {
  it('400 when path is missing', async () => {
    const res = await app.request('/api/swarm/worktree/remove', json({ worktree: '/x' }))
    expect(res.status).toBe(400)
  })

  it('403 when the path is not a registered project', async () => {
    const dir = join(scratch, 'unregistered')
    await mkdir(dir, { recursive: true })
    const res = await app.request(
      '/api/swarm/worktree/remove',
      json({ path: dir, worktree: '/x' }),
    )
    expect(res.status).toBe(403)
  })

  it('400 when worktree is missing', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    const res = await app.request('/api/swarm/worktree/remove', json({ path: dir }))
    expect(res.status).toBe(400)
  })

  it('refuses (removed:false) a path OUTSIDE the central worktrees dir', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    // An existing dir that is NOT under ~/.openground/projects/<uuid>/worktrees/
    // — the central-only guard must keep it, never `git worktree remove` it.
    const res = await app.request(
      '/api/swarm/worktree/remove',
      json({ path: dir, worktree: scratch, force: true }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { removed: boolean; reason?: string }
    expect(body.removed).toBe(false)
    expect(body.reason).toBe('not a central worktree')
  })

  it('refuses a NON-EXISTENT path outside central (guard runs before idempotency)', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    // A path that does not exist AND is outside central must be refused — never
    // wrongly reported as removed:true by the "already gone" idempotency branch.
    const res = await app.request(
      '/api/swarm/worktree/remove',
      json({ path: dir, worktree: join(scratch, 'does-not-exist'), force: true }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { removed: boolean; reason?: string }
    expect(body.removed).toBe(false)
    expect(body.reason).toBe('not a central worktree')
  })
})

describe('owner gate — the in-app swarm is owner-only', () => {
  // The gate runs FIRST, before body parse / path validation. With the SAME
  // (empty) body, a non-owner gets 403 (gate) while the owner gets 400 (path
  // required) — proving the gate fires ahead of, and independently of, the
  // existing validation. tester (a signed-in non-owner) is also 403: the gate is
  // owner-only, stricter than the custom-tab authoring routes that allow tester.
  it('POST /api/swarm/worker → 403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/worker', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/worker → 403 for a signed-in non-owner (tester)', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/worker', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/worker → owner passes the gate (reaches validation: 400)', async () => {
    // The same empty body that 403s for a non-owner reaches the path check (400)
    // for the owner — proving the gate passes. Explicit sign-in (not just the
    // beforeEach) keeps this case self-contained.
    await signInAs(OWNER)
    const res = await app.request('/api/swarm/worker', json({}))
    expect(res.status).toBe(400)
  })

  it('POST /api/swarm/worktree/remove → 403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/worktree/remove', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/worktree/remove → 403 for a signed-in non-owner (tester)', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/worktree/remove', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/worktree/remove → owner passes the gate (reaches validation: 400)', async () => {
    await signInAs(OWNER)
    const res = await app.request('/api/swarm/worktree/remove', json({}))
    expect(res.status).toBe(400)
  })

  it('POST /api/swarm/supply → 403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/supply', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/supply → 403 for a signed-in non-owner (tester)', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/supply', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/supply → owner passes the gate (reaches validation: 400)', async () => {
    await signInAs(OWNER)
    const res = await app.request('/api/swarm/supply', json({}))
    expect(res.status).toBe(400)
  })

  it('GET /api/swarm/orchestrator → 403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/orchestrator')
    expect(res.status).toBe(403)
  })

  it('GET /api/swarm/orchestrator → 403 for a signed-in non-owner (tester)', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/orchestrator')
    expect(res.status).toBe(403)
  })

  it('GET /api/swarm/workers → 403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/workers')
    expect(res.status).toBe(403)
  })

  it('GET /api/swarm/workers → 403 for a signed-in non-owner (tester)', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/workers')
    expect(res.status).toBe(403)
  })

  it('GET /api/swarm/workers → owner passes the gate (reaches validation: 400)', async () => {
    await signInAs(OWNER)
    const res = await app.request('/api/swarm/workers')
    expect(res.status).toBe(400)
  })

  it('POST /api/swarm/orchestrator/start → 403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/orchestrator/start', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/orchestrator/start → 403 for a tester', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/orchestrator/start', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/orchestrator/stop → 403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/orchestrator/stop', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/orchestrator/start → owner passes the gate (reaches validation: 400)', async () => {
    await signInAs(OWNER)
    const res = await app.request('/api/swarm/orchestrator/start', json({}))
    expect(res.status).toBe(400)
  })

  it('POST /api/swarm/orchestrator/drain-tick → 403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/orchestrator/drain-tick', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/orchestrator/drain-tick → 403 for a tester', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/orchestrator/drain-tick', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/orchestrator/drain-tick → owner passes the gate (reaches validation: 400)', async () => {
    await signInAs(OWNER)
    const res = await app.request('/api/swarm/orchestrator/drain-tick', json({}))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/swarm/orchestrator/automerge (RETIRED 2026-07-16)', () => {
  // The separate auto-wake-the-commander toggle is GONE: the wake reflex is
  // always armed while the engine runs, so this route must stay unmounted —
  // a 404 like any unknown /api/* path, even for the owner. Pins the retirement
  // (a resurrected toggle would answer 403/400/200 here and fail this).
  it('404 even for the owner — the toggle route is gone, not gated', async () => {
    await signInAs(OWNER)
    const dir = join(scratch, 'app')
    await register(dir)
    const res = await app.request('/api/swarm/orchestrator/automerge', json({ path: dir, enabled: true }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/swarm/orchestrator/review/resolve (resolve a stuck review card — owner)', () => {
  it('403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/orchestrator/review/resolve', json({}))
    expect(res.status).toBe(403)
  })

  it('403 for a tester (owner-only)', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/orchestrator/review/resolve', json({}))
    expect(res.status).toBe(403)
  })

  it('owner: 400 for a missing taskId / target, or an invalid target', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    expect((await app.request('/api/swarm/orchestrator/review/resolve', json({ path: dir }))).status).toBe(400)
    expect(
      (await app.request('/api/swarm/orchestrator/review/resolve', json({ path: dir, taskId: 'a' }))).status,
    ).toBe(400)
    expect(
      (await app.request('/api/swarm/orchestrator/review/resolve', json({ path: dir, taskId: 'a', target: 'done' }))).status,
    ).toBe(400) // only blocked | todo are valid targets
  })

  it('403 when the path is not a registered project (the allowlist holds)', async () => {
    const dir = join(scratch, 'unregistered-resolve')
    await mkdir(dir, { recursive: true })
    const res = await app.request(
      '/api/swarm/orchestrator/review/resolve',
      json({ path: dir, taskId: 'a', target: 'blocked' }),
    )
    expect(res.status).toBe(403)
  })

  it('a registered project with no engine returns a stopped empty state (idempotent no-op)', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    const res = await app.request(
      '/api/swarm/orchestrator/review/resolve',
      json({ path: dir, taskId: 'nope', target: 'blocked' }),
    )
    expect(res.status).toBe(200)
    const state = (await res.json()) as SwarmOrchestratorState
    expect(state.running).toBe(false)
    expect(state.reviews).toHaveLength(0)
  })
})

describe('GET /api/swarm/orchestrator (state — owner)', () => {
  // The happy-path START (spawning workers) needs the `claude` CLI + a live
  // board listener, so it is curl-verified on the real machine like the worker
  // spawn. Here we prove the OWNER-reachable validation + the never-started
  // state shape, which need neither.
  it('400 when path is missing', async () => {
    const res = await app.request('/api/swarm/orchestrator')
    expect(res.status).toBe(400)
  })

  it('403 when the path is not a registered project (the allowlist holds)', async () => {
    const dir = join(scratch, 'unregistered')
    await mkdir(dir, { recursive: true })
    const res = await app.request(
      `/api/swarm/orchestrator?path=${encodeURIComponent(dir)}`,
    )
    expect(res.status).toBe(403)
  })

  it('a registered, never-started project reads back as a stopped empty engine', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    const res = await app.request(
      `/api/swarm/orchestrator?path=${encodeURIComponent(dir)}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as SwarmOrchestratorState
    expect(body.running).toBe(false)
    expect(body.workers).toEqual([])
    expect(body.log).toEqual([])
    expect(body.maxWorkers).toBeGreaterThan(0)
  })

  it('stop on a never-started project is a no-op stopped state (idempotent)', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    const res = await app.request('/api/swarm/orchestrator/stop', json({ path: dir }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as SwarmOrchestratorState
    expect(body.running).toBe(false)
  })
})

describe('GET /api/swarm/workers (server-truth worker list — owner)', () => {
  // The full cross-referenced happy path (a live PTY / heartbeat file / engine
  // record actually merging) needs a real git worktree + terminal pool, so it's
  // covered by swarmWorkerRegistry.test.ts's injected-deps unit tests. Here we
  // prove the OWNER-reachable validation + the no-workers-yet shape over the
  // real Hono app, mirroring the orchestrator route's own test shape above.
  it('400 when path is missing', async () => {
    const res = await app.request('/api/swarm/workers')
    expect(res.status).toBe(400)
  })

  it('403 when the path is not a registered project (the allowlist holds)', async () => {
    const dir = join(scratch, 'unregistered')
    await mkdir(dir, { recursive: true })
    const res = await app.request(`/api/swarm/workers?path=${encodeURIComponent(dir)}`)
    expect(res.status).toBe(403)
  })

  it('a registered project with no live workers reads back an empty list', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    const res = await app.request(`/api/swarm/workers?path=${encodeURIComponent(dir)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workers: unknown[] }
    expect(body.workers).toEqual([])
  })
})

// The in-app half of the escalation safety valve over the REAL Hono app: prove the
// owner gate AND that persisted fatal notifications round-trip through the route
// (newest-first). HOME-isolated (beforeEach), so it writes only to the throwaway
// home. os:false keeps it off the IPC channel.
describe('GET /api/swarm/notifications — fatal swarm notifications (owner-only)', () => {
  it('403 for a signed-out caller', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/notifications')
    expect(res.status).toBe(403)
  })

  it('403 for a non-owner', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/notifications')
    expect(res.status).toBe(403)
  })

  it('returns the persisted fatal notifications (newest-first) for the owner', async () => {
    // owner is signed in by beforeEach.
    await createSwarmFatalNotification(
      { event: 'all-workers-down', detail: 'zero workers', projectPath: '/p', logHint: 'check log' },
      { os: false, now: 1000 },
    )
    await createSwarmFatalNotification(
      {
        event: 'rework-exhausted',
        detail: 'parked',
        taskId: 'a',
        branch: 'swarm/a',
        logHint: 'blocked col',
      },
      { os: false, now: 2000 },
    )
    const res = await app.request('/api/swarm/notifications')
    expect(res.status).toBe(200)
    const body = (await res.json()) as AppNotificationsResponse
    expect(body.notifications).toHaveLength(2)
    expect(body.notifications[0].kind).toBe('swarm-fatal')
    expect(body.notifications[0].swarmFatal?.event).toBe('rework-exhausted') // newest first
    expect(body.notifications[0].swarmFatal?.logHint).toBe('blocked col') // 導線 round-trips
    expect(body.notifications[1].swarmFatal?.event).toBe('all-workers-down')
  })

  it('returns an empty list when nothing fatal has fired', async () => {
    const res = await app.request('/api/swarm/notifications')
    expect(res.status).toBe(200)
    const body = (await res.json()) as AppNotificationsResponse
    expect(body.notifications).toEqual([])
  })
})

// ── Model-quota control plane ────────────────────────────────────────────────
// The owner's manual steering wheel over swarmQuota's cooling table. It exists
// because the automatic sensor can be wrong or late (2026-07-09: the CLI's
// per-model limit notice went unmatched, so fable never cooled and the engine
// kept dispatching into the dry tier) and a packaged .app cannot be
// source-patched — the operator must be able to avoid a tier WITHOUT stopping
// the engine. Owner-gating is swept for every /api/swarm route in
// swarmSafety.routes.test.ts; here we prove the behaviour.

describe('/api/swarm/quota — the model-tier cooling table', () => {
  beforeEach(() => __resetQuotaForTest())
  afterEach(() => __resetQuotaForTest())

  it('GET reports every ladder tier, none cooling, launching on the top tier', async () => {
    const res = await app.request('/api/swarm/quota')
    expect(res.status).toBe(200)
    const body = (await res.json()) as SwarmQuotaResponse
    expect(body.tiers.map((t) => t.tier)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(body.tiers.every((t) => !t.cooling && t.until === null)).toBe(true)
    expect(body.launchTier).toBe('fable')
    expect(body.allCoolingUntil).toBeNull()
  })

  it('cooling fable by hand drops the next launch to opus, and GET agrees', async () => {
    const res = await app.request('/api/swarm/quota/cool', json({ tier: 'fable', minutes: 30 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as SwarmQuotaResponse
    expect(body.launchTier).toBe('opus')
    const fable = body.tiers.find((t) => t.tier === 'fable')
    expect(fable?.cooling).toBe(true)
    expect(fable?.until).toBeGreaterThan(body.now)
    // The engine reads the SAME table — a later GET sees the mark.
    const after = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
    expect(after.launchTier).toBe('opus')
    expect(after.tiers.find((t) => t.tier === 'opus')?.cooling).toBe(false)
  })

  it('accepts an absolute untilMs as well as minutes', async () => {
    const until = Date.now() + 45 * 60_000
    const res = await app.request('/api/swarm/quota/cool', json({ tier: 'opus', untilMs: until }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as SwarmQuotaResponse
    expect(body.tiers.find((t) => t.tier === 'opus')?.until).toBe(until)
    expect(body.launchTier).toBe('fable') // only opus was cooled
  })

  it('cooling every tier parks the swarm and reports the earliest reset', async () => {
    for (const tier of ['fable', 'opus', 'sonnet', 'haiku']) {
      const minutes = tier === 'sonnet' ? 10 : 60
      expect((await app.request('/api/swarm/quota/cool', json({ tier, minutes }))).status).toBe(200)
    }
    const body = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
    expect(body.launchTier).toBeNull()
    // sonnet frees up first (10 min), so that is when the swarm can resume.
    expect(body.allCoolingUntil).toBeGreaterThan(body.now)
    expect(body.allCoolingUntil! - body.now).toBeLessThan(11 * 60_000)
  })

  it('uncool releases a tier (and is idempotent)', async () => {
    await app.request('/api/swarm/quota/cool', json({ tier: 'fable', minutes: 30 }))
    const res = await app.request('/api/swarm/quota/uncool', json({ tier: 'fable' }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as SwarmQuotaResponse).launchTier).toBe('fable')
    const again = await app.request('/api/swarm/quota/uncool', json({ tier: 'fable' }))
    expect(again.status).toBe(200)
    expect(((await again.json()) as SwarmQuotaResponse).launchTier).toBe('fable')
  })

  it('400 on an alias that is not on the ladder (fail-closed — never cool by guess)', async () => {
    for (const path of ['/api/swarm/quota/cool', '/api/swarm/quota/uncool']) {
      const res = await app.request(path, json({ tier: 'gpt-5', minutes: 30 }))
      expect(res.status).toBe(400)
    }
    // …and the table is untouched.
    const body = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
    expect(body.launchTier).toBe('fable')
  })

  it('400 when neither untilMs nor minutes is given', async () => {
    const res = await app.request('/api/swarm/quota/cool', json({ tier: 'fable' }))
    expect(res.status).toBe(400)
  })

  // The mark has to outlive the PROCESS, not just the request. Before 2026-07-13
  // the table was memory-only, so a relaunch — which is what happens after every
  // release — came up believing every tier was fresh: `cooling:false`,
  // `launchTier:"fable"`, straight back into the wall it hit yesterday. The cost
  // was one session burned per restart, purely to re-learn a known fact.
  //
  // This is the acceptance from the card, driven end-to-end through the routes:
  // cool → restart → still cooling. haiku throughout (cooling fable or opus in a
  // test would model a tier the real launcher actually picks).
  describe('persistence — a cool survives the app restart', () => {
    beforeEach(async () => {
      // Earlier cases in this block cool tiers too, and their marks are now real
      // files. Drain any write still in flight, then start from no file at all,
      // so this case's restart hydrates ONLY what this case wrote.
      // `recursive`: the write-failure cases below make the path a DIRECTORY.
      await flushQuotaPersist()
      await rm(swarmQuotaFile(), { force: true, recursive: true })
    })
    afterEach(async () => {
      await flushQuotaPersist()
      await rm(swarmQuotaFile(), { force: true, recursive: true })
      vi.restoreAllMocks()
    })

    /** Make the mirror write fail the way a real filesystem does: atomicWrite
     *  renames a temp file onto the target, and renaming onto a DIRECTORY is
     *  EISDIR. Stands in for the EACCES / ENOSPC / read-only-volume family. */
    const breakTheFile = () => mkdir(swarmQuotaFile(), { recursive: true })

    it('POST /cool haiku → restart → GET still reports haiku cooling', async () => {
      const res = await app.request('/api/swarm/quota/cool', json({ tier: 'haiku', minutes: 60 }))
      expect(res.status).toBe(200)
      const until = ((await res.json()) as SwarmQuotaResponse).tiers.find((t) => t.tier === 'haiku')
        ?.until
      expect(until).toBeGreaterThan(Date.now())

      // The 200 above already means "on disk" — the route awaits the mirror write
      // before answering. So dropping the whole in-memory table now is exactly
      // what quitting the app does.
      await __simulateRestartForTest()

      const after = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
      const haiku = after.tiers.find((t) => t.tier === 'haiku')
      expect(haiku?.cooling).toBe(true)
      expect(haiku?.until).toBe(until) // the same reset time, not a fresh window
      expect(after.launchTier).toBe('fable') // and only haiku came back
    })

    it('POST /uncool → restart → the tier stays RELEASED (hydration must not undo it)', async () => {
      await app.request('/api/swarm/quota/cool', json({ tier: 'haiku', minutes: 60 }))
      expect(
        (await app.request('/api/swarm/quota/uncool', json({ tier: 'haiku' }))).status,
      ).toBe(200)

      await __simulateRestartForTest()

      const after = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
      expect(after.tiers.find((t) => t.tier === 'haiku')?.cooling).toBe(false)
      expect(after.tiers.every((t) => !t.cooling)).toBe(true)
    })

    // A 200 from /cool asserts durability ("quit now and the mark is still there").
    // If the write failed, the honest answer is 500 — a 200 would put us straight
    // back in the loop this whole card closes: the owner cools a dry tier, the app
    // relaunches having forgotten it, and the next dispatch burns a session
    // rediscovering the wall. The engine's own sensor path still shrugs off a bad
    // write (a mark it can re-learn is not worth killing the cockpit for); this
    // route cannot, because durability IS what it is for.
    it('POST /cool answers 500 — not 200 — when the mark could NOT be persisted', async () => {
      await breakTheFile()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const res = await app.request('/api/swarm/quota/cool', json({ tier: 'haiku', minutes: 60 }))
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toMatch(/forgotten when the app restarts/i)
      expect(warn).toHaveBeenCalled()

      // …and the tier IS cooling in this process. We do not roll the mark back: the
      // running engine should still avoid the tier. Only its survival across a
      // restart was lost, which is exactly what the 500 says.
      const after = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
      expect(after.tiers.find((t) => t.tier === 'haiku')?.cooling).toBe(true)
    })

    it('POST /uncool answers 500 when the RELEASE could not be persisted', async () => {
      // Cool first (that write lands), then break the file so only the release fails.
      expect(
        (await app.request('/api/swarm/quota/cool', json({ tier: 'haiku', minutes: 60 }))).status,
      ).toBe(200)
      await rm(swarmQuotaFile(), { force: true, recursive: true })
      await breakTheFile()
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      const res = await app.request('/api/swarm/quota/uncool', json({ tier: 'haiku' }))
      expect(res.status).toBe(500)
      // The stakes are the opposite of /cool's and the message must say so: the old
      // mark is still on disk, so a restart brings the released tier BACK cooling.
      expect(((await res.json()) as { error: string }).error).toMatch(/COOLING again after a restart/i)
    })

    it('a later successful write heals it — /cool answers 200 again', async () => {
      await breakTheFile()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(
        (await app.request('/api/swarm/quota/cool', json({ tier: 'haiku', minutes: 60 }))).status,
      ).toBe(500)

      await rm(swarmQuotaFile(), { force: true, recursive: true })
      const res = await app.request('/api/swarm/quota/cool', json({ tier: 'haiku', minutes: 90 }))
      expect(res.status).toBe(200)

      // And the durability the 200 now claims is real.
      await __simulateRestartForTest()
      const after = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
      expect(after.tiers.find((t) => t.tier === 'haiku')?.cooling).toBe(true)
    })
  })

  // The owner's model hard mask is a SEPARATE layer. It must not touch the cooling
  // table this endpoint reports, but `launchTier` — the one claim about a LAUNCH —
  // must honor it, or an operator debugging "why is nothing spawning" reads
  // `launchTier: fable` for a tier the engine will never touch.
  describe('with the model hard mask (Settings.swarmAllowedModels)', () => {
    afterEach(() => setSettings({ swarmAllowedModels: undefined }))

    it('launchTier skips a switched-OFF tier; the cooling table is untouched', async () => {
      await setSettings({ swarmAllowedModels: { fable: false } })
      const body = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
      expect(body.launchTier).toBe('opus')
      // fable is DISABLED, not cooling — the table says so verbatim.
      expect(body.tiers.find((t) => t.tier === 'fable')).toEqual({
        tier: 'fable',
        cooling: false,
        until: null,
      })
      expect(body.allCoolingUntil).toBeNull()
    })

    it('every tier OFF ⇒ launchTier null while allCoolingUntil stays null (no reset exists)', async () => {
      await setSettings({
        swarmAllowedModels: { fable: false, opus: false, sonnet: false, haiku: false },
      })
      const body = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
      expect(body.launchTier).toBeNull()
      expect(body.allCoolingUntil).toBeNull() // nothing is COOLING — the mask is not a cool
    })

    it('uncool does not resurrect a disabled tier (the two vetoes stay independent)', async () => {
      await setSettings({ swarmAllowedModels: { fable: false } })
      await app.request('/api/swarm/quota/cool', json({ tier: 'fable', minutes: 30 }))
      const res = await app.request('/api/swarm/quota/uncool', json({ tier: 'fable' }))
      const body = (await res.json()) as SwarmQuotaResponse
      // The cool is gone (cooling semantics unchanged) — but fable stays unusable.
      expect(body.tiers.find((t) => t.tier === 'fable')?.cooling).toBe(false)
      expect(body.launchTier).toBe('opus')
    })
  })

  it('400 on an until in the past, or beyond the 7-day cap', async () => {
    const past = await app.request('/api/swarm/quota/cool', json({ tier: 'fable', minutes: -5 }))
    expect(past.status).toBe(400)
    const far = await app.request(
      '/api/swarm/quota/cool',
      json({ tier: 'fable', untilMs: Date.now() + 8 * 24 * 3_600_000 }),
    )
    expect(far.status).toBe(400)
    // Neither attempt cooled anything.
    const body = (await (await app.request('/api/swarm/quota')).json()) as SwarmQuotaResponse
    expect(body.tiers.every((t) => !t.cooling)).toBe(true)
  })

  it('403 for a non-owner — the control plane is owner-only', async () => {
    await signInAs(TESTER)
    expect((await app.request('/api/swarm/quota')).status).toBe(403)
    expect((await app.request('/api/swarm/quota/cool', json({ tier: 'fable', minutes: 30 }))).status).toBe(403)
    expect((await app.request('/api/swarm/quota/uncool', json({ tier: 'fable' }))).status).toBe(403)
  })
})
