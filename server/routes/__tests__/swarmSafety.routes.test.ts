import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { __resetOrchestratorForTests } from '@/lib/server/swarmOrchestrator'

// ─────────────────────────────────────────────────────────────────────────────
// SWARM SAFETY NET — INVARIANT C: every /api/swarm route is OWNER-GATED.
//
// The in-app swarm control plane spawns `claude` PTYs and mutates git worktrees,
// so EVERY /api/swarm route must reject a signed-out OR non-owner (tester) caller
// with 403 BEFORE any body parse / path validation / preflight / git — the UI
// hiding the tab is not the only guard (a local curl / SDK call would otherwise
// drive the swarm). This is the in-app counterpart of test-swarm-safety.sh §13's
// owner-scoped PreToolUse gate.
//
// The sweep is driven off the LIVE Hono route table (app.routes), so it covers
// every swarm route automatically — including a future one whose author forgets
// the gate (it would return non-403 when signed out → this test goes red). A
// NEGATIVE CONTROL builds an un-gated swarm route and shows it returns non-403,
// proving the sweep's `expect(403)` genuinely distinguishes gated from un-gated.
//
// (Invariants A / B / D — the git + teardown guards — live in
// src/lib/server/swarmSafety.test.ts. Full list: docs/SWARM_SAFETY_INVARIANTS.md.)
//
// HOME ISOLATION: OPENGROUND_HOME is pinned to a throwaway tmp dir per test, so
// the registry/session this exercises never touch the real ~/.openground.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = 'owner@example.com'
const TESTER = 'tester@example.com'

// Roles ship with NO built-in emails; the override (set per-test in beforeEach,
// and restored in afterEach) grants them so these route tests stay network-free
// (it skips the og_roles lookup). Set in beforeEach — never at module top — so the
// vars can't leak into a sibling test file under a non-default (isolate:false) pool.

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

/** Fire ONE swarm route with a minimal request (empty body for POST). The owner
 *  gate runs first, so a gated route 403s a non-owner regardless of body shape. */
const fire = async (method: string, path: string): Promise<Response> =>
  method === 'GET' ? await app.request(path) : await app.request(path, json({}))

// ── Discover EVERY /api/swarm route from the live Hono route table ─────────────
// Deduped by `${method} ${path}`; ALL-method middleware entries are dropped (the
// gate is on the concrete GET/POST handlers). If this ever comes back empty the
// sanity test below fails loudly rather than letting an empty sweep pass.
const swarmRoutes: { method: string; path: string }[] = (() => {
  const seen = new Set<string>()
  const out: { method: string; path: string }[] = []
  for (const r of app.routes) {
    if (!r.path.startsWith('/api/swarm')) continue
    if (r.method !== 'GET' && r.method !== 'POST') continue
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ method: r.method, path: r.path })
  }
  return out
})()

let home: string
// OPENGROUND_LOCAL_OWNER is cleared (never set) here: this suite pins the
// LOCKED default of the swarm gate (swarmGate.ts), so a developer machine with
// the login-free unlock exported must not turn the 403 sweep green-by-accident.
const ENV_KEYS = [
  'OPENGROUND_HOME',
  'OPENGROUND_OWNER_EMAILS',
  'OPENGROUND_TESTER_EMAILS',
  'OPENGROUND_LOCAL_OWNER',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-swarm-safety-routes-')))
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.OPENGROUND_HOME = home
  process.env.OPENGROUND_OWNER_EMAILS = OWNER
  process.env.OPENGROUND_TESTER_EMAILS = TESTER
  delete process.env.OPENGROUND_LOCAL_OWNER
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  __resetOrchestratorForTests()
  await clearSession()
  // Restore every env var to its pre-test value so this file leaks nothing —
  // EXCEPT the home vars, which are never unset. A dangling OPENGROUND_HOME
  // pointing at a deleted temp dir is inert; an UNSET one points at the user's
  // real data (paths.ts openGroundHome), which is the strictly worse leak.
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    // NEVER unset the home vars: empty means the user's REAL ~/.openground
    // (paths.ts openGroundHome), and vitest reuses workers across files.
    else if (!['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
  }
  await rm(home, { recursive: true, force: true })
})

describe('INVARIANT C — every /api/swarm route is owner-gated', () => {
  it('the route table actually contains the swarm control plane (the sweep is non-empty)', () => {
    // A guard against a silently-empty it.each (which would make the sweep below a
    // no-op): the control plane has 12 routes today (worker / supply / manager /
    // worktree-remove + 8 orchestrator routes — the 6 base + selfsupply arm/approve,
    // card b3fbbfba). Keep this ≤ the real count.
    expect(swarmRoutes.length).toBeGreaterThanOrEqual(12)
  })

  it('every swarm route is GET or POST (a future DELETE/PUT/PATCH route would dodge the sweep)', () => {
    // The discovery only fires GET/POST. If a swarm route ever uses another method
    // it would be SILENTLY skipped by the method filter — so fail loudly here,
    // forcing whoever adds it to extend `fire()` + the filter so the gate sweep
    // keeps covering EVERY route. ('ALL' is Hono mount/middleware bookkeeping.)
    const methods = new Set(
      app.routes.filter((r) => r.path.startsWith('/api/swarm')).map((r) => r.method),
    )
    methods.delete('ALL')
    expect(Array.from(methods).sort()).toEqual(['GET', 'POST'])
  })

  it.each(swarmRoutes)('$method $path → 403 when SIGNED OUT (before any body/path/git)', async ({ method, path }) => {
    await clearSession()
    const res = await fire(method, path)
    expect(res.status).toBe(403)
  })

  it.each(swarmRoutes)('$method $path → 403 for a signed-in NON-OWNER (tester)', async ({ method, path }) => {
    await signInAs(TESTER)
    const res = await fire(method, path)
    expect(res.status).toBe(403)
  })

  it.each(swarmRoutes)('$method $path → OWNER passes the gate (NOT 403 — reaches validation)', async ({ method, path }) => {
    // The same minimal request that 403s a non-owner reaches the path/body
    // validation (400) for the owner — proving the 403s above were the GATE, not a
    // blanket failure, and that the gate doesn't accidentally lock the owner out.
    await signInAs(OWNER)
    const res = await fire(method, path)
    expect(res.status).not.toBe(403)
  })

  it.each(swarmRoutes.filter((r) => r.method === 'POST'))(
    '$method $path → 403 for a MALFORMED body when signed out (the gate runs BEFORE body parse)',
    async ({ path }) => {
      await clearSession()
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ this is not valid json',
      })
      // The owner gate runs before `c.req.json()`, so a signed-out caller gets 403
      // — NOT the 400 'invalid body' a parse-FIRST handler would return. This
      // substantiates the "before any body parse" ordering claim in
      // docs/SWARM_SAFETY_INVARIANTS.md (a gate-after-parse regression → 400 → red).
      expect(res.status).toBe(403)
    },
  )

  it('NEGATIVE CONTROL: an UN-gated swarm route returns non-403 when signed out (what the sweep forbids)', async () => {
    await clearSession()
    // A swarm-shaped route that OMITS the owner gate — the regression the sweep
    // exists to catch. Built standalone so it can't affect the real app.
    const ungated = new Hono().post('/api/swarm/__ungated_probe__', async (c) => {
      // (no `getCustomTabRole() !== 'owner'` gate here — that is the bug)
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'invalid body' }, 400)
      }
      const path = typeof (body as { path?: unknown })?.path === 'string' ? (body as { path: string }).path : ''
      if (!path) return c.json({ error: 'path is required' }, 400)
      return c.json({ ok: true })
    })

    const res = await ungated.request('/api/swarm/__ungated_probe__', json({}))
    // A signed-out caller is NOT blocked — it falls straight through to validation
    // (400). Had this route shipped in the real app, the SIGNED-OUT sweep above
    // (which asserts 403 for every swarm route) would have flipped red on it.
    expect(res.status).not.toBe(403)
    expect(res.status).toBe(400)
  })
})
