// roles.ts — role resolution for the custom-tab feature (docs/CUSTOM_TABS_PLAN.md).
//
// The SERVER decides who may manage custom tab modules; the client only mirrors
// the role for cosmetic gating. Identity comes from the persisted app-login
// session (authStore.readSession), never from anything the request carries.
//
// SOURCE OF TRUTH: the Supabase table `og_roles` (env SUPABASE_ROLES_TABLE to
// override). NOTHING identifying ships in this binary — there are deliberately
// NO default emails here; an install with no Supabase env and no role row
// resolves to 'none' and the feature stays invisible. The lookup runs with the
// signed-in user's OWN access token: RLS lets each account read only its own
// row (matched by auth uid OR the JWT email claim, so the owner can grant a
// role to an email before that account's first login). Writes to the table are
// service-role only (the owner, via dashboard/MCP) — this server never edits it.
//
//   OPENGROUND_OWNER_EMAILS / OPENGROUND_TESTER_EMAILS — optional comma-
//   separated env OVERRIDE (dev/test escape hatch, also the offline fallback
//   for the owner's own machine). When either is set, the remote lookup is
//   skipped entirely. Empty by default.
//
// Remote results are cached in-memory for 5 minutes per user id (on a
// globalThis singleton so `tsx watch` reloads keep it, like the terminal
// pool); a failed refresh serves the last known role rather than flickering
// the UI off, and resolves 'none' only when we have nothing better.

import { readSession } from './authStore'
import { readAuthConfig, getFreshAccessToken } from './supabaseAuth'
import type { CustomTabRole } from '../types'

// Parse a comma-separated allowlist env var. No fallback — unset/blank means
// "not configured", which is the shipped default.
const parseEmails = (raw: string | undefined): Set<string> =>
  new Set(
    (raw ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )

const envConfigured = (): boolean =>
  !!(
    process.env.OPENGROUND_OWNER_EMAILS?.trim() ||
    process.env.OPENGROUND_TESTER_EMAILS?.trim()
  )

const envRole = (email: string): CustomTabRole => {
  if (parseEmails(process.env.OPENGROUND_OWNER_EMAILS).has(email)) return 'owner'
  if (parseEmails(process.env.OPENGROUND_TESTER_EMAILS).has(email)) return 'tester'
  return 'none'
}

// --- Remote lookup (og_roles via the user's own JWT) ------------------------

const rolesTable = (): string =>
  process.env.SUPABASE_ROLES_TABLE?.trim() || 'og_roles'

const CACHE_TTL_MS = 5 * 60 * 1000

interface CachedRole {
  role: CustomTabRole
  at: number
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_custom_roles: Map<string, CachedRole> | undefined
}

const roleCache: Map<string, CachedRole> =
  globalThis.__openground_custom_roles ??
  (globalThis.__openground_custom_roles = new Map())

// RLS already scopes the SELECT to the caller's own row(s); a user may match
// twice (a user_id row and an email row), so prefer the strongest role.
const strongest = (rows: Array<{ role?: string }>): CustomTabRole => {
  if (rows.some((r) => r.role === 'owner')) return 'owner'
  if (rows.some((r) => r.role === 'tester')) return 'tester'
  return 'none'
}

const fetchRemoteRole = async (): Promise<CustomTabRole | null> => {
  const config = readAuthConfig()
  if (!config) return null
  const token = await getFreshAccessToken()
  if (!token) return null
  try {
    const res = await fetch(
      `${config.url}/rest/v1/${rolesTable()}?select=role`,
      {
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.error(`[openground:roles] lookup ${res.status}`)
      return null
    }
    const rows = (await res.json()) as Array<{ role?: string }>
    return strongest(Array.isArray(rows) ? rows : [])
  } catch (e) {
    console.error(
      '[openground:roles] lookup failed',
      e instanceof Error ? e.message : e,
    )
    return null
  }
}

// Resolve the caller's custom-tab role. Signed out → 'none'. Env override (when
// configured) decides without any network. Otherwise: fresh cache → remote
// lookup → stale cache → 'none'.
export const getCustomTabRole = async (): Promise<CustomTabRole> => {
  const session = await readSession()
  const userId = session?.user.id
  const email = session?.user.email?.trim().toLowerCase()
  if (!userId || !email) return 'none'

  if (envConfigured()) return envRole(email)

  const cached = roleCache.get(userId)
  if (cached && cached.at > Date.now() - CACHE_TTL_MS) return cached.role

  const remote = await fetchRemoteRole()
  if (remote !== null) {
    roleCache.set(userId, { role: remote, at: Date.now() })
    return remote
  }
  // Lookup unavailable (offline / unconfigured remote): serve the last known
  // role for this user rather than yanking the UI away mid-session.
  return cached?.role ?? 'none'
}
