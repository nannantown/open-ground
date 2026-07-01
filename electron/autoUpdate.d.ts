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

/** Injectable side effects of the "Restart now" sequence. */
export interface ApplyDownloadedUpdateDeps {
  /** Flip the module-level isQuitting flag (so health waits bail / 'exit' is treated
   *  as intentional). Called FIRST. */
  setQuitting: (v: boolean) => void
  /** Tear the live engine down and resolve once it is gone (null or killed). */
  shutdownServerChild: () => Promise<unknown>
  /** electron-updater's apply step. Called ONLY after teardown settles. */
  quitAndInstall: () => void
}

/** Run the ordered "Restart now" sequence: setQuitting(true) → shutdownServerChild()
 *  → (always, via finally) quitAndInstall(). Returns the teardown promise so the
 *  ordering can be awaited/asserted. */
export function applyDownloadedUpdate(deps: ApplyDownloadedUpdateDeps): Promise<void>
