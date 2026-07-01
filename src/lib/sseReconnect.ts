// sseReconnect.ts — the PURE state machine for a terminal pane's output-stream
// (EventSource) connection status. Extracted from TerminalPane /
// ClaudeTerminalPane so the reconnect / escalation / close logic is unit-testable
// WITHOUT a real browser EventSource (the panes mount xterm via a dynamic import,
// so the inline logic can't run in jsdom). The pane owns the SIDE EFFECTS (the
// two timers, es.close(), setState); this module owns the DECISIONS.
//
// State flow:
//   connecting ──init──▶ open
//   open ──error(transient)──▶ open  (+arm debounce & escalate timers)
//   …debounce elapsed──▶ reconnecting        (the "Reconnecting…" pill)
//   …init──▶ open                            (reconnected — clear timers)
//   …escalate elapsed──▶ lost (+close)       (gave up — manual Reconnect)
//   any ──error(server NAMED / readyState CLOSED)──▶ lost (+close)
//   any ──exit──▶ exited (ignore everything after)
//
// WHY THE ESCALATION (review fix #2): when the server is fully dead the browser's
// fetch is REFUSED, so EventSource stays CONNECTING (it never reaches CLOSED) and
// retries forever. Without a timeout the pill would read "Reconnecting…" forever
// with no way back. The escalate timer flips it to 'lost' after a bounded window
// so the user gets a manual Reconnect.

export type SseConnState = 'connecting' | 'open' | 'reconnecting' | 'lost'

/** EventSource.CLOSED. Exported (and injectable into the reducer) so callers/tests
 *  don't need a DOM EventSource to reason about readyState. */
export const SSE_READYSTATE_CLOSED = 2

/** Debounce before the "Reconnecting…" pill shows: the browser auto-reconnects
 *  (and a flow-control stall drop reconnects routinely on a backgrounded tab), so
 *  a short grace window keeps a quick blip from flashing the pill. */
export const RECONNECT_PILL_DELAY_MS = 600

/** How long auto-reconnect may run before we escalate to 'lost' (manual
 *  Reconnect). The browser's default SSE retry is ~3s, so this is ~5 attempts —
 *  long enough to ride out a server restart, short enough not to strand the user
 *  on a dead server. */
export const RECONNECT_GIVEUP_MS = 15_000

export type SseInput =
  // The server's `init` event arrived — the stream is live / re-established.
  | { kind: 'init' }
  // An EventSource `error`. `hasData` = a server-sent NAMED error (it carries a
  // data payload, e.g. {error:'not found'} when the PTY is gone → terminal).
  // `readyState` = es.readyState at the error (CLOSED = the browser gave up).
  | { kind: 'error'; hasData: boolean; readyState: number }
  // The debounce timer fired (a transient drop outlived the grace window).
  | { kind: 'debounce' }
  // The escalation timer fired (auto-reconnect never succeeded in the window).
  | { kind: 'escalate' }
  // A clean PTY exit — the close that follows is expected; stop reacting.
  | { kind: 'exit' }

export type SseEffect =
  | 'arm-debounce' // start the pill debounce → re-enters with { kind: 'debounce' }
  | 'arm-escalate' // start the give-up timer → re-enters with { kind: 'escalate' }
  | 'clear-debounce'
  | 'clear-escalate'
  | 'close-stream' // es.close() — stop the browser's futile auto-retry

export interface SseState {
  conn: SseConnState
  /** A clean exit happened — all further inputs are ignored (the exit overlay /
   *  strip owns the UI from here). */
  exited: boolean
}

export const initialSseState = (): SseState => ({ conn: 'connecting', exited: false })

const CLEAR_BOTH: SseEffect[] = ['clear-debounce', 'clear-escalate']

/** Advance the machine. PURE: returns the next state plus the side effects the
 *  pane must perform. `closedState` is injected (EventSource.CLOSED) so tests need
 *  no DOM. Re-arming a timer is the pane's call to make idempotent (it only starts
 *  one when none is pending), so 'arm-*' on every transient error is safe. */
export const sseReducer = (
  state: SseState,
  input: SseInput,
  closedState: number = SSE_READYSTATE_CLOSED,
): { state: SseState; effects: SseEffect[] } => {
  // After a clean exit, ignore everything — including the expected close that
  // fires an EventSource error.
  if (state.exited) return { state, effects: [] }

  switch (input.kind) {
    case 'exit':
      return { state: { conn: state.conn, exited: true }, effects: CLEAR_BOTH }

    case 'init':
      // (Re)connected: drop any pending/active notice and both timers.
      return { state: { conn: 'open', exited: false }, effects: CLEAR_BOTH }

    case 'error':
      // Terminal: a server NAMED error (the PTY is gone) or the EventSource itself
      // reached CLOSED (it won't auto-retry). Show 'lost' (manual Reconnect) and
      // stop the browser retry.
      if (input.hasData || input.readyState === closedState) {
        return { state: { ...state, conn: 'lost' }, effects: ['clear-debounce', 'clear-escalate', 'close-stream'] }
      }
      // Transient: the browser is auto-retrying (CONNECTING). Arm the debounce (so
      // a quick blip doesn't flash the pill) AND the escalation (so a server that
      // never returns can't show 'Reconnecting…' forever).
      return { state, effects: ['arm-debounce', 'arm-escalate'] }

    case 'debounce':
      // The transient drop outlived the grace window → surface the pill. NOTE the
      // state here is normally still 'open' (the arming error left conn unchanged):
      // a successful reconnect would have CLEARED this timer via 'init', so a
      // firing debounce always means genuinely-disconnected. Only a terminal
      // 'lost' (a late timer after we already gave up) must not revert to the pill.
      if (state.conn === 'lost') return { state, effects: [] }
      return { state: { ...state, conn: 'reconnecting' }, effects: [] }

    case 'escalate':
      // Auto-reconnect never succeeded within the window → give up to a manual
      // Reconnect and stop the futile retry. No-op if already given up ('lost') or
      // (defensively — a reconnect would have cleared this timer) genuinely 'open'.
      // Clear BOTH timers like the terminal-error path: a debounce armed by a
      // retry just before the window closed could otherwise fire a stray no-op.
      if (state.conn === 'open' || state.conn === 'lost') return { state, effects: [] }
      return { state: { ...state, conn: 'lost' }, effects: ['clear-debounce', 'clear-escalate', 'close-stream'] }
  }
}
