// Pins the git/shell env-preflight gate (2026-07-22 review, must-fix 3):
// mutation-tested against the reviewer's own repro — deleting the gate call
// out of any of the three spawn routes turns these tests red (verified by
// hand while writing this file: removing the swarmEnvPreflight() call + its
// `if (!envPre.ok)` guard from server/routes/swarm.ts made every "gate blocks"
// case here fail, since spawnSwarmWorker/Supply/Manager were then called and
// the route answered 200 instead of 503).
//
// Also pins two behavior contracts from the review: the gate runs BEFORE the
// twin-dispatch claim (a card must never be claimed off todo for a spawn the
// env gate already refused), and /supply + /manager pass requireGitRepo:false
// (they never call git — see swarmEnvPreflight.ts's module header) while
// /worker uses the default (requireGitRepo:true).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { readProjectData, mutateProjectData } from '@/lib/server/projectData'
import type { ProjectTask } from '@/lib/types'
import type { SwarmEnvPreflightOptions, SwarmEnvPreflightResult } from '@/lib/server/swarmEnvPreflight'

// vitest.config.ts has no testTimeout — the 5s default flakes under load
// (repo-wide known issue, card d44b5ff0; sibling swarmEnvPreflight.test.ts
// already carries this same line). Without it, 2026-07-22 review measured 3/7
// cases here timing out at load≈4.7.
vi.setConfig({ testTimeout: 60_000 })

const hooks = vi.hoisted(() => ({
  envResult: { ok: true, issues: [] } as SwarmEnvPreflightResult,
  envCalls: [] as Array<{ path: string; opts?: SwarmEnvPreflightOptions }>,
}))

vi.mock('@/lib/server/claudePreflight', () => ({
  claudeRunPreflight: async () => ({ ok: true }),
}))

vi.mock('@/lib/server/swarmEnvPreflight', () => ({
  swarmEnvPreflight: async (path: string, opts?: SwarmEnvPreflightOptions) => {
    hooks.envCalls.push({ path, opts })
    return hooks.envResult
  },
}))

vi.mock('@/lib/server/swarmWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/swarmWorker')>()
  return {
    ...actual,
    spawnSwarmWorker: vi.fn(async () => ({
      terminalId: 't-worker',
      agentSessionId: 's-worker',
      worktree: '/tmp/fake-worktree',
      branch: 'swarm/fake-branch',
    })),
  }
})

vi.mock('@/lib/server/swarmSupply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/swarmSupply')>()
  return {
    ...actual,
    spawnSwarmSupply: vi.fn(async () => ({ terminalId: 't-supply', agentSessionId: 's-supply', resumed: false })),
  }
})

vi.mock('@/lib/server/swarmManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/swarmManager')>()
  return {
    ...actual,
    spawnSwarmManager: vi.fn(async () => ({ terminalId: 't-manager', agentSessionId: 's-manager', resumed: false })),
  }
})

import { spawnSwarmWorker } from '@/lib/server/swarmWorker'
import { spawnSwarmSupply } from '@/lib/server/swarmSupply'
import { spawnSwarmManager } from '@/lib/server/swarmManager'

const OWNER = 'owner@example.com'
process.env.OPENGROUND_OWNER_EMAILS = OWNER

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let proj: string

const register = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
}

const seedCard = async (task: Partial<ProjectTask> & { id: string }): Promise<void> => {
  await mutateProjectData(proj, (data) => {
    data.tasks.push({
      title: 'fix the thing',
      done: false,
      createdAt: new Date(0).toISOString(),
      boardColumn: 'todo',
      ...task,
    })
  })
}

const cardNow = async (id: string): Promise<ProjectTask | undefined> =>
  (await readProjectData(proj)).tasks.find((t) => t.id === id)

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-envgate-home-')))
  proj = await realpath(await mkdtemp(join(tmpdir(), 'og-envgate-proj-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  await writeSession({
    user: { id: 'test-user', email: OWNER, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'a',
    refreshToken: 'r',
  })
  await register(proj)
  hooks.envResult = { ok: true, issues: [] }
  hooks.envCalls = []
  vi.mocked(spawnSwarmWorker).mockClear()
  vi.mocked(spawnSwarmSupply).mockClear()
  vi.mocked(spawnSwarmManager).mockClear()
})

afterEach(async () => {
  await clearSession()
  await rm(home, { recursive: true, force: true })
  await rm(proj, { recursive: true, force: true })
})

describe('the env-preflight gate blocks every spawn route before it does any work', () => {
  it('POST /api/swarm/worker → 503 + envIssues, spawnSwarmWorker never called, card never claimed off todo', async () => {
    await seedCard({ id: 'c1' })
    hooks.envResult = {
      ok: false,
      issues: [{ id: 'notAGitRepo', message: 'not a git repo' }],
    }

    const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c1' }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.envIssues).toEqual(['notAGitRepo'])

    expect(spawnSwarmWorker).not.toHaveBeenCalled()
    // The twin-dispatch claim (todo→doing CAS) must not have run either — a
    // refused env gate must never leave a card claimed with no worker behind it.
    const after = await cardNow('c1')
    expect(after?.boardColumn).toBe('todo')
    expect(after?.branch).toBeUndefined()
  })

  it('POST /api/swarm/worker → 200 and the gate ran BEFORE spawnSwarmWorker (call order)', async () => {
    await seedCard({ id: 'c2' })
    const order: string[] = []
    hooks.envResult = { ok: true, issues: [] }
    vi.mocked(spawnSwarmWorker).mockImplementationOnce(async () => {
      order.push('spawn')
      return { terminalId: 't-worker', agentSessionId: 's-worker', worktree: '/tmp/fake', branch: 'swarm/fake' }
    })
    const originalEnvCalls = hooks.envCalls.length
    const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c2' }))
    expect(res.status).toBe(200)
    expect(hooks.envCalls.length).toBe(originalEnvCalls + 1) // the gate was actually consulted
    expect(order).toEqual(['spawn']) // and only reached AFTER it passed
  })

  it('POST /api/swarm/supply → 503 + envIssues, spawnSwarmSupply never called', async () => {
    hooks.envResult = { ok: false, issues: [{ id: 'shellMissing', message: 'no shell' }] }
    const res = await app.request('/api/swarm/supply', json({ path: proj }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.envIssues).toEqual(['shellMissing'])
    expect(spawnSwarmSupply).not.toHaveBeenCalled()
  })

  it('POST /api/swarm/manager → 503 + envIssues, spawnSwarmManager never called', async () => {
    hooks.envResult = { ok: false, issues: [{ id: 'shellMissing', message: 'no shell' }] }
    const res = await app.request('/api/swarm/manager', json({ path: proj }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.envIssues).toEqual(['shellMissing'])
    expect(spawnSwarmManager).not.toHaveBeenCalled()
  })
})

describe('requireGit/requireGitRepo — only /worker requires a git repo; only /supply skips git entirely', () => {
  it('POST /api/swarm/worker calls swarmEnvPreflight with the default (requireGitRepo unset/true)', async () => {
    await seedCard({ id: 'c3' })
    const callsBefore = hooks.envCalls.length
    const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c3' }))
    expect(res.status).toBe(200)
    // Assert the gate was actually consulted (a mutation that deletes the gate
    // call, leaving envCalls empty, must not pass this "unset/true" check by
    // vacuously reading undefined as "not false" — 2026-07-22 review, must-fix5).
    expect(hooks.envCalls.length).toBe(callsBefore + 1)
    const call = hooks.envCalls.at(-1)
    expect(call?.opts?.requireGitRepo).not.toBe(false)
    expect(call?.opts?.requireGit).not.toBe(false)
  })

  it('POST /api/swarm/supply calls swarmEnvPreflight with requireGit:false AND requireGitRepo:false (no git at all)', async () => {
    const callsBefore = hooks.envCalls.length
    const res = await app.request('/api/swarm/supply', json({ path: proj }))
    expect(res.status).toBe(200)
    expect(hooks.envCalls.length).toBe(callsBefore + 1)
    const call = hooks.envCalls.at(-1)
    expect(call?.opts?.requireGitRepo).toBe(false)
    expect(call?.opts?.requireGit).toBe(false)
  })

  it('POST /api/swarm/manager calls swarmEnvPreflight with requireGitRepo:false but requireGit still true (the /og-manage conversation runs git)', async () => {
    const callsBefore = hooks.envCalls.length
    const res = await app.request('/api/swarm/manager', json({ path: proj }))
    expect(res.status).toBe(200)
    expect(hooks.envCalls.length).toBe(callsBefore + 1)
    const call = hooks.envCalls.at(-1)
    expect(call?.opts?.requireGitRepo).toBe(false)
    expect(call?.opts?.requireGit).not.toBe(false)
  })
})
