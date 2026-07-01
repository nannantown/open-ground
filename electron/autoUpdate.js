// electron/autoUpdate.js — the two pure decisions that make electron-updater's
// "Restart now" actually apply a downloaded update, factored out of the 78 KB
// electron/main.js so they are unit-testable WITHOUT an Electron runtime
// (server/__tests__/autoUpdate.test.ts) — the same plain-CJS split as
// electron/selfUpdate.js / cacheReset.js / forkEnv.js / startup.js.
//
// THE BUG THIS LOCKS (observed 2026-06-25, fixed in 0.11.8 / commit cc529d9).
// The app forks a Hono server child (serverChild). On any quit, the
// `before-quit` handler must reap that child so it is not orphaned — so it
// `event.preventDefault()`s the quit, tears the child down, then `app.quit()`s.
// electron-updater applies a downloaded update by calling `quitAndInstall()`,
// which ALSO triggers a quit. If `before-quit` intercepts THAT quit and replaces
// it with a plain `app.quit()`, the install step is skipped: the update was
// downloaded but never applied, so the user's "Restart now" button appears to do
// nothing (a silent no-op). That is exactly what happened.
//
// THE INVARIANT (why the fix works). The "Restart now" branch must tear the
// server child down FIRST and only then call `quitAndInstall()`. By the time
// quitAndInstall fires, the live engine is gone, so `before-quit`'s "are there
// live children?" predicate is false → it returns early WITHOUT preventDefault →
// quitAndInstall's quit proceeds and the update is applied. Two independent
// mechanisms make the predicate false after teardown, so the ordering is robust:
//   • happy path — the child exits, and main.js's 'exit' handler nulls serverChild
//     (`serverChild && …` is then false);
//   • SIGKILL path — `child.kill('SIGKILL')` sets `child.killed = true`
//     synchronously the moment the signal is sent, even before the process is
//     reaped (`… && !serverChild.killed` is then false).
// Either way `hasLiveForkedChildren(...)` is false after `shutdownServerChild()`
// settles, so before-quit no longer hijacks the quitAndInstall.
//
// Keeping these two as pure functions means the ordering and the predicate are
// asserted by a real unit test, not just a code comment — a regression that
// reorders the teardown, or that drops the `killed` arm of the predicate, turns
// the suite red instead of silently breaking auto-update in the field.
//
// SCOPE / BOUNDARY. applyDownloadedUpdate only reaps serverChild, which is
// sufficient for the supported field config: a PACKAGED build runs electron-updater
// (this path) with the self-update cycle DORMANT, so the canary/build/e2e children
// never exist and serverChild is the only live fork. Those two subsystems are
// mutually exclusive in the field — `initAutoUpdater()` needs `app.isPackaged`,
// while the self-update cycle is armed only for UNpackaged electron:prod. The lone
// way to overlap them is the `OPENGROUND_SELF_UPDATE=1` verification override on a
// packaged build; that is outside the supported envelope and deliberately not
// hardened here (reaping a mid-flight cycle's children from this path would reach
// into the self-update subsystem). If that ever needs belt-and-suspenders, tear
// down the SAME child set before-quit reaps, not just serverChild.

/**
 * before-quit's guard: is any forked child still live and in need of reaping?
 *
 * Mirrors exactly the predicate electron/main.js's `app.on('before-quit')` uses
 * to decide whether to `event.preventDefault()` and reap before quitting. When
 * this is false the handler returns early (no preventDefault), which is the state
 * the "Restart now" flow must reach BEFORE quitAndInstall so the install step is
 * not intercepted.
 *
 * A child counts as live only when it is present AND neither already-`killed` nor
 * already-exited. `child.killed` flips to true synchronously when a signal is
 * sent, so a child we just SIGKILLed reads as not-live here even before its 'exit'
 * fires — which is what keeps the quitAndInstall ordering robust on the force-kill
 * path. In a PACKAGED build the canary / build / e2e children never exist (the
 * self-update cycle is armed only for unpackaged electron:prod), so in the field
 * this reduces to "is serverChild still live?".
 *
 * @param {{
 *   serverChild?: { killed?: boolean, exitCode?: number|null } | null,
 *   activeCanaryHandle?: { child?: unknown } | null,
 *   activeBuildChild?: { killed?: boolean, exitCode?: number|null } | null,
 *   activeE2eChild?: { killed?: boolean, exitCode?: number|null } | null,
 * }} handles
 * @returns {boolean}
 */
function hasLiveForkedChildren(handles) {
  const h = handles || {}
  // Keep the shape byte-for-byte identical to main.js's inline check: a child is
  // "live" when present and not yet `killed`. main.js does not consult exitCode for
  // the generic children (only serverChild's own 'exit' handler nulls its ref), so
  // we match that — presence + !killed is "live".
  return Boolean(
    (h.serverChild && !h.serverChild.killed) ||
      (h.activeCanaryHandle && h.activeCanaryHandle.child) ||
      (h.activeBuildChild && !h.activeBuildChild.killed) ||
      (h.activeE2eChild && !h.activeE2eChild.killed),
  )
}

/**
 * The "Restart now" sequence for a downloaded update, as a pure, ordered
 * orchestration with every side effect injected.
 *
 * Contract (the regression-locked invariant):
 *   1. `setQuitting(true)` FIRST — so any in-flight health waits bail and the
 *      'exit' handler treats the impending child death as intentional.
 *   2. `shutdownServerChild()` — tear the live engine down and WAIT for it. When
 *      this settles the engine is gone (serverChild null or killed), so before-quit
 *      will not intercept.
 *   3. ONLY THEN `quitAndInstall()` — via `.finally`, so a teardown that rejects
 *      still applies the update (the install must not be held hostage to a messy
 *      shutdown; the child is already SIGKILL-bound by then regardless).
 *
 * Returns the teardown promise so callers (and the test) can await the ordering.
 *
 * @param {{
 *   setQuitting: (v: boolean) => void,
 *   shutdownServerChild: () => Promise<unknown>,
 *   quitAndInstall: () => void,
 * }} deps
 * @returns {Promise<void>}
 */
function applyDownloadedUpdate(deps) {
  const { setQuitting, shutdownServerChild, quitAndInstall } = deps
  setQuitting(true)
  // Byte-for-byte the field-tested 0.11.8 fix: setQuitting → shutdownServerChild()
  // → (via .finally) quitAndInstall(). .finally runs the install even if teardown
  // rejects, and the returned promise still rejects so the caller's .catch sees it.
  return shutdownServerChild().finally(() => {
    quitAndInstall()
  })
}

module.exports = { hasLiveForkedChildren, applyDownloadedUpdate }
