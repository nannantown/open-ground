// canvasAiPreflight.test.ts — the SPAWN-TIME run-gate re-check in runFileTask.
//
// SECURITY (TOCTOU): the POST routes pre-flight the run gate (claudeRunPreflight)
// before creating a job, but a Canvas AI run is a JOB that can sit QUEUED behind
// another run in the SAME project for seconds–minutes before it wins its turn and
// actually spawns claude. If the user signs OUT of claude in that window, the
// old code spawned a SIGNED-OUT claude that opens its OWN OAuth browser — exactly
// what the preflight gate exists to prevent. runFileTask now RE-RUNS the same gate
// right before launchClaude and refuses to spawn when signed out.
//
// HERMETIC: the run gate (claudeRunPreflight) and the PTY layer (launchClaude /
// subscribeTerminal / killTerminal) are mocked, so this test never shells out to
// the real `claude`, never opens a browser, and never touches the real home —
// HOME is the throwaway test home (setup-home.ts), and the only filesystem writes
// are to per-test tmp dirs. We verify the loggedOut detection lands BEFORE any
// spawn (launchClaude is asserted never-called).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ClaudePreflightResult } from './claudePreflight'
import type { CanvasAiJobStatus } from '@/lib/types'

// The run gate, controllable per-test. Default = signed in (ok). A test that
// simulates a mid-window sign-out flips it to a logged-out 503 body.
const preflight = vi.fn(async (): Promise<ClaudePreflightResult> => ({ ok: true }))
vi.mock('./claudePreflight', () => ({ claudeRunPreflight: () => preflight() }))

// The spawn + PTY layer. launchClaude is a spy so we can assert it is NEVER
// reached when the gate refuses; subscribeTerminal optionally emits the DONE
// marker (set nextChunk before the call) so the signed-in path can complete.
const launchClaude = vi.fn((_opts?: unknown) => ({ terminalId: 't1' }))
const killTerminal = vi.fn()
const unsubscribe = vi.fn()
let nextChunk: string | null = null
vi.mock('./claudeTerminal', () => ({ launchClaude: (o: unknown) => launchClaude(o as never) }))
vi.mock('./terminal', () => ({
  subscribeTerminal: (_id: string, onChunk: (c: string) => void) => {
    if (nextChunk != null) {
      const c = nextChunk
      queueMicrotask(() => onChunk(c))
    }
    return { info: { finishedAt: null }, unsubscribe }
  },
  killTerminal: () => killTerminal(),
  // Added 2026-07-29: canvasAi now WAITS for the session to be gone before
  // deleting the handoff dir it runs in (07 章 §7.8 — a cwd removed under a live
  // process is how an un-killable wedge is made). Nothing is really spawned here.
  killTerminalsByCwdAndWait: async () => true,
}))

import {
  runFileTask,
  CANVAS_DONE_MARKER,
  startGenerateJob,
  getCanvasAiJobState,
  _resetCanvasAiJobsForTest,
} from './canvasAi'
import { createCanvas, readCanvasFile } from './canvasData'
import { registerTestProject } from '../../test/registerProject'

const waitForStatus = async (id: string, status: CanvasAiJobStatus, ms = 3000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (getCanvasAiJobState(id)?.status === status) return getCanvasAiJobState(id)!
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${id} → ${status}`)
}

// ── runFileTask: the gate is re-checked right before the spawn ────────────────

describe('runFileTask — spawn-time run-gate re-check (TOCTOU)', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    preflight.mockReset()
    preflight.mockResolvedValue({ ok: true })
    launchClaude.mockClear()
    killTerminal.mockClear()
    unsubscribe.mockClear()
    nextChunk = null
    dir = await mkdtemp(join(tmpdir(), 'og-canvasai-preflight-'))
    file = join(dir, 'out.json')
    await writeFile(file, '[]\n')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('refuses to spawn (throws) when the gate reports SIGNED-OUT at spawn time', async () => {
    // The window the fix closes: preflight passed at POST, but by the time this
    // run wins its turn the user has signed out.
    preflight.mockResolvedValue({
      ok: false,
      body: { error: 'Claude Code is installed but not signed in.', claudeLoggedOut: true },
    })
    await expect(runFileTask({ cwd: dir, prompt: 'p', file })).rejects.toThrow(/not signed in/)
    // The signed-out claude (which would open its own OAuth browser) is NEVER spawned.
    expect(launchClaude).not.toHaveBeenCalled()
  })

  it('refuses to spawn when the CLI is MISSING at spawn time', async () => {
    preflight.mockResolvedValue({
      ok: false,
      body: { error: 'Claude Code CLI not found.', claudeMissing: true },
    })
    await expect(runFileTask({ cwd: dir, prompt: 'p', file })).rejects.toThrow(/not found/)
    expect(launchClaude).not.toHaveBeenCalled()
  })

  it('spawns and returns the file result when the gate PASSES (normal signed-in run)', async () => {
    await writeFile(file, 'RESULT-OK')
    nextChunk = `${CANVAS_DONE_MARKER}\n`
    const out = await runFileTask({ cwd: dir, prompt: 'p', file })
    expect(out).toBe('RESULT-OK')
    // The gate passed, so the spawn happened exactly once and was torn down.
    expect(launchClaude).toHaveBeenCalledTimes(1)
    expect(killTerminal).toHaveBeenCalledTimes(1)
  })

  it('a timeout with no completion marker names ITSELF (timed out), not the generic error', async () => {
    // 2026-08-03: a session still alive at the deadline throws "timed out" so
    // the client can say 時間切れ — the generic wording hid the ceiling from
    // the owner (their real generate died as an anonymous 「失敗」). The
    // generic "output file" error is reserved for a session that EXITED
    // without completing. (No MCP-specific path exists either way:
    // --strict-mcp-config loads zero MCP servers, so the welcome-screen
    // "MCP servers need authentication" stall is structurally impossible.)
    nextChunk = 'Cogitating…\nstill working, no marker yet\n'
    await expect(
      runFileTask({ cwd: dir, prompt: 'p', file, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/i)
  })
})

// ── job layer: a sign-out before the spawn errors the job (no signed-out spawn) ─

describe('Canvas AI job — sign-out before spawn errors the job, never spawns', () => {
  let projectPath: string
  let canvasId: string
  beforeEach(async () => {
    preflight.mockReset()
    preflight.mockResolvedValue({ ok: true })
    launchClaude.mockClear()
    _resetCanvasAiJobsForTest()
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvasai-preflight-job-'))
    await registerTestProject(projectPath)
    const { canvas } = await createCanvas(projectPath, 'C1')
    canvasId = canvas.id
  })
  afterEach(async () => {
    _resetCanvasAiJobsForTest()
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('preflight passed at POST but the user signed out before the spawn → job ends "error", no spawn, nothing persisted', async () => {
    // The job is started (the POST already let it through); the spawn-time gate
    // then reports signed-out, standing in for the sign-out that landed while the
    // job sat queued / serialized.
    preflight.mockResolvedValue({
      ok: false,
      body: { error: 'Claude Code is installed but not signed in.', claudeLoggedOut: true },
    })
    const id = startGenerateJob({ projectPath, canvasId, prompt: 'two labels' })
    const ended = await waitForStatus(id, 'error')
    expect(ended.error).toMatch(/not signed in/)
    // The whole point: no signed-out claude was ever spawned.
    expect(launchClaude).not.toHaveBeenCalled()
    // And a refused run writes nothing to the canvas.
    const canvas = await readCanvasFile(projectPath, canvasId)
    expect(canvas?.elements ?? []).toEqual([])
  })
})
