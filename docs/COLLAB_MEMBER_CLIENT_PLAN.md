# Realtime collab — CLIENT member-join UX

## STATUS (2026-06-16) — member Board flow BUILT, test-verified

Decisions locked: D1 owner sets a shared **label**; D2 folder-less members get
**Board + Canvas collab only** (Claude/Terminal needs a local checkout); D3 owner
UI first; cache = **A** (mirror to `~/.openground/shared/<id>/`, no work folder);
member view built **now, test-verified** (real 2-user QA after the Worker deploy).

Built + committed on `feat/collab-cf-do` (all tsc/lint/build green, full suite
1522+):
- **Owner**: invite link + shared name (`93a94d1`/`4831c15`).
- **Member foundation** (`af54020`): routes accept `?collabProjectId=` (no path,
  membership-gated); binding → `CollabSource`; `useBoardCollabShared`/
  `useCanvasCollabShared`; `listMyProjects` → `{id,label,owned}`.
- **Member Board view** (`baf8d85`): `SharedProjectPanel` — opens by
  collabProjectId, owns the doc↔state sync (adopt-from-doc; never seed-clobber),
  reuses `BoardModule` (synthetic path-`''` project, member-stub terminal).
- **Member entry** (`5edeed7`): Toolbar "Shared with me" → `CollabSharedDialog`
  (list owned:false + join by code) → opens `SharedProjectPanel`.
- **Cache server** (`686ac69`): `GET/POST /api/collab/shared-data`
  (membership-gated, strict-UUID, separate `~/.openground/shared/` root).

REMAINING: m6 **client** wiring (hydrate cache on open + mirror doc→cache in
`SharedProjectPanel`); **member Canvas** (needs a shared canvas index +
`ProjectCanvas` data injection — a separate piece); a final adversarial review
pass; then the user's Worker deploy + live 2-user QA. MVP simplification: shared
projects live in the "Shared with me" dialog, NOT as cards on the Ground canvas
(a later enhancement — avoids autoLayout/selection/bulk edge cases on path-less
cards).

---

## NEXT: member Canvas (plan — needs one design decision)

Member **Board** is done. Member **Canvas** is the remaining piece and is a
separate build because of one gap: a member must discover **which canvases
exist**. Today the canvas list lives in a per-project local
`canvases-index.json` (read by `ProjectCanvas` via `/api/project/canvases?path=`)
— a folder-less member has neither. Each canvas is already its own Y.Doc (scope
`canvas:<id>`, and `useCanvasCollabShared(collabProjectId, canvasId)` already
exists), so the ONLY missing data is the **shared canvas index** (the list of
`{id, name}`) plus driving `ProjectCanvas` from docs instead of disk.

DECISION NEEDED — where does the shared canvas index live?
- **(A, recommended)** Carry it in the **board doc** as one LWW meta key
  (`m:canvasIndex` = JSON `[{id,name}]`). The board doc is already synced and the
  member already opens it, so members get the list for free. Cost: the OWNER's
  `ProjectCanvas` must publish its canvas-list changes into the board-scope doc
  (a small cross-module write).
- (B) A dedicated **meta doc** (new scope `meta`) carrying `{label, canvasIndex}`.
  Cleaner separation, but a third scope + binding to wire.

DECISION: **A** (chosen 2026-06-16). The canvas index lives on the board doc.

Build status / outline:
- **cv1 — DONE (`03c9915`)**: the data channel. `ProjectData.canvasIndex?:{id,name}[]`
  + `boardDoc` `m:canvasIndex` with a DEDICATED writer/reader. **Two-writer
  invariant** (tested): the index is EXCLUDED from `projectDataToBoardDoc`, so a
  Board-tab full seed (no canvas list) can't LWW-clobber what the owner's Canvas
  tab publishes; `writeBoardCanvasIndex`/`readBoardCanvasIndex` are the only
  writer/reader; `boardDocToProjectData` surfaces it for the member.
- **cv2 — owner publish (next)**: the owner's `ProjectCanvas` must publish its
  canvas list into the board doc. Approach: `ProjectCanvas` opens its OWN board
  binding (`useBoardCollab(project.path)`) ALONGSIDE its per-canvas binding, and
  calls `writeBoardCanvasIndex(boardDoc, list)` whenever its canvas
  list/names change. This covers the Canvas tab (BoardModule unmounted there); the
  Board tab leaves `m:canvasIndex` untouched (cv1 invariant), so no clobber. ⚠️
  Don't route the index through `projectDataToBoardDoc`/server-derive — that
  reintroduces the clobber. Gate on `useCollab().enabled` so the OFF build is
  unchanged.
- **cv3 — member render**: `SharedProjectPanel` gains a Board/Canvas tab switcher.
  The Canvas tab lists `data.canvasIndex` (from the board doc the panel already
  binds); picking one binds `useCanvasCollabShared(collabProjectId, canvasId)` and
  renders `CanvasWorkspace` from that doc. `ProjectCanvas` itself is path-driven
  (loads list+file by `?path=`), so EITHER add a member-mode/DI to it OR render a
  thinner member canvas view straight from the canvas doc — assess which is less
  invasive (ProjectCanvas is not data-prop-driven like BoardModule was, so this is
  the biggest sub-piece).
- **cv4 — cache (option A)** for the active canvas, same pattern as the board
  cache (`/api/collab/shared-data` generalised, or a sibling keyed by canvasId).
- Canvas-element images need R2 (u14) — defer; show placeholders meanwhile.

cv1 is committed + gated; cv2–cv4 are a focused follow-up (ideally verified
against a deployed Worker).

---

## (original plan below)
# Realtime collab — CLIENT member-join UX (plan, decisions pending)

The **server** side of realtime collab is done, hardened, and pushed
(`feat/collab-cf-do`): owner-managed membership, email invite, **link-based
self-join (7-day codes)**, HMAC-ticket WS auth, Cloudflare-DO transport. See
`docs/COLLAB_CF_DO_PLAN.md`. This doc plans the **client** UX that's still
missing and flags the decisions that gate it.

## What exists (server, callable today)

- `GET /api/collab/config` → `{enabled}` (the global gate; default OFF).
- `GET /api/collab/project?path=[&collabProjectId=]` → `{collabProjectId, member}`.
- `GET /api/collab/projects` → `{projects:[{id, name?}]}` — every project the user
  can read (owner OR member). **`name` is an opaque hash, NOT human-readable.**
- `GET /api/collab/ticket?path=&scope=[&collabProjectId=]` → WS ticket.
- `POST /api/collab/invite {path, emails}` · `POST /api/collab/remove {path,email}`.
- `POST /api/collab/invite-link {path}` → `{ok, code, expiresAt}` (owner mints).
- `POST /api/collab/join {code}` → `{ok, collabProjectId, error?}` (logged-in
  redeem; inserts only the caller).

## What's missing (client) + why it's not trivial

The collab binding is **`projectPath`-keyed** (`useBoardCollab(project.path)`,
`useCanvasCollab(path, canvasId)` in `src/lib/collab/RealtimeContext.tsx`) and it
seeds the Y.Doc **from local-disk data**. An invited member has **no local
folder**, so today they have no path, no card on Ground, no data to seed, and no
way to open the project. Closing that gap is the real work, and it forks on a few
product decisions.

### Pieces

1. **Owner invite UI** (contained): a dialog to mint + copy a 7-day code (and
   surface the existing email invite). Small new component; one entry point in the
   per-project surface (`ProjectPanel`). Gated on `useCollab().enabled` so the OFF
   build is unchanged.
2. **Member redeem entry** (contained): a global "Join a shared project" input
   (paste code → `POST /api/collab/join`). Lives on the Ground / toolbar (it's not
   per-project — you don't have the project yet).
3. **Folder-less shared project on Ground** (architectural): represent a joined
   project (collabProjectId, no path) as a card; drive Board/Canvas collab by
   `collabProjectId` (server already accepts `?collabProjectId=`); **skip
   local-disk load/save** when there's no path (the DO's authoritative Y.Doc IS
   the data). Touches `App.tsx` project model, `ProjectCard`, `BoardModule`,
   `ProjectCanvas`, and the binding.

## Decisions that gate the build

### D1 — How is a shared project LABELED for a member?
A member can't see the owner's real project name (we store
`sha256(ownerId+path)` in `og_projects.name` to avoid leaking the local path).
So a shared card has no human label unless we add one.
- **(A, recommended)** Owner sets a **shared display name** when they first create
  an invite — stored in a NEW readable `og_projects.label` column (the *path* stays
  private; the *label* is meant to be seen by collaborators). Clean, owner-chosen.
- (B) Send the local folder **basename** as the label at invite time. Simpler;
  fixed; mildly leaks the folder name.
- (C) Each member **names it locally** on their own side. Most private; no shared
  identity (two members see different names).

### D2 — What can a member DO in a folder-less shared project?
The model is "the place is shared; each person's hands (claude) are their own"
([[project_subscription_only]]). A member without the repo has no cwd to spawn
`claude`.
- **(A, recommended)** **Board + Canvas realtime only.** Terminal/claude is
  disabled for a shared project the member doesn't have locally (no cwd). Matches
  the subscription model exactly. If a member later opens the same repo locally,
  the full experience lights up.
- (B) On join, offer to **clone the repo locally** so the member gets full
  features (incl. terminal). Heavier; pulls git back into the core flow.

### D3 — Scope for THIS round
- **(A, recommended)** Build owner-invite UI **now**; build member redeem +
  folder-less open **after** D1/D2 are settled (it's the part you wanted to QA).
- (B) Build the **whole** member flow now using the recommended D1/D2 answers.
- (C) Plan only; build nothing until reviewed.

## Notes / follow-ups surfaced by the security review
- **Eviction is two steps** for multi-use links: remove the member row AND revoke
  outstanding invite links (else they rejoin with the old 7-day code). Add an
  owner **"revoke invite links"** action (owner-DELETE on `og_project_invites`
  under RLS) as part of the owner-management UI.
- Everything stays behind the OFF gate; the default (no collab env) build ships
  none of this.

## Boundary (user's, unchanged)
`wrangler deploy` the Worker to your CF account + set `OPENGROUND_COLLAB_WS_URL`
and the shared ticket secret on the Hono side; then a real cross-machine 2-user
test. See `worker/README.md`.
