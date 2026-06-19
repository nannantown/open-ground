// Type declarations for the plain-CJS electron/runtimeConfig.js. The module
// itself must stay JS (electron/main.js is loaded directly by Electron and
// cannot import TypeScript), but TS callers — the vitest suite — get full types
// from here. Runtime resolves the .js; TypeScript resolves this .d.ts.

export type BakedAuthEnv = Partial<Record<'SUPABASE_URL' | 'SUPABASE_ANON_KEY', string>>

/** The exact (public) keys ever baked into a shipped build. */
export const BAKED_KEYS: ReadonlyArray<'SUPABASE_URL' | 'SUPABASE_ANON_KEY'>

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
