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

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const path = require('path')
const http = require('http')
const { fork, execFileSync } = require('child_process')
const crypto = require('crypto')
const { readBakedAuthEnv } = require('./runtimeConfig')
const { maybeResetCachesOnVersionChange } = require('./cacheReset')

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
    resetStaleCachesOnVersionChange()
    registerIpcHandlers()
    void start()
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

  // Tear down the forked server before the process exits. Async-safe via
  // event.preventDefault() until the child is gone (or the grace elapses).
  app.on('before-quit', (event) => {
    if (serverChild && !serverChild.killed) {
      event.preventDefault()
      isQuitting = true
      shutdownServerChild().finally(() => {
        app.quit()
      })
    }
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
// cwd: the app root that holds scripts/ + src/designs/. src/lib/server's
// hooksInstall.ts and screenWatcher.ts derive paths from process.cwd(), so the
// child must run from a dir where those exist. We anchor it at the bundle's
// app root (two levels up from server/dist/index.cjs).
// ---------------------------------------------------------------------------
async function spawnServerChild() {
  const serverPath = resolveServerBundle()
  if (!serverPath) {
    throw new Error(
      'could not locate server/dist/index.cjs — run `npm run build:server` ' +
        '(or `npm run build`) before electron:prod, or check that server/dist ' +
        'is shipped (asarUnpack) for the packaged app'
    )
  }

  // server/dist/index.cjs → app root is two dirs up (../../).
  const appRoot = path.resolve(path.dirname(serverPath), '..', '..')
  const webRoot = resolveWebRoot()

  // Resolve the login-shell PATH right here, just before fork — async, so the
  // ~560ms `zsh -lic` probe never blocked window creation earlier in startup.
  const enrichedPath = await resolveEnrichedPath()

  // PUBLIC build-time config, baked into electron/runtime-config.json (see
  // electron/runtimeConfig.js): app login (SUPABASE_URL / SUPABASE_ANON_KEY) AND
  // realtime collab (OPENGROUND_REALTIME / OPENGROUND_COLLAB_WS_URL). A
  // Finder/Dock-launched .app inherits a stripped env with these NOWHERE, so
  // without this the forked server reports `/api/auth/config → { enabled:false }`
  // (toolbar hides "Sign in") AND `/api/collab/config → { enabled:false }` (collab
  // off for every shipped user) — the exact bug this fixes. We spread it BEFORE
  // ...process.env so an explicit env var (an operator override) still wins for
  // the overridable keys; in the normal packaged case process.env has none of
  // them, so the baked values fill in. An absent/empty file yields {} → login +
  // collab stay disabled (graceful degrade). The SERVICE_ROLE key and the collab
  // HMAC ticket secret are NEVER baked (see REPORT.md / runtimeConfig.js guard).
  const bakedAuthEnv = readBakedAuthEnv()
  console.log(
    `[openground] app login: ${bakedAuthEnv.SUPABASE_URL ? 'enabled (baked config present)' : 'disabled (no baked config)'}`
  )
  console.log(
    `[openground] realtime collab: ${bakedAuthEnv.OPENGROUND_REALTIME && bakedAuthEnv.OPENGROUND_COLLAB_WS_URL ? 'enabled (baked config present)' : 'disabled (no baked config)'}`
  )

  const child = fork(serverPath, [], {
    cwd: appRoot,
    detached: false, // tied to our lifetime; dies with the parent tree.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...bakedAuthEnv,
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(FIXED_PORT),
      HOSTNAME: HOST,
      OPENGROUND_BOOT_ID: BOOT_ID,
      OPENGROUND_PROJECT_DIR: PROJECT_DIR,
      ...(webRoot ? { OPENGROUND_WEB_ROOT: webRoot } : {}),
      // A packaged .app launched from Finder/Dock inherits a minimal PATH
      // (/usr/bin:/bin), so node-pty's posix_spawn of `zsh`/`claude` fails with
      // "No such file or directory". The old shell launcher dodged this by
      // running under `zsh -lic` (full login PATH). We reproduce that here.
      PATH: enrichedPath,
      // SECURITY — collab token-relay destination lock. The collab Worker WS
      // endpoint is where the signed-in user's Supabase access token is relayed
      // (server-to-server) to mint a ticket. In a SHIPPED build that destination
      // must be the value we baked and NOTHING the local launch environment can
      // change — otherwise a tampered `OPENGROUND_COLLAB_WS_URL=wss://attacker`
      // in the user's env would redirect the token relay. So when a baked WS URL
      // exists, re-apply it AFTER ...process.env so it wins over any env override.
      // When NO WS URL was baked (a local/dev `electron:prod` build), process.env
      // still flows through, so a developer can still point at a local/staging
      // Worker — i.e. env override is dev-only. (OPENGROUND_REALTIME stays
      // overridable: flipping the flag off is a legitimate opt-out, not an attack,
      // and it can't change where the token goes.)
      ...(bakedAuthEnv.OPENGROUND_COLLAB_WS_URL
        ? { OPENGROUND_COLLAB_WS_URL: bakedAuthEnv.OPENGROUND_COLLAB_WS_URL }
        : {}),
    },
  })

  child.stdout?.on('data', (d) => process.stdout.write(`[hono] ${d}`))
  child.stderr?.on('data', (d) => process.stderr.write(`[hono] ${d}`))

  child.on('exit', (code, signal) => {
    serverChild = null
    // An unexpected death (not during our own quit) is fatal — there is no
    // server to talk to. Surface it rather than leave a blank window.
    if (!isQuitting) {
      dialog.showErrorBox(
        'OPEN GROUND',
        `The OPEN GROUND server exited unexpectedly (code=${code} signal=${signal}).`
      )
      app.exit(1)
    }
  })

  serverChild = child
  return child
}

// Graceful child teardown: SIGTERM, wait up to CHILD_SIGTERM_GRACE_MS, then
// SIGKILL. Resolves once the child is gone (or we've force-killed it).
function shutdownServerChild() {
  return new Promise((resolve) => {
    const child = serverChild
    if (!child || child.killed || child.exitCode !== null) {
      resolve()
      return
    }

    let settled = false
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

    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      done()
    }, CHILD_SIGTERM_GRACE_MS)
  })
}

// ---------------------------------------------------------------------------
// /api/health probing.
//
// pingHealth() resolves with the parsed JSON body on 2xx + valid JSON, else
// rejects. waitForReady() polls until the body satisfies the predicate or the
// timeout elapses — the Electron equivalent of the shell launcher's STEP 6.
// ---------------------------------------------------------------------------
function pingHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(HEALTH_URL, { timeout: HEALTH_REQUEST_TIMEOUT_MS }, (res) => {
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

// Poll /api/health until `predicate(body)` is true. In prod the predicate
// requires bootId === BOOT_ID (proves the listener is our fork). In dev the
// dev server was started separately so we only require app === 'openground'.
function waitForReady(predicate) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const tick = async () => {
      // If the prod child died while we were waiting, bail immediately.
      if (MODE === 'prod' && (!serverChild || serverChild.exitCode !== null)) {
        reject(new Error('server process exited before becoming ready'))
        return
      }
      try {
        const body = await pingHealth()
        if (predicate(body)) {
          resolve(body)
          return
        }
      } catch {
        /* not up yet — keep polling */
      }
      if (Date.now() >= deadline) {
        reject(new Error(`server did not become ready within ${HEALTH_TIMEOUT_MS / 1000}s`))
        return
      }
      setTimeout(tick, HEALTH_POLL_INTERVAL_MS)
    }
    void tick()
  })
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
    await mainWindow.loadURL(MODE === 'dev' ? DEV_URL : BASE_URL)
  }

  // Auto-update wiring (Fix #14). Only ever runs in a packaged build — in dev
  // (isPackaged=false) electron-updater would hit GitHub and log spurious
  // "cannot find update feed"/dev errors, so we never even require it there.
  initAutoUpdater()
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
// explicit user action (here: a dialog button on 'update-downloaded'). The
// minimal contract is "download + tell the user"; the restart is opt-in.
// ---------------------------------------------------------------------------
const AUTO_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4h

function initAutoUpdater() {
  if (!app.isPackaged) return // dev / unpackaged: never touch electron-updater.

  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch (err) {
    console.error('[updater] electron-updater unavailable:', err && err.message)
    return
  }

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
  })
  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] downloading ${Math.round(p.percent)}%`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    const version = (info && info.version) || 'a new version'
    console.log('[updater] update downloaded:', version)
    // Notify only — do NOT auto-restart (could kill an in-flight run). Offer
    // the restart as an explicit choice; default to "Later".
    dialog
      .showMessageBox(mainWindow || undefined, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 1,
        cancelId: 1,
        title: 'OPEN GROUND',
        message: `OPEN GROUND ${version} has been downloaded.`,
        detail:
          'Restart to apply the update. If a run is in progress, choose "Later" ' +
          'and restart once it finishes.',
      })
      .then((res) => {
        if (res.response === 0) {
          isQuitting = true
          autoUpdater.quitAndInstall()
        }
      })
      .catch(() => {})
  })

  // Kick off an initial check, then poll every 4h. checkForUpdatesAndNotify
  // surfaces a native OS notification on its own in addition to our handlers.
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[updater] initial check failed:', err && err.message)
  })
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[updater] periodic check failed:', err && err.message)
    })
  }, AUTO_UPDATE_INTERVAL_MS)
}
