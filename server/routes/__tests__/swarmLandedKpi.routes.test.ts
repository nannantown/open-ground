import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import {
  recordPromoted,
  sweepLanded,
  utcWeekStart,
} from '@/lib/server/swarmLandedLedger'
import type { SwarmLandedKpi } from '@/lib/types'

// GET /api/swarm/kpi/landed against the real Hono app: the owner gate, the
// registry-wide aggregation, the self/external split, and the weeks clamp.
// Ledgers are written with the PRODUCTION writers (recordPromoted/sweepLanded)
// and read back through the real route — never hand-built JSON — so this test
// breaks when either side of the contract drifts (検証の掟 2).

const OWNER = 'owner@example.com'
process.env.OPENGROUND_OWNER_EMAILS = OWNER

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
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-landedkpi-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-landedkpi-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  await signInAs(OWNER)
})

afterEach(async () => {
  await clearSession()
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const register = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
}

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString()
const DAY = 24 * 60 * 60 * 1000

describe('GET /api/swarm/kpi/landed', () => {
  it('403 when signed out (owner gate before any work)', async () => {
    await clearSession()
    const res = await app.request('/api/swarm/kpi/landed')
    expect(res.status).toBe(403)
  })

  it('aggregates ledgers registry-wide, splits self vs external, clamps weeks', async () => {
    // SELF: a checkout of OG itself (package.json name matches the built-from
    // name). EXTERNAL: any other package.
    const selfDir = join(scratch, 'og-clone')
    const extDir = join(scratch, 'someapp')
    await mkdir(selfDir, { recursive: true })
    await mkdir(extDir, { recursive: true })
    await writeFile(join(selfDir, 'package.json'), JSON.stringify({ name: 'openground' }))
    await writeFile(join(extDir, 'package.json'), JSON.stringify({ name: 'someapp' }))
    await register(selfDir)
    await register(extDir)

    // Production writers: promote, then land — one self land this week, two
    // external lands (this week + ~3 weeks ago).
    await recordPromoted(selfDir, { taskId: 's1', title: 'self work' }, iso(2 * DAY))
    await sweepLanded(selfDir, [{ id: 's1', done: true, boardColumn: 'done' }], iso(DAY))
    await recordPromoted(extDir, { taskId: 'e1', title: 'ext now' }, iso(2 * DAY))
    await sweepLanded(extDir, [{ id: 'e1', done: true, boardColumn: 'done' }], iso(DAY))
    await recordPromoted(extDir, { taskId: 'e2', title: 'ext old' }, iso(22 * DAY))
    await sweepLanded(extDir, [{ id: 'e2', done: true, boardColumn: 'done' }], iso(21 * DAY))
    // A promoted-but-not-landed card must count nowhere.
    await recordPromoted(extDir, { taskId: 'e3', title: 'in flight' }, iso(DAY))

    const res = await app.request('/api/swarm/kpi/landed')
    expect(res.status).toBe(200)
    const body = (await res.json()) as SwarmLandedKpi

    expect(body.totals).toEqual({ self: 1, external: 2 })
    expect(body.weeks).toHaveLength(12)
    // Sum across buckets equals the landed totals (nothing dropped, nothing doubled).
    expect(body.weeks.reduce((n, w) => n + w.self, 0)).toBe(1)
    expect(body.weeks.reduce((n, w) => n + w.external, 0)).toBe(2)
    // The lands sit in the RIGHT buckets (paired via the same week fold the
    // module uses — unit-proven in swarmLandedLedger.test.ts).
    const thisWeek = body.weeks.find((w) => w.weekStart === utcWeekStart(Date.now() - DAY))
    expect(thisWeek?.self).toBe(1)
    expect(thisWeek?.external).toBe(1)
    const oldWeek = body.weeks.find((w) => w.weekStart === utcWeekStart(Date.now() - 21 * DAY))
    expect(oldWeek?.external).toBe(1)

    // Per-project: busiest first, self flag honest, recent = last 28 days.
    expect(body.perProject).toHaveLength(2)
    expect(body.perProject[0]).toMatchObject({ name: 'someapp', self: false, total: 2, recent: 2 })
    expect(body.perProject[1]).toMatchObject({ name: 'og-clone', self: true, total: 1, recent: 1 })

    // weeks param clamps to [4, 26].
    const wide = (await (await app.request('/api/swarm/kpi/landed?weeks=999')).json()) as SwarmLandedKpi
    expect(wide.weeks).toHaveLength(26)
    const narrow = (await (await app.request('/api/swarm/kpi/landed?weeks=1')).json()) as SwarmLandedKpi
    expect(narrow.weeks).toHaveLength(4)
  })

  it('an empty registry answers an all-zero shape, never an error', async () => {
    const res = await app.request('/api/swarm/kpi/landed')
    expect(res.status).toBe(200)
    const body = (await res.json()) as SwarmLandedKpi
    expect(body.totals).toEqual({ self: 0, external: 0 })
    expect(body.perProject).toEqual([])
    expect(body.weeks).toHaveLength(12)
    expect(body.weeks.every((w) => w.self === 0 && w.external === 0)).toBe(true)
  })
})
