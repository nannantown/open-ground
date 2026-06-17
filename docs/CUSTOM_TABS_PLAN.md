# Custom Tabs (user-built Modules) — Design & Contract

Status: CONTRACT — this document plus the type/path/id additions in the same
commit are the shared contract between the parallel implementation tracks.
Track agents implement against THIS; do not invent divergent payloads.

## Goal (observable completion criteria)

1. **Owner gate** — when the app-login account holds the `owner` role (see
   Roles below), the per-project tab bar shows a "+" (create tab) affordance.
   Signed-out / role-less accounts: invisible.
2. **Create flow** — "+" opens a dialog (name + description). Save creates
   `~/.openground/custom-modules/<uuid>/` (meta in `index.json`, starter
   `source.tsx`) and the new tab appears in EVERY project's tab bar (global
   scope), appended after the built-ins.
3. **Auto-generate + brush-up** — opening a custom tab as owner shows a right
   sidebar hosting a `claude` PTY cwd'd at the module dir; on first create the
   terminal auto-launches and the name+description prompt is pasted UNSENT
   (bracketed paste, same UX as Board's paste-task). When claude edits
   `source.tsx`, the tab's sandboxed iframe hot-reloads (mtime polling).
4. **Publish** — owner-only "Publish" button pushes the module (meta+source)
   to the Supabase table `og_custom_modules` (insert, or update+version-bump
   when already published).
5. **Marketplace / install** — owner OR tester sees a Marketplace surface
   listing published modules; "Install" copies one locally (origin
   `installed`) so its tab appears. Everyone else sees NO custom-tab UI
   (existing on-disk tabs still render read-only — management UI hidden).
6. **Quality gates** — `npm test` green, `npm run lint` 0 errors,
   `npm run build` succeeds, `validateProjectPath` boundary untouched.

## Roles

Server-side check is the source of truth; client gating is cosmetic.

**Nothing identifying ships in the binary** — there are NO built-in emails
anywhere in the code. The shipped default resolves every account to `'none'`.

- Source of truth: the Supabase table **`og_roles`** (env
  `SUPABASE_ROLES_TABLE` to override). Rows are written ONLY by the owner via
  dashboard/MCP (service-role; the app server never edits the table). A row
  may name a `user_id` or just an `email` — the email form lets the owner
  grant a role before that account's first login.
- Lookup (`src/lib/server/roles.ts` `getCustomTabRole()`): reads the stored
  app-login session (`authStore.readSession()`), gets a fresh access token
  (`supabaseAuth.getFreshAccessToken()`, refreshing + persisting the rotated
  refresh token when stale), then GETs
  `/rest/v1/og_roles?select=role` with `apikey` = anon key and
  `Authorization: Bearer <user JWT>`. RLS (`to authenticated`, matched on
  `auth.uid()` OR the JWT `email` claim, case-insensitive) returns only the
  caller's own row(s); `owner` wins over `tester` when both match. anon sees
  zero rows.
- Caching: in-memory per user id, 5-min TTL, on a `globalThis` singleton
  (survives `tsx watch` reloads). A failed refresh serves the last known role
  rather than yanking the UI away; `'none'` only when nothing better exists.
- Env override (dev/test escape hatch + the owner's offline fallback):
  `OPENGROUND_OWNER_EMAILS` / `OPENGROUND_TESTER_EMAILS` (comma-separated,
  case-insensitive). When either is set the remote lookup is skipped
  entirely. Both default EMPTY.
- Publishing writes no author identity: `og_custom_modules` has no
  `author_email` column (dropped — it was readable through the anon SELECT
  policy column-wide).
- Capability matrix:
  | capability | owner | tester | none |
  |---|---|---|---|
  | see/create/edit local modules | ✓ | ✓ | – |
  | delete a *local* module | ✓ | – | – |
  | sidebar claude terminal + paste | ✓ | ✓ | – |
  | publish | ✓ | – | – |
  | marketplace list + install | ✓ | ✓ | – |
  | delete an *installed* module | ✓ | ✓ | – |
  | render existing on-disk custom tabs | ✓ | ✓ | ✓ |

  A tester now authors tabs locally (build → submit to the owner for review),
  so they may create/edit and drive the sidebar claude terminal — but **editing
  is restricted to `origin:'local'` modules they authored, never an
  `installed` one** (someone else's published artifact). Publishing stays
  owner authority.

## Data layout (global scope, app home)

```
~/.openground/custom-modules/
  index.json          # CustomModuleDef[] (single JSON file, atomic writes)
  <uuid>/
    source.tsx        # framework 'react' (default)  — claude edits THIS file
    source.html       # framework 'html' (alternative; exactly one exists)
```

- ids are `crypto.randomUUID()`; the TAB id shown to the tab system is
  `custom:<uuid>` (see `src/lib/modules/ids.ts` helpers).
- Path builders live in `src/lib/server/paths.ts` (already in this commit):
  `customModulesRootDir() / customModulesIndexFile() / customModuleDir(id) /
  customModuleSourceFile(id, framework) / ensureCustomModulesDir()`.
- Server CRUD module: `src/lib/server/customModules.ts` (Track A). Keep the
  serialized-write-chain pattern from `store.ts` to avoid lost updates.
- **id validation:** every route param id MUST match
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` before
  touching the filesystem (no traversal), AND exist in `index.json`.

## API contract (server/routes/customModules.ts — Track A)

All shapes are in `src/lib/types.ts` (this commit). Role failures → 403
`{ error: 'forbidden' }`; unknown id → 404.

- `GET  /api/custom-modules` → `CustomModulesResponse { role, modules }`
  (any caller; modules read from disk).
- `POST /api/custom-modules` `{ label, description, framework? }` → owner.
  Creates def (origin `'local'`), writes a starter source that renders the
  label + description placeholder, returns the `CustomModuleDef`.
  `label` 1–60 chars; `description` ≤ 4000.
- `GET  /api/custom-modules/:id/source` → `CustomModuleSourceResponse
  { source, mtimeMs }` (any caller — feeds the iframe + hot-reload polling).
- `PUT  /api/custom-modules/:id` `{ label?, description?, source? }` → owner.
- `DELETE /api/custom-modules/:id` → owner; tester allowed ONLY when the
  module's origin is `'installed'`. Removes dir + index entry.
- `POST /api/custom-modules/:id/publish` → owner. Upserts to Supabase via
  SERVICE-ROLE key (server-side only, same env pattern as
  `server/routes/feedback.ts` readConfig): env `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, table env `SUPABASE_MODULES_TABLE` default
  `og_custom_modules`. First publish: INSERT, store returned row id in the
  local def (`remoteId`, `publishedAt`, `version`). Re-publish: UPDATE by
  remoteId, `version+1`. Missing env → 503 `{ error, publishUnavailable: true }`.
- `GET  /api/marketplace` → owner|tester. Reads via ANON key
  (`SUPABASE_ANON_KEY`), returns `MarketplaceListResponse`. Missing env → 503.
- `POST /api/marketplace/install` `{ remoteId }` → owner|tester. Fetches the
  row (anon), writes local def origin `'installed'` (new local uuid, keeps
  `remoteId`) + source file. Installing an already-installed remoteId
  re-writes it in place (update, not duplicate).

Mount the router in `server/app.ts` after `authRoutes`.

### Supabase table (created separately by the orchestrator via MCP)

```sql
create table public.og_custom_modules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  framework text not null default 'react',
  source text not null,
  version int not null default 1,
  author_email text,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.og_custom_modules enable row level security;
create policy "anon can read published modules"
  on public.og_custom_modules for select using (true);
-- no anon insert/update/delete; the owner's server uses the service-role key.
```

## Terminal seam (Track A — server/routes/terminal.ts additions)

The module dir is NOT a registered project, so `validateProjectPath` must not
be loosened. Follow the existing `/api/terminal/setup` precedent (a narrowly
scoped route that never accepts a raw cwd):

- `POST /api/terminal/custom-module` `{ moduleId, cols?, rows? }` → owner.
  Validates `moduleId` (uuid regex + present in index), resolves
  `cwd = customModuleDir(moduleId)` SERVER-SIDE, ensures the dir exists, then
  `launchClaude({ cwd, cols, rows })` (plain claude, no prompt). Returns
  `TerminalInfo`. claude missing → 503 `{ claudeMissing: true }` (same probe
  as `/api/terminal/claude`).
- `POST /api/terminal/:id/paste-custom-module` `{ moduleId }` → owner.
  Builds the brush-up prompt (new `buildCustomModulePrompt` in
  `src/lib/server/pastePrompt.ts` — reuse the bracketed-paste/ESC-strip
  machinery) and injects it UNSENT into the live PTY, exactly like
  paste-task. Prompt content: the tab's label + description + instructions —
  "edit `source.tsx` in the current directory; it is rendered as a React
  default-export component inside a sandboxed iframe with Tailwind classes,
  the app's design tokens and `lucide-react` available; no other imports; the
  preview hot-reloads on every save."

## Client (Track B)

New files under `src/components/canvas/modules/` + `src/lib/modules/`:

- `src/lib/modules/useCustomModules.ts` — hook: fetch
  `GET /api/custom-modules` on mount, expose `{ role, modules, refresh }`.
  Used by `ProjectPanel`.
- **Registry merge** — built-ins stay in `moduleRegistry.tsx`; ProjectPanel
  computes the tab row from `effectiveTabOrder(saved, [...builtinIds,
  ...modules.map(m => customTabId(m.id))])` (tabOrder.ts is now generic over
  string ids — this commit). `PanelView` widens from `ModuleId` to `string`;
  custom tabs render label from the fetched def and a fixed icon (e.g.
  lucide `Puzzle`). Built-in behavior (Ctrl+Tab cycle, drag-reorder
  persistence to `ProjectData.tabOrder`) must keep working with custom ids in
  the list — `persistView`-style validation must accept `custom:*` ids that
  exist in the fetched set.
- `CustomModuleView.tsx` — renders the module: sandboxed iframe whose srcDoc
  comes from `buildScreenSrcdoc(source, framework, 'dark')`
  (`src/lib/screenSrcdoc.ts`, reused as-is). While visible, poll
  `GET /api/custom-modules/:id/source` every 1500 ms (pause when
  `document.hidden`); on `mtimeMs` change, rebuild the srcDoc.
  Owner-only header actions: "Edit with Claude" (toggles sidebar),
  "Publish", "Delete". Tester sees none of these (installed modules get
  "Uninstall" only).
- `CustomTabCreateDialog.tsx` — name + description form. **IME rules:**
  uncontrolled inputs or composition-safe controlled ones; any Enter handling
  must ignore `e.nativeEvent.isComposing`; submit via button / Cmd+Enter
  only. On save: POST create → refresh modules → switch the panel to the new
  tab → auto-open the sidebar, launch the terminal, paste the prompt.
- `CustomTabSidebar.tsx` — right sidebar inside the custom tab view hosting
  the claude PTY (reuse the Board drawer's terminal component pattern —
  `BoardTaskTerminal` / `launchTaskTerminal` in `ProjectPanel.tsx`, but
  calling `/api/terminal/custom-module` + `/api/terminal/:id/paste-custom-module`).
  Keep the live terminal id per moduleId in localStorage
  (`openground.customTab.terminals`) like `TASK_TERMINALS_KEY` does.
- `MarketplaceDialog.tsx` — visible to owner|tester (role from the hook):
  lists `GET /api/marketplace`, Install button → POST install → refresh.
- "+" tab-bar button: rendered in `ViewTabs` (ProjectPanel) only when
  `role === 'owner'`; a marketplace entry point (e.g. small "Market" button
  next to "+") when `role !== 'none'`.
- i18n: put new strings in a NEW file `src/i18n/messages/customTabs.ts`
  following the existing message-file pattern (see `src/i18n/messages/*` and
  how `canvas.ts` is consumed). Do NOT edit `canvas.ts`.
- Interactive elements follow the 5-state rule (default/hover/active/
  disabled/focus-visible) used across the app.

## Security invariants (review checklist)

- `validateProjectPath` untouched; no route accepts a raw filesystem path.
- Module id always regex-validated before any `join()`.
- Role checks enforced SERVER-side on every mutating/privileged route
  (create/put/delete/publish/marketplace/terminal/paste).
- Service-role key never reaches the client; publish/marketplace 503 (not
  crash) when env is missing.
- Custom source renders ONLY inside the existing sandboxed iframe path.
- Paste injection reuses the ESC-stripping bracketed-paste helper.

## Track ownership (parallel worktrees — do not cross)

- **Contract (this commit):** `docs/CUSTOM_TABS_PLAN.md`, `src/lib/types.ts`,
  `src/lib/modules/ids.ts`, `src/lib/modules/tabOrder.ts`,
  `src/lib/server/paths.ts`.
- **Track A (server):** `src/lib/server/customModules.ts`, `roles.ts`,
  `customModulesMarket.ts` (supabase glue), `pastePrompt.ts` (additive),
  `server/routes/customModules.ts`, `server/routes/terminal.ts` (additive),
  `server/app.ts` (mount only), server tests.
- **Track B (client):** `src/components/canvas/modules/CustomModuleView.tsx`,
  `CustomTabCreateDialog.tsx`, `CustomTabSidebar.tsx`,
  `MarketplaceDialog.tsx`, `src/lib/modules/useCustomModules.ts`,
  `src/components/canvas/ProjectPanel.tsx`, `moduleRegistry.tsx` (icon/labels
  for custom ids only), `src/i18n/messages/customTabs.ts`, client tests.
  Track B MUST NOT edit `src/lib/types.ts` or any `server/` file — develop
  against this contract; integration is a later phase.

## Out of scope (this round)

Payments, ratings, module updates/uninstall sync, non-owner publishing,
public marketplace browsing for `none` users, packaging env for end users.

## Per-project attachment & the "+" picker (2026-06-12 dogfood revision)

The library/attachment split. Modules themselves stay USER-level
(~/.openground/custom-modules/); which tabs appear in a given project's tab
row is now a PER-PROJECT choice:

- `ProjectData.customTabs?: string[]` — bare module uuids attached to this
  project. PERSONAL state exactly like `tabOrder` (stays central in
  git-shared mode; sanitised on read like tabOrder; unknown/deleted ids
  ignored). A module appears in a project's row ONLY when listed here —
  creating or installing a module no longer surfaces it anywhere by itself.
- **"+" → picker dialog** (replaces "+ → create dialog" directly): lists MY
  library (label + description preview + origin/version badge + 追加済み
  state). Click an unattached item → append its id to `customTabs`, persist,
  switch the view to that tab. Contains a **「新規タブを作成」command** →
  the existing create dialog; on create the new module is auto-attached to
  the CURRENT project (then the dock/auto-paste setup flow runs unchanged).
  Also the place for LIBRARY-LEVEL destruction: per-item delete (owner,
  two-step confirm; tester sees uninstall on `installed` only) — removes the
  module everywhere (server DELETE, existing route).
- **Tab right-click menu** = 「タブの列から外す」(detach) ONLY: removes the
  id from THIS project's `customTabs` (and its `tabOrder` entry), persists —
  non-destructive, the module stays in the library. The old destructive
  delete/uninstall moves into the picker.
- **Marketplace install** (from inside a project) auto-attaches the
  installed module to the current project.
- Existing data migration: none — `customTabs` starts undefined (= no custom
  tabs attached anywhere). The owner re-attaches via the picker.

## "Everything is a module" + the submission pipeline (2026-06 round)

This round graduates custom tabs from an owner-only internal tool toward an
ecosystem: built-ins are modelled as modules, testers author + submit, and the
owner reviews + publishes. The capability matrix above already reflects it.

### Everything is a module (unified registry + per-project disable)

- A tab is a `ModuleDescriptor` (`src/lib/modules/descriptor.ts`) of one of two
  **kinds**: `native` (Terminal / Canvas / Board — compiled React shipped in the
  binary, the pre-installed default set) or `sandboxed` (`custom:<uuid>` — user
  source in a sandboxed iframe). The registry (`moduleRegistry.tsx`) tags each
  built-in `kind:'native', default:true` and exposes `nativeDescriptors()`; the
  tab row, Ctrl+Tab, drag-order and persistView treat both kinds uniformly. The
  PERSISTENCE layer stays split on purpose — a native has no `CustomModuleDef`
  and never publishes — so `validateProjectPath`, the iframe sandbox and the
  Supabase glue are untouched.
- A native is **disabled, never uninstalled**: `ProjectData.disabledModules?:
  string[]` (personal per-project state like `tabOrder` / `customTabs`) hides a
  built-in from THIS project's row. The "+" picker's **Built-in** section and the
  tab right-click menu toggle it (everyone's right — it's personal layout). The
  **last visible tab can't be hidden** (the floor invariant). Pure helpers:
  `src/lib/modules/nativeEnable.ts`.

### Tester authoring (server gate change)

Authoring opened to testers: `POST /api/custom-modules`, `PUT` (their
`origin:'local'` modules only), and the sidebar-claude terminal routes are now
`owner|tester`. **Publishing official modules stays owner-only.**

### Submission → review → publish

A tester builds a tab, then **submits its source** to the owner, who reviews and
approves (→ published to the marketplace) or rejects. Mirrors the feedback proxy.
Setup + table SQL + env: **`docs/MODULE_SUBMISSIONS_SETUP.md`**.

- Table `og_module_submissions` — RLS **anon INSERT pending-only, no anon
  SELECT** (a private queue, vs `og_custom_modules`' public `anon SELECT`). The
  owner reads/moderates with the service-role key.
- Glue `src/lib/server/customModulesSubmissions.ts`; routes
  `server/routes/moduleSubmissions.ts` (group J): `config` / `POST` submit
  (owner|tester) / `GET` list + `:id` (with source) + `unread` / `approve` /
  `reject`. Review routes gated by service-role + `MODULE_ADMIN_EMAILS` (falls
  back to `FEEDBACK_ADMIN_EMAILS`). **approve** copies the source through the
  existing `publishModule` (INSERT) — the only writer of the public table.
- Client: the custom-tab header shows **"Submit to owner"** for testers
  (`CustomModuleView`); the owner inbox is **Settings → Tab submissions**
  (`ModuleReviewInbox`, modelled on `FeedbackInbox`) with a sandboxed-iframe
  preview + raw source + approve/reject, and a settings-gear unread dot
  (`App.tsx`, the feedback-unread wiring).
- 3-point set: `SubmitModuleRequest` / `ModuleSubmissionItem` / `*Response`
  (types.ts) + `SubmitModuleBodySchema` + `sanitizeModuleSubmission` (schemas.ts,
  the read-side guard) + the row build in the glue.

### Defaults the implementation chose (easy to revisit)

- Submit INSERT is **anon-proxied** (feedback-faithful); `submitter_email` is
  display-only. Trustworthy attribution / read-own-status would mean a JWT +
  per-user RLS upgrade.
- **approve always INSERTs** a fresh marketplace row (no version continuity —
  consistent with "module updates" being out of scope).
- `none` can see the "+" picker (native layout is personal); library
  destruction / create / submit stay role-gated.
