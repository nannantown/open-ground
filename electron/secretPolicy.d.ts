// Type declarations for the plain-CJS electron/secretPolicy.js. The module must
// stay JS (electron/main.js is loaded directly by Electron and cannot import
// TypeScript), but TS callers — the vitest suite — get full types from here.

/** Secret-SHAPED env var names. Substring + case-insensitive, so camelCase is
 *  covered. Shared by the strip policy and the bake guard: anything the bake
 *  guard admits is handed to untrusted post-merge code by buildProducerEnv. */
export const SECRET_NAME_RE: RegExp

/** Secrets + authority. Never handed to untrusted code, never bakeable. */
export const GATE_ENV_FORBIDDEN: readonly string[]

/** Public values stripped from VERIFIERS for test hermeticity only; baked into
 *  the shipped app and handed back to PRODUCER steps on purpose. */
export const GATE_ENV_HERMETIC: readonly string[]

/** Names that look secret to the pattern but are public by design (reviewed). */
export const BAKE_PUBLIC_EXCEPTIONS: readonly string[]

/** Is this env var stripped from a verifier child? (forbidden ∪ hermetic ∪ pattern) */
export function isStrippedKey(key: string): boolean

/** May this key be baked — and thus reach untrusted producer code? */
export function isBakeable(key: string): boolean

/** Throws if any key must never be baked. */
export function assertBakeable(keys: readonly string[]): void
