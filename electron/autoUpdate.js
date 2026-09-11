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

/** How long to wait for the OS installer to STAGE a downloaded update before
 *  giving up and saying so. Generous: the app ships unpacked (`asar: false`, so
 *  Squirrel.Mac unzips and code-signature-verifies tens of thousands of files
 *  rather than one archive), and a slow disk makes that minutes, not seconds.
 *  Waiting costs nothing here — the app stays fully usable throughout. */
const STAGE_WAIT_MS = 5 * 60 * 1000

/**
 * Pure: does this platform's OS installer have to STAGE the update before the
 * app is able to quit into it?
 *
 * macOS only. Squirrel.Mac fetches the zip (from electron-updater's local proxy
 * server), unpacks it and verifies its signature ASYNCHRONOUSLY; `quitAndInstall()`
 * can only quit once that has landed. On Windows/Linux electron-updater runs the
 * installer from inside quitAndInstall itself, so there is nothing to wait for.
 *
 * @param {string} platform — process.platform
 * @returns {boolean}
 */
function installStagingRequired(platform) {
  return platform === 'darwin'
}

/**
 * Pure: may we tear the forked server down RIGHT NOW?
 *
 * ⚠ WHY THIS EXISTS (owner, 2026-09-11, the second half of the same report).
 * Pinning `autoInstallOnAppQuit` true (eagerSquirrelHandoff) moves the staging
 * work to download time, so by the time a user reads the dialog and clicks it is
 * usually done. USUALLY. Click within a few seconds of the dialog appearing and
 * staging is still running — and the old sequence tore the back-end down first
 * regardless, so the user got a window that could not be used and would not
 * quit, for however long unpacking took, with nothing on screen saying why.
 *
 * So the teardown is gated on readiness instead of guessed at: 'staging' means
 * WAIT, with the app whole and usable, and quit the instant the installer is
 * ready. Nothing is destroyed in order to wait.
 *
 * @param {string} platform
 * @param {boolean} staged — has the OS installer reported the update staged?
 * @returns {'ready' | 'staging'}
 */
function installReadiness(platform, staged) {
  if (!installStagingRequired(platform)) return 'ready'
  return staged === true ? 'ready' : 'staging'
}

/**
 * Wait until the OS installer reports the update staged.
 *
 * Event-driven with a bounded fallback, and — the part worth a test — it
 * re-checks `isStaged()` AFTER subscribing, because the event can land in the
 * gap between the first check and the subscription, and a missed edge here would
 * mean waiting out the whole timeout on an update that is ready.
 *
 * @param {{
 *   isStaged: () => boolean,
 *   onStaged: (cb: () => void) => (() => void) | void,
 *   timers?: { setTimeout?: Function, clearTimeout?: Function, timeoutMs?: number },
 * }} deps
 * @returns {Promise<boolean>} true = staged, false = timed out
 */
function waitForInstallStaged(deps) {
  const { isStaged, onStaged, timers } = deps
  if (isStaged()) return Promise.resolve(true)
  const set = (timers && timers.setTimeout) || setTimeout
  const clear = (timers && timers.clearTimeout) || clearTimeout
  const ms = timers && Number.isFinite(timers.timeoutMs) ? timers.timeoutMs : STAGE_WAIT_MS
  return new Promise((resolve) => {
    let settled = false
    let timer
    let unsubscribe = () => {}
    const settle = (v) => {
      if (settled) return
      settled = true
      clear(timer)
      try {
        unsubscribe()
      } catch {
        /* listener already gone — nothing to undo */
      }
      resolve(v)
    }
    const off = onStaged(() => settle(true))
    if (typeof off === 'function') unsubscribe = off
    timer = set(() => settle(false), ms)
    // Close the subscribe race: staged between the check above and the listener.
    if (isStaged()) settle(true)
  })
}

/** How long after `quitAndInstall()` a still-running app counts as a FAILED
 *  install. Generous on purpose: on the happy path the process is gone in well
 *  under a second, and the slowest legitimate case (Squirrel.Mac unpacking a
 *  ~180 MB, asar-less bundle straight after the click) is tens of seconds. */
const INSTALL_WATCHDOG_MS = 90 * 1000

/**
 * Pure decision: must electron-updater hand the downloaded update to the OS
 * installer EAGERLY (at download time) rather than lazily (at quitAndInstall)?
 *
 * ⚠ THE BUG THIS EXISTS FOR (owner report, 2026-09-11; the second sighting of
 * the SAME failure type as the 0.11.8 one above — "Restart now does nothing").
 * The owner restarted repeatedly and kept getting the same "0.11.106 has been
 * downloaded" dialog: the update downloaded fine and was never applied.
 *
 * The cause is a MISREADING of electron-updater's `autoInstallOnAppQuit` on
 * macOS, which main.js was setting from the user's hands-free-update setting.
 * On macOS that flag does NOT mean "install when the app quits" — install-on-
 * quit lives in `BaseUpdater` (Windows NSIS / Linux), and `MacUpdater extends
 * AppUpdater`, which has NO quit handler at all. Its only two readers are both
 * inside MacUpdater (electron-updater 6.8.3, out/MacUpdater.js):
 *
 *   • updateDownloaded(): `if (autoInstallOnAppQuit) nativeUpdater.checkForUpdates()`
 *     — the hand-off that makes Squirrel.Mac actually FETCH + STAGE the zip;
 *     `else resolve([])`, i.e. Squirrel is told nothing.
 *   • quitAndInstall(): takes the fast path ONLY `if (squirrelDownloadedUpdate)`.
 *     Otherwise it registers a listener and (because the flag is false) kicks
 *     off `checkForUpdates()` — and RETURNS WITHOUT QUITTING.
 *
 * So with the flag false on macOS, pressing "Restart now" does not restart. It
 * starts a fetch + unpack that finishes tens of seconds later, by which time
 * this app has already torn its forked server down (that ordering is required,
 * see applyDownloadedUpdate) — so the user faces a window whose back-end is
 * dead and which refuses to quit, force-quits it, and the staged update dies
 * with the process. Every launch then repeats the whole loop.
 *
 * The flag is therefore not a policy knob on macOS, it is plumbing: it must be
 * TRUE there, always. On Windows/Linux it keeps its documented meaning and so
 * keeps following the user's setting — a user who turned hands-free updates off
 * has not asked for an install on every quit.
 *
 * @param {string} platform — process.platform
 * @param {boolean} settingEnabled — settings.autoUpdate, already narrowed
 * @returns {boolean}
 */
function eagerSquirrelHandoff(platform, settingEnabled) {
  if (platform === 'darwin') return true
  return settingEnabled === true
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
 * 4. `onStuck` (optional) is the WATCHDOG. `quitAndInstall()` is allowed to be
 *    asynchronous — on macOS it returns immediately and quits only once
 *    Squirrel has staged the update (see eagerSquirrelHandoff) — and it is
 *    allowed to never quit at all. Silence in that case is the whole 2026-09-11
 *    defect: the app sat there with a dead back-end and the user had no way to
 *    tell "applying" from "broken". So the watchdog is armed BEFORE the install
 *    call (anything after it is unreachable on the happy path, where the process
 *    is already gone) and fires only in the world where the app is still alive.
 *
 * @param {{
 *   setQuitting: (v: boolean) => void,
 *   shutdownServerChild: () => Promise<unknown>,
 *   quitAndInstall: () => void,
 *   onStuck?: () => void,
 *   timers?: { setTimeout?: Function, watchdogMs?: number },
 * }} deps
 * @returns {Promise<void>}
 */
function applyDownloadedUpdate(deps) {
  const { setQuitting, shutdownServerChild, quitAndInstall, onStuck, timers } = deps
  setQuitting(true)
  // Byte-for-byte the field-tested 0.11.8 fix: setQuitting → shutdownServerChild()
  // → (via .finally) quitAndInstall(). .finally runs the install even if teardown
  // rejects, and the returned promise still rejects so the caller's .catch sees it.
  return shutdownServerChild().finally(() => {
    // ARM FIRST, INSTALL SECOND. quitAndInstall() may end the process from inside
    // the call, so a watchdog armed after it would never exist; and a
    // quitAndInstall() that THROWS must also be reported, not swallowed by the
    // caller's .catch. Both are covered by arming here.
    if (typeof onStuck === 'function') {
      const set = (timers && timers.setTimeout) || setTimeout
      const ms =
        timers && Number.isFinite(timers.watchdogMs) ? timers.watchdogMs : INSTALL_WATCHDOG_MS
      const handle = set(() => {
        onStuck()
      }, ms)
      // Never be the reason the process stays alive: Electron's own event loop
      // keeps main running, so an unref'd timer still fires while the app does.
      if (handle && typeof handle.unref === 'function') handle.unref()
    }
    quitAndInstall()
  })
}

module.exports = {
  INSTALL_WATCHDOG_MS,
  STAGE_WAIT_MS,
  eagerSquirrelHandoff,
  installStagingRequired,
  installReadiness,
  waitForInstallStaged,
  hasLiveForkedChildren,
  applyDownloadedUpdate,
}
