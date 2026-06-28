# Collab — email invites as the safe primary path (pending → accepted)

Board card `5745e3b5`. Builds on the in-app お知らせ bell (card `d9a3e2`, already
landed) and the realtime-collab member flow (`docs/COLLAB_CF_DO_PLAN.md`,
`docs/COLLAB_ZEROCONFIG_PLAN.md`).

## Why

A **link** invite is a bearer secret: anyone who holds the link can join, and the
owner only learns who came in *after* the fact. An **email** invite is
identity-bound — only the named person can ever take it — so the owner decides
*exactly who is in, before* they're in. This card promotes email invites to the
**safe, recommended** path and gives the invitee a real in-app way to discover +
accept them. Link invites stay as the quick-share alternative.

Real email *delivery* is **out of scope** (Phase 2). The loop here is
`owner names an email → pending invite → invitee sees the お知らせ bell → accepts → joins`.

## Goal state (observable)

- Owner types an email in the invite dialog → a **pending** `og_project_members`
  row is created (identity-bound; only that person can accept). **Zero collab
  access** until accepted.
- The invited person signs in → the Ground お知らせ bell shows
  *"X invited you to ‹project›"* → **Join** accepts the invite, opens the shared
  project, and it appears on their Ground as a shared card. The invite then
  leaves the bell.
- The owner's roster shows who is **In** (accepted) vs **Invited** (pending), and
  can revoke per person: **cancel** a pending invite or **remove** an accepted
  member.
- The invite dialog presents email invite as **Recommended** (top); the quick-
  share **link** stays below, worded so the difference is clear.
- Existing link behaviour (mode / 7-day expiry / cap / revoke / approval queue)
  is unchanged. `npm run lint` + `npm test` green, i18n JA/EN, dark/light.

## Design — one new axis: `og_project_members.status`

`status ∈ {pending, accepted}` (migration `0013`):

| Path | status |
|------|--------|
| Owner seed (`upsertProjectMembers`, role `owner`) | `accepted` |
| **Email invite** (`upsertProjectMembers`, role `member`) | **`pending`** |
| Link self-join (`join_with_invite`, open mode) | `accepted` (DB default) |
| Owner approval (`approve_join_request`) | `accepted` (DB default) |
| Every pre-0013 row (backfill) | `accepted` (column default) |

`default 'accepted'` is the keystone: it backfills all existing rows and makes
every immediate-access path correct **without** naming status; only the email
invite explicitly writes `pending`.

### The access boundary (pending = zero access)

`getMyMembership` is the single server-side chokepoint for **all** content
access — the WS ticket relay (`/api/collab/ticket`) and the member caches
(`/shared-data`, `/shared-canvas`, `/asset`). It now resolves a **pending-only**
membership to `null` (`grantsAccess` = `owner || status==='accepted'`), so a
pending invitee gets a 403 everywhere. The Cloudflare Worker's
`resolveMembership` enforces the same rule independently (the authoritative gate
before it mints a ticket).

Crucially the **roster-read RLS is unchanged** (`private.og_is_member`,
existence-based): a pending invitee can still read their roster row + the project
label, which is exactly how `listInvitesForMe` (the bell) surfaces the invite —
metadata only, no Y.Doc, no tickets, no secrets. So pending is *visible* (bell)
but *not accessible* (no content), and it is **not** a Ground card until accepted
(`listMyProjects` returns owned + accepted only).

### Accept — invitee-only, RLS-safe

Direct `UPDATE` on `og_project_members` is revoked (migration `0011`), so accept
is a `SECURITY DEFINER` RPC `accept_invite(p_project_id)` that flips **only the
caller's own** pending row → accepted, matched by the caller's verified JWT
email **or** uid (so it can neither accept someone else's invite nor enrol a
non-invited caller — UPDATE-only, no INSERT, 0 rows when there's no pending row).
It also binds `user_id` now that the account is known. `POST /api/collab/accept`
calls it; the お知らせ **Join** action runs accept → open → refresh.

`join_with_invite` is re-declared (same jsonb return, no DROP) with one change:
its idempotency branch also flips a coexisting pending email invite → accepted,
so someone invited by email *and* handed a link isn't left stuck pending.

### Cancel — pending-only, link-safe

`POST /api/collab/invite/cancel` → `cancelPendingInvite` is a `status=eq.pending`
scoped owner DELETE: it can only ever drop an **unaccepted** invite (never an
active member), and unlike eviction it does **not** rotate the project's invite
links (a pending invitee never held one — rotating would break the coexisting
quick-share path). Accepted members are still removed via `/api/collab/remove`
(which keeps rotating links).

## Files

- `supabase/migrations/0013_collab_email_invite_pending.sql` — status column +
  `accept_invite` RPC + `join_with_invite` re-declare.
- `src/lib/server/projectMembers.ts` — `status` plumbing; `getMyMembership`
  (access excludes pending); `listInvitesForMe` (pending only); `listMyProjects`
  (accepted-or-owned only); `upsertProjectMembers` (email → pending); new
  `acceptInvite` / `cancelPendingInvite`.
- `server/routes/collab.ts` — `POST /api/collab/accept`, `POST /api/collab/invite/cancel`.
- `worker/src/membership.ts` — Worker access gate excludes pending.
- `src/App.tsx` — お知らせ **Join** = accept → open → refresh.
- `src/components/canvas/CollabInviteDialog.tsx` — email-primary layout,
  Recommended badge, roster pending/accepted badges + cancel/remove.
- `src/lib/types.ts` — `ProjectMember.status`, `CollabAcceptResponse`.
- `src/i18n/messages/projectPanel.ts` — new JA/EN strings.

## Deploy order (HARD dependency)

The `status` column is required by the new code. Apply in this order — the
column default `accepted` makes the DB change non-breaking for any still-running
OLD app/Worker (they ignore the column), so the ordering only protects the NEW
code:

1. **Apply migration `0013`** to Supabase (MCP). Adds the column (backfills
   accepted), the `accept_invite` RPC, and the `join_with_invite` re-declare.
   Run `get_advisors(security)` after — `accept_invite` joins the existing
   `join_with_invite` / `approve_join_request` on the "definer executable by
   authenticated" advisor BY DESIGN (the standard secure-invite pattern).
2. **Deploy the Worker** (`worker/`, `npm run deploy`). Its `resolveMembership`
   selects `status`; against an un-migrated DB that read 400s → everyone 403s
   (fail-CLOSED — an outage, never a leak), so it must follow the migration.
3. **Ship the app.** Hono reads that select `status` fail-safe to `[]` if the
   column is somehow absent (no white screen), but the feature needs the column.

## Security posture (adversarially reviewed — no findings)

- `accept_invite` acts only on the caller's own JWT-derived row → no cross-
  identity accept, no self-enrol (UPDATE-only), no role escalation;
  `set search_path = public`.
- Pending grants zero content access, enforced independently by the server and
  the Worker; the `?? 'accepted'` default can't upgrade a real pending row (the
  column is NOT NULL and every access read includes it).
- No RLS policy is altered/dropped; the HMAC ticket is untouched; grants mirror
  the existing RPCs. **Net effect: strengthened** — an email-invited person who
  used to be an immediate full member is now access-less until they accept.
