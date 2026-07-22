// Type declarations for the plain-CJS electron/runtimeConfig.js. The module
// itself must stay JS (electron/main.js is loaded directly by Electron and
// cannot import TypeScript), but TS callers — the vitest suite — get full types
// from here. Runtime resolves the .js; TypeScript resolves this .d.ts.

/** The exact (public) keys ever baked into a shipped build: app-login
 *  (SUPABASE_*) plus realtime-collab (OPENGROUND_REALTIME / the public Worker WS
 *  endpoint). Never a credential — see electron/runtimeConfig.js. */
export type BakedKey =
  | 'SUPABASE_URL'
  | 'SUPABASE_ANON_KEY'
  | 'OPENGROUND_REALTIME'
  | 'OPENGROUND_COLLAB_WS_URL'

export type BakedAuthEnv = Partial<Record<BakedKey, string>>

/** The exact (public) keys ever baked into a shipped build. */
export const BAKED_KEYS: ReadonlyArray<BakedKey>

/** Absolute path of the baked config file (electron/runtime-config.json). */
export const CONFIG_FILE: string

/**
 * Write the baked config from an env bag (default process.env) to `file`
 * (default CONFIG_FILE). Only non-empty BAKED_KEYS are written; always writes
 * (`{}` when nothing configured). Returns the object written.
 */
export function writeRuntimeConfig(env?: NodeJS.ProcessEnv, file?: string): BakedAuthEnv

/**
 * Read the baked config back as an env-shaped object to spread into a child
 * process env. Returns `{}` on a missing/empty/corrupt file.
 */
export function readBakedAuthEnv(file?: string): BakedAuthEnv

// The secret/bake policy itself lives in electron/secretPolicy.js (one definition
// shared with the untrusted-child strip policy) — import it from there.
