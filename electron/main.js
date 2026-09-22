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
const {
  eagerSquirrelHandoff,
  installReadiness,
  waitForInstallStaged,
  hasLiveForkedChildren,
  applyDownloadedUpdate,
} = require('./autoUpdate')
// The updater's MEMORY (2026-09-13): every updater line to ~/.openground/updater.log,
// and a pending-install marker the next boot checks. See electron/updaterLog.js.
const {
  updaterLogPath,
  pendingInstallPath,
  recoveryMarkerPath,
  makeUpdaterLogger,
  tailUpdaterLog,
  writePendingInstall,
  readPendingInstall,
  checkPendingInstall,
} = require('./updaterLog')
// The OS installer's launchd job — logged at boot and before every install,
// and consulted BEFORE the app tears itself down (electron/shipIt.js).
const {
  shipItLabel,
  decideBootRecovery,
  decideArmedRecoveryAtQuit,
  decideUnarmedStagedRelaunch,
  parseShipItRequest,
  shipItRequestIO,
  ensureRelaunchAfterInstall,
  versionFromPlistJson,
  launchdDomain,
  parseDisabledFlag,
  parseServicePrint,
  decideInstallPreflight,
  describeShipItState,
} = require('./shipIt')
// Our own updater lines. Mirrors to the console too, so a Terminal-launched
// diagnosis still streams; the file is what survives a packaged launch.
const ulog = makeUpdaterLogger({ path: updaterLogPath(), tag: 'updater' })
const {
  AUTO_APPLY_POLL_MS,
  SAFETY_FETCH_TIMEOUT_MS,
  autoUpdateFromSettingsRaw,
  decideAutoApply,
  decideDownloadedAction,
  shouldNudgeCheck,
  asapWindowActive,
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

// Release-time update bell. MUST match UPDATE_CHECK_MESSAGE in
// src/lib/server/updateNudge.ts: the server relays POST /api/update/check-now
// here so a just-published release is discovered in seconds instead of at the
// next periodic tick. Rate-limited below (shouldNudgeCheck) because the route
// is reachable by anything on loopback.
const UPDATE_CHECK_MESSAGE = 'openground:update-check'

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

  // The very last thing this process does — after before-quit has reaped the
  // children. Nothing async can survive here, and nothing else may run between
  // the nudge and exit, which is exactly what makes it the right place to start
  // the OS installer's launchd job by hand (kickstartShipItBeforeExit).
  app.on('will-quit', () => {
    try {
      kickstartShipItBeforeExit()
    } catch (err) {
      console.error('[openground] ShipIt kickstart skipped:', err && err.message ? err.message : err)
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
  // Release-time bell: check for updates now instead of at the next periodic
  // tick. Rate-limited (the route is open to loopback), and a no-op until
  // initAutoUpdater has armed nudgeUpdateCheck (dev/unpackaged stay silent).
  if (msg.type === UPDATE_CHECK_MESSAGE) {
    const now = Date.now()
    if (msg.apply === 'asap') {
      // A user COMMAND — arm before (and regardless of) the check rate limit,
      // so ringing twice quickly still upgrades the first ring's download. If
      // something already sits downloaded, don't wait for the 5-min poll.
      asapArmedAt = now
      if (downloadedUpdate) void maybeAutoApplyUpdate()
    }
    if (!nudgeUpdateCheck || !shouldNudgeCheck({ lastNudgeAt: lastUpdateNudgeAt, now })) return
    lastUpdateNudgeAt = now
    nudgeUpdateCheck()
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

  // Did the LAST run quit to install an update that then did not happen? The OS
  // installer works after the app is gone, so this — waking up and comparing
  // versions — is the first moment the app can know. Before initAutoUpdater so
  // the answer is on screen before the same "downloaded" dialog could reappear.
  reportFailedInstallOnBoot()
  // …and what launchd thinks of the installer job right now — the line that
  // was missing from every diagnosis before 2026-09-21. Fire-and-forget.
  void probeShipIt('boot').catch(() => {})

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
// restart-safety probe proves nothing unrecoverable is running — plus, on
// WINDOWS/LINUX only, on any normal quit (autoInstallOnAppQuit).
// Policy: electron/autoUpdatePolicy.js.
//
// ⚠ autoInstallOnAppQuit IS NOT A POLICY KNOB ON macOS (2026-09-11). There it
// is plumbing: install-on-quit lives in electron-updater's BaseUpdater
// (Windows/Linux), while MacUpdater extends AppUpdater and has no quit handler
// — the flag's only macOS effect is whether the downloaded zip is handed to
// Squirrel.Mac at DOWNLOAD time or not at all. Driving it from the user's
// setting made "Restart now" a no-op for every user with hands-free off. It is
// now decided by eagerSquirrelHandoff() (electron/autoUpdate.js), which is
// where that whole story is written down.
//
// The user-INITIATED counterpart is the menu's "Check for Updates…"
// (checkForUpdatesInteractive below, decisions in electron/updateMenu.js). Every
// path above is the app deciding to act ON the user, and all of them are silent
// unless something was downloaded — so without the menu item there was no way to
// ASK, and no way to see the two honest answers ("you are current", "work mode is
// suppressing checks"), which were console.log lines in a packaged app.
// ---------------------------------------------------------------------------
// 1h, down from 4h (2026-08-13): the poll is one CDN-cached yml fetch, and it is
// every user's ONLY discovery path — the check-now bell below only reaches the
// machine that ran the release.
const AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1000 // 1h

// The live electron-updater handle, hoisted so the MENU's manual check can reach
// it. Null in dev / unpackaged (initAutoUpdater never loads the module there) and
// null if the require fails — both of which the precondition below answers for.
let autoUpdaterHandle = null

// Release-time bell (UPDATE_CHECK_MESSAGE): initAutoUpdater points this at its
// maybeCheck closure so onServerMessage can trigger a lockdown-aware check.
// Null until the updater initialises (and forever in dev/unpackaged, where a
// nudge is meaningless) — the handler treats null as "nothing to ring".
let nudgeUpdateCheck = null
let lastUpdateNudgeAt = 0
// When a bell carried {apply:'asap'} (user command): the away-timer is waived
// for ASAP_WINDOW_MS. 0 = never armed. Read by maybeAutoApplyUpdate.
let asapArmedAt = 0
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
// ── The OS installer's own staging state (macOS) ────────────────────────────
// electron-updater hands a downloaded zip to Squirrel.Mac, which fetches,
// unpacks and signature-verifies it ASYNCHRONOUSLY; only after that can
// quitAndInstall() actually quit. `electron.autoUpdater` IS that native updater
// (the same object MacUpdater drives), so its 'update-downloaded' is the one
// honest signal for "the quit will be immediate". Listening is side-effect free
// — we never call the native updater ourselves.
let nativeUpdaterHandle = null
let squirrelStaged = false
// One apply at a time: the dialog can be re-opened from the menu while a staging
// wait is in flight, and two waits racing two teardowns is not a thing to allow.
let applyInFlight = false

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
    asap: asapWindowActive({ armedAt: asapArmedAt, now: Date.now() }),
    safety: downloadedUpdate ? await fetchRestartSafety() : null,
  })
  if (!decision.apply) {
    ulog.info(`auto-apply deferred: ${decision.reason}`)
    return
  }
  ulog.info('auto-applying update', downloadedUpdate && downloadedUpdate.version)
  if (autoApplyTimer) {
    clearInterval(autoApplyTimer)
    autoApplyTimer = null
  }
  await applyUpdateWhenStaged(downloadedUpdate && downloadedUpdate.version)
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

/** Say that the restart they asked for is waiting on the OS — the whole point of
 *  the readiness gate is that the app is still ALIVE while it waits, so the one
 *  thing that must not happen is silence.
 *
 *  Deliberately NOT the swarm notification channel: those rows are the swarm's
 *  needs-attention feed (and typed + labelled + translated as such), and "macOS
 *  is unzipping" belongs in neither. Two main-process primitives that already
 *  exist say it without inventing a contract: the dock/taskbar bar and an OS
 *  toast. Both follow Settings.language like every other owner-facing string. */
function notifyPreparingInstall(version) {
  // > 1 is macOS's INDETERMINATE bar: "something is happening", without
  // pretending to a percentage we do not have (Squirrel reports none).
  setUpdateDockProgress(2)
  const ja = updateDialogLanguage() === 'ja'
  const named = version
    ? `OPEN GROUND ${version}`
    : ja
      ? '新しいバージョン'
      : 'A new version of OPEN GROUND'
  showOsNotification(
    'OPEN GROUND',
    ja
      ? `${named} の準備をしています。終わり次第、自動で再起動します — それまでは今のまま使えます。`
      : `Preparing ${named}. It restarts itself as soon as that finishes — keep using the app until then.`,
  )
}

/** Staging never finished. NOTHING was torn down, so the app is fine — say that,
 *  and offer the manual route for someone who would rather not wait. */
function reportInstallNotReady(version) {
  ulog.error('the OS installer never staged the update — not applying')
  setUpdateDockProgress(-1)
  showUpdateDialog('install-not-ready', { version })
    .then((res) => {
      if (res.response === 0) void shell.openExternal(RELEASE_NOTES_URL).catch(() => {})
    })
    .catch(() => {})
}

/** The bundle id Squirrel.Mac derives the ShipIt label from. electron-builder
 *  ships package.json inside the app, so this reads the same `build.appId` the
 *  build was stamped with; the literal is the fallback for a stripped tree. */
function shipItAppId() {
  try {
    const id = require('../package.json').build.appId
    if (typeof id === 'string' && id) return id
  } catch {
    /* fall through */
  }
  return 'local.openground.app'
}

/** `launchctl <args>`, best-effort: the combined stdout+stderr text, or null
 *  when it could not run at all (not macOS, no binary, timeout). A non-zero
 *  exit still yields its text — `launchctl print` of a job that is not loaded
 *  exits 113 with "Could not find service", and that IS the answer. */
async function launchctl(args) {
  if (process.platform !== 'darwin') return null
  try {
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const { stdout, stderr } = await promisify(execFile)('launchctl', args, {
      timeout: 3000,
      maxBuffer: 256 * 1024,
    })
    return `${stdout || ''}${stderr || ''}`
  } catch (err) {
    if (err && (typeof err.stdout === 'string' || typeof err.stderr === 'string')) {
      return `${err.stdout || ''}${err.stderr || ''}`
    }
    return null
  }
}

/**
 * What launchd currently says about the ShipIt job — logged, never thrown.
 * `stage` names the moment ('boot' / 'pre-install' / 'after-enable') so the
 * log reads as a story. Resolves null off macOS or when launchctl is unusable.
 * @param {string} stage
 */
async function probeShipIt(stage) {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') return null
  const label = shipItLabel(shipItAppId())
  const domain = launchdDomain(process.getuid())
  const disabledOut = await launchctl(['print-disabled', domain])
  const printOut = await launchctl(['print', `${domain}/${label}`])
  const disabled = disabledOut === null ? 'unknown' : parseDisabledFlag(disabledOut, label)
  const service = printOut === null ? null : parseServicePrint(printOut)
  ulog.info(`ShipIt (${stage}): ${describeShipItState({ label, disabled, service })}`)
  return { label, domain, disabled, service }
}

/**
 * Start the ShipIt job by hand, SYNCHRONOUSLY — this only ever runs from
 * `will-quit`, where the event loop is about to stop and an async call would
 * simply never come back. `launchctl kickstart gui/<uid>/<label>` is the
 * release operator's manual fix (2026-09-21) turned into code.
 *
 * Deliberately WITHOUT `-k`: killing a ShipIt that IS mid-install would be the
 * one way to make this path destructive, and a kickstart on an already-running
 * job is a harmless no-op — which is exactly why racing Squirrel's own Mach
 * trigger for the same job costs nothing. Bounded and best-effort: a launchctl
 * that hangs must not hold the quit open (the install watchdog is waiting).
 * @param {string} why
 */
function kickstartShipItSync(why) {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') return
  const label = shipItLabel(shipItAppId())
  const target = `${launchdDomain(process.getuid())}/${label}`
  try {
    const out = require('child_process').execFileSync('launchctl', ['kickstart', target], {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    ulog.warn(`ShipIt kickstart (${why}): ${String(out || '').trim() || 'ok'}`)
  } catch (err) {
    // Non-zero exit is an ANSWER, not a crash ("Could not find service" when
    // Squirrel never submitted one). Either way the install is Squirrel's to
    // perform; we only ever added a nudge.
    const text = err && (err.stderr || err.stdout) ? String(err.stderr || err.stdout).trim() : err && err.message
    ulog.warn(`ShipIt kickstart (${why}) did not run: ${text || 'unknown error'}`)
  }
}

/**
 * The pre-install gate. A disabled ShipIt job means quitting installs NOTHING
 * (the 2026-09-21 "zero runs" finding), so: try to enable it, re-read, and only
 * then decide. 'proceed' on anything short of a confirmed still-disabled job —
 * uncertainty must never hold an update hostage; the boot check reports a
 * failure with the log if it comes to that.
 *
 * ⚠ It deliberately does NOT act on "the job has never run", even though that
 * is the 2026-09-22 failure shape. The job readable here is the PREVIOUS
 * cycle's submission — `quitAndInstall` removes it and submits a fresh one —
 * so kicking it would start an OLD install request alongside Squirrel's new
 * one, with two ShipIts moving /Applications at once. The nudge belongs at
 * `will-quit`, after the right job exists. (electron/shipIt.js header.)
 * @returns {Promise<{ decision: 'proceed'|'block', label: string | null }>}
 */
async function shipItPreflight() {
  let probe = null
  try {
    probe = await probeShipIt('pre-install')
  } catch {
    probe = null
  }
  if (!probe) return { decision: 'proceed', label: null }
  if (probe.disabled !== 'disabled') return { decision: 'proceed', label: probe.label }
  const out = await launchctl(['enable', `${probe.domain}/${probe.label}`])
  ulog.warn(`ShipIt job is DISABLED under Background Items — tried \`launchctl enable\`: ${out === null ? 'could not run' : out.trim() || 'ok'}`)
  let after = null
  try {
    after = await probeShipIt('after-enable')
  } catch {
    after = null
  }
  const decision = decideInstallPreflight({
    disabledBefore: probe.disabled,
    disabledAfterEnable: after ? after.disabled : 'unknown',
  })
  return { decision, label: probe.label }
}

/** The macOS Login Items & Extensions pane (the "Allow in the Background" list). */
const LOGIN_ITEMS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'

/** launchd will not run the install — say so BEFORE quitting into nothing.
 *  One reason only: the label is switched off under Background Items and
 *  `launchctl enable` did not take. "The job never runs" is deliberately NOT a
 *  block (electron/shipIt.js header) — its remedy is the will-quit kickstart. */
function reportInstallBlocked(version, label) {
  ulog.error(`install blocked: the ShipIt job (${label}) stays disabled — not quitting`)
  setUpdateDockProgress(-1)
  showUpdateDialog('install-blocked', { version, label })
    .then((res) => {
      if (res.response === 0) void shell.openExternal(LOGIN_ITEMS_SETTINGS_URL).catch(() => {})
      else if (res.response === 1) void shell.openExternal(RELEASE_NOTES_URL).catch(() => {})
    })
    .catch(() => {})
}

/**
 * Apply a downloaded update — but only once the OS installer can actually quit
 * into it. THE ONLY route to applyDownloadedUpdate; both doors (the dialog's
 * "Restart now" and the hands-free loop) come through here.
 *
 * ⚠ WHY THE GATE (owner, 2026-09-11). The teardown-before-quitAndInstall
 * ordering is mandatory (0.11.8), so tearing down while macOS is still unpacking
 * left a window that could not be used and would not quit, silently, for as long
 * as unpacking took. Waiting costs nothing: during the wait the app is WHOLE —
 * server alive, window usable — and it quits the instant staging lands.
 */
async function applyUpdateWhenStaged(version) {
  if (applyInFlight) {
    // A second press is not a second install; it is "did you hear me?".
    notifyPreparingInstall(version)
    return
  }
  applyInFlight = true
  // Will launchd even run the installer? Asked FIRST, before any wait and long
  // before the teardown: a blocked answer costs nothing (the app is untouched),
  // and a proceed answer leaves a dated launchd snapshot in the log for the
  // day the install still fails.
  const preflight = await shipItPreflight()
  if (preflight.decision === 'block') {
    applyInFlight = false
    reportInstallBlocked(version, preflight.label)
    return
  }
  // Only WAIT when we can actually observe staging. A darwin build whose native
  // handle failed to wire would otherwise sit out the whole timeout on an update
  // that may well be ready — so fall through to the old behaviour (+ watchdog)
  // rather than invent a delay.
  if (nativeUpdaterHandle && installReadiness(process.platform, squirrelStaged) === 'staging') {
    ulog.info('waiting for the OS installer to stage the update before tearing down')
    notifyPreparingInstall(version)
    const staged = await waitForInstallStaged({
      isStaged: () => squirrelStaged,
      onStaged: (cb) => {
        nativeUpdaterHandle.once('update-downloaded', cb)
        return () => {
          try {
            nativeUpdaterHandle.removeListener('update-downloaded', cb)
          } catch {
            /* handle went away with the updater — nothing to detach */
          }
        }
      },
    })
    if (!staged) {
      applyInFlight = false
      reportInstallNotReady(version)
      return
    }
  }
  await applyDownloadedUpdate({
    setQuitting: (v) => {
      isQuitting = v
    },
    shutdownServerChild,
    // Fall back to a plain quit if the handle is somehow gone: by this point the
    // server child has already been torn down, so doing NOTHING would leave the
    // user staring at a live window backed by a dead server.
    quitAndInstall: () => (autoUpdaterHandle ? autoUpdaterHandle.quitAndInstall() : app.quit()),
    // ⚠ AND IT DISARMS. `quitAndInstall` can return WITHOUT quitting on macOS
    // (electron-updater's MacUpdater, `squirrelDownloadedUpdate === false`),
    // and the arm below was made for THIS quit. Left standing it would ride the
    // next quit instead — a deliberate ⌘Q an hour later, which would then
    // KICKSTART launchd on a quit nobody asked to install on (adversarial
    // review, 2026-09-22). Since the owner's 2026-09-22 decision the relaunch
    // itself is no longer what disarming prevents — an unarmed quit writes it
    // anyway (`relaunchUnarmedStagedInstall`); the kick is.
    // The watchdog firing IS the proof this quit never happened,
    // so it is the honest place to take the arm back.
    onStuck: () => {
      armedKickstart = null
      reportInstallStuck(version)
    },
    // "We are quitting to install X, running Y." The next boot reads this and,
    // if it wakes up as Y, says the install failed — with the log's tail —
    // instead of re-showing the "downloaded" dialog as if nothing happened.
    beforeInstall: () => {
      ulog.info(`quitting to install ${version || '(unknown version)'} (running ${app.getVersion()})`)
      writePendingInstall({ path: pendingInstallPath(), from: app.getVersion(), to: version || '' })
      // quitAndInstall is about to write Squirrel's request and submit a FRESH
      // ShipIt job — which carries no RunAtLoad and is therefore the job launchd
      // can sit on forever (the 2026-09-22 failure). Arm the nudge for will-quit,
      // the first moment that job exists and the last moment we run.
      armedKickstart = { why: `install of ${version || 'the downloaded update'}`, verifyRelaunch: false, version }
    },
  }).catch(() => {})
}

/** Whether the next `will-quit` should kick the ShipIt job, and why — `null`
 *  for not at all. Two arming sites: `beforeInstall` (this quit IS an install)
 *  and the boot check (the LAST quit installed nothing and the same update is
 *  still staged); only the latter sets `verifyRelaunch`, because only it can go
 *  stale between arming and the quit. Never armed while the app merely runs —
 *  see the shipIt.js header on why a ShipIt parked mid-session is dangerous.
 *  `version` rides along on the install arm only: at will-quit it is what the
 *  pending request must be pointing at before we bless it with a relaunch.
 *  @type {{ why: string, verifyRelaunch: boolean, version?: string } | null} */
let armedKickstart = null

/** `CFBundleShortVersionString` of an app bundle on disk, or null when it cannot
 *  be read. `plutil` because a packaged Info.plist may be binary; bounded, and
 *  a failure always reads as "unknown", which every caller treats as "do
 *  nothing" rather than "go ahead". */
function bundleVersionAt(appPath) {
  try {
    const json = require('child_process').execFileSync(
      'plutil',
      ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return versionFromPlistJson(json)
  } catch {
    return null
  }
}

/** Squirrel's request file: `~/Library/Caches/<bundle id>.ShipIt/ShipItState.plist`
 *  (SQRLDirectoryManager.m). Named here once — the boot check READS it and the
 *  will-quit relaunch fix WRITES it, and those two must never drift apart. */
function shipItStatePath() {
  return path.join(app.getPath('cache'), shipItLabel(shipItAppId()), 'ShipItState.plist')
}

/**
 * The version ShipIt still has unpacked, or null.
 *
 * ⚠ Existence alone is NOT the question (adversarial review, 2026-09-22 —
 * measured on a real Mac): both `ShipItState.plist` and the `update.*` bundle
 * SURVIVE a successful install, and other Squirrel apps on the same machine
 * were holding `update.*` dirs two months stale. Only the staged VERSION can
 * tell "still pending" from "already installed, litter left behind".
 *
 * ⚠ And it must come from the REQUEST, not from scanning `update.*` (rework,
 * 2026-09-22). A kicked ShipIt replays `ShipItState.plist` and nothing else, so
 * a directory walk answers a different question than the one that matters:
 * with several `update.*` dirs present — which the doc itself says happens — a
 * readdir-order match on the target version can name a build the request does
 * not point at, and a bundle nested one level deeper than expected reads as
 * "nothing staged", disabling self-repair on a real machine while the tests
 * stay green. The file is named `.plist` but Squirrel writes JSON into it
 * (SQRLShipItRequest.m:184-200, Mantle → NSJSONSerialization; the keys are at
 * :63-70), so it is one `JSON.parse` away.
 */
function pendingShipItRequest() {
  try {
    return parseShipItRequest(require('fs').readFileSync(shipItStatePath(), 'utf8'))
  } catch {
    /* absent, unreadable, not JSON, no such key — all the same answer: do nothing */
    return null
  }
}

/** The version that request would install, or null. */
function stagedShipItVersion() {
  const request = pendingShipItRequest()
  return request ? bundleVersionAt(request.bundlePath) : null
}

/**
 * Self-repair, ARMED once per from→to pair: the previous quit installed
 * nothing, so the next quit kicks the launchd job by hand — the release
 * operator's manual fix (2026-09-21) that the app can now perform for itself.
 *
 * ⚠ Armed, not fired. ShipIt blocks until every instance of the app has quit
 * before touching anything (`-waitForTermination`, Squirrel.Mac
 * SQRLTerminationListener.m:51), so kicking it HERE would park a process that then installs
 * its staged version on whatever quit comes next — including one that follows
 * the user taking this same boot's `install-failed` dialog to the release page
 * and installing a NEWER build by hand. That would be a silent downgrade
 * undoing the user's own action. Deferring to `will-quit`, where the installed
 * version is re-checked, removes the window entirely.
 * @param {{ kind: string, from?: string, to?: string }} verdict
 */
function armInstallSelfRepair(verdict) {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  const marker = recoveryMarkerPath()
  const stagedVersion = stagedShipItVersion()
  if (!decideBootRecovery({ verdict, lastRecovery: readPendingInstall(marker), stagedVersion })) {
    ulog.info(
      `boot: no self-repair for ${verdict.from} → ${verdict.to} ` +
        `(staged=${stagedVersion || 'none'}; already tried once, or nothing matching is staged)`,
    )
    return
  }
  // Written BEFORE the attempt is armed: a run that dies before quitting must
  // not hand the same attempt to every launch from here on.
  writePendingInstall({ path: marker, from: verdict.from || '', to: verdict.to || '' })
  armedKickstart = { why: `self-repair of the failed ${verdict.from} → ${verdict.to} install`, verifyRelaunch: true }
  ulog.info(`boot: self-repair ARMED — ${verdict.to} is still staged; the next quit will start ShipIt by hand`)
}

/**
 * `will-quit`: the last moment this process runs, and the ONLY one at which
 * kicking ShipIt is both correct and safe.
 *
 * The request Squirrel wrote and submitted at staging time says
 * `launchAfterInstallation = NO`, and `quitAndInstall` is the only thing that
 * ever flips it — when it quits at all. So for an install WE are quitting for
 * this writes the flag itself (`stateRelaunchForInstall`) rather than assume;
 * the install this kick produces then also RELAUNCHES the app, which a
 * pre-flight kick would not (electron/shipIt.js header (b)). And nothing can
 * come between the kick and this process exiting, so ShipIt cannot sit parked
 * over an app the user goes on using.
 *
 * ⚠ `app.exit()` bypasses this handler entirely (main.js's fatal-startup exits
 * use it). A crash-exit therefore spends the pair's one recovery ticket without
 * trying — accepted: the ticket is written at ARM time on purpose, so that a
 * run which dies before quitting cannot hand the same attempt to every launch
 * that follows. Losing one retry beats an unbounded retry loop.
 */
/**
 * Tell the installer to reopen the app — by WRITING that into Squirrel's
 * pending request — for the install THIS quit is performing. Returns whether
 * the kickstart may go ahead.
 *
 * Three refusals, all of them "do not nudge an install we cannot promise to
 * reopen" (the adversarial review's downgrade + corruption cases):
 *  • the request points at a DIFFERENT version than the one we quit to install
 *    — blessing it would relaunch a build the user never chose, possibly older;
 *  • the file is not a readable ShipIt request — we do not write into something
 *    we cannot recognise, and there is nothing to kick either;
 *  • the write failed — Squirrel's own request survives (the write is
 *    tmp-file + rename, atomic on APFS), so the worst case stays "no install
 *    now", never "a request ShipIt cannot parse".
 * @param {string} why
 * @param {string | undefined} version — the version beforeInstall quit to install
 * @returns {boolean}
 */
function stateRelaunchForInstall(why, version) {
  // ⚠ COST AT `will-quit`, counted exactly (it runs while the app is exiting):
  // one bounded `plutil` subprocess (stagedShipItVersion → bundleVersionAt, 2 s
  // timeout) plus FOUR synchronous filesystem operations — the staged bundle's
  // Info.plist read, the request read, the tmp write, the rename. Worst case is
  // therefore the plutil timeout plus four small local I/Os, ≈2 s, inside the
  // install watchdog's 90 s and far under macOS's quit grace.
  //
  // The version gate is deliberately one-sided: it only STOPS a write when both
  // versions are known AND differ. An unknown version (a download that never
  // reported one) or an unreadable staged bundle (plutil failed) lets the write
  // through, because the alternative — standing down whenever we are unsure —
  // would disable the fix on exactly the machines where reading things fails.
  // The downgrade case it exists for is a KNOWN mismatch, and that it still
  // catches.
  //
  // Read LAZILY: the unarmed-quit caller passes no version (it has nothing to
  // compare against) and has already established that the staged bundle reads,
  // so a second `plutil` there would only spend quit time on a comparison that
  // cannot happen.
  const staged = version ? stagedShipItVersion() : null
  if (version && staged && staged !== version) {
    ulog.warn(`ShipIt kickstart skipped (${why}): the pending request installs ${staged}, not ${version}`)
    return false
  }
  // The read/write pair is the one in electron/shipIt.js (tmp + rename, and it
  // cleans its tmp file up), so the production closure is the same object the
  // unit tests and scripts/probe-shipit-relaunch.mts exercise.
  const outcome = ensureRelaunchAfterInstall(shipItRequestIO(shipItStatePath()))
  const line = `relaunch after install (${why}): ${outcome}`
  if (outcome === 'set' || outcome === 'already-set') {
    ulog.info(line)
    return true
  }
  ulog.warn(`${line} — this install would not reopen the app`)
  return false
}

/**
 * An ordinary quit — ⌘Q, the menu, a logout — with an update already staged.
 * Squirrel installs it on termination anyway, and the request it wrote at stage
 * time says `launchAfterInstallation = NO`, so the app is swapped and stays
 * closed. **Owner decision, 2026-09-22: it should come back up.** (Until then
 * this was deliberately left alone, on the opposite reading — "the user closed
 * the app, so it stays closed".)
 *
 * ⚠ This writes the relaunch instruction and NOTHING ELSE. The kickstart stays
 * behind the arm gate below: an unarmed quit must still never poke launchd.
 *
 * "Is there an install for this quit to reopen at all?" — three conditions:
 *  • `stagedShipItVersion()` reads — the pending request parses AND the bundle
 *    it points at is a readable app bundle carrying a version;
 *  • that version is STRICTLY NEWER than the one we are running
 *    (`decideUnarmedStagedRelaunch`). This is the LITTER GATE, and it is the
 *    reason a bare truthiness check is wrong: the request AND the
 *    `update.*` bundle both SURVIVE a successful install (see
 *    `pendingShipItRequest` above), so on any Mac that has ever updated, the
 *    steady state is a readable staged bundle of the version already installed.
 *    Measured on the owner's machine, 2026-09-22: `ShipItState.plist` holds
 *    `launchAfterInstallation:false` for a staged 0.11.121 while /Applications
 *    and the running process are also 0.11.121 — leftovers, nothing pending.
 *    Writing YES there would happen on every single quit from then on. An
 *    OLDER staged version is litter of a second shape — explained by a job
 *    launchd sat on while the owner installed a newer build by hand — and
 *    blessing it would reopen the app onto a downgrade, so it is refused too;
 *  • `targetBundleURL` is present — checked inside `ensureRelaunchAfterInstall`,
 *    because the flag means "reopen the target" and a missing one is a relaunch
 *    with no subject.
 * Any of them unanswerable ⇒ write nothing, i.e. exactly the behaviour before
 * this change.
 *
 * ⚠ CEILING of the litter gate: only a STRICTLY NEWER staged version passes,
 * so a staged REINSTALL of the running version is skipped, a staged OLDER
 * version is skipped, and so is any version string not readable as a plain
 * x.y.z (a prerelease tag, a leading `v`) — undecidable reads as "do nothing".
 * In each case the install, if one happens, would not reopen the app. Accepted:
 * same-version and downgrade staging are not shapes this updater produces
 * (`allowDowngrade` is never set, and electron-updater 6.8.3 defaults it to
 * false), and the alternative is writing into litter on every quit forever.
 *
 * And no new write path: this routes through the same
 * `stateRelaunchForInstall` the armed install uses, so that one reviewed write
 * site still covers it.
 */
function relaunchUnarmedStagedInstall() {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  const staged = stagedShipItVersion()
  // Unreadable, the version we are already running, or OLDER than it ⇒
  // leftovers from a past install, not something this quit is about to apply.
  // Write nothing. (The older-than case is a stale job the owner has since
  // overtaken by installing by hand — see decideUnarmedStagedRelaunch.)
  if (!decideUnarmedStagedRelaunch({ stagedVersion: staged, runningVersion: app.getVersion() })) return
  stateRelaunchForInstall(`update applying on an ordinary quit (staged ${staged})`, undefined)
}

function kickstartShipItBeforeExit() {
  // THE arm gate: an ordinary ⌘Q must never KICKSTART the installer. Removing
  // this line means every quit pokes launchd — autoUpdate.test.ts pins it. An
  // update Squirrel applies on that quit by itself still gets its relaunch
  // instruction (owner decision, 2026-09-22) — that, and only that, is what
  // the call below does.
  if (!armedKickstart) return relaunchUnarmedStagedInstall()
  const { why, verifyRelaunch, version } = armedKickstart
  armedKickstart = null // one shot, whatever happens below
  if (
    !decideArmedRecoveryAtQuit({
      runningVersion: app.getVersion(),
      // The bundle we are executing from — if it is no longer OUR version,
      // someone replaced the app since boot and the staged build is older.
      installedVersion: bundleVersionAt(path.resolve(path.dirname(app.getPath('exe')), '..', '..')),
    })
  ) {
    ulog.warn(`ShipIt kickstart skipped (${why}): the app on disk is no longer the version this process is running`)
    return
  }
  // SELF-REPAIR: VERIFY. The request was armed at boot, and a download that
  // landed since then rewrote it with `launchAfterInstallation` back to NO
  // (-prepareUpdateForInstallation:). Kicking now would install and NOT reopen
  // the app — while the dialog that sent the user here promised it would. Let
  // the ordinary "Restart now" flow handle that newer update instead; it comes
  // through the branch below.
  //
  // AN INSTALL WE ARE QUITTING FOR: WRITE IT. This used to ASSUME
  // `quitAndInstall` had just flipped the flag to YES. Assuming is the wrong
  // shape: `quitAndInstall` can return without quitting at all on macOS
  // (MacUpdater.js:236-252), and only a write makes the promise this quit made
  // to the user ("restarting to install") true no matter how it got here.
  //
  // ⚠ SCOPE, stated because it is narrower than it looks — and because the
  // owner's 2026-09-22 install is NOT evidence for this path. The only thing
  // measured about that one is a negative: no `quitting to install 0.11.120`
  // line, and only `beforeInstall` writes that line, so nothing armed it. Nor
  // does the unarmed-quit path reach it: the same process's `auto-apply
  // deferred (unfocused Nmin)` counter rises monotonically straight THROUGH the
  // install (4 → 29 min), so that process never quit at all. What
  // DID apply it is unexplained (the app neither quit nor started in that
  // window, yet ShipIt completed an install) and is a separate card. What this
  // fixes is the armed case — "Restart now" and the hands-free auto-apply,
  // where the app promised to come back.
  //
  // An update that lands on an UNARMED quit is handled before this point, at
  // the arm gate (`relaunchUnarmedStagedInstall`) — owner decision 2026-09-22:
  // it reopens the app too. What stays behind the arm gate is the KICK, not the
  // relaunch instruction. See electron/shipIt.js and docs/DISTRIBUTION.md.
  if (verifyRelaunch) {
    const request = pendingShipItRequest()
    if (!request || !request.relaunchesAfterInstall) {
      ulog.warn(
        `ShipIt kickstart skipped (${why}): the pending request would install without relaunching` +
          ` (launchAfterInstallation=${request ? 'false' : 'unreadable'})`,
      )
      return
    }
  } else if (!stateRelaunchForInstall(why, version)) {
    return
  }
  kickstartShipItSync(why)
}

/**
 * Boot-time verdict on the previous run's install (electron/updaterLog.js).
 * 'failed' is the one that speaks: a dialog with the log's tail and a button
 * that opens the log — the third "came back on the old version, no explanation"
 * (2026-09-13) is the reason. 'installed' / 'stale' / 'none' only log.
 * Wrapped so a broken marker can never keep the app from launching.
 */
function reportFailedInstallOnBoot() {
  try {
    const verdict = checkPendingInstall({ path: pendingInstallPath(), currentVersion: app.getVersion() })
    if (verdict.kind === 'none') return
    ulog.info(`boot: pending install ${verdict.from} → ${verdict.to} (${verdict.at || '?'}) — ${verdict.kind}`)
    if (verdict.kind !== 'failed') return
    // Arm the self-repair for THIS run's own quit (never sooner — see
    // armInstallSelfRepair). Synchronous, so it cannot still be running when
    // initAutoUpdater starts an install of its own.
    armInstallSelfRepair(verdict)
    void showUpdateDialog('install-failed', {
      version: verdict.to,
      from: verdict.from,
      logTail: tailUpdaterLog(updaterLogPath(), 25),
      // Armed just above: quitting is now the fix, so the dialog says that
      // rather than sending the user to the release page — a hand-install
      // while a retry is armed is exactly the case will-quit has to skip.
      retryArmed: armedKickstart !== null,
    })
      .then((res) => {
        if (res.response === 0) void shell.openPath(updaterLogPath()).catch(() => {})
        else if (res.response === 1) void shell.openExternal(RELEASE_NOTES_URL).catch(() => {})
      })
      .catch(() => {})
  } catch (err) {
    console.error('[openground] pending-install check skipped:', err && err.message ? err.message : err)
  }
}

/**
 * The watchdog's voice: the app asked to restart-and-install and is STILL HERE.
 *
 * Reached only in the world where quitAndInstall() failed to quit (see
 * electron/autoUpdate.js — INSTALL_WATCHDOG_MS). By this point the forked server
 * has already been torn down, so the window is not usable: saying nothing is the
 * exact 2026-09-11 defect, where the user force-quit and the update was lost
 * silently on every single launch. Native dialog on purpose — it does not need
 * the dead back-end.
 */
function reportInstallStuck(version) {
  ulog.error('quitAndInstall did not quit — the update was NOT applied')
  showUpdateDialog('install-stuck', { version })
    .then((res) => {
      if (res.response === 0) void shell.openExternal(RELEASE_NOTES_URL).catch(() => {})
    })
    .catch(() => {})
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
      // Everything about HOW this applies lives in applyUpdateWhenStaged: wait
      // for the OS installer if it is not ready (without destroying anything),
      // then tear the forked server down BEFORE quitAndInstall (mandatory — see
      // electron/autoUpdate.js), then say so if the quit never happens.
      void applyUpdateWhenStaged(version)
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
            ulog.error('manual check failed:', err && err.message)
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
    ulog.error('electron-updater unavailable:', err && err.message)
    // NOW "this build has no updater" is the truth, and the menu may say it.
    autoUpdaterInit = 'unavailable'
    return
  }
  autoUpdaterHandle = autoUpdater
  autoUpdaterInit = 'ready'
  // electron-updater's internal narrative (proxy server for Squirrel, what
  // Squirrel requested, native errors) — the part that was stdout-only when the
  // 2026-09-13 install vanished without a trace.
  autoUpdater.logger = makeUpdaterLogger({ path: updaterLogPath(), tag: 'electron-updater' })
  // Observe the OS installer (macOS). This is the only trustworthy answer to
  // "will quitAndInstall actually quit?" — see applyUpdateWhenStaged. Listening
  // only; the native updater is never driven from here.
  try {
    if (process.platform === 'darwin') {
      nativeUpdaterHandle = require('electron').autoUpdater
      nativeUpdaterHandle.on('update-downloaded', () => {
        squirrelStaged = true
        ulog.info('the OS installer staged the update — a restart is now immediate')
      })
      nativeUpdaterHandle.on('error', (err) => {
        ulog.error('OS installer (Squirrel) error:', err && err.message ? err.message : err)
      })
    }
  } catch (err) {
    nativeUpdaterHandle = null
    ulog.warn('could not observe the OS installer:', err && err.message)
  }

  // We drive the "apply" step ourselves (a dialog button), so disable the
  // built-in auto-install-on-quit — otherwise a downloaded update would also
  // get applied on the next normal Cmd+Q, mid-run-queue.
  autoUpdater.autoDownload = true
  // macOS: ALWAYS eager (see eagerSquirrelHandoff — false there makes
  // quitAndInstall() return without quitting). Elsewhere it follows the setting.
  autoUpdater.autoInstallOnAppQuit = eagerSquirrelHandoff(process.platform, autoUpdateEnabled())

  autoUpdater.on('checking-for-update', () => {
    ulog.info('checking for update…')
  })
  autoUpdater.on('update-available', (info) => {
    ulog.info('update available:', info && info.version)
  })
  autoUpdater.on('update-not-available', (info) => {
    ulog.info('up to date:', info && info.version)
  })
  autoUpdater.on('error', (err) => {
    // Non-fatal: a failed update check must never take the app down.
    ulog.error('error:', err && err.message ? err.message : err)
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
    ulog.info(`downloading ${Math.round(p.percent)}%`)
    // Ambient, not modal: the dock icon carries the download so "is anything
    // happening?" has an answer without a dialog (the 2026-08-13 stuck-looking
    // update). percent is 0–100 from electron-updater; clamp defensively.
    const ratio = Number.isFinite(p && p.percent) ? Math.min(1, Math.max(0, p.percent / 100)) : 0
    setUpdateDockProgress(ratio)
  })
  autoUpdater.on('update-downloaded', (info) => {
    const version = (info && info.version) || ''
    ulog.info('update downloaded:', version || '(unknown version)')
    // The announced download kept its promise — retire the failure watch and
    // the dock progress bar.
    announcedDownloadLive = false
    setUpdateDockProgress(-1)
    // Remember it: if the user picks "Later", the menu's manual check must offer
    // THIS restart instead of asking GitHub again about an update already on disk.
    // A NEW version is not staged yet, whatever the last one managed. Safe to
    // reset here: electron-updater emits this BEFORE handing the zip over, so
    // the native 'update-downloaded' that flips the flag always comes after.
    // The SAME version re-announced (the hourly poll re-finds the cached file)
    // keeps its staged flag: Squirrel refuses a second check while it is
    // awaiting relaunch, so a reset here would never be undone and "Restart
    // now" would sit out the whole staging wait for an update that is ready.
    if (!downloadedUpdate || downloadedUpdate.version !== version) squirrelStaged = false
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
      ulog.info(`${label} check skipped — work mode (lockdown) is on`)
      return
    }
    // Keep the flag in step with the LIVE setting, platform-aware: on
    // Windows/Linux hands-free on ⇒ a downloaded update also applies on any
    // normal quit, toggled off ⇒ explicit-restart-only. On macOS it is pinned
    // true regardless (eagerSquirrelHandoff — the flag means "hand the zip to
    // Squirrel now" there, and false breaks "Restart now" outright). Refreshed
    // per tick so the Settings toggle needs no app restart (same liveness
    // contract as the lockdown read above).
    autoUpdater.autoInstallOnAppQuit = eagerSquirrelHandoff(process.platform, autoUpdateEnabled())
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      ulog.error(`${label} check failed:`, err && err.message)
    })
  }
  // Arm the release-time bell: onServerMessage rings this on the server's
  // UPDATE_CHECK_MESSAGE (rate limit + null guard live over there).
  nudgeUpdateCheck = () => maybeCheck('nudge')
  maybeCheck('initial')
  setInterval(() => {
    maybeCheck('periodic')
  }, AUTO_UPDATE_INTERVAL_MS)
}
