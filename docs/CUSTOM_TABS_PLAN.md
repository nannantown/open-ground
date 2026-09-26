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
- Full-width custom-tab previews. Right-edge terminal docks and post-create
  terminal launch/paste were removed on 2026-09-22. The regular Terminal tab,
  Board task sessions and Swarm are unchanged. Existing dock bindings are not
  resumed or deleted just by opening a tab; explicit module deletion retains
  its existing terminal cleanup.

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

### NENE Microphone Capability (2026-09-22)

An owner-configured library entry may carry `localApp: 'nene-songs'`. This is
not accepted by the general create/update APIs and is not inferred from a tab
label or source text. `localAppFrame.ts` resolves it only to
`http://127.0.0.1:8899/`, never to a caller-provided URL or the host's own origin.
`CustomFrameHost` independently validates that exact URL. The frame receives
`allow-scripts allow-same-origin allow-downloads` and microphone delegation for
that origin. Ordinary custom sources keep `sandbox="allow-scripts"` with no
microphone delegation. Work mode disables the direct integration too.

This is a trusted local app integration, not a relaxation of arbitrary source
sandboxing. Browser/OS microphone permission is still required. A nested opaque
sandbox cannot support getUserMedia, even with an inner `allow` attribute.
Until NENE answers its probe (2xx) the tab shows only "Starting…" while OPEN
GROUND itself starts NENE's serve.js (`POST /api/local-apps/nene-songs/start`,
`src/lib/server/localAppLauncher.ts`: fixed command, no input, registered folder
whose package.json is "nene-songs"), or "Couldn't start" + a reason + Try again.
The module's own source is not shown meanwhile, so no shell command reaches the
owner (owner decision 2026-09-26).
Once connected, transient probe failures do not reload or destroy the document.
Visible direct frames also receive Space/Enter from non-editable host focus.
Existing playback heartbeats keep active recordings and pending saves alive.

NENE's one-track editor, original takes and edit metadata live in the separate
NENE repository. This OPEN GROUND change does not migrate or delete user audio.
`e2e/nene-recording-frame.spec.ts` intercepts every NENE request and uses a fake
browser input; it does not capture the owner's microphone. Actual interface
channel mapping/latency and packaged Electron permissions need a hardware pass.

### Endpoints

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
- `CustomModuleDock.test.tsx`: no dock, launch or paste, including legacy saved
  open docks; explicit deletion still cleans only that module's bindings.
- `CustomTabPickerDialog.test.tsx`: retained library UI.
- `src/App.render.test.tsx`: no submission polling or review settings.
- `server/routes/__tests__/lockdown.test.ts`: local tabs remain available under
  Work mode; the shared network restrictions are unchanged.
- `e2e/local-custom-tabs.spec.ts`: attachment persists through the real project
  API; a fixture-backed installed HTML tab renders, responds to clicks, hot-reloads
  and reopens at 1280px and 390px. This does not test a live role service.

### Results (2026-09-20)

- Full suite: 7,269 passed, 2 skipped across 417 files. TypeScript and build passed.
- ESLint: zero errors, 202 warnings.

### NENE Integration Results (2026-09-22)

- Full suite: 7,287 passed, 2 skipped across 419 files. TypeScript/build passed.
- ESLint: zero errors, 196 existing warnings.
- Real browser: ordinary local tab tests at 1280/390px and fixed-origin NENE
  fake-input permission/keyboard test passed. Previous host fails the new
  direct-frame regression, then the restored implementation passes.
- Development NENE UI/sidecar routes were installed with song, memo and setlist
  hashes unchanged. No published OPEN GROUND release was created by this work.
- Browser checks: 7 passed, including local-tab flows, startup and card difficulty.
- Red baseline: 12 new retirement checks failed against the old implementation;
  after removal the focused suite passed all 128 checks.
- The installed Electron executable ran the new server bundle through two boots
  with an isolated home. Local CRUD, restart persistence, an editing PTY using a
  fake CLI, and preservation of installed-tab source and Persona archives passed.
- No live Claude, external distribution service, newly packaged app UI, release
  or installation was exercised. The installed application is unchanged.
