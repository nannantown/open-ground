// Membership resolution for the zero-config collab Worker auth layer (step 2).
//
// After jwt.ts proves WHO the caller is, this confirms they may join project
// `pid` and resolves their ROLE — by reading og_project_members through Supabase
// PostgREST under the CALLER'S OWN JWT, so RLS does the authorization (exactly
// like src/lib/server/projectMembers.ts, but in the Worker). No service-role key.
//
// RLS NUANCE (migration 0005 "og members read roster", final state after 0006):
// a MEMBER's SELECT returns the WHOLE roster (every row of the project); a
// NON-member's SELECT is denied → empty. So:
//   * empty result        ⇒ not a member          → null (the route 403s)
//   * non-empty result     ⇒ caller IS a member
// To read the caller's OWN role we then filter the roster to their row(s) by uid
// OR (lowercased) email — the same identity match the RLS helper og_is_member
// uses. This is correct under BOTH the roster-wide policy (we isolate the caller
// from the full roster) and a hypothetical self-scoped policy (the filter is a
// no-op). Taking the strongest matching role (owner > member) mirrors
// projectMembers.ts' `strongest`; a member we can't isolate falls to the LEAST
// privilege ('member') rather than guessing 'owner'.

import type { VerifiedJwt } from './jwt'

export type Role = 'owner' | 'member'

export interface MembershipEnv {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
}

interface MemberRow {
  user_id?: string | null
  email?: string | null
  role?: string
}

const normalizeUrl = (u: string): string => u.replace(/\/+$/, '')
const MEMBERS_TABLE = 'og_project_members'

/**
 * Resolve the caller's membership role for `pid`, or null when they are NOT a
 * member (also null on any unconfigured / network / non-OK / malformed case —
 * fail CLOSED). Never throws.
 *
 * @param env       SUPABASE_URL + SUPABASE_ANON_KEY (both required)
 * @param rawToken  the caller's Supabase JWT (sent as the Bearer for RLS)
 * @param pid       collabProjectId (og_projects.id)
 * @param identity  the verified caller identity (sub/email) from verifySupabaseJwt
 */
export async function resolveMembership(
  env: MembershipEnv,
  rawToken: string,
  pid: string,
  identity: VerifiedJwt,
): Promise<Role | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null
  const baseUrl = normalizeUrl(env.SUPABASE_URL)

  let rows: MemberRow[]
  try {
    const res = await fetch(
      `${baseUrl}/rest/v1/${MEMBERS_TABLE}?project_id=eq.${encodeURIComponent(
        pid,
      )}&select=user_id,email,role`,
      {
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${rawToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    if (!Array.isArray(body)) return null
    rows = body as MemberRow[]
  } catch {
    return null
  }

  // Empty ⇒ RLS denied the read (or genuinely no rows) ⇒ not a member.
  if (rows.length === 0) return null

  // Isolate the caller's own row(s) from the (possibly roster-wide) result.
  const email = identity.email?.toLowerCase()
  const own = rows.filter(
    (r) =>
      (!!r.user_id && r.user_id === identity.sub) ||
      (!!r.email && !!email && r.email.toLowerCase() === email),
  )
  // Member confirmed by RLS but no self-row isolated (data quirk): least privilege.
  if (own.length === 0) return 'member'
  return own.some((r) => r.role === 'owner') ? 'owner' : 'member'
}
