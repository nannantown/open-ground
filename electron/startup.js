// electron/startup.js — the app.whenReady startup ordering, as a pure, Electron-
// free function so the ONE ordering it must never break is unit-testable.
//
// THE INVARIANT THIS LOCKS (white-screen-after-reinstall fix): the Chromium-cache
// self-heal MUST run BEFORE the window is created and loaded, so the renderer has
// not yet opened the HTTP/Code caches we are about to delete (see
// electron/cacheReset.js). In electron/main.js the cache reset sits at the top of
// the whenReady callback and the window is created + loaded inside start(); a
// future edit that moved the reset after start() — or interleaved it after
// createWindow()/loadURL() — would silently reintroduce the white screen. By
// expressing the order in one tiny injectable function, a unit test can assert it
// (server/__tests__/startup.test.ts) and go red the moment the steps are
// reordered, without booting Electron.
//
// Plain CommonJS (no `electron` import) for the same reason as cacheReset.js /
// runtimeConfig.js: electron/main.js is loaded directly by Electron and the
// vitest suite must be able to require this in plain node.

/**
 * Run the whenReady startup steps in the only order that keeps the Chromium-cache
 * self-heal strictly before window creation/load.
 *
 * @param {object} steps
 * @param {() => void} steps.resetCaches  Chromium-cache self-heal (white-screen
 *   fix). Runs FIRST — before any window (and thus any renderer cache read) exists.
 * @param {() => void} steps.registerIpc  Register the ipcMain handlers the preload
 *   bridge invokes — done before the renderer loads so no invoke hangs.
 * @param {() => (void | Promise<void>)} steps.start  Bring the window up: start()
 *   creates the window, (in prod) forks + awaits the server, then loadURL()s it.
 * @returns {void | Promise<void>} start()'s result, so the caller can await it.
 */
function runStartupSequence(steps) {
  const { resetCaches, registerIpc, start } = steps
  // 1. Heal a stale/corrupt Chromium cache FIRST — before any window (and thus any
  //    renderer cache read) exists. This is the load-bearing ordering.
  resetCaches()
  // 2. Register IPC handlers before the renderer loads.
  registerIpc()
  // 3. Only now bring the window up (createWindow + loadURL live inside start()).
  return start()
}

module.exports = { runStartupSequence }
