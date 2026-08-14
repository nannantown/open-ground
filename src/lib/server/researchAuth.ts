// researchAuth — local-only storage for the research system's platform cookies
// (today: X/Twitter `auth_token` + `ct0`), behind Settings → Research channels.
//
// THE PROMISE THE UI MAKES, ENFORCED HERE: the values are stored ONLY on this
// machine and never leave it —
//   - written to ~/.openground/research-auth.json with mode 0600;
//   - the status API returns BOOLEANS only, never the values (a client that
//     could read them back would be an exfiltration path; the pin lives in
//     researchAuth.test.ts);
//   - never logged (no console.* in this module touches the values);
//   - handed out exactly once, as env vars for an OG-spawned worker's own
//     local tool invocations (researchWorkerEnv → swarmWorker spawn), the same
//     exposure class a PTY-era `zsh -l` desk already had for anything the
//     owner exported in their shell profile.
//
// At-rest hardening (Electron safeStorage / OS keychain) is a DELIBERATE
// follow-up, not an oversight: the encrypt/decrypt would have to round-trip
// the Electron MAIN process over fork IPC, and per docs/VERIFICATION.md §4.1
// anything on that seam needs a packaged-.app pass this change set cannot run.
// File perms + boolean-only reads are the honest v1.

import { chmod, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { researchAuthFile } from './paths'

export interface ResearchTwitterAuth {
  authToken: string
  ct0: string
}

interface ResearchAuthFileShape {
  twitter?: ResearchTwitterAuth
}

/** Cookie values are opaque tokens, not prose — cap them so a paste mistake
 *  (whole cookie header, a JSON blob) is rejected instead of stored. */
const MAX_VALUE_LEN = 500

const sane = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.trim().length <= MAX_VALUE_LEN

const readStore = async (): Promise<ResearchAuthFileShape> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(researchAuthFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    const t = (parsed as ResearchAuthFileShape).twitter
    return sane(t?.authToken) && sane(t?.ct0)
      ? { twitter: { authToken: t.authToken.trim(), ct0: t.ct0.trim() } }
      : {}
  } catch {
    return {} // absent / unreadable / corrupt ⇒ not configured (fail closed)
  }
}

/** The stored X cookies, or null. PRODUCTION READER — the worker-env injection
 *  and the status API both come through here, so a test that writes through
 *  setResearchTwitterAuth and reads back through this proves the real path. */
export const getResearchTwitterAuth = async (): Promise<ResearchTwitterAuth | null> =>
  (await readStore()).twitter ?? null

/** Save (both values, trimmed) or reject. Never partial: one cookie without
 *  the other cannot work, so it must not be storable. */
export const setResearchTwitterAuth = async (auth: ResearchTwitterAuth): Promise<void> => {
  if (!sane(auth.authToken) || !sane(auth.ct0)) {
    throw new Error('research auth: both auth_token and ct0 are required (each 1..500 chars)')
  }
  const file = researchAuthFile()
  await mkdir(dirname(file), { recursive: true })
  const body: ResearchAuthFileShape = {
    twitter: { authToken: auth.authToken.trim(), ct0: auth.ct0.trim() },
  }
  await writeFile(file, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  // writeFile's `mode` only applies on CREATE — an existing file keeps its old
  // bits — so re-assert after every write.
  await chmod(file, 0o600)
}

/** Forget the stored cookies (idempotent). */
export const clearResearchTwitterAuth = async (): Promise<void> => {
  await rm(researchAuthFile(), { force: true })
}

/** Booleans only — the shape the status API may expose. */
export const researchAuthStatus = async (): Promise<{ twitterConfigured: boolean }> => ({
  twitterConfigured: (await getResearchTwitterAuth()) !== null,
})

/** Env vars for an OG-spawned worker so its local twitter-cli invocations are
 *  signed in — {} when nothing is configured (spawn env then stays untouched).
 *  A user's own exported env still wins: the caller spreads this UNDER
 *  process.env? No — OVER. Stored settings are the more deliberate act, and
 *  the panel is where we told the owner this lives; an old forgotten export
 *  silently overriding the panel would make the UI lie. */
export const researchWorkerEnv = async (): Promise<Record<string, string>> => {
  const t = await getResearchTwitterAuth()
  return t ? { TWITTER_AUTH_TOKEN: t.authToken, TWITTER_CT0: t.ct0 } : {}
}
