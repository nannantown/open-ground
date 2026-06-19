import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Route-level contract for the signed-out run gate (claudeRunPreflight) and the
// dedicated sign-in terminal (/api/terminal/claude-login). The bug this guards:
// a distributed build is commonly installed:true / loggedIn:false, and the run
// routes used to gate on `.installed` only — so every 実行 spawned a signed-out
// claude that opened its own OAuth browser (and a single run fans out to 2+
// spawns → "the approval screen opens in a loop"). The fix: refuse the spawn
// with 503 { claudeLoggedOut } and funnel sign-in through ONE login terminal.
//
// launchClaude is mocked — these tests assert WHETHER the route spawns and what
// 503 flag it answers, not the PTY itself (claudeTerminal.test.ts owns argv).

const launchClaude = vi.fn((opts: Record<string, unknown>) => ({
  terminalId: 'pty-x',
  agentSessionId: String(opts.agentSessionId ?? 'sid'),
  info: {
    id: 'pty-x',
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

// Mutable connection probe — each test sets installed/loggedIn for its case.
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
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { ProjectTask } from '@/lib/types'

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const loggedOut = () =>
  claudeConnection.mockResolvedValueOnce({
    installed: true,
    loggedIn: false,
    plan: null,
    email: null,
    message: 'not signed in',
  })
const notInstalled = () =>
  claudeConnection.mockResolvedValueOnce({
    installed: false,
    loggedIn: false,
    plan: null,
    email: null,
    message: 'not installed',
  })

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-login-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-login-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  launchClaude.mockClear()
  // Full reset (clears the mockResolvedValueOnce queue too, so an unconsumed
  // once-value from a prior test can't leak), then re-seed the signed-in
  // default; each test overrides with loggedOut()/notInstalled() as needed.
  claudeConnection.mockReset()
  claudeConnection.mockResolvedValue({
    installed: true,
    loggedIn: true,
    plan: null,
    email: null,
    message: 'ok',
  })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const registerDir = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await writeFile(join(dir, 'README.md'), `# ${name}\n`)
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
  return dir
}

describe('signed-out run gate (claudeRunPreflight)', () => {
  it('POST /api/terminal/claude refuses to spawn while signed out → 503 claudeLoggedOut', async () => {
    const dir = await registerDir('a')
    loggedOut()
    const res = await app.request('/api/terminal/claude', json({ cwd: dir }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.claudeLoggedOut).toBe(true)
    expect(body.claudeMissing).toBeUndefined()
    // The core of the fix: NO claude is spawned, so no OAuth browser opens.
    expect(launchClaude).not.toHaveBeenCalled()
  })

  it('POST /api/terminal/claude spawns normally once signed in', async () => {
    const dir = await registerDir('b')
    // default mock = installed:true, loggedIn:true
    const res = await app.request('/api/terminal/claude', json({ cwd: dir }))
    expect(res.status).toBe(200)
    expect(launchClaude).toHaveBeenCalledTimes(1)
  })

  it('POST /api/project/task-title refuses the auto-title spawn while signed out → 503 claudeLoggedOut', async () => {
    const dir = await registerDir('c')
    const add = await app.request('/api/project/tasks', json({ path: dir, add: ['do a thing'] }))
    expect(add.status).toBe(200)
    const task = ((await add.json()).tasks as ProjectTask[]).find((t) => t.title === 'do a thing')!
    loggedOut()
    // force:true so the route reaches the run gate (a hand-titled card would
    // otherwise no-op before it) — we're asserting the gate, not the title policy.
    const res = await app.request(
      '/api/project/task-title',
      json({ path: dir, id: task.id, force: true }),
    )
    expect(res.status).toBe(503)
    expect((await res.json()).claudeLoggedOut).toBe(true)
    expect(launchClaude).not.toHaveBeenCalled()
  })
})

describe('dedicated sign-in terminal (/api/terminal/claude-login)', () => {
  it('spawns a PLAIN claude while signed out (installed-only) — the ONE sign-in terminal', async () => {
    const dir = await registerDir('d')
    loggedOut()
    const res = await app.request('/api/terminal/claude-login', json({ cwd: dir }))
    expect(res.status).toBe(200)
    expect(launchClaude).toHaveBeenCalledTimes(1)
    const opts = launchClaude.mock.calls[0][0]
    // Plain: no prompt is sent (the user signs in; claude waits at its prompt),
    // and no app-context card is injected.
    expect(opts.initialPrompt).toBeUndefined()
    expect(opts.appContext).toBe(false)
    expect(opts.cwd).toBe(dir)
  })

  it('still 503 claudeMissing when the CLI is absent (a doomed spawn)', async () => {
    const dir = await registerDir('e')
    notInstalled()
    const res = await app.request('/api/terminal/claude-login', json({ cwd: dir }))
    expect(res.status).toBe(503)
    expect((await res.json()).claudeMissing).toBe(true)
    expect(launchClaude).not.toHaveBeenCalled()
  })

  it('rejects an unregistered cwd (validateProjectPath) → 403', async () => {
    const res = await app.request('/api/terminal/claude-login', json({ cwd: scratch }))
    expect(res.status).toBe(403)
    expect(launchClaude).not.toHaveBeenCalled()
  })
})
