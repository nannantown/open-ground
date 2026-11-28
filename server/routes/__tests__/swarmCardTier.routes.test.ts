import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// ─── GET /api/swarm/card-tier — the tier the card's worker runs at (R-D5) ────
//
// og-manage 「マージ」 step 4 settles the commander's review depth from this
// answer. It used to copy HEAVY_SIGNALS into a jq `test()`, and jq (Oniguruma)
// counts Japanese letters as word characters, so `\bguard\b` missed
// 「guardを直す」 while the worker's JS regex floored it to `design`: the safety
// card lost its review (review D-M1, 2026-11-28). The route answers with the
// worker's own resolveCardTier, so the two cannot disagree. Pinned on the REAL
// Hono app, with the project folder named like the OPEN GROUND checkout (a
// space in the path) and the query encoded the way `curl -G --data-urlencode`
// encodes it (space ⇒ '+').

import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { mutateProjectData } from '@/lib/server/projectData'
import type { ProjectTask, TaskTier } from '@/lib/types'

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

/** The query exactly as `curl -G --data-urlencode "path=$PWD" --data-urlencode "id=…"` builds it. */
const cardTier = (path: string, id: string) =>
  app.request(`/api/swarm/card-tier?${new URLSearchParams({ path, id }).toString()}`)

const card = (id: string, title: string, tier?: TaskTier, notes = 'completion conditions'): ProjectTask =>
  ({ id, title, notes, done: false, boardColumn: 'review', ...(tier ? { tier } : {}) }) as unknown as ProjectTask

let home: string
let scratch: string
let dir: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-cardtier-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-cardtier-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  await signInAs(OWNER)
  dir = join(scratch, 'OPEN GROUND')
  await mkdir(dir, { recursive: true })
  expect((await post('/api/projects/import', { path: dir })).status).toBe(200)
})

afterEach(async () => {
  await clearSession()
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

describe('GET /api/swarm/card-tier', () => {
  it('the reviewer’s Japanese titles floor to design, as they do for the worker (jq read them as not floored)', async () => {
    const titles = ['guardを直す', 'sandboxの修正', 'authが落ちる', 'migrationを追加', 'deleteボタン']
    await mutateProjectData(dir, (d) => void (d.tasks = titles.map((t, i) => card(`j${i}`, t, 'standard'))))
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i]
      const res = await cardTier(dir, `j${i}`)
      expect(res.status, title).toBe(200)
      expect(await res.json(), title).toEqual({ tier: 'standard', effectiveTier: 'design', floored: true })
    }
  })

  it('English floor words, an explicit tier above the floor, and a card that trips nothing', async () => {
    await mutateProjectData(dir, (d) => void (d.tasks = [
      card('en', 'Fix the auth guard', 'touch'),
      card('up', 'guardの全面見直し', 'ultra'),
      card('light', 'ボタンの文言', undefined, 'typo'),
      card('plain', 'ボタンの色を変える', undefined),
      card('safe', 'Guardian of the copy', 'standard'),
    ]))
    const read = async (id: string) => (await (await cardTier(dir, id)).json()) as unknown
    expect(await read('en')).toEqual({ tier: 'touch', effectiveTier: 'design', floored: true })
    expect(await read('up'), 'the floor never lowers a written tier').toEqual({ tier: 'ultra', effectiveTier: 'ultra', floored: true })
    expect(await read('light'), 'no tier stored: the estimator').toEqual({ tier: null, effectiveTier: 'touch', floored: false })
    expect(await read('plain')).toEqual({ tier: null, effectiveTier: 'standard', floored: false })
    expect(await read('safe'), 'a floor word inside a longer English word is not one').toEqual({ tier: 'standard', effectiveTier: 'standard', floored: false })
  })

  it('a junk stored tier reads as none, and the estimator decides (as for the worker)', async () => {
    await mutateProjectData(dir, (d) => void (d.tasks = [{ ...card('junk', 'ボタンの色を変える'), tier: 'heavy' } as unknown as ProjectTask]))
    expect(await (await cardTier(dir, 'junk')).json()).toEqual({ tier: null, effectiveTier: 'standard', floored: false })
  })

  it('404 for a card that is not on the Board, 400 without an id', async () => {
    await mutateProjectData(dir, (d) => void (d.tasks = [card('c1', 'guardを直す')]))
    expect((await cardTier(dir, 'nope')).status).toBe(404)
    expect((await app.request(`/api/swarm/card-tier?${new URLSearchParams({ path: dir }).toString()}`)).status).toBe(400)
  })

  it('403 for a folder that is not a registered project', async () => {
    const other = join(scratch, 'other')
    await mkdir(other, { recursive: true })
    expect((await cardTier(other, 'c1')).status).toBe(403)
  })

  it('403 when signed out, and for a signed-in non-owner', async () => {
    await mutateProjectData(dir, (d) => void (d.tasks = [card('c1', 'guardを直す')]))
    await clearSession()
    expect((await cardTier(dir, 'c1')).status).toBe(403)
    await signInAs(TESTER)
    expect((await cardTier(dir, 'c1')).status).toBe(403)
  })

  it('reads only: the Board file is unchanged by the call', async () => {
    await mutateProjectData(dir, (d) => void (d.tasks = [card('c1', 'guardを直す', 'standard')]))
    const { readProjectData } = await import('@/lib/server/projectData')
    const before = JSON.stringify((await readProjectData(dir)).tasks)
    expect((await cardTier(dir, 'c1')).status).toBe(200)
    expect(JSON.stringify((await readProjectData(dir)).tasks)).toBe(before)
  })
})
