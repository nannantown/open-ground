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
import net from 'node:net'
import { spawn } from 'node:child_process'

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

console.log('')
console.log(`  OPEN GROUND dev (alt instance)`)
console.log(`  → open  http://127.0.0.1:${webPort}   (API :${apiPort})`)
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
      PORT: String(apiPort),
      OPENGROUND_API_PORT: String(apiPort),
      OPENGROUND_WEB_PORT: String(webPort),
    },
  },
)
child.on('exit', code => process.exit(code ?? 0))
