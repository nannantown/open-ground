// WAKING AN ABSENT COMMANDER — `POST /api/swarm/manager/say` (owner decision
// 2026-09-22 「いいよ。おこして。」).
//
// WHAT IS BEING PINNED, and why it needs a guard at all. This route used to
// answer 404 when no commander desk was up, on the stated grounds that a model
// launch is too expensive to spend on a relayed sentence. The owner reversed
// that, because the commander is woken by the engine only when cards are ready
// to integrate — so for most of the day it is simply absent, and with the reply
// leg now in place 「司令官がいません」 would be the answer to nearly every
// question they ask from a phone.
//
// That reversal is EXACTLY the kind of decision a later reader undoes as a
// "safety tightening" (the old comment argued for it persuasively). So the
// guard asserts the spawn is ATTEMPTED, not merely that the route returns 200 —
// a 200 is what the old 404-only code would give once a desk happened to exist.
//
// Everything expensive is mocked at the module boundary: no `claude` is
// launched, no PTY is opened, no git is run.
//
// RED MEASURED (2026-09-22), each reverted after:
//   • the whole `if (!desk && body?.wake !== false)` block removed  → the wake
//     tests fail (404, spawns 0) — i.e. the pre-decision behaviour is caught.
//   • `body?.wake !== false` changed to `body?.wake === true`       → the
//     default-on test fails (a desk is never woken unless asked).
//   • the `woke: true` field dropped from the response              → the
//     "the desk is told it was woken" test fails.
//   • the two preflights moved AFTER the spawn                      → the
//     preflight test fails (a spawn is attempted with no CLI).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const spawns: string[] = []
const said: string[] = []
/** Desks the mocked pool reports. Mutated per test — an empty list is the
 *  "commander absent" case this file is about. */
let desks: { runtime: 'sdk'; handleId: string; stopping?: boolean }[] = []
let cliOk = true

vi.mock('@/lib/server/swarmManager', () => ({
  spawnSwarmManager: async ({ projectPath }: { projectPath: string }) => {
    spawns.push(projectPath)
    // A real spawn makes the desk appear in the pool; the route re-reads it.
    desks = [{ runtime: 'sdk', handleId: 'sdk-manager-1' }]
    return { sdkSessionId: 'sdk-manager-1', runtime: 'sdk' }
  },
  MANAGER_DESK_LABEL: '司令官',
}))

vi.mock('@/lib/server/swarmManagerRuntime', async (orig) => {
  const actual = await orig<typeof import('@/lib/server/swarmManagerRuntime')>()
  return {
    ...actual,
    listManagerDesks: () => desks,
    sayToManagerDesk: (h: unknown, text: string) => {
      said.push(text)
      return { ok: true }
    },
    stopManagerDesks: () => 0,
  }
})

vi.mock('@/lib/server/claudePreflight', () => ({
  claudeRunPreflight: async () =>
    cliOk ? { ok: true } : { ok: false, body: { error: 'claude にサインインしてください' } },
}))

vi.mock('@/lib/server/swarmEnvPreflight', () => ({
  swarmEnvPreflight: async () => ({ ok: true, issues: [] }),
}))

import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests, addProjectEntry } from '@/lib/server/registry'

const OWNER = 'owner@example.com'
const ENV_KEYS = ['OPENGROUND_HOME', 'OPENGROUND_OWNER_EMAILS', 'OPENGROUND_LOCAL_OWNER'] as const
let savedEnv: Record<string, string | undefined> = {}
let home: string
let project: string

const relay = (body: unknown) =>
  app.request('/api/swarm/manager/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-mgr-say-')))
  project = await realpath(await mkdtemp(join(tmpdir(), 'og-mgr-say-proj-')))
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.OPENGROUND_HOME = home
  process.env.OPENGROUND_OWNER_EMAILS = OWNER
  delete process.env.OPENGROUND_LOCAL_OWNER
  __resetMigrationCacheForTests()
  await addProjectEntry(project)
  spawns.length = 0
  said.length = 0
  desks = []
  cliOk = true
  await writeSession({
    user: { id: 'test-user', email: OWNER, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'a',
    refreshToken: 'r',
  })
})

afterEach(async () => {
  await clearSession()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    // NEVER unset a home var — empty resolves at the REAL ~/.openground (the
    // 2026-07-18 data loss). This exact spelling is the one the repo fence
    // sanctions (src/testHomeEnvGuard.test.ts); `k !== 'OPENGROUND_HOME'` is
    // not, and was measured red there — it leaves HOME reachable.
    else if (!['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
  }
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('POST /api/swarm/manager/say — an absent commander is woken', () => {
  it('wakes one BY DEFAULT and delivers the sentence to it', async () => {
    const res = await relay({ path: project, text: 'swarm/x を入れて大丈夫か教えて' })
    expect(res.status).toBe(200)
    expect(spawns).toEqual([project])
    expect(said).toEqual(['swarm/x を入れて大丈夫か教えて'])
    expect(await res.json()).toMatchObject({ delivered: true, woke: true })
  })

  it('tells the desk it WOKE one, so the owner is not promised a fast answer', async () => {
    const body = await (await relay({ path: project, text: '状況を教えて' })).json()
    expect(body.woke).toBe(true)
  })

  it('does NOT wake or claim to when a commander was already there', async () => {
    desks = [{ runtime: 'sdk', handleId: 'sdk-manager-existing' }]
    const body = await (await relay({ path: project, text: 'これ入れて' })).json()
    expect(spawns).toEqual([])
    expect(body.woke).toBeUndefined()
    expect(body.delivered).toBe(true)
  })

  it('honours wake:false — the caller who does not want to spend a launch', async () => {
    const res = await relay({ path: project, text: '急ぎではない', wake: false })
    expect(res.status).toBe(404)
    expect(spawns).toEqual([])
    expect(said).toEqual([])
  })

  it('refuses BEFORE spawning when the CLI cannot run, and says why', async () => {
    cliOk = false
    const res = await relay({ path: project, text: '聞きたいことがある' })
    expect(res.status).toBe(503)
    expect(spawns).toEqual([]) // never half-start a desk
    expect(await res.json()).toMatchObject({ delivered: false, woke: false })
    expect(JSON.stringify(await (await relay({ path: project, text: 'x' })).json())).toContain('サインイン')
  })

  it('never wakes a desk for a caller that is not the owner', async () => {
    await clearSession()
    const res = await relay({ path: project, text: '通ってはいけない' })
    expect(res.status).toBe(403)
    expect(spawns).toEqual([])
  })

  it('never wakes a desk for a path outside the registry', async () => {
    const res = await relay({ path: '/etc', text: 'どこかへ' })
    expect(res.status).toBe(403)
    expect(spawns).toEqual([])
  })

  it('does not treat a STOPPING desk as present — it wakes a fresh one', async () => {
    desks = [{ runtime: 'sdk', handleId: 'sdk-manager-dying', stopping: true }]
    const body = await (await relay({ path: project, text: 'まだ聞ける?' })).json()
    expect(spawns).toEqual([project])
    expect(body).toMatchObject({ delivered: true, woke: true })
  })
})
