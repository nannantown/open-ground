import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// ─── GET /api/swarm/standing — one answer to "is it held and why" (R-E1) ────
//
// The route is a thin adapter over standingOf (swarmStanding.ts). Pinned on the
// REAL Hono app: each engine fixture — the engine's own in-memory fields, set the
// way the engine sets them — yields the expected state and a plain sentence in
// the owner's language (Settings.language, read back through the production
// reader), in Japanese and in English. Plus the owner gate and the allowlist.

import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { __resetOrchestratorForTests, emptyMetricsCounters, type ProjectEngine } from '@/lib/server/swarmOrchestrator'
import { STANDING_STALL_MS } from '@/lib/server/swarmStanding'
import { initOverseerRuntime } from '@/lib/server/swarmOverseer'
import { mutateProjectData } from '@/lib/server/projectData'
import { getSettings, rememberSwarmManualStop } from '@/lib/server/store'
import type { ProjectStanding, ProjectTask } from '@/lib/types'

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

const post = (url: string, body: unknown) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const todo = { id: 'c1', title: 'card', notes: 'completion conditions', done: false, boardColumn: 'todo' } as unknown as ProjectTask

/** Put an engine literal into the orchestrator's store — the same object the
 *  engine keeps for a running project. */
const seatEngine = (path: string, over: Partial<ProjectEngine>) => {
  const engine = {
    path,
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
  } as ProjectEngine
  globalThis.__openground_swarm_orchestrator!.engines.set(path, engine)
}

let home: string
let scratch: string
let dir: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-standing-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-standing-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  __resetOrchestratorForTests()
  await signInAs(OWNER)
  dir = join(scratch, 'app')
  await mkdir(dir, { recursive: true })
  expect((await post('/api/projects/import', { path: dir })).status).toBe(200)
})

afterEach(async () => {
  __resetOrchestratorForTests()
  await clearSession()
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const standing = async (): Promise<ProjectStanding> => {
  const res = await app.request(`/api/swarm/standing?path=${encodeURIComponent(dir)}`)
  expect(res.status).toBe(200)
  return (await res.json()) as ProjectStanding
}

const FIXTURES: Array<{ name: string; arrange: () => Promise<void>; state: ProjectStanding['state']; kind?: string }> = [
  {
    name: 'stopped by hand, no engine in memory',
    arrange: () => rememberSwarmManualStop(dir),
    state: 'off',
    kind: 'manual-stop',
  },
  {
    name: 'every tier cooling, a card waiting',
    arrange: async () => {
      await mutateProjectData(dir, (d) => void (d.tasks = [todo]))
      seatEngine(dir, { parkUntil: Date.now() + 60 * 60_000, spawnBlockSig: 'cooling:1' })
    },
    state: 'waiting',
    kind: 'usage-limit',
  },
  {
    name: 'an unconfirmed operation holds the project',
    arrange: async () => seatEngine(dir, { savedWorkHold: { since: Date.now(), count: 1 } }),
    state: 'needs-owner',
    kind: 'owner-question',
  },
  {
    name: 'a card needed for 16 minutes, nothing held, nothing moving',
    arrange: async () => {
      await mutateProjectData(dir, (d) => void (d.tasks = [todo]))
      seatEngine(dir, { standingWatch: { sig: 'c1:todo', quietSince: Date.now() - STANDING_STALL_MS - 60_000 } })
    },
    state: 'waiting',
    kind: 'unexplained',
  },
  {
    name: 'the autopilot on with nothing to do',
    arrange: async () => seatEngine(dir, {}),
    state: 'idle',
  },
]

describe('GET /api/swarm/standing — each engine fixture, both languages', () => {
  for (const lang of ['ja', 'en'] as const) {
    it.each(FIXTURES)(`${lang}: $name ⇒ $state`, async ({ arrange, state, kind }) => {
      expect((await post('/api/settings', { language: lang })).status).toBe(200)
      expect((await getSettings()).language).toBe(lang) // read back through the production reader
      await arrange()
      const s = await standing()
      expect(s.state).toBe(state)
      if (kind === undefined) {
        expect(s.reasons).toEqual([])
        return
      }
      const r = s.reasons.find((x) => x.kind === kind)
      expect(r, JSON.stringify(s.reasons)).toBeDefined()
      expect(r!.plain.length).toBeGreaterThan(0)
      expect(/[぀-ヿ一-鿿]/.test(r!.plain), r!.plain).toBe(lang === 'ja')
    })
  }

  it('counts the work waiting to be served', async () => {
    await mutateProjectData(dir, (d) => void (d.tasks = [todo, { ...todo, id: 'r1', title: 'another card', notes: 'other conditions', boardColumn: 'review', branch: 'swarm/r1' } as ProjectTask]))
    seatEngine(dir, {})
    expect((await standing()).needs).toEqual({ dispatch: 1, integrate: 1 })
  })
})

describe('GET /api/swarm/standing — gate and allowlist', () => {
  it('400 without a path', async () => {
    expect((await app.request('/api/swarm/standing')).status).toBe(400)
  })

  it('403 for a folder that is not a registered project', async () => {
    const other = join(scratch, 'unregistered')
    await mkdir(other, { recursive: true })
    expect((await app.request(`/api/swarm/standing?path=${encodeURIComponent(other)}`)).status).toBe(403)
  })

  it('403 when signed out, and for a signed-in non-owner', async () => {
    await clearSession()
    expect((await app.request(`/api/swarm/standing?path=${encodeURIComponent(dir)}`)).status).toBe(403)
    await signInAs(TESTER)
    expect((await app.request(`/api/swarm/standing?path=${encodeURIComponent(dir)}`)).status).toBe(403)
  })
})
