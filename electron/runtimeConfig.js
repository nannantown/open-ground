// electron/runtimeConfig.js — build-time Supabase config seam for the packaged app.
//
// THE PROBLEM THIS SOLVES: in a distributed build the Electron main process is
// launched from Finder/Dock with a stripped env, so it has NO SUPABASE_URL /
// SUPABASE_ANON_KEY. The forked Hono server therefore reports
// `GET /api/auth/config → { enabled: false }` and the toolbar hides "Sign in" —
// nobody could ever log in. (In dev the server gets these from `.env.local` via
// `tsx --env-file-if-exists`, which is why login worked there but not shipped.)
//
// THE FIX: at BUILD time we write the PUBLIC values into `runtime-config.json`
// (next to this file, shipped via electron-builder `files: ["electron/**"]`),
// then `electron/main.js` reads them back and injects them into the forked
// server's env. The values come from the open-ground CI Secrets/Vars — never
// hard-coded, and `runtime-config.json` is gitignored so nothing is committed.
//
// SECURITY — only the PUBLIC anon key ships:
//   - BAKED_KEYS is an explicit allowlist of exactly the two public values.
//     The Supabase **anon key is a public key by design**; safety rests on Row
//     Level Security enforcing owner/member/self boundaries at the DB (audited —
//     see REPORT.md). The SERVICE_ROLE key is server-secret and is NEVER bundled;
//     writeRuntimeConfig() refuses to ever bake a SERVICE_ROLE/SECRET-named key.
//   - This file is plain CommonJS (no TypeScript build): `electron/main.js` is
//     loaded directly by Electron and cannot import the TS server modules, so the
//     read half lives here in JS that both main.js and the build script require.

const fs = require('fs')
const path = require('path')

// The only keys we ever bake into the shipped app. PUBLIC values only.
const BAKED_KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY']

// Hard guard: a future edit must never add a server-secret to the allowlist.
for (const k of BAKED_KEYS) {
  if (/SERVICE_ROLE|SECRET|PASSWORD|PRIVATE/i.test(k)) {
    throw new Error(`runtimeConfig: refusing to bake secret-named key "${k}"`)
  }
}

// Co-located with this module so it ships under electron/** and resolves the
// same way in dev (repo) and in the packaged .app (…/Resources/app/electron/).
const CONFIG_FILE = path.join(__dirname, 'runtime-config.json')

// Write the baked config from an env bag (defaults to process.env). Only
// non-empty BAKED_KEYS are written; everything else is dropped. We ALWAYS write
// the file (with `{}` when nothing is configured) so a build never inherits a
// stale config from a previous run — that determinism is what guarantees the
// "no env → enabled:false" graceful degrade. Returns the object written.
function writeRuntimeConfig(env = process.env, file = CONFIG_FILE) {
  const out = {}
  for (const k of BAKED_KEYS) {
    const v = typeof env[k] === 'string' ? env[k].trim() : ''
    if (v) out[k] = v
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  return out
}

// Read the baked config back as an env-shaped object suitable for spreading into
// a child process env. Returns `{}` on a missing/empty/corrupt file (the
// public, credential-free build) so login degrades off cleanly rather than
// throwing. Only the allowlisted, non-empty keys are surfaced.
function readBakedAuthEnv(file = CONFIG_FILE) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    const out = {}
    for (const k of BAKED_KEYS) {
      if (typeof cfg[k] === 'string' && cfg[k]) out[k] = cfg[k]
    }
    return out
  } catch {
    return {}
  }
}

module.exports = { writeRuntimeConfig, readBakedAuthEnv, BAKED_KEYS, CONFIG_FILE }
