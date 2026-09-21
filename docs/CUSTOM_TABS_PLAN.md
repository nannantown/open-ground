# Local Custom Tabs

Current contract after the distribution retirement on 2026-09-20. The filename
is retained for existing references; this describes the implementation, not a
marketplace roadmap. No release or migration is implied by this source change.

## What Remains

- A local library of React (`source.tsx`) and HTML (`source.html`) tabs.
- Attach/detach per project, tab ordering and native-tab visibility settings.
  Detaching a tab does not delete its source or library entry.
- Sandboxed iframe rendering through `CustomFrameHost` and its global host.
  Source changes hot-reload; polling pauses while the tab is hidden.
- A Claude editing terminal through `CustomModuleView` and the
  `TerminalDock` in `EmbeddedClaudeTerminal.tsx`.
  Terminal creation and reuse retain their existing role checks and cleanup.

## Storage and Permissions

The library lives in `~/.openground/custom-modules/index.json`. Each UUID has a
directory containing its source. Project preferences store attached module IDs;
no files are added to the registered repository. Index writes are serialized,
and path-taking module operations validate UUIDs before resolving a directory.

Roles still come from `getCustomTabRole`; removing distribution does not grant
new authoring rights. Since 2026-09-21 the application surfaces custom tabs only
for the app owner (see `PUBLIC_PRODUCT_SCOPE.md`). Existing list/source APIs and
their compatibility permissions remain; hiding the UI is not an API lockdown.
Owners can
create, edit and delete any module. Testers can create local modules, edit local
modules, and delete installed modules, but cannot edit installed modules or
delete local originals. The server, not just the UI, enforces these rules.
`origin` is the permission discriminator; it is not a per-author identity check.

Existing `origin: 'installed'`, `remoteId`, `publishedAt` and `version` values
remain valid legacy metadata. Existing files are not migrated or deleted.

## Local API

- `GET /api/custom-modules`: `{ role, modules }`.
- `POST /api/custom-modules`: create from label, description and framework.
- `GET /api/custom-modules/:id/source`: source and modification time.
- `PUT /api/custom-modules/:id`: update label, description or source.
- `DELETE /api/custom-modules/:id`: stop its terminals and delete the local module.
- Custom-module terminal and paste routes remain in `server/routes/terminal.ts`.

Labels are trimmed and limited to 1-60 characters; descriptions to 4,000.

## Removed

Marketplace browsing/install, publishing, submission, approval/rejection,
review inbox and its polling, distribution schemas, and remote service adapters
are removed. Their former API paths return 404, regardless of role or legacy
configuration. `marketAvailable` is no longer part of the list response.
Remote Supabase tables, historical migrations and previously uploaded data are
untouched. Removing these clients is not a remote-data deletion operation.

## Verification

- `server/routes/__tests__/retiredMarketplace.routes.test.ts`: retired endpoints
  are absent, no distribution requests occur, and legacy installed files survive.
- `server/routes/__tests__/customModules.test.ts` and
  `src/lib/server/customModules.test.ts`: local CRUD, validation and role rules.
- `server/routes/__tests__/customModuleTerminal.test.ts`: editing-terminal paths.
- `CustomModuleDock.test.tsx` / `CustomTabPickerDialog.test.tsx`: retained UI.
- `src/App.render.test.tsx`: no submission polling or review settings.
- `server/routes/__tests__/lockdown.test.ts`: local tabs remain available under
  Work mode; the shared network restrictions are unchanged.
- `e2e/local-custom-tabs.spec.ts`: attachment persists through the real project
  API; a fixture-backed installed HTML tab renders, responds to clicks, hot-reloads
  and reopens at 1280px and 390px. This does not test a live role service.

### Results (2026-09-20)

- Full suite: 7,269 passed, 2 skipped across 417 files. TypeScript and build passed.
- ESLint: zero errors, 202 warnings.
- Browser checks: 7 passed, including local-tab flows, startup and card difficulty.
- Red baseline: 12 new retirement checks failed against the old implementation;
  after removal the focused suite passed all 128 checks.
- The installed Electron executable ran the new server bundle through two boots
  with an isolated home. Local CRUD, restart persistence, an editing PTY using a
  fake CLI, and preservation of installed-tab source and Persona archives passed.
- No live Claude, external distribution service, newly packaged app UI, release
  or installation was exercised. The installed application is unchanged.
