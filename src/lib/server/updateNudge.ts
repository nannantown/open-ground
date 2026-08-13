// updateNudge — the server→Electron seam that asks the MAIN process to check for
// an app update RIGHT NOW instead of waiting for the periodic tick. Same shape as
// osNotify.ts: the bundled Hono server is a CHILD of electron/main.js forked with
// an IPC channel, so `process.send` reaches the main process — the only place
// that holds the electron-updater handle. Raised by POST /api/update/check-now,
// whose caller is the release runbook: publish a version, then ring the local
// app's bell so it discovers the release in seconds, not at the next poll.
//
// FAIL-SAFE (a no-op result, never a throw): in dev `tsx`, vitest, or a bare
// `node` run there is no Electron parent (no `process.send`), so the response
// says honestly that nothing was queued. The main process applies its own
// rate limit (autoUpdatePolicy.shouldNudgeCheck) and its own lockdown check —
// this side only delivers the request.

/** The IPC message electron/main.js listens for to run an update check. Kept
 *  here as the single source of truth; electron/main.js compares against this
 *  exact string (it can't import this TS module — it duplicates the literal with
 *  a "must match updateNudge.ts" comment, exactly like OS_NOTIFY_MESSAGE). */
export const UPDATE_CHECK_MESSAGE = 'openground:update-check'

/** What POST /api/update/check-now answers. `queued` means the request reached
 *  the Electron main process — NOT that a new version exists or was applied. */
export interface UpdateNudgeResult {
  queued: boolean
  reason: 'sent' | 'no-electron-parent' | 'send-failed'
}

/**
 * Ask the Electron main process to check for updates now. Fail-safe: reports
 * `no-electron-parent` when there is no IPC channel — i.e. we are not the engine
 * forked by electron/main.js (dev/tsx/vitest/bare node).
 */
export function requestUpdateCheck(): UpdateNudgeResult {
  const send = typeof process.send === 'function' ? process.send.bind(process) : null
  if (!send) return { queued: false, reason: 'no-electron-parent' }
  try {
    send({ type: UPDATE_CHECK_MESSAGE })
    return { queued: true, reason: 'sent' }
  } catch {
    return { queued: false, reason: 'send-failed' }
  }
}
