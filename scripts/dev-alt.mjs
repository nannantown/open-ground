// Secondary dev instance launcher — `npm run dev:alt`.
//
// Port convention: the primary (daily-driver) instance owns the fixed pair
// Web 5174 / API 47776 via `npm run dev`. Every EXTRA instance — a worktree,
// a parallel branch, a second checkout — goes through this script, which
// claims the first free pair counting up from Web 5175 / API 47777 and
// prints the URL to open. Nothing else changes: the server already honors
// PORT, the SPA only uses relative /api fetches, and vite.config.ts reads
// OPENGROUND_WEB_PORT / OPENGROUND_API_PORT.
//
// Known limit: OAuth login (server/routes/auth.ts) has a fixed redirect URI
// on 47776, so app login only works on the primary instance. Fine for dev —
// these instances are for verifying UI/API changes, not for logging in.
//
// Own data folder by default (2026-11-23). Unless OPENGROUND_HOME is given, the
// instance gets a throwaway one. On 2026-11-20 a dev:alt on the shared
// ~/.openground marked the live app's in-flight tool calls 'uncertain', and two
// teams stood still for three days. A second process is now refused the live
// app's runtime journal (src/lib/server/runtimeJournalOwner.ts); its own folder
// keeps this instance working instead of refused.
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

// Not even when asked (2026-11-24): the app's own data folder stays the app's.
// Its runtime journal refuses a second process, but a second server would still
// act on the app's other state from its own memory (docs/VERIFICATION.md §4.2).
// The same folder however it is spelled (letter case, /System/Volumes/Data, a
// symlink), and with HOME pointed elsewhere the account's home still counts.
const sameFolder = (a, b) => { try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino } catch { return false } }
const appFolders = [homedir(), (() => { try { return userInfo().homedir } catch { return homedir() } })()].map((home) => join(home, '.openground'))
if (process.env.OPENGROUND_HOME && appFolders.some((folder) => sameFolder(process.env.OPENGROUND_HOME, folder))) {
  console.error(`dev:alt refuses OPENGROUND_HOME=${process.env.OPENGROUND_HOME}: it is the app's own data folder. Leave it unset for a throwaway folder (docs/VERIFICATION.md §4.2).`)
  process.exit(1)
}

const WEB_BASE = 5175
const API_BASE = 47777
const SCAN_LIMIT = 50 // give up after 50 occupied ports — something is wrong

// A port counts as free only when BOTH loopback stacks are free — Vite binds
// localhost as ::1, the Hono server as 127.0.0.1, and checking just one would
// miss the other instance.
const isFreeOn = (port, host) =>
  new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, host, () => srv.close(() => resolve(true)))
  })
const isFree = async port => (await isFreeOn(port, '127.0.0.1')) && (await isFreeOn(port, '::1'))

const firstFree = async base => {
  for (let port = base; port < base + SCAN_LIMIT; port++) {
    if (await isFree(port)) return port
  }
  throw new Error(`no free port in ${base}..${base + SCAN_LIMIT - 1}`)
}

const apiPort = await firstFree(API_BASE)
const webPort = await firstFree(WEB_BASE)
// mkdtemp creates the folder, and an existing home never triggers the legacy
// ~/.hove / ~/.pmmap move in paths.ts ensureOpenGroundHome().
const home = process.env.OPENGROUND_HOME || mkdtempSync(join(tmpdir(), 'openground-alt-home-'))

console.log('')
console.log(`  OPEN GROUND dev (alt instance)`)
console.log(`  → open  http://127.0.0.1:${webPort}   (API :${apiPort})`)
console.log(`  data   ${home}${process.env.OPENGROUND_HOME ? '' : '  (throwaway)'}`)
console.log('')

const child = spawn(
  'npx',
  [
    'concurrently',
    '-k',
    'tsx watch --env-file-if-exists=.env.local server/index.ts',
    'vite',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      OPENGROUND_HOME: home,
      PORT: String(apiPort),
      OPENGROUND_API_PORT: String(apiPort),
      OPENGROUND_WEB_PORT: String(webPort),
    },
  },
)
child.on('exit', code => process.exit(code ?? 0))
