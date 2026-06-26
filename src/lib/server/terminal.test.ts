import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  listActiveTerminalCwds,
  listActiveTerminals,
  claudeStatus,
  getTerminal,
  getTerminalScreen,
  killTerminalsByCwd,
  registerFlowStream,
  trackFlowSent,
  ackFlowStream,
  unregisterFlowStream,
  pickShell,
  sweepTerminalPool,
  TERMINAL_LINGER_SWEEP_MS,
  WORKING_SILENCE_MS,
  FLOW_HIGH_WATERMARK,
  FLOW_LOW_WATERMARK,
  FLOW_PAUSE_CAP_MS,
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
  // Optional like on the real PtySession — most fixtures here stay bare, which
  // is itself part of the contract (flow readers must tolerate undefined).
  flows?: Map<string, { sent: number; acked: number; controlled: boolean }>
  paused?: boolean
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

  it('lists every live claude pane with its PTY id — no per-cwd dedup', () => {
    const now = Date.now()
    // Board cards key their slot by PTY id, so each pane must be reported
    // individually; the Ground beacon aggregates per project client-side.
    state().sessions.set('w1', fakeSession('w1', '/tmp/proj-a', { tag: 'claude' }))
    state().sessions.set(
      'w2',
      fakeSession('w2', '/tmp/proj-a', { tag: 'claude', lastOutputAt: now }),
    )
    state().sessions.set('w3', fakeSession('w3', '/tmp/proj-a', { tag: 'claude' }))
    const res = listActiveTerminals()
    expect(res.claude).toEqual([
      { id: 'w1', cwd: '/tmp/proj-a', status: 'waiting' },
      { id: 'w2', cwd: '/tmp/proj-a', status: 'working' },
      { id: 'w3', cwd: '/tmp/proj-a', status: 'waiting' },
    ])
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

describe('getTerminalScreen', () => {
  // The swarm orchestrator reads this to classify WHY a worker is quiet. The
  // headless-xterm path needs a real PTY (covered by the live menu-detection
  // code); here we exercise the contract + the raw-buffer FALLBACK (a session
  // without a headless terminal), which is what the fake sessions model.
  it('returns null for an unknown session', () => {
    expect(getTerminalScreen('nope')).toBeNull()
  })

  it('returns null when the buffer is empty (no signal to classify)', () => {
    state().sessions.set('empty', fakeSession('empty', '/tmp/p'))
    expect(getTerminalScreen('empty')).toBeNull()
  })

  it('falls back to the raw buffer tail when there is no headless terminal', () => {
    const s = fakeSession('buf', '/tmp/p', { tag: 'shell' })
    s.buffer = 'booting…\nClaude usage limit reached · resets 3pm'
    state().sessions.set('buf', s)
    // The orchestrator's classifier normalizes this; here we just prove the text
    // (the rate-limit signal) reaches the caller verbatim.
    expect(getTerminalScreen('buf')).toContain('usage limit reached')
  })

  it('bounds a huge buffer to its last 4000 chars (the recent frame)', () => {
    const s = fakeSession('long', '/tmp/p')
    s.buffer = 'X'.repeat(6000) + 'TAIL_MARKER'
    state().sessions.set('long', s)
    const out = getTerminalScreen('long')
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(4000)
    expect(out!.endsWith('TAIL_MARKER')).toBe(true)
  })
})

describe('killTerminalsByCwd', () => {
  // Custom-module delete kills the sidebar claude session living in the
  // module dir before rm -rf'ing it — otherwise the PTY would outlive every
  // UI surface that could reach it.
  const killable = (
    id: string,
    cwd: string,
    kills: string[],
    opts: { finishedAt?: string } = {},
  ): FakeSessionShape => {
    const s = fakeSession(id, cwd, { tag: 'claude', ...opts })
    s.pty = { kill: () => kills.push(id) }
    return s
  }

  it('kills every live session in the cwd and reports the count', () => {
    const kills: string[] = []
    state().sessions.set('a', killable('a', '/tmp/mod-dir', kills))
    state().sessions.set('b', killable('b', '/tmp/mod-dir', kills))
    state().sessions.set('other', killable('other', '/tmp/elsewhere', kills))
    expect(killTerminalsByCwd('/tmp/mod-dir')).toBe(2)
    expect(kills.sort()).toEqual(['a', 'b'])
  })

  it('skips exited sessions lingering for buffer drain', () => {
    const kills: string[] = []
    state().sessions.set(
      'dead',
      killable('dead', '/tmp/mod-dir', kills, { finishedAt: new Date().toISOString() }),
    )
    expect(killTerminalsByCwd('/tmp/mod-dir')).toBe(0)
    expect(kills).toEqual([])
  })

  it('returns 0 on a cwd with no sessions', () => {
    expect(killTerminalsByCwd('/tmp/nowhere')).toBe(0)
  })
})

describe('flow control (ACK-based PTY pause/resume)', () => {
  // pause/resume are the only pty surface evaluateFlow touches — spy on them.
  const flowPty = (): { calls: string[]; pty: unknown } => {
    const calls: string[] = []
    return {
      calls,
      pty: { pause: () => calls.push('pause'), resume: () => calls.push('resume') },
    }
  }

  const sessionWithSpy = (id: string): { s: FakeSessionShape; calls: string[] } => {
    const s = fakeSession(id, '/tmp/proj-a', { tag: 'claude' })
    const { calls, pty } = flowPty()
    s.pty = pty
    state().sessions.set(id, s)
    return { s, calls }
  }

  // A flow only participates in pause decisions after its first ACK — mark it
  // controlled the way a real subscriber would. The 1-unit ACK credits
  // NOTHING (acked clamps to sent=0); it only flips `controlled`.
  const controlledFlow = (termId: string, streamId: string): void => {
    registerFlowStream(termId, streamId)
    ackFlowStream(termId, streamId, 1)
  }

  it('pauses when the un-acked backlog of a controlled flow exceeds HIGH', () => {
    const { s, calls } = sessionWithSpy('t')
    controlledFlow('t', 'st')
    // acked=0 (clamped), so HIGH+1 sent is exactly one past the strict
    // `> HIGH` pause threshold.
    trackFlowSent('t', 'st', FLOW_HIGH_WATERMARK + 1)
    expect(calls).toEqual(['pause'])
    expect(s.paused).toBe(true)
  })

  it('holds the pause between the watermarks, resumes below LOW (hysteresis)', () => {
    const { s, calls } = sessionWithSpy('t')
    controlledFlow('t', 'st')
    trackFlowSent('t', 'st', FLOW_HIGH_WATERMARK + 2)
    expect(calls).toEqual(['pause'])
    // Drain to backlog === LOW: `< LOW` is strict, so still paused.
    ackFlowStream('t', 'st', FLOW_HIGH_WATERMARK + 2 - FLOW_LOW_WATERMARK)
    expect(calls).toEqual(['pause'])
    expect(s.paused).toBe(true)
    // One more unit tips below LOW — resume.
    ackFlowStream('t', 'st', 1)
    expect(calls).toEqual(['pause', 'resume'])
    expect(s.paused).toBe(false)
  })

  it('clamps ACK credit to what was sent (over-ACK cannot bank negative backlog)', () => {
    const { s, calls } = sessionWithSpy('t')
    registerFlowStream('t', 'st')
    trackFlowSent('t', 'st', 10)
    // Two duplicate oversized ACKs: each clamps to `sent`, crediting 10 total…
    ackFlowStream('t', 'st', 10_000)
    ackFlowStream('t', 'st', 10_000)
    // …so the next surge still pauses (un-clamped, the banked 20 000 credit
    // would swallow it and flow control would be silently off).
    trackFlowSent('t', 'st', FLOW_HIGH_WATERMARK + 1)
    expect(calls).toEqual(['pause'])
    expect(s.paused).toBe(true)
  })

  it('never pauses for a flow that has not ACKed (legacy-client compatibility)', () => {
    const { s, calls } = sessionWithSpy('t')
    registerFlowStream('t', 'st')
    // A pre-flow-control subscriber never ACKs; no matter how far its `sent`
    // runs ahead it must not freeze the PTY for everyone.
    trackFlowSent('t', 'st', FLOW_HIGH_WATERMARK * 3)
    expect(calls).toEqual([])
    expect(s.paused).toBeFalsy()
  })

  it('unregistering the jammed stream resumes (tab closed mid-backlog)', () => {
    const { s, calls } = sessionWithSpy('t')
    controlledFlow('t', 'st')
    trackFlowSent('t', 'st', FLOW_HIGH_WATERMARK + 2)
    expect(calls).toEqual(['pause'])
    unregisterFlowStream('t', 'st')
    expect(calls).toEqual(['pause', 'resume'])
    expect(s.paused).toBe(false)
  })

  it('a healthy sibling prevents the pause — the jammed flow is stall-dropped at HIGH instead', () => {
    const { s, calls } = sessionWithSpy('t')
    const stalls: string[] = []
    registerFlowStream('t', 'fast')
    registerFlowStream('t', 'slow', () => stalls.push('slow'))
    ackFlowStream('t', 'fast', 1)
    ackFlowStream('t', 'slow', 1)
    // The fast subscriber keeps up (backlog 0 after acking its 10)…
    trackFlowSent('t', 'fast', 10)
    ackFlowStream('t', 'fast', 10)
    expect(calls).toEqual([])
    // …so when the slow one (a background-throttled tab) jams past HIGH the
    // PTY must NOT pause — that would freeze the healthy viewer's live output
    // for up to FLOW_PAUSE_CAP_MS. The jammed flow alone is dropped (onStall
    // ends its stream; the client reconnects and repaints) and the sibling
    // never misses a frame.
    trackFlowSent('t', 'slow', FLOW_HIGH_WATERMARK + 1)
    expect(calls).toEqual([])
    expect(s.paused).toBeFalsy()
    expect(stalls).toEqual(['slow'])
    expect(s.flows?.has('slow')).toBe(false)
    expect(s.flows?.has('fast')).toBe(true)
  })

  it('pauses only when EVERY controlled flow is jammed (the minimum backlog governs)', () => {
    const { s, calls } = sessionWithSpy('t')
    const stalls: string[] = []
    registerFlowStream('t', 'a', () => stalls.push('a'))
    registerFlowStream('t', 'b', () => stalls.push('b'))
    ackFlowStream('t', 'a', 1)
    ackFlowStream('t', 'b', 1)
    // b leaves the healthy band first (at exactly LOW it is no longer a
    // `< LOW` sibling), THEN a jams past HIGH: no healthy sibling justifies
    // an immediate drop, but b is not jammed either — so no pause yet and a
    // is kept.
    trackFlowSent('t', 'b', FLOW_LOW_WATERMARK)
    trackFlowSent('t', 'a', FLOW_HIGH_WATERMARK + 1)
    expect(calls).toEqual([])
    expect(s.paused).toBeFalsy()
    expect(s.flows?.has('a')).toBe(true)
    // b jams too — now every watcher is stuck and pausing is the only option.
    trackFlowSent('t', 'b', FLOW_HIGH_WATERMARK + 1 - FLOW_LOW_WATERMARK)
    expect(calls).toEqual(['pause'])
    expect(s.paused).toBe(true)
    // a drains below LOW: the PTY resumes for it, and b — still jammed past
    // HIGH, now with a healthy sibling present — is dropped on the same pass.
    ackFlowStream('t', 'a', FLOW_HIGH_WATERMARK + 1)
    expect(calls).toEqual(['pause', 'resume'])
    expect(s.paused).toBe(false)
    expect(stalls).toEqual(['b'])
    expect(s.flows?.has('b')).toBe(false)
    expect(s.flows?.has('a')).toBe(true)
  })

  it('does nothing on a finished session (no pause/resume at a dead PTY)', () => {
    const s = fakeSession('t', '/tmp/proj-a', {
      tag: 'claude',
      finishedAt: new Date().toISOString(),
    })
    const { calls, pty } = flowPty()
    s.pty = pty
    state().sessions.set('t', s)
    controlledFlow('t', 'st')
    trackFlowSent('t', 'st', FLOW_HIGH_WATERMARK * 2)
    expect(calls).toEqual([])
  })

  it('tolerates unknown ids and bare sessions without flows (no throw)', () => {
    // Bare fixture — flows undefined, exactly what every legacy test injects.
    state().sessions.set('bare', fakeSession('bare', '/tmp/proj-a'))
    expect(() => {
      trackFlowSent('bare', 'nope', 5)
      ackFlowStream('bare', 'nope', 5)
      unregisterFlowStream('bare', 'nope')
      registerFlowStream('ghost', 'nope')
      trackFlowSent('ghost', 'nope', 5)
      ackFlowStream('ghost', 'nope', 5)
      unregisterFlowStream('ghost', 'nope')
    }).not.toThrow()
  })

  describe('pause duration cap (FLOW_PAUSE_CAP_MS)', () => {
    // A background-throttled renderer stops draining xterm, so its ACKs stop
    // for minutes — without the cap that would hold the PTY paused until
    // claude hard-blocks on a full kernel buffer. Unlike claudeStatus there is
    // no injectable `now` seam: the cap firing with NO further flow events at
    // all IS the contract, so this block runs on vitest's fake clock.
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('drops the jammed flow at the cap: onStall fires, the PTY resumes', () => {
      const { s, calls } = sessionWithSpy('t')
      const stalls: string[] = []
      registerFlowStream('t', 'st', () => stalls.push('st'))
      ackFlowStream('t', 'st', 1)
      trackFlowSent('t', 'st', FLOW_HIGH_WATERMARK + 2)
      expect(calls).toEqual(['pause'])
      // Not a millisecond early…
      vi.advanceTimersByTime(FLOW_PAUSE_CAP_MS - 1)
      expect(stalls).toEqual([])
      expect(s.paused).toBe(true)
      // …then at the cap: flow dropped, its stream told to end, PTY resumed.
      vi.advanceTimersByTime(1)
      expect(stalls).toEqual(['st'])
      expect(calls).toEqual(['pause', 'resume'])
      expect(s.paused).toBe(false)
      expect(s.flows?.has('st')).toBe(false)
    })

    it('a drain below LOW before the cap disarms it — no stall, flow kept', () => {
      const { s, calls } = sessionWithSpy('t')
      const stalls: string[] = []
      registerFlowStream('t', 'st', () => stalls.push('st'))
      ackFlowStream('t', 'st', 1)
      trackFlowSent('t', 'st', FLOW_HIGH_WATERMARK + 2)
      expect(calls).toEqual(['pause'])
      // Healthy client catches up in time — resume disarms the timer.
      ackFlowStream('t', 'st', FLOW_HIGH_WATERMARK + 2)
      expect(calls).toEqual(['pause', 'resume'])
      vi.advanceTimersByTime(FLOW_PAUSE_CAP_MS * 2)
      expect(stalls).toEqual([])
      expect(s.flows?.has('st')).toBe(true)
    })

    it('drops EVERY controlled flow still ≥ LOW at the cap (a kept one would pin the pause, timer spent), spares uncontrolled ones', () => {
      const { s, calls } = sessionWithSpy('t')
      const stalls: string[] = []
      registerFlowStream('t', 'jam', () => stalls.push('jam'))
      registerFlowStream('t', 'mid', () => stalls.push('mid'))
      registerFlowStream('t', 'legacy', () => stalls.push('legacy'))
      ackFlowStream('t', 'jam', 1)
      ackFlowStream('t', 'mid', 1)
      // legacy never ACKs — uncontrolled, exempt from decisions and drops alike.
      trackFlowSent('t', 'legacy', FLOW_HIGH_WATERMARK * 3)
      // March both controlled flows out of the healthy band together, then
      // past HIGH (one jamming while the other was still < LOW would be
      // immediate-dropped before any pause — see the sibling tests above).
      trackFlowSent('t', 'jam', FLOW_LOW_WATERMARK)
      trackFlowSent('t', 'mid', FLOW_LOW_WATERMARK)
      trackFlowSent('t', 'jam', FLOW_HIGH_WATERMARK + 2 - FLOW_LOW_WATERMARK)
      expect(calls).toEqual([])
      trackFlowSent('t', 'mid', FLOW_HIGH_WATERMARK + 1 - FLOW_LOW_WATERMARK)
      expect(calls).toEqual(['pause'])
      // mid claws back into the hysteresis band (backlog EXACTLY LOW) — not
      // enough: resume needs `< LOW`, so the pause and its cap timer stand.
      ackFlowStream('t', 'mid', FLOW_HIGH_WATERMARK + 1 - FLOW_LOW_WATERMARK)
      expect(calls).toEqual(['pause'])
      vi.advanceTimersByTime(FLOW_PAUSE_CAP_MS)
      // Both controlled flows were still ≥ LOW — both dropped (keeping mid
      // would hold the pause forever: the cap timer is spent and mid alone
      // can never satisfy `< LOW` without draining)…
      expect(stalls).toEqual(['jam', 'mid'])
      expect(calls).toEqual(['pause', 'resume'])
      // …while the uncontrolled legacy flow rides on, exempt as ever.
      expect(s.flows?.has('legacy')).toBe(true)
      expect(s.flows?.has('jam')).toBe(false)
      expect(s.flows?.has('mid')).toBe(false)
    })

    it('a cap firing after exit does nothing (no resume at a dead PTY, no stall)', () => {
      const { s, calls } = sessionWithSpy('t')
      const stalls: string[] = []
      registerFlowStream('t', 'st', () => stalls.push('st'))
      ackFlowStream('t', 'st', 1)
      trackFlowSent('t', 'st', FLOW_HIGH_WATERMARK + 2)
      expect(calls).toEqual(['pause'])
      // Mimic onExit landing between pause and cap: finishedAt + flows
      // dropped. (The real handler also clears the timer — the guard must
      // hold even if a stale callback still fires.)
      s.info.finishedAt = new Date().toISOString()
      s.flows?.clear()
      vi.advanceTimersByTime(FLOW_PAUSE_CAP_MS)
      expect(stalls).toEqual([])
      expect(calls).toEqual(['pause'])
    })
  })
})

describe('pickShell (host shell selection per platform)', () => {
  // platform / env are injectable so both branches test on one host.
  it('Windows ALWAYS uses PowerShell, even when a stray POSIX $SHELL is set', () => {
    // The claude launch-command framing (claudeTerminal.buildLaunchCommand) is
    // PowerShell-specific, so a SHELL inherited from a Git Bash / MSYS launch
    // must not win on win32 (it would pick a shell that framing can't drive).
    expect(pickShell('win32', {})).toBe('powershell.exe')
    expect(pickShell('win32', { SHELL: '/usr/bin/bash' })).toBe('powershell.exe')
  })

  it('POSIX honours $SHELL, falling back to /bin/zsh', () => {
    expect(pickShell('darwin', { SHELL: '/bin/fish' })).toBe('/bin/fish')
    expect(pickShell('linux', {})).toBe('/bin/zsh')
  })

  it('OPENGROUND_TERMINAL_SHELL overrides on every platform', () => {
    expect(pickShell('win32', { OPENGROUND_TERMINAL_SHELL: 'pwsh.exe' })).toBe('pwsh.exe')
    expect(
      pickShell('darwin', { OPENGROUND_TERMINAL_SHELL: '/bin/bash', SHELL: '/bin/zsh' }),
    ).toBe('/bin/bash')
  })
})

describe('sweepTerminalPool — reaps dead pool entries, never kills', () => {
  const NOW = 1_000_000_000_000

  // Build a fake session with controllable pid + populated listener sets, so we
  // can assert the sweep both DROPS the entry and RELEASES its listeners.
  const fake = (
    id: string,
    opts: { finishedAt?: string; pid?: number } = {},
  ): FakeSessionShape & { pty: { pid?: number }; killed: boolean } => {
    const s = fakeSession(id, '/tmp/p', opts.finishedAt ? { finishedAt: opts.finishedAt } : {}) as
      FakeSessionShape & { pty: { pid?: number; kill: () => void }; killed: boolean }
    s.listeners.add(() => {})
    s.exitListeners.add(() => {})
    s.killed = false
    s.pty = { ...(opts.pid !== undefined ? { pid: opts.pid } : {}), kill: () => { s.killed = true } }
    return s
  }

  it('reaps an EXITED session past the linger window and releases its listeners', () => {
    const s = fake('done', { finishedAt: new Date(NOW - TERMINAL_LINGER_SWEEP_MS - 1).toISOString() })
    state().sessions.set('done', s)

    const res = sweepTerminalPool({ now: NOW })

    expect(res.swept).toEqual(['done'])
    expect(res.kept).toBe(0)
    expect(state().sessions.has('done')).toBe(false)
    expect(s.listeners.size).toBe(0)
    expect(s.exitListeners.size).toBe(0)
    expect(s.killed).toBe(false) // a dead PTY is never signalled
  })

  it('KEEPS an exited session still within the linger window', () => {
    const s = fake('recent', { finishedAt: new Date(NOW - 5_000).toISOString() })
    state().sessions.set('recent', s)

    const res = sweepTerminalPool({ now: NOW })

    expect(res.swept).toEqual([])
    expect(res.kept).toBe(1)
    expect(state().sessions.has('recent')).toBe(true)
  })

  it('reconciles an ORPHAN (no finishedAt, pid confirmed dead): stamps exit, fires exitListeners, drops it', () => {
    const s = fake('orphan', { pid: 4242 })
    let exitInfo: TerminalInfo | null = null
    s.exitListeners.clear()
    s.exitListeners.add((info: unknown) => { exitInfo = info as TerminalInfo })
    state().sessions.set('orphan', s)

    // isAlive injected → pid 4242 reported dead.
    const res = sweepTerminalPool({ now: NOW, isAlive: () => false })

    expect(res.swept).toEqual(['orphan'])
    expect(state().sessions.has('orphan')).toBe(false)
    expect(exitInfo).not.toBeNull()
    expect(exitInfo!.finishedAt).toBe(new Date(NOW).toISOString()) // stamped
    expect(s.listeners.size).toBe(0)
    expect(s.killed).toBe(false) // reconcile only — already-dead process is not signalled
  })

  it('KEEPS a live session (no finishedAt, pid alive)', () => {
    const s = fake('live', { pid: 4243 })
    state().sessions.set('live', s)

    const res = sweepTerminalPool({ now: NOW, isAlive: () => true })

    expect(res.swept).toEqual([])
    expect(res.kept).toBe(1)
    expect(state().sessions.has('live')).toBe(true)
  })

  it('leaves a running session WITHOUT a real pid untouched (cannot verify liveness)', () => {
    // The bare test/legacy fixtures carry `pty: {}` — no pid. The orphan probe
    // must never reap those: an unverifiable session is treated as alive.
    const s = fakeSession('bare', '/tmp/p') // pty: {}, no finishedAt
    state().sessions.set('bare', s)

    const res = sweepTerminalPool({ now: NOW, isAlive: () => false })

    expect(res.swept).toEqual([])
    expect(res.kept).toBe(1)
    expect(state().sessions.has('bare')).toBe(true)
  })

  it('sweeps a MIXED pool: dead entries go, live ones stay', () => {
    state().sessions.set('exited', fake('exited', {
      finishedAt: new Date(NOW - TERMINAL_LINGER_SWEEP_MS - 1).toISOString(),
    }))
    state().sessions.set('lingering', fake('lingering', { finishedAt: new Date(NOW - 1_000).toISOString() }))
    state().sessions.set('orphan', fake('orphan', { pid: 99 }))
    state().sessions.set('alive', fake('alive', { pid: 100 }))

    const res = sweepTerminalPool({ now: NOW, isAlive: (pid) => pid === 100 })

    expect(res.swept.sort()).toEqual(['exited', 'orphan'])
    expect(res.kept).toBe(2) // lingering + alive
  })

  it('default lingerMs is the documented 60s safety-net constant (> the 30s onExit timer)', () => {
    expect(TERMINAL_LINGER_SWEEP_MS).toBe(60_000)
    expect(TERMINAL_LINGER_SWEEP_MS).toBeGreaterThan(30_000)
  })
})
