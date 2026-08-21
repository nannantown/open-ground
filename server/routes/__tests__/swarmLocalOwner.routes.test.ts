import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { clearSession } from '@/lib/server/authStore'
import { getSettings, setSettings } from '@/lib/server/store'
import { addProjectEntry, __resetMigrationCacheForTests } from '@/lib/server/registry'
import { __resetOrchestratorForTests } from '@/lib/server/swarmOrchestrator'
import type { ExperimentsResponse } from '@/lib/types'

// ─────────────────────────────────────────────────────────────────────────────
// SWARM LOCAL OWNER UNLOCK — the login-free gate (swarmGate.ts).
//
// A machine that runs login-disabled (業務モード) can still drive the swarm by
// unlocking it with SERVER-LOCAL state: env OPENGROUND_LOCAL_OWNER=1 or a
// hand-edited settings.json `swarmLocalOwner: true`. These tests pin, with NO
// session and NO Supabase env at all:
//   1. every /api/swarm route passes the gate under either unlock source
//      (sweep — the mirror image of swarmSafety.routes.test.ts INVARIANT C,
//      which pins the locked default),
//   2. GET /api/experiments mirrors the unlock to the client (flags.swarm) so
//      the Swarm tab appears — without widening `eligible` or `sandbox`,
//   3. the unlock is SWARM-SCOPED: marketplace / custom-tab routes still 403,
//   4. the unlock can NEVER be set through a request: POST /api/settings drops
//      the key (it is not in USER_SETTINGS_KEYS), and swarm stays 403 after,
//   5. escalations actually read/write end-to-end while signed out + unlocked.
//
// HOME ISOLATION: OPENGROUND_HOME is pinned to a throwaway tmp dir per test.
// ─────────────────────────────────────────────────────────────────────────────

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
// Every identity/unlock input is cleared so the ONLY thing opening the gate in
// these tests is the unlock under test — including the Supabase client env
// ("no Supabase env at all" is part of the claim).
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
    '$method $path → passes the gate SIGNED OUT (reaches validation, not 403)',
    async ({ method, path }) => {
      process.env.OPENGROUND_LOCAL_OWNER = '1'
      const res = await fire(method, path)
      expect(res.status).not.toBe(403)
    },
  )

  it('GET /api/experiments mirrors the unlock: flags.swarm true, every other flag untouched', async () => {
    process.env.OPENGROUND_LOCAL_OWNER = '1'
    const res = await app.request('/api/experiments')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ExperimentsResponse
    // Exhaustive on purpose: the unlock is a SWARM control-plane convenience,
    // so any other experiment resolving open here — persona, which reads the
    // owner's personal corpus, most of all — is a leak this must catch.
    expect(body).toEqual({
      eligible: false,
      flags: { swarm: true, sandbox: false, persona: false },
      // The public opt-in block: unavailable on this (non-macOS) test host and
      // off — the LOCAL unlock is a separate path and must not report itself as
      // the user opt-in.
      swarmOptIn: { available: false, enabled: false },
      // Persona is its own beta (2026-08-20): the swarm unlock never touches it,
      // and its opt-in — available on every platform — is off here.
      personaOptIn: { available: true, enabled: false },
    })
  })

  it('the unlock is SWARM-SCOPED: marketplace/custom-tab routes still 403 signed out', async () => {
    process.env.OPENGROUND_LOCAL_OWNER = '1'
    // Role-'none'-forbidden route (tester or owner may pass — signed out may not).
    expect((await app.request('/api/custom-modules', json({}))).status).toBe(403)
    // Owner-only marketplace publish (writes to Supabase when signed in).
    expect((await app.request('/api/custom-modules/some-id/publish', json({}))).status).toBe(403)
  })
})

describe('swarm local owner unlock — hand-edited settings.json swarmLocalOwner', () => {
  it.each(swarmRoutes)(
    '$method $path → passes the gate SIGNED OUT (reaches validation, not 403)',
    async ({ method, path }) => {
      // setSettings is the TRUSTED internal merge — stands in for the user
      // editing ~/.openground/settings.json by hand.
      await setSettings({ swarmLocalOwner: true })
      const res = await fire(method, path)
      expect(res.status).not.toBe(403)
    },
  )

  it('GET /api/experiments mirrors the unlock (Swarm tab appears)', async () => {
    await setSettings({ swarmLocalOwner: true })
    const body = (await (await app.request('/api/experiments')).json()) as ExperimentsResponse
    expect(body.flags.swarm).toBe(true)
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

describe('escalations read/write end-to-end — signed out + unlocked, no Supabase env', () => {
  it('open → list → answer all work against a registered project', async () => {
    process.env.OPENGROUND_LOCAL_OWNER = '1'
    const projectDir = await realpath(await mkdtemp(join(tmpdir(), 'og-local-owner-proj-')))
    try {
      await addProjectEntry(projectDir)

      const open = await app.request(
        '/api/swarm/escalations/open',
        json({
          path: projectDir,
          question: 'may I delete the legacy config?',
          context: 'worker hit an irreversible cleanup step',
          whyEscalated: 'irreversible',
        }),
      )
      expect(open.status).toBe(200)
      const opened = (await open.json()) as { escalation: { id: string; status: string } }
      expect(opened.escalation.status).toBe('open')

      const list = await app.request(
        `/api/swarm/escalations?path=${encodeURIComponent(projectDir)}&status=open`,
      )
      expect(list.status).toBe(200)
      const listed = (await list.json()) as { escalations: Array<{ id: string }> }
      expect(listed.escalations.map((e) => e.id)).toContain(opened.escalation.id)

      const answer = await app.request(
        '/api/swarm/escalations/answer',
        json({ id: opened.escalation.id, answer: 'yes — delete it' }),
      )
      expect(answer.status).toBe(200)
      const answered = (await answer.json()) as { escalation: { status: string } }
      // No live PTY / queued dispatch in this fixture — delivery may be pending,
      // but the decision is durably recorded past 'open'.
      expect(answered.escalation.status).not.toBe('open')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})
