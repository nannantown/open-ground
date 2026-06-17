import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Route-level contract for the custom-tab terminal seam
// (server/routes/terminal.ts: POST /api/terminal/custom-module and
// POST /api/terminal/:id/paste-custom-module). The module dir is NOT a
// registered project, so the boundary is role (owner OR tester — only 'none'
// forbidden) + server-resolved cwd — validateProjectPath is never involved.
// The PTY is faked via the same globalThis seam as pasteTask.test.ts, so the
// paste assertions capture the exact bytes the route emits; launchClaude is
// mocked (runTaskLaunch.test.ts pattern) so the happy-path launch never spawns
// a real node-pty, and claudeConnection is mocked so the pre-flight probe
// passes without a real `claude` binary (the 503 case drives a miss through
// the mock).

const launchClaude = vi.fn((opts: Record<string, unknown>) => ({
  terminalId: 'pty-cm',
  agentSessionId: String(opts.agentSessionId ?? 'sid'),
  info: {
    id: 'pty-cm',
    cwd: String(opts.cwd ?? ''),
    shell: '/bin/zsh',
    cols: 100,
    rows: 30,
    startedAt: new Date().toISOString(),
    tag: 'claude',
  },
}))

vi.mock('@/lib/server/claudeTerminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/claudeTerminal')>()
  return { ...actual, launchClaude: (opts: Record<string, unknown>) => launchClaude(opts) }
})

// Pre-flight connection probe: installed by default (no real `claude` needed);
// the 503 test flips it to a miss via mockResolvedValueOnce.
const claudeConnection = vi.fn(async () => ({
  installed: true,
  loggedIn: true,
  plan: null,
  email: null,
  message: 'ok',
}))

vi.mock('@/lib/server/claudeConnection', () => ({
  claudeConnection: () => claudeConnection(),
}))

import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { customModuleDir } from '@/lib/server/paths'
import type { TerminalInfo } from '@/lib/server/terminal'
import type { CustomModuleDef } from '@/lib/types'

const OWNER = 'owner@example.com'
const TESTER = 'tester@example.com'

// Roles ship with NO built-in emails (the binary must not identify anyone) —
// grant them explicitly through the env override so these route tests stay
// network-free (the override skips the Supabase og_roles lookup).
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

interface FakeSessionShape {
  info: TerminalInfo
  pty: { write: (data: string) => void }
  buffer: string
  listeners: Set<unknown>
  exitListeners: Set<unknown>
}

const state = () =>
  (globalThis as { __openground_terminal?: { sessions: Map<string, FakeSessionShape> } })
    .__openground_terminal!

// Importing ../../app pulls in terminal.ts, which initialises the global pool.
const fakePty = (id: string, cwd: string, writes: string[]): void => {
  state().sessions.set(id, {
    info: {
      id,
      cwd,
      shell: '/bin/zsh',
      cols: 100,
      rows: 30,
      startedAt: new Date().toISOString(),
      tag: 'claude',
    } as TerminalInfo,
    pty: { write: (data: string) => writes.push(data) },
    buffer: '',
    listeners: new Set(),
    exitListeners: new Set(),
  })
}

const createModuleAsOwner = async (
  label = 'Term Tab',
  description = 'edits itself',
): Promise<CustomModuleDef> => {
  await signInAs(OWNER)
  const res = await app.request('/api/custom-modules', json({ label, description }))
  expect(res.status).toBe(200)
  return res.json()
}

let home: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'og-custom-term-'))
  process.env.OPENGROUND_HOME = home
  state().sessions.clear()
  launchClaude.mockClear()
  claudeConnection.mockClear()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  state().sessions.clear()
  await clearSession()
  process.env.OPENGROUND_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe('POST /api/terminal/custom-module — role gate (owner|tester) + id validation', () => {
  it('403 forbidden when signed out (role none)', async () => {
    const res = await app.request('/api/terminal/custom-module', json({ moduleId: 'x' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden')
  })

  it('owner MAY launch a sidebar claude session in the module dir', async () => {
    const def = await createModuleAsOwner()
    const res = await app.request('/api/terminal/custom-module', json({ moduleId: def.id }))
    expect(res.status).toBe(200)
    // launchClaude got the SERVER-resolved module dir (never a client cwd) and
    // appContext:false (the board/canvas usage card is meaningless here).
    expect(launchClaude).toHaveBeenCalledTimes(1)
    const opts = launchClaude.mock.calls.at(-1)![0]
    expect(opts.cwd).toBe(customModuleDir(def.id))
    expect(opts.appContext).toBe(false)
  })

  it('a tester MAY launch one too (authoring is open to testers)', async () => {
    // Create as owner (deterministic), then act as the tester.
    const def = await createModuleAsOwner()
    await signInAs(TESTER)
    const res = await app.request('/api/terminal/custom-module', json({ moduleId: def.id }))
    expect(res.status).toBe(200)
    expect(launchClaude).toHaveBeenCalledTimes(1)
    expect(launchClaude.mock.calls.at(-1)![0].cwd).toBe(customModuleDir(def.id))
  })

  it('400 when moduleId is missing', async () => {
    await signInAs(OWNER)
    const res = await app.request('/api/terminal/custom-module', json({}))
    expect(res.status).toBe(400)
  })

  it('404 for a traversal-shaped id (never reaches the filesystem)', async () => {
    await signInAs(OWNER)
    const res = await app.request(
      '/api/terminal/custom-module',
      json({ moduleId: '../../../etc' }),
    )
    expect(res.status).toBe(404)
  })

  it('404 for an unknown uuid', async () => {
    await signInAs(OWNER)
    const res = await app.request(
      '/api/terminal/custom-module',
      json({ moduleId: '123e4567-e89b-42d3-a456-426614174000' }),
    )
    expect(res.status).toBe(404)
  })

  it('503 claudeMissing when the claude CLI cannot be found', async () => {
    // Drive the miss through the mocked probe (the real probe + its 10s cache
    // are bypassed file-wide here). launchClaude must NOT be reached.
    claudeConnection.mockResolvedValueOnce({
      installed: false,
      loggedIn: false,
      plan: null,
      email: null,
      message: 'claude not found',
    })
    const def = await createModuleAsOwner()
    const res = await app.request('/api/terminal/custom-module', json({ moduleId: def.id }))
    expect(res.status).toBe(503)
    expect((await res.json()).claudeMissing).toBe(true)
    expect(launchClaude).not.toHaveBeenCalled()
  })
})

describe('POST /api/terminal/:id/paste-custom-module', () => {
  it('403 forbidden when signed out (role none)', async () => {
    const def = await createModuleAsOwner()
    await clearSession()
    const res = await app.request(
      '/api/terminal/t1/paste-custom-module',
      json({ moduleId: def.id }),
    )
    expect(res.status).toBe(403)
  })

  it('404 for an unknown module / unknown terminal', async () => {
    await signInAs(OWNER)
    expect(
      (
        await app.request(
          '/api/terminal/t1/paste-custom-module',
          json({ moduleId: '123e4567-e89b-42d3-a456-426614174000' }),
        )
      ).status,
    ).toBe(404)

    const def = await createModuleAsOwner()
    expect(
      (
        await app.request('/api/terminal/no-such-terminal/paste-custom-module', json({ moduleId: def.id }))
      ).status,
    ).toBe(404)
  })

  it("403 when the terminal's cwd is not this module's dir", async () => {
    const def = await createModuleAsOwner()
    const writes: string[] = []
    fakePty('t-elsewhere', '/somewhere/else', writes)
    const res = await app.request(
      '/api/terminal/t-elsewhere/paste-custom-module',
      json({ moduleId: def.id }),
    )
    expect(res.status).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('injects the brush-up prompt as ONE bracketed paste with no trailing newline', async () => {
    const def = await createModuleAsOwner('Paste Tab', 'paste me')
    const writes: string[] = []
    fakePty('t-module', customModuleDir(def.id), writes)

    const res = await app.request(
      '/api/terminal/t-module/paste-custom-module',
      json({ moduleId: def.id }),
    )
    expect(res.status).toBe(200)
    expect(writes).toHaveLength(1)
    const out = writes[0]
    // Bracketed-paste framing, insert-not-send.
    expect(out.startsWith('\x1b[200~')).toBe(true)
    expect(out.endsWith('\x1b[201~')).toBe(true)
    expect(out.endsWith('\n')).toBe(false)
    // The prompt carries the tab's label + description + the source.tsx
    // editing instructions (react module).
    expect(out).toContain('Paste Tab')
    expect(out).toContain('paste me')
    expect(out).toContain('source.tsx')
    expect(out).toContain('hot-reloads')
  })

  it('a tester MAY paste into a session in the module dir', async () => {
    const def = await createModuleAsOwner('Tester Paste', 'paste me')
    await signInAs(TESTER)
    const writes: string[] = []
    fakePty('t-module', customModuleDir(def.id), writes)

    const res = await app.request(
      '/api/terminal/t-module/paste-custom-module',
      json({ moduleId: def.id }),
    )
    expect(res.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0].startsWith('\x1b[200~')).toBe(true)
  })
})
