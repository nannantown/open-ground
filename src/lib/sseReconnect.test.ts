import { describe, expect, it } from 'vitest'
import {
  initialSseState,
  sseReducer,
  SSE_READYSTATE_CLOSED,
  type SseState,
} from './sseReconnect'

// EventSource readyState values (the helper takes CLOSED as an injected arg).
const CONNECTING = 0
const OPEN = 1
const CLOSED = SSE_READYSTATE_CLOSED // 2

const open: SseState = { conn: 'open', exited: false }
const reconnecting: SseState = { conn: 'reconnecting', exited: false }

describe('sseReducer — connection state machine', () => {
  it('starts connecting and goes open on the first init', () => {
    expect(initialSseState()).toEqual({ conn: 'connecting', exited: false })
    const r = sseReducer(initialSseState(), { kind: 'init' })
    expect(r.state).toEqual({ conn: 'open', exited: false })
    expect(r.effects).toEqual(['clear-debounce', 'clear-escalate'])
  })

  describe('transient transport drop (browser auto-retrying)', () => {
    it('arms BOTH the debounce pill and the escalation on a dataless CONNECTING error', () => {
      const r = sseReducer(open, { kind: 'error', hasData: false, readyState: CONNECTING })
      // State unchanged until the debounce elapses — no flash on a quick blip.
      expect(r.state).toEqual(open)
      expect(r.effects).toEqual(['arm-debounce', 'arm-escalate'])
    })

    it('shows the pill once the debounce elapses (state is still open post-error)', () => {
      // The arming error leaves conn 'open'; a successful reconnect would have
      // cleared the timer via 'init', so a firing debounce always means the pill
      // should show — open → reconnecting.
      const r = sseReducer(open, { kind: 'debounce' })
      expect(r.state.conn).toBe('reconnecting')
      expect(r.effects).toEqual([])
    })

    it('a reconnect (init) clears the timers and returns to open', () => {
      const r = sseReducer(reconnecting, { kind: 'init' })
      expect(r.state).toEqual(open)
      expect(r.effects).toEqual(['clear-debounce', 'clear-escalate'])
    })

    it('escalates reconnecting → lost (clears timers + closes) when auto-reconnect never succeeds', () => {
      // The dead-server case: EventSource stays CONNECTING forever, so the
      // escalate timer is the only way out of an endless "Reconnecting…". Clears
      // BOTH timers (symmetric with the terminal-error path) so a debounce armed
      // by a last-moment retry can't fire a stray no-op after we've given up.
      const r = sseReducer(reconnecting, { kind: 'escalate' })
      expect(r.state.conn).toBe('lost')
      expect(r.effects).toEqual(['clear-debounce', 'clear-escalate', 'close-stream'])
    })

    it('a late timer never reverts a terminal/connected state', () => {
      const lost: SseState = { conn: 'lost', exited: false }
      // Once given up, a stray debounce/escalate must not revert the state.
      expect(sseReducer(lost, { kind: 'debounce' }).state.conn).toBe('lost')
      expect(sseReducer(lost, { kind: 'escalate' }).state.conn).toBe('lost')
      // A stale escalate while genuinely connected is a defensive no-op (in
      // practice 'init' would have cleared the timer first).
      expect(sseReducer(open, { kind: 'escalate' }).state).toEqual(open)
      expect(sseReducer(open, { kind: 'escalate' }).effects).toEqual([])
    })
  })

  describe('terminal drop → lost (manual Reconnect)', () => {
    it('a server NAMED error (carries data) is lost — and closes the stream', () => {
      const r = sseReducer(open, { kind: 'error', hasData: true, readyState: CONNECTING })
      expect(r.state.conn).toBe('lost')
      // close-stream stops the browser auto-retrying into the same not-found.
      expect(r.effects).toEqual(['clear-debounce', 'clear-escalate', 'close-stream'])
    })

    it('readyState CLOSED (EventSource gave up) is lost — and closes the stream', () => {
      const r = sseReducer(reconnecting, { kind: 'error', hasData: false, readyState: CLOSED })
      expect(r.state.conn).toBe('lost')
      expect(r.effects).toEqual(['clear-debounce', 'clear-escalate', 'close-stream'])
    })

    it('a transient error while OPEN is NOT lost (readyState OPEN ≠ CLOSED)', () => {
      const r = sseReducer(open, { kind: 'error', hasData: false, readyState: OPEN })
      expect(r.state.conn).toBe('open')
      expect(r.effects).toEqual(['arm-debounce', 'arm-escalate'])
    })
  })

  describe('clean exit', () => {
    it('marks exited and clears both timers', () => {
      const r = sseReducer(reconnecting, { kind: 'exit' })
      expect(r.state).toEqual({ conn: 'reconnecting', exited: true })
      expect(r.effects).toEqual(['clear-debounce', 'clear-escalate'])
    })

    it('ignores EVERY input after exit (the expected post-exit close included)', () => {
      const exited: SseState = { conn: 'open', exited: true }
      for (const input of [
        { kind: 'error', hasData: false, readyState: CONNECTING },
        { kind: 'error', hasData: true, readyState: CLOSED },
        { kind: 'debounce' },
        { kind: 'escalate' },
        { kind: 'init' },
      ] as const) {
        const r = sseReducer(exited, input)
        expect(r.state).toEqual(exited)
        expect(r.effects).toEqual([])
      }
    })
  })
})
