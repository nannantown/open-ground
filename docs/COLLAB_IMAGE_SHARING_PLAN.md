# u14b — Collab image sharing (Cloudflare R2)

Status: **planned, not implemented. Blocked on a user-provisioned R2 bucket.**
Canon for the rest of realtime collab: `docs/COLLAB_CF_DO_PLAN.md` +
`docs/COLLAB_MEMBER_CLIENT_PLAN.md`. This doc covers ONLY image binaries.

## The gap u14b closes

Canvas **image** elements (`type:'image'`) store their bytes on the *owner's*
local disk at `<project>/.openground/canvases/<canvasId>-assets/<assetId>.<ext>`,
served by the loopback route `GET /api/canvas/asset?path=&canvasId=&assetId=`
(`server/routes/canvas.ts` → `src/lib/server/canvasImages.ts`). The shared Y.Doc
carries only the `assetId` *reference*, never the bytes.

A folder-less collab **member** has no local copy of those bytes and the asset
route requires a real registered `path`, so today (**u14a**, shipped) the member
sees a neutral "Image not synced" placeholder (`ImageView.tsx`, gated on
`projectPath === ''`). u14b makes the bytes actually reach members.

Mock / Screen elements are self-contained `srcDoc` (no asset fetch) — unaffected.
Board (kanban) cards have **no** image attachments in the current model (the
task-attachments feature was removed in the terminal-only purge), so u14b is
**canvas-image-only**. (Re-verify before implementing; if board attachments ever
return, they reuse the same seam.)

## Why R2 (not Supabase Storage)

Migration `0005_og_projects_owner_managed.sql` **dropped** the v1 Supabase
Storage bucket + its `storage.objects` RLS policies on purpose: under the v2
Cloudflare-DO architecture, **Cloudflare R2 replaces it** (R2 has *zero egress
fees*, and it lives on the same CF account that already runs the collab Worker).
The `CanvasElement.storageKey` field (`src/lib/types.ts`) is reserved for the R2
object key but is **not yet wired**.

## Data model

- Reserved field already present: `CanvasElement.storageKey?: string`.
- R2 object key: **`<projectUuid>/<canvasId>/<assetId>`** (projectUuid =
  `og_projects.id` = the room's project id; matches the ticket's `pid` scope).
- The Y.Doc carries `storageKey` (a short string), never bytes — same principle
  as the local `assetId`.

## Transport: bytes flow owner → R2 → member, always gated by the Worker

The browser must never hold R2 credentials. The collab **Worker**
(`worker/src/index.ts`) already owns the HMAC-ticket gate
(`worker/src/ticket.ts`, `verifyTicket`) and will own an **R2 binding**. Add two
HTTP routes to the Worker's `fetch` handler, matched BEFORE
`routePartykitRequest`:

- `PUT /assets/<pid>/<canvasId>/<assetId>` — **owner upload**. Verify ticket
  (`?token=`), require `role === 'owner'` and `pid` match, enforce
  `content-type: image/*` + a size cap (e.g. 10 MB), then `env.ASSETS.put(key,
  body, { httpMetadata })`.
- `GET /assets/<pid>/<canvasId>/<assetId>` — **member/owner download**. Verify
  ticket, require membership of `pid`, then stream `env.ASSETS.get(key)` with a
  `cache-control: private` header. (Optional later optimization: return a
  short-lived **presigned** R2 URL via the S3 API so the bytes go browser↔R2
  directly instead of through the Worker. Streaming through the Worker is fine
  for the MVP — images are small.)

Reuse the existing ticket exactly (no new auth). Scope can be the board room
(`<pid>:board`) so one ticket covers all of a project's assets, or per-canvas —
pick board-scope for simplicity (a member of the project may see any of its
canvases).

`worker/wrangler.toml` **and** `worker/wrangler.jsonc` (both are kept in sync —
see the header comment in wrangler.toml) gain:

```toml
[[r2_buckets]]
binding = "ASSETS"
bucket_name = "og-collab-assets"
```

User provisioning (the blocking step): `wrangler r2 bucket create og-collab-assets`.

## Client wiring — preserve the OFF-bundle guarantee

The hard constraint (proven by build-grep in u18): the default / collab-OFF
build must not bundle yjs/y-partyserver/partysocket, and `ImageView.tsx` is in
the **main** chunk. So ImageView must NOT import any collab/transport module.

Mirror the existing **loopback-proxy** pattern so ImageView stays dumb:

1. **Loopback proxy routes** in Hono (`server/routes/collab.ts`), server-side,
   gated by collab config (404 when collab is OFF):
   - `GET /api/collab/asset?<source>&canvasId=&storageKey=` — membership-gated;
     server mints a ticket (it holds the secret) and fetches the Worker `GET
     /assets/...`, streaming bytes back. ImageView uses THIS url — same shape as
     the local `/api/canvas/asset`, no client transport import.
   - `POST /api/collab/asset?<source>&canvasId=&assetId=` — owner-only; streams
     the local asset bytes up to the Worker `PUT /assets/...`.
2. **`ImageView.tsx`** resolution order (keys off element fields + projectPath
   only — no collab context needed; the route self-gates):
   - `element.storageKey` present → `src = /api/collab/asset?...&storageKey=...`
     (with `onError` → fall through to the next option, then placeholder).
   - else `assetId` + non-empty `projectPath` → local `/api/canvas/asset` (today).
   - else (member, not-yet-uploaded) → the u14a "not synced" placeholder.
3. **Owner upload trigger** — new lazy module `src/lib/collab/assetSync.ts`
   (imported only inside the enabled+owner branch, like `provider.ts`): on
   opening/editing a SHARED canvas, sweep image elements that have an `assetId`
   but no `storageKey`, `POST /api/collab/asset` to upload, then write
   `storageKey` into the Y.Doc (so members resolve it). A sweep-on-open also
   backfills images added before the project was shared. Throttle/dedupe so the
   same asset uploads once.

## Eviction / cleanup (note, not MVP)

When a member is removed or invite links are revoked, R2 objects are NOT deleted
(they're only reachable with a valid membership ticket, so this is a cost, not a
leak). A future owner-side "purge shared assets" sweep can `env.ASSETS.delete`
by `<pid>/` prefix. Out of scope for u14b MVP — just log what's left.

## Verification plan (when unblocked)

- Worker: extend `worker/test/local.mjs` (miniflare, no CF login) with R2 PUT/GET
  round-trip + ticket/role/scope rejection (401/403) — mirrors the existing
  ticket tests.
- Unit: `assetSync` sweep picks exactly the not-yet-uploaded assets; ImageView
  resolution order (storageKey → local → placeholder) incl. `onError` fallthrough.
- i18n parity; tsc/lint/build green.
- **OFF guarantee:** build-grep the main chunk for `partysocket`/`y-partyserver`
  and confirm `assetSync` lands only in a lazy chunk (same check as u18).
- Real 2-user QA (after `wrangler deploy` + bucket): owner adds an image to a
  shared canvas → member sees it render (not the placeholder); both directions.

## Boundary (user)

1. `wrangler r2 bucket create og-collab-assets` on the owner's CF account.
2. Add the `[[r2_buckets]]` binding to both wrangler files, `wrangler deploy`.
3. (Hono env already covers the ticket secret + WS URL from the base collab
   setup — no new server env needed for u14b.)
