// Type declarations for the plain-CJS electron/startup.js. The module stays JS
// (Electron loads electron/main.js directly and cannot import TypeScript); the
// vitest suite gets types from here. Runtime resolves the .js; TypeScript resolves
// this .d.ts — the same split as electron/runtimeConfig.d.ts.

/** The injectable side-effecting steps of the whenReady startup, in the order
 *  runStartupSequence enforces. */
export interface StartupSteps {
  /** Chromium-cache self-heal (white-screen fix). MUST run before the window. */
  resetCaches: () => void
  /** Register the ipcMain handlers the preload bridge invokes. */
  registerIpc: () => void
  /** Create + load the window (and, in prod, fork + await the server). */
  start: () => void | Promise<void>
}

/** Run the whenReady startup steps in the order that keeps the cache self-heal
 *  strictly before window creation/load. Returns start()'s result. */
export function runStartupSequence(steps: StartupSteps): void | Promise<void>
