# Realtime collab v2 — Cloudflare Durable Objects transport

Supersedes the **transport** half of `docs/COLLAB_PLAN.md` (which used Supabase
Realtime Broadcast). The CRDT data model, the flat-map mappers, and the
Board/Canvas bindings are **unchanged and reused** — only the wire transport and
the membership model changed. Chosen after a costed, web-researched comparison
(Cloudflare DO was both cheapest and the best Yjs fit; Supabase Broadcast was the
priciest at scale; see the research summary in the PR description).

## Architecture (each vendor does what it's best at)

| Concern | Where | Notes |
|---|---|---|
| **Realtime engine + authoritative Y.Doc** | **Cloudflare Durable Objects** (`worker/`, via OSS `y-partyserver` `YServer`) | one DO per room = the single authoritative doc + WebSocket hub + SQLite persistence; WebSocket **Hibernation** ⇒ idle rooms cost ~$0 |
| **Auth (identity)** | **Supabase** (OAuth, unchanged) | the Hono server owns the session; nothing about auth changed |
| **Membership (authz)** | **Supabase** `og_projects` + `og_project_members`, **owner-managed RLS** | each project's **owner self-manages** invite/remove by email with their own JWT — NO service-role |
| **Images** | **Cloudflare R2** (zero egress) | only a reference in the doc; client upload wiring is deferred (see below) |
| **Offline / durable / cross-session** | local Y.Doc + the DO's SQLite; git-share optional | solo users are 100% local (no backend) |

Room key = `collabProjectId + ":" + scope` (scope = `board` or `canvas:<id>`).
`collabProjectId` = `og_projects.id` (NOT the git marker anymore — collab no
longer requires git-share).

## Auth seam — short-lived signed ticket

Browsers can't set headers on a WebSocket, and we don't want the Worker calling
Supabase on every connect. So:

1. Client → Hono `GET /api/collab/ticket?path=&scope=` → Hono checks membership
   (RLS, caller's JWT) and **mints an HMAC ticket** (`server/routes/ticket.ts`):
   `base64url(JSON{pid,scope,sub,role,exp})` + "." + `base64url(HMAC_SHA256(secret, firstPart))`, ~60s TTL,
   secret = `OPENGROUND_COLLAB_TICKET_SECRET` (shared Hono↔Worker). Returns
   `{ wsUrl, room, token, expiresAt }` (`wsUrl` = `OPENGROUND_COLLAB_WS_URL`).
2. Client → `y-partyserver` `YProvider(wsUrl, room, doc, { party: 'og-collab-doc', params: () => ({ token }) })`.
   `partysocket` re-invokes `params` on every (re)connect, so the ticket
   **auto-refreshes** — no manual timer.
3. Worker `onBeforeConnect` (`worker/src/ticket.ts`, Web Crypto) verifies the
   HMAC, checks `exp`, and binds `pid:scope === room`; else `401`. The DO never
   talks to Supabase.

The Worker holds only one shared secret, so it is Supabase-agnostic and
self-hostable to the user's own Cloudflare account.

## Feature flag / OFF guarantee (preserved)

`GET /api/collab/config` → `{ enabled }` is true only when `OPENGROUND_REALTIME`
**and** `OPENGROUND_COLLAB_WS_URL` **and** `OPENGROUND_COLLAB_TICKET_SECRET`
**and** a signed-in session are all present. Default build: disabled. The client
loads `y-partyserver`/`partysocket`/`yjs`/the mappers via `await import()` only
inside the enabled branch — **verified**: the main bundle chunk contains zero
partysocket/y-partyserver/supabase internals and `index.html` preloads none of
the collab chunks.

## Supabase v2 (owner-managed membership)

`supabase/migrations/0005_og_projects_owner_managed.sql` (applied, advisor-clean):
- `og_projects { id, owner_id, name, created_at }` — `id` IS the collabProjectId.
- Owner self-manages the roster: RLS lets the **project owner** INSERT/DELETE
  `og_project_members` (identified via `og_projects.owner_id = auth.uid()`); any
  member SELECTs the roster. **No service-role.**
- The membership helper `og_is_member` is **SECURITY DEFINER in a non-API-exposed
  `private` schema** — DEFINER breaks the `og_projects ↔ og_project_members`
  policy recursion; `private` keeps it off PostgREST so it doesn't trip the
  "definer executable" advisor. (Single permissive SELECT per table → no
  multiple-permissive perf lint; `(select auth.uid())` form → no initplan lint.)
- Dropped the obsolete v1 objects: `og_doc_snapshots` (DO SQLite replaces it),
  `realtime.messages` broadcast policies (no Supabase realtime), the
  `og-collab-assets` storage policies (R2 replaces it; the empty bucket row can
  only be removed via the Storage API/dashboard).

### Membership — how someone joins (two paths, both login-required)

A project's roster is `og_project_members`; the OWNER manages it. There are two
ways to add a collaborator, both requiring the joiner to be **signed in** (no
anonymous members):

1. **Email invite** (owner-driven): the owner enters an email; the server
   owner-INSERTs a member row under RLS (`upsertProjectMembers`,
   `POST /api/collab/invite`). When that email's account later signs in, the
   RLS email-claim match lets them resolve in. Owner-removable
   (`POST /api/collab/remove`).
2. **Invite link / code** (invitee-driven self-join — migration
   `0007_collab_invites.sql`): the owner mints a secret, **7-day-expiry** CODE
   (`POST /api/collab/invite-link` → `og_project_invites` row, owner-JWT RLS
   write); any **logged-in** user who presents a valid code self-joins as a
   member via `POST /api/collab/join` → the `join_with_invite(token)` **SECURITY
   DEFINER** RPC. The RPC is the controlled privilege escalation: a member-insert
   is normally owner-only, but the invitee isn't the owner, so the function
   inserts **ONLY the caller** (uid/email from their JWT, role capped by the
   invite) — it can't add others, pick the project, or escalate. UX is
   **paste-code** (OPEN GROUND is a local app — there's no web origin to
   deep-link, so the invitee pastes the code into their own OPEN GROUND).
   - The code IS the secret: only the owner can mint/read it (RLS "invites owner
     all"); `join_with_invite` is the only way a non-owner touches the invite,
     and only to enrol themselves.
   - ADVISOR NOTE: `join_with_invite` is an **intentional** user-callable
     `SECURITY DEFINER` function, so it appears on the "Signed-In Users Can
     Execute SECURITY DEFINER Function" advisor **BY DESIGN** (the standard
     secure-invite pattern; tightly scoped + reviewed — unlike the internal
     `private.og_is_member` helper, which stays off PostgREST). All other
     advisor findings are pre-existing (feedback/waitlist anon-insert,
     leaked-password).
   - Helpers: `src/lib/server/collabInvites.ts` (`createInviteLink` /
     `joinWithInvite`, caller-JWT, never-throw). Contract:
     `CollabInviteLinkResponse` / `CollabJoinResponse` in `src/lib/types.ts`.
   - Hardening (`0008_collab_invite_email_hardening.sql`, adversarial-review
     follow-up): the RPC LOWERCASES the caller email + requires a non-null email,
     so the roster has one identity per person and an owner's "remove member"
     actually matches a link-joined row (0007 stored the raw JWT email → a
     capitalized email caused a revocation bypass + duplicate rows). Also revokes
     `anon`'s default grants on `og_project_invites` (tokens are the secret;
     matches the 0006 posture for the sibling tables).
   - EVICTION CAVEAT (multi-use links): a link is valid for its full 7 days and
     can be redeemed more than once, so fully evicting someone =
     **remove the member row AND revoke any outstanding invite links** (else they
     rejoin with the old code). A per-project "revoke invite links" action
     (owner-DELETE on `og_project_invites` under RLS) is a follow-up for the
     owner-management UI — see the client plan.

## Verification (this run, all green)

- **Local DO convergence** (`worker/test/local.mjs`, real `wrangler unstable_dev`
  miniflare, no CF login): 2 clients converge a Y.Map; a late joiner gets prior
  state (authoritative doc); tampered/expired/wrong-room tickets → 401; valid
  canvas-room accepted. **PASS.**
- `tsc` 0, `eslint` 0 errors, `npm test` **1456 passing**.
- `get_advisors(security)` clean (only the pre-existing feedback/waitlist/leaked-
  password warnings remain).

## Boundary & deferred

- **Live deploy is the user's**: `cd worker && wrangler login && wrangler secret put OPENGROUND_COLLAB_TICKET_SECRET && wrangler deploy`, then set `OPENGROUND_COLLAB_WS_URL` (the `wss://…` form) + the same ticket secret on the Hono side. Real cross-machine 2-user test needs that deploy. See `worker/README.md`.
- **Deferred** (need visual QA with the user): u14 images→R2 client upload + `ElementView` `storageKey`; u15 presence (cursors/avatars via the DO awareness channel).
- `docs/COLLAB_PLAN.md` (v1 Supabase Broadcast) is kept for history; this doc is the current transport canon.
