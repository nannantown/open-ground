// describeRoutes.test.ts — route-level contract for the project-description job
// endpoints. Exercised via app.request(...) (no TCP bind). claudeConnection is
// mocked so the run-gate preflight is deterministic; the lifecycle endpoints
// (active / job / cancel) are driven against jobs started through the MODULE
// with a fake engine, so NO claude PTY is ever spawned and ~/.openground is
// never written. The happy-path POST → {jobId} (a real run) is covered at the
// module level (generateDescription.test.ts's "describe job registry") + the
// client (ProjectPanel), which don't need a real CLI.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Mutable connection probe — each test seeds installed/loggedIn for its case
// (mirrors canvasAiRoutes.test.ts; the factory references a vi.fn so the mock
// is overridable per test).
const claudeConnection = vi.fn(async () => ({
  installed: true,
  loggedIn: true,
  plan: null as string | null,
  email: null as string | null,
  message: 'ok',
}))
vi.mock('@/lib/server/claudeConnection', () => ({
  claudeConnection: () => claudeConnection(),
}))

import { app } from '../../app'
import { registerTestProject } from '../../../src/test/registerProject'
import {
  startDescribeJob,
  _resetDescribeJobsForTest,
  type GeneratedDescriptions,
} from '@/lib/server/generateDescription'

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('project describe routes', () => {
  let projectPath: string
  beforeEach(async () => {
    _resetDescribeJobsForTest()
    claudeConnection.mockReset()
    claudeConnection.mockResolvedValue({
      installed: true,
      loggedIn: true,
      plan: null,
      email: null,
      message: 'ok',
    })
    projectPath = await realpath(await mkdtemp(join(tmpdir(), 'og-describe-route-')))
    await registerTestProject(projectPath)
  })
  afterEach(async () => {
    _resetDescribeJobsForTest()
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  // ── path guard + preflight (both BEFORE any job is created / claude spawned) ──
  it('POST describe → 403 for an unregistered path', async () => {
    const res = await app.request('/api/project/describe', post({ path: '/etc' }))
    expect(res.status).toBe(403)
  })
  it('POST describe → 503 { claudeLoggedOut } when signed out (no job created)', async () => {
    claudeConnection.mockResolvedValue({
      installed: true,
      loggedIn: false,
      plan: null,
      email: null,
      message: 'not signed in',
    })
    const res = await app.request('/api/project/describe', post({ path: projectPath }))
    expect(res.status).toBe(503)
    expect((await res.json()).claudeLoggedOut).toBe(true)
  })
  it('POST describe → 503 { claudeMissing } when the CLI is absent (no job created)', async () => {
    claudeConnection.mockResolvedValue({
      installed: false,
      loggedIn: false,
      plan: null,
      email: null,
      message: 'not installed',
    })
    const res = await app.request('/api/project/describe', post({ path: projectPath }))
    expect(res.status).toBe(503)
    expect((await res.json()).claudeMissing).toBe(true)
  })

  // ── lifecycle endpoints (active / job / cancel) — no claude spawned ──
  it('GET active lists a running job; GET job reports it; cancel drops it', async () => {
    let aborted = false
    // Start via the MODULE with a fake engine so no PTY runs and the run stays
    // 'running' until we cancel it.
    const id = startDescribeJob(
      { projectPath },
      {
        generate: (_p, opts) =>
          new Promise<GeneratedDescriptions>((_res, rej) => {
            opts?.signal?.addEventListener(
              'abort',
              () => {
                aborted = true
                rej(new Error('aborted'))
              },
              { once: true },
            )
          }),
        persist: async () => {},
        lang: async () => 'en',
      },
    )

    const active = await (await app.request('/api/project/describe/active')).json()
    expect(
      active.jobs.some((j: { id: string; projectPath: string }) => j.id === id && j.projectPath === projectPath),
    ).toBe(true)

    const state = await (await app.request(`/api/project/describe/job/${id}`)).json()
    expect(state.status).toBe('running')
    expect(state.projectPath).toBe(projectPath)

    const cancelRes = await app.request(`/api/project/describe/job/${id}/cancel`, {
      method: 'POST',
    })
    expect(cancelRes.status).toBe(200)
    expect((await cancelRes.json()).ok).toBe(true)
    // The abort settles the job; it must then leave the active list.
    await new Promise((r) => setTimeout(r, 40))
    expect(aborted).toBe(true)
    const active2 = await (await app.request('/api/project/describe/active')).json()
    expect(active2.jobs.some((j: { id: string }) => j.id === id)).toBe(false)
  })

  it('GET job → 404 for an unknown id', async () => {
    const res = await app.request('/api/project/describe/job/nope-123')
    expect(res.status).toBe(404)
  })
  it('POST cancel → 404 for an unknown id', async () => {
    const res = await app.request('/api/project/describe/job/nope-123/cancel', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })
})
