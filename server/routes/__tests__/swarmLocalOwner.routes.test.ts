import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { clearSession } from '@/lib/server/authStore'
import { getSettings, setSettings } from '@/lib/server/store'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { __resetOrchestratorForTests } from '@/lib/server/swarmOrchestrator'
import type { ExperimentsResponse } from '@/lib/types'

// Free local unlock flags are retained as data but grant no paid access.
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const fire = async (method: string, path: string): Promise<Response> =>
  method === 'GET' ? await app.request(path) : await app.request(path, json({}))

// Same live-route-table discovery as the INVARIANT C sweep, so a future swarm
// route is covered here automatically too.
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
// Clear identity and entitlement inputs so legacy local flags cannot grant Pro.
const ENV_KEYS = [
  'OPENGROUND_HOME',
  'OPENGROUND_LOCAL_OWNER',
  'OPENGROUND_OWNER_EMAILS',
  'OPENGROUND_TESTER_EMAILS',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-swarm-local-owner-')))
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  // Skip the home vars: unset means the user's REAL ~/.openground (paths.ts
  // openGroundHome), so never leave even a momentary gap before the line below.
  for (const k of ENV_KEYS) if (!['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  await clearSession()
})
afterEach(async () => {
  __resetOrchestratorForTests()
  await clearSession()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    // NEVER unset the home vars: empty means the user's REAL ~/.openground
    // (paths.ts openGroundHome), and vitest reuses workers across files.
    else if (!['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
  }
  await rm(home, { recursive: true, force: true })
})

describe('swarm local owner unlock — env OPENGROUND_LOCAL_OWNER=1', () => {
  it('the sweep has routes to sweep', () => {
    expect(swarmRoutes.length).toBeGreaterThanOrEqual(12)
  })

  it.each(swarmRoutes)(
    '$method $path → Free remains denied despite local unlock',
    async ({ method, path }) => {
      process.env.OPENGROUND_LOCAL_OWNER = '1'
      const res = await fire(method, path)
      const safety = ['/api/swarm/supply/stop','/api/swarm/manager/stop','/api/swarm/orchestrator/stop','/api/swarm/orchestrator/worker/stop','/api/swarm/orchestrator','/api/swarm/workers','/api/swarm/quota'].includes(path)
      if (!safety) expect(res.status).toBe(403)
      else expect(res.status).not.toBe(403)
    },
  )

  it('GET /api/experiments keeps Free flags false despite the unlock', async () => {
    process.env.OPENGROUND_LOCAL_OWNER = '1'
    const res = await app.request('/api/experiments')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ExperimentsResponse
    expect(body).toEqual({
      eligible: false,
      flags: { swarm: false, sandbox: false },
      swarmOptIn: { available: false, enabled: false },
    })
  })

  it('the unlock is SWARM-SCOPED: custom-tab creation still 403 signed out', async () => {
    process.env.OPENGROUND_LOCAL_OWNER = '1'
    // Custom modules require the actual Owner role.
    expect((await app.request('/api/custom-modules', json({}))).status).toBe(403)
  })
})

describe('swarm local owner unlock — hand-edited settings.json swarmLocalOwner', () => {
  it.each(swarmRoutes)(
    '$method $path → Free remains denied despite local unlock',
    async ({ method, path }) => {
      // setSettings is the TRUSTED internal merge — stands in for the user
      // editing ~/.openground/settings.json by hand.
      await setSettings({ swarmLocalOwner: true })
      const res = await fire(method, path)
      const safety = ['/api/swarm/supply/stop','/api/swarm/manager/stop','/api/swarm/orchestrator/stop','/api/swarm/orchestrator/worker/stop','/api/swarm/orchestrator','/api/swarm/workers','/api/swarm/quota'].includes(path)
      if (!safety) expect(res.status).toBe(403)
      else expect(res.status).not.toBe(403)
    },
  )

  it('GET /api/experiments keeps the Swarm tab hidden for Free', async () => {
    await setSettings({ swarmLocalOwner: true })
    const body = (await (await app.request('/api/experiments')).json()) as ExperimentsResponse
    expect(body.flags.swarm).toBe(false)
    expect(body.eligible).toBe(false)
  })
})

describe('the unlock can NEVER come from a request', () => {
  it('POST /api/settings drops swarmLocalOwner (not in USER_SETTINGS_KEYS) — swarm stays 403', async () => {
    const res = await app.request('/api/settings', json({ swarmLocalOwner: true, language: 'ja' }))
    expect(res.status).toBe(200)
    // The allowlisted sibling key was applied; the unlock key was NOT persisted.
    const settings = await getSettings()
    expect(settings.language).toBe('ja')
    expect(settings.swarmLocalOwner).toBeUndefined()
    // And the gate is still shut for this signed-out caller.
    expect((await app.request('/api/swarm/workers?path=/tmp')).status).toBe(403)
    expect((await app.request('/api/swarm/worker', json({}))).status).toBe(403)
  })
})

it('local unlock cannot start an escalation as Free', async () => {
  process.env.OPENGROUND_LOCAL_OWNER = '1'
  expect((await app.request('/api/swarm/escalations/open', json({}))).status).toBe(403)
})
