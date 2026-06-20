# Collaboration, zero-config — the canonical sharing design

This is the **canonical design** for how OPEN GROUND shares work between people.
It unifies and supersedes the sharing story that was previously split across two
mechanisms:

- `docs/COLLAB_CF_DO_PLAN.md` — realtime collab transport (Cloudflare Durable
  Objects + Yjs). **Kept and extended** here (the CRDT data model, the flat-map
  mappers, and the Board/Canvas bindings are unchanged).
- `docs/SHARED_DATA_PLAN.md` — "Share via Git" (Board/Canvas data committed into
  the repo under `.openground/`). **Removed** by this plan (Track D). That doc
  becomes history.

**One-line thesis:** there is exactly **one pipe per kind of thing**. Collaboration
*state* (Board/Canvas) flows through collab and is never written into the repo.
The *substance* people actually build (code + docs) flows through Git/GitHub.
*Who* may touch a project is decided by login + membership, enforced by a single
operator-run Worker that members never configure. No knobs, no secrets on a
member's machine, no second sync path for the same data.

> Status (2026-06-20): **design canon, not yet implemented.** The realtime collab
> transport, owner-managed membership, invite links, member client, presence, and
> R2 image sharing already ship on this branch (see `docs/COLLAB_CF_DO_PLAN.md`
> and `docs/COLLAB_MEMBER_CLIENT_PLAN.md`). This plan defines the *zero-config*
> evolution on top of that foundation and the removal of Share via Git. Tracks
> A–E in §4 are the work.

---

## 0. The three-layer separation (the core decision)

Every byte in an OPEN GROUND project belongs to exactly one of three layers, and
each layer has exactly one home and one sync pipe. The product's job is to keep
these layers from leaking into each other.

| Layer | What | Home (canonical) | Sync pipe | Touches the repo? |
|---|---|---|---|---|
| **L1 — State** | Board (kanban cards + notes) and Canvas (elements, images) | CF Durable Object authoritative `Y.Doc` (live); local mirror cache when collab is off | **collab** (CF DO realtime; central cache) | **Never** |
| **L2 — Substance** | The code and the documentation — the actual files of the project | the Git working tree → GitHub | **Git** (the user's existing `git remote` + their own auth) | **Is** the repo |
| **L3 — Identity & Access** | *Who you are* and *who may touch a project* | Supabase (OAuth identity + owner-managed membership) + the operator Worker (short-lived authorization) | loopback Hono → operator Worker / Supabase | No |

The headline is the **L1 / L2 split**:

- **L1 (state) is collab-only and central.** Board and Canvas data is synchronized
  through the realtime engine and cached centrally under `~/.openground/`. It is
  **never** written into the project's working tree, mirroring how Claude Code
  keeps per-project state under `~/.claude/projects/` rather than in the repo.
- **L2 (substance) is GitHub-only.** Code and docs live in the repo and travel
  through ordinary Git. OPEN GROUND never commits L1 state into L2's pipe.
- **L3 (identity & access) is the connective tissue.** It is what lets L1 be
  zero-config: a member proves who they are (L3) and the system grants live access
  to the state (L1) — without the member ever cloning the repo (L2) or holding any
  secret.

### Why Share via Git is removed

"Share via Git" deliberately put **L1 state into L2's pipe** — it committed
Board/Canvas data into `.openground/` inside the repo so collaborators synced it
through `git pull`. That made sense before realtime collab existed, but it now
violates the separation in three concrete ways:

1. **Two pipes for one kind of data.** With collab as the L1 pipe, Share via Git
   is a *second*, conflicting sync path for the very same Board/Canvas state.
   Whichever a teammate uses, the other goes stale; reconciling them is exactly
   the merge pain collab was built to remove.
2. **It muddies "the repo is L2 only."** A clean invariant ("OPEN GROUND never
   writes into your working tree") is far easier to reason about — for users and
   for the path-security boundary — than "…except when shared mode is on."
3. **Collab no longer needs it.** In the realtime model `collabProjectId =
   og_projects.id` (a Supabase row), not a git marker — so the original reason
   git-share existed (somewhere durable to anchor the shared identity) is gone.

So Share via Git is retired (Track D). Collaboration on *state* is collab;
collaboration on *substance* is Git. Nothing does both.

### What this plan changes vs. what ships today

| Property | Ships today | This plan |
|---|---|---|
| L1 sync paths | collab **and** Share via Git (two) | collab only (one) |
| Repo contains L1 state | optional (shared mode) | never |
| Ticket secret location | shared **Hono ↔ Worker** (both hold it) | **operator Worker only** |
| Who mints the ticket | the owner's local Hono | the operator Worker |
| Who checks membership at connect | the owner's local Hono | the operator Worker |
| Worker provisioning | each deployment provisions its own | one operator Worker for everyone |
| Member setup to join | login + paste invite code | login + click invite link (deep link) |
| Invite permission modes | one (open, multi-use, 7-day) | owner picks **open** or **approval**, with caps |

---

## 1. The layers in detail

### L1 — State (Board / Canvas)

- **Canonical store while collaborating:** the CF Durable Object's authoritative
  `Y.Doc`, one per room. Room key = `collabProjectId + ":" + scope`, scope =
  `board` or `canvas:<id>`. (Unchanged from `COLLAB_CF_DO_PLAN.md`.)
- **Canonical store when solo / collab off:** the central per-project data dir
  `~/.openground/projects/<uuid>/` (`tasks.json`, `canvases/…`). A solo user is
  100% local — no backend.
- **Local mirrors are caches, never sources of truth:**
  - Owner: the central per-project dir doubles as the offline cache; the live
    `Y.Doc` wins on reconnect.
  - Member: `~/.openground/shared/<collabProjectId>/` (the "home cache",
    option A in `COLLAB_MEMBER_CLIENT_PLAN.md`) — a folder-less member has no
    working tree, so this central mirror lets the panel open instantly/offline.
- **Invariant:** L1 is never written into the project's working tree. The
  path-security boundary (`validateProjectPath`) and the data resolvers
  (`projectDataPath.ts`) only ever address `~/.openground/…`, never repo paths,
  for state.

### L2 — Substance (code + docs)

- **Home:** the Git working tree; **shared via** the user's existing `git remote`
  and their own git auth. OPEN GROUND has no opinion here and adds no machinery —
  it never runs git on the user's behalf for state anymore (that was Share via
  Git). Members who also want the *code* clone the repo themselves, the normal way.
- **Docs are L2 too.** This very file, `CONCEPT.md`, the plan docs — all live in
  the repo and travel through GitHub. There is no "share a doc through collab"
  path; docs are substance.
- **Release topology (unchanged):** code lives in `origin` = PMmap (private);
  public distribution is the `open-ground` repo (clean history). See
  `docs/DISTRIBUTION.md`.

### L3 — Identity & Access

- **Identity = Supabase OAuth** (google/github), server-side PKCE in
  `server/routes/auth.ts`. The loopback Hono owns the session; access tokens stay
  server-side and are not handed to the browser (preserved — see §2).
- **Membership = Supabase, owner-managed RLS, no service-role.** Tables
  `og_projects` (`id` = collabProjectId, `owner_id`, `name` = `sha256(ownerId + ':' + canonicalPath)`
  so the owner's local path never leaks, `label` = the member-visible display
  name) and `og_project_members` (`project_id`, `user_id`, `email`, `role`). The
  `private.og_is_member()` SECURITY DEFINER helper breaks policy recursion and
  stays off PostgREST. `anon` is revoked from all collab tables.
- **Authorization = short-lived HMAC ticket**, minted only after a membership
  check, verified at the edge. In this plan the mint+check move to the operator
  Worker (§2).

---

## 2. Zero-config membership (the operator Worker model)

**Goal (user-visible):** a member joins a project with nothing but a login and an
invite link. They never install a Worker, never paste a secret, never edit env,
never clone the repo. The only secret in the whole system lives on the operator's
single Worker, and that Worker is what decides — against Supabase — whether a
given person may open a given room.

### Baseline: how it works today (self-host model)

Today the HMAC ticket secret (`OPENGROUND_COLLAB_TICKET_SECRET`) is **shared
between the owner's local Hono and the Worker**. The browser asks its *local*
Hono for a ticket; the local Hono checks membership in Supabase (RLS, caller's
JWT) and mints the ticket; the Worker only verifies the HMAC. That is great for
**self-hosting** (point your own Cloudflare account at it), but it is **not
zero-config for an operator-run service**: every deployment must provision a
Worker and copy the same secret onto the Hono side. You cannot ship the operator's
secret onto every user's machine.

### Target: single operator Worker, secret only on the Worker

One Worker, run by the operator, holds the **only** copy of
`OPENGROUND_COLLAB_TICKET_SECRET`. Minting and the membership check both move into
that Worker. The member's machine holds no collab secret at all.

To keep the existing **"Supabase tokens never reach the browser"** property while
moving the mint off the user's machine, the loopback Hono becomes a thin
**authenticated relay** to the Worker's authorize endpoint. The client-facing API
(`GET /api/collab/ticket`) and its response shape are unchanged.

```
Browser ──GET /api/collab/ticket?path|collabProjectId=…&scope=…──▶ loopback Hono
                                                                      │
        (server-to-server; the user's Supabase access token           │
         is presented here and never sent to the browser)             ▼
loopback Hono ──POST /authorize { accessToken, collabProjectId, scope }──▶ operator Worker
                                                                      │
                                          1. check og_project_members membership by
                                             forwarding the caller JWT to PostgREST
                                             under RLS  ◀── "Worker verifies Supabase"
                                             (no secret; optional JWKS pre-check)
                                          2. if member: mint HMAC ticket with the
                                             Worker's own secret (~60s TTL)
                                                                      │
operator Worker ──{ wsUrl, room, token, expiresAt }──▶ loopback Hono ──▶ Browser
                                                                      │
Browser ──WS /parties/og-collab-doc/<room>?token=<ticket>──▶ operator Worker
          Worker onBeforeConnect verifies the HMAC (Web Crypto), binds
          pid:scope === room; the DO still never talks to Supabase.
```

**Why the membership read needs no service-role and no second secret on the
Worker:** exactly as the loopback Hono does today, the Worker performs the
`og_project_members` lookup by **forwarding the caller's own access token** to
PostgREST (`Authorization: Bearer <token>` + the public `anon` key). PostgREST
validates the token and owner-managed RLS does the authorization — member rows
come back only if the caller is a member. The Worker never inspects the token and
never holds a Supabase key; the HMAC ticket secret remains its only secret.
*Optional hardening:* if the Supabase project enables **asymmetric** JWT signing
(publishes a JWKS), the Worker can verify the token's signature locally first and
reject forgeries before the network hop — a latency/abuse optimization, **not** a
prerequisite (the RLS round-trip already authenticates the token).

### The deltas from today (precise)

1. **Secret centralizes.** `OPENGROUND_COLLAB_TICKET_SECRET` is removed from every
   user's Hono env and exists only on the operator Worker.
2. **Mint moves** from the local Hono (`server/routes/ticket.ts` `mintTicket`) to
   the Worker's `POST /authorize`.
3. **Membership check moves** from the local Hono to the Worker (the user's
   "Worker verifies Supabase membership").
4. **The loopback `GET /api/collab/ticket` becomes a relay** — it attaches the
   server-held Supabase access token and calls the Worker; it no longer mints.
5. **The Worker checks membership by forwarding the caller JWT** to PostgREST under
   RLS, so it needs no Supabase secret — optionally pre-verifying the JWT signature
   via a public JWKS if asymmetric signing is enabled.
6. **Unchanged on purpose:** the browser still calls only the loopback
   `GET /api/collab/ticket`; it still receives `{ wsUrl, room, token, expiresAt }`;
   it still never sees the HMAC secret or a Supabase token; the DO still never
   talks to Supabase; tickets are still ~60s and auto-refresh via partysocket
   `params`; R2 image GET/PUT continue to gate on the same ticket against the
   project's `board` room.

### Security properties preserved

- **No service-role key anywhere.** Owner-managed RLS still does authorization.
- **Tokens never reach the browser.** The Supabase access token only travels
  loopback-Hono → operator-Worker (TLS, server-to-server); the browser only ever
  holds a ~60s HMAC ticket.
- **Fail-closed on revocation.** Tickets are short-lived; a removed member stops
  getting fresh tickets within one TTL. The member-side membership cache keeps its
  existing 2×TTL fail-closed discard so an offline evicted member cannot linger.
- **OFF guarantee intact.** `GET /api/collab/config` still returns `{enabled}`
  only when collab env + a signed-in session are present; default builds load no
  collab chunks.
- **New trust concession (honest delta).** Routing the handshake through the
  operator Worker means that Worker briefly sees each member's Supabase access
  token (post-TLS) to perform the membership read, and could replay it against
  Supabase within the token's short lifetime. A self-hosted Worker already had
  this; for the operator-run Worker it is a real concession the self-host model
  lacked. It is bounded by the token's TTL and by RLS (the token grants only what
  its own policies allow), and the Worker persists nothing.

---

## 3. Figma-style link invites

**Goal (user-visible):** sharing a project feels like sharing a Figma file. The
owner clicks "Share", picks who may join and how, and gets a link. The recipient
clicks the link, OPEN GROUND opens, and — depending on the owner's choice — they
either join instantly or land in the owner's approval queue. The owner sees a live
roster, can revoke any single link or any single person, and can reset the link in
one click.

### 3.1 Owner picks the permission mode

Per invite link, the owner chooses one of:

- **Open (default).** Anyone signed-in who opens the link joins immediately as a
  member. Default expiry **7 days**.
- **Approval-required.** Opening the link creates a **pending join request**; the
  owner approves or denies it from the roster. Nobody gains access until approved.

This is new — today there is exactly one (open, multi-use) mode. Schema and RPC
changes back it:

- `og_project_invites` gains `mode text not null default 'open' check (mode in
  ('open','approval'))`.
- A new owner-managed table `og_project_join_requests { id, project_id, invite_id,
  user_id, email, status text check (status in ('pending','approved','denied')),
  created_at }`. Owner-only RLS for SELECT/UPDATE/DELETE; a caller-only
  `request_join(token)` SECURITY DEFINER RPC (mirrors `join_with_invite`: inserts
  **only the caller** as a pending request, email lowercased + non-null).
- Approval is owner-only: `approve_join_request(id)` (or an owner-RLS insert into
  `og_project_members` + delete of the request). Denials delete/flag the request.

`join_with_invite(token)` branches on the invite's `mode`: `open` → insert the
member directly (today's behavior); `approval` → defer to `request_join`.

### 3.2 Bounding a link: single-use or member cap

The owner can bound how far a link spreads. New columns, enforced atomically in
the join/request RPC:

- `og_project_invites.max_uses int` — `null` = unlimited (today's behavior),
  `1` = **single-use**, `n` = at most n redemptions. `use_count int not null
  default 0` is incremented in the same transaction as the join; the RPC rejects
  once `use_count >= max_uses`.
- `og_projects.member_cap int` — `null` = unlimited; otherwise the join/approve
  path rejects once the roster reaches the cap. (Project-level so "max N
  collaborators" holds regardless of how many links exist.) In approval mode the
  cap is enforced at **approve time** — the pending queue may hold more than the
  cap; the owner simply cannot approve past it.

The owner picks **single-use or a member cap** (or neither) when creating the
link; both are off by default to preserve the current frictionless flow.

### 3.3 Deep link — `openground://` launches the app

Today the invite is an opaque code the recipient **pastes** into their own OPEN
GROUND, because a local app has no web origin to deep-link. This plan adds a real
deep link so the link *opens the app*:

- **Protocol registration:** Electron registers `openground://` via
  `app.setAsDefaultProtocolClient('openground')`, plus an electron-builder
  `protocols` entry so packaged builds claim it.
- **Delivery into the running app:**
  - macOS: `app.on('open-url', (e, url) => …)`.
  - Windows/Linux: the URL arrives as an argv to a second instance →
    `app.on('second-instance', (e, argv) => …)` (which already raises the window),
    plus first-launch argv parsing.
- **The link itself:** `openground://join?code=<token>`. For recipients who don't
  have the app, the human-facing share URL is an **https landing page** (on the
  marketing site) that detects the OS and either bounces to the `openground://`
  link (app installed) or shows a download CTA (not installed). The raw
  `openground://join?code=…` is available for direct use.
- **On open:** the app focuses (single-instance), routes to the join flow,
  pre-fills the code in the "Shared with me" dialog, then — **open mode** →
  auto-join; **approval mode** → submit a request and show "awaiting approval".
- **Paste-code stays as a fallback** (the code is still the underlying secret), so
  nothing regresses if protocol handling is unavailable.
- **Token exposure:** the code *is* the secret, so a link is as sensitive as the
  access it grants. The https bounce page must not log the query string, and risky
  links are bounded with single-use or approval mode + Reset link. (Same posture
  as today's pasteable code — the deep link merely carries it.)

> Note: this relaxes the explicit "no deep link" decision in
> `COLLAB_CF_DO_PLAN.md`/`COLLAB_MEMBER_CLIENT_PLAN.md`. That decision was an
> artifact of "local app = no web origin"; a registered custom scheme + an https
> bounce page resolves it without a hosted web app for the product itself.

### 3.4 Roster, individual revoke, Reset link

The owner's collaborators panel (today's roster + presence) gains:

- **Pending requests** (approval mode): a list with Approve / Deny per request.
- **Per-link list with individual revoke.** Today revoke is project-wide (delete
  all invites). Add revoke **by invite id** so the owner can kill one leaked link
  while keeping others. (Adds an owner-RLS delete scoped to a single
  `og_project_invites` row.)
- **Reset link** — one action that **revokes the active link(s) and mints a fresh
  one**, returning the new code/URL. The revoke + mint runs as one server-side
  transaction, so there is never a window with no valid link, and an in-flight
  redemption of the old code either completes before the revoke or fails closed
  after it. (Equivalent to "revoke + New link" today, collapsed into one button.)
- **Member cap display** and remaining-uses on a bounded link.
- **Individual member revoke** (exists today): removing a member row. The
  **eviction caveat stands** — to fully evict someone, remove the member *and*
  revoke outstanding links (or Reset the link), else they rejoin with the old code.

### 3.5 What exists vs. what's new

| Capability | Today | This plan |
|---|---|---|
| Mint invite link (256-bit code) | ✅ | reuse |
| 7-day expiry (DB default) | ✅ | reuse (now per-mode) |
| Roster + presence avatars | ✅ | reuse, extend with requests/links |
| Individual **member** revoke | ✅ | reuse |
| Project-wide link revoke | ✅ | reuse (now also per-link) |
| **Open vs approval** mode | ❌ | **new** (`mode` col + requests table + RPC) |
| **Single-use** / max-uses | ❌ | **new** (`max_uses`/`use_count`) |
| **Member cap** | ❌ | **new** (`og_projects.member_cap`) |
| **Per-link** revoke | ❌ | **new** (delete by invite id) |
| **Reset link** (one action) | ❌ | **new** (revoke + mint) |
| **Deep link** `openground://` | ❌ | **new** (Electron protocol + routing) |
| Owner picks permission in UI | ❌ | **new** (mode + caps picker) |

---

## 4. Implementation — Tracks A–E and merge order

The work splits into five tracks chosen so their file surfaces overlap as little
as possible. Each track is its own feature branch + PR, verified green
(`tsc` / `npm test` / `eslint`, plus the Worker miniflare test where relevant)
before it merges.

### Track A — Operator Worker & secret centralization (zero-config core)

Implements §2. The heart of zero-config.

- **Worker:** add `POST /authorize` — check `og_project_members` membership by
  forwarding the caller JWT to PostgREST under RLS (optional public-JWKS signature
  pre-check), then mint the HMAC ticket. Keep `onBeforeConnect` HMAC verification
  and the R2 asset gate unchanged.
- **Hono:** turn `GET /api/collab/ticket` into a relay that attaches the
  server-held Supabase access token and calls the Worker; remove `mintTicket`/the
  local secret dependency. Keep the response contract identical.
- **Supabase:** no change required — the Worker forwards the caller JWT to
  PostgREST under RLS (as the Hono relay does today). *Optional:* enable
  asymmetric JWT signing + publish a JWKS so the Worker can pre-verify token
  signatures before the membership round-trip.
- **Config/env:** remove `OPENGROUND_COLLAB_TICKET_SECRET` from the Hono side;
  document that it lives only on the operator Worker. `GET /api/collab/config`
  enablement no longer requires the secret locally (it requires the operator
  Worker URL + a signed-in session).
- **Files:** `worker/src/*`, `server/routes/ticket.ts`, `server/routes/collab.ts`
  (ticket relay), `src/lib/collab/provider.ts` (unchanged contract), `worker/README.md`.
- **Observable result:** a member with only a login and a valid membership opens a
  room with **no secret on their machine**; the Worker is the only secret-holder
  and the only thing that read Supabase to authorize.

### Track B — Invite system v2 (Figma-style, minus deep link)

Implements §3.1, §3.2, §3.4.

- **Supabase:** migration adding `og_project_invites.mode` / `max_uses` /
  `use_count`, `og_projects.member_cap`, the `og_project_join_requests` table +
  RLS, and the `request_join` / `approve_join_request` RPCs; update
  `join_with_invite` to branch on `mode` and enforce caps atomically.
- **Server:** `src/lib/server/collabInvites.ts` + `server/routes/collab.ts` —
  create-with-mode/caps, per-link revoke, Reset link (revoke+mint), list links,
  list/approve/deny requests.
- **Client:** `CollabInviteDialog.tsx` — mode picker, caps inputs, per-link list
  with revoke, Reset link button, requests queue. `CollabSharedDialog.tsx` —
  "awaiting approval" state.
- **Types:** `src/lib/types.ts` invite/request contracts.
- **Observable result:** the owner creates an approval-required, single-use, or
  capped link; recipients are gated accordingly; the owner manages links and
  requests from the roster.

### Track C — Deep link (`openground://`)

Implements §3.3. Independent of B's schema; touches Electron + routing.

- **Electron:** `setAsDefaultProtocolClient`, `open-url` (macOS), `second-instance`
  + first-launch argv (Win/Linux), electron-builder `protocols`. Keep the existing
  strict external-URL allow-list intact.
- **Renderer:** a deep-link handler that routes `openground://join?code=…` to the
  join flow and pre-fills `CollabSharedDialog`.
- **Landing:** an https bounce page (OS-detect → `openground://` or download CTA)
  on the marketing site (`landing/`, deployed manually via `npm run deploy:landing`).
- **Observable result:** clicking an invite link opens OPEN GROUND on the join
  screen with the code pre-filled; paste-code still works as fallback.

### Track D — Share via Git removal

Implements §0's retirement. Large but mostly mechanical; high blast radius, so it
lands **after** the collab suite is proven. The full inventory is the appendix.

- **Delete:** `src/lib/server/{sharedData,gitShare,shareAutoSync}.ts`,
  `src/lib/{shareClient,shareUx,boardDigest}.ts`,
  `src/components/canvas/ShareStartDialog.tsx` (after relocating its 4 reused
  exports — see appendix), `server/routes/share.ts`, the git-share tests, and
  `docs/SHARED_DATA_PLAN.md` + `docs/SHARE_UX_FLOWS.md`.
- **Edit (collapse the `isShared()` branch to the central arm):**
  `projectData.ts`, `canvasData.ts`, `canvasImages.ts`, `taskAssets.ts`,
  `server/routes/terminal.ts` (make the task-assets `--add-dir` unconditional),
  `ProjectPanel.tsx` (remove Share button + Sync/Live block + share state/dialogs,
  **keep** collab Invite + workflow settings), `BoardModule.tsx` (drop `shared`
  prop + welcome strip), `types.ts` (remove `Share*` interfaces + `ProjectConfig.autoSync`,
  **keep** `ProjectConfig`), `src/i18n/messages/projectPanel.ts` (git-share keys),
  the git-shared paragraph in `CLAUDE.md`.
- **Wiring:** unregister `shareRoutes` in `server/app.ts`.
- **Observable result:** no "Share via Git" / Sync UI anywhere; OPEN GROUND never
  writes into a project's working tree; collab is unaffected; `tsc`/test/lint green.

### Track E — 0.10.0 release

Last. Ships A–D.

- **Docs sync:** add this file as canon; update `CLAUDE.md` to the three-layer
  model (drop the git-shared exception); correct `docs/COLLAB_IMAGE_SHARING_PLAN.md`
  (it still describes image sharing as future work and names the R2 binding
  `ASSETS` — it shipped, and the binding is `ASSET_BUCKET`); mark `COLLAB_PLAN.md`
  / `SHARED_DATA_PLAN.md` as history.
- **Version:** bump `package.json` `0.9.1 → 0.10.0`; bilingual changelog.
- **Release pipeline (unchanged, `docs/DISTRIBUTION.md`):** land on `origin`
  (PMmap) main → snapshot to `open-ground` via `git commit-tree` (tree must match)
  → FF push `<sha>:main` → push tag `v0.10.0` → CI (`release.yml`) builds signed
  arm64/x64 dmg + Windows exe into a **draft** release → after CI green and **user
  approval**, publish with bilingual notes.
- **Observable result:** `v0.10.0` is downloadable; members join with login + a
  clicked link; Share via Git is gone.

### Merge order & rationale

```
A (zero-config core)
   └─▶ B (invites v2) ─┐
   └─▶ C (deep link) ──┼─▶ D (Share via Git removal) ─▶ E (0.10.0 release)
                       ┘
```

1. **A first.** B and C both assume the operator-Worker authorization model; A
   establishes it and is the smallest, highest-leverage change.
2. **B and C after A, in near-parallel.** B is mostly Supabase/server/invite-dialog;
   C is mostly Electron/routing/landing — nearly disjoint, with one shared file
   (`CollabSharedDialog.tsx`: B adds the "awaiting approval" state, C pre-fills the
   code), so C merges after B. That also makes the invite-link format (mode/caps)
   final before the deep link encodes it.
3. **D after the whole collab suite (A–C).** Two reasons: (a) **don't remove the
   replacement's predecessor until the replacement is proven** — collab must be
   solid before Share via Git goes, so there's never a window where neither path
   works; (b) D heavily edits `ProjectPanel.tsx`, which B also touched (the Invite
   button lives there) — sequencing B → D keeps those edits clean instead of two
   tracks fighting over one file.
4. **E last.** Release only after A–D are merged and green: the user-visible
   story ("login + link to join, no Share via Git") is only true once D lands.

This is exactly the order the canon mandates: **collab suite → Share removal →
0.10.0 release.**

---

## 5. What stays the same (reused, unchanged)

- The **CRDT data model**: flat-map per-field LWW (`t:<id>:<field>` board,
  `e:<id>:<field>` canvas), whole-value LWW for notes/order; one `Y.Doc` per
  `(collabProjectId, scope)`.
- The **transport**: CF Durable Object + `y-partyserver` `YServer`/`YProvider`,
  WebSocket Hibernation, SQLite persistence, the `og-collab-doc` party name.
- The **HMAC ticket wire format** and ~60s TTL, the `onBeforeConnect` HMAC check,
  and `pid:scope === room` binding.
- **Owner-managed membership** RLS, `private.og_is_member`, the
  `join_with_invite` secure-invite pattern (extended, not replaced).
- The **member client**: folder-less synthetic project, Board+Canvas realtime,
  home cache, canvas list from the board doc's `m:canvasIndex`, Terminal/claude
  gated (no cwd), presence (email local-part only, symmetric on both tabs).
- **R2 image sharing** (already implemented): bucket `og-collab-assets`, binding
  `ASSET_BUCKET`, key `<pid>/<canvasId>/<assetId>`, Worker as the sole R2 gateway
  (GET member/owner, PUT owner-only, 10 MB, `image/*`), gated on the project's
  `board`-room ticket. (Asset eviction/purge remains the one deferred piece.)
- **Personal-only state** stays central in all modes: `tabOrder`, `customTabs`,
  canvas `viewport`/`activeId`, `ProjectLaunchPrefs`, selection/edit state,
  terminal slots.

---

## 6. Boundary & open questions

- **Operator responsibilities** (not a member/owner concern): run the single
  Worker, hold `OPENGROUND_COLLAB_TICKET_SECRET`, provision R2 (`og-collab-assets`),
  set `OPENGROUND_COLLAB_WS_URL` (optionally enable Supabase asymmetric JWT
  signing). These are
  build/deploy inputs baked for distribution; a member configures nothing.
- **Self-host still possible:** Track A's Worker is the same artifact; a self-host
  user runs their own Worker with their own secret and points the build at it.
  Zero-config is the *default operator-run path*, not the *only* path.
- **Local signature pre-check is optional, not required.** The Worker authorizes
  by forwarding the caller JWT to PostgREST under RLS (no secret either way), so it
  works with the current HS256 setup unchanged. Asymmetric JWT signing (a public
  JWKS) only *adds* the ability to reject forged tokens locally before the
  membership round-trip; the Worker still never holds a Supabase secret.
- **Approval-mode notifications:** the owner sees pending requests in the roster;
  push/desktop notification of a new request is a follow-up, not a blocker.
- **Asset eviction:** purging R2 objects for a removed member/project is still
  deferred (unreachable without a valid ticket, so it is a cost, not a leak); an
  owner-side "purge shared assets" sweep is future work.
- **Member discovery on Ground:** members reach shared projects via the "Shared
  with me" dialog, not a Ground card (today's MVP simplification); promoting a
  joined project to a Ground card is a possible later refinement.
- **Deep-link landing depends on the marketing page.** The https bounce page lives
  in `landing/` and deploys only via manual `npm run deploy:landing` (not the
  release pipeline), so the "click → app opens" path for users without the app
  depends on that page being current. The raw `openground://` link and the
  paste-code fallback do not.

---

## Appendix — Share via Git removal inventory (Track D)

The single biggest trap: **`sharedData.ts` (DELETE, git-share) ≠ `sharedCache.ts`
(KEEP, collab member cache)**. Realtime collab has **zero** dependency on the
git-share modules; verify that before deleting anything.

**Delete wholesale**
- `src/lib/server/sharedData.ts` (seam), `gitShare.ts` (engine),
  `shareAutoSync.ts` (auto-sync engine).
- `src/lib/shareClient.ts`, `src/lib/shareUx.ts`, `src/lib/boardDigest.ts`
  (`boardDigest`'s only consumer is `ProjectPanel.tsx`'s `doSync` — gut that Sync
  block first so `tsc` stays green).
- `server/routes/share.ts` (and its registration in `server/app.ts`).
- Tests: `gitShare.test.ts`, `shareAutoSync.test.ts`, `projectDataShared.test.ts`,
  `canvasShared.test.ts`, `server/routes/__tests__/share.test.ts`,
  `shareClient.test.ts`, `shareUx.test.ts`, `boardDigest.test.ts`.
- `docs/SHARED_DATA_PLAN.md`, `docs/SHARE_UX_FLOWS.md`.

**Relocate before deleting `ShareStartDialog.tsx`** (4 symbols consumed by KEPT
code — move to a neutral module first):
- `FIELD_INPUT_CSS` (used by `CollabInviteDialog.tsx`, `CollabSharedDialog.tsx`).
- `MembersField`, `TargetBranchField`, `useProjectBranches` (used by the kept
  workflow settings in `ProjectPanel.tsx`).

**Edit (collapse `isShared()` to the central arm; do not delete the file)**
- `src/lib/server/projectData.ts` — drop shared read/write arms and the
  migrate-to/from-shared helpers; **keep** all central I/O, CAS, `taskCounts`, and
  the **`validateProjectPath` re-export** (the path-security middleware needs it).
- `src/lib/server/canvasData.ts` — drop shared arms in `canvasesDir` /
  `readCanvasesIndex` / `writeCanvasesIndex` / `setActiveCanvas` + shared
  order/marker/migrate helpers.
- `src/lib/server/canvasImages.ts` — `assetsDir()` → always central; **keep**
  `CANVAS_ASSETS_SUFFIX` / `centralCanvasAssetsDir` / `deleteCanvasAssetsDir`.
- `src/lib/server/taskAssets.ts` — `taskAssetsDir()` → always central.
- `server/routes/terminal.ts` — the `isShared` guard (~:185) pre-authorizing
  central task-assets for `claude --add-dir` becomes **unconditional** (kept
  feature; don't just delete the block).
- `src/components/canvas/ProjectPanel.tsx` — remove the **Share button**, the
  `{shareStatus?.shared && …}` **Sync/Live block**, all share state/effects/handlers,
  and the inline `ConflictResolveDialog` + `UnshareConfirm` (they live here, not as
  separate files); the `ShareStartDialog` / `ConflictResolveDialog` / `UnshareConfirm`
  renders; the `共有` team section + share CTA in `ProjectSettingsDialog`.
  **Keep** the collab Invite button, `CollabInviteDialog`, and the workflow
  settings (targetBranch + assignee roster).
- `src/components/canvas/modules/BoardModule.tsx` — drop the `shared?: boolean`
  prop and the "shared welcome strip" (note: line that reads `data.config?.members`
  for the welcome heuristic only — `ProjectConfig.members` itself stays).
- `src/lib/types.ts` — remove `ShareEnableConfig`, `ShareStatus`,
  `ShareAutoStatus`, `ShareConflict`, `ShareSyncResult`, and
  `ProjectConfig.autoSync`; **keep** `ProjectConfig` (reused by prompt-building +
  collab) and `ProjectData.config`.
- `src/i18n/messages/projectPanel.ts` — remove the contiguous git-share blocks
  (the `// Git share` section) and the scattered git-share settings keys; **keep**
  the `// Realtime collaboration` block and all `collab*` / workflow keys.
- `CLAUDE.md` — remove the "Exception — git-shared mode" paragraph.

**No change (collab — KEEP):** `CollabInviteDialog.tsx`, `CollabSharedDialog.tsx`,
`CollabPresence.tsx`, `SharedProjectPanel.tsx`, `src/lib/collab/*`,
`src/lib/server/sharedCache.ts`, `server/routes/collab.ts`.

**Edit (kept features whose tests also covered shared mode):**
`server/routes/__tests__/taskAsset.test.ts`, `projectDataCas.test.ts`,
`worktreeCleanup.test.ts`, `gitBranches.test.ts`, `reviewWorktree.test.ts` — keep
the central-mode coverage, drop the shared-mode cases/imports.
