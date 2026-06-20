// electron/preload.js
//
// PR A — minimal native bridge for the OPEN GROUND renderer.
//
// Runs in an isolated world (contextIsolation: true, nodeIntegration: false).
// The preload script is the *only* place with access to Node / Electron APIs;
// the renderer (http://127.0.0.1:47776) gets just the small, explicit surface
// exposed below via contextBridge. Everything else the app needs it still does
// the way it always has: fetch / SSE against /api/* served by the Next server.
//
// Design notes:
// - `platform` is read here (preload has Node `process`) and exposed as a plain
//   value. The renderer must never see `process` itself.
// - `getVersion()` goes through IPC instead of requiring package.json directly:
//   in a packaged build the version lives in main, and asar-relative requires
//   are fragile. main.js owns the source of truth and answers 'app:getVersion'.
// - `showOpenDialog()` is intentionally minimal in PR A. It forwards to main via
//   IPC; if main has no handler yet it resolves to a canceled result, so the
//   renderer can feature-detect without throwing. No filesystem logic lives here.
//
// Keep this surface small. Adding capabilities means adding a matching,
// validated ipcMain handler in main.js — never widen the bridge speculatively.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('openground', {
  // Static OS identity. Plain string, safe to expose.
  platform: process.platform,

  // Absolute on-disk path of a File dragged into the window (terminal panes
  // paste it iTerm-style). Synchronous and read-only — webUtils only maps the
  // DOM File back to the path the OS drag already carried; it grants no fs
  // access. In a plain dev browser this is absent and the renderer falls back
  // to uploading the bytes (see src/lib/terminalFileDrop.ts).
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // App version, owned by main (works in dev and packaged builds).
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // PR A stub: folder picker. Forwards to main; degrades gracefully if main
  // hasn't wired the handler yet (returns a canceled-style result).
  showOpenDialog: async (options) => {
    try {
      return await ipcRenderer.invoke('dialog:showOpenDialog', options)
    } catch {
      return { canceled: true, filePaths: [] }
    }
  },

  // Open an OAuth URL in the OS default browser (optional app login). main.js
  // validates the URL against an allow-list before opening — the renderer can't
  // turn this into an arbitrary opener. Degrades gracefully (returns false) if
  // main hasn't wired the handler, so the SPA can feature-detect (it falls back
  // to window.open in a plain dev browser).
  openExternal: async (url) => {
    try {
      return await ipcRenderer.invoke('shell:openExternal', url)
    } catch {
      return false
    }
  },

  // Deep links (openground://join?code=…). `onDeepLink` subscribes to WARM links
  // (the app is already open); it returns an unsubscribe. `getInitialDeepLink`
  // fetches the COLD-start link the app was launched with (one-shot — main clears
  // it after handing it over). Both degrade to no-op/null in a plain dev browser.
  onDeepLink: (cb) => {
    const listener = (_event, url) => {
      try {
        cb(url)
      } catch {
        /* renderer handler threw — never let it break the IPC channel */
      }
    }
    ipcRenderer.on('openground:deep-link', listener)
    return () => ipcRenderer.removeListener('openground:deep-link', listener)
  },
  getInitialDeepLink: async () => {
    try {
      return await ipcRenderer.invoke('openground:getInitialDeepLink')
    } catch {
      return null
    }
  },
})
