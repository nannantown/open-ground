// server/routes/collab.ts — realtime-collab gating, per-project resolution, and
// the Cloudflare-DO WebSocket TICKET minter.
//
// Thin adapter (like every route): the real logic is the membership resolver +
// owner-managed writes (src/lib/server/projectMembers.ts) and the ticket mint
// helper (./ticket). The v2 (Cloudflare Durable-Object) model REPLACES v1's
// git-marker collabProjectId + Supabase Realtime broadcast:
//   GET  /api/collab/config            global capability gate → { enabled }
//   GET  /api/collab/project?path=[&collabProjectId=]  resolve collabProjectId →
//                                      { collabProjectId, member } (owner-by-path
//                                      default; member-by-id when the param is set)
//   GET  /api/collab/members?path=     the project's roster (owner Collaborators UI)
//   GET  /api/collab/projects          projects the caller can read (owner OR
//                                      member) → { projects } — "shared with me"
//                                      groundwork (client UX DEFERRED)
//   GET  /api/collab/ticket?path=&scope=[&collabProjectId=]  membership-gated HMAC
//                                      ticket → CollabTicketResponse
//   POST /api/collab/invite {path,emails} owner adds members (owner-JWT RLS write)
//   POST /api/collab/remove {path,email}  owner removes a member (owner-JWT RLS write)
//   POST /api/collab/invite-link {path}   owner mints a 7-day self-join CODE (0007)
//   POST /api/collab/invite-link/revoke {path}  owner revokes ALL invite links (evict)
//   POST /api/collab/join {code}          logged-in user redeems a code → member
//   POST /api/collab/label {path,label}   owner sets the member-visible shared name
//   GET/POST /api/collab/shared-data       member's local board cache (option A)
//   GET/POST /api/collab/shared-canvas     member's local per-canvas cache (cv4)
//
// The cross-user collabProjectId is now og_projects.id (owner-managed, migration
// 0005), NOT the git-share marker — so collab no longer requires "Share via Git".
// The WS transport is the Worker (y-partyserver), authorized by the short-lived
// ticket; Supabase only stores membership.
//
// GRACEFUL DEGRADE: with the collab env unset (the public build) config is
// { enabled:false }, the SPA never loads the y-partyserver/yjs chunk, and the
// single-user path is byte-for-byte unchanged.

import { Hono, type Context } from 'hono'
import { readAuthConfig, getFreshAccessToken } from '@/lib/server/supabaseAuth'
import { readSession } from '@/lib/server/authStore'
import {
  getMyMembership,
  findOrCreateOwnProject,
  upsertProjectMembers,
  removeProjectMember,
  listMyProjects,
  listInvitesForMe,
  listProjectMembers,
  getProjectLabel,
  setProjectLabel,
} from '@/lib/server/projectMembers'
import {
  createInviteLink,
  joinWithInvite,
  revokeProjectInvites,
  resetInviteLinks,
  listInviteLinks,
  getProjectMemberCap,
  setProjectMemberCap,
  listJoinRequests,
  approveJoinRequest,
  denyJoinRequest,
  type CreateInviteOpts,
} from '@/lib/server/collabInvites'
import {
  isCollabProjectId,
  isSafeId,
  readSharedBoardCache,
  writeSharedBoardCache,
  readSharedCanvasCache,
  writeSharedCanvasCache,
} from '@/lib/server/sharedCache'
import { readCanvasAsset } from '@/lib/server/canvasImages'
import {
  readCollabWsUrl,
  roomFor,
  workerHttpBase,
  issueWorkerTicket,
} from './ticket'
import { requireProjectPath } from '../middleware/projectPath'
import type {
  CollabAssetUploadResponse,
  CollabConfigResponse,
  CollabInviteLinkResponse,
  CollabInviteLinksResponse,
  CollabInviteMode,
  CollabInvitesResponse,
  CollabJoinRequestsResponse,
  CollabJoinResponse,
  CollabLabelResponse,
  CollabMembersResponse,
  CollabProjectResponse,
  CollabProjectsListResponse,
  CollabSharedCanvasResponse,
  CollabSharedDataResponse,
  CollabTicketResponse,
  CanvasFile,
  ProjectData,
  ProjectMember,
} from '@/lib/types'

// The server-side feature flag. Collab is OFF unless explicitly turned on.
const realtimeEnvOn = (): boolean => {
  const v = process.env.OPENGROUND_REALTIME?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

// The single capability predicate, shared by /config (whether to load the
// bundle) and /ticket (503 collab-disabled). ZERO-CONFIG contract: the flag AND a
// Worker WS endpoint AND a signed-in session. The HMAC ticket secret is NO LONGER
// a local condition — it lives only on the operator Worker now (the Hono relays
// the user's access token to the Worker, which mints). A session implies Supabase
// Auth was configured, so membership lookups + the access-token relay work; we
// don't double-check readAuthConfig() here to keep the gate exactly these three.
const collabEnabled = async (): Promise<boolean> =>
  realtimeEnvOn() &&
  readCollabWsUrl() !== null &&
  (await readSession()) !== null

// Validate a DocScope string: 'board' or 'canvas:<id>' (id non-empty, no further
// colons in the id segment beyond the one separator). Fails CLOSED.
const isValidScope = (scope: string): boolean => {
  if (scope === 'board') return true
  const m = /^canvas:(.+)$/.exec(scope)
  return !!m && m[1].length > 0
}

// Resolve THIS local project's collabProjectId for the signed-in caller and make
// sure they have a membership row (owner). Shared by /project, /ticket, /invite,
// /remove so every route both resolves the id the same way AND guarantees the
// owner is enrolled (the og_projects INSERT does NOT create a member row, so a
// freshly created project would otherwise fail the membership gate / ticket /
// og_is_member until enrolled). Idempotent: the membership upsert only fires when
// the caller isn't already a cached owner, so steady-state reconnects do no
// extra write. Returns null collabProjectId when unconfigured / signed out / the
// resolve fails.
const resolveOwnedProject = async (
  path: string,
): Promise<{ collabProjectId: string | null; me: ProjectMember | null }> => {
  const session = await readSession()
  if (!readAuthConfig() || !session?.user.email) {
    return { collabProjectId: null, me: null }
  }
  const collabProjectId = await findOrCreateOwnProject(path)
  if (!collabProjectId) return { collabProjectId: null, me: null }

  let me = await getMyMembership(collabProjectId)
  if (me?.role !== 'owner') {
    const seed = await upsertProjectMembers(collabProjectId, [session.user.email], {
      ownerEmail: session.user.email,
    })
    if (seed.ok) me = { projectId: collabProjectId, role: 'owner' }
  }
  return { collabProjectId, me }
}

// MEMBER-FLOW resolver (SERVER groundwork). Resolve a collab project by its
// cross-user id (NOT a local path), gating on membership only — owner OR member.
// This is the path an INVITED member uses: they have no local folder for the
// project, so findOrCreateOwnProject (which keys off the canonical local path and
// would mint a brand-new OWNED project) can't reach the shared room. Here we just
// confirm the caller may read the project via getMyMembership and pass the id
// through; we NEVER create or seed anything (a member must not own/seed rows).
// Returns null collabProjectId when signed out / unconfigured / not a member.
//
// TODO(member-flow / DEFERRED — needs product/UX): the CLIENT side of "open a
// shared project you don't own" is intentionally NOT built here. A member today
// has no UI to discover a collabProjectId or to open a project without a local
// folder on the Ground canvas; GET /api/collab/projects (below) is the server
// groundwork for a future "shared with me" list, but the picker / placeholder-
// card UX is a separate product decision. Path-based resolution stays the default
// for owners; this id-based path only activates when a `collabProjectId` query
// param is supplied.
const resolveMemberProject = async (
  collabProjectId: string,
): Promise<{ collabProjectId: string | null; me: ProjectMember | null }> => {
  const session = await readSession()
  if (!readAuthConfig() || !session?.user.email || !collabProjectId) {
    return { collabProjectId: null, me: null }
  }
  const me = await getMyMembership(collabProjectId)
  if (!me) return { collabProjectId: null, me: null }
  return { collabProjectId, me }
}

// Resolve the project for a route that accepts EITHER ?path= (OWNER flow) OR
// ?collabProjectId= (MEMBER flow — the invitee has no local folder). Returns a
// Response only on a path error in the OWNER flow; the MEMBER flow needs no path
// (and runs no path validation) because its security gate is MEMBERSHIP:
// resolveMemberProject reads og_project_members under the caller's JWT and yields
// {null,null} for a non-member, so a caller can only resolve a room they actually
// belong to. Centralised so /project and /ticket behave identically.
const resolveRouteProject = async (
  c: Context,
): Promise<
  Response | { collabProjectId: string | null; me: ProjectMember | null }
> => {
  const idParam = c.req.query('collabProjectId')?.trim() || undefined
  if (idParam) return resolveMemberProject(idParam)
  const path = await requireProjectPath(c)
  if (path instanceof Response) return path
  return resolveOwnedProject(path)
}

// Parse the {mode?, maxUses?} per-link options from a request body. Garbage falls
// back to the defaults (open, unlimited); the helper layer re-normalizes too.
const parseInviteOpts = (body: { mode?: unknown; maxUses?: unknown }): CreateInviteOpts => ({
  mode: (body.mode === 'approval' ? 'approval' : 'open') as CollabInviteMode,
  maxUses:
    typeof body.maxUses === 'number' && Number.isFinite(body.maxUses) && body.maxUses >= 1
      ? Math.floor(body.maxUses)
      : null,
})

// Parse an optional project member cap. `undefined` (key absent) = "leave it
// unchanged"; `null` or a non-positive value = clear/unlimited; a positive int = set.
const parseMemberCap = (raw: unknown): number | null | undefined => {
  if (raw === undefined) return undefined
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw)
  return null
}

export const collabRoutes = new Hono()
  // GET /api/collab/config — global capability gate. The SPA checks this once on
  // mount to decide whether to load the collab bundle. No project path.
  .get('/api/collab/config', async (c) => {
    return c.json<CollabConfigResponse>({ enabled: await collabEnabled() })
  })

  // GET /api/collab/project?path=[&collabProjectId=] — per-project resolve.
  // Returns the cross-user collabProjectId (og_projects.id) for this project and
  // whether the caller is a member. DEFAULT (owner, no id param): idempotently
  // resolves-or-creates the owner's og_projects row keyed by the canonical local
  // path, then seeds the owner membership row so og_is_member (and the ticket
  // gate) succeed. With an explicit `collabProjectId` (MEMBER flow): resolves by
  // id via membership only (no create/seed) so an invited member who has no local
  // folder can still resolve the room. collabProjectId is null when signed out /
  // unconfigured / not a member / the resolve fails — the SPA then shows collab
  // as unavailable for this project.
  .get('/api/collab/project', async (c) => {
    const resolved = await resolveRouteProject(c)
    if (resolved instanceof Response) return resolved
    const { collabProjectId, me } = resolved
    // The member-visible shared name (if the owner has set one) — used to pre-fill
    // the owner's invite dialog and to label a member's shared project. Read only
    // when we resolved a project the caller can see (owner OR member via RLS).
    const label = collabProjectId ? await getProjectLabel(collabProjectId) : null
    return c.json<CollabProjectResponse>({
      collabProjectId,
      member: !!me,
      ...(label ? { label } : {}),
    })
  })

  // GET /api/collab/projects — every project the signed-in user can read (owner
  // OR member). MEMBER-FLOW groundwork (server only): the seed for a future
  // "shared with me" list so an invited member can enumerate collabProjectIds
  // they may open even without a local folder. (The picker / placeholder-card UX
  // itself is DEFERRED — see resolveMemberProject's TODO.)
  .get('/api/collab/projects', async (c) => {
    const projects = await listMyProjects()
    return c.json<CollabProjectsListResponse>({ projects })
  })

  // GET /api/collab/invites — the signed-in user's pending collab INVITES: every
  // project shared WITH them that they don't own (the first in-app notification
  // source — the Ground お知らせ bell). SELF-SCOPED BY RLS: listInvitesForMe reads
  // og_project_members under the caller's OWN JWT, and the "og members read roster"
  // policy returns only the rosters of projects the caller belongs to (matched by
  // uid OR JWT email) — so a caller can NEVER read an invite addressed to someone
  // else. No path; "for me" is the only mode. Empty (never an error) when signed
  // out / unconfigured / they have none — so the bell is quiet by default.
  .get('/api/collab/invites', async (c) => {
    const invites = await listInvitesForMe()
    return c.json<CollabInvitesResponse>({ invites })
  })

  // GET /api/collab/members?path= — the project's roster for the owner's
  // "Collaborators" UI. Resolves the OWNED project by path, then lists every
  // member (RLS "og members read roster" lets any member read the whole roster,
  // under the caller's own JWT). collabProjectId null (signed out / unconfigured)
  // → empty list, never an error.
  .get('/api/collab/members', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const { collabProjectId } = await resolveOwnedProject(path)
    const members = collabProjectId ? await listProjectMembers(collabProjectId) : []
    return c.json<CollabMembersResponse>({ members })
  })

  // GET /api/collab/ticket?scope=&{path=|collabProjectId=} — the SHARED-CONTRACT
  // ticket route. Mints a short-lived HMAC ticket the client hands the Worker; the
  // Worker recomputes the HMAC, checks exp, and checks the ticket pid+scope equal
  // the requested room. OWNER flow resolves the project by ?path=; MEMBER flow
  // (invited member, NO local folder) resolves by ?collabProjectId= via membership
  // only — no path required. The cheap gates (enabled, scope) run first so neither
  // flow leaks work before validation.
  //   503 collab-disabled · 400 bad scope/path · 403 non-member · 412 no project
  .get('/api/collab/ticket', async (c) => {
    if (!(await collabEnabled())) {
      return c.json({ error: 'collab disabled' }, 503)
    }

    const scope = c.req.query('scope') ?? ''
    if (!isValidScope(scope)) {
      return c.json({ error: 'invalid scope' }, 400)
    }

    // Resolve by path (OWNER) or collabProjectId (MEMBER, no path). The member
    // flow's gate is membership; the owner flow's is path validation + ownership.
    const resolved = await resolveRouteProject(c)
    if (resolved instanceof Response) return resolved
    const { collabProjectId, me } = resolved
    if (!collabProjectId) {
      return c.json({ error: 'no collab project for this path' }, 412)
    }
    // Membership gate — fast local fail (the Worker re-checks authoritatively).
    // It ALSO matters for the owner flow: resolveOwnedProject seeded the owner's
    // membership row above, which the Worker's own RLS read then sees.
    if (!me) {
      return c.json({ error: 'not a member of this project' }, 403)
    }

    // RELAY (not mint): the HMAC secret lives only on the Worker now. Present the
    // signed-in user's FRESH Supabase access token to the Worker's POST /ticket
    // server-to-server (it never reaches the browser); the Worker re-verifies
    // membership under that token and mints the ticket. collabEnabled() already
    // proved the WS URL + session; re-read for the type + a fresh token.
    const wsUrl = readCollabWsUrl()
    const accessToken = await getFreshAccessToken()
    if (!wsUrl || !accessToken) {
      return c.json({ error: 'collab disabled' }, 503)
    }
    const relay = await issueWorkerTicket(wsUrl, accessToken, collabProjectId, scope)
    if (!relay.ok) {
      return relay.status === 403
        ? c.json({ error: 'not a member of this project' }, 403)
        : c.json({ error: 'ticket relay failed' }, 502)
    }
    return c.json<CollabTicketResponse>({
      wsUrl,
      // Derive the room locally from the pid+scope we validated (the Worker bound
      // the ticket to this same room); don't trust the response echo.
      room: roomFor(collabProjectId, scope),
      token: relay.ticket.token,
      expiresAt: relay.ticket.expiresAt,
    })
  })

  // POST /api/collab/invite {path, emails:[]} — the owner adds collaborator
  // emails. Owner-JWT RLS write (0005): a non-owner's INSERT is a Supabase no-op,
  // so this enforces ownership in the database, not just here.
  .post('/api/collab/invite', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path

    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId) {
      return c.json({ error: 'no collab project for this path' }, 412)
    }
    // UX gate (the DB is the real authority): only a project OWNER may invite.
    if (me?.role !== 'owner') {
      return c.json({ error: 'only a project owner can invite' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { emails?: unknown }
    const emails = Array.isArray(body.emails)
      ? body.emails.filter((e): e is string => typeof e === 'string')
      : []
    if (emails.length === 0) return c.json({ error: 'no emails' }, 400)
    const session = await readSession()
    const res = await upsertProjectMembers(collabProjectId, emails, {
      ownerEmail: session?.user.email,
    })
    return c.json(res)
  })

  // POST /api/collab/remove {path, email} — the owner removes one collaborator.
  // Owner-JWT RLS write (0005): a non-owner's DELETE matches no rows it is
  // allowed to touch, so ownership is enforced in the database. removeProjectMember
  // ALSO rotates the project's self-join invite links (a project-wide code is the
  // evicted member's re-entry vector) so they can't rejoin with a code they still
  // hold — see its SECURITY note in projectMembers.ts.
  .post('/api/collab/remove', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path

    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId) {
      return c.json({ error: 'no collab project for this path' }, 412)
    }
    if (me?.role !== 'owner') {
      return c.json({ error: 'only a project owner can remove members' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown }
    const email = typeof body.email === 'string' ? body.email : ''
    if (!email) return c.json({ error: 'no email' }, 400)
    const res = await removeProjectMember(collabProjectId, email)
    return c.json(res)
  })

  // POST /api/collab/invite-link/revoke {path, inviteId?} — the owner revokes invite
  // links EXPLICITLY. With NO inviteId: ALL outstanding links (project-wide link
  // rotation without removing anyone — e.g. a code leaked). With an inviteId: just
  // THAT link (kill one leaked link, keep the rest). NOTE: removing a member already
  // revokes all links automatically (removeProjectMember), so this route is for
  // rotating links on their own. Owner-JWT RLS delete (0007 "invites owner all"): a
  // non-owner matches no rows, so ownership is enforced in the database.
  //   412 no collabProjectId · 403 non-owner
  .post('/api/collab/invite-link/revoke', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path

    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId) {
      return c.json({ error: 'no collab project for this path' }, 412)
    }
    if (me?.role !== 'owner') {
      return c.json({ error: 'only a project owner can revoke invite links' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { inviteId?: unknown }
    const inviteId =
      typeof body.inviteId === 'string' && body.inviteId ? body.inviteId : undefined
    const res = await revokeProjectInvites(collabProjectId, inviteId)
    return c.json(res)
  })

  // POST /api/collab/invite-link/reset {path, mode?, maxUses?, memberCap?} — the
  // owner mints a FRESH link and revokes every other one in a single action ("revoke
  // + New link" collapsed), optionally re-applying the project member cap. Returns
  // the new link (so there is never a window with no valid link). Owner-gated (DB).
  //   412 no collabProjectId · 403 non-owner · 502 mint failed
  .post('/api/collab/invite-link/reset', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path

    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId) {
      return c.json({ error: 'no collab project for this path' }, 412)
    }
    if (me?.role !== 'owner') {
      return c.json({ error: 'only a project owner can reset the invite link' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      mode?: unknown
      maxUses?: unknown
      memberCap?: unknown
    }
    const cap = parseMemberCap(body.memberCap)
    if (cap !== undefined) await setProjectMemberCap(collabProjectId, cap)
    const res = await resetInviteLinks(collabProjectId, parseInviteOpts(body))
    if (!res.ok) {
      return c.json({ error: 'could not reset invite link' }, 502)
    }
    return c.json<CollabInviteLinkResponse>({
      ok: true,
      code: res.code,
      id: res.id,
      mode: res.mode,
      maxUses: res.maxUses,
      expiresAt: res.expiresAt,
    })
  })

  // GET /api/collab/invite-links?path= — the owner's live links (metadata only — NO
  // raw tokens) + the project member cap, for the manage-links roster. Non-owner /
  // unresolved → empty list, never an error.
  .get('/api/collab/invite-links', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId || me?.role !== 'owner') {
      return c.json<CollabInviteLinksResponse>({ links: [], memberCap: null })
    }
    const [links, memberCap] = await Promise.all([
      listInviteLinks(collabProjectId),
      getProjectMemberCap(collabProjectId),
    ])
    return c.json<CollabInviteLinksResponse>({ links, memberCap })
  })

  // POST /api/collab/invite-link {path, mode?, maxUses?, memberCap?} — the owner
  // mints a secret, time-limited (7-day) self-join CODE. `mode` = open (join now) |
  // approval (request → owner approves); optional per-link `maxUses` (single-use /
  // max-n) and project `memberCap`. Owner-JWT RLS write (0007/0010): a non-owner's
  // insert is a DB no-op, so ownership is enforced in the database.
  //   412 no collabProjectId · 403 non-owner · 502 mint failed
  .post('/api/collab/invite-link', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path

    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId) {
      return c.json({ error: 'no collab project for this path' }, 412)
    }
    // UX gate (the DB is the real authority): only a project OWNER may mint links.
    if (me?.role !== 'owner') {
      return c.json({ error: 'only a project owner can create invite links' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      mode?: unknown
      maxUses?: unknown
      memberCap?: unknown
    }
    // Apply the project-level cap first (when provided) so a freshly-minted link is
    // already bounded by it.
    const cap = parseMemberCap(body.memberCap)
    if (cap !== undefined) await setProjectMemberCap(collabProjectId, cap)
    const res = await createInviteLink(collabProjectId, parseInviteOpts(body))
    if (!res.ok) {
      return c.json({ error: 'could not create invite link' }, 502)
    }
    return c.json<CollabInviteLinkResponse>({
      ok: true,
      code: res.code,
      id: res.id,
      mode: res.mode,
      maxUses: res.maxUses,
      expiresAt: res.expiresAt,
    })
  })

  // GET /api/collab/join-requests?path= — the owner's PENDING approval queue (the
  // people who opened an approval-mode link and await a decision). Non-owner /
  // unresolved → empty list, never an error.
  .get('/api/collab/join-requests', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId || me?.role !== 'owner') {
      return c.json<CollabJoinRequestsResponse>({ requests: [] })
    }
    const requests = await listJoinRequests(collabProjectId)
    return c.json<CollabJoinRequestsResponse>({ requests })
  })

  // POST /api/collab/join-requests/approve {path, requestId} — the owner approves a
  // pending request; the requester becomes a member (member_cap enforced inside the
  // approve_join_request RPC). Owner-gated here AND in the RPC.
  //   412 no collabProjectId · 403 non-owner · 400 no requestId · 502 approve failed
  .post('/api/collab/join-requests/approve', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId) {
      return c.json({ error: 'no collab project for this path' }, 412)
    }
    if (me?.role !== 'owner') {
      return c.json({ error: 'only a project owner can approve requests' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { requestId?: unknown }
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    if (!requestId) return c.json({ error: 'no requestId' }, 400)
    const res = await approveJoinRequest(collabProjectId, requestId)
    if (!res.ok) return c.json({ error: 'could not approve request' }, 502)
    return c.json(res)
  })

  // POST /api/collab/join-requests/deny {path, requestId} — the owner denies (deletes)
  // a pending request. Owner-gated here AND via RLS.
  //   412 no collabProjectId · 403 non-owner · 400 no requestId · 502 deny failed
  .post('/api/collab/join-requests/deny', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId) {
      return c.json({ error: 'no collab project for this path' }, 412)
    }
    if (me?.role !== 'owner') {
      return c.json({ error: 'only a project owner can deny requests' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { requestId?: unknown }
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    if (!requestId) return c.json({ error: 'no requestId' }, 400)
    const res = await denyJoinRequest(collabProjectId, requestId)
    if (!res.ok) return c.json({ error: 'could not deny request' }, 502)
    return c.json(res)
  })

  // POST /api/collab/join {code} — a logged-in user redeems an invite code to
  // join a shared project as a member (self-join via the join_with_invite RPC,
  // migration 0007 — it inserts ONLY the caller). Returns the joined
  // collabProjectId so the client can open the shared room (the invitee has no
  // local folder — this is the member-flow entry point). LOGIN-REQUIRED: the RPC
  // reads the caller's JWT uid/email, so a signed-out call enrols no one
  // (joinWithInvite → {ok:false,'not signed in'}). A bad/expired code is a normal
  // user-input outcome, returned as 200 {ok:false,error} so the client renders it
  // inline rather than as a network error.
  //   400 missing code field
  .post('/api/collab/join', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown }
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!code) return c.json({ error: 'no code' }, 400)
    const res = await joinWithInvite(code)
    return c.json<CollabJoinResponse>(res)
  })

  // POST /api/collab/label {path, label} — the owner sets the member-visible
  // SHARED NAME for the project (og_projects.label). Owner-JWT RLS write (0005
  // "og projects owner update"): a non-owner's PATCH matches no allowed row, so
  // ownership is enforced in the database. A blank label clears it.
  //   412 no collabProjectId · 403 non-owner · 502 update failed
  .post('/api/collab/label', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path

    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId) {
      return c.json({ error: 'no collab project for this path' }, 412)
    }
    if (me?.role !== 'owner') {
      return c.json({ error: 'only a project owner can set the shared name' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown }
    const label = typeof body.label === 'string' ? body.label : ''
    const res = await setProjectLabel(collabProjectId, label)
    if (!res.ok) return c.json({ error: 'could not set shared name' }, 502)
    return c.json<CollabLabelResponse>({ ok: true, ...(res.label ? { label: res.label } : {}) })
  })

  // GET /api/collab/shared-data?collabProjectId= — read the MEMBER's local board
  // cache for a folder-less shared project (option A; ~/.openground/shared/<id>/).
  // The Y.Doc is authoritative — this just lets the panel open instantly/offline.
  // MEMBERSHIP-gated (caller-JWT) + strict-UUID id (path-traversal guard). NO path.
  //   400 bad id · 403 non-member
  .get('/api/collab/shared-data', async (c) => {
    const id = c.req.query('collabProjectId')?.trim() ?? ''
    if (!isCollabProjectId(id)) return c.json({ error: 'bad collabProjectId' }, 400)
    if (!(await getMyMembership(id))) {
      return c.json({ error: 'not a member of this project' }, 403)
    }
    const data = await readSharedBoardCache(id)
    return c.json<CollabSharedDataResponse>({ data })
  })

  // POST /api/collab/shared-data {collabProjectId, data} — mirror the doc-derived
  // board to the member's local cache. MEMBERSHIP-gated + strict-UUID id.
  //   400 bad id / bad data · 403 non-member
  .post('/api/collab/shared-data', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      collabProjectId?: unknown
      data?: unknown
    }
    const id = typeof body.collabProjectId === 'string' ? body.collabProjectId.trim() : ''
    if (!isCollabProjectId(id)) return c.json({ error: 'bad collabProjectId' }, 400)
    if (!(await getMyMembership(id))) {
      return c.json({ error: 'not a member of this project' }, 403)
    }
    const data = body.data
    if (!data || typeof data !== 'object' || !Array.isArray((data as ProjectData).tasks)) {
      return c.json({ error: 'bad data' }, 400)
    }
    const ok = await writeSharedBoardCache(id, data as ProjectData)
    return c.json({ ok })
  })

  // GET /api/collab/shared-canvas?collabProjectId=&canvasId= — read a member's
  // local cache of ONE shared canvas (cv4). MEMBERSHIP-gated; both ids validated
  // (collabProjectId strict-UUID, canvasId safe-id) → no path traversal.
  //   400 bad id · 403 non-member
  .get('/api/collab/shared-canvas', async (c) => {
    const id = c.req.query('collabProjectId')?.trim() ?? ''
    const canvasId = c.req.query('canvasId')?.trim() ?? ''
    if (!isCollabProjectId(id) || !isSafeId(canvasId)) {
      return c.json({ error: 'bad id' }, 400)
    }
    if (!(await getMyMembership(id))) {
      return c.json({ error: 'not a member of this project' }, 403)
    }
    const data = await readSharedCanvasCache(id, canvasId)
    return c.json<CollabSharedCanvasResponse>({ data })
  })

  // POST /api/collab/shared-canvas {collabProjectId, canvasId, data} — mirror the
  // doc-derived canvas to the member's local cache. MEMBERSHIP-gated + id-validated.
  //   400 bad id / bad data · 403 non-member
  .post('/api/collab/shared-canvas', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      collabProjectId?: unknown
      canvasId?: unknown
      data?: unknown
    }
    const id = typeof body.collabProjectId === 'string' ? body.collabProjectId.trim() : ''
    const canvasId = typeof body.canvasId === 'string' ? body.canvasId.trim() : ''
    if (!isCollabProjectId(id) || !isSafeId(canvasId)) {
      return c.json({ error: 'bad id' }, 400)
    }
    if (!(await getMyMembership(id))) {
      return c.json({ error: 'not a member of this project' }, 403)
    }
    const data = body.data
    if (!data || typeof data !== 'object' || !Array.isArray((data as CanvasFile).elements)) {
      return c.json({ error: 'bad data' }, 400)
    }
    const ok = await writeSharedCanvasCache(id, canvasId, data as CanvasFile)
    return c.json({ ok })
  })

  // GET /api/collab/asset?collabProjectId=&canvasId=&assetId= — stream a shared
  // canvas image's bytes to a folder-less MEMBER (u14b). The browser never holds
  // R2 creds: this loopback route mints a board-scope ticket server-side and
  // proxies the Worker's GET /assets/<pid>/<cid>/<aid>. Membership-gated +
  // strict-id (traversal guard). The OWNER uses the local /api/canvas/asset and
  // never hits this. Keeping the R2 fetch server-side ALSO preserves the OFF
  // guarantee — ImageView only builds a same-origin URL, importing no transport.
  //   503 disabled · 400 bad id · 403 non-member · 404 missing · 502 upstream
  .get('/api/collab/asset', async (c) => {
    if (!(await collabEnabled())) return c.json({ error: 'collab disabled' }, 503)
    const id = c.req.query('collabProjectId')?.trim() ?? ''
    const canvasId = c.req.query('canvasId')?.trim() ?? ''
    const assetId = c.req.query('assetId')?.trim() ?? ''
    if (!isCollabProjectId(id) || !isSafeId(canvasId) || !isSafeId(assetId)) {
      return c.json({ error: 'bad id' }, 400)
    }
    const me = await getMyMembership(id)
    if (!me) return c.json({ error: 'not a member of this project' }, 403)

    // Relay for a BOARD-scope ticket (the asset gate verifies <pid>:board), then
    // proxy the Worker's GET. The mint lives on the Worker now — present the
    // user's fresh access token server-to-server; it never reaches the browser.
    const wsUrl = readCollabWsUrl()
    const accessToken = await getFreshAccessToken()
    if (!wsUrl || !accessToken) return c.json({ error: 'collab disabled' }, 503)
    const relay = await issueWorkerTicket(wsUrl, accessToken, id, 'board')
    if (!relay.ok) {
      return relay.status === 403
        ? c.json({ error: 'not a member of this project' }, 403)
        : c.json({ error: 'ticket relay failed' }, 502)
    }
    const url =
      `${workerHttpBase(wsUrl)}/assets/${encodeURIComponent(id)}/${encodeURIComponent(canvasId)}` +
      `/${encodeURIComponent(assetId)}?token=${encodeURIComponent(relay.ticket.token)}`
    let upstream: Response
    try {
      upstream = await fetch(url)
    } catch {
      return c.json({ error: 'upstream unreachable' }, 502)
    }
    if (upstream.status === 404) return c.json({ error: 'not found' }, 404)
    if (!upstream.ok) return c.json({ error: 'upstream error' }, 502)
    const buf = await upstream.arrayBuffer()
    const ct = upstream.headers.get('content-type') ?? 'application/octet-stream'
    return c.body(buf, 200, { 'content-type': ct, 'cache-control': 'private, max-age=300' })
  })

  // POST /api/collab/asset?path=&canvasId=&assetId= — the OWNER uploads a local
  // canvas image's bytes to R2 (via the Worker PUT) so members can fetch them,
  // then returns the storageKey to write onto the element. Owner-only (the local
  // bytes + ownership both come from the resolved path). Idempotent: re-uploading
  // the same asset just overwrites the same key.
  //   503 disabled · 400 bad id · 403 non-owner · 404 no local asset · 502 upstream
  .post('/api/collab/asset', async (c) => {
    if (!(await collabEnabled())) return c.json({ error: 'collab disabled' }, 503)
    const canvasId = c.req.query('canvasId')?.trim() ?? ''
    const assetId = c.req.query('assetId')?.trim() ?? ''
    if (!isSafeId(canvasId) || !isSafeId(assetId)) return c.json({ error: 'bad id' }, 400)

    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const { collabProjectId, me } = await resolveOwnedProject(path)
    if (!collabProjectId || me?.role !== 'owner') return c.json({ error: 'forbidden' }, 403)

    const out = await readCanvasAsset(path, canvasId, assetId)
    if (!out) return c.json({ error: 'asset not found' }, 404)

    // Relay for the owner's BOARD-scope ticket (the Worker resolves role=owner
    // from membership, which the asset PUT gate requires), then proxy the PUT.
    // The mint lives on the Worker now — the access token never reaches the browser.
    const wsUrl = readCollabWsUrl()
    const accessToken = await getFreshAccessToken()
    if (!wsUrl || !accessToken) return c.json({ error: 'collab disabled' }, 503)
    const relay = await issueWorkerTicket(wsUrl, accessToken, collabProjectId, 'board')
    if (!relay.ok) return c.json({ error: 'upload failed' }, 502)
    const url =
      `${workerHttpBase(wsUrl)}/assets/${encodeURIComponent(collabProjectId)}` +
      `/${encodeURIComponent(canvasId)}/${encodeURIComponent(assetId)}?token=${encodeURIComponent(relay.ticket.token)}`
    let upstream: Response
    try {
      upstream = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': out.mime, 'content-length': String(out.data.byteLength) },
        body: out.data as unknown as BodyInit,
      })
    } catch {
      return c.json({ error: 'upload failed' }, 502)
    }
    if (!upstream.ok) return c.json({ error: 'upload failed' }, 502)
    return c.json<CollabAssetUploadResponse>({
      ok: true,
      storageKey: `${collabProjectId}/${canvasId}/${assetId}`,
    })
  })
