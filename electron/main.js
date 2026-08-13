// OPEN GROUND — Electron main process.
//
// This is the Electron translation of scripts/openground-launch.sh. The shell
// launcher's job was: probe → (bootstrap: spawn server → wait /api/health →
// open window) → tear down on quit. Electron owns the window natively, so the
// main process only has to own the *server child* and the *readiness gate*.
//
// Two modes, selected by OPENGROUND_ELECTRON_MODE:
//   - 'dev'  : a Vite dev server (renderer, HMR) is ALREADY running on
//              DEV_URL and a Hono backend is ALREADY listening on the fixed
//              port (both started by `npm run electron:dev` via concurrently).
//              We don't spawn anything — we wait until /api/health answers,
//              then loadURL(DEV_URL). The Vite dev server proxies /api to Hono,
//              so HMR + live API both work.
//   - 'prod' : we fork the bundled Hono server (server/dist/index.cjs) as a
//              Node child. That single process BOTH serves the Vite build
//              (dist-web/) as static files AND answers /api on the fixed port,
//              so the whole app is one origin. We wait for /api/health to echo
//              our bootId, then loadURL(BASE_URL). The child dies with us
//              (before-quit → SIGTERM → 5s → SIGKILL).
//
// Single source of truth for "is the server ours": GET /api/health must return
// 200 with { app: 'openground', bootId: <our bootId> }. In dev the running
// server may not carry our bootId (it was started by a separate `npm run dev`),
// so dev only requires app === 'openground'. Prod requires the exact bootId,
// exactly like the shell launcher's STEP 6.

const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, Notification } = require('electron')
const path = require('path')
const http = require('http')
const net = require('net')
const os = require('os')
const { fork, spawn, execFileSync } = require('child_process')
const crypto = require('crypto')
const { readBakedAuthEnv } = require('./runtimeConfig')
const { maybeResetCachesOnVersionChange } = require('./cacheReset')
const { runStartupSequence } = require('./startup')
const { buildServerForkEnv } = require('./forkEnv')
const { buildProducerEnv, buildStepEnv, makeGateHome, removeGateHome } = require('./gateEnv')
const {
  runSelfUpdateCycle,
  performEngineSwitch,
  performRollback,
  killProcessTree,
  gracefulGroupKill,
  runRegressionSteps,
} = require('./selfUpdate')
const { hasLiveForkedChildren, applyDownloadedUpdate } = require('./autoUpdate')
const {
  AUTO_APPLY_POLL_MS,
  SAFETY_FETCH_TIMEOUT_MS,
  autoUpdateFromSettingsRaw,
  decideAutoApply,
  decideDownloadedAction,
} = require('./autoUpdatePolicy')
const { isLockdownEnabled, isRendererUrlAllowedUnderLockdown, settingsFilePath } = require('./lockdown')
const { decideCrashResponse } = require('./crashRespawn')
const {
  RELEASE_NOTES_URL,
  MANUAL_CHECK_TIMEOUT_MS,
  withTimeout,
  languageFromSettingsRaw,
  buildAppMenuTemplate,
  manualCheckPrecondition,
  manualCheckOutcome,
  updateDialogText,
} = require('./updateMenu')

// ---------------------------------------------------------------------------
// Constants — mirror scripts/openground-launch.sh.
// ---------------------------------------------------------------------------
const FIXED_PORT = 47776
const HOST = '127.0.0.1'
const BASE_URL = `http://${HOST}:${FIXED_PORT}`
const HEALTH_URL = `${BASE_URL}/api/health`

// In dev the renderer is the Vite dev server (HMR), NOT the Hono port. Vite
// proxies /api → 47776, so the health probe still uses HEALTH_URL (the Hono
// port) but the window loads DEV_URL. Override with OPENGROUND_DEV_URL.
const DEV_URL = process.env.OPENGROUND_DEV_URL || 'http://127.0.0.1:5174'

// Mode selection. An explicit OPENGROUND_ELECTRON_MODE always wins (so
// `electron:dev` / `electron:prod` npm scripts behave as named). Otherwise
// fall back on app.isPackaged: a packaged .app must run 'prod' (fork the
// bundled Hono server) — it can't assume a dev backend is already up.
const MODE =
  process.env.OPENGROUND_ELECTRON_MODE === 'prod'
    ? 'prod'
    : process.env.OPENGROUND_ELECTRON_MODE === 'dev'
      ? 'dev'
      : app.isPackaged
        ? 'prod'
        : 'dev'

// Readiness polling — matches the shell launcher: 250ms cadence, 120s ceiling.
const HEALTH_POLL_INTERVAL_MS = 250
const HEALTH_TIMEOUT_MS = 120_000
const HEALTH_REQUEST_TIMEOUT_MS = 2_000

// Child shutdown grace before we escalate to SIGKILL.
const CHILD_SIGTERM_GRACE_MS = 5_000

// A bootId for THIS launch. The bundled Hono server echoes it back through
// /api/health (via OPENGROUND_BOOT_ID) so we can prove the listener on :47776
// is the process we just forked.
const BOOT_ID = crypto.randomUUID()

// The project directory. In dev we run from the repo root (app.getAppPath()).
// In prod the user's project dir is whatever was scanned; OPEN GROUND derives
// it server-side, but we still pass a sane default so /api/health reports
// something coherent. Allow an explicit override.
const PROJECT_DIR =
  process.env.OPENGROUND_PROJECT_DIR || app.getAppPath()

// ---------------------------------------------------------------------------
// Self-update (the in-app swarm engine replacing itself; electron/selfUpdate.js).
//
// When the in-app swarm lands a self-improvement on OPEN GROUND's OWN source, the
// live engine is still its old self until it is rebuilt and re-forked. The forked
// server signals us over IPC (src/lib/server/selfUpdateSignal.ts → this process)
// and we run the unmanned cycle: rebuild → canary on a SEPARATE port → /api/health
// → switch on the fixed port. See electron/selfUpdate.js for the safety contract.
//
// ARMED ONLY for a non-packaged electron:prod run — i.e. dogfooding the engine
// from a source checkout, the only place where `npm run build` and a source repo
// both exist. A shipped .app (app.isPackaged) is NEVER self-updated here: it has
// no source to rebuild and updates through electron-updater instead (initAutoUpdater
// below). OPENGROUND_SELF_UPDATE=1/0 force on/off for verification.
//
// SINGLE-INSTANCE LOCK is unaffected: the canary and the post-switch engine are
// FORKED NODE SERVERS (ELECTRON_RUN_AS_NODE=1), not second Electron app instances,
// so requestSingleInstanceLock() never sees them.
const SELF_UPDATE_ARMED =
  process.env.OPENGROUND_SELF_UPDATE === '0'
    ? false
    : process.env.OPENGROUND_SELF_UPDATE === '1'
      ? true
      : MODE === 'prod' && !app.isPackaged

// MUST match SELF_UPDATE_MESSAGE in src/lib/server/selfUpdateSignal.ts (main.js
// is plain JS Electron loads directly — it can't import the bundled .ts).
const SELF_UPDATE_MESSAGE = 'openground:self-update'

// Escalation safety valve (card 6fe48c1f). MUST match the literals in
// src/lib/server/osNotify.ts. OS_NOTIFY_MESSAGE: the server asks us to show an
// OS-native toast for a FATAL swarm event (server→main). CREATE_NOTIFICATION_MESSAGE:
// we ask the server to create an in-app notification for a self-update rollback /
// canary failure (main→server — events only Electron observes).
const OS_NOTIFY_MESSAGE = 'openground:notify'
const CREATE_NOTIFICATION_MESSAGE = 'openground:create-notification'

// Self-update cycles that DID NOT switch (rebuild/canary/regression failure) in a
// row — when this reaches the threshold we escalate "canary昇格失敗の連続" to the
// human. Reset to 0 on a successful switch. (See onServerMessage.)
let selfUpdateConsecutiveFailures = 0
const CANARY_FAILURE_ALERT_THRESHOLD = 2

// The canary listens on the first free port at/above this base. Deliberately
// clear of the fixed port (47776) and the dev:alt range (47777+/5175+) so it
// never fights a second dev instance.
const CANARY_PORT_BASE = 47901
// A fresh build is unproven, so the canary/switch health waits are SHORT (a broken
// build should fail fast to the safe "stay on old" branch, not hang for 120s).
const CANARY_HEALTH_TIMEOUT_MS = 45_000
const SWITCH_HEALTH_TIMEOUT_MS = 45_000
// `npm run build` ceiling — vite + esbuild; generous so a cold build never trips it.
const BUILD_TIMEOUT_MS = 5 * 60_000

// Rollback (task 402d34a0) — the regression gate + the known-good build backup.
//
// REGRESSION GATE (task 402d34a0 + c76cb3f3). Health (bootId echo) only proves the
// new build STARTS — a self-modification can break the LOGIC while the build still
// boots, so booting alone must never promote a build. After the canary proves the
// build BOOTS, run the test suite against the freshly-built source and switch ONLY if
// it is also CORRECT (condition 2: "回帰テスト赤"). Two steps run IN ORDER, fail-fast:
//   1. unit — `npm test` (vitest run, the full ~450-test suite)
//   2. e2e  — `npm run test:e2e` (playwright smoke: builds + boots a prod Hono on its
//             OWN isolated port 47876 + tmp HOME, never the live 47776 / canary 47901)
// RED on EITHER step → stay on old (we never touch the live engine), and the FAILING
// STEP is named in the engine log (condition 4). Whole gate off with
// OPENGROUND_SELF_UPDATE_SKIP_TESTS=1; each step's command is independently overridable
// (OPENGROUND_SELF_UPDATE_TEST_CMD / OPENGROUND_SELF_UPDATE_E2E_CMD) so the verification
// harness can inject fast deterministic pass/fail stand-ins.
const REGRESSION_TIMEOUT_MS = 10 * 60_000
const SELF_UPDATE_RUN_TESTS = process.env.OPENGROUND_SELF_UPDATE_SKIP_TESTS !== '1'
const SELF_UPDATE_TEST_STEPS = [
  {
    name: 'unit',
    cmd: (process.env.OPENGROUND_SELF_UPDATE_TEST_CMD || 'npm test').split(/\s+/).filter(Boolean),
  },
  {
    name: 'e2e',
    cmd: (process.env.OPENGROUND_SELF_UPDATE_E2E_CMD || 'npm run test:e2e').split(/\s+/).filter(Boolean),
    // ★review-B M1: playwright puts its webServer (build → vite/esbuild → node on
    // port 47876) in a SEPARATE process group. So a forced kill of this step must go
    // through gracefulGroupKill (discover that group → SIGINT → escalate to SIGKILL),
    // NEVER killProcessTree (which SIGKILLs only this step's own group) — else the
    // webServer orphans, squats 47876, and the next e2e fails EADDRINUSE forever.
    ownsServerGroup: true,
    // PRODUCER — transitively. playwright.config.ts's webServer.command literally
    // starts with `npm run build && …`, so this "test" step re-runs the build, and
    // build:config would re-bake electron/runtime-config.json from THIS step's env.
    // With a verifier env that rewrote the config to `{}` right before the switch,
    // undoing runBuild's correct bake (review round 2, must-fix 1). The `unit` step
    // runs no build, so it stays a verifier. gateEnvParity.test.ts cross-checks
    // these flags against package.json + playwright.config.ts, so this cannot drift.
    producer: true,
  },
]
// Where the last known-good build is stashed for the duration of a cycle. OUT of the
// repo (os.tmpdir) so it never shows in git status; recreated fresh each cycle. Holds
// copies of server/dist + dist-web as they were while the live engine was healthy —
// the payload the rollback restores when a switch leaves the engine down.
const KNOWN_GOOD_BACKUP_DIR = path.join(os.tmpdir(), 'openground-self-update-lastgood')

// True while a self-update cycle is running — the re-entrancy guard (a second
// trigger mid-cycle is ignored). NOTE: this used to ALSO suppress the live engine's
// fatal-on-death handler for the whole cycle, but that was too broad (a GENUINE
// crash during the minutes-long rebuild/canary phases would be swallowed). The
// narrower isSwitching below now owns that suppression (R3).
let isSelfUpdating = false
// True ONLY during the fixed-port cutover window — the intentional stop of the old
// engine, the start of the new one, and any rollback that follows. THIS is what
// suppresses the live engine's fatal-on-unexpected-death handler, so the deliberate
// stop of the old engine at cutover never pops the "server died" dialog, while a
// real crash OUTSIDE the cutover (during rebuild/canary) still surfaces as fatal (R3).
let isSwitching = false
// Rollback state (task 402d34a0). knownGoodSnapshot = the build stashed at cycle
// start (the restore payload); liveEngineSha = the sha the running engine
// corresponds to (rollback target, for logs/notification); activeCanaryHandle /
// activeBuildChild = the in-flight children so before-quit can reap them mid-cycle (R4).
let knownGoodSnapshot = null
let liveEngineSha = null
let activeCanaryHandle = null
let activeBuildChild = null
// The e2e (playwright) regression child, tracked SEPARATELY from activeBuildChild
// because playwright launches its webServer (port 47876) in a SECOND process group.
// killProcessTree SIGKILLs only the child's OWN group → that webServer orphans and
// squats the port (task c76cb3f3 review-B M1). So every forced-kill path routes this
// one through gracefulGroupKill, which DISCOVERS the webServer's group and SIGINTs it
// directly (then SIGKILL-escalates) — SIGINT, not SIGTERM, is what makes playwright
// tear the webServer down. At most one of activeBuildChild / activeE2eChild is set at a
// time — the gate steps run serially.
let activeE2eChild = null
// The login-shell PATH, resolved once and reused for every fork + the build (the
// ~560ms `zsh -lic` probe should not run per self-update fork).
let cachedEnrichedPath = null

// The login-shell PATH. A .app started from Finder/Dock has a stripped PATH;
// the forked Hono server (and the node-pty children it spawns: zsh, claude,
// git) need the user's real PATH — nvm node, ~/.local/bin/claude,
// /opt/homebrew/bin, etc. We ask the login shell for it, the same way
// scripts/openground-launch.sh ran under `zsh -lic`.
//
// This used to run as a top-level synchronous `execSync` (~560ms) that blocked
// the entire main-process init — window creation included. It is now resolved
// asynchronously (execFile) just before we fork the server, so it never
// blocks bringing the window up. We only need the value before `fork`, and
// spawnServerChild awaits it there.
const pathFallback = () =>
  [
    process.env.PATH || '',
    `${process.env.HOME}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]
    .filter(Boolean)
    .join(':')

async function resolveEnrichedPath() {
  // Windows (and any non-macOS host): there is no login `zsh` to probe, the
  // homebrew/`~/.local/bin` fallbacks are meaningless, and PATH segments are
  // `;`-separated, not `:`-separated. A GUI-launched .exe inherits the user's
  // PATH through the registry, so process.env.PATH is already the right thing
  // to pass through — do NOT try to spawn a unix login shell here (it would
  // just throw and fall back, but make the intent explicit so we never exec
  // `/bin/zsh` on Windows). The `zsh -lic` probe below is macOS-specific
  // (Finder strips the .app's PATH; a login shell restores nvm/homebrew/claude).
  if (process.platform !== 'darwin') {
    return process.env.PATH || ''
  }
  const fallback = pathFallback()
  try {
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const execFileAsync = promisify(execFile)
    const shell = process.env.SHELL || '/bin/zsh'
    const { stdout } = await execFileAsync(
      shell,
      ['-lic', 'printf %s "$PATH"'],
      { encoding: 'utf8', timeout: 5000 }
    )
    const out = (stdout || '').trim()
    // Merge login PATH with the fallback so we never end up with less.
    return out ? `${out}:${fallback}` : fallback
  } catch {
    return fallback
  }
}

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null
/** @type {import('child_process').ChildProcess | null} */
let serverChild = null
let isQuitting = false
// Crash timestamps (ms epoch) for the crash-loop breaker (docs/ENGINE_PERSISTENCE_PLAN.md
// §6, card 5) — an unbounded ring pruned to the 10-minute window by decideCrashResponse.
let crashRespawnTimestamps = []

// ---------------------------------------------------------------------------
// Deep links — the `openground://` custom scheme (Figma-style invite links,
// docs/COLLAB_ZEROCONFIG_PLAN.md §3.3). An invite URL is
// `openground://join?code=<token>`; clicking it opens the app on the join flow.
//
//   - macOS delivers it via the `open-url` event (cold or warm).
//   - Windows/Linux deliver it as an argv to the (single-instance) second launch,
//     and on the very first launch as part of process.argv.
//
// We BUFFER the most recent link until a renderer is ready: the renderer fetches a
// cold-start link via the `openground:getInitialDeepLink` IPC (returns + clears the
// buffer) and listens for warm links via `openground:deep-link` (webContents.send).
// We only ever forward URLs of our own scheme — never an arbitrary string.
// ---------------------------------------------------------------------------
const DEEP_LINK_SCHEME = 'openground'
/** @type {string | null} */
let pendingDeepLink = null

// Pull the first `openground://…` token out of an argv array (Win/Linux delivery).
function deepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null
  const hit = argv.find(
    (a) => typeof a === 'string' && a.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`),
  )
  return hit || null
}

// Route a deep link to the renderer. If a window with a live renderer exists, send
// it now (warm path) and raise the window; otherwise buffer it for the renderer to
// pick up once it mounts (cold path). Ignores anything not of our scheme.
function deliverDeepLink(url) {
  if (typeof url !== 'string' || !url.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) {
    return
  }
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  if (wc && !wc.isLoading()) {
    wc.send('openground:deep-link', url)
    focusExistingWindow()
  } else {
    // No renderer yet (cold start) — buffer; the renderer asks via IPC on mount.
    pendingDeepLink = url
    focusExistingWindow()
  }
}

// ---------------------------------------------------------------------------
// Single instance — app.requestSingleInstanceLock(). A second `open` of the
// app gets denied the lock and quits immediately; the first instance gets a
// 'second-instance' event and raises its window. This is the Electron-native
// equivalent of the shell launcher's STEP 1 probe-and-raise.
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Claim the openground:// scheme. In dev (unpackaged) Electron must be told the
  // exact binary + script to relaunch, or the OS can't map the scheme back to us;
  // a packaged app registers itself via the bundle's Info.plist / registry
  // (electron-builder `protocols`), so the bare form is enough there.
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ])
    } else {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
    }
  } catch (err) {
    console.error('[openground] could not register protocol client:', err && err.message)
  }

  // macOS deep-link delivery (cold or warm). Registered up here (not in whenReady)
  // so a cold-start open-url that fires before the app is ready is still captured.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    deliverDeepLink(url)
  })

  app.on('second-instance', (_event, argv) => {
    // Win/Linux deliver a warm deep link as an argv to the second launch.
    const url = deepLinkFromArgv(argv)
    if (url) deliverDeepLink(url)
    focusExistingWindow()
  })

  app.whenReady().then(() => {
    // Heal a stale/corrupt Chromium cache left by an update/reinstall BEFORE any
    // window (and thus any renderer cache read) exists — see resetStaleCachesOnVersionChange.
    // The ordering (cache reset → IPC → window bringup) is encoded in
    // runStartupSequence (electron/startup.js) so a unit test can lock it
    // (server/__tests__/startup.test.ts) and go red if it is ever reordered.
    void runStartupSequence({
      resetCaches: resetStaleCachesOnVersionChange,
      registerIpc: registerIpcHandlers,
      start,
    })
  })

  // macOS: keep the app alive when all windows close (lives in the dock).
  // Re-activating (dock click) recreates a window. On other platforms, quit.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow()
      // The server is still up (we never tore it down on window close), so
      // just point the fresh window at it. dev → Vite dev server, prod → Hono.
      mainWindow.loadURL(MODE === 'dev' ? DEV_URL : BASE_URL)
    } else {
      focusExistingWindow()
    }
  })

  // Tear down EVERY forked child before the process exits. The live engine is the
  // common case, but a self-update cycle can also have a canary (its own port) and
  // an `npm run build` / regression child in flight — those would orphan if we quit
  // mid-cycle (R4). isQuitting is set FIRST so the cycle's health waits bail and the
  // rollback skips recovery. Async-safe via event.preventDefault() until the
  // children are gone (or the grace elapses).
  app.on('before-quit', (event) => {
    // Shared with the "Restart now" auto-update path (electron/autoUpdate.js): the
    // SAME predicate decides both "reap before quitting" here and "is teardown done
    // so quitAndInstall won't be intercepted" there. Keeping one definition means
    // the auto-update regression test (autoUpdate.test.ts) exercises this exact gate.
    const hasChildren = hasLiveForkedChildren({
      serverChild,
      activeCanaryHandle,
      activeBuildChild,
      activeE2eChild,
    })
    if (!hasChildren) return
    event.preventDefault()
    isQuitting = true
    // The build/vitest child shares npm's group and has no graceful protocol — SIGKILL
    // its WHOLE group outright (killing only the parent orphans the fork pool → 100%+
    // core saturation; detached spawn + group-kill reaps every worker, task 402d34a0
    // MUST-FIX1).
    killProcessTree(activeBuildChild)
    // The e2e (playwright) child spawns its webServer in a SEPARATE group, so route it
    // through gracefulGroupKill (discover that group → SIGINT → SIGKILL escalation) and
    // WAIT for it before quitting — a plain group SIGKILL would orphan the webServer on
    // port 47876 (review-B M1).
    Promise.all([
      gracefulGroupKill(activeE2eChild),
      shutdownServerChild(),
      activeCanaryHandle ? stopCanaryEngine(activeCanaryHandle) : Promise.resolve(),
    ]).finally(() => {
      app.quit()
    })
  })
}

// ---------------------------------------------------------------------------
// IPC handlers — the main-side implementation of the surface preload.js exposes
// via contextBridge ('openground'). Kept 1:1 with electron/preload.js: every
// ipcRenderer.invoke(channel) there must have exactly one ipcMain.handle here,
// or the renderer's invoke promise never settles (hangs). Registered once, at
// whenReady, before the renderer loads.
//   - 'app:getVersion'        → preload.getVersion()
//   - 'dialog:showOpenDialog' → preload.showOpenDialog(options); parented to
//                               mainWindow so it's a sheet, not a detached modal.
//   - 'shell:openExternal'    → preload.openExternal(url); opens an OAuth URL in
//                               the OS default browser for the optional login.
//                               STRICTLY allow-listed (see isAllowedOauthUrl) so
//                               the renderer can't turn the bridge into an
//                               arbitrary "open any URL/protocol" capability.
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('dialog:showOpenDialog', async (_event, options) => {
    // Parent the dialog to the main window when we have one (sheet on macOS);
    // fall back to a window-less dialog if the window isn't up yet.
    return mainWindow
      ? dialog.showOpenDialog(mainWindow, options)
      : dialog.showOpenDialog(options)
  })

  // Open an OAuth authorize URL in the user's real browser. We refuse anything
  // that isn't https: to a known auth host — the renderer hands us a URL it got
  // from /api/auth/start (a Supabase authorize endpoint), so a tight allow-list
  // is both sufficient and the safe default. Returns false on rejection rather
  // than throwing so the renderer's invoke promise always settles.
  ipcMain.handle('shell:openExternal', async (_event, url) => {
    if (!isAllowedOauthUrl(url)) {
      console.error('[openground] refused shell:openExternal for', url)
      return false
    }
    await shell.openExternal(url)
    return true
  })

  // Hand the renderer the cold-start deep link the app was launched with (if any),
  // then clear it so a later reload doesn't replay a stale join. Returns null when
  // there's nothing buffered. Warm links arrive separately via 'openground:deep-link'.
  ipcMain.handle('openground:getInitialDeepLink', () => {
    const url = pendingDeepLink
    pendingDeepLink = null
    return url
  })
}

// Allow-list for shell:openExternal. Must be https: and the host must be the
// Supabase project host (*.supabase.co — where the authorize endpoint lives) or
// a known provider domain (the OAuth consent screens the authorize step may
// redirect on to). Anything else is rejected.
function isAllowedOauthUrl(url) {
  if (typeof url !== 'string') return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  const allowedSuffixes = [
    '.supabase.co', // the project's auth origin (authorize / callback)
    'accounts.google.com',
    '.google.com',
    'github.com',
    '.github.com',
    '.githubusercontent.com',
  ]
  return allowedSuffixes.some(
    (suffix) =>
      suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix,
  )
}

// ---------------------------------------------------------------------------
// Window helpers.
// ---------------------------------------------------------------------------

// Navigation hardening (Electron security checklist #12 "Disable or limit
// navigation" / #13 "Disable or limit creation of new windows"). The renderer
// only ever needs to live on the app's own origin — the Vite dev server in dev,
// the Hono port in prod. Treat anything else as an external link: route http(s)
// to the OS browser and refuse to open it inside the app. This stops a stray
// target=_blank / window.open / errant in-app href from replacing the SPA or
// spawning a second, preload-backed BrowserWindow. (OAuth still flows through
// the separate, tightly allow-listed shell:openExternal IPC handler; the auth
// browser tab runs in the OS browser, never in this window, so will-navigate
// never sees it.)
function isAppOrigin(target) {
  try {
    const origin = new URL(target).origin
    return origin === new URL(BASE_URL).origin || origin === new URL(DEV_URL).origin
  } catch {
    return false
  }
}

function hardenNavigation(contents) {
  // New windows (window.open, target=_blank): never open inside the app; send
  // real web links to the OS browser, drop everything else.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Top-level navigations: allow same-origin (the SPA's own routes/reloads),
  // bounce anything external to the OS browser instead of loading it here.
  contents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'OPEN GROUND',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Keep timers un-clamped while minimized: xterm's write callbacks drive
      // the terminal flow-control ACKs, so a throttled background window would
      // push live claude output into the 10s pause/drop cycle (VS Code ships
      // the same setting for its flow-controlled terminal).
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  hardenNavigation(mainWindow.webContents)

  // Lock zoom to 100%. OPEN GROUND is a fixed-layout canvas app (the canvas has
  // its own pan/zoom), so accidental *browser* zoom — ⌘+/−/0 or trackpad pinch —
  // just shifts the chrome around and reads as a layout bug. Cap visual (pinch)
  // zoom to 1×, reset the zoom level on every load, and swallow the zoom
  // accelerators before they act.
  const lockZoom = () => {
    mainWindow?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {})
    mainWindow?.webContents.setZoomLevel(0)
  }
  mainWindow.webContents.on('did-finish-load', lockZoom)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && ['=', '+', '-', '0'].includes(input.key)) {
      event.preventDefault()
    }
  })

  // Hands-free updates: the auto-apply policy needs "how long has the user
  // been away" — track the last blur. Focus resets nothing (the policy reads
  // isFocused() live); blur just stamps when away-time started.
  mainWindow.on('blur', () => {
    lastBlurAt = Date.now()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

function focusExistingWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// ---------------------------------------------------------------------------
// Server bundle path resolution.
//
// `npm run build:server` (esbuild) emits a single self-contained CommonJS file
// at server/dist/index.cjs. That's what Electron prod forks instead of the old
// Next `.next/standalone/server.js`. Where it lands depends on packaging:
//   - dev/unpackaged: inside the repo at <appPath>/server/dist/index.cjs.
//   - packaged (asar): a Node child can't `fork` a script inside the asar
//     archive, so electron-builder ships server/dist outside it. With the
//     `server/dist/**` glob in build.files + asarUnpack it lands under
//     <resources>/app.asar.unpacked/server/dist/index.cjs. We probe the
//     likely locations and use whichever exists.
// ---------------------------------------------------------------------------
function resolveServerBundle() {
  const fs = require('fs')
  const candidates = [
    // Packaged: unpacked out of the asar so it's forkable.
    path.join(
      process.resourcesPath || '',
      'app.asar.unpacked',
      'server',
      'dist',
      'index.cjs'
    ),
    path.join(process.resourcesPath || '', 'server', 'dist', 'index.cjs'),
    // Dev / unpackaged: straight out of the repo build.
    path.join(app.getAppPath(), 'server', 'dist', 'index.cjs'),
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

// Where the built Vite SPA (dist-web/) lives at runtime — the bundled Hono
// server serves it statically. Mirrors resolveServerBundle's packaging logic.
// Returned via OPENGROUND_WEB_ROOT so server/app.ts knows where to look without
// relying on the forked child's cwd.
function resolveWebRoot() {
  const fs = require('fs')
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'dist-web'),
    path.join(process.resourcesPath || '', 'dist-web'),
    path.join(app.getAppPath(), 'dist-web'),
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// Fork the bundled Hono server (prod only).
//
// ELECTRON_RUN_AS_NODE=1 makes the forked Electron binary behave as plain
// Node, so the CJS bundle runs as a Node process (the spike-proven path for
// loading node-pty + spawning `claude`). We pass PORT/HOSTNAME so Hono binds
// the fixed port, OPENGROUND_BOOT_ID / OPENGROUND_PROJECT_DIR so /api/health
// can identify us, and OPENGROUND_WEB_ROOT so the server serves the right
// dist-web regardless of the child's cwd.
//
// cwd: the app root that holds scripts/ + src/designs/. screenWatcher.ts (and
// the package.json readers in the misc/feedback routes) still derive paths
// from process.cwd(), so the child must run from a dir where those exist.
// (hooksInstall.ts / ogManageSkill.ts are deliberately cwd-INDEPENDENT — they
// anchor at their own module location and refuse worktree roots — so the
// global ~/.claude wiring stays safe even if a caller gets the cwd wrong.)
// We anchor it at the bundle's app root (two levels up from
// server/dist/index.cjs).
// ---------------------------------------------------------------------------
// Resolve (and memoize) the login-shell PATH. Async — the ~560ms `zsh -lic`
// probe should run at most once, then be reused by every fork + the self-update
// build, never re-run per canary/switch.
async function getEnrichedPath() {
  if (cachedEnrichedPath == null) cachedEnrichedPath = await resolveEnrichedPath()
  return cachedEnrichedPath
}

// The app root (holds scripts/ + src/ + package.json): two dirs up from
// server/dist/index.cjs. The forked server's cwd AND the self-update build's cwd
// AND the OPENGROUND_SOURCE_ROOT we self-gate on. Throws if the bundle is absent.
function getAppRoot() {
  const serverPath = resolveServerBundle()
  if (!serverPath) {
    throw new Error(
      'could not locate server/dist/index.cjs — run `npm run build:server` ' +
        '(or `npm run build`) before electron:prod, or check that server/dist ' +
        'is shipped (asarUnpack) for the packaged app'
    )
  }
  return path.resolve(path.dirname(serverPath), '..', '..')
}

// ---------------------------------------------------------------------------
// Fork the bundled Hono server. The LOW-LEVEL primitive shared by the initial
// live engine, the self-update canary, and the post-switch engine. It only forks
// + pipes stdout/stderr; the CALLER attaches the role-appropriate exit handler
// (fatal for the live engine, benign for the canary) and tracks the child.
//
// `port`/`bootId` vary per role. `home` (OPENGROUND_HOME) isolates the canary on
// a scratch dir so it never touches the real ~/.openground while the live engine
// runs. `sourceRoot` (OPENGROUND_SOURCE_ROOT) is set ONLY for the live engine
// when self-update is armed, so only the live engine can ever request a
// self-update (the canary must never trigger another cycle).
//
// ELECTRON_RUN_AS_NODE=1 + the security-critical env layering come from the
// unit-tested buildServerForkEnv (electron/forkEnv.js); OPENGROUND_HOME /
// OPENGROUND_SOURCE_ROOT are spread AFTER it (neither touches the collab WS-URL
// lock, so the token-relay invariant is preserved).
// ---------------------------------------------------------------------------
async function forkEngine({ port, bootId, sourceRoot, home, label, bootKind }) {
  const serverPath = resolveServerBundle()
  if (!serverPath) {
    throw new Error(
      'could not locate server/dist/index.cjs — run `npm run build:server` ' +
        '(or `npm run build`) before electron:prod, or check that server/dist ' +
        'is shipped (asarUnpack) for the packaged app'
    )
  }
  const appRoot = path.resolve(path.dirname(serverPath), '..', '..')
  const webRoot = resolveWebRoot()
  const enrichedPath = await getEnrichedPath()
  const bakedAuthEnv = readBakedAuthEnv()

  const child = fork(serverPath, [], {
    cwd: appRoot,
    detached: false, // tied to our lifetime; dies with the parent tree.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...buildServerForkEnv({
        bakedAuthEnv,
        processEnv: process.env,
        port,
        host: HOST,
        bootId,
        projectDir: PROJECT_DIR,
        webRoot,
        enrichedPath,
      }),
      ...(sourceRoot ? { OPENGROUND_SOURCE_ROOT: sourceRoot } : {}),
      ...(home ? { OPENGROUND_HOME: home } : {}),
      OPENGROUND_BOOT_KIND: bootKind || 'normal',
    },
  })

  const tag = label || 'hono'
  child.stdout?.on('data', (d) => process.stdout.write(`[${tag}] ${d}`))
  child.stderr?.on('data', (d) => process.stderr.write(`[${tag}] ${d}`))
  return child
}

// Fork the LIVE engine on the fixed port: the initial launch AND the post-switch
// engine both go through here. Attaches the fatal-on-unexpected-death handler and
// the self-update IPC trigger listener, and records it as serverChild. When
// self-update is armed we pass OPENGROUND_SOURCE_ROOT so this engine (and only
// this engine) can request the next cycle.
async function spawnLiveEngine({ bootId, bootKind }) {
  // PUBLIC build-time config (login + collab) — logged once so a dogfood run can
  // confirm the baked config reached the fork. (Full rationale on forkEnv.js.)
  const bakedAuthEnv = readBakedAuthEnv()
  console.log(
    `[openground] app login: ${bakedAuthEnv.SUPABASE_URL ? 'enabled (baked config present)' : 'disabled (no baked config)'}`
  )
  console.log(
    `[openground] realtime collab: ${bakedAuthEnv.OPENGROUND_REALTIME && bakedAuthEnv.OPENGROUND_COLLAB_WS_URL ? 'enabled (baked config present)' : 'disabled (no baked config)'}`
  )

  const child = await forkEngine({
    port: FIXED_PORT,
    bootId,
    sourceRoot: SELF_UPDATE_ARMED ? getAppRoot() : undefined,
    label: 'hono',
    bootKind,
  })

  child.on('exit', (code, signal) => {
    serverChild = null
    // An unexpected death (not during our own quit, and not while we are
    // deliberately tearing the old engine down for a self-update cutover) needs
    // a decision — respawn or fatal. During a cutover, isSwitching suppresses
    // this so the intentional stop of the OLD engine (and the teardown of a
    // failed new engine during rollback) never triggers either path — but a
    // real crash during the rebuild/canary phases, when isSwitching is false,
    // still goes through the decision below (R3).
    if (isQuitting || isSwitching) return

    // app.exit(1) (fatal path) does NOT fire before-quit, so synchronously reap
    // any in-flight self-update children FIRST — otherwise a live-engine crash
    // mid rebuild/regression would orphan the (detached) vitest fork pool and
    // saturate the machine, the exact hazard MUST-FIX1's group-kill exists to
    // prevent. No-op on a normal run (these refs are null unless a self-update
    // is in flight). Reap unconditionally — a respawn must not carry the old
    // cycle's orphans forward either (ENGINE_PERSISTENCE_PLAN §6, card 5).
    killProcessTree(activeBuildChild)
    // The e2e (playwright) child spawns its webServer in a separate group.
    // gracefulGroupKill SYNCHRONOUSLY discovers that group and SIGINTs it here; the
    // node webServer exits on SIGINT, so port 47876 frees even though app.exit below
    // won't wait for the grace/escalation (a plain SIGKILL of only G1 would orphan it,
    // review-B M1).
    gracefulGroupKill(activeE2eChild)
    if (activeCanaryHandle && activeCanaryHandle.child) {
      try {
        activeCanaryHandle.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }

    const decision = decideCrashResponse({
      timestamps: crashRespawnTimestamps,
      now: Date.now(),
      isQuitting,
      isSwitching,
    })
    crashRespawnTimestamps = decision.timestamps || crashRespawnTimestamps

    if (decision.action === 'respawn') {
      console.log(
        `[openground] server exited unexpectedly (code=${code} signal=${signal}) — ` +
          `respawning in ${decision.delayMs}ms (crash-loop breaker: ${crashRespawnTimestamps.length}/3 in this 10-minute window)`
      )
      setTimeout(() => {
        void attemptCrashRespawn()
      }, decision.delayMs)
      return
    }

    dialog.showErrorBox(
      'OPEN GROUND',
      `The OPEN GROUND server exited unexpectedly (code=${code} signal=${signal}) too many times ` +
        `in a short window (crash-loop breaker tripped) — giving up.`
    )
    app.exit(1)
  })

  // The forked server asks us to self-update over IPC after it lands a
  // self-improvement on OPEN GROUND's own source (selfUpdateSignal.ts).
  child.on('message', onServerMessage)

  serverChild = child
  return { child, port: FIXED_PORT, bootId }
}

// Thin wrapper kept for start(): the initial live engine carries BOOT_ID.
async function spawnServerChild() {
  return spawnLiveEngine({ bootId: BOOT_ID, bootKind: 'normal' })
}

// Crash-loop breaker respawn (ENGINE_PERSISTENCE_PLAN.md §6, card 5): fork a fresh
// live engine with a NEW bootId (mirrors the self-update canary's own-bootId
// pattern — waitForReady's default watchChild picks up the new child the instant
// spawnLiveEngine sets serverChild) tagged OPENGROUND_BOOT_KIND=crash-respawn so
// server-side boot (§4-2's breaker) can tell a real crash apart from a normal
// launch. Reloads the renderer once healthy — it reuses the same health-wait the
// renderer shows during a cold start, so no separate "restarting" UI is needed.
// If the respawn itself fails to come up, that's unrecoverable — fall through to
// the same fatal dialog the exhausted-window path uses.
async function attemptCrashRespawn() {
  try {
    await spawnLiveEngine({ bootId: crypto.randomUUID(), bootKind: 'crash-respawn' })
    await waitForReady((body) => body && body.app === 'openground')
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(MODE === 'dev' ? DEV_URL : BASE_URL)
    }
  } catch (err) {
    dialog.showErrorBox(
      'OPEN GROUND',
      `The OPEN GROUND server could not be restarted after a crash: ${
        err && err.message ? err.message : String(err)
      }`
    )
    app.exit(1)
  }
}

// Graceful teardown for ANY forked child: SIGTERM, wait up to `graceMs`, then
// SIGKILL. Resolves once the child is gone (or we've force-killed it). Shared by
// the live-engine shutdown and the self-update canary teardown.
function terminateChild(child, graceMs = CHILD_SIGTERM_GRACE_MS) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve()
      return
    }

    let settled = false
    let killTimer
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve()
    }

    child.once('exit', done)

    try {
      child.kill('SIGTERM')
    } catch {
      done()
      return
    }

    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      done()
    }, graceMs)
  })
}

// Stop the LIVE engine (serverChild). Used at quit AND as the switch's "stop old".
function shutdownServerChild() {
  return terminateChild(serverChild)
}

// ---------------------------------------------------------------------------
// /api/health probing.
//
// pingHealth() resolves with the parsed JSON body on 2xx + valid JSON, else
// rejects. waitForReady() polls until the body satisfies the predicate or the
// timeout elapses — the Electron equivalent of the shell launcher's STEP 6.
// ---------------------------------------------------------------------------
function pingHealth(port = FIXED_PORT) {
  const url = `http://${HOST}:${port}/api/health`
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: HEALTH_REQUEST_TIMEOUT_MS }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error(`health status ${res.statusCode}`))
        return
      }
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw))
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error('health request timed out'))
    })
    req.on('error', reject)
  })
}

// Poll a server's /api/health until `predicate(body)` is true, then resolve with
// the body; reject on timeout (or if `watchChild` dies first). `port` selects the
// target (fixed port for the live engine, the canary's port for a canary).
// `watchChild`, when given, lets us bail the instant a forked child we are waiting
// on exits — the prod equivalent of the shell launcher's STEP 6. In dev no child
// is passed (the backend is a separate process), so polling just runs to timeout.
function waitForReady(
  predicate,
  { port = FIXED_PORT, watchChild = serverChild, timeoutMs = HEALTH_TIMEOUT_MS } = {},
) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = async () => {
      // If a child we are watching died while we were waiting, bail immediately.
      if (watchChild && (watchChild.exitCode !== null || watchChild.killed)) {
        reject(new Error('server process exited before becoming ready'))
        return
      }
      try {
        const body = await pingHealth(port)
        if (predicate(body)) {
          resolve(body)
          return
        }
      } catch {
        /* not up yet — keep polling */
      }
      if (Date.now() >= deadline) {
        reject(new Error(`server did not become ready within ${timeoutMs / 1000}s`))
        return
      }
      setTimeout(tick, HEALTH_POLL_INTERVAL_MS)
    }
    void tick()
  })
}

// Boolean health gate for the self-update cycle: resolve true iff /api/health on
// `port` echoes `expectBootId` (proving the listener is the fork we just made)
// within `timeoutMs`, else false. Never throws — the cycle branches on the bool,
// and any failure (timeout, child death, bad JSON) means "not healthy → don't
// switch", the safe side.
async function pollHealthy({ port, expectBootId, watchChild, timeoutMs }) {
  try {
    await waitForReady(
      (body) =>
        !!body &&
        body.app === 'openground' &&
        (!expectBootId || body.bootId === expectBootId),
      { port, watchChild, timeoutMs },
    )
    return true
  } catch {
    return false
  }
}

// First free TCP port at/above `base` on the loopback host — the canary binds it.
// Tries a bounded window so a pathological "everything taken" never loops forever.
function findFreePort(base) {
  const tryPort = (p) =>
    new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(p, HOST)
    })
  return (async () => {
    for (let p = base; p < base + 50; p++) {
      // eslint-disable-next-line no-await-in-loop
      if (await tryPort(p)) return p
    }
    throw new Error(`no free port found in ${base}..${base + 50}`)
  })()
}

// ---------------------------------------------------------------------------
// Port-conflict diagnostics. When startup fails, the single most common
// (and most confusing) cause is something already squatting on port 47776.
// We synchronously probe for the listening PID — this only runs on the
// already-fatal path, so blocking is fine — and surface the exact recovery
// steps from CLAUDE.md's "Port 47776 is occupied" section inline in the
// dialog, instead of a generic "could not start".
// ---------------------------------------------------------------------------
function listeningPidsOnFixedPort() {
  // `lsof` is macOS/Linux-only. On Windows there's no equivalent one-liner we
  // can rely on (netstat output parsing is brittle and locale-dependent), so we
  // skip the PID probe entirely there — startup still surfaces the generic
  // "port in use / check the bundle" message, just without the exact PID/kill
  // recipe. Best-effort: a Windows user resolves the conflict via Task Manager
  // / `netstat -ano | findstr 47776`.
  if (process.platform === 'win32') return []
  try {
    const out = execFileSync(
      'lsof',
      ['-ti', `tcp:${FIXED_PORT}`, '-sTCP:LISTEN'],
      { encoding: 'utf8', timeout: 3000 }
    )
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    // lsof exits non-zero when nothing is listening (no match) — treat as
    // "no occupier found".
    return []
  }
}

function portConflictRecoveryText() {
  const pids = listeningPidsOnFixedPort()
  if (pids.length === 0) return null
  const pidList = pids.join(' ')
  const killTarget = pids.length === 1 ? pids[0] : `<pid>`
  return (
    `Port ${FIXED_PORT} is already in use by PID ${pidList}.\n\n` +
    `OPEN GROUND never shifts to another port — it must own ${FIXED_PORT}.\n` +
    `To recover, in Terminal:\n\n` +
    `  lsof -i :${FIXED_PORT}        # confirm the culprit\n` +
    `  kill ${killTarget}` + (pids.length === 1 ? '' : `              # kill each listed PID`) + `\n` +
    `  # if it won't die:  kill -9 ${killTarget}\n\n` +
    `If the culprit is a stale OPEN GROUND server (orphaned after a crash),\n` +
    `also clear its state, then relaunch:\n\n` +
    `  rm -rf ~/.openground/bootstrap.lock ~/.openground/server.json`
  )
}

// ---------------------------------------------------------------------------
// Cache self-heal (white-screen-after-reinstall fix).
//
// A reinstall/update over an existing user-data dir keeps the PREVIOUS install's
// Chromium caches (HTTP `Cache`, V8 `Code Cache`, GPU caches). If those are stale
// or corrupt relative to the freshly installed SPA bundle, the renderer can fail
// to boot and the window paints nothing but the background colour — the
// "white screen after reinstall" bug (observed 2026-06-21; moving the Cache dirs
// aside fixed it by hand, which this does automatically).
//
// We delete ONLY the regenerable Chromium cache directories (never
// localStorage/IndexedDB/cookies/login state) and ONLY when the version persisted
// in user-data differs from app.getVersion() — i.e. exactly on an update/reinstall
// or the first launch of this fix, never on a normal same-version relaunch (so
// steady-state startup speed is untouched). Runs in whenReady BEFORE createWindow()
// so the renderer hasn't opened the HTTP/Code caches yet — the safe moment to
// remove them. Wrapped so a clear failure can NEVER prevent the app from
// launching. Pure, unit-tested logic lives in electron/cacheReset.js.
// ---------------------------------------------------------------------------
function resetStaleCachesOnVersionChange() {
  try {
    maybeResetCachesOnVersionChange({
      userDataPath: app.getPath('userData'),
      currentVersion: app.getVersion(),
      log: (msg) => console.log(`[openground] ${msg}`),
    })
  } catch (err) {
    // Never fatal — fall through to a normal launch with the cache left as-is.
    console.error(
      '[openground] cache self-heal skipped:',
      err && err.message ? err.message : err,
    )
  }
}

// ---------------------------------------------------------------------------
// Self-update orchestration — the REAL side effects the pure cycle
// (electron/selfUpdate.js) drives. Kept here, thin, over that unit-tested core:
//   rebuild (npm run build) → canary on a free port → /api/health → switch.
// Triggered by the forked server's IPC message (selfUpdateSignal.ts) after it
// lands a self-improvement on OPEN GROUND's own source. See the SELF_UPDATE_ARMED
// note up top for why this only ever runs in a non-packaged electron:prod run.
// ---------------------------------------------------------------------------

// One log channel for the whole cycle so condition (5) — "one unmanned cycle,
// confirmed in the logs" — reads as a single, greppable [self-update] story.
function selfUpdateLog(level, msg) {
  const line = `[self-update] ${msg}`
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

// Run `npm run build` in the source checkout. Resolves { ok, reason? } — never
// rejects, so the cycle always branches cleanly (a failed build → stay on old).
function runBuild() {
  return new Promise((resolve) => {
    let appRoot
    let gateHome = null
    try {
      appRoot = getAppRoot()
    } catch (err) {
      resolve({ ok: false, reason: err && err.message ? err.message : 'no app root' })
      return
    }
    getEnrichedPath()
      .then((enrichedPath) => {
        selfUpdateLog('info', `rebuild: running \`npm run build\` (cwd ${appRoot})`)
        // Throwaway OPENGROUND_HOME (gateEnv.js): `npm run build` runs the
        // POST-MERGE tree's own package.json scripts. Same reason the canary
        // engine below gets a scratch home — the code under test never gets the
        // live one. Removed in settle(), and in the tail .catch if the spawn
        // below throws synchronously (EMFILE) before settle exists.
        //
        // buildProducerEnv, NOT buildGateEnv: this is the one PRODUCER step, and
        // its first stage (`build:config`) bakes BAKED_KEYS into
        // electron/runtime-config.json. Stripping them there does not preserve
        // the old file — it overwrites it with `{}`, silently shipping a build
        // with sign-in and collab disabled (review round 1, must-fix 1).
        gateHome = makeGateHome()
        const child = spawn('npm', ['run', 'build'], {
          cwd: appRoot,
          env: buildProducerEnv({ home: gateHome, extra: { PATH: enrichedPath } }),
          stdio: ['ignore', 'pipe', 'pipe'],
          // detached → own process group on POSIX, so a timeout/quit can SIGKILL the
          // WHOLE tree (npm + vite/esbuild forks), not just npm (task 402d34a0 R4).
          detached: process.platform !== 'win32',
          shell: process.platform === 'win32', // npm is npm.cmd on Windows
        })
        // Track for before-quit reaping (R4): a quit mid-build must not orphan npm.
        activeBuildChild = child
        let settled = false
        let timer
        const settle = (v) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (activeBuildChild === child) activeBuildChild = null
          removeGateHome(gateHome)
          gateHome = null
          resolve(v)
        }
        child.stdout?.on('data', (d) => process.stdout.write(`[build] ${d}`))
        child.stderr?.on('data', (d) => process.stderr.write(`[build] ${d}`))
        child.on('error', (err) =>
          settle({ ok: false, reason: err && err.message ? err.message : 'spawn error' }),
        )
        child.on('exit', (code) =>
          settle(code === 0 ? { ok: true } : { ok: false, reason: `build exited ${code}` }),
        )
        timer = setTimeout(() => {
          // Asymmetry with spawnTestStep's e2e path, on purpose: killProcessTree is
          // a SYNCHRONOUS group SIGKILL of a tree that shares this child's group, so
          // by the time settle() removes the gate home the tree is already gone.
          // The e2e path defers its removal instead because gracefulGroupKill is
          // ASYNC (SIGINT → grace → SIGKILL of a SEPARATE webServer group), so
          // there the tree is still alive when settle() runs. Both are best-effort;
          // the difference is whether a kill has already completed. (Round 4 nit.)
          killProcessTree(child)
          settle({ ok: false, reason: `build timed out after ${BUILD_TIMEOUT_MS / 1000}s` })
        }, BUILD_TIMEOUT_MS)
      })
      .catch((err) => {
        // Reached when getEnrichedPath rejects OR when the block above threw
        // before `settle` existed (a synchronous spawn failure such as EMFILE).
        // In the latter case the throwaway home is already made, so clean it up
        // here too — settle() will never run.
        removeGateHome(gateHome)
        gateHome = null
        resolve({ ok: false, reason: err && err.message ? err.message : 'path error' })
      })
  })
}

// Fork the freshly-built engine as a CANARY on a free port, isolated on a scratch
// OPENGROUND_HOME so it never disturbs the live engine's ~/.openground. No
// OPENGROUND_SOURCE_ROOT → the canary can never itself request a self-update.
async function spawnCanaryEngine() {
  const port = await findFreePort(CANARY_PORT_BASE)
  const bootId = crypto.randomUUID()
  const home = path.join(os.tmpdir(), `openground-canary-${bootId}`)
  try {
    require('fs').mkdirSync(home, { recursive: true })
  } catch {
    /* best-effort — the server creates its home dirs too */
  }
  const child = await forkEngine({ port, bootId, home, label: 'hono:canary' })
  // Benign exit handler: a canary death just means the new build didn't stay up;
  // the health poll then reports unhealthy → safe "stay on old". NEVER fatal.
  child.on('exit', (code, signal) => {
    selfUpdateLog('info', `canary exited (code=${code} signal=${signal})`)
  })
  const handle = { child, port, bootId, home }
  // Track for before-quit reaping (R4): a quit mid-cycle must not orphan the canary.
  activeCanaryHandle = handle
  return handle
}

// Tear a canary down and remove its scratch home (both best-effort).
async function stopCanaryEngine(handle) {
  if (!handle) return
  // Clear the before-quit tracking ref the moment we begin teardown (R4).
  if (activeCanaryHandle === handle) activeCanaryHandle = null
  await terminateChild(handle.child)
  if (handle.home) {
    try {
      require('fs').rmSync(handle.home, { recursive: true, force: true })
    } catch {
      /* best-effort — a tmp leftover is swept by the OS eventually */
    }
  }
}

// ---------------------------------------------------------------------------
// Rollback (task 402d34a0) — the REAL side effects of performRollback, plus the
// known-good snapshot/restore and the regression gate. A switch stops the old
// engine to free the fixed port, then forks the new build there; if the new engine
// never comes up healthy the app would be bricked. These make the engine SURVIVE
// that by snapshotting the healthy build (at boot + after each successful switch —
// never at rebuild time, MUST-FIX2) and restoring it on a failed switch. Everything
// here only runs on the armed self-update path.
// ---------------------------------------------------------------------------

// Best-effort git sha of the source checkout, for rollback observability (condition
// 1: the known-good pointer is "commit sha + build artifact"). Synchronous with a
// short timeout; only ever called on the armed path, never in a shipped run. Returns
// 'unknown' on any failure (detached HEAD, no git, timeout).
function currentHeadSha() {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: getAppRoot(),
      encoding: 'utf8',
      timeout: 3000,
    })
    return out.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

// Snapshot the CURRENT on-disk build (server/dist + dist-web) as the rollback restore
// payload. CRITICAL (MUST-FIX2): only call this where on-disk is PROVABLY the build
// the live healthy engine is running — i.e. at armed boot (engine just forked from
// it, health OK) and right after a successful switch (new build just forked + proved
// healthy). NEVER at rebuild time: after a rejected cycle the on-disk build is the
// rejected one (left un-restored), so snapshotting then would stamp a broken build
// good. THROWS on copy failure; callers treat that as best-effort (keep the previous
// snapshot / log that rollback is unavailable) — they never abort a completed switch.
function captureKnownGood() {
  const fs = require('fs')
  const appRoot = getAppRoot()
  const serverDist = path.join(appRoot, 'server', 'dist')
  const webRoot = path.join(appRoot, 'dist-web')
  fs.rmSync(KNOWN_GOOD_BACKUP_DIR, { recursive: true, force: true })
  fs.mkdirSync(KNOWN_GOOD_BACKUP_DIR, { recursive: true })
  fs.cpSync(serverDist, path.join(KNOWN_GOOD_BACKUP_DIR, 'server-dist'), { recursive: true })
  fs.cpSync(webRoot, path.join(KNOWN_GOOD_BACKUP_DIR, 'dist-web'), { recursive: true })
  knownGoodSnapshot = { dir: KNOWN_GOOD_BACKUP_DIR, appRoot, sha: liveEngineSha || 'unknown' }
  selfUpdateLog(
    'info',
    `known-good build snapshotted (sha ${knownGoodSnapshot.sha}) → ${KNOWN_GOOD_BACKUP_DIR}`,
  )
}

// Restore the snapshotted known-good artifacts over the (broken) on-disk build, so
// the re-forked engine runs the previous good self — and so a later relaunch also
// forks the good build, not the broken one. THROWS on failure → performRollback
// reports restore-failed.
function restoreKnownGood() {
  const fs = require('fs')
  if (!knownGoodSnapshot) throw new Error('no known-good snapshot was taken')
  const { dir, appRoot } = knownGoodSnapshot
  const serverDist = path.join(appRoot, 'server', 'dist')
  const webRoot = path.join(appRoot, 'dist-web')
  fs.rmSync(serverDist, { recursive: true, force: true })
  fs.cpSync(path.join(dir, 'server-dist'), serverDist, { recursive: true })
  fs.rmSync(webRoot, { recursive: true, force: true })
  fs.cpSync(path.join(dir, 'dist-web'), webRoot, { recursive: true })
}

// Spawn ONE regression step (a single test command) against the freshly-built source
// checkout. detached so the child leads its own process group (task 402d34a0 MUST-FIX1):
// vitest runs a FORK POOL and `npm run build` forks vite/esbuild — killing only the npm
// PARENT would orphan those workers (100%+ core saturation), so the group lets us reap
// the whole pool. The FORCED-KILL differs by step (review-B M1): vitest/build share
// npm's group → killProcessTree (immediate SIGKILL); the e2e step's playwright spawns
// its webServer in a SEPARATE group → gracefulGroupKill (discover that group → SIGINT →
// SIGKILL escalation), else its webServer orphans + squats port 47876. Resolves
// { ok, reason? } — never rejects, so runRegressionSteps always branches cleanly.
// Output is line-prefixed with the step name so the log shows unit vs e2e (condition 4).
function spawnTestStep(step) {
  return new Promise((resolve) => {
    let appRoot
    let gateHome = null
    try {
      appRoot = getAppRoot()
    } catch (err) {
      resolve({ ok: false, reason: err && err.message ? err.message : 'no app root' })
      return
    }
    const [cmd, ...cmdArgs] = step.cmd || []
    if (!cmd) {
      resolve({ ok: false, reason: 'empty command' })
      return
    }
    getEnrichedPath()
      .then((enrichedPath) => {
        selfUpdateLog('info', `regression[${step.name}]: running \`${step.cmd.join(' ')}\` (cwd ${appRoot})`)
        // Throwaway OPENGROUND_HOME (gateEnv.js). This is the step the whole
        // control exists for: `npm test` boots the POST-MERGE tree's vitest with
        // that tree's own vitest.config.ts + setupFiles, so "the suite isolates
        // itself" was the landed code vouching for itself. Removed in settle().
        //
        // buildStepEnv, not buildGateEnv: the `e2e` step is declared a PRODUCER
        // because playwright's webServer.command begins with `npm run build &&`.
        // (The HOME/OPENGROUND_HOME that command pins applies only to the node
        // server at its END — the build at its FRONT inherits what we pass here.)
        gateHome = makeGateHome()
        const child = spawn(cmd, cmdArgs, {
          cwd: appRoot,
          env: buildStepEnv(step, { home: gateHome, extra: { PATH: enrichedPath } }),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          shell: process.platform === 'win32', // npm is npm.cmd on Windows
        })
        // Track for before-quit / crash reaping (MUST-FIX1 + review-B M1): a quit or a
        // live-engine crash mid-run must not orphan this child. The e2e (playwright)
        // child owns a SEPARATE webServer group only IT reaps on SIGTERM, so it is
        // tracked in activeE2eChild (force-killed via gracefulGroupKill); unit/build
        // share npm's group and go in activeBuildChild (killProcessTree). Steps run
        // serially → at most one is set. Assign-on-spawn / clear-on-settle.
        const ownsServerGroup = !!step.ownsServerGroup
        if (ownsServerGroup) activeE2eChild = child
        else activeBuildChild = child
        let settled = false
        let timer
        const settle = (v) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (activeBuildChild === child) activeBuildChild = null
          if (activeE2eChild === child) activeE2eChild = null
          removeGateHome(gateHome)
          gateHome = null
          resolve(v)
        }
        child.stdout?.on('data', (d) => process.stdout.write(`[regression:${step.name}] ${d}`))
        child.stderr?.on('data', (d) => process.stderr.write(`[regression:${step.name}] ${d}`))
        child.on('error', (err) =>
          settle({ ok: false, reason: err && err.message ? err.message : 'spawn error' }),
        )
        child.on('exit', (code) =>
          settle(code === 0 ? { ok: true } : { ok: false, reason: `exited ${code}` }),
        )
        timer = setTimeout(() => {
          // Timed out → force-kill. playwright (ownsServerGroup) needs gracefulGroupKill
          // (discover its separate webServer group → SIGINT → SIGKILL) else port 47876
          // orphans (M1); vitest/build share npm's group → an immediate group SIGKILL is
          // fine. Settle the gate as timed-out without awaiting the (best-effort) teardown.
          if (ownsServerGroup) {
            // …and hold the throwaway home until that teardown finishes. NOT because
            // the webServer writes there — it does not; playwright.config.ts mktemps
            // its OWN HOME/OPENGROUND_HOME for the server it boots (review round 2,
            // nit 4 corrected this comment). The reason is narrower: this step's
            // process tree is still alive through the SIGINT→SIGKILL escalation and
            // still holds the dir as inherited state, so removing it from settle()
            // would rm underneath live processes. Conservative, not load-bearing.
            const doomed = gateHome
            gateHome = null // settle()'s removeGateHome(null) is now a no-op
            // .catch after .finally: `.finally` re-throws, and this promise is
            // deliberately not awaited — without the tail catch a rejecting
            // teardown would surface as an unhandled rejection in the MAIN
            // process (the pre-existing `void gracefulGroupKill(child)` had no
            // such tail because it created no derived promise).
            void gracefulGroupKill(child)
              .finally(() => removeGateHome(doomed))
              .catch(() => {})
          } else killProcessTree(child)
          settle({ ok: false, reason: `timed out after ${REGRESSION_TIMEOUT_MS / 1000}s` })
        }, REGRESSION_TIMEOUT_MS)
      })
      .catch((err) => {
        // Also covers a synchronous spawn failure before `settle` existed (nit 1).
        removeGateHome(gateHome)
        gateHome = null
        resolve({ ok: false, reason: err && err.message ? err.message : 'path error' })
      })
  })
}

// The regression gate (task 402d34a0 + c76cb3f3): run the ordered test steps (unit →
// e2e smoke) against the freshly-built engine, fail-fast, naming the red step. The
// canary already proved the build BOOTS; this proves it is CORRECT before the switch.
// Delegates the ordering / fail-fast / naming to the pure runRegressionSteps (unit-
// tested in selfUpdate.test.ts) and injects the real per-step spawn. Resolves
// { ok, reason? } — never rejects, so the cycle always branches cleanly (RED → stay
// on old).
function runSelfUpdateTests() {
  return runRegressionSteps({
    steps: SELF_UPDATE_TEST_STEPS,
    runStep: spawnTestStep,
    log: selfUpdateLog,
  })
}

// User-facing notification of a rollback (condition 3: leave it in BOTH the engine
// log AND a notification). Non-blocking native notification so the unmanned loop is
// never stalled by a modal; the [self-update] log lines carry the full detail.
function notifyRollback(info) {
  const sha = String((info && info.goodSha) || 'unknown').slice(0, 7)
  const ok = info && info.ok
  showOsNotification(
    ok ? 'OPEN GROUND — self-update rolled back' : 'OPEN GROUND — rollback failed',
    ok
      ? `A broken self-update was reverted to the last working build (${sha}). The app kept running.`
      : `A self-update failed and the rollback could not recover (${(info && info.reason) || 'error'}). Relaunch may be needed.`,
  )
  // Escalation safety valve (in-app half): also record it in the Ground bell so the
  // event persists past the transient OS toast. The server shows no second toast
  // for this (createSwarmFatalNotification os:false on the inward bridge).
  createInAppNotification({
    event: 'rollback',
    detail: ok
      ? `壊れた self-update を直前の正常ビルド(${sha})へロールバックしました（アプリは稼働継続）。`
      : `self-update のロールバックに失敗しました（${(info && info.reason) || 'error'}）。再起動が必要かもしれません。`,
    logHint: '[self-update] のログ行を確認してください。',
  })
}

// Show an OS-native toast. The single guarded entry point for every OS push (the
// rollback notice and the server-driven swarm escalations both route through it).
// Non-blocking, best-effort — a notification fault never disturbs the caller.
function showOsNotification(title, body) {
  try {
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) return
    new Notification({ title: String(title || 'OPEN GROUND'), body: String(body || '') }).show()
  } catch (err) {
    selfUpdateLog('warn', `os-notify: could not post (${err && err.message ? err.message : err})`)
  }
}

// Ask the forked server to CREATE an in-app notification (the Ground bell record)
// for an event only Electron observes (self-update rollback / canary failure).
// Best-effort: a dead/absent server child just drops it (the OS toast already fired).
function createInAppNotification(notification) {
  try {
    if (serverChild && !serverChild.killed && typeof serverChild.send === 'function') {
      serverChild.send({ type: CREATE_NOTIFICATION_MESSAGE, notification })
    }
  } catch (err) {
    selfUpdateLog('warn', `in-app notify: send failed (${err && err.message ? err.message : err})`)
  }
}

// The onSwitchFailure handler wired into performEngineSwitch — the heart of R1.
// Restore the known-good build, re-fork the engine on the fixed port, prove its
// health, reload the window. If even that fails there is no engine left, so surface
// it like an initial-launch server failure (the operator must relaunch).
async function rollbackToKnownGood(info) {
  const stage = (info && info.stage) || 'unknown'
  if (isQuitting) {
    selfUpdateLog('warn', `rollback: app is quitting — skipping recovery (stage=${stage})`)
    return
  }
  const result = await performRollback({
    restoreArtifacts: async () => restoreKnownGood(),
    startEngine: () => spawnLiveEngine({ bootId: crypto.randomUUID() }),
    waitHealthy: ({ port, bootId, child }) =>
      pollHealthy({ port, expectBootId: bootId, watchChild: child, timeoutMs: SWITCH_HEALTH_TIMEOUT_MS }),
    reloadWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(BASE_URL)
    },
    notify: notifyRollback,
    stage,
    goodSha: knownGoodSnapshot && knownGoodSnapshot.sha,
    log: selfUpdateLog,
  })
  if (!result.ok && !isQuitting) {
    try {
      dialog.showErrorBox(
        'OPEN GROUND',
        'A self-update failed AND the automatic rollback to the previous working ' +
          `version could not bring the server back up (${result.reason}).\n\n` +
          'Please relaunch OPEN GROUND.',
      )
    } catch {
      /* a failed dialog must not mask the exit */
    }
    app.exit(1)
  }
}

// Compose the REAL deps and run one cycle. The switch path is the separated
// performEngineSwitch (electron/selfUpdate.js); onSwitchFailure is now wired to
// rollbackToKnownGood (task 402d34a0), and isSwitching brackets the cutover so the
// old engine's deliberate stop never reads as a fatal crash (R3).
function runSelfUpdate() {
  let canaryHandle = null
  // The sha we are about to build & switch TO (best-effort). On a clean cutover it
  // becomes the live engine's sha; a rollback discards it (we stay on the good sha).
  const targetSha = currentHeadSha()
  return runSelfUpdateCycle({
    // NOTE (MUST-FIX2): the known-good snapshot is NOT taken here. Snapshotting at
    // rebuild time captures whatever is on disk then — and after a previously
    // rejected cycle (canary-unhealthy / regression-red leave the rejected build on
    // disk, un-restored) that is a BROKEN build, which would then be wrongly stamped
    // good and rolled back TO. The snapshot is taken only where on-disk is provably
    // the live healthy engine: at armed boot (start) and via onSwitchSucceeded below.
    rebuild: runBuild,
    startCanary: async () => {
      canaryHandle = await spawnCanaryEngine()
      return canaryHandle
    },
    checkHealth: ({ port, bootId }) =>
      pollHealthy({
        port,
        expectBootId: bootId,
        watchChild: canaryHandle && canaryHandle.child,
        timeoutMs: CANARY_HEALTH_TIMEOUT_MS,
      }),
    stopCanary: async () => {
      const h = canaryHandle
      canaryHandle = null
      await stopCanaryEngine(h)
    },
    // Regression gate (condition 2): run on the new build before switching. Skipped
    // when OPENGROUND_SELF_UPDATE_SKIP_TESTS=1 (the gate is then health-only).
    runRegressionTests: SELF_UPDATE_RUN_TESTS ? runSelfUpdateTests : undefined,
    performSwitch: async () => {
      // Bracket the cutover (and any rollback inside it) so the live engine's
      // fatal-on-death handler is suppressed for the INTENTIONAL stops only (R3).
      isSwitching = true
      try {
        const result = await performEngineSwitch({
          // Stop old → start new on the FIXED port → require its bootId echo →
          // reload the window. onSwitchFailure recovers a switch that fails here.
          stopOldEngine: shutdownServerChild,
          startNewEngine: () => spawnLiveEngine({ bootId: crypto.randomUUID() }),
          waitHealthy: ({ port, bootId, child }) =>
            pollHealthy({
              port,
              expectBootId: bootId,
              watchChild: child,
              timeoutMs: SWITCH_HEALTH_TIMEOUT_MS,
            }),
          reloadWindow: () => {
            if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(BASE_URL)
          },
          // R2: free the fixed port if the new engine spawned but never went healthy.
          stopNewEngine: (child) => terminateChild(child),
          // R1: recover instead of leaving the engine down.
          onSwitchFailure: (failInfo) => rollbackToKnownGood(failInfo),
          log: selfUpdateLog,
        })
        return result
      } finally {
        isSwitching = false
      }
    },
    // MUST-FIX2: refresh the known-good snapshot ONLY after a successful switch — the
    // one in-cycle moment on-disk == the live healthy engine (the new build was just
    // forked from it and proved healthy). Now the live engine IS this build, so record
    // its sha and snapshot it as the next rollback target. The cycle never fires this
    // on a reject, so a rejected build can never be captured as known-good.
    onSwitchSucceeded: () => {
      liveEngineSha = targetSha
      captureKnownGood()
    },
    log: selfUpdateLog,
  })
}

// IPC trigger from the forked server (selfUpdateSignal.ts). Gated by SELF_UPDATE_
// ARMED (defence-in-depth on top of the server-side self-gate) and single-flighted
// by isSelfUpdating — a second merge mid-cycle is dropped (the next merge re-fires
// against the then-current main). isSelfUpdating also suppresses the live engine's
// fatal-on-death handler during the cutover (see spawnLiveEngine).
function onServerMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  // Escalation safety valve (OUTWARD half): the server asks us to show an OS toast
  // for a FATAL swarm event. Different message type than self-update — handle first.
  if (msg.type === OS_NOTIFY_MESSAGE) {
    showOsNotification(msg.title, msg.body)
    return
  }
  if (msg.type !== SELF_UPDATE_MESSAGE) return
  if (!SELF_UPDATE_ARMED) {
    selfUpdateLog('info', 'trigger received but self-update is not armed — ignoring')
    return
  }
  if (isSelfUpdating) {
    selfUpdateLog('info', 'trigger received while a cycle is in flight — ignoring (next merge re-fires)')
    return
  }
  isSelfUpdating = true
  selfUpdateLog('info', `self-improvement merged (${(msg && msg.projectPath) || 'source'}) — starting cycle`)
  runSelfUpdate()
    .then((result) => {
      selfUpdateLog('info', `cycle result: ${JSON.stringify(result)}`)
      handleSelfUpdateOutcome(result)
    })
    .catch((err) => {
      selfUpdateLog('error', `cycle crashed: ${err && err.message ? err.message : err}`)
      handleSelfUpdateOutcome({ switched: false, reason: 'cycle-crashed' })
    })
    .finally(() => {
      isSelfUpdating = false
    })
}

// Escalation safety valve: track CONSECUTIVE non-switching self-update cycles
// (rebuild/canary/regression failures). A successful switch resets the streak; once
// it reaches the threshold, push "canary昇格失敗の連続" to the human (OS toast +
// Ground bell). The rollback path has its own notice (notifyRollback); this covers
// the cycles that never even switched.
function handleSelfUpdateOutcome(result) {
  if (result && result.switched) {
    selfUpdateConsecutiveFailures = 0
    return
  }
  selfUpdateConsecutiveFailures += 1
  if (selfUpdateConsecutiveFailures < CANARY_FAILURE_ALERT_THRESHOLD) return
  const reason = (result && result.reason) || 'unknown'
  showOsNotification(
    'OPEN GROUND — Self-update canary failed',
    `A self-update has failed to promote ${selfUpdateConsecutiveFailures} times in a row (${reason}). The running build is unchanged.`,
  )
  createInAppNotification({
    event: 'canary-failed',
    detail: `self-update が ${selfUpdateConsecutiveFailures} 回連続で昇格に失敗しました（${reason}）。稼働中のビルドは変更なし。`,
    logHint: '[self-update] のログを確認してください。',
  })
}

// ---------------------------------------------------------------------------
// Work mode (lockdown) — renderer egress filter.
//
// The forked server's fetch floor (src/lib/server/lockdown.ts) cannot see
// requests the RENDERER makes: <link>/<img>/<script> resource loads, fetches
// from Canvas mock/screen iframes, and marketplace custom-tab code all leave
// through Chromium's network stack. This session-level filter is their floor:
// while lockdown is ON, any renderer request that is neither local
// (loopback / file: / data: / blob:) nor Anthropic is cancelled before it
// dials out.
//
// The allowlist check runs FIRST so the hot path (every loopback API/SSE/
// static request) never touches the disk; only a non-allowlisted destination
// pays the settings.json read — and those are exactly the requests lockdown
// exists to stop, made rare by the srcdoc CSP + self-hosted fonts. Per-request
// freshness is what makes the Settings toggle live without an app restart,
// same contract as the updater guard above.
//
// Scope note (documented limitation): this covers the Electron window only.
// Opening the SPA in an ordinary browser (dev: Vite on :5174, or prod
// :47776) bypasses main-process filtering — there the in-page layers (server
// route gates + fetch floor + srcdoc CSP) are the enforcement.
// ---------------------------------------------------------------------------
function installLockdownWebRequestGuard() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (isRendererUrlAllowedUnderLockdown(details.url)) return callback({})
    if (!isLockdownEnabled()) return callback({})
    console.log(`[lockdown] renderer egress blocked: ${details.url}`)
    callback({ cancel: true })
  })
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------
async function start() {
  // Windows/Linux deliver a cold-start deep link as part of the launch argv (macOS
  // uses the open-url event instead, which has likely already buffered it). Capture
  // it before the window comes up so the renderer can fetch it on mount.
  if (!pendingDeepLink) {
    const fromArgv = deepLinkFromArgv(process.argv)
    if (fromArgv) pendingDeepLink = fromArgv
  }

  // BEFORE the window exists, so the very first document load is already
  // filtered (a lockdown machine must not even leak the boot-time requests).
  installLockdownWebRequestGuard()

  // The application menu is global (not window-bound), and on macOS it is on
  // screen the moment the app is frontmost — before any window exists. Install it
  // first so there is never a frame where the default Electron menu (no "Check
  // for Updates…", "Learn More" pointing at electronjs.org) is what the user sees.
  installApplicationMenu()

  createWindow()

  try {
    if (MODE === 'prod') {
      await spawnServerChild()
      await waitForReady(
        (body) => body && body.app === 'openground' && body.bootId === BOOT_ID
      )
    } else {
      // dev: a separate Hono backend (`npm run electron:dev` → concurrently)
      // is expected to already be listening on the fixed port.
      await waitForReady((body) => body && body.app === 'openground')
    }
  } catch (err) {
    // If something is holding the fixed port, the recovery steps matter far
    // more than the raw error — lead with them.
    const recovery = portConflictRecoveryText()
    const baseMsg =
      `Could not start the OPEN GROUND server (${MODE} mode):\n\n${
        err && err.message ? err.message : String(err)
      }`
    dialog.showErrorBox(
      'OPEN GROUND',
      recovery
        ? `${baseMsg}\n\n${recovery}`
        : `${baseMsg}\n\n` +
            (MODE === 'dev'
              ? `Make sure the dev backend is running on ${BASE_URL} and Vite on ${DEV_URL}.`
              : `Check that the server bundle exists and port ${FIXED_PORT} is free.`)
    )
    app.exit(1)
    return
  }

  if (mainWindow) {
    // dev → Vite dev server (HMR); prod → the bundled Hono server (one origin).
    //
    // GUARDED. This await sits OUTSIDE the server-boot try/catch above, so a
    // rejection (ERR_ABORTED when the user closes the window mid-load, a
    // transient refusal, a renderer crash) used to propagate out of start() —
    // taking initAutoUpdater() and the self-update arming with it. The app then
    // ran with auto-update silently dead for the whole session, and, since the
    // menu item was added, "Check for Updates…" answered "still starting" forever
    // because the dial never left 'pending'. Loading the window is not a
    // precondition for wiring the updater.
    try {
      await mainWindow.loadURL(MODE === 'dev' ? DEV_URL : BASE_URL)
    } catch (err) {
      console.error('[startup] loadURL failed:', err && err.message ? err.message : err)
    }
  }

  // Auto-update wiring (Fix #14). Only ever runs in a packaged build — in dev
  // (isPackaged=false) electron-updater would hit GitHub and log spurious
  // "cannot find update feed"/dev errors, so we never even require it there.
  initAutoUpdater()

  // Self-update (in-app swarm self-improvement loop). Announce the armed state so
  // a dogfood run can confirm at a glance that the engine WILL replace itself on
  // the next self-improvement merge — and a shipped/dev run that the listener is
  // deliberately dormant. The actual cycle fires from onServerMessage (IPC).
  if (SELF_UPDATE_ARMED) {
    // The engine is up and healthy → record the sha it corresponds to AND snapshot
    // its build as the initial rollback target (condition 1 / MUST-FIX2). Right here,
    // at a freshly-booted healthy engine, on-disk IS exactly what the live engine
    // runs — the one safe moment besides a successful switch to capture known-good.
    // Best-effort: a snapshot failure must never take the app down (rollback is then
    // unavailable until the next successful switch, which is logged loudly).
    liveEngineSha = currentHeadSha()
    try {
      captureKnownGood()
    } catch (err) {
      selfUpdateLog(
        'warn',
        `boot: known-good snapshot failed (${err && err.message ? err.message : err}) — ` +
          `self-update rollback unavailable until the next successful switch`,
      )
    }
    selfUpdateLog(
      'info',
      `armed — a swarm self-improvement merge will trigger rebuild → canary → unit+e2e tests → switch; ` +
        `known-good rollback target sha ${liveEngineSha}`,
    )
  } else {
    selfUpdateLog(
      'info',
      'dormant — not a non-packaged electron:prod run (set OPENGROUND_SELF_UPDATE=1 to force)',
    )
  }
}

// ---------------------------------------------------------------------------
// Auto-update (electron-updater, Fix #14).
//
// Strictly packaged-only: a dev run has no app-update.yml and no real version,
// so checking would just spew errors. We therefore gate the ENTIRE thing on
// app.isPackaged and lazy-require electron-updater so dev never even loads it.
//
// The GitHub feed (owner/repo) comes from package.json build.publish, which
// electron-builder bakes into app-update.yml inside the bundle. No feed URL is
// set here.
//
// Policy (deliberately conservative): we auto-DOWNLOAD updates and NOTIFY, but
// we do NOT auto-restart. quitAndInstall mid-run would kill in-flight `claude`
// child processes / a running run queue, so applying the update is left to an
// explicit user action (a dialog button on 'update-downloaded'). The
// minimal contract is "download + tell the user"; the restart is opt-in.
//
// EXCEPTION (2026-08-03, settings.autoUpdate — default OFF): with the
// hands-free toggle on, the dialog is skipped and the update applies ITSELF,
// but only when the user is away (unfocused ≥30min) AND the forked server's
// restart-safety probe proves nothing unrecoverable is running — plus on any
// normal quit (autoInstallOnAppQuit). Policy: electron/autoUpdatePolicy.js.
//
// The user-INITIATED counterpart is the menu's "Check for Updates…"
// (checkForUpdatesInteractive below, decisions in electron/updateMenu.js). Every
// path above is the app deciding to act ON the user, and all of them are silent
// unless something was downloaded — so without the menu item there was no way to
// ASK, and no way to see the two honest answers ("you are current", "work mode is
// suppressing checks"), which were console.log lines in a packaged app.
// ---------------------------------------------------------------------------
const AUTO_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4h

// The live electron-updater handle, hoisted so the MENU's manual check can reach
// it. Null in dev / unpackaged (initAutoUpdater never loads the module there) and
// null if the require fails — both of which the precondition below answers for.
let autoUpdaterHandle = null
// Has initAutoUpdater run yet, and did it succeed? 'pending' is a REAL state the
// user can reach: the menu is installed at the top of start() while
// initAutoUpdater runs at the bottom, after a health poll that may take up to
// HEALTH_TIMEOUT_MS. Reporting "no updater in this build" during that window
// would be a false statement about a perfectly good build.
let autoUpdaterInit = 'pending'
// The update already downloaded and waiting for a restart, if the user chose
// "Later" — `{ version }`, or null when there is none. A manual check must offer
// THAT restart rather than re-asking GitHub about an update already on disk. It is
// an object rather than a bare string so "we have one" survives a missing version.
let downloadedUpdate = null
/** When the pending update finished downloading — drives the notice escalation. */
let downloadedUpdateAt = 0
// Guard against two manual checks racing two dialogs.
let manualCheckInFlight = false
// True while a download the app ANNOUNCED (the manual check's "downloading in
// the background" dialog) is in flight — the one case where a later 'error'
// must surface as a dialog instead of dying in stdout (2026-08-13). Background
// downloads never set this, so background failures stay silent by design.
let announcedDownloadLive = false

/** Dock-icon download progress (macOS/Windows taskbar). ratio 0..1, or -1 to
 *  clear. Best-effort: a destroyed window must never throw in an updater
 *  event handler. */
function setUpdateDockProgress(ratio) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(ratio)
  } catch {
    /* cosmetic only */
  }
}

// ── Hands-free updates (settings.autoUpdate, electron/autoUpdatePolicy.js) ──
// When the window last lost focus (epoch ms), or null while focused. Fed by the
// blur/focus listeners installed in start(); the policy needs "how long has the
// user been away", and a window that has NEVER focused (launched to the
// background) counts as away since launch.
let lastBlurAt = Date.now()
// The polling timer that re-evaluates the auto-apply decision while an update
// sits downloaded. One at a time; cleared when it fires the apply.
let autoApplyTimer = null

/** settings.autoUpdate, re-read from disk per call (the lockdown.js pattern —
 *  toggling in Settings takes effect at the next tick, no restart). */
function autoUpdateEnabled() {
  try {
    return autoUpdateFromSettingsRaw(require('fs').readFileSync(settingsFilePath(), 'utf8'))
  } catch {
    return false
  }
}

/** Ask the forked server whether a restart destroys anything right now.
 *  null (unreachable / non-OK / timeout) is FAIL-CLOSED to "unsafe" by the
 *  policy — a dead server probably means mid-boot or mid-teardown, both of
 *  which are wrong moments to restart on top of. */
async function fetchRestartSafety() {
  try {
    const res = await fetch(`http://127.0.0.1:${FIXED_PORT}/api/update/restart-safety`, {
      signal: AbortSignal.timeout(SAFETY_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** One policy evaluation. Applies the update (same ordered teardown as the
 *  dialog path) when every condition holds; otherwise just logs why not. */
async function maybeAutoApplyUpdate() {
  const focused = mainWindow ? mainWindow.isFocused() : false
  const unfocusedMs = focused ? 0 : Date.now() - lastBlurAt
  const decision = decideAutoApply({
    enabled: autoUpdateEnabled(),
    lockdown: isLockdownEnabled(),
    hasDownloaded: !!downloadedUpdate,
    unfocusedMs,
    safety: downloadedUpdate ? await fetchRestartSafety() : null,
  })
  if (!decision.apply) {
    console.log(`[updater] auto-apply deferred: ${decision.reason}`)
    return
  }
  console.log('[updater] auto-applying update', downloadedUpdate && downloadedUpdate.version)
  if (autoApplyTimer) {
    clearInterval(autoApplyTimer)
    autoApplyTimer = null
  }
  await applyDownloadedUpdate({
    setQuitting: (v) => {
      isQuitting = v
    },
    shutdownServerChild,
    quitAndInstall: () =>
      autoUpdaterHandle ? autoUpdaterHandle.quitAndInstall() : app.quit(),
  }).catch(() => {})
}

/** Arm the recurring evaluation after a download lands (idempotent). */
function armAutoApplyLoop() {
  if (autoApplyTimer) return
  autoApplyTimer = setInterval(() => {
    void maybeAutoApplyUpdate()
  }, AUTO_APPLY_POLL_MS)
  // First look right away — the user may already be away.
  void maybeAutoApplyUpdate()
}

/** The app's own UI language, re-read per dialog so a change in Settings takes
 *  effect without an app restart (the same per-use freshness lockdown.js uses).
 *  Any read/parse failure falls back to English rather than costing the dialog. */
function updateDialogLanguage() {
  try {
    return languageFromSettingsRaw(require('fs').readFileSync(settingsFilePath(), 'utf8'))
  } catch {
    return 'en'
  }
}

/** Show one update dialog in the app's language. Returns showMessageBox's promise
 *  so callers can branch on the button ('downloaded' is the only multi-button kind). */
function showUpdateDialog(kind, opts) {
  const t = updateDialogText(updateDialogLanguage(), kind, opts || {})
  return dialog.showMessageBox(mainWindow || undefined, {
    type: kind === 'error' ? 'warning' : 'info',
    title: 'OPEN GROUND',
    message: t.message,
    detail: t.detail,
    ...(t.buttons ? { buttons: t.buttons, defaultId: t.defaultId, cancelId: t.cancelId } : {}),
  })
}

/**
 * Offer the restart that applies a downloaded update. Reached two ways — the
 * 'update-downloaded' event (the app telling the user) and the menu's manual
 * check when an update is already waiting (the user asking) — so it lives in one
 * place: the same prompt and, critically, the same teardown-then-quitAndInstall
 * ordering (electron/autoUpdate.js) whichever door the user came through.
 */
function promptRestartForUpdate(version) {
  return showUpdateDialog('downloaded', { version })
    .then((res) => {
      if (res.response !== 0) return
      // Tear the forked server down FIRST, then quitAndInstall. Otherwise the
      // before-quit handler preventDefault()s quitAndInstall's quit and replaces
      // it with a plain app.quit() — the update downloads but is never applied, so
      // "Restart now" appears to do nothing (observed 2026-06-25). Settling
      // shutdownServerChild first leaves serverChild null/killed by the time
      // quitAndInstall fires, so before-quit no longer intercepts it. The ordered
      // sequence lives in electron/autoUpdate.js, locked by autoUpdate.test.ts.
      applyDownloadedUpdate({
        setQuitting: (v) => {
          isQuitting = v
        },
        shutdownServerChild,
        // Fall back to a plain quit if the handle is somehow gone: by this point
        // the server child has already been torn down, so doing NOTHING would
        // leave the user staring at a live window backed by a dead server.
        quitAndInstall: () =>
          autoUpdaterHandle ? autoUpdaterHandle.quitAndInstall() : app.quit(),
      }).catch(() => {})
    })
    .catch(() => {})
}

/**
 * The menu's "Check for Updates…" — the ONLY update path the user initiates.
 *
 * Every branch ends in a dialog. That is the whole point: the background checks
 * are silent by design (an OS notification only when something was downloaded),
 * so "am I current?" and "why has nothing updated?" had no answer short of
 * reading a packaged app's stdout. A manual check that could return silently
 * would be indistinguishable from a broken one.
 *
 * The decision itself is pure (electron/updateMenu.js, locked by
 * updateMenu.test.ts); this function is only its side effects.
 */
async function checkForUpdatesInteractive() {
  const decision = manualCheckPrecondition({
    packaged: app.isPackaged,
    lockdown: isLockdownEnabled(),
    updateDownloaded: Boolean(downloadedUpdate),
    inFlight: manualCheckInFlight,
    // 'ready' only once initAutoUpdater has actually wired a handle — a null
    // handle after a successful init would still be a lie, so belt and braces.
    updater: autoUpdaterInit === 'ready' && autoUpdaterHandle ? 'ready' : autoUpdaterInit,
  })
  if (decision === 'restart') {
    await promptRestartForUpdate(downloadedUpdate.version)
    return
  }
  if (decision !== 'check') {
    await showUpdateDialog(decision, {})
    return
  }

  manualCheckInFlight = true
  try {
    // checkForUpdates(), NOT checkForUpdatesAndNotify(): the notify variant fires an
    // OS notification of its own, which on top of our dialog would tell the user the
    // same thing twice.
    //
    // BOUNDED: checkForUpdates() has no timeout of its own, and a promise that
    // never settles would leave manualCheckInFlight true forever — every later
    // click answering "already checking" for the rest of the session.
    const result = await withTimeout(
      autoUpdaterHandle.checkForUpdates(),
      MANUAL_CHECK_TIMEOUT_MS,
    )
    const outcome = manualCheckOutcome({ result, currentVersion: app.getVersion() })
    // The dialog below PROMISES "you will be asked to restart once it is
    // ready" — from here on, a download error must surface as a dialog too
    // (the 'error' handler reads this flag), or the promise dies in stdout.
    if (outcome.kind === 'downloading') announcedDownloadLive = true
    // autoDownload means a small update can finish DURING the check — in which case
    // 'update-downloaded' already put the restart prompt on screen. Don't stack a
    // second dialog behind it.
    if (outcome.kind === 'downloading' && downloadedUpdate) return
    await showUpdateDialog(outcome.kind, { version: outcome.version })
  } catch (err) {
    await showUpdateDialog('error', { error: err && err.message ? err.message : String(err) })
  } finally {
    manualCheckInFlight = false
  }
}

/**
 * Replace Electron's default application menu with ours.
 *
 * The ONLY functional addition is "Check for Updates…" (plus a Release Notes
 * link); everything else is `role:`-driven, which reproduces Electron's defaults
 * exactly — so Cmd+C / Cmd+V / DevTools / Minimize are untouched. The About /
 * Hide / Quit labels are spelled with the product name because `app.name` is the
 * lowercase package name ("openground"), and renaming the app itself is NOT an
 * option: app.name is what userData's path is derived from.
 */
function installApplicationMenu() {
  // Same reason: the About panel would otherwise be titled "openground".
  app.setAboutPanelOptions({ applicationName: 'OPEN GROUND', applicationVersion: app.getVersion() })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenuTemplate({
        appName: 'OPEN GROUND',
        isMac: process.platform === 'darwin',
        onCheckForUpdates: () => {
          // .catch because the early-return branches await showMessageBox OUTSIDE
          // the try — a dialog that rejects (window destroyed mid-prompt) would
          // otherwise surface as an unhandled rejection in the main process.
          void checkForUpdatesInteractive().catch((err) => {
            console.error('[updater] manual check failed:', err && err.message)
          })
        },
        onOpenReleaseNotes: () => {
          void shell.openExternal(RELEASE_NOTES_URL).catch(() => {})
        },
      }),
    ),
  )
}

function initAutoUpdater() {
  // dev / unpackaged: never touch electron-updater. The dial stays 'pending',
  // which is never read there — manualCheckPrecondition answers 'dev' first.
  if (!app.isPackaged) return

  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch (err) {
    console.error('[updater] electron-updater unavailable:', err && err.message)
    // NOW "this build has no updater" is the truth, and the menu may say it.
    autoUpdaterInit = 'unavailable'
    return
  }
  autoUpdaterHandle = autoUpdater
  autoUpdaterInit = 'ready'

  // We drive the "apply" step ourselves (a dialog button), so disable the
  // built-in auto-install-on-quit — otherwise a downloaded update would also
  // get applied on the next normal Cmd+Q, mid-run-queue.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update…')
  })
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info && info.version)
  })
  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] up to date:', info && info.version)
  })
  autoUpdater.on('error', (err) => {
    // Non-fatal: a failed update check must never take the app down.
    console.error('[updater] error:', err && err.message ? err.message : err)
    setUpdateDockProgress(-1)
    // A download the app ANNOUNCED (the manual check's "downloading in the
    // background… you will be asked to restart" dialog) must not die silently —
    // the user is sitting in front of a promise that can no longer be kept
    // (observed 2026-08-13 on a real 0.11.71 update: the failure went only to a
    // packaged app's stdout and the app looked hung). Background checks stay
    // silent by design — announcedDownloadLive is only ever set by the manual
    // check path, so this dialog can never pop uninvited.
    if (announcedDownloadLive) {
      announcedDownloadLive = false
      void showUpdateDialog('download-failed', {
        error: err && err.message ? err.message : String(err),
      })
        .then((res) => {
          if (res.response === 0) void shell.openExternal(RELEASE_NOTES_URL).catch(() => {})
        })
        .catch(() => {})
    }
  })
  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] downloading ${Math.round(p.percent)}%`)
    // Ambient, not modal: the dock icon carries the download so "is anything
    // happening?" has an answer without a dialog (the 2026-08-13 stuck-looking
    // update). percent is 0–100 from electron-updater; clamp defensively.
    const ratio = Number.isFinite(p && p.percent) ? Math.min(1, Math.max(0, p.percent / 100)) : 0
    setUpdateDockProgress(ratio)
  })
  autoUpdater.on('update-downloaded', (info) => {
    const version = (info && info.version) || ''
    console.log('[updater] update downloaded:', version || '(unknown version)')
    // The announced download kept its promise — retire the failure watch and
    // the dock progress bar.
    announcedDownloadLive = false
    setUpdateDockProgress(-1)
    // Remember it: if the user picks "Later", the menu's manual check must offer
    // THIS restart instead of asking GitHub again about an update already on disk.
    downloadedUpdate = { version }
    // When it landed — the escalation below and the poll loop both age from this.
    // WHAT HANDS-FREE MEANS, and what it used to mean by accident.
    //
    // This branch used to `return` after arming the loop, so turning the setting
    // ON removed the only prompt that always worked. ON therefore had two ways to
    // land an update — the unattended moment and a normal quit — where OFF had
    // three, and the unattended moment never arrived for anyone who keeps a
    // terminal open (measured on the owner's own app: userPtys stuck at 2, both
    // empty shells). **ON delivered updates less reliably than OFF.**
    //
    // Arming the loop and telling the user are now independent
    // (autoUpdatePolicy.decideDownloadedAction, unit-tested without Electron).
    // Hands-free still means "nothing interrupts you"; it never means "you are
    // not told". The notice escalates the longer the update waits, and every
    // form of it restarts in one click.
    downloadedUpdateAt = Date.now()
    const action = decideDownloadedAction({
      enabled: autoUpdateEnabled(),
      lockdown: isLockdownEnabled(),
      waitedDays: 0,
    })
    if (action.armLoop) {
      autoUpdater.autoInstallOnAppQuit = true
      armAutoApplyLoop()
    }
    if (!action.notify) return
    if (action.escalation === 'dialog') {
      void promptRestartForUpdate(version)
      return
    }
    createInAppNotification({
      event: 'update-ready',
      detail: `新しい版 ${version} の準備ができました。手が空いた頃合いに自動で入れ替えますが、今すぐでも構いません。`,
      logHint: '設定 → 自動アップデート で、いま適用できない理由が見られます。',
    })
  })

  // Kick off an initial check, then poll every 4h. checkForUpdatesAndNotify
  // surfaces a native OS notification on its own in addition to our handlers.
  //
  // WORK MODE (lockdown): the switch is re-read from settings.json IMMEDIATELY
  // BEFORE every check (electron/lockdown.js) — not once at init — so toggling
  // it in Settings takes effect at the next tick, both directions, without an
  // app restart. The updater is MAIN-process egress (GitHub), which the forked
  // server's fetch floor cannot reach; this is its counterpart guard.
  const maybeCheck = (label) => {
    if (isLockdownEnabled()) {
      console.log(`[updater] ${label} check skipped — work mode (lockdown) is on`)
      return
    }
    // Keep the quit-time backstop in step with the LIVE setting: hands-free on
    // ⇒ a downloaded update also applies on any normal quit; toggled off ⇒ back
    // to explicit-restart-only. Refreshed per tick so the Settings toggle needs
    // no app restart (same liveness contract as the lockdown read above).
    autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled()
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error(`[updater] ${label} check failed:`, err && err.message)
    })
  }
  maybeCheck('initial')
  setInterval(() => {
    maybeCheck('periodic')
  }, AUTO_UPDATE_INTERVAL_MS)
}
