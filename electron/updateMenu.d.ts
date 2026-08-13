// Type declarations for the plain-CJS electron/updateMenu.js. The module stays JS
// (Electron loads electron/main.js directly and cannot import TypeScript); the
// vitest suite gets types from here. Runtime resolves the .js; TypeScript resolves
// this .d.ts — the same split as electron/autoUpdate.d.ts / lockdown.d.ts.

/** The public distribution repo's releases page — where "Release Notes" points,
 *  and the same feed electron-updater installs from. */
export declare const RELEASE_NOTES_URL: string

/** Ceiling on a MANUAL check. electron-updater's checkForUpdates() has no
 *  timeout, and a promise that never settles would wedge the in-flight flag —
 *  every later click answering "already checking" for the rest of the session. */
export declare const MANUAL_CHECK_TIMEOUT_MS: number

/** Await `promise`, rejecting after `ms`. Timers injectable so tests do not sleep. */
export declare function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timers?: { setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (h: unknown) => void },
): Promise<T>

/** Stable id of the "Check for Updates…" item, so callers/tests never match on a
 *  display label. */
export declare const MENU_ID_CHECK_FOR_UPDATES: string
/** Stable id of the "Release Notes" item. */
export declare const MENU_ID_RELEASE_NOTES: string

/** The app's UI language as this settings.json CONTENT declares it. English-first
 *  (unset ⇒ 'en'); a missing/corrupt file reads as 'en' rather than throwing. */
export declare function languageFromSettingsRaw(raw: string | null | undefined): 'en' | 'ja'

/** A menu template entry, as `Menu.buildFromTemplate` consumes it. Deliberately
 *  loose: the builder emits role-driven entries whose exact shape is Electron's,
 *  and the test asserts on `role` / `id` / `submenu` only. */
export interface MenuTemplateEntry {
  id?: string
  label?: string
  role?: string
  type?: string
  click?: () => void
  submenu?: MenuTemplateEntry[]
  [key: string]: unknown
}

export interface AppMenuTemplateOptions {
  /** Display name for the app submenu and its About/Hide/Quit labels
   *  ('OPEN GROUND' — NOT `app.name`, which is the lowercase package name). */
  appName: string
  /** darwin ⇒ the item goes in the app submenu; otherwise at the top of Help. */
  isMac: boolean
  onCheckForUpdates: () => void
  onOpenReleaseNotes: () => void
}

/** Build the whole application menu: the standard `role:` submenus (which ARE
 *  Electron's defaults, so Cmd+C/V/DevTools/Minimize keep working) plus the
 *  "Check for Updates…" item, placed per platform convention. */
export declare function buildAppMenuTemplate(opts: AppMenuTemplateOptions): MenuTemplateEntry[]

export interface ManualCheckState {
  /** app.isPackaged — an unpackaged build has no updater at all. */
  packaged: boolean
  /** Work mode (electron/lockdown.js) — suppresses checks, both periodic and manual. */
  lockdown: boolean
  /** Is an update already downloaded and awaiting a restart? A boolean, not the
   *  version string — having the update must not hinge on having named it. */
  updateDownloaded?: boolean
  /** Is a manual check already running? */
  inFlight?: boolean
  /** Has initAutoUpdater run, and did it find electron-updater? 'pending' is a
   *  REAL state: the menu is installed before the updater is wired. Absent is
   *  treated as 'ready' for back-compat. */
  updater?: 'pending' | 'ready' | 'unavailable'
}

/** What a manual "Check for Updates…" click should do before any network is
 *  touched. Precedence: dev → restart → lockdown → busy → starting → unavailable
 *  → check (see the .js header for why `restart` outranks `lockdown`, and why
 *  `starting` and `unavailable` are not the same answer). */
export declare function manualCheckPrecondition(
  state: ManualCheckState,
): 'dev' | 'restart' | 'lockdown' | 'busy' | 'starting' | 'unavailable' | 'check'

/** How to read electron-updater's `checkForUpdates()` result. An unknown shape
 *  degrades toward "there is an update", never toward a false all-clear; `null`
 *  (the updater declined) reports as 'unavailable'. */
export declare function manualCheckOutcome(args: {
  result: unknown
  currentVersion: string
}): { kind: 'up-to-date' | 'downloading' | 'unavailable'; version: string }

export type UpdateDialogKind =
  | 'dev'
  | 'lockdown'
  | 'busy'
  | 'starting'
  | 'unavailable'
  | 'up-to-date'
  | 'downloading'
  | 'error'
  | 'downloaded'
  | 'download-failed'

export interface UpdateDialogText {
  message: string
  detail: string
  /** Present only for 'downloaded' (Restart now / Later) and 'download-failed'
   *  (Open release page / Close). */
  buttons?: string[]
  defaultId?: number
  cancelId?: number
}

/** User-facing copy for every update dialog, in the app's own language (the menu
 *  labels stay English to match the system-rendered menu bar — see the .js header). */
export declare function updateDialogText(
  lang: 'en' | 'ja',
  kind: UpdateDialogKind,
  opts?: { version?: string | null; error?: string | null },
): UpdateDialogText
