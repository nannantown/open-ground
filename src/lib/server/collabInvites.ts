// collabInvites.ts — LINK-based self-join for realtime collab (Figma-style v2).
//
// The owner mints a secret, time-limited invite CODE (a row in og_project_invites,
// 7-day expiry — migrations 0007/0010). Each link carries a PERMISSION MODE:
//   * open     — any LOGGED-IN user with the code self-joins as a MEMBER at once.
//   * approval — opening the link files a PENDING request the owner approves from
//                the roster; nobody gains access until approved.
// A link may also be BOUNDED — `max_uses` (single-use / max-n) caps how far one
// link spreads; the project-level `member_cap` caps total collaborators. Both run
// through the join_with_invite / approve_join_request SECURITY DEFINER RPCs, which
// insert ONLY the caller / the named requester (uid/email from the JWT — they
// cannot add anyone else, pick the project, or escalate the role). Coexists with
// the email-invite path (upsertProjectMembers in projectMembers.ts).
//
// Everything runs with the signed-in user's OWN JWT — there is NO service-role key
// (the v2 / Cloudflare-DO model):
//   * MINT / LIST / REVOKE / RESET / member-cap / request-deny: the owner writes
//     og_project_invites / og_projects / og_project_join_requests under RLS (0007
//     "invites owner all", 0005 "og projects owner update", 0010 "join requests
//     owner …") — only the owner of the og_projects row. A non-owner's call
//     matches no allowed row → RLS no-op.
//   * REDEEM (joinWithInvite) / APPROVE (approveJoinRequest): authenticated callers
//     invoke the definer RPCs under their own JWT; login is enforced INSIDE the RPC.
//
// Best-effort + NEVER throws to the caller (mirrors projectMembers.ts): a
// non-owner / invalid-code / offline / unconfigured call is a quiet { ok:false }.

import { randomBytes } from 'node:crypto'
import { readAuthConfig, getFreshAccessToken } from './supabaseAuth'
import { clearMembershipCache } from './projectMembers'
import type {
  CollabInviteLinkItem,
  CollabInviteMode,
  CollabJoinRequestItem,
} from '../types'

const invitesTable = (): string =>
  process.env.SUPABASE_INVITES_TABLE?.trim() || 'og_project_invites'

const projectsTable = (): string =>
  process.env.SUPABASE_PROJECTS_TABLE?.trim() || 'og_projects'

const joinRequestsTable = (): string =>
  process.env.SUPABASE_JOIN_REQUESTS_TABLE?.trim() || 'og_project_join_requests'

// Caller-JWT auth context for a PostgREST write/RPC. Identical to projectMembers'
// internal ownerAuth, but kept local so this module doesn't widen that one's API
// surface. null when unconfigured / signed out (→ the operation is a no-op).
interface CallerAuth {
  url: string
  anonKey: string
  token: string
}

const callerAuth = async (): Promise<CallerAuth | null> => {
  try {
    const config = readAuthConfig()
    if (!config) return null
    const token = await getFreshAccessToken()
    if (!token) return null
    return { url: config.url, anonKey: config.anonKey, token }
  } catch {
    // getFreshAccessToken can reject on a token-refresh edge (network/disk). Honor
    // the never-throws contract — every helper awaits callerAuth() BEFORE its own
    // try block, so a throw here would escape as a 500 — treat it as signed-out.
    return null
  }
}

// Normalize an optional mode → a valid CollabInviteMode (default 'open').
const normMode = (mode?: string): CollabInviteMode =>
  mode === 'approval' ? 'approval' : 'open'

// Normalize an optional max-uses → a positive int, else null (unlimited).
const normMaxUses = (n?: number | null): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null

// Parse a PostgREST timestamptz → epoch ms, or undefined when absent/invalid.
const toEpoch = (raw: unknown): number | undefined => {
  if (typeof raw !== 'string' || !raw) return undefined
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : undefined
}

export interface CreateInviteOpts {
  mode?: CollabInviteMode
  /** Redemption cap (1 = single-use, n = max-n). Anything <1 / non-number = unlimited. */
  maxUses?: number | null
}

export interface CreateInviteResult {
  ok: boolean
  id?: string
  code?: string
  mode?: CollabInviteMode
  maxUses?: number | null
  expiresAt?: number
}

// The owner mints a secret invite code for a project they OWN. Generates a random
// 256-bit token, INSERTs the invite row with the chosen mode + bound (owner-JWT,
// RLS-gated), and returns the row back (id/token/mode/max_uses/expiry). The code IS
// the secret — only the owner can create/read it. Returns { ok:false } when
// unconfigured / signed out / the caller doesn't own the project (RLS no-op) / the
// insert fails. Never throws.
export const createInviteLink = async (
  collabProjectId: string,
  opts?: CreateInviteOpts,
): Promise<CreateInviteResult> => {
  if (!collabProjectId) return { ok: false }
  const auth = await callerAuth()
  if (!auth) return { ok: false }

  // 256-bit URL-safe secret. base64url so the code rides a URL / clipboard /
  // text field verbatim with no escaping.
  const code = randomBytes(32).toString('base64url')
  const mode = normMode(opts?.mode)
  const maxUses = normMaxUses(opts?.maxUses)

  try {
    const res = await fetch(`${auth.url}/rest/v1/${invitesTable()}`, {
      method: 'POST',
      headers: {
        apikey: auth.anonKey,
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        // Read the row back so we can return the DB-assigned id + 7-day expiry.
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        project_id: collabProjectId,
        token: code,
        mode,
        // Omit max_uses when unlimited so the DB default (null) applies.
        ...(maxUses !== null ? { max_uses: maxUses } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:invites] mint ${res.status}: ${detail}`)
      return { ok: false }
    }
    const rows = (await res.json()) as Array<{
      id?: string
      token?: string
      mode?: string
      max_uses?: number | null
      expires_at?: string
    }>
    const row = Array.isArray(rows) ? rows[0] : undefined
    if (!row?.token) return { ok: false }
    return {
      ok: true,
      id: row.id,
      code: row.token,
      mode: normMode(row.mode),
      maxUses: normMaxUses(row.max_uses),
      expiresAt: toEpoch(row.expires_at),
    }
  } catch (e) {
    console.error(
      '[openground:invites] mint failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}

// Revoke (delete) invite links for a project the caller OWNS. With no `inviteId`
// it deletes ALL outstanding links (project-wide eviction — the second half of
// removing a member, who could otherwise rejoin with an unexpired 7-day code).
// With an `inviteId` it deletes just THAT link (kill one leaked link, keep the
// rest). Owner-JWT DELETE under RLS (0007 "invites owner all") — a non-owner
// matches no rows it may touch, so it's a silent no-op. Returns { ok:false } when
// unconfigured / signed out / the delete fails; { ok:true } on success (including
// 0 rows). Never throws.
export const revokeProjectInvites = async (
  collabProjectId: string,
  inviteId?: string,
): Promise<{ ok: boolean }> => {
  if (!collabProjectId) return { ok: false }
  const auth = await callerAuth()
  if (!auth) return { ok: false }
  try {
    // Always scope by project_id (RLS-redundant, but keeps a per-id delete from
    // ever touching another project's row even under a future looser policy).
    let url = `${auth.url}/rest/v1/${invitesTable()}?project_id=eq.${encodeURIComponent(
      collabProjectId,
    )}`
    if (inviteId) url += `&id=eq.${encodeURIComponent(inviteId)}`
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        apikey: auth.anonKey,
        Authorization: `Bearer ${auth.token}`,
        Prefer: 'return=minimal',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:invites] revoke ${res.status}: ${detail}`)
      return { ok: false }
    }
    return { ok: true }
  } catch (e) {
    console.error(
      '[openground:invites] revoke failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}

// Reset the link: mint a FRESH link, then revoke every OTHER link for the project.
// Minting first means there is never a window with zero valid links (the new one
// exists before the old ones die); an in-flight redemption of an old code either
// lands before the revoke or fails closed after it. Returns the new link (same
// shape as createInviteLink). On a mint failure NOTHING is revoked (we never leave
// the owner with no link). Never throws.
export const resetInviteLinks = async (
  collabProjectId: string,
  opts?: CreateInviteOpts,
): Promise<CreateInviteResult> => {
  const minted = await createInviteLink(collabProjectId, opts)
  if (!minted.ok || !minted.id) return { ok: false }
  // Best-effort: delete all links for the project EXCEPT the one we just minted.
  const auth = await callerAuth()
  if (auth) {
    try {
      await fetch(
        `${auth.url}/rest/v1/${invitesTable()}?project_id=eq.${encodeURIComponent(
          collabProjectId,
        )}&id=neq.${encodeURIComponent(minted.id)}`,
        {
          method: 'DELETE',
          headers: {
            apikey: auth.anonKey,
            Authorization: `Bearer ${auth.token}`,
            Prefer: 'return=minimal',
          },
          signal: AbortSignal.timeout(10_000),
        },
      )
    } catch (e) {
      // The new link is live regardless; a failed sweep just leaves old links
      // around (the owner can revoke-all). Don't fail the reset over it.
      console.error(
        '[openground:invites] reset sweep failed',
        e instanceof Error ? e.message : e,
      )
    }
  }
  return minted
}

// List the OWNER's live invite links (metadata only — the raw token is NEVER
// returned, only the id needed to revoke each). Owner-JWT read under RLS ("invites
// owner all" also gates SELECT). Returns [] when unconfigured / signed out / not
// the owner / the read fails. Never throws.
export const listInviteLinks = async (
  collabProjectId: string,
): Promise<CollabInviteLinkItem[]> => {
  if (!collabProjectId) return []
  const auth = await callerAuth()
  if (!auth) return []
  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${invitesTable()}?project_id=eq.${encodeURIComponent(
        collabProjectId,
      )}&select=id,mode,max_uses,use_count,expires_at,created_at&order=created_at.desc`,
      {
        headers: { apikey: auth.anonKey, Authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.error(`[openground:invites] list links ${res.status}`)
      return []
    }
    const rows = (await res.json()) as unknown
    if (!Array.isArray(rows)) return []
    const out: CollabInviteLinkItem[] = []
    for (const r of rows as Array<{
      id?: unknown
      mode?: unknown
      max_uses?: unknown
      use_count?: unknown
      expires_at?: unknown
      created_at?: unknown
    }>) {
      if (typeof r.id !== 'string' || !r.id) continue
      out.push({
        id: r.id,
        mode: normMode(typeof r.mode === 'string' ? r.mode : undefined),
        maxUses: normMaxUses(typeof r.max_uses === 'number' ? r.max_uses : null),
        useCount: typeof r.use_count === 'number' ? r.use_count : 0,
        expiresAt: toEpoch(r.expires_at),
        createdAt: toEpoch(r.created_at),
      })
    }
    return out
  } catch (e) {
    console.error(
      '[openground:invites] list links failed',
      e instanceof Error ? e.message : e,
    )
    return []
  }
}

// Read the project-level collaborator cap (og_projects.member_cap). Owner/member
// can read the row (RLS "og projects read"); the value is null when unset /
// unlimited. Returns null when unconfigured / signed out / unset / the read fails.
// Never throws.
export const getProjectMemberCap = async (
  collabProjectId: string,
): Promise<number | null> => {
  if (!collabProjectId) return null
  const auth = await callerAuth()
  if (!auth) return null
  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${projectsTable()}?id=eq.${encodeURIComponent(
        collabProjectId,
      )}&select=member_cap&limit=1`,
      {
        headers: { apikey: auth.anonKey, Authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.error(`[openground:invites] get cap ${res.status}`)
      return null
    }
    const rows = (await res.json()) as Array<{ member_cap?: unknown }>
    const cap = Array.isArray(rows) ? rows[0]?.member_cap : undefined
    return typeof cap === 'number' && cap >= 1 ? Math.floor(cap) : null
  } catch (e) {
    console.error(
      '[openground:invites] get cap failed',
      e instanceof Error ? e.message : e,
    )
    return null
  }
}

// Set (or clear, with null) the project-level collaborator cap. Owner-JWT PATCH
// under RLS (0005 "og projects owner update") — a non-owner's PATCH matches no
// allowed row. Like setProjectLabel, the only caller is owner-gated AND resolves
// the project from the caller's OWN registered path, so a 204 here is trustworthy.
// Returns { ok:false } when unconfigured / signed out / the update fails. Never throws.
export const setProjectMemberCap = async (
  collabProjectId: string,
  cap: number | null,
): Promise<{ ok: boolean }> => {
  if (!collabProjectId) return { ok: false }
  const auth = await callerAuth()
  if (!auth) return { ok: false }
  const value = typeof cap === 'number' && cap >= 1 ? Math.floor(cap) : null
  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${projectsTable()}?id=eq.${encodeURIComponent(
        collabProjectId,
      )}`,
      {
        method: 'PATCH',
        headers: {
          apikey: auth.anonKey,
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ member_cap: value }),
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:invites] set cap ${res.status}: ${detail}`)
      return { ok: false }
    }
    return { ok: true }
  } catch (e) {
    console.error(
      '[openground:invites] set cap failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}

// List a project's PENDING join requests for the owner's approval queue. Owner-JWT
// read under RLS (0010 "join requests owner select"). Returns [] when unconfigured
// / signed out / not the owner / the read fails. Never throws.
export const listJoinRequests = async (
  collabProjectId: string,
): Promise<CollabJoinRequestItem[]> => {
  if (!collabProjectId) return []
  const auth = await callerAuth()
  if (!auth) return []
  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${joinRequestsTable()}?project_id=eq.${encodeURIComponent(
        collabProjectId,
      )}&status=eq.pending&select=id,email,created_at&order=created_at.asc`,
      {
        headers: { apikey: auth.anonKey, Authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.error(`[openground:invites] list requests ${res.status}`)
      return []
    }
    const rows = (await res.json()) as unknown
    if (!Array.isArray(rows)) return []
    const out: CollabJoinRequestItem[] = []
    for (const r of rows as Array<{ id?: unknown; email?: unknown; created_at?: unknown }>) {
      if (typeof r.id !== 'string' || !r.id) continue
      out.push({
        id: r.id,
        email: typeof r.email === 'string' ? r.email : '',
        createdAt: toEpoch(r.created_at),
      })
    }
    return out
  } catch (e) {
    console.error(
      '[openground:invites] list requests failed',
      e instanceof Error ? e.message : e,
    )
    return []
  }
}

// Approve a pending join request → enrol the requester as a member (cap-checked).
// Calls the approve_join_request SECURITY DEFINER RPC (0010), which itself verifies
// the caller OWNS the request's project. On success invalidates this project's
// membership cache (the new member's negative cache, if any, should drop). Returns
// { ok:false } for a non-owner / cap-full / unconfigured / signed out / RPC raise.
// Never throws.
export const approveJoinRequest = async (
  collabProjectId: string,
  requestId: string,
): Promise<{ ok: boolean }> => {
  if (!requestId) return { ok: false }
  const auth = await callerAuth()
  if (!auth) return { ok: false }
  try {
    const res = await fetch(`${auth.url}/rest/v1/rpc/approve_join_request`, {
      method: 'POST',
      headers: {
        apikey: auth.anonKey,
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ request_id: requestId }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:invites] approve ${res.status}: ${detail}`)
      return { ok: false }
    }
    if (collabProjectId) clearMembershipCache(collabProjectId)
    return { ok: true }
  } catch (e) {
    console.error(
      '[openground:invites] approve failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}

// Deny a pending join request → delete the request row. Owner-JWT DELETE under RLS
// (0010 "join requests owner delete"); scoped by project_id too (defense-in-depth).
// Returns { ok:false } when unconfigured / signed out / the delete fails. Never throws.
export const denyJoinRequest = async (
  collabProjectId: string,
  requestId: string,
): Promise<{ ok: boolean }> => {
  if (!requestId) return { ok: false }
  const auth = await callerAuth()
  if (!auth) return { ok: false }
  try {
    let url = `${auth.url}/rest/v1/${joinRequestsTable()}?id=eq.${encodeURIComponent(
      requestId,
    )}`
    if (collabProjectId) url += `&project_id=eq.${encodeURIComponent(collabProjectId)}`
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        apikey: auth.anonKey,
        Authorization: `Bearer ${auth.token}`,
        Prefer: 'return=minimal',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:invites] deny ${res.status}: ${detail}`)
      return { ok: false }
    }
    return { ok: true }
  } catch (e) {
    console.error(
      '[openground:invites] deny failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}

// A logged-in user redeems an invite code via the join_with_invite RPC (SECURITY
// DEFINER; inserts ONLY the caller). The RPC branches on the link's mode and
// returns jsonb { project_id, status } where status is 'joined' (open: now a
// member — open the room) or 'pending' (approval: a request was filed — await the
// owner). On success returns the collabProjectId + status and invalidates that
// project's membership cache (the caller was likely cached as a non-member).
// Returns { ok:false } for an invalid/expired/exhausted code, signed out, or
// unconfigured. Never throws. We deliberately surface only a GENERIC reason to the
// client (the specific raise — "invalid" vs "expired" vs "exhausted" — is logged
// server-side but not echoed, to avoid leaking which codes exist).
export const joinWithInvite = async (
  code: string,
): Promise<{
  ok: boolean
  collabProjectId?: string
  status?: 'joined' | 'pending'
  error?: string
}> => {
  const token = code?.trim()
  if (!token) return { ok: false, error: 'no code' }
  // A real invite code is a 43-char base64url secret; cap defensively so a
  // pathological body never reaches PostgREST (the deep-link parser caps too).
  if (token.length > 512) return { ok: false, error: 'invalid or expired invite' }
  const auth = await callerAuth()
  if (!auth) return { ok: false, error: 'not signed in' }

  try {
    const res = await fetch(`${auth.url}/rest/v1/rpc/join_with_invite`, {
      method: 'POST',
      headers: {
        apikey: auth.anonKey,
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ invite_token: token }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      // The RPC RAISEs for a missing/expired/exhausted token → PostgREST 400 with a
      // JSON error body. Log the detail; tell the client a single generic reason.
      const detail = await res.text().catch(() => '')
      console.error(`[openground:invites] join ${res.status}: ${detail}`)
      return { ok: false, error: 'invalid or expired invite' }
    }
    // v2 RPC renders jsonb { project_id, status }; the legacy 0007/0008 RPC rendered
    // a bare uuid STRING (= an immediate join). Accept BOTH so a client running
    // ahead of the migration still works.
    const body = (await res.json()) as unknown
    let collabProjectId: string | undefined
    let status: 'joined' | 'pending' = 'joined'
    if (typeof body === 'string' && body) {
      collabProjectId = body
    } else if (body && typeof body === 'object') {
      const o = body as { project_id?: unknown; status?: unknown }
      if (typeof o.project_id === 'string' && o.project_id) collabProjectId = o.project_id
      if (o.status === 'pending') status = 'pending'
    }
    if (!collabProjectId) return { ok: false, error: 'invalid or expired invite' }
    // The caller is now a member (joined) or has a pending request; either way drop
    // any cached negative so the next getMyMembership re-resolves cleanly.
    clearMembershipCache(collabProjectId)
    return { ok: true, collabProjectId, status }
  } catch (e) {
    console.error(
      '[openground:invites] join failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false, error: 'join failed' }
  }
}
