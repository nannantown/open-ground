import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { TerminalInfo } from '@/lib/server/terminal'

// Route-level contract for POST /api/terminal/:id/paste — the GENERIC unsent
// paste (used by the Board drawer's "Review with claude", F064): write
// caller-supplied text into a live PTY as ONE bracketed paste with NO trailing
// newline. Same fake-PTY seam as pasteTask.test.ts (no node-pty, no shell —
// the fake's write() captures the exact bytes the route emits).

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const ETC = '/etc' // registered by NOBODY → 403

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

const fakePty = (
  id: string,
  cwd: string,
  writes: string[],
  opts: { finishedAt?: string } = {},
): void => {
  state().sessions.set(id, {
    info: {
      id,
      cwd,
      shell: '/bin/zsh',
      cols: 100,
      rows: 30,
      startedAt: new Date().toISOString(),
      tag: 'claude',
      ...(opts.finishedAt ? { finishedAt: opts.finishedAt, exitCode: 0 } : {}),
    } as TerminalInfo,
    pty: { write: (data: string) => writes.push(data) },
    buffer: '',
    listeners: new Set(),
    exitListeners: new Set(),
  })
}

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-gpaste-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-gpaste-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  state().sessions.clear()
})

afterEach(async () => {
  state().sessions.clear()
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

afterAll(() => {
  state().sessions.clear()
})

const makeRegisteredDir = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await writeFile(join(dir, 'README.md'), `# ${name}\n`)
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
  return dir
}

describe('POST /api/terminal/:id/paste — validation', () => {
  it('missing path → 400', async () => {
    const res = await app.request('/api/terminal/some-id/paste', json({ text: 'hi' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/path/i)
  })

  it('missing text → 400', async () => {
    const res = await app.request('/api/terminal/some-id/paste', json({ path: ETC }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/text/i)
  })

  it('oversized text → 400 (cap before validation/PTY work)', async () => {
    const res = await app.request(
      '/api/terminal/some-id/paste',
      json({ path: ETC, text: 'x'.repeat(256 * 1024 + 1) }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/too large/i)
  })

  it('unregistered path → 403 (validateProjectPath boundary)', async () => {
    const res = await app.request(
      '/api/terminal/some-id/paste',
      json({ path: ETC, text: 'hi' }),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/not allowed/i)
  })

  it('unknown / dead PTY id → 404', async () => {
    const dir = await makeRegisteredDir('no-pty')
    const res = await app.request(
      '/api/terminal/no-such-pty/paste',
      json({ path: dir, text: 'hi' }),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/not found/i)

    // A finished PTY is equally dead (writeInput refuses it).
    fakePty('pty-dead', dir, [], { finishedAt: new Date().toISOString() })
    const res2 = await app.request(
      '/api/terminal/pty-dead/paste',
      json({ path: dir, text: 'hi' }),
    )
    expect(res2.status).toBe(404)
  })
})

describe('POST /api/terminal/:id/paste — the paste write', () => {
  it('writes ONE bracketed paste: starts ESC[200~, ends ESC[201~, NO trailing newline', async () => {
    const dir = await makeRegisteredDir('paste-ok')
    const writes: string[] = []
    fakePty('pty-live', dir, writes)

    const text = 'Review the changes on branch task/x against main.\nDo not modify any files.'
    const res = await app.request(
      '/api/terminal/pty-live/paste',
      json({ path: dir, text }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    expect(writes).toHaveLength(1)
    const written = writes[0]
    // Insert-not-send byte contract — the whole point of the unsent paste.
    expect(written.startsWith('\x1b[200~')).toBe(true)
    expect(written.endsWith('\x1b[201~')).toBe(true)
    expect(written.endsWith('\n')).toBe(false)
    expect(written.endsWith('\r')).toBe(false)
    expect(written).toContain(text)
  })

  it('strips an embedded paste-END marker so the bracketed span stays intact (injection guard)', async () => {
    const dir = await makeRegisteredDir('esc-inject')
    const writes: string[] = []
    fakePty('pty-esc', dir, writes)

    const res = await app.request(
      '/api/terminal/pty-esc/paste',
      json({ path: dir, text: 'before\x1b[201~\rafter' }),
    )
    expect(res.status).toBe(200)
    const written = writes[0]
    // Exactly one END marker — ours, at the very end. The smuggled one is gone.
    expect(written.endsWith('\x1b[201~')).toBe(true)
    expect(written.indexOf('\x1b[201~')).toBe(written.length - '\x1b[201~'.length)
    // The body bytes survive as inert text (ESC removed, [201~ kept literal).
    expect(written).toContain('before[201~\rafter')
  })
})
