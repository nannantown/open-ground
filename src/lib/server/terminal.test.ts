import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  listActiveTerminalCwds,
  listActiveTerminals,
  claudeSessionActivity,
  isClaudeSessionLive,
  claudeStatus,
  scheduleMenuDetect,
  getTerminal,
  getTerminalScreen,
  killTerminalsByCwd,
  killTerminalsByCwdAndWait,
  waitForTerminalGone,
  registerFlowStream,
  trackFlowSent,
  ackFlowStream,
  unregisterFlowStream,
  pickShell,
  sweepTerminalPool,
  isTerminalProcessAlive,
  startTerminalSweepLoop,
  stopTerminalSweepLoop,
  TERMINAL_LINGER_SWEEP_MS,
  TERMINAL_SWEEP_INTERVAL_MS,
  JUST_HANDED_BACK_MS,
  WORKING_SILENCE_MS,
  FLOW_HIGH_WATERMARK,
  FLOW_LOW_WATERMARK,
  FLOW_PAUSE_CAP_MS,
} from './terminal'
import type { TerminalInfo } from './terminal'
import { Terminal as HeadlessTerminal } from '@xterm/headless'

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
    hidden?: boolean
    agentSessionId?: string
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
    ...(opts.agentSessionId !== undefined ? { agentSessionId: opts.agentSessionId } : {}),
    ...(opts.lastOutputAt !== undefined ? { lastOutputAt: opts.lastOutputAt } : {}),
    ...(opts.menuOpen !== undefined ? { menuOpen: opts.menuOpen } : {}),
    ...(opts.hidden ? { hidden: true } : {}),
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

  it('INCLUDES a hidden utility session — it is the liveness primitive, not the beacon', () => {
    // worktreeCleanup reads this to never reap a worktree with a live PTY in it,
    // so a background auto-title/describe session (hidden) must still count here —
    // only the user-facing beacon (listActiveTerminals) filters hidden out.
    state().sessions.set(
      'util',
      fakeSession('util', '/tmp/proj-a', { tag: 'claude', hidden: true }),
    )
    expect(listActiveTerminalCwds()).toEqual(['/tmp/proj-a'])
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

  it('JUST stopped painting → waiting: the turn really did come back to you', () => {
    expect(claudeStatus(info({ lastOutputAt: NOW - WORKING_SILENCE_MS }), NOW)).toBe('waiting')
    expect(claudeStatus(info({ lastOutputAt: NOW - (JUST_HANDED_BACK_MS - 1) }), NOW)).toBe(
      'waiting',
    )
  })

  it('LONG silence → idle, NOT waiting — a parked desk is not your turn', () => {
    // THE BUG (owner, 2026-08-15): three Ground cards stamped WAITING with every
    // task done. Each project held a commander/supply desk that had been sitting
    // at its prompt for hours; the classifier had no third answer, so "not
    // working" meant "sitting on the human". An amber stamp that is usually
    // wrong teaches the reader to ignore the one that is right.
    expect(claudeStatus(info({ lastOutputAt: NOW - JUST_HANDED_BACK_MS }), NOW)).toBe('idle')
    expect(claudeStatus(info({ lastOutputAt: NOW - 6 * 60 * 60 * 1000 }), NOW)).toBe('idle')
    // Never produced output at all — a desk that booted and has said nothing.
    expect(claudeStatus(info({}), NOW)).toBe('idle')
  })

  it('a MENU still outranks everything — that one really is blocked on you', () => {
    // The one case where age is irrelevant: a permission prompt open for six
    // hours is still a prompt waiting for a human.
    expect(
      claudeStatus(info({ menuOpen: true, lastOutputAt: NOW - 6 * 60 * 60 * 1000 }), NOW),
    ).toBe('waiting')
  })
})

describe('scheduleMenuDetect — menu verdict across a post-approval work burst', () => {
  // The bug: after the human answers a permission prompt, claude immediately
  // floods tool output (chunks < MENU_DETECT_DEBOUNCE_MS apart). The trailing
  // debounce kept getting cleared + rescheduled on every chunk and so NEVER
  // fired, leaving menuOpen pinned to the `true` it held before the answer — and
  // claudeStatus short-circuits menuOpen to 'waiting', so the beacon stuck on
  // "waiting" for the whole burst even though claude was plainly working. The fix
  // is the EAGER clear inside scheduleMenuDetect: fresh output ⇒ the screen is
  // repainting ⇒ not a static menu ⇒ drop the stale verdict at once; the
  // settled-frame detect re-confirms a real menu so the clear is self-correcting.
  //
  // These drive the REAL headless screen model (vitest's default `node` env;
  // setup-home redirects OPENGROUND_HOME to a tmp dir, so HOME stays isolated).

  type MenuSession = Parameters<typeof scheduleMenuDetect>[0]

  const claudeSessionWithScreen = (): { session: MenuSession; headless: HeadlessTerminal } => {
    const headless = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 0 })
    const info: TerminalInfo = {
      id: 'menu-test',
      cwd: '/tmp/proj-a',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
      startedAt: new Date().toISOString(),
      tag: 'claude',
    }
    const session = {
      info,
      pty: {},
      buffer: '',
      listeners: new Set<(c: string) => void>(),
      exitListeners: new Set<(i: TerminalInfo) => void>(),
      headless,
      menuTimer: null as ReturnType<typeof setTimeout> | null,
    }
    return { session: session as MenuSession, headless }
  }

  // Resolve once xterm has parsed the chunk into the buffer — a deterministic
  // flush that doesn't depend on xterm's internal write scheduling.
  const writeScreen = (h: HeadlessTerminal, data: string): Promise<void> =>
    new Promise((resolve) => h.write(data, () => resolve()))

  // Poll a postcondition instead of sleeping a fixed span: robust under CPU load
  // (a delayed 350ms debounce timer just makes us poll a little longer, up to a
  // cap far below vitest's 5s test timeout — see the flaky-load-test lesson).
  const waitFor = async (pred: () => boolean, capMs = 3000): Promise<void> => {
    const start = Date.now()
    while (!pred()) {
      if (Date.now() - start > capMs) throw new Error('waitFor: condition not met within cap')
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  it('keeps the beacon on working through a burst (no stuck waiting after approval)', async () => {
    const { session, headless } = claudeSessionWithScreen()
    // Pre-approval: the permission menu was detected, so the beacon is waiting.
    session.info.menuOpen = true
    session.info.lastOutputAt = Date.now()
    expect(claudeStatus(session.info, Date.now())).toBe('waiting')

    // The human answers; claude floods non-menu tool output. Each chunk is one
    // pty.onData → scheduleMenuDetect. In the bug the debounce never fired and
    // menuOpen stayed true the entire burst.
    for (const chunk of ['● Running tool…\r\n', 'reading files\r\n', 'applying edit\r\n', 'done step\r\n']) {
      await writeScreen(headless, chunk)
      scheduleMenuDetect(session)
      // The eager clear fires synchronously on every chunk — working THROUGHOUT,
      // without waiting for any debounce to fire.
      expect(session.info.menuOpen).toBe(false)
      session.info.lastOutputAt = Date.now()
      expect(claudeStatus(session.info, Date.now())).toBe('working')
    }

    // Once output settles the debounce reads a menu-free frame and confirms the
    // clear — it must NOT flip back to waiting.
    await waitFor(() => session.menuTimer === null)
    expect(session.info.menuOpen).toBe(false)
    expect(claudeStatus(session.info, Date.now())).toBe('working')

    // Normal transition still holds: true idle past the silence window ⇒ waiting.
    expect(
      claudeStatus({ ...session.info, lastOutputAt: Date.now() - WORKING_SILENCE_MS }, Date.now()),
    ).toBe('waiting')
    headless.dispose()
  })

  it('re-flags a genuinely open menu after the frame settles (a real prompt still reads waiting)', async () => {
    const { session, headless } = claudeSessionWithScreen()
    // claude paints a permission prompt, then goes quiet on the human.
    await writeScreen(headless, 'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n')
    session.info.lastOutputAt = Date.now()
    scheduleMenuDetect(session)
    // The eager clear optimistically dropped it on that paint chunk…
    expect(session.info.menuOpen).toBe(false)
    // …but the settled-frame detect restores the verdict, so the beacon reads
    // waiting while the prompt is actually up — the eager clear is self-correcting.
    await waitFor(() => session.info.menuOpen === true)
    expect(claudeStatus(session.info, Date.now())).toBe('waiting')
    headless.dispose()
  })

  it('is a no-op on a session with no headless screen (a plain shell — never touches menuOpen)', () => {
    const { session, headless } = claudeSessionWithScreen()
    headless.dispose()
    session.headless = null
    session.info.menuOpen = true
    scheduleMenuDetect(session)
    // No headless ⇒ no screen model to consult; the field is left untouched and
    // no debounce is armed (the eager clear stays gated behind the headless guard).
    expect(session.info.menuOpen).toBe(true)
    expect(session.menuTimer).toBeNull()
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
      // w1/w3 never painted, so they are `idle` — live, but claiming nothing.
      { id: 'w1', cwd: '/tmp/proj-a', status: 'idle' },
      { id: 'w2', cwd: '/tmp/proj-a', status: 'working' },
      { id: 'w3', cwd: '/tmp/proj-a', status: 'idle' },
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

  it('EXCLUDES a hidden utility claude session from BOTH cwds and claude (no spurious beacon)', () => {
    // generateTaskTitle / generateProjectDescription spawn a real claude PTY
    // (tag:'claude') with hidden:true purely to marker-scrape its output — there
    // is no pane the user opened, so it must not flash "claude working" on the
    // project's Ground card. It is the ONLY live session here, so a leak would
    // show up as a non-empty payload.
    state().sessions.set(
      'util',
      fakeSession('util', '/tmp/proj-a', { tag: 'claude', lastOutputAt: Date.now(), hidden: true }),
    )
    expect(listActiveTerminals()).toEqual({ cwds: [], claude: [] })
  })

  it('a hidden utility session never masks a real user session in the SAME project', () => {
    // A user has a visible claude pane open in proj-a while a background auto-title
    // run (hidden) fires in the same cwd: the beacon must still report the user's
    // pane (by its own PTY id), and the hidden one must never appear.
    state().sessions.set(
      'user',
      fakeSession('user', '/tmp/proj-a', { tag: 'claude', lastOutputAt: Date.now() }),
    )
    state().sessions.set(
      'util',
      fakeSession('util', '/tmp/proj-a', { tag: 'claude', lastOutputAt: Date.now(), hidden: true }),
    )
    const res = listActiveTerminals()
    expect(res.cwds).toEqual(['/tmp/proj-a'])
    expect(res.claude).toEqual([{ id: 'user', cwd: '/tmp/proj-a', status: 'working' }])
  })
})

// ── claudeSessionActivity — liveness + ACTIVITY for a persisted session id ──────
// The swarm commander monitor's primitive (2026-07-18). isClaudeSessionLive answers
// only "is a PTY holding this transcript open?"; conflating that single bit with
// heartbeat silence made the engine declare a LIVE, working commander dead and respawn
// it three times. `lastOutputAt` is the second channel that distinguishes a quiet desk
// from a gone one, and `terminalId` is the PTY a nudge is written to.
describe('claudeSessionActivity', () => {
  it('reports a live session with its newest paint and the PTY to address', () => {
    const now = Date.now()
    state().sessions.set(
      'm1',
      fakeSession('m1', '/tmp/proj-a', { tag: 'claude', agentSessionId: 'sess-1', lastOutputAt: now }),
    )
    expect(claudeSessionActivity('sess-1')).toEqual({
      live: true,
      lastOutputAt: now,
      terminalId: 'm1',
    })
    expect(isClaudeSessionLive('sess-1')).toBe(true) // the wrapper agrees
  })

  it('a live PTY that has NEVER painted is still live, and is still addressable', () => {
    // The distinction the whole fix rests on: no output ≠ no process. A desk that has
    // not painted must remain nudge-able rather than be treated as absent.
    state().sessions.set(
      'm2',
      fakeSession('m2', '/tmp/proj-a', { tag: 'claude', agentSessionId: 'sess-2' }),
    )
    expect(claudeSessionActivity('sess-2')).toEqual({
      live: true,
      lastOutputAt: null,
      terminalId: 'm2',
    })
  })

  it('an EXITED session is not live — its id is free to resume and there is nothing to nudge', () => {
    state().sessions.set(
      'm3',
      fakeSession('m3', '/tmp/proj-a', {
        tag: 'claude',
        agentSessionId: 'sess-3',
        lastOutputAt: Date.now(),
        finishedAt: new Date().toISOString(),
      }),
    )
    expect(claudeSessionActivity('sess-3')).toEqual({
      live: false,
      lastOutputAt: null,
      terminalId: null,
    })
    expect(isClaudeSessionLive('sess-3')).toBe(false)
  })

  it('unknown / empty session ids report absent rather than throwing', () => {
    expect(claudeSessionActivity('nope')).toEqual({ live: false, lastOutputAt: null, terminalId: null })
    expect(claudeSessionActivity('')).toEqual({ live: false, lastOutputAt: null, terminalId: null })
  })

  it('with several live PTYs on one id, the NEWEST-painting one is the one to address', () => {
    const now = Date.now()
    state().sessions.set(
      'old',
      fakeSession('old', '/tmp/proj-a', { tag: 'claude', agentSessionId: 'dup', lastOutputAt: now - 60_000 }),
    )
    state().sessions.set(
      'new',
      fakeSession('new', '/tmp/proj-a', { tag: 'claude', agentSessionId: 'dup', lastOutputAt: now }),
    )
    expect(claudeSessionActivity('dup')).toEqual({ live: true, lastOutputAt: now, terminalId: 'new' })
  })

  it('a HIDDEN utility session still counts — it is a real claude process holding the id', () => {
    // Mirrors isClaudeSessionLive's documented rule (unlike the user-facing beacon,
    // which filters hidden sessions out).
    state().sessions.set(
      'util',
      fakeSession('util', '/tmp/proj-a', { tag: 'claude', agentSessionId: 'sess-h', hidden: true }),
    )
    expect(claudeSessionActivity('sess-h').live).toBe(true)
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

describe('isTerminalProcessAlive — OS-confirmed liveness (the Restart-race guard, MF3)', () => {
  const fake = (
    id: string,
    opts: { finishedAt?: string; pid?: number } = {},
  ): FakeSessionShape & { pty: { pid?: number } } => {
    const s = fakeSession(id, '/tmp/p', opts.finishedAt ? { finishedAt: opts.finishedAt } : {}) as
      FakeSessionShape & { pty: { pid?: number } }
    s.pty = opts.pid !== undefined ? { pid: opts.pid } : {}
    return s
  }

  it('an unknown terminal id is never alive', () => {
    expect(isTerminalProcessAlive('nope')).toBe(false)
  })

  it('a session already stamped finishedAt is never alive, even if a pid check would say yes', () => {
    state().sessions.set('done', fake('done', { finishedAt: new Date().toISOString(), pid: 111 }))
    expect(isTerminalProcessAlive('done', () => true)).toBe(false)
  })

  it('defers to the injected isAlive for a session carrying a real pid', () => {
    state().sessions.set('live', fake('live', { pid: 222 }))
    expect(isTerminalProcessAlive('live', () => true)).toBe(true)
    state().sessions.set('dead', fake('dead', { pid: 333 }))
    expect(isTerminalProcessAlive('dead', () => false)).toBe(false)
  })

  it('a session WITHOUT a real numeric pid is reported ALIVE — absence of evidence is not evidence of death (the guard the mutant kills)', () => {
    // The bare test/legacy fixture shape: pty:{} carries no pid at all. Flipping
    // this branch to `false` would make isTerminalProcessAlive reap sessions it
    // cannot actually verify — the same class of over-eager reap sweepTerminalPool
    // deliberately avoids for the identical fixture shape (see the sibling
    // describe above).
    state().sessions.set('bare', fake('bare'))
    expect(isTerminalProcessAlive('bare', () => false)).toBe(true)
  })
})

describe('startTerminalSweepLoop — the server-side sweep is actually wired to a periodic tick', () => {
  // The whole point of the loop: in production NOTHING called sweepTerminalPool
  // (runSwarmJanitor, its only caller, has no non-test caller), so a dead pool
  // entry from a reload race / orphan would never be reaped — a phantom
  // "terminal active" beacon pinned on a Ground card. These prove a boot-armed
  // interval reaps them with NO swarm + NO UI. Fake timers: the loop has no async
  // work (sweepTerminalPool is synchronous), so this stays deterministic — no
  // sleeping on a real interval (see the flaky-load-test lesson).
  beforeEach(() => {
    stopTerminalSweepLoop()
    vi.useFakeTimers()
  })
  afterEach(() => {
    stopTerminalSweepLoop()
    vi.useRealTimers()
  })

  it('a tick reaps an ORPHAN (no finishedAt, pid dead) and clears its phantom beacon', () => {
    // node-pty's onExit never fired (out-of-band kill), so finishedAt stays unset
    // and listActiveTerminals reports the dead session forever — the phantom beacon.
    const s = fakeSession('orphan', '/tmp/proj-a', { tag: 'claude', lastOutputAt: Date.now() })
    s.pty = { pid: 4242 }
    state().sessions.set('orphan', s)
    // Before the sweep, the orphan lights the beacon.
    expect(listActiveTerminals().claude.map((c) => c.id)).toEqual(['orphan'])
    expect(listActiveTerminals().cwds).toEqual(['/tmp/proj-a'])

    // isAlive injected → pid 4242 reported dead (the real signal-0 probe is e2e).
    startTerminalSweepLoop(1_000, { isAlive: () => false })
    vi.advanceTimersByTime(1_000)

    // The tick reconciled the orphan out of the pool — beacon cleared.
    expect(state().sessions.has('orphan')).toBe(false)
    expect(listActiveTerminals()).toEqual({ cwds: [], claude: [] })
  })

  it('a tick reaps a reload-orphaned EXITED entry once it passes the linger window', () => {
    // The 30s onExit delete timer is lost across a `tsx watch` reload (the
    // globalThis Map survives, the setTimeout does not). The sweep is the net.
    const NOW = 1_700_000_000_000
    vi.setSystemTime(NOW)
    state().sessions.set(
      'linger',
      fakeSession('linger', '/tmp/proj-a', { tag: 'claude', finishedAt: new Date(NOW).toISOString() }),
    )
    startTerminalSweepLoop(5_000)
    // One tick inside the 60s linger window → still kept (never races a draining client).
    vi.advanceTimersByTime(5_000)
    expect(state().sessions.has('linger')).toBe(true)
    // Advance past the linger window → a subsequent tick reaps it.
    vi.advanceTimersByTime(TERMINAL_LINGER_SWEEP_MS)
    expect(state().sessions.has('linger')).toBe(false)
  })

  it('ticks repeatedly and never reaps a LIVE session', () => {
    const s = fakeSession('live', '/tmp/proj-a', { tag: 'claude', lastOutputAt: Date.now() })
    s.pty = { pid: 4243 }
    state().sessions.set('live', s)
    startTerminalSweepLoop(1_000, { isAlive: () => true })
    vi.advanceTimersByTime(10_000) // ten ticks
    expect(state().sessions.has('live')).toBe(true)
    expect(listActiveTerminals().claude.map((c) => c.id)).toEqual(['live'])
  })

  it('is reload-safe: re-arming clears the previous interval instead of stacking a second loop', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const timerGlobal = globalThis as { __openground_terminal_sweep_timer?: ReturnType<typeof setInterval> | null }
    startTerminalSweepLoop(1_000)
    const first = timerGlobal.__openground_terminal_sweep_timer
    expect(first).toBeTruthy()
    startTerminalSweepLoop(1_000)
    // The re-eval cleared the OLD timer (mirrors startAutoDrainLoop) and armed a fresh one.
    expect(clearSpy).toHaveBeenCalledWith(first)
    expect(timerGlobal.__openground_terminal_sweep_timer).not.toBe(first)
    clearSpy.mockRestore()
  })

  it('stopTerminalSweepLoop halts the ticks (no further sweeps) and is idempotent', () => {
    const s = fakeSession('orphan', '/tmp/proj-a', { tag: 'claude' })
    s.pty = { pid: 4242 }
    state().sessions.set('orphan', s)
    startTerminalSweepLoop(1_000, { isAlive: () => false })
    stopTerminalSweepLoop()
    stopTerminalSweepLoop() // idempotent — no throw, no-op the second time
    vi.advanceTimersByTime(10_000)
    // The loop was stopped before any tick fired, so the orphan is untouched.
    expect(state().sessions.has('orphan')).toBe(true)
  })

  it('default sweep interval is a sane sub-minute cadence', () => {
    expect(TERMINAL_SWEEP_INTERVAL_MS).toBe(30_000)
    expect(TERMINAL_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(60_000)
  })
})

// ── Killing is asynchronous; DELETING the cwd is not (2026-07-29) ────────────
// node-pty's kill() is `process.kill(pid, 'SIGHUP')` and returns at once, while
// `finishedAt` is stamped later by an async onExit. Callers that removed the
// worktree / tmp dir on the very next line were deleting a directory a live
// `claude` was sitting in — and claude runs `git` constantly, so the delete
// lands mid-run and wedges that git in uninterruptible sleep, where no signal
// and no timeout can ever reach it (07 章 §7). These wait for the OS to agree.
//
// Waiting on the SHELL's pid is the right signal (measured on this machine):
// zsh's job control puts claude in its OWN process group, so a negative-pid
// group kill never reaches it; what reaches it is the kernel's SIGHUP to the
// foreground group when the session leader dies. The leader leaving the process
// table is therefore the evidence that hangup was delivered.
describe('killTerminalsByCwdAndWait / waitForTerminalGone', () => {
  const withPid = (id: string, cwd: string, pid: number) => {
    const s = fakeSession(id, cwd)
    ;(s.pty as Record<string, unknown>).pid = pid
    ;(s.pty as Record<string, unknown>).kill = () => {}
    return s
  }

  it('returns true only once the process has actually left the table', async () => {
    state().sessions.set('t1', withPid('t1', '/w', 4242))
    let alive = true
    const p = killTerminalsByCwdAndWait('/w', { pollMs: 5, isAlive: () => alive })
    // Still alive ⇒ must NOT have resolved yet. Pre-fix (fire-and-forget) the
    // caller simply proceeded to delete the directory at this instant.
    let settled = false
    void p.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)

    alive = false // the shell finally exits
    expect(await p).toBe(true)
  })

  it('returns FALSE on timeout — the caller must not delete the directory', async () => {
    state().sessions.set('t2', withPid('t2', '/w2', 4243))
    expect(await killTerminalsByCwdAndWait('/w2', { timeoutMs: 40, pollMs: 5, isAlive: () => true })).toBe(false)
  })

  it('escalates to SIGKILL once at the halfway mark', async () => {
    state().sessions.set('t3', withPid('t3', '/w3', 4244))
    const kills: [number, string][] = []
    const realKill = process.kill.bind(process)
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string) => {
      kills.push([pid, String(sig)])
      return true
    }) as typeof realKill)
    try {
      await killTerminalsByCwdAndWait('/w3', { timeoutMs: 60, pollMs: 5, isAlive: () => true })
    } finally {
      spy.mockRestore()
    }
    // Exactly one escalation, aimed at the pid (never a negative/group pid —
    // pid reuse would make that a loaded gun, and it does not reach claude anyway).
    expect(kills.filter(([, sig]) => sig === 'SIGKILL')).toEqual([[4244, 'SIGKILL']])
  })

  it('no matching session ⇒ true immediately (nothing to wait for is not a failure)', async () => {
    expect(await killTerminalsByCwdAndWait('/nobody', { isAlive: () => true })).toBe(true)
    expect(await waitForTerminalGone('no-such-id', { isAlive: () => true })).toBe(true)
  })

  it('waitForTerminalGone follows the same rule for a single terminal', async () => {
    state().sessions.set('t4', withPid('t4', '/w4', 4245))
    expect(await waitForTerminalGone('t4', { timeoutMs: 40, pollMs: 5, isAlive: () => true })).toBe(false)
    expect(await waitForTerminalGone('t4', { pollMs: 5, isAlive: () => false })).toBe(true)
  })
})
