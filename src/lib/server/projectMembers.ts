// projectMembers.ts — who may join a project's realtime-collab channel.
//
// The SERVER decides membership; the client only mirrors it to gate the collab
// UI. Identity comes from the persisted app-login session's OWN access token
// (getFreshAccessToken), never from anything the request carries — exactly the
// posture of roles.ts (docs/CUSTOM_TABS_PLAN.md). This is plain logic with no
// Hono imports, like roles.ts.
//
// SOURCE OF TRUTH: the Supabase tables `og_projects` (the canonical project row;
// its id IS the collabProjectId) + `og_project_members` (the roster). EVERYTHING
// runs with the signed-in user's OWN JWT — there is NO service-role key in the
// collab path anymore (the v2 / Cloudflare-DO model, migration 0005):
//   * READ  (getMyMembership): RLS returns the caller's own row(s) for a project
//     (matched by auth uid OR the JWT email claim, so an owner can seed a member
//     by email before that account's first login).
//   * WRITE (ensureOwnProject / upsertProjectMembers / removeProjectMember): the
//     project OWNER mutates og_projects + og_project_members directly under RLS
//     with their own JWT. The owner-INSERT/DELETE policies in 0005 permit only
//     the owner of the og_projects row, so a non-owner's calls are RLS no-ops.
//
//   OPENGROUND_COLLAB_MEMBER_PROJECTS — optional comma-separated env OVERRIDE
//   (dev/test escape hatch): a list of collabProjectIds the local user is
//   force-considered a member of. When a queried id is on the list the remote
//   lookup is skipped entirely. Empty by default — the shipped build identifies
//   no one.
//
// IDS: the id here is the cross-user "collabProjectId" = og_projects.id, NOT the
// local registry UUID.
//
// Remote READ results are cached in-memory for 5 minutes per collabProjectId (on
// a globalThis singleton so `tsx watch` reloads keep it, like the terminal pool);
// a failed refresh serves the last known membership rather than flickering the
// collab UI off, and resolves null only when we have nothing better.

import { createHash } from 'node:crypto'
import { readAuthConfig, getFreshAccessToken } from './supabaseAuth'
import { readSession } from './authStore'
import type { CollabInviteForMe, ProjectMember } from '../types'

// --- Env override -----------------------------------------------------------
// Parse the comma list of collabProjectIds. No fallback — unset/blank means
// "not configured", the shipped default. Trimmed but NOT lowercased: these are
// opaque ids (uuids), compared verbatim.
const parseIds = (raw: string | undefined): Set<string> =>
  new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

const envMemberOf = (collabProjectId: string): boolean =>
  parseIds(process.env.OPENGROUND_COLLAB_MEMBER_PROJECTS).has(collabProjectId)

// --- In-memory cache (per collabProjectId, survives tsx-watch reloads) -------

const membersTable = (): string =>
  process.env.SUPABASE_MEMBERS_TABLE?.trim() || 'og_project_members'

const projectsTable = (): string =>
  process.env.SUPABASE_PROJECTS_TABLE?.trim() || 'og_projects'

// The self-join invite-code table (migrations 0007/0010). Resolved the same way
// collabInvites.ts does, so removeProjectMember can rotate a project's links on
// eviction without importing that module (which would create a cycle — it imports
// clearMembershipCache from here).
const invitesTable = (): string =>
  process.env.SUPABASE_INVITES_TABLE?.trim() || 'og_project_invites'

const CACHE_TTL_MS = 5 * 60 * 1000

interface CachedMembership {
  // null = looked up and the caller is NOT a member (cached briefly too, like
  // roles.ts caches 'none', so a non-member doesn't re-hit the network).
  member: ProjectMember | null
  at: number
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_project_members: Map<string, CachedMembership> | undefined
  // Single-flight map for findOrCreateOwnProject (see its definition below): in-
  // flight resolve-or-create promises keyed by `${ownerId}\n${canonicalPath}`.
  // eslint-disable-next-line no-var
  var __openground_project_resolve:
    | Map<string, Promise<string | null>>
    | undefined
}

const memberCache: Map<string, CachedMembership> =
  globalThis.__openground_project_members ??
  (globalThis.__openground_project_members = new Map())

// Cache key = `${userId}\n${collabProjectId}`. Membership is a per-USER fact, so
// the cache MUST be scoped by the signed-in user — keying by collabProjectId
// ALONE let a different account (after a sign-out / account switch on the same
// machine) read the previous user's cached membership within the TTL, which is a
// cross-account access leak. This mirrors roles.ts (its role cache is keyed by
// user id). '\n' can't appear in a uuid, so it is an unambiguous separator —
// the same convention findOrCreateOwnProject's resolveInFlight key uses below,
// and the suffix clearMembershipCache matches on.
const membershipCacheKey = (userId: string, collabProjectId: string): string =>
  `${userId}\n${collabProjectId}`

// Coalesces concurrent findOrCreateOwnProject calls for the SAME (owner, path)
// onto one promise so duplicate project rows can't be minted by a burst of
// simultaneous collab-scope opens. On globalThis so a tsx-watch reload keeps it,
// exactly like memberCache / the terminal pool.
const resolveInFlight: Map<string, Promise<string | null>> =
  globalThis.__openground_project_resolve ??
  (globalThis.__openground_project_resolve = new Map())

// Clear the cache (tests / after a write that changes membership). With no arg
// clears everything; with an id clears that project's entry for EVERY cached
// user. Entries are keyed `${userId}\n${collabProjectId}` (see membershipCacheKey
// above), so a roster change for one project — which can affect any cached
// viewer of it — drops all matching entries by the trailing-separator suffix
// (unambiguous: uuids hold no '\n'). A sign-out passes no arg to drop everything.
export const clearMembershipCache = (collabProjectId?: string): void => {
  if (collabProjectId === undefined) {
    memberCache.clear()
    return
  }
  const suffix = `\n${collabProjectId}`
  for (const key of Array.from(memberCache.keys())) {
    if (key.endsWith(suffix)) memberCache.delete(key)
  }
}

// --- REST row → ProjectMember ----------------------------------------------

interface MemberRow {
  project_id?: string
  user_id?: string | null
  email?: string | null
  role?: string
  status?: string | null
}

const toRole = (raw: string | undefined): ProjectMember['role'] =>
  raw === 'owner' ? 'owner' : 'member'

// Acceptance state (og_project_members.status, migration 0013). A missing/unknown
// value resolves to 'accepted' — every pre-0013 row predates the column, and the
// SAFE default is "full member" (a transitional NULL must NOT silently downgrade a
// real collaborator to no-access; only an explicit 'pending' gates access).
const toStatus = (raw: string | null | undefined): ProjectMember['status'] =>
  raw === 'pending' ? 'pending' : 'accepted'

// Does a row grant ACCESS right now? An owner always does; a member only once
// accepted. A 'pending' email invite does NOT (pre-confirmed identity, zero access
// until they accept). This is the single predicate every access gate shares.
const grantsAccess = (row: { role?: string; status?: string | null }): boolean =>
  row.role === 'owner' || toStatus(row.status) === 'accepted'

// Parse a PostgREST timestamptz → epoch ms, or undefined when absent/invalid.
const toEpoch = (raw: unknown): number | undefined => {
  if (typeof raw !== 'string' || !raw) return undefined
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : undefined
}

const toMember = (row: MemberRow, collabProjectId: string): ProjectMember => ({
  // Prefer the row's project_id, but fall back to the queried id (the row is
  // already scoped to it by the eq filter + RLS) so the shape is always sound.
  projectId: row.project_id ?? collabProjectId,
  userId: row.user_id ?? undefined,
  email: row.email ?? undefined,
  role: toRole(row.role),
  status: toStatus(row.status),
})

// RLS scopes the SELECT to the caller's own row(s); a user may match twice (a
// user_id row AND an email row), so prefer the strongest. This resolves the
// caller's ACCESS membership, so a still-PENDING email invite is NOT a member
// here (it grants no access) — only owner / accepted rows count. Returns null when
// the caller has no access-granting row (signed in but only a pending invite, or
// genuinely not on the roster).
const strongest = (
  rows: MemberRow[],
  collabProjectId: string,
): ProjectMember | null => {
  const accessible = rows.filter(grantsAccess)
  if (accessible.length === 0) return null
  const owner = accessible.find((r) => r.role === 'owner')
  return toMember(owner ?? accessible[0], collabProjectId)
}

const fetchRemoteMembership = async (
  collabProjectId: string,
): Promise<ProjectMember | null | undefined> => {
  // undefined = lookup unavailable (unconfigured / signed-out / network error)
  // → the caller serves stale cache. null = looked up, not a member.
  const config = readAuthConfig()
  if (!config) return undefined
  const token = await getFreshAccessToken()
  if (!token) return undefined
  try {
    const res = await fetch(
      `${config.url}/rest/v1/${membersTable()}?project_id=eq.${encodeURIComponent(
        collabProjectId,
      )}&select=*`,
      {
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.error(`[openground:members] lookup ${res.status}`)
      return undefined
    }
    const rows = (await res.json()) as unknown
    return strongest(Array.isArray(rows) ? (rows as MemberRow[]) : [], collabProjectId)
  } catch (e) {
    console.error(
      '[openground:members] lookup failed',
      e instanceof Error ? e.message : e,
    )
    return undefined
  }
}

// Resolve the caller's membership of a collab project. Resolution chain mirrors
// roles.ts: session gate → env override → fresh cache → remote lookup → stale
// cache → null. Unconfigured / signed-out → null; the cache is per-user, so an
// account switch never inherits the prior user's answer.
export const getMyMembership = async (
  collabProjectId: string,
): Promise<ProjectMember | null> => {
  if (!collabProjectId) return null

  // Identity gate FIRST, exactly like roles.ts getCustomTabRole: membership is a
  // per-USER fact, so resolve it against the signed-in session. Signed out → not
  // a member, full stop (no env override, no cache, no network). This closes the
  // sign-out / account-switch leak two ways: a different account can never reach
  // the previous user's cached entry (the cache is keyed by userId below), and a
  // signed-out caller is rejected before a still-fresh cached entry is ever read.
  const session = await readSession()
  const userId = session?.user.id
  if (!userId) return null

  if (envMemberOf(collabProjectId)) {
    // The dev/test override force-grants membership → an ACCEPTED member.
    return { projectId: collabProjectId, role: 'member', status: 'accepted' }
  }

  const cacheKey = membershipCacheKey(userId, collabProjectId)
  const cached = memberCache.get(cacheKey)
  if (cached && cached.at > Date.now() - CACHE_TTL_MS) return cached.member

  const remote = await fetchRemoteMembership(collabProjectId)
  if (remote !== undefined) {
    memberCache.set(cacheKey, { member: remote, at: Date.now() })
    return remote
  }
  // Lookup unavailable (offline / unconfigured / signed out): serve the last
  // known membership rather than yanking the collab UI away mid-session — BUT
  // fail CLOSED for revocation. If the cached entry is older than 2x the TTL we
  // can no longer trust a stale POSITIVE (a removed member would otherwise keep
  // collab forever while offline), so drop it and resolve null. Fresh-enough
  // cache (≤ 2x TTL) is still served to ride out a brief network blip.
  if (cached && cached.at <= Date.now() - 2 * CACHE_TTL_MS) return null
  return cached?.member ?? null
}

// Convenience predicate.
export const isMyProject = async (collabProjectId: string): Promise<boolean> =>
  !!(await getMyMembership(collabProjectId))

// List the FULL roster of a project (every og_project_members row) for the owner's
// "Collaborators" UI. RLS (0005 "og members read roster": private.og_is_member)
// lets any MEMBER read all rows of a project they belong to, so this returns the
// whole roster — under the caller's own JWT (no service-role). Returns [] when
// unconfigured / signed out / not a member / the lookup fails. Never throws.
export const listProjectMembers = async (
  collabProjectId: string,
): Promise<ProjectMember[]> => {
  if (!collabProjectId) return []
  const auth = await ownerAuth()
  if (!auth) return []
  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${membersTable()}?project_id=eq.${encodeURIComponent(
        collabProjectId,
      )}&select=*`,
      {
        headers: { apikey: auth.anonKey, Authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.error(`[openground:members] list roster ${res.status}`)
      return []
    }
    const rows = (await res.json()) as unknown
    if (!Array.isArray(rows)) return []
    return (rows as MemberRow[]).map((r) => toMember(r, collabProjectId))
  } catch (e) {
    console.error(
      '[openground:members] list roster failed',
      e instanceof Error ? e.message : e,
    )
    return []
  }
}

// List every og_projects row the caller can READ — owner OR member. RLS (0005
// "og projects read": owner_id = self OR private.og_is_member(id)) does the
// filtering, so this returns exactly the projects the signed-in user is allowed
// to see. Member-flow groundwork: a future "shared with me" UI lists these so an
// INVITED member (who has no local folder for the project, hence no path to
// resolve) can still discover + open a shared project by its collabProjectId.
//
// `name` is the OPAQUE per-owner dedup hash for owned rows (never a real path);
// it is returned as-is so callers don't choke on the shape, but it is NOT a
// human label and the UI must not render it. Returns [] when unconfigured /
// signed out / the lookup fails. Never throws.
export const listMyProjects = async (): Promise<
  Array<{ id: string; label?: string; owned: boolean }>
> => {
  const auth = await ownerAuth()
  if (!auth) return []
  // The caller's uid/email decide `owned` (owner_id == self) and which shared
  // rooms they may OPEN. RLS lets a member read owner_id + the whole roster of a
  // project they belong to, so this is sound for both roles.
  const session = await readSession()
  const myUid = session?.user.id
  const myEmail = session?.user.email?.trim().toLowerCase()
  const isMine = (r: MemberRow): boolean =>
    (!!myUid && r.user_id === myUid) ||
    (!!myEmail && !!r.email && r.email.toLowerCase() === myEmail)
  try {
    const headers = { apikey: auth.anonKey, Authorization: `Bearer ${auth.token}` }
    // Two reads: the projects I can SEE (owner OR any member, incl. a pending
    // invite — RLS "og projects read" is membership-by-existence) AND my roster
    // rows (to learn my ACCEPTANCE status per project). A pending email invite is
    // readable here but must NOT surface as an openable shared card until accepted,
    // so a non-owned project is included ONLY when I hold an access-granting
    // (accepted) row — otherwise it lives in the お知らせ bell, not on the Ground.
    const [projRes, rosterRes] = await Promise.all([
      fetch(`${auth.url}/rest/v1/${projectsTable()}?select=id,label,owner_id`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(
        `${auth.url}/rest/v1/${membersTable()}?select=project_id,user_id,email,role,status`,
        { headers, signal: AbortSignal.timeout(10_000) },
      ),
    ])
    if (!projRes.ok || !rosterRes.ok) {
      console.error(`[openground:members] list projects ${projRes.status}/${rosterRes.status}`)
      return []
    }
    const rows = (await projRes.json()) as unknown
    const rosterRows = (await rosterRes.json()) as unknown
    if (!Array.isArray(rows)) return []
    // Project ids where I hold an access-granting (accepted/owner) membership row.
    const accessibleIds = new Set<string>()
    if (Array.isArray(rosterRows)) {
      for (const r of rosterRows as MemberRow[]) {
        const pid = typeof r.project_id === 'string' ? r.project_id : ''
        if (pid && isMine(r) && grantsAccess(r)) accessibleIds.add(pid)
      }
    }
    const out: Array<{ id: string; label?: string; owned: boolean }> = []
    for (const r of rows as Array<{ id?: unknown; label?: unknown; owner_id?: unknown }>) {
      if (typeof r.id !== 'string' || !r.id) continue
      // owned only when we positively know the caller's uid AND it matches; a
      // missing uid falls CLOSED to owned:false (treated as shared, never the
      // reverse — owned cards are the privileged local ones).
      const owned = !!myUid && r.owner_id === myUid
      // A shared (non-owned) project shows as a card ONLY once I've accepted —
      // a pending invite is surfaced via the bell, not here.
      if (!owned && !accessibleIds.has(r.id)) continue
      const item: { id: string; label?: string; owned: boolean } = { id: r.id, owned }
      // `label` is the owner-set, member-visible display name (the opaque
      // dedup hash in `name` is never sent to the client).
      if (typeof r.label === 'string' && r.label) item.label = r.label
      out.push(item)
    }
    return out
  } catch (e) {
    console.error(
      '[openground:members] list projects failed',
      e instanceof Error ? e.message : e,
    )
    return []
  }
}

// List the SIGNED-IN user's pending collab INVITES: every project shared WITH
// them that they do NOT own (the first in-app notification source — the Ground
// お知らせ bell). Read entirely under the caller's OWN JWT — RLS ("og members
// read roster": private.og_is_member) returns only the rosters of projects the
// caller belongs to (matched by uid OR JWT email), so a caller can ONLY ever see
// invites addressed to themselves; "for me" is enforced by the database, never a
// query param. Two reads joined in memory:
//   1) og_project_members (all my rosters) → my role per project, the OWNER row's
//      email (the inviter) and my invite row's created_at.
//   2) og_projects (id,label,owner_id) → the member-visible label + the
//      authoritative owner check (so a project I own is excluded as "not an invite").
// Returns [] when unconfigured / signed out / I have none / the read fails. Never throws.
export const listInvitesForMe = async (): Promise<CollabInviteForMe[]> => {
  const auth = await ownerAuth()
  if (!auth) return []
  const session = await readSession()
  const myUid = session?.user.id
  const myEmail = session?.user.email?.trim().toLowerCase()
  // Without an identity we can't tell "mine" from "someone else's" row — bail
  // (RLS would scope reads anyway, but this also avoids a pointless round-trip).
  if (!myUid && !myEmail) return []

  // Does a roster row belong to ME? (uid match OR case-insensitive email match —
  // the same dual identity RLS / og_is_member use, so an email-only invite seeded
  // before that account's first login still resolves.)
  const isMine = (r: { user_id?: string | null; email?: string | null }): boolean =>
    (!!myUid && r.user_id === myUid) ||
    (!!myEmail && !!r.email && r.email.toLowerCase() === myEmail)

  try {
    const headers = { apikey: auth.anonKey, Authorization: `Bearer ${auth.token}` }
    const [rosterRes, projRes] = await Promise.all([
      fetch(`${auth.url}/rest/v1/${membersTable()}?select=project_id,user_id,email,role,status,created_at`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(`${auth.url}/rest/v1/${projectsTable()}?select=id,label,owner_id`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
    ])
    if (!rosterRes.ok || !projRes.ok) {
      console.error(`[openground:members] invites lookup ${rosterRes.status}/${projRes.status}`)
      return []
    }
    const rosterRows = (await rosterRes.json()) as unknown
    const projRows = (await projRes.json()) as unknown
    if (!Array.isArray(rosterRows) || !Array.isArray(projRows)) return []

    // Group roster rows by project_id so each project's owner row + my row are
    // resolvable without an O(n²) scan.
    type Row = MemberRow & { created_at?: string }
    const byProject = new Map<string, Row[]>()
    for (const r of rosterRows as Row[]) {
      const pid = typeof r.project_id === 'string' ? r.project_id : ''
      if (!pid) continue
      const list = byProject.get(pid)
      if (list) list.push(r)
      else byProject.set(pid, [r])
    }

    const invites: CollabInviteForMe[] = []
    for (const p of projRows as Array<{ id?: unknown; label?: unknown; owner_id?: unknown }>) {
      const pid = typeof p.id === 'string' ? p.id : ''
      if (!pid) continue
      // Skip projects I OWN — they're mine, not an invite (authoritative
      // og_projects.owner_id check).
      if (myUid && p.owner_id === myUid) continue
      const roster = byProject.get(pid) ?? []
      const myRow = roster.find(isMine)
      // Only surface it if I'm actually on the roster as a NON-owner. (RLS already
      // guarantees I can only read rosters I belong to — this is belt-and-braces.)
      if (!myRow || toRole(myRow.role) === 'owner') continue
      // An INVITE is a still-PENDING row. Once accepted, the project moves out of
      // the お知らせ bell and onto the Ground as a shared card (listMyProjects), so
      // a joined collaborator stops being nagged to "join" what they already joined.
      if (toStatus(myRow.status) !== 'pending') continue
      const ownerRow = roster.find((r) => r.role === 'owner')
      invites.push({
        collabProjectId: pid,
        label: typeof p.label === 'string' && p.label ? p.label : null,
        inviterEmail: ownerRow?.email ? ownerRow.email : null,
        invitedAt: toEpoch(myRow.created_at),
      })
    }
    // Newest invite first (undated rows sort last).
    invites.sort((a, b) => (b.invitedAt ?? 0) - (a.invitedAt ?? 0))
    return invites
  } catch (e) {
    console.error(
      '[openground:members] invites lookup failed',
      e instanceof Error ? e.message : e,
    )
    return []
  }
}

// Read a project's member-visible SHARED NAME (og_projects.label). Caller-JWT
// read — RLS ("og projects read") returns the row to the owner OR any member, so
// both the owner's invite dialog (pre-fill) and a future member's shared card can
// resolve it. Returns null when unconfigured / signed out / unset / the read
// fails. Never throws.
export const getProjectLabel = async (
  collabProjectId: string,
): Promise<string | null> => {
  if (!collabProjectId) return null
  const auth = await ownerAuth()
  if (!auth) return null
  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${projectsTable()}?id=eq.${encodeURIComponent(
        collabProjectId,
      )}&select=label&limit=1`,
      {
        headers: {
          apikey: auth.anonKey,
          Authorization: `Bearer ${auth.token}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.error(`[openground:members] get label ${res.status}`)
      return null
    }
    const rows = (await res.json()) as Array<{ label?: unknown }>
    const label = Array.isArray(rows) ? rows[0]?.label : undefined
    return typeof label === 'string' && label ? label : null
  } catch (e) {
    console.error(
      '[openground:members] get label failed',
      e instanceof Error ? e.message : e,
    )
    return null
  }
}

// Set (or clear) a project's member-visible SHARED NAME. Owner-JWT UPDATE under
// RLS (0005 "og projects owner update") — a non-owner's PATCH matches no allowed
// row, so ownership is enforced in the database. A blank label clears it (stored
// NULL). Returns { ok, label } with the trimmed value on success; { ok:false }
// when unconfigured / signed out / the update fails. Never throws.
//
// NOTE: with `return=minimal` a 204 means "request accepted" — NOT "a row was
// updated". An RLS-filtered (non-owner) PATCH affects 0 rows yet still 204s, so
// this would return ok:true having changed nothing. That false-positive is inert
// here because the ONLY caller (POST /api/collab/label) is owner-gated AND
// resolves the collabProjectId from the caller's OWN registered path — a caller
// can never submit someone else's project. A future, non-owner-gated caller
// MUST switch to return=representation and treat an empty result as ok:false.
export const setProjectLabel = async (
  collabProjectId: string,
  label: string,
): Promise<{ ok: boolean; label?: string }> => {
  if (!collabProjectId) return { ok: false }
  const auth = await ownerAuth()
  if (!auth) return { ok: false }
  const trimmed = (label ?? '').trim()
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
        body: JSON.stringify({ label: trimmed || null }),
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:members] set label ${res.status}: ${detail}`)
      return { ok: false }
    }
    return { ok: true, label: trimmed || undefined }
  } catch (e) {
    console.error(
      '[openground:members] set label failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}

// --- Caller-JWT (owner) writes ----------------------------------------------
// The v2 model has NO service-role key. Every write runs with the signed-in
// user's OWN access token; the 0005 RLS policies permit them only when the caller
// owns the og_projects row. Each helper is best-effort and NEVER throws to the
// caller — a non-owner / offline / unconfigured call is a quiet no-op.

interface OwnerAuth {
  url: string
  anonKey: string
  token: string
}

// Resolve the anon config + a fresh access token for an owner write. null when
// unconfigured or signed out (→ the write is a no-op).
const ownerAuth = async (): Promise<OwnerAuth | null> => {
  const config = readAuthConfig()
  if (!config) return null
  const token = await getFreshAccessToken()
  if (!token) return null
  return { url: config.url, anonKey: config.anonKey, token }
}

// Ensure the signed-in user OWNS an og_projects row and return its id (the
// collabProjectId). Always INSERTs a new project owned by self (a "create a
// shareable project" action), echoing the new row back. Returns null when
// unconfigured / signed out / the insert fails. Owner = the session's auth uid
// (the 0005 insert policy requires owner_id = auth.uid()). `name` is optional
// display metadata.
export const ensureOwnProject = async (name?: string): Promise<string | null> => {
  const auth = await ownerAuth()
  if (!auth) return null
  const session = await readSession()
  const ownerId = session?.user.id
  if (!ownerId) return null

  try {
    const res = await fetch(`${auth.url}/rest/v1/${projectsTable()}`, {
      method: 'POST',
      headers: {
        apikey: auth.anonKey,
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ owner_id: ownerId, name: name?.trim() || null }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:members] create project ${res.status}: ${detail}`)
      return null
    }
    const rows = (await res.json()) as Array<{ id?: string }>
    const id = Array.isArray(rows) ? rows[0]?.id : undefined
    return typeof id === 'string' && id ? id : null
  } catch (e) {
    console.error(
      '[openground:members] create project failed',
      e instanceof Error ? e.message : e,
    )
    return null
  }
}

// Opaque per-owner dedup key for an og_projects row. We store sha256_hex of
// (ownerUserId + ':' + canonicalPath) in og_projects.name — NOT the raw path.
// PRIVACY: name is readable by every member (RLS "og projects read"); the owner's
// absolute local FS path must never be exposed, so this is a NON-REVERSIBLE hash
// (one-way + salted by the owner id). It is used only to dedup the SAME owner's
// repeated opens of the SAME folder; collaborators can't recover the path from it.
const ownerProjectNameKey = (ownerId: string, canonicalPath: string): string =>
  createHash('sha256').update(`${ownerId}:${canonicalPath}`).digest('hex')

// DETERMINISTIC find of the caller's OWN og_projects row for a dedup hash. Orders
// by (created_at, id) ascending and takes the first, so even if duplicate rows
// somehow exist — legacy data minted before the unique (owner_id,name) index
// (migration 0014), or a cross-process race the in-process single-flight below
// can't cover — EVERY caller converges on the SAME (oldest) row rather than a
// non-deterministic limit-1 pick. The (created_at,id) tiebreak matches 0014's
// duplicate-collapse survivor, so runtime and migration agree on the survivor.
// Returns the id, `null` when there is no such row, or `undefined` when the
// lookup itself FAILED (non-ok / network) so the caller can distinguish "absent"
// from "couldn't check". Never throws.
const findOwnProjectByHash = async (
  auth: OwnerAuth,
  ownerId: string,
  nameHash: string,
): Promise<string | null | undefined> => {
  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${projectsTable()}?owner_id=eq.${encodeURIComponent(
        ownerId,
      )}&name=eq.${encodeURIComponent(
        nameHash,
      )}&select=id&order=created_at.asc,id.asc&limit=1`,
      {
        headers: {
          apikey: auth.anonKey,
          Authorization: `Bearer ${auth.token}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.error(`[openground:members] find project ${res.status}`)
      return undefined
    }
    const rows = (await res.json()) as Array<{ id?: string }>
    const existing = Array.isArray(rows) ? rows[0]?.id : undefined
    return typeof existing === 'string' && existing ? existing : null
  } catch (e) {
    console.error(
      '[openground:members] find project failed',
      e instanceof Error ? e.message : e,
    )
    return undefined
  }
}

// The actual resolve-or-create body (find → create → re-find on conflict),
// wrapped by findOrCreateOwnProject's single-flight below so concurrent collab
// scopes share one run. Never throws; null only when every step failed.
const resolveOwnProjectRow = async (
  auth: OwnerAuth,
  ownerId: string,
  canonicalPath: string,
): Promise<string | null> => {
  // Opaque, non-reversible dedup key (never the raw path) — used for BOTH the
  // lookup and the insert so the same folder reuses one row.
  const nameHash = ownerProjectNameKey(ownerId, canonicalPath)

  // 1) Existing row for this dedup hash? (deterministic — oldest wins.)
  const existing = await findOwnProjectByHash(auth, ownerId, nameHash)
  if (existing) return existing
  // existing === undefined means the read itself failed; fall through to create
  // anyway — a transient read blip shouldn't block sharing, and the create's own
  // conflict handling (step 3) still converges if a row actually exists.

  // 2) None found → create one keyed by the opaque dedup hash (not the path).
  const created = await ensureOwnProject(nameHash)
  if (created) return created

  // 3) The create returned null. Once the unique (owner_id, name) index
  //    (migration 0014) is live, a CONCURRENT / cross-process insert that won the
  //    race makes our insert 409 — the canonical row now exists, so re-find it
  //    (deterministically) and return the winner instead of a split null. A
  //    genuine create error re-finds to null too, preserving the best-effort
  //    "never throw, null on total failure" contract.
  return (await findOwnProjectByHash(auth, ownerId, nameHash)) ?? null
}

// IDEMPOTENT resolve-or-create of the caller's OWN og_projects row for a stable
// key, returning its id (the collabProjectId). `canonicalPath` is the project's
// CANONICAL LOCAL PATH — unique + stable per owner per machine, so two opens of
// the same folder reuse one collab project instead of minting a new row on every
// poll (ensureOwnProject alone always INSERTs). The marker-free replacement for
// v1's path→collabProjectId mapping. og_projects.name stores an OPAQUE per-owner
// dedup HASH of the path (ownerProjectNameKey above), NEVER the path itself —
// every member can read name, so a raw path would leak the owner's local FS
// layout. Returns null when unconfigured / signed out / both the lookup and the
// create fail. Never throws.
//
// CONCURRENCY: every collab scope (board + each open canvas) mounts its own
// RealtimeProvider when a project opens and each fires GET /api/collab/project at
// once, so this is called N times concurrently for the SAME folder. Without
// coalescing, every call missed the find (no row yet) and INSERTed, minting
// DUPLICATE og_projects rows for one folder — and a later limit-1 find then
// returned DIFFERENT ids to different scopes/members, silently SPLITTING the
// collab room. We single-flight concurrent calls for the same (owner, path) onto
// one in-flight promise: the get→set below is synchronous (no await between), so
// a second concurrent call always observes the first's entry and shares its
// result, guaranteeing exactly one find-then-create and one converged id. The
// unique index (0014) backstops the rarer cross-process race.
export const findOrCreateOwnProject = async (
  canonicalPath: string,
): Promise<string | null> => {
  const auth = await ownerAuth()
  if (!auth) return null
  const session = await readSession()
  const ownerId = session?.user.id
  if (!ownerId || !canonicalPath) return null

  // Keyed by owner too (not just path), so an account switch can't hand back a
  // stale resolve for the previous user. '\n' can't appear in a uuid, so it's an
  // unambiguous separator.
  const key = `${ownerId}\n${canonicalPath}`
  const inflight = resolveInFlight.get(key)
  if (inflight) return inflight

  const p = resolveOwnProjectRow(auth, ownerId, canonicalPath)
  resolveInFlight.set(key, p)
  try {
    return await p
  } finally {
    resolveInFlight.delete(key)
  }
}

// Add (or re-add) member emails to a project the caller OWNS. Owner INSERT under
// RLS (0005) — a non-owner is a silent RLS no-op. Idempotent: each email is a
// PLAIN per-row insert and a 409 unique-violation (already a member) is treated
// as a no-op success — so a re-invite is harmless WITHOUT needing an UPDATE
// policy. (We deliberately do NOT use ON CONFLICT / resolution=ignore-duplicates:
// Postgres's ON CONFLICT speculative-insertion path spuriously fails this table's
// subquery-based RLS WITH CHECK, 403-ing even the legitimate owner.) The owner
// email (when given) is stored role 'owner', everyone else 'member'. Dedupes +
// lowercases emails. No-op ({ok:false,written:0}) when unconfigured / signed out
// / no usable emails. Invalidates this project's read cache on success. Never throws.
export const upsertProjectMembers = async (
  collabProjectId: string,
  emails: string[],
  opts?: { ownerEmail?: string },
): Promise<{ ok: boolean; written: number }> => {
  if (!collabProjectId) return { ok: false, written: 0 }
  const auth = await ownerAuth()
  if (!auth) return { ok: false, written: 0 }

  const ownerEmail = opts?.ownerEmail?.trim().toLowerCase()
  const unique = Array.from(
    new Set(
      (emails ?? [])
        .map((e) => e?.trim().toLowerCase())
        .filter((e): e is string => !!e),
    ),
  )
  if (unique.length === 0) return { ok: false, written: 0 }

  // The owner seeding THEIR OWN row is an immediate, accepted member; everyone else
  // is an EMAIL INVITE that lands as 'pending' — pre-confirmed identity with zero
  // collab access until that person accepts the in-app お知らせ (accept_invite). This
  // is the whole "name exactly who may enter, they're not in until they accept"
  // guarantee, enforced at insert time. (The link self-join / owner-approval paths
  // never come through here — they insert via their RPCs with the default
  // 'accepted'.)
  const rows = unique.map((email) => {
    const isOwner = !!ownerEmail && email === ownerEmail
    return {
      project_id: collabProjectId,
      email,
      role: isOwner ? 'owner' : 'member',
      status: isOwner ? 'accepted' : 'pending',
    }
  })

  // Insert rows INDIVIDUALLY as plain inserts — do NOT use `on_conflict` /
  // `resolution=ignore-duplicates`. PostgreSQL's ON CONFLICT speculative-
  // insertion path spuriously FAILS this table's RLS WITH CHECK (which contains
  // an `EXISTS(og_projects …)` subquery), so a bulk upsert returns 403 even for
  // the legitimate owner seeding their own membership. A plain insert passes the
  // exact same WITH CHECK; idempotency comes from treating a 409 unique-violation
  // (the (project_id,email) row already exists) as a no-op success.
  let written = 0
  try {
    for (const row of rows) {
      const res = await fetch(`${auth.url}/rest/v1/${membersTable()}`, {
        method: 'POST',
        headers: {
          apikey: auth.anonKey,
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        written++
        continue
      }
      if (res.status === 409) continue // already a member — idempotent no-op
      const detail = await res.text().catch(() => '')
      console.error(`[openground:members] insert ${res.status}: ${detail}`)
      return { ok: false, written }
    }
    // Membership may have changed — drop the stale read cache so the next
    // getMyMembership re-resolves against the freshly seeded rows.
    clearMembershipCache(collabProjectId)
    return { ok: true, written }
  } catch (e) {
    console.error(
      '[openground:members] upsert failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false, written: 0 }
  }
}

// Delete EVERY outstanding self-join invite CODE for a project (link rotation on
// eviction). A removed member only loses their roster row; the project's invite
// codes (og_project_invites, 7-day) are PROJECT-WIDE, so an evicted member who
// still holds an unexpired code could immediately self-rejoin via the
// join_with_invite RPC. Removing a member therefore MUST also revoke the
// project's links to close that re-entry path. Owner-JWT DELETE under RLS (0007
// "invites owner all") — a non-owner matches no rows. Best-effort + never throws:
// inlined here (rather than importing collabInvites' revokeProjectInvites) to keep
// projectMembers free of a projectMembers↔collabInvites import cycle.
const revokeProjectInviteLinks = async (
  auth: OwnerAuth,
  collabProjectId: string,
): Promise<void> => {
  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${invitesTable()}?project_id=eq.${encodeURIComponent(
        collabProjectId,
      )}`,
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
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:members] revoke invites on remove ${res.status}: ${detail}`)
    }
  } catch (e) {
    console.error(
      '[openground:members] revoke invites on remove failed',
      e instanceof Error ? e.message : e,
    )
  }
}

// Remove ONE member (by email) from a project the caller OWNS. Owner DELETE under
// RLS (0005). Lowercases the email to match how rows are stored. No-op
// ({ok:false}) when unconfigured / signed out / blank email. Invalidates this
// project's read cache on success. Never throws.
//
// SECURITY — eviction is TWO deletes: the roster row AND the project's self-join
// invite links (revokeProjectInviteLinks above), so a removed member can't rejoin
// with an unexpired code they still hold. The link rotation runs ONLY after the
// roster DELETE succeeds (so a non-owner, whose roster DELETE is an RLS no-op /
// failure, never triggers it) and is best-effort: a failed sweep is logged but
// does NOT flip the result — the member is already removed, and the owner can
// still revoke-all manually (POST /api/collab/invite-link/revoke).
export const removeProjectMember = async (
  collabProjectId: string,
  email: string,
): Promise<{ ok: boolean }> => {
  if (!collabProjectId) return { ok: false }
  const auth = await ownerAuth()
  if (!auth) return { ok: false }
  const target = email?.trim().toLowerCase()
  if (!target) return { ok: false }

  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${membersTable()}?project_id=eq.${encodeURIComponent(
        collabProjectId,
      )}&email=eq.${encodeURIComponent(target)}`,
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
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:members] remove ${res.status}: ${detail}`)
      return { ok: false }
    }
    clearMembershipCache(collabProjectId)
    // Close the re-entry path: rotate the project's invite links so the evicted
    // member can't self-rejoin with a code they still hold. Best-effort.
    await revokeProjectInviteLinks(auth, collabProjectId)
    return { ok: true }
  } catch (e) {
    console.error(
      '[openground:members] remove failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}

// The owner CANCELS a still-PENDING email invite (the "取消" action on a pending
// roster row). A plain owner-JWT DELETE under RLS (0005 "og members owner delete"),
// scoped by email AND status='pending' so it can ONLY ever drop an UNACCEPTED
// invite — never an active collaborator (that's removeProjectMember). Unlike
// eviction it does NOT rotate the project's invite links: a pending invitee never
// held a link, so cancelling their invite must not nuke everyone else's links (that
// would break the coexisting quick-share link path). Lowercases the email to match
// storage. Invalidates the read cache. { ok:false } when unconfigured / signed out
// / blank email / the delete fails. Never throws.
export const cancelPendingInvite = async (
  collabProjectId: string,
  email: string,
): Promise<{ ok: boolean }> => {
  if (!collabProjectId) return { ok: false }
  const auth = await ownerAuth()
  if (!auth) return { ok: false }
  const target = email?.trim().toLowerCase()
  if (!target) return { ok: false }

  try {
    const res = await fetch(
      `${auth.url}/rest/v1/${membersTable()}?project_id=eq.${encodeURIComponent(
        collabProjectId,
      )}&email=eq.${encodeURIComponent(target)}&status=eq.pending`,
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
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:members] cancel invite ${res.status}: ${detail}`)
      return { ok: false }
    }
    clearMembershipCache(collabProjectId)
    return { ok: true }
  } catch (e) {
    console.error(
      '[openground:members] cancel invite failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}

// The INVITEE accepts their OWN pending email invite (the Ground お知らせ "Join"
// action): flips their og_project_members row 'pending' → 'accepted' so they gain
// collab access and the project moves from the bell to a Ground shared card. Calls
// the accept_invite SECURITY DEFINER RPC (migration 0013) under the caller's own
// JWT; the RPC touches ONLY the caller's own row (matched by their verified JWT
// email/uid), so it can neither accept someone else's invite nor enrol a non-invited
// caller (no matching pending row → 0 flipped). Invalidates this project's
// membership cache so the next getMyMembership re-resolves the now-accepted row.
// Returns { ok, accepted } where `accepted` is the rows flipped (0 = already
// accepted / no invite). { ok:false } when unconfigured / signed out / the RPC
// errors. Never throws.
export const acceptInvite = async (
  collabProjectId: string,
): Promise<{ ok: boolean; accepted?: number }> => {
  if (!collabProjectId) return { ok: false }
  const auth = await ownerAuth()
  if (!auth) return { ok: false }
  try {
    const res = await fetch(`${auth.url}/rest/v1/rpc/accept_invite`, {
      method: 'POST',
      headers: {
        apikey: auth.anonKey,
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_project_id: collabProjectId }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:members] accept ${res.status}: ${detail}`)
      return { ok: false }
    }
    // The caller is now an accepted member — drop any cached negative so the next
    // getMyMembership (ticket gate) sees the accepted row.
    clearMembershipCache(collabProjectId)
    const body = (await res.json().catch(() => null)) as { accepted?: unknown } | null
    const accepted = typeof body?.accepted === 'number' ? body.accepted : undefined
    return { ok: true, ...(accepted !== undefined ? { accepted } : {}) }
  } catch (e) {
    console.error(
      '[openground:members] accept failed',
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}
