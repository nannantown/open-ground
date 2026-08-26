import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// ─── 司令官の卓は「開いた」ことを覚える (2026-08-26) ──────────────────────────
//
// An OPEN GROUND update restarted the app mid-swarm. The engine came back
// (`desiredRunning`), the worker roster reconciled, the supply desk relaunched
// (`supplyDesired`) — and the commander did not, because the commander was the
// ONE desk whose spawn route wrote no intent at all. `managerPresence` stayed
// 'missing' while the orphaned worker ran on and finished, and finished work
// with no commander is work nobody integrates.
//
// This file pins the two halves of the flag on the REAL Hono app, observed
// through the PRODUCTION reader (`readEngineIntent`) rather than through the
// route's own response:
//   • the spawn route SETS it — otherwise boot resume has nothing to act on;
//   • the stop route CLEARS it — otherwise a desk the owner just closed is
//     resurrected on every restart, forever (the trap /api/swarm/supply/stop
//     was built to avoid on its side).
//
// The commander spawn needs a real `claude`, so the two preflights and the
// spawn itself are mocked — everything downstream of them (the owner gate, the
// registry allowlist, the intent write, the disk) is the real thing.

const spawnCalls: string[] = []
vi.mock('@/lib/server/claudePreflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/claudePreflight')>()),
  claudeRunPreflight: async () => ({ ok: true }),
}))
vi.mock('@/lib/server/swarmEnvPreflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/swarmEnvPreflight')>()),
  swarmEnvPreflight: async () => ({ ok: true, issues: [] }),
}))
vi.mock('@/lib/server/swarmManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/swarmManager')>()
  return {
    ...actual,
    spawnSwarmManager: async ({ projectPath }: { projectPath: string }) => {
      spawnCalls.push(projectPath)
      return { terminalId: 't1', runtime: 'pty', agentSessionId: 'a1', resumed: false }
    },
  }
})

import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { __resetOrchestratorForTests } from '@/lib/server/swarmOrchestrator'
import { readEngineIntent, patchEngineIntent } from '@/lib/server/swarmEnginePersistence'

const OWNER = 'owner@example.com'
const TESTER = 'tester@example.com'
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
let dir: string

beforeEach(async () => {
  spawnCalls.length = 0
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-mgr-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-mgr-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  await signInAs(OWNER)
  dir = join(scratch, 'app')
  await mkdir(dir, { recursive: true })
  expect((await app.request('/api/projects/import', json({ path: dir }))).status).toBe(200)
})

afterEach(async () => {
  __resetOrchestratorForTests()
  await clearSession()
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

describe('POST /api/swarm/manager — opening the desk records the intent', () => {
  it('writes managerDesired:true, read back through the production reader', async () => {
    // ⚠ Read from DISK, not from the response. The response says a desk opened;
    // only the file says the NEXT boot will bring it back, and that file is the
    // whole fix.
    expect((await readEngineIntent(dir)).managerDesired).toBeUndefined()
    const res = await app.request('/api/swarm/manager', json({ path: dir }))
    expect(res.status).toBe(200)
    expect(spawnCalls).toEqual([dir])
    expect((await readEngineIntent(dir)).managerDesired).toBe(true)
  })

  it('does not disturb the engine flags it did not state', async () => {
    await patchEngineIntent(dir, { desiredRunning: true, selfSupply: true })
    await app.request('/api/swarm/manager', json({ path: dir }))
    const after = await readEngineIntent(dir)
    expect(after.managerDesired).toBe(true)
    expect(after.desiredRunning).toBe(true)
    expect(after.selfSupply).toBe(true)
  })
})

describe('POST /api/swarm/manager/stop — closing the desk clears the intent', () => {
  it('clears managerDesired so the next boot does NOT resurrect a closed desk', async () => {
    await app.request('/api/swarm/manager', json({ path: dir }))
    expect((await readEngineIntent(dir)).managerDesired).toBe(true)
    const res = await app.request('/api/swarm/manager/stop', json({ path: dir }))
    expect(res.status).toBe(200)
    expect((await readEngineIntent(dir)).managerDesired).toBeUndefined()
  })

  it('leaves autonomy alone — closing the desk is not pausing the engine', async () => {
    await patchEngineIntent(dir, { desiredRunning: true, selfSupply: false })
    await app.request('/api/swarm/manager', json({ path: dir }))
    await app.request('/api/swarm/manager/stop', json({ path: dir }))
    const after = await readEngineIntent(dir)
    expect(after.managerDesired).toBeUndefined()
    expect(after.desiredRunning).toBe(true)
  })

  it('400 when path is missing', async () => {
    expect((await app.request('/api/swarm/manager/stop', json({}))).status).toBe(400)
  })

  it('403 when the path is not a registered project (the allowlist holds)', async () => {
    const other = join(scratch, 'unregistered')
    await mkdir(other, { recursive: true })
    expect((await app.request('/api/swarm/manager/stop', json({ path: other }))).status).toBe(403)
  })

  it('403 when signed out, and for a signed-in non-owner', async () => {
    await clearSession()
    expect((await app.request('/api/swarm/manager/stop', json({ path: dir }))).status).toBe(403)
    await signInAs(TESTER)
    expect((await app.request('/api/swarm/manager/stop', json({ path: dir }))).status).toBe(403)
  })
})
