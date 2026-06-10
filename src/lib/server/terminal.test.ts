import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { listActiveTerminalCwds, getTerminal } from './terminal'
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
  opts: { finishedAt?: string; tag?: 'shell' | 'claude' } = {},
): FakeSessionShape => ({
  info: {
    id,
    cwd,
    shell: '/bin/zsh',
    cols: 100,
    rows: 30,
    startedAt: new Date().toISOString(),
    tag: opts.tag ?? 'shell',
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
