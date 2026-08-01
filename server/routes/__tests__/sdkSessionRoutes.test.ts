// Route contract for /api/sdk-session/* — the HTTP face of the Agent SDK
// worker sessions (docs/SDK_WORKER_MIGRATION_PLAN.md §3.5 / §7).
//
// The interesting surface here is NOT the happy path, it is the gate. These
// routes reach a live claude session, so they carry TWO checks: the supplied
// project path must be a registered project, AND the session's cwd must sit
// under that project. Without the second, any one registered project would
// unlock every session on the machine.
//
// No real `claude` is spawned: sdkSession's queryFn is injected (the only way
// these paths are testable at all — an isolated HOME cannot authenticate, and
// the real one is the owner's).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { app } from '../../app'
import { registerTestProject } from '../../../src/test/registerProject'
import {
  spawnSdkSession,
  __resetSdkSessionsForTests,
  __setQuotaPrefixesForTests,
  getSdkSession,
  type SdkQueryFn,
} from '@/lib/server/sdkSession'
import { projectUUIDFromPath } from '@/lib/server/projectDataPath'
import { centralWorktreesDir } from '@/lib/server/paths'

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** A session that stays open until its input closes, echoing one text per turn. */
const openQuery: SdkQueryFn = ({ prompt }) => ({
  async *[Symbol.asyncIterator]() {
    for await (const _m of prompt) {
      void _m
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ack' }] } }
      yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
    }
  },
  interrupt: async () => {},
})

const settle = () => new Promise((r) => setTimeout(r, 10))

describe('/api/sdk-session/* — gates and lifecycle', () => {
  let projectPath: string
  let otherPath: string
  let scratch: string
  let sessionId: string

  beforeEach(async () => {
    __resetSdkSessionsForTests()
    __setQuotaPrefixesForTests([])
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-sdkroute-')))
    projectPath = join(scratch, 'projA')
    otherPath = join(scratch, 'projB')
    await mkdir(projectPath, { recursive: true })
    await mkdir(otherPath, { recursive: true })
    await registerTestProject(projectPath)
    await registerTestProject(otherPath)

    // A session whose cwd is the project's CENTRAL worktree — the arrangement
    // production actually creates (~/.openground/projects/<uuid>/worktrees/…,
    // in the isolated test home). The first version of this file put the
    // worktree INSIDE the project instead, an arrangement that never exists,
    // and thereby certified a gate that 403'd every real SDK worker. Measure
    // the production arrangement, not a convenient one.
    const uuid = await projectUUIDFromPath(projectPath)
    const wt = join(centralWorktreesDir(uuid), 'wt1')
    await mkdir(wt, { recursive: true })
    sessionId = spawnSdkSession({
      cwd: wt,
      options: {},
      initialPrompt: 'go',
      queryFn: openQuery,
    }).id
    await settle()
  })

  afterEach(async () => {
    __resetSdkSessionsForTests()
    __setQuotaPrefixesForTests(null)
    await rm(scratch, { recursive: true, force: true })
  })

  const q = (p: string) => `path=${encodeURIComponent(p)}`

  describe('the entitlement gate', () => {
    it('403s an UNREGISTERED project path', async () => {
      const res = await app.request(
        `/api/sdk-session/${sessionId}?${q(join(scratch, 'not-registered'))}`,
      )
      expect(res.status).toBe(403)
    })

    it('403s a registered project that does NOT own the session', async () => {
      // The second gate. Without it, holding any one registered project would
      // be enough to read and drive every live session on the machine.
      const res = await app.request(`/api/sdk-session/${sessionId}?${q(otherPath)}`)
      expect(res.status).toBe(403)
    })

    it('404s an unknown session id under a valid project', async () => {
      const res = await app.request(`/api/sdk-session/does-not-exist?${q(projectPath)}`)
      expect(res.status).toBe(404)
    })

    it('allows a MANAGER-shaped session too (cwd = the project root itself)', async () => {
      // The other production shape: a commander desk runs in the primary
      // checkout, not a worktree. Same UUID both sides ⇒ entitled.
      const managerSession = spawnSdkSession({
        cwd: projectPath,
        options: {},
        initialPrompt: 'go',
        queryFn: openQuery,
      })
      const res = await app.request(`/api/sdk-session/${managerSession.id}?${q(projectPath)}`)
      expect(res.status).toBe(200)
    })

    it('403s a session whose cwd resolves to NO registered project', async () => {
      // e.g. the project was removed from the canvas while its session ran.
      const orphan = spawnSdkSession({
        cwd: join(scratch, 'unregistered-dir'),
        options: {},
        initialPrompt: 'go',
        queryFn: openQuery,
      })
      const res = await app.request(`/api/sdk-session/${orphan.id}?${q(projectPath)}`)
      expect(res.status).toBe(403)
    })

    it('allows the owning project', async () => {
      const res = await app.request(`/api/sdk-session/${sessionId}?${q(projectPath)}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id: string; status: string }
      expect(body.id).toBe(sessionId)
    })

    it('applies the SAME gate to input / interrupt / delete, not just GET', async () => {
      for (const [path, init] of [
        [`/api/sdk-session/${sessionId}/input?${q(otherPath)}`, postJson({ text: 'x' })],
        [`/api/sdk-session/${sessionId}/interrupt?${q(otherPath)}`, { method: 'POST' }],
        [`/api/sdk-session/${sessionId}?${q(otherPath)}`, { method: 'DELETE' }],
      ] as [string, RequestInit][]) {
        const res = await app.request(path, init)
        expect([403, 404]).toContain(res.status)
      }
    })
  })

  describe('input', () => {
    it('queues a turn and the session processes it', async () => {
      const res = await app.request(
        `/api/sdk-session/${sessionId}/input?${q(projectPath)}`,
        postJson({ text: 'second turn' }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, queued: true })
      await settle()
      expect(getSdkSession(sessionId)!.status).toBe('waiting')
    })

    it('400s empty text rather than sending a blank turn', async () => {
      const res = await app.request(
        `/api/sdk-session/${sessionId}/input?${q(projectPath)}`,
        postJson({ text: '   ' }),
      )
      expect(res.status).toBe(400)
    })

    it('409s once the session has finished — not a silent drop', async () => {
      await app.request(`/api/sdk-session/${sessionId}?${q(projectPath)}`, { method: 'DELETE' })
      const res = await app.request(
        `/api/sdk-session/${sessionId}/input?${q(projectPath)}`,
        postJson({ text: 'too late' }),
      )
      expect(res.status).toBe(409)
    })
  })

  describe('interrupt / delete', () => {
    it('interrupt returns ok and leaves the session addressable', async () => {
      const res = await app.request(`/api/sdk-session/${sessionId}/interrupt?${q(projectPath)}`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      expect(getSdkSession(sessionId)).not.toBeNull()
    })

    it('delete ends the session', async () => {
      const res = await app.request(`/api/sdk-session/${sessionId}?${q(projectPath)}`, {
        method: 'DELETE',
      })
      expect(res.status).toBe(200)
      expect(getSdkSession(sessionId)!.status).toBe('exited')
    })
  })

  describe('stream', () => {
    it('opens an SSE stream whose first event carries the replay and the truncation flag', async () => {
      const res = await app.request(`/api/sdk-session/${sessionId}/stream?${q(projectPath)}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      // Read just the first frames; the session is finished-or-idle so the
      // stream either ends or heartbeats — we do not drain it.
      const reader = res.body!.getReader()
      const { value } = await reader.read()
      const text = new TextDecoder().decode(value)
      expect(text).toContain('event: init')
      expect(text).toContain('"truncated":false')
      await reader.cancel()
    })

    it('403s the stream for a project that does not own the session', async () => {
      const res = await app.request(`/api/sdk-session/${sessionId}/stream?${q(otherPath)}`)
      expect(res.status).toBe(403)
    })
  })
})
