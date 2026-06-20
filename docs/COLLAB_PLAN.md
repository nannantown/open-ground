# Realtime Collaboration (CRDT + Supabase) — design & status

OPEN GROUND's Board and Canvas can be **co-edited in realtime** by multiple
people, while each person's `claude` PTY stays **100% local** to their machine.
The slogan: **the *place* (Board/Canvas data) is shared; the *hands* (claude
execution) are each user's own.** This is the structural advantage over
Notion/Figma AI — collaborators each spend their OWN Claude subscription, so the
service operator carries no AI cost for a "everyone has AI" multiplayer surface.

This doc is the canon for the collab layer. It supersedes the audit's original
plan where they differ (see **Architecture decision** below).

## Status (v1)

Implemented, feature-flagged OFF by default, zero regressions (full suite green):

| Unit | What | State |
|---|---|---|
| u1 | deps: yjs, y-protocols, @supabase/supabase-js | ✅ |
| u2 | `types.ts` collab contract + `CanvasElement.storageKey` + marker `collabProjectId` | ✅ |
| u3 | Supabase: `og_project_members` (+`og_is_member`), `og_doc_snapshots`, realtime broadcast RLS | ✅ (advisor-clean) |
| u4 | private Storage bucket `og-collab-assets` + RLS | ✅ |
| u5 | `GET /api/auth/realtime-token` + `/realtime-config` (the client-JWT seam) | ✅ |
| u6 | `projectMembers.ts` membership resolver + service-role upsert | ✅ |
| u7 | `server/routes/collab.ts`: config / project / invite | ✅ |
| u8 | pure Y.Doc mappers (`ydoc/boardDoc/canvasDoc.ts`) | ✅ |
| u9 | client transport (`provider.ts` + `yProvider.ts`) | ✅ |
| u10 | `RealtimeContext.tsx` + `useBoardCollab`/`useCanvasCollab` | ✅ |
| u12 | Board ↔ Y.Doc binding (`BoardModule.tsx`) | ✅ |
| u13 | Canvas ↔ Y.Doc binding (`ProjectCanvas.tsx`) | ✅ |
| u14 | canvas images → Supabase Storage | **DEFERRED** (bucket + `storageKey` field ready; upload/render wiring pending — images still sync via git) |
| u15 | presence (cursors / avatars) | **DEFERRED** (design below; not yet implemented) |
| u11, u16 | central server collabHub + snapshot bridge | **DEFERRED** — see **Architecture decision** |

## Architecture decision (deviation from the audit)

The audit assumed a **single central server** acting as a headless Yjs peer and
the snapshot authority. OPEN GROUND's reality breaks that assumption:

- Every user runs their **own local Hono server** (loopback). There is no shared
  server process.
- The Supabase **service-role key lives only on the owner's machine** (never
  shipped in the public build), so only the owner could ever write snapshots.

So v1 is **client-driven**, which is simpler *and* more correct here:

1. Each client **seeds its Y.Doc from its own local disk** (the project's
   `.openground/` git-shared files, already on disk because collab requires a
   shared project). No Postgres snapshot needed for initial state.
2. Clients **converge peer-to-peer** over a Supabase Realtime **broadcast**
   channel (the Yjs state-vector handshake + live update relay).
3. Each client **persists its own doc back to local disk** through the EXISTING
   `writeProjectData` / canvas POST path, so **git-share remains the durable,
   offline, cross-session layer** exactly as before.

Consequence: the **server `collabHub` (u11)** and the **`og_doc_snapshots`
write path (part of u16)** are **deferred**. The snapshot table exists as an
optional future cache (faster cold-join when no peer is online); v1 doesn't
write or read it. git-share covers the offline gap the snapshot would have.

## Data model (what syncs, what doesn't)

One `Y.Doc` per `(collabProjectId, scope)`, `scope ∈ {board, canvas:<id>}`.

- **Encoding = FLAT keys on ONE `Y.Map` per scope** (`ydoc.ts`). Each card/
  element field is its own key (`t:<id>:<field>` for board, `e:<id>:<field>` for
  canvas); the id order is a single LWW JSON value `m:order`; board `notes` is a
  single LWW string `m:notes`; description/config are LWW keys.
  **WHY (load-bearing):** collab is client-driven — each client builds its doc
  from its OWN disk and they merge over the wire. Yjs only converges when docs
  share key/op identity; independently-constructed NESTED Y types (a Y.Map per
  card) and SEQUENCES (Y.Array / Y.Text) DUPLICATE ids or drop a whole side under
  LWW. Flat string keys merge by key (per-field LWW), which DOES converge under
  independent construction. Guarded by the "two INDEPENDENTLY-seeded docs
  converge to the union, no duplicates" tests in `docMappers.test.ts`.
- **Honesty about merge granularity:** this is **per-field LWW, not
  per-character**. Different fields of the same card both survive; the SAME field
  edited concurrently *before peers have synced* is last-writer-wins. **`notes`
  and item `order` are whole-value LWW** — concurrent free-text editing or
  concurrent reorder resolves last-writer-wins (NOT char-merge, NOT move-aware).
  Cross-session/offline divergence is still resolved by **git rebase** as before.
- Whole arrays/objects (attachments, dependsOn, run, layout, config) = one JSON
  value (LWW).
- **NEVER in any doc** (stays central/personal): `tabOrder`, `customTabs`, canvas
  `viewport` + chats + `activeId`, `ProjectLaunchPrefs`, selection/editing state,
  terminal slots, `ProjectData.updatedAt`. This preserves the existing
  central-vs-shared contract verbatim.

The mappers are **pure** and used by client only in v1; seeding is **idempotent**
(re-applying identical data emits zero Y updates) — that's what makes "mirror
every local persist into the doc" loop-safe.

### CRDT ↔ git-share ↔ binding (loop-safety)

- Local edit → existing persist (local disk + undo) → `seed(next)` into the doc →
  Yjs broadcasts the diff. The seed transaction carries `ORIGIN_SEED`.
- Peer edit → applied to the doc with `origin = provider` → `onRemote` fires
  (ORIGIN_SEED is filtered out) → the merged state is fed through the SAME
  `persist`, so the component's **existing external-adoption path** renders it
  (Board: drops local undo like any external change; Canvas: CanvasWorkspace
  adopts via the `canvas` prop). Re-seeding the merged state is a no-op (the doc
  already has it) → no broadcast loop.
- **Offline / cross-session divergence** is resolved by **git rebase exactly as
  today** (`shareResolve`); Yjs never offers concurrent-edit resolution UI.

## Transport, auth & security

- **Channel**: `supabase.channel('og:<collabProjectId>:<scope>', {config:{private:true, broadcast:{self:false}}})`. ONE shared supabase client (one WebSocket) per session; one channel per doc.
- **Client JWT seam** (the one deliberate boundary break vs. "tokens never reach
  the client"): `GET /api/auth/realtime-token` hands the loopback SPA the user's
  OWN, already-RLS-scoped access token. Low-risk: loopback origin + single local
  user + the token only grants what the user's memberships already allow. The
  client refreshes ~60s before expiry and calls `realtime.setAuth`.
- **Membership = the RLS allowlist** (`og_project_members`). `og_is_member(uuid)`
  (SECURITY INVOKER, self-scoped) gates every collab object: the snapshot table,
  the broadcast `realtime.messages` policies (topic→project_id via `split_part`,
  fail-closed on malformed), and the Storage bucket. Writes to membership are
  **service-role only** (owner machine).
- **collabProjectId**: a stable cross-user id minted into the git-share marker
  (`.openground/openground.json`) and synced via git, so both machines agree on
  the channel/membership key despite different local registry UUIDs. Minted +
  owner self-enrolled on first `GET /api/collab/project`; collaborators added by
  `POST /api/collab/invite` (owner, by email).
- **Advisors**: after all DDL, `get_advisors(security)` shows **zero NEW
  findings** (only the pre-existing feedback/waitlist anon-insert + leaked-
  password warnings remain, untouched). No `with_check(true)` on any collab
  table; `(select auth.uid())` form avoids the `auth_rls_initplan` perf lint.
- **v1 collab requires Share-via-Git** (that's where collabProjectId + the
  durable fallback live). Central-only collab is future work.

## Feature flag & the OFF guarantee

- Server: `OPENGROUND_REALTIME=1` AND `SUPABASE_URL`/`SUPABASE_ANON_KEY` (or
  `SUPABASE_PUBLISHABLE_KEY`) AND a signed-in session ⇒ `GET /api/collab/config`
  returns `{enabled:true}`. Default build: unset ⇒ `{enabled:false}`.
- Client: `RealtimeContext` statically imports only React + erased types. ALL
  heavy modules (`supabase-js`, `yjs`, the mappers) load via `await import()`
  **inside the enabled branch only**.
- **Verified** (`npm run build:web`): yjs (92 kB) and supabase (204 kB) are
  separate lazy chunks; the main `index` chunk contains **zero** yjs/supabase
  internals and `index.html` does **not** preload the collab chunks. So a
  collab-OFF load never fetches or executes them, and the single-user Board/
  Canvas path is byte-for-byte unchanged (the full existing suite — 1446 tests —
  runs with collab OFF and stays green).

## Images

Canvas images already work in shared mode by riding the git repo
(`.openground/.../assets/`). For collab, a **private Storage bucket
`og-collab-assets`** (RLS by membership) + `CanvasElement.storageKey` exist so a
pasted image can later be uploaded once and fetched by peers via a signed URL
instead of waiting for a git sync. **DEFERRED (u14):** the upload path
(`assetSync.ts`) and `ElementView` preferring `storageKey` over the local
`assetId` are NOT yet wired — until then, collab images sync via git-share like
today. When built, bytes will NEVER enter the Y.Doc — only the `storageKey`.

## Presence

Realtime **Presence** on the same channel (no extra socket): each peer publishes
`{userId, name, avatarUrl, color, cursor?, selection?}`; cursors/selection are
ephemeral, never persisted, never `noteSharedWrite` (so they can't leak into
git). This is the human-visible "who's here" layer (Figma cursors ≈ OG's
per-card/element presence). **DEFERRED (u15)** — not yet implemented; there is
no `presence.ts` or cursor overlay yet.

## Known v1 limitations (accepted; surfaced by the adversarial reviews)

- **Per-field / whole-value LWW**, not per-character / move-aware. Concurrent
  edits to the SAME field, to `notes`, or to item `order` before peers sync are
  last-writer-wins; git rebase remains the cross-session resolver.
- **Periodic re-sync is O(N²)** in broadcast traffic for N concurrent peers on
  one doc (each broadcasts a state vector every 15s; behind peers reply with a
  diff). Fine for small teams; for large rooms, jitter the interval or gate it on
  a detected gap.
- **Canvas seeds per gesture-commit** (every settled `onCanvasChange`),
  reconciling the whole element collection. Fine at human edit rates; debounce if
  a pathological drag shows up.
- **Cold-bootstrap race**: two peers opening a never-before-synced shared project
  in the same instant each seed independently; flat-key LWW still converges to
  the union (no card loss), but a same-field divergence resolves LWW.
- **No membership revocation UI** yet (invite-only; `upsertProjectMembers` is
  merge-only) — a `leave`/`revoke` route is future work.
- **Snapshot table unused in v1** (clients seed from local disk; git-share is the
  durable layer) — kept for a future fast cold-join cache.

## How to turn it on (operator)

1. Set `OPENGROUND_REALTIME=1` + `SUPABASE_*` in `.env.local` (owner needs
   `SUPABASE_SERVICE_ROLE_KEY` to invite/seed).
2. Sign in (app login). Enable **Share via Git** on the project.
3. Open the project once (mints `collabProjectId`, self-enrols the owner).
4. `POST /api/collab/invite {path, emails}` for collaborators; commit/push so
   they pull the marker. They sign in + open the shared clone → realtime.
