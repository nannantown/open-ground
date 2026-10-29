// src/lib/server/authStore.ts — on-disk persistence for the OPTIONAL app login.
//
// WHAT THIS HOLDS (and the boundary that matters most):
// This file persists the OPEN GROUND *app account* session obtained from
// Supabase Auth — the Google/GitHub login the user optionally signs into. It is
// NOT, and must never be confused with, the Claude CLI subscription token: that
// belongs to the user's `claude` install (~/.claude) and OPEN GROUND never reads
// or writes it. The app login identifies the account used by Pro billing / entitlements (see docs/BILLING_PLAN.md).
//
// SHAPE ON DISK (auth.json): the public Session (user + expiresAt) PLUS the
// Supabase tokens the server needs to refresh. The tokens stay server-side — the
// SPA only ever sees the public AuthUser via GET /api/auth/session, exactly like
// the feedback proxy keeps the anon key off the client.
//
// FAILURE POSTURE (mirrors store.ts): reads never throw — a missing/garbled
// auth.json simply means "signed out" (return null). Writes propagate failures and
// land with mode 0600 (owner-only) since the file carries refresh tokens.

import { readFile, unlink, chmod } from 'fs/promises'
import { ensureOpenGroundHome, authFile } from './paths'
import { atomicWriteJson } from './atomicWrite'
import type { Session } from '../types'

// The persisted record = public Session + the Supabase tokens we keep private.
// `refreshToken` is rotated by Supabase on every refresh, so we re-persist it
// (see server/routes/auth.ts /session) — never assume it is stable.
export interface StoredSession extends Session {
  accessToken: string
  refreshToken: string
}

// Read the persisted session. Returns null on any failure (no file, bad JSON,
// permission error) — "signed out" is the safe default and must never crash the
// loopback server. Does NOT validate token freshness; the route decides whether
// to refresh based on expiresAt.
export const readSession = async (): Promise<StoredSession | null> => {
  await ensureOpenGroundHome()
  try {
    const raw = await readFile(authFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    // Minimal shape guard: a record missing tokens or a user is unusable, so
    // treat it as signed out rather than handing back a half-session.
    if (!parsed?.accessToken || !parsed?.refreshToken || !parsed?.user?.id) {
      return null
    }
    return parsed as StoredSession
  } catch {
    return null
  }
}

// Persist (overwrite) the session. Writes 0600 so the refresh token is
// owner-only. Propagate failures so login is never reported before persistence.
export const writeSession = async (session: StoredSession): Promise<void> => {
  await ensureOpenGroundHome()
  const path = authFile()
  try {
    await atomicWriteJson(path, session, { mode: 0o600 })
    // The temp file is created 0600 and rename preserves it, but chmod again so
    // an existing, looser-permission auth.json is tightened on every write.
    await chmod(path, 0o600)
  } catch (err) {
    console.error(
      '[openground:auth] failed to persist session',
      err instanceof Error ? err.message : err,
    )
    throw new Error('Could not save app session')
  }
}

// Clear the session (sign out). ENOENT is success (already gone); any other
// error propagates — a stuck file must not leave owner privileges active while
// the UI claims the account was signed out.
export const clearSession = async (): Promise<void> => {
  await ensureOpenGroundHome()
  try {
    await unlink(authFile())
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(
        '[openground:auth] failed to clear session',
        err instanceof Error ? err.message : err,
      )
      throw new Error('Could not sign out')
    }
  }
}
