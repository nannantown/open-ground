// osNotify — the server→Electron seam that raises an OS-native push notification
// (the OUTWARD half of the escalation safety valve). The bundled Hono server is a
// CHILD of electron/main.js, forked with an IPC channel, so `process.send` reaches
// the Electron main process — the only place that can call Electron's
// `Notification` API. This module is the one-line call the server makes; the
// actual `new Notification().show()` lives in electron/main.js (onServerMessage),
// mirroring how selfUpdateSignal.ts kicks the self-update cycle.
//
// FAIL-SAFE (a no-op return, never a throw) so wiring this into the swarm loop can
// never affect a pass: in dev `tsx`, vitest, or a bare `node` run there is no
// parent listening (no `process.send`), so we stay silent. The in-app notification
// is persisted regardless (swarmNotifications.ts), so the bell still records the
// event even when no OS toast can be shown.

/** The IPC message electron/main.js listens for to SHOW an OS notification. Kept
 *  here as the single source of truth; electron/main.js compares against this
 *  exact string (it can't import this TS module — it duplicates the literal with
 *  a "must match osNotify.ts" comment, exactly like SELF_UPDATE_MESSAGE). */
export const OS_NOTIFY_MESSAGE = 'openground:notify'

/** The IPC message the server listens for FROM electron/main.js to CREATE an
 *  in-app notification (the INWARD half — used for self-update rollback/canary
 *  events, which only Electron observes). Handled by registerIncomingNotifications
 *  in swarmNotifications.ts. */
export const CREATE_NOTIFICATION_MESSAGE = 'openground:create-notification'

/** The IPC message electron/main.js sends on window focus / blur so the gate
 *  below knows whether the owner is looking at OPEN GROUND right now. */
export const WINDOW_FOCUS_MESSAGE = 'openground:window-focus'

/** The ONLY notification events that may raise a Mac toast (owner decision
 *  2026-09-26 — "only what must reach me while I'm looking elsewhere"): a
 *  question that stops work until answered (first time only — reminders stay in
 *  the bell), the owner's own conversation hit its usage limit, and stuck
 *  processes piling up (restart needed). An ALLOWLIST on purpose: a new event
 *  kind stays bell-only until someone adds it here. Everything else — fatal
 *  included ("mistaken for an error during updates") — still reaches the bell
 *  and the president's seat, just never the Mac toast. */
export const OS_TOAST_EVENTS: ReadonlySet<string> = new Set([
  'escalation-open',
  'session-limit',
  'stuck-processes',
])

let windowFocused = false

/** Record the window focus state relayed by electron/main.js. */
export function setWindowFocused(focused: boolean): void {
  windowFocused = focused
}

/** The single Mac-toast gate: an allowlisted event AND the OPEN GROUND window is
 *  not in front (when it is, the owner already sees it on screen). */
export function shouldRaiseOsNotification(event: string): boolean {
  return OS_TOAST_EVENTS.has(event) && !windowFocused
}

/** Title + body for one OS notification. */
export interface OsNotification {
  title: string
  body: string
}

/**
 * Ask the Electron main process to show an OS-native notification. Fail-safe:
 * returns false (and shows nothing) when there is no IPC channel — i.e. we are
 * not the engine forked by electron/main.js (dev/tsx/vitest/bare node).
 *
 * @returns true iff the request was actually sent to the main process.
 */
export function sendOsNotification(n: OsNotification): boolean {
  const send = typeof process.send === 'function' ? process.send.bind(process) : null
  if (!send) return false // not a child with an IPC channel
  try {
    send({ type: OS_NOTIFY_MESSAGE, title: n.title, body: n.body })
    return true
  } catch {
    // A failed IPC send must never disturb the caller (a swarm pass / a notify).
    return false
  }
}
