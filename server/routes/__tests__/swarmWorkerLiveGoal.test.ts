import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// ─── worker の目標は「画面に今あるもの」 (2026-08-26) ──────────────────────────
//
// With the swarm on, the Board card's 実行 dispatches a WORKER instead of
// opening a terminal. The route reads the card from tasks.json — and the drawer
// DEBOUNCES its edits (~350ms) before they land there. So the ordinary case —
// the owner writes the card and presses 実行 — would send a worker after a goal
// that is one edit stale, or after an EMPTY one for a card created in the same
// breath.
//
// The terminal path has always taken the client's LIVE fields
// (composeTaskPrompt's LiveTaskFields). The two dispatch paths had different
// answers to the same question; this pins the one answer.
//
// The claim/identity half must NOT move with it: `taskId` still decides which
// card is taken todo→doing and which twin dispatch is refused.

const spawnCalls: { title: string; notes?: string }[] = []
vi.mock('@/lib/server/claudePreflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/claudePreflight')>()),
  claudeRunPreflight: async () => ({ ok: true }),
}))
vi.mock('@/lib/server/swarmEnvPreflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/swarmEnvPreflight')>()),
  swarmEnvPreflight: async () => ({ ok: true, issues: [] }),
}))
vi.mock('@/lib/server/swarmWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/swarmWorker')>()
  return {
    ...actual,
    spawnSwarmWorker: async (o: { title: string; notes?: string }) => {
      spawnCalls.push({ title: o.title, notes: o.notes })
      return { branch: 'swarm/x', worktree: '/w', runtime: 'sdk', sdkSessionId: 's1' }
    },
  }
})

import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { __resetOrchestratorForTests } from '@/lib/server/swarmOrchestrator'
import { readProjectData, writeProjectData } from '@/lib/server/projectData'

const OWNER = 'owner@example.com'
process.env.OPENGROUND_OWNER_EMAILS = OWNER

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
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-wg-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-wg-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  await writeSession({
    user: { id: 'u', email: OWNER, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'a',
    refreshToken: 'r',
  })
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

/** Seed one card, the way the disk holds it BEFORE a debounced drawer edit lands. */
const seedCard = async (over: Record<string, unknown> = {}) => {
  const data = await readProjectData(dir)
  await writeProjectData(dir, {
    ...data,
    tasks: [
      {
        id: 'c1',
        title: 'stale title',
        notes: 'stale content',
        done: false,
        createdAt: '2026-08-26T00:00:00.000Z',
        boardColumn: 'todo',
        ...over,
      },
    ],
  } as never)
}

describe('POST /api/swarm/worker — the goal is what is on screen', () => {
  it('prefers the live title/notes over the debounced disk copy', async () => {
    await seedCard()
    const res = await app.request(
      '/api/swarm/worker',
      json({ path: dir, taskId: 'c1', title: 'live title', notes: 'live content' }),
    )
    expect(res.status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].title).toBe('live title')
    expect(spawnCalls[0].notes).toBe('live content')
  })

  it('a card the drawer has not persisted AT ALL still dispatches on the live fields', async () => {
    // The card exists (so the claim can take it) but its content has not landed
    // on disk yet — the create-then-run-immediately case, where the old
    // disk-only read had nothing to send.
    await seedCard({ title: '', notes: '' })
    const res = await app.request(
      '/api/swarm/worker',
      json({ path: dir, taskId: 'c1', title: 'just typed', notes: 'just typed body' }),
    )
    expect(res.status).toBe(200)
    expect(spawnCalls[0].title).toBe('just typed')
  })

  it('falls back to the stored card when the client sends nothing live', async () => {
    await seedCard()
    const res = await app.request('/api/swarm/worker', json({ path: dir, taskId: 'c1' }))
    expect(res.status).toBe(200)
    expect(spawnCalls[0].title).toBe('stale title')
    expect(spawnCalls[0].notes).toBe('stale content')
  })

  it('a blank live title does NOT erase the stored one (a stray empty field is not an instruction)', async () => {
    await seedCard()
    const res = await app.request(
      '/api/swarm/worker',
      json({ path: dir, taskId: 'c1', title: '   ', notes: '' }),
    )
    expect(res.status).toBe(200)
    expect(spawnCalls[0].title).toBe('stale title')
  })

  // ⚠ DEFENDED TWICE, measured: removing only the route's `if (!card) 404` leaves
  // this green — `claimCardForDispatch` answers `missing` one layer down and 404s
  // there. It is NOT a vacuous test (removing BOTH turns it red); the note is here
  // so a later reader does not mistake "one mutation could not break it" for
  // "nothing is being observed".
  it('identity still comes from taskId: an unknown card is 404, whatever the live fields say', async () => {
    await seedCard()
    const res = await app.request(
      '/api/swarm/worker',
      json({ path: dir, taskId: 'nope', title: 'live title' }),
    )
    expect(res.status).toBe(404)
    expect(spawnCalls).toHaveLength(0)
  })

  it('the card is CLAIMED todo→doing before the spawn, live fields or not', async () => {
    await seedCard()
    await app.request('/api/swarm/worker', json({ path: dir, taskId: 'c1', title: 'live title' }))
    const after = await readProjectData(dir)
    expect(after.tasks[0].boardColumn).toBe('doing')
  })
})
