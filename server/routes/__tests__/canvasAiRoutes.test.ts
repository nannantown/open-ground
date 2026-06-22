// canvasAiRoutes.test.ts — route-level contract for the Canvas AI job endpoints.
// Exercised via app.request(...) (no TCP bind). claudeConnection is mocked so
// the run-gate preflight is deterministic; the lifecycle endpoints (active /
// job / cancel) are driven against jobs started through the MODULE with fake
// engines, so NO claude PTY is ever spawned. The happy-path POST → {jobId} (a
// real run) is covered at the module level (canvasAiJobs.test.ts) + client level
// (CanvasWorkspace.generate / ScreenView.tweak), which don't need a real CLI.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Mutable connection probe — each test seeds installed/loggedIn for its case
// (mirrors claudeLoginGate.test.ts; the factory references a vi.fn so the mock
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
import { startGenerateJob, _resetCanvasAiJobsForTest } from '@/lib/server/canvasAi'
import type { CanvasElement } from '@/lib/types'

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('canvas AI routes', () => {
  let projectPath: string
  beforeEach(async () => {
    _resetCanvasAiJobsForTest()
    claudeConnection.mockReset()
    claudeConnection.mockResolvedValue({
      installed: true,
      loggedIn: true,
      plan: null,
      email: null,
      message: 'ok',
    })
    projectPath = await realpath(await mkdtemp(join(tmpdir(), 'og-canvas-ai-route-')))
    await registerTestProject(projectPath)
  })
  afterEach(async () => {
    _resetCanvasAiJobsForTest()
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  // ── validation (before any preflight / spawn) ──
  it('POST generate → 400 without a prompt', async () => {
    const res = await app.request(
      '/api/canvas/ai/generate',
      json({ path: projectPath, canvasId: 'c1' }),
    )
    expect(res.status).toBe(400)
  })
  it('POST generate → 400 without a canvasId', async () => {
    const res = await app.request(
      '/api/canvas/ai/generate',
      json({ path: projectPath, prompt: 'a card' }),
    )
    expect(res.status).toBe(400)
  })
  it('POST generate → 403 for an unregistered path', async () => {
    const res = await app.request(
      '/api/canvas/ai/generate',
      json({ path: '/etc', canvasId: 'c1', prompt: 'a card' }),
    )
    expect(res.status).toBe(403)
  })
  it('POST tweak → 400 without an elementId', async () => {
    const res = await app.request(
      '/api/canvas/ai/tweak',
      json({
        path: projectPath,
        canvasId: 'c1',
        source: 's',
        framework: 'react',
        instruction: 'i',
        element: { tag: 'div' },
      }),
    )
    expect(res.status).toBe(400)
  })

  // ── preflight 503s (the sign-in / install CTA contract) ──
  it('POST generate → 503 { claudeLoggedOut } when signed out', async () => {
    claudeConnection.mockResolvedValue({
      installed: true,
      loggedIn: false,
      plan: null,
      email: null,
      message: 'not signed in',
    })
    const res = await app.request(
      '/api/canvas/ai/generate',
      json({ path: projectPath, canvasId: 'c1', prompt: 'a card' }),
    )
    expect(res.status).toBe(503)
    expect((await res.json()).claudeLoggedOut).toBe(true)
  })
  it('POST generate → 503 { claudeMissing } when the CLI is absent', async () => {
    claudeConnection.mockResolvedValue({
      installed: false,
      loggedIn: false,
      plan: null,
      email: null,
      message: 'not installed',
    })
    const res = await app.request(
      '/api/canvas/ai/generate',
      json({ path: projectPath, canvasId: 'c1', prompt: 'a card' }),
    )
    expect(res.status).toBe(503)
    expect((await res.json()).claudeMissing).toBe(true)
  })

  // ── lifecycle endpoints (active / job / cancel) — no claude spawned ──
  it('GET active lists a running job; GET job reports it; cancel drops it', async () => {
    let aborted = false
    const id = startGenerateJob(
      { projectPath, canvasId: 'cX', prompt: 'p' },
      {
        generate: (_p, opts) =>
          new Promise<CanvasElement[]>((_res, rej) => {
            opts?.signal?.addEventListener(
              'abort',
              () => {
                aborted = true
                rej(new Error('aborted'))
              },
              { once: true },
            )
          }),
      },
    )

    const active = await (await app.request('/api/canvas/ai/active')).json()
    expect(active.jobs.some((j: { id: string }) => j.id === id)).toBe(true)

    const state = await (await app.request(`/api/canvas/ai/job/${id}`)).json()
    expect(state.status).toBe('running')
    expect(state.canvasId).toBe('cX')

    const cancelRes = await app.request(`/api/canvas/ai/job/${id}/cancel`, { method: 'POST' })
    expect(cancelRes.status).toBe(200)
    // The abort settles the job; it must then leave the active list.
    await new Promise((r) => setTimeout(r, 40))
    expect(aborted).toBe(true)
    const active2 = await (await app.request('/api/canvas/ai/active')).json()
    expect(active2.jobs.some((j: { id: string }) => j.id === id)).toBe(false)
  })

  it('GET job → 404 for an unknown id', async () => {
    const res = await app.request('/api/canvas/ai/job/nope-123')
    expect(res.status).toBe(404)
  })
  it('POST cancel → 404 for an unknown id', async () => {
    const res = await app.request('/api/canvas/ai/job/nope-123/cancel', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
