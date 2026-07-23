'use strict'

// Pure decision logic for the Electron server-crash-respawn supervisor
// (electron/main.js, card 5 of docs/ENGINE_PERSISTENCE_PLAN.md §7). Kept
// side-effect free and free of any `electron` import so it can be unit tested
// directly — the same DI-friendly split electron/selfUpdate.js already uses.

const BACKOFF_DELAYS_MS = [2000, 4000, 8000]
const CRASH_WINDOW_MS = 10 * 60_000
const CRASH_WINDOW_MAX_RESPAWNS = 3

// Decide how an unexpected server death should be handled, given the crash
// timestamps recorded so far (ms epoch, any order) and the current time.
// Deliberate stops (isQuitting: app is quitting, isSwitching: self-update
// cutover is mid-flight) are never touched — the caller's own teardown owns
// those paths.
//
// Returns one of:
//   { action: 'skip' }                            — deliberate stop; do nothing.
//   { action: 'respawn', delayMs, timestamps }     — respawn after `delayMs`;
//                                                     `timestamps` is the updated
//                                                     window the caller must store.
//   { action: 'fatal', timestamps }                — window exhausted, go fatal.
function decideCrashResponse({ timestamps, now, isQuitting, isSwitching }) {
  if (isQuitting || isSwitching) {
    return { action: 'skip' }
  }
  const windowStart = now - CRASH_WINDOW_MS
  const recent = (timestamps || []).filter((t) => t > windowStart)
  recent.push(now)
  if (recent.length <= CRASH_WINDOW_MAX_RESPAWNS) {
    const delayMs = BACKOFF_DELAYS_MS[Math.min(recent.length - 1, BACKOFF_DELAYS_MS.length - 1)]
    return { action: 'respawn', delayMs, timestamps: recent }
  }
  return { action: 'fatal', timestamps: recent }
}

module.exports = {
  decideCrashResponse,
  BACKOFF_DELAYS_MS,
  CRASH_WINDOW_MS,
  CRASH_WINDOW_MAX_RESPAWNS,
}
