import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { __resetOrchestratorForTests } from '@/lib/server/swarmOrchestrator'
import type { SwarmOrchestratorState } from '@/lib/types'

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

  it('POST /api/swarm/orchestrator/automerge → 403 when signed out', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/orchestrator/automerge', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/orchestrator/automerge → 403 for a tester', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/swarm/orchestrator/automerge', json({}))
    expect(res.status).toBe(403)
  })

  it('POST /api/swarm/orchestrator/automerge → owner passes the gate (reaches validation: 400)', async () => {
    await signInAs(OWNER)
    const res = await app.request('/api/swarm/orchestrator/automerge', json({}))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/swarm/orchestrator/automerge (auto-integrate toggle — owner)', () => {
  // setAutoMerge only flips an in-memory flag + returns state — no claude
  // preflight, no git — so the happy path is fully exercisable here (unlike
  // /start, which spawns workers and is curl-verified on the real machine).
  it('403 when the path is not a registered project (the allowlist holds)', async () => {
    const dir = join(scratch, 'unregistered')
    await mkdir(dir, { recursive: true })
    const res = await app.request('/api/swarm/orchestrator/automerge', json({ path: dir, enabled: true }))
    expect(res.status).toBe(403)
  })

  it('400 when `enabled` is missing or not a boolean', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    expect((await app.request('/api/swarm/orchestrator/automerge', json({ path: dir }))).status).toBe(400)
    expect(
      (await app.request('/api/swarm/orchestrator/automerge', json({ path: dir, enabled: 'yes' }))).status,
    ).toBe(400)
  })

  it('arms (default OFF) then disarms auto-integration, reflected in the state', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    // Default is OFF on a never-armed engine.
    const initial = (await (await app.request(`/api/swarm/orchestrator?path=${encodeURIComponent(dir)}`)).json()) as SwarmOrchestratorState
    expect(initial.autoMerge).toBe(false)

    const on = await app.request('/api/swarm/orchestrator/automerge', json({ path: dir, enabled: true }))
    expect(on.status).toBe(200)
    expect(((await on.json()) as SwarmOrchestratorState).autoMerge).toBe(true)

    const off = await app.request('/api/swarm/orchestrator/automerge', json({ path: dir, enabled: false }))
    expect(((await off.json()) as SwarmOrchestratorState).autoMerge).toBe(false)
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
