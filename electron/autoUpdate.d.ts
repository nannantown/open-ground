// Type declarations for the plain-CJS electron/autoUpdate.js. The module stays JS
// (Electron loads electron/main.js directly and cannot import TypeScript); the
// vitest suite gets types from here. Runtime resolves the .js; TypeScript resolves
// this .d.ts — the same split as electron/selfUpdate.d.ts / electron/startup.d.ts.

/** A forked child as the before-quit predicate sees it — only `killed` /
 *  `exitCode` are read; the handle is otherwise opaque. */
export interface ForkedChildLike {
  killed?: boolean
  exitCode?: number | null
}

/** The set of forked-child refs main.js's before-quit handler reaps. In a packaged
 *  build only `serverChild` is ever non-null (the self-update canary/build/e2e
 *  children exist only for unpackaged electron:prod). */
export interface ForkedChildHandles {
  serverChild?: ForkedChildLike | null
  activeCanaryHandle?: { child?: unknown } | null
  activeBuildChild?: ForkedChildLike | null
  activeE2eChild?: ForkedChildLike | null
}

/** before-quit's guard: is any forked child still live (present and not yet
 *  `killed`/exited)? When false, before-quit returns early without
 *  preventDefault — the state "Restart now" must reach before quitAndInstall. */
export function hasLiveForkedChildren(handles: ForkedChildHandles): boolean

/** How long terminateChild waits after SIGTERM before it SIGKILLs. */
export const CHILD_SIGTERM_GRACE_MS: number

/** SIGTERM the child, SIGKILL it if it is still up after `graceMs`; resolves once
 *  it has exited or been force-killed. */
export function terminateChild(
  child: (ForkedChildLike & { kill(signal: string): unknown; once(event: 'exit', cb: () => void): unknown }) | null | undefined,
  graceMs?: number,
): Promise<void>

/** main.js's `before-quit` and relaunch decisions, with Electron injected. */
export function createQuitGate(deps: {
  /** hasLiveForkedChildren over the live child refs. */
  hasChildren: () => boolean
  hideWindows: () => void
  /** Reap every forked child; the quit follows when it settles. */
  teardown: () => Promise<unknown> | unknown
  /** app.quit */
  quit: () => void
  /** app.relaunch */
  relaunch: () => void
}): {
  beforeQuit(event: { preventDefault(): void }): void
  /** Hold every quit while a teardown the gate did not start ("Restart now")
   *  is pending; settles like `promise`, after the hold is released. */
  track<T>(promise: Promise<T>): Promise<T>
  /** A second launch / dock reopen: true when the app is quitting (a relaunch
   *  was requested instead) and no window may be surfaced. */
  relaunchIfQuitting(): boolean
}

/** How long after quitAndInstall() a still-running app counts as a failed install. */
export const INSTALL_WATCHDOG_MS: number

/** Must electron-updater hand the downloaded update to the OS installer EAGERLY
 *  (at download time) rather than lazily (at quitAndInstall)? Always true on
 *  macOS, where `autoInstallOnAppQuit` is plumbing rather than policy — see the
 *  module comment for the 2026-09-11 "Restart now does nothing" defect. */
export function eagerSquirrelHandoff(platform: string, settingEnabled: boolean): boolean

/** How long to wait for the OS installer to stage a downloaded update. */
export const STAGE_WAIT_MS: number

/** Does this platform's OS installer have to STAGE the update before the app can
 *  quit into it? macOS only (Squirrel.Mac unpacks + verifies asynchronously). */
export function installStagingRequired(platform: string): boolean

/** May the forked server be torn down right now — i.e. will the quit be
 *  immediate? 'staging' means wait instead, with the app left whole. */
export function installReadiness(platform: string, staged: boolean): 'ready' | 'staging'

/** Wait until the OS installer reports the update staged. Resolves true when
 *  staged, false on timeout. Re-checks after subscribing so a staged-in-the-gap
 *  edge is never missed. */
export function waitForInstallStaged(deps: {
  isStaged: () => boolean
  onStaged: (cb: () => void) => (() => void) | void
  timers?: {
    setTimeout?: (fn: () => void, ms: number) => unknown
    clearTimeout?: (h: unknown) => void
    timeoutMs?: number
  }
}): Promise<boolean>

/** Injectable side effects of the "Restart now" sequence. */
export interface ApplyDownloadedUpdateDeps {
  /** Flip the module-level isQuitting flag (so health waits bail / 'exit' is treated
   *  as intentional). Called FIRST. */
  setQuitting: (v: boolean) => void
  /** Tear the live engine down and resolve once it is gone (null or killed). */
  shutdownServerChild: () => Promise<unknown>
  /** electron-updater's apply step. Called ONLY after teardown settles. */
  quitAndInstall: () => void
  /** Watchdog: called when the app is STILL RUNNING this long after the install
   *  step, i.e. the install silently failed to quit. Armed before quitAndInstall. */
  onStuck?: () => void
  /** Runs immediately before quitAndInstall (after the watchdog is armed) — where
   *  the pending-install marker is written. Wrapped: a throw never blocks the install. */
  beforeInstall?: () => void
  /** Injection seam for the watchdog's clock (tests pass a fake + short delay). */
  timers?: { setTimeout?: (fn: () => void, ms: number) => unknown; watchdogMs?: number }
}

/** Run the ordered "Restart now" sequence: setQuitting(true) → shutdownServerChild()
 *  → (always, via finally) quitAndInstall(). Returns the teardown promise so the
 *  ordering can be awaited/asserted. */
export function applyDownloadedUpdate(deps: ApplyDownloadedUpdateDeps): Promise<void>
