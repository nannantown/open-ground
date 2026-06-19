// scripts/write-runtime-config.js
//
// Build step (runs inside `npm run build` as `build:config`): bakes the PUBLIC
// Supabase config (SUPABASE_URL / SUPABASE_ANON_KEY) from the build env into
// electron/runtime-config.json, which electron/main.js reads at launch and
// injects into the forked Hono server's env. See electron/runtimeConfig.js for
// the why and the security boundary (public anon key only; service-role never).
//
// On the open-ground release runner these come from repo Secrets/Vars; on the
// PMmap CI runner (no secrets) the env is empty and we write `{}` — so the
// public/dev build keeps `GET /api/auth/config → { enabled:false }` unchanged.
//
// Pure Node, run via `node scripts/write-runtime-config.js`. NEVER prints the
// key values — only which keys were baked.

const { writeRuntimeConfig, BAKED_KEYS } = require('../electron/runtimeConfig')

const written = writeRuntimeConfig()
const baked = BAKED_KEYS.filter((k) => k in written)

if (baked.length) {
  console.log(`[write-runtime-config] baked app-login config: ${baked.join(', ')}`)
} else {
  console.log('[write-runtime-config] no SUPABASE_* in build env — login disabled in this build')
}
