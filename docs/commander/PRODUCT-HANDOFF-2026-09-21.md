# Product Simplification Handoff and Board Audit

Date: 2026-09-21. Requested by the owner so Claude can resume with the current
product scope after the weekly usage reset. This is a handoff and backlog audit,
not authorization to dispatch workers, publish a release or resume the engine.

Subsequent owner decision on the same date: release and local update are now
authorized, followed by a read-only Claude handoff. Automatic worker dispatch
and engine restart remain outside scope. The snapshot below describes the
pre-release state; confirm the installed version and upstream refs before resuming.

## Current Status: Released, Installed and Acknowledged

- [OPEN GROUND 0.11.115](https://github.com/nannantown/open-ground/releases/tag/v0.11.115)
  was published on 2026-09-21 at 08:39 UTC. The release source is `13d9103c`
  on private `origin/main`; the public snapshot/tag is `87c3f0b7`. Their trees
  were identical before publication. All pushes were fast-forward, and public
  snapshot metadata uses the GitHub noreply identity.
- Final private CI (`35577830516`), public CI (`35577912860`) and both release
  platform builds (`35577946947`) passed. The build was deliberately held as a
  draft until the signed macOS artifact passed acceptance, then published.
- The downloaded arm64 DMG's own app reported 0.11.115 and passed signature and
  Gatekeeper notarization checks. Its bundled Electron executable and server
  ran the real SDK against an offline CLI in isolated public/owner homes:
  legacy history resume, singleton reuse, input delivery, stop/reap and data
  retention passed. This is packaged-runtime evidence, not live-model Swarm
  work or Windows hardware QA.
- The owner's installed app now reports 0.11.115 from `/api/health`, started at
  08:45:07 UTC. The first update attempt returned to 0.11.114: the registered
  app-specific ShipIt service had zero runs. Starting that existing service
  and repeating the normal update completed installation and relaunch. No
  security policy was bypassed and no data was deleted. This was an operational
  recovery; it does not establish or fix the underlying service-start cause.
- Before/after API comparison preserved all 45 registered projects and the
  complete OPEN GROUND project document (337 cards). Hash comparison preserved
  all 13 files captured under the Persona/you-corpus, custom-module and Ground
  canvas paths. Private before/after snapshots are retained outside Git.
- After that comparison, the context-cap and difficulty cards were moved from
  review to done: both worker commits are now ancestors of `origin/main`.
  The Board contains 331 done, 2 todo and 4 blocked cards. Original notes,
  dependencies, other cards and old worker worktrees remain. The old fuel
  proposal is still awaiting the owner's retirement decision.
- A live Claude conversation, launched through the updated app's ordinary
  Terminal, read all four handoff/scope/release documents and the actual Board.
  Its reply confirmed the scope, remaining tasks, preserved data and waiting
  for the owner, ending with `HANDOFF_ACK_011115`. That reply is saved in the
  blocked handoff card `fba3b9e5-9218-4bab-a743-3a786319a7f6`. The Board was
  unchanged by Claude; only the operator then appended this receipt.
- At handoff verification (08:52 UTC), the OPEN GROUND project's engine was
  stopped, with no manager or supply desk. The handoff dispatched no workers.
  Other projects' pre-existing restart intents were not modified. The ordinary
  handoff conversation was left idle.

**Later owner action:** at 08:56 UTC the engine was enabled briefly and dispatched
the consumption-attribution and difficulty-template cards, then was stopped.
The owner explicitly confirmed starting this work and instructed that the two
workers be left running. Their cards are now doing; do not stop them or restore
the earlier todo snapshot. The release/handoff operator did not start them.
Re-read live state before intervening; stopping dispatch does not stop workers.

The two real-world verification cards remain blocked. The four polish proposals
remain unapproved. All sections from **Pre-Release Snapshot** onward record
the earlier audit: statements there about unshipped work or pending delivery
are historical and superseded by this section. Re-read live state before work.

## Release Verification

Release 0.11.115 local preflight: 7,245 tests passed, 2 skipped (416 files);
typecheck and production build passed; lint has zero errors and 196 warnings;
21 Playwright checks passed, including public/owner views, description retention,
retired features, local tabs and Swarm controls. The PII guard first detected a
machine-specific home path in this handoff; the path was removed and the guard
passed. Git 2.34 was used for the full passing run: the older Git 2.28 on the
default PATH ignores the identity-isolation settings required by one test.
Publication, installation and live-Claude acknowledgement were verified
separately afterward, as recorded above; local checks alone do not claim them.

The first Linux CI run passed unit tests but exposed five browser-fixture
failures: public opt-in was incorrectly expected on every OS, and the synthetic
manager dashboard inherited a real 403 response. The browser checks now assert
the real platform gate in both directions and use an explicit successful engine
fixture for layout-only coverage. Production access policy is unchanged. The
full local browser suite passed all 34 checks after this correction; the earlier
unpublished installer build was cancelled before any assets were uploaded.

## Pre-Release Snapshot

### Start Here

- Checkout: the registered OPEN GROUND project directory (resolve its actual
  path from the local registry; do not publish machine-specific home paths).
- Current implementation branch: `codex/remove-persona-and-dormant-automation`.
- Implementation tip: `a9ef307b`. The documentation commit containing this file
  follows that tip; use the current branch, not an older worker checkout.
- Fresh `git fetch origin main` on this date: `origin/main` is `814b4dc0`
  (0.11.114), with 25 local commits ahead and zero behind before this handoff.
- Actual running app: installed Electron app, version 0.11.114, API on 47776.
  It has NOT received the local simplification work. A server restart alone
  does not install the new build. Do not confuse this with the fixture preview
  on 56558, which uses temporary data and an offline CLI.
- Real project registry ID: `3de870a679fa`. Board initially contains 336 cards:
  329 done, 3 blocked, 2 review and 2 todo. The audit covers all seven open cards
  in OPEN GROUND only; other registered projects are outside scope.
- Engine is stopped with `manualStop: true`; manager and supply desks are absent.
  Two older worker records remain at `stage: done`. Do not treat those records
  as permission to resume them or delete their worktrees.
- The owner reports Claude's weekly allowance has reset. No fresh live-model
  run or independent allowance check was performed as part of this handoff.

Read `docs/PUBLIC_PRODUCT_SCOPE.md` and `docs/commander/SIMPLIFICATION.md` before
following older plans. Those current contracts supersede historical Persona,
PTY-manager, marketplace and owner-only-Swarm descriptions in older documents.

## Owner Decisions to Preserve

1. Public product: Ground/project management, Board, Terminal and optional Swarm.
   Keep Swarm on/off and the existing public macOS opt-in. Windows policy is
   unchanged. This is not a change to the Claude/Codex execution provider.
2. Owner-only experimentation: project Canvas, Research, local custom tabs,
   WordPress settings, Skills management and automatic daily fuel proposals.
   Owner/Public display preview does not change identity, data or running jobs.
3. Persona and proxy answers are removed from the application. Existing local
   Persona data is retained. Do not recreate them from an old task or plan.
4. Preserve human questions, stop/recovery, quota detection, backups and guards.
   Preserve existing user data, saved hidden features and conversation history.
5. Keep Generate description. Its disappearing-text race has been fixed.
6. New Swarm workers and managers are SDK-only for every audience. Supply and
   ordinary terminals remain PTY-based, including phone access through Supply.
   Legacy in-flight manager adoption remains to avoid orphaning or duplication;
   it is not a selectable runtime or a new-launch fallback.
7. Public project tabs are fixed. Owner tab controls and Swarm sub-tab ordering
   remain. Do not remove sub-tab ordering without another owner decision.
8. No push, main merge, release, installation, data deletion or engine restart
   was included in the simplification work or this handoff.

## Work Already Implemented Locally

| Commit | Delivered behavior |
| --- | --- |
| `1c1ee7e8`, `45810d17`, `e8934d3f` | Integrated the desk context cap and card difficulty branches; fixed manual launch/reset and safety-floor wiring. |
| `3e9fa2e7` | Corrected pre-existing platform-dependent test assumptions without changing production behavior. |
| `91df0a44` | Removed Persona, proxy answering, self-supply scanning and dormant engine integration code; retained safety and existing local data. |
| `36a844c7` | Removed custom-tab market/submission/review distribution and unused Persona proxy startup; retained locally installed tabs and shared egress controls. |
| `4ce98fd7` | Separated public and owner feature visibility without deleting data. |
| `43982d19` | Added owner public-view preview, collapsed Ground drawing tools and owner-gated automatic fuel reports. |
| `937b2741` | Fixed public tabs, removed duplicate feedback/open-app controls and protected generated descriptions against late reads. |
| `3d20e9d4` | Hid manual Board run defaults when Swarm is enabled while preserving saved values. |
| `a9ef307b` | Removed manager runtime selection and PTY launch path; retained SDK resume/stop/recovery; fixed narrow-screen Swarm tab/dashboard layout. |

The two worker commits `cdb8af68` (context cap) and `32181eec` (difficulty) are
ancestors of this implementation branch, but neither is on `origin/main`.
Do not implement them again or integrate an old worker branch over the newer
simplification work. Their original branches and worktrees remain intact, with
untracked user instruction files preserved.

## Verification Already Completed

Latest implementation verification at `a9ef307b`:

- Vitest: 7,245 passed, 2 skipped, 416 files; no failures.
- TypeScript and production build passed. ESLint: zero errors, 193 warnings.
- Latest Playwright run: 11 passed, covering manager settings, Board and smoke
  at desktop/narrow sizes for owner/public displays. Screenshots inspected.
- New guards were observed failing against the old preference/launch/selector
  behavior, then passing after removal. Mobile tab clicks also failed before
  the layout fix and passed after it.
- Installed Electron executable ran the new server bundle with the real Agent
  SDK and an offline CLI fixture in a temporary HOME. Public and owner boots
  resumed legacy conversation history, delivered input, reused the singleton,
  stopped it and retained project data.
- Prior public/owner visibility, description retention and data-preservation
  checks are recorded separately in `docs/PUBLIC_PRODUCT_SCOPE.md`.

These are not a freshly packaged GUI acceptance test, a live-Claude acceptance
run, a Windows hardware pass or a release. Do not report those as completed.

## Audit of the Seven Existing Open Cards

### Keep in Review: Implemented, Not Delivered Upstream

- `477e6d41-7aca-4a47-aa24-d25ecd02eaed`: desk context cap. Locally integrated
  and verified; keep review until its stated `origin/main` destination is met.
  Current manager path is SDK-only, not the PTY path quoted by older notes.
- `2d7c8224-6035-489f-88eb-99fb5616aea7`: difficulty type/routing/safety floor.
  Locally integrated and verified; keep review for the same delivery reason.
  Auto/reset and title-only manual launch fixes are already included.

### Keep in Todo: Useful and Still Unimplemented

- `5a11ac62-184d-436c-8194-787bbd99f427`: distinguish manager, supply, overseer
  and personal consumption. `UsageSourceKind` still has only `swarm-worker`,
  `project`, `other`; `collectUsageBreakdown` still classifies by directory.
  Useful for measuring real savings. The historical 49% is a 2026-09-18
  observation, not the current week's measurement. Keep its context-cap
  dependency. Refresh spawn-path references for the SDK manager before work.
  Do not call unmatched project sessions definitely personal: pre-ledger or
  unrecorded desk sessions remain unknown/mixed. Preserve an explicit uncertainty
  bucket or wording, and never fabricate historical attribution.
- `1c5f66e3-99df-4855-bbdc-ee7eee3784e8`: difficulty-based worker templates.
  Still needed: `skills/order/SKILL.md` remains uniformly max-effort; the tier
  work selects model/effort but does not yet bound team size or review strategy.
  Preserve its difficulty dependency and mandatory safety/review rules.
  A single standard-versus-ultra run is noisy evidence, not proof of guaranteed
  savings. Verify the actual injected policy and observed agent usage; report
  comparison conditions instead of forcing a cheaper result.

Both todo cards name historical branches which are absent from the current
local branch/worktree list. No artifacts were deleted by this audit. Recheck
refs before resuming; do not assume those worktrees exist or that code was done.

### Keep Blocked: Real-World Checks, Not Automatic Coding Jobs

- `8348107b-c59b-45fc-9c70-25c618d9db52`: Windows hardware QA. Keep blocked
  until actual Windows hardware is available. Mac tests cannot satisfy it.
  Windows public Swarm access remains out of scope; do not open it by assumption.
- `79c36df3-ce3b-438f-8da1-ad51f9aa36c7`: real-operation reliability evidence.
  Keep blocked as an observation record, not a worker-dispatch task. Some old
  notes still refer to autoMerge/PTY-era behavior; use current manager-owned
  integration and SDK contracts. Historical checks are not proof that the
  latest build ran continuously for seven days. Update evidence only after a
  matching real event, retaining the old observation dates.

### Recommended to Retire Without Deleting

- `e1c6ed3c-8df0-4449-a195-ea54b2cd2e85`: automatic fuel proposal based on
  2026-07-28 measurements. Its general context/subagent suggestions overlap
  the concrete context-cap and worker-template cards, and unconditional
  subagent expansion can conflict with the newer difficulty policy. Recommend
  marking it deliberately passed over, not completed implementation. Preserve
  its original text and metrics. Do not disable fuel reporting itself.

## Newly Discussed Suggestions: Not Approved for Implementation

The last four suggestions were discussion only. They are not new runnable
tasks and must not be silently folded into the remaining fuel cards:

1. Roll back and report failed saves of Max/Economy/Optimize in
   `src/components/canvas/modules/ExecutionModeToggle.tsx`. This is distinct
   from the retired SDK runtime switch. The current mode-save path updates
   display first and does not handle non-2xx responses or restore on rejection.
2. Fold manager analytics/weekly graphs into details while keeping progress,
   human questions, stop and quota/budget warnings readily visible.
3. Remove redundant SDK labels and old `/manage`-desk wording from normal UI.
4. Measure and defer loading of owner-only feature code until needed.

## Recommended Resumption Order

1. Read this handoff and the live Board. Confirm Git branch, API identity and
   stopped-engine state again; never resume based solely on this snapshot.
2. Agree upstream integration/release as a separate action. Reuse the combined
   branch and verify it; do not cherry-pick the same worker work twice.
3. Run live-Claude and packaged-GUI acceptance against a controlled test project
   once that work is authorized. A reset allowance is not unlimited budget.
4. Complete the two already-approved remaining fuel tasks on the updated base,
   honoring dependencies. Keep user safety, human questions and stop/recovery.
5. Record real-operation/Windows evidence only under the stated conditions.
   The four new polish ideas still need the owner's go-ahead.

The handoff card is a blocked information card, not a dispatch request. The
real engine, manager, supply and existing worker processes must remain unchanged
by the handoff. Notes may be appended to existing cards; original content,
branches, dependencies, completed cards and all non-task project data remain.

## Handoff Recorded in the Actual Board

- Added blocked information card `fba3b9e5-9218-4bab-a743-3a786319a7f6`:
  `[引き継ぎ・実行しない] 製品整理の進捗と残タスク確認 (2026-09-21)`.
- Appended a dated audit to each of the seven existing open cards. Original
  titles, notes, columns, branches and dependencies are retained.
- The old fuel proposal is only a retirement recommendation pending the owner's
  answer. Its status/abandoned flag has NOT been changed.
- Used the real app's `PUT /api/project` with its fresh `updatedAt` CAS token.
  Before writing, raw storage and API data were structurally identical. The
  prior project and engine snapshots were saved outside Git under
  `/private/tmp/og-handoff-20260921-ykJoPb/`.
- Readback through the production API matched the planned result: 337 cards,
  including all original 336; all 329 completed cards unchanged. Non-task
  project data is unchanged. Engine remains manually stopped; manager/supply
  remain absent and existing worker identities are unchanged.
- This handoff changes documentation and Board notes only. The application
  test results above are the last implementation verification, not a new test
  run for this documentation-only handoff.
