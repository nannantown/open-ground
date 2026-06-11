import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  listActiveTerminalCwds,
  listActiveTerminals,
  claudeStatus,
  getTerminal,
  WORKING_SILENCE_MS,
} from './terminal'
import type { TerminalInfo } from './terminal'

// listActiveTerminalCwds is exercised through the same globalThis seam the
// module itself uses to survive tsx-watch reloads (__openground_terminal).
// Injecting fake PtySession records there keeps the test hermetic: no node-pty
// load, no real shell spawned, nothing outlives the test. (createTerminal()
// would spawn a real zsh — deliberately NOT called here; the spawn path
// belongs to e2e.)

interface FakeSessionShape {
  info: TerminalInfo
  pty: unknown
  buffer: string
  listeners: Set<unknown>
  exitListeners: Set<unknown>
}

const state = () =>
  (globalThis as { __openground_terminal?: { sessions: Map<string, FakeSessionShape> } })
    .__openground_terminal!

const fakeSession = (
  id: string,
  cwd: string,
  opts: {
    finishedAt?: string
    tag?: 'shell' | 'claude'
    lastOutputAt?: number
    menuOpen?: boolean
  } = {},
): FakeSessionShape => ({
  info: {
    id,
    cwd,
    shell: '/bin/zsh',
    cols: 100,
    rows: 30,
    startedAt: new Date().toISOString(),
    tag: opts.tag ?? 'shell',
    ...(opts.lastOutputAt !== undefined ? { lastOutputAt: opts.lastOutputAt } : {}),
    ...(opts.menuOpen !== undefined ? { menuOpen: opts.menuOpen } : {}),
    ...(opts.finishedAt ? { finishedAt: opts.finishedAt, exitCode: 0 } : {}),
  },
  pty: {},
  buffer: '',
  listeners: new Set(),
  exitListeners: new Set(),
})

beforeEach(() => {
  // Importing ./terminal above initialised the global state — start each test
  // from an empty pool. (Vitest isolates files, so no other suite sees this.)
  state().sessions.clear()
})

afterAll(() => {
  state().sessions.clear()
})

describe('listActiveTerminalCwds', () => {
  it('returns [] when no terminal exists', () => {
    expect(listActiveTerminalCwds()).toEqual([])
  })

  it('returns the cwd of a live terminal', () => {
    state().sessions.set('t1', fakeSession('t1', '/tmp/proj-a'))
    expect(listActiveTerminalCwds()).toEqual(['/tmp/proj-a'])
  })

  it('excludes exited sessions that linger in the pool for buffer drain', () => {
    // onExit stamps finishedAt and keeps the session ~30s so the client can
    // read the exit; the Ground beacon must drop the project immediately.
    state().sessions.set('live', fakeSession('live', '/tmp/proj-a'))
    state().sessions.set(
      'dead',
      fakeSession('dead', '/tmp/proj-b', { finishedAt: new Date().toISOString() }),
    )
    // sanity: the exited session is still discoverable by id…
    expect(getTerminal('dead')?.finishedAt).toBeTruthy()
    // …but only the live cwd is reported.
    expect(listActiveTerminalCwds()).toEqual(['/tmp/proj-a'])
  })

  it('dedupes multiple live PTYs in the same cwd (shell + claude panes)', () => {
    state().sessions.set('s', fakeSession('s', '/tmp/proj-a'))
    state().sessions.set('c', fakeSession('c', '/tmp/proj-a', { tag: 'claude' }))
    state().sessions.set('other', fakeSession('other', '/tmp/proj-b'))
    expect(listActiveTerminalCwds().sort()).toEqual(['/tmp/proj-a', '/tmp/proj-b'])
  })

  it('returns [] again once every terminal has exited', () => {
    state().sessions.set(
      't',
      fakeSession('t', '/tmp/proj-a', { finishedAt: new Date().toISOString() }),
    )
    expect(listActiveTerminalCwds()).toEqual([])
  })
})

describe('claudeStatus', () => {
  // Pure function — `now` is injected (house style: no fake timers).
  const NOW = 1_750_000_000_000

  const info = (over: Partial<TerminalInfo>): TerminalInfo => ({
    ...fakeSession('x', '/tmp/proj-a', { tag: 'claude' }).info,
    ...over,
  })

  it('menuOpen → waiting, even with fresh output (blocked on a permission prompt)', () => {
    expect(claudeStatus(info({ menuOpen: true, lastOutputAt: NOW - 100 }), NOW)).toBe('waiting')
  })

  it('recent output (< WORKING_SILENCE_MS) → working', () => {
    expect(claudeStatus(info({ lastOutputAt: NOW - (WORKING_SILENCE_MS - 1) }), NOW)).toBe('working')
  })

  it('silence past the threshold (or no output yet) → waiting', () => {
    expect(claudeStatus(info({ lastOutputAt: NOW - WORKING_SILENCE_MS }), NOW)).toBe('waiting')
    expect(claudeStatus(info({}), NOW)).toBe('waiting')
  })
})

describe('listActiveTerminals', () => {
  it('returns the contract shape with empty pool', () => {
    expect(listActiveTerminals()).toEqual({ cwds: [], claude: [] })
  })

  it('dedupes claude sessions per cwd — working wins over waiting', () => {
    const now = Date.now()
    // waiting first, then working: the working pane must win regardless of order.
    state().sessions.set('w1', fakeSession('w1', '/tmp/proj-a', { tag: 'claude' }))
    state().sessions.set(
      'w2',
      fakeSession('w2', '/tmp/proj-a', { tag: 'claude', lastOutputAt: now }),
    )
    // …and a waiting pane AFTER the working one must not downgrade it back.
    state().sessions.set('w3', fakeSession('w3', '/tmp/proj-a', { tag: 'claude' }))
    const res = listActiveTerminals()
    expect(res.claude).toEqual([{ cwd: '/tmp/proj-a', status: 'working' }])
    expect(res.cwds).toEqual(['/tmp/proj-a'])
  })

  it('excludes exited claude sessions lingering for buffer drain', () => {
    state().sessions.set(
      'dead',
      fakeSession('dead', '/tmp/proj-a', {
        tag: 'claude',
        lastOutputAt: Date.now(),
        finishedAt: new Date().toISOString(),
      }),
    )
    expect(listActiveTerminals()).toEqual({ cwds: [], claude: [] })
  })

  it('shell-tagged PTYs appear in cwds but never in claude', () => {
    state().sessions.set('s', fakeSession('s', '/tmp/proj-a', { lastOutputAt: Date.now() }))
    const res = listActiveTerminals()
    expect(res.cwds).toEqual(['/tmp/proj-a'])
    expect(res.claude).toEqual([])
  })
})
