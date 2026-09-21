# Public Product Scope

Owner decision, 2026-09-21. This is a source change, not a release or a data
migration. New experimental features should start owner-only; public promotion
is an explicit product decision after verification.

## Visible Surfaces

- Public: Ground/project management, Board, Terminal, existing safety controls,
  settings, usage, stop/recovery and backups.
- Public project tabs have a fixed order: Board, Terminal, then optional Swarm.
  Adding, hiding and reordering tabs are owner-view controls only. Generate
  description remains available to everyone. Feedback opens from Ground only;
  Settings retains the owner's incoming-feedback inbox, not a duplicate composer.
- With Swarm enabled, Board hides the manual run-defaults strip as well as the
  per-card manual run settings. Both use the same capability that routes Run to
  a Swarm worker (not whether the autonomous engine is currently running).
  Disabling Swarm restores the saved defaults and disclosure preference; this
  visibility change does not alter launch settings or runtime controls.
- Swarm availability: unchanged. The existing public macOS opt-in remains optional, with its
  warning. Existing owner/local unlocks remain. Windows availability is unchanged.
- All new Swarm managers and workers use SDK. There is no runtime selector for
  either audience. Legacy manager settings remain inert and existing conversation
  data is preserved. Supply/ordinary terminals and public Swarm opt-in are unchanged.
- App owner: per-project Canvas, Research, local custom tabs and WordPress
  settings, global/project Skills management, and automatic daily fuel reports
  and improvement proposals, in addition to the public surfaces and experiments.
- Ground drawing tools start collapsed behind Edit layout. Selection, moving
  projects, existing elements and grouping remain available; keyboard selection
  of a drawing tool also reveals the palette. The project Canvas is unchanged.
- Tester and signed-out sessions do not get these owner surfaces. Swarm's local
  unlock and public opt-in do not confer the app-owner role.

`/api/experiments.eligible` is the existing server-resolved owner decision.
`moduleRegistry.tsx` declares each native module's explicit audience; its gate
drives the row, picker, keyboard cycling and mounted content. App passes the
same owner decision to project/settings/manual surfaces and the iframe host.
Login changes invalidate the prior account's gate before a new response arrives.

## Preservation

This is visibility control, not deletion or a new API security boundary.
Existing local storage formats remain. In particular,
no Canvas files/assets, research reports/credentials, custom-module sources or
metadata, WordPress credentials/ledger, or project attachments are migrated or
deleted. The app does not erase existing remote WordPress drafts either.

The public tab list ignores saved ordering and hidden-module preferences without
rewriting them. Those preferences and attachments survive public-user edits;
an inaccessible saved active tab falls back visually without overwriting that
preference. Owner view restores the saved layout, including hidden public tabs.

Public sessions do not load the custom-tab library or mount the Research/Canvas
surfaces or research settings checks. Closing owner access destroys hosted
iframes/playback, not their source files. WordPress background sweeps re-check
the actual owner role and pause otherwise, leaving the pending ledger intact.
Existing explicitly started terminal/AI jobs are not killed by a role change.
Automatic fuel reporting checks the actual owner role each tick before reading
or updating its sentinel. Existing reports, notifications and blocked proposal
cards are retained. CLI skill files, the Swarm toolkit, token meters and quota
safety remain available independently of the Skills management UI. The unused
legacy open-app menu and GET/POST/PUT `/api/project/open` are removed (404).
Open in editor, its `/api/project/open/pick` chooser, and legacy stored app
preferences are retained.

Description refreshes discard reads whose saved baseline changed while they
were in flight; a late pre-generation poll cannot replace the generated text.
Ground and the project header use the same language fallback, including when
only a generated language field survives. This does not prevent deliberate
backup restoration or change the stored description format.

## Owner Preview

The owner-only Owner view / Public view switch appears on Ground and local
project headers (`OwnerViewSwitch.tsx`). App derives visible capabilities from
the real role plus this window-local choice. Public preview hides owner tabs,
Skills, owner settings, manual chapters and the feedback inbox; Swarm follows
the public macOS opt-in, not the owner's experimental/local unlock.

Switching does not write settings, change the authenticated role, delete data,
or pause running work. Returning to Owner view restores hidden saved tabs. A
reload or account change resets preview. This is a feature-display preview of
the owner's existing data, NOT a sandbox or another user's account: actions on
visible data are real actions. Owner background jobs still use the actual role.
Shared-project collaboration remains governed by its existing membership rules;
return to Ground to switch display mode from a shared project.

## Verification

- Registry and tab-order unit tests cover public/owner visibility and hidden IDs.
- Settings tests cover owner-only controls, public Swarm opt-in and preserving
  hidden WordPress values during unrelated saves.
- `useExperiments.test.tsx` covers account changes and stale owner responses.
- `CustomFrameHost.test.tsx` covers closing background playback on access loss.
- `blogPublish.test.ts` covers no background requests or saved-data loss for
  public/tester sessions, and resuming the same pending report as owner.
- `e2e/public-product.spec.ts` checks real project/Canvas readback at desktop and
  narrow widths, saved-view restoration for the owner, and the public Swarm toggle.
- `e2e/local-custom-tabs.spec.ts` and `e2e/canvas.spec.ts` retain owner UI coverage.

Role responses in browser fixtures are controlled; live account-provider behavior
and a newly packaged GUI release still require release acceptance testing.

### Initial Public-Scope Verification (2026-09-21)

- TypeScript and build passed. ESLint: no errors, 202 existing warnings.
- Full Vitest run: 7,282 passed, 2 skipped across 418 files.
- Playwright: 17 passed (public/owner visibility, legacy data readback, public
  Swarm opt-in, local custom tabs, Canvas editing, Board difficulty and smoke).
  Desktop and narrow screenshots were inspected.
- Before the implementation, the changed tests detected public tabs/settings,
  hidden-order loss and non-owner background publishing. Separate mutation runs
  detected a stale account gate and retained background playback; restored code
  passed. One intermediate full run overlapped Playwright's output-directory
  recreation and tripped the repository-root fence; the final full run was
  repeated after Playwright finished and passed.
- The final bundled server was run under the installed Electron runtime with an
  isolated HOME, dummy roles and no live model/service. Public and owner boots
  preserved the project layout, Canvas, research report, module index/source and
  WordPress settings; public Swarm opt-in resolved correctly. This was a runtime
  probe, not an installation or a newly packaged GUI acceptance test.
- No release, push, installed-app update or real-user data migration was performed.

### Cleanup and Preview Verification (2026-09-21)

- TypeScript and build passed; ESLint: no errors, 196 existing warnings.
- Full Vitest: 7,289 passed, 2 skipped across 419 files. The first full run
  identified one stale home-inventory entry after removing a JSX comment; the
  inventory was updated to match the source and the full run repeated green.
- New regression tests failed before implementation for public Skills entries,
  missing preview, expanded Ground tools and non-owner automatic fuel reports.
  Fuel tests retain an existing blocked proposal, notifications and sentinel,
  then verify reporting resumes under the owner role.
- Playwright: 19 passed, covering owner/public preview at 1280/390px, unchanged
  project/Canvas data, no settings/auth writes from switching, tab restoration,
  public Swarm opt-in, collapsed tools, local custom tabs, Canvas and Board.
- The installed Electron runtime ran the new bundle in two isolated boots:
  public fuel sentinel unchanged, owner catch-up observed, global/project skill
  files and previous saved data intact. This is not packaged-GUI acceptance.
- Japanese preview screenshots at 1280/390px were also inspected against the
  actual role resolver with dummy local auth. Live auth-provider verification,
  a packaged release and installation remain outside this task.

### Fixed Tabs and Description Retention (2026-09-21)

- TypeScript and build passed; ESLint: no errors, 193 warnings.
- Full Vitest: 7,291 passed, 2 skipped across 419 files. New tests failed before
  the fixes for public layout controls, duplicated feedback, retired routes and
  disappearing descriptions. Removing the response-order guard also made all
  three targeted description ordering tests fail; restoring it passed.
- Playwright: 20 passed. Desktop/narrow screenshots were inspected. Saved owner
  layouts/Canvas survived fixed public tabs and preview switching. The real
  description job used the fake CLI through a PTY, persisted both languages and
  stayed visible after a delayed old response, Ground navigation and reload.
- Two isolated boots using the installed Electron runtime retained the generated
  description, layout, Canvas, research, custom tabs, skills, WordPress settings
  and legacy app preferences. Retired app-menu APIs returned 404. No live model,
  remote service or real-user data was used; no release or installation occurred.

### Swarm-Aware Manual Defaults (2026-09-21)

- Only the board-wide manual defaults display changed. Runtime switches, Swarm
  sub-tab ordering, execution routing and stored preferences remain unchanged.
- A mounted BoardModule regression failed before the visibility gate and passed
  after it; enabling/disabling Swarm restores values and disclosure state with
  no writes. Full Vitest: 7,292 passed, 2 skipped across 419 files.
- TypeScript/build passed; ESLint: no errors, 193 existing warnings. Final
  Playwright: 13 passed, including 1280/390px visibility and real saved-data
  readback, normal task execution, public preview and Swarm opt-in.
- Screenshot review found pre-existing narrow-screen overflow in the manual
  permissions select. A bounds assertion reproduced it before constraining the
  labels/selects; the final browser run and inspected screenshots pass. The
  first browser attempt also required correcting its label locator to use the
  combobox's accessible name. No user data or installed application was changed.
