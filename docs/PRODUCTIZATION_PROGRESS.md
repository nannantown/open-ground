# Productization implementation progress

2026-10-15. Work in progress on `codex/productize-subscriptions`, PR #2.
This records implementation evidence, not public-release acceptance.
The feature inventory and original findings remain in [PRODUCT_FEATURE_AUDIT.md](./PRODUCT_FEATURE_AUDIT.md).

## Confirmed scope

- Finish the existing product's quality first. The user explicitly deferred new paid
  workspace features; existing Free multi-project and multi-terminal access stays intact.
- macOS small beta precedes Free/Pro public release. Prices remain JPY 0 / 2,980 monthly.
- Preserve Owner features, files and settings. No AI API-key migration, no Codex/MCP rewrite.
- Use isolated test homes, dummy credentials and fake services. Do not delete real data,
  replace the installed application, publish a release, or assume external access is configured.

## Implemented so far

- A01/A05: preference-only writes, serialized save queue, retained failed patches and explicit retry;
  App propagates HTTP/network errors to the settings panel. Research-channel failures and sound-test
  results are visible. WordPress settings no longer resend unrelated preferences.
- A02/A03/A08: one lock for manual and periodic blog sync; site-bound ledgers with preserved
  per-site archives; corrupt ledgers stop writes. Old unbound records require explicit destination
  confirmation. Durable pre-create records stop automatic duplicate creation after ambiguous delivery
  or local acknowledgement failure; retry requires checking WordPress first. Actual publishing stays
  on WordPress. No real WordPress requests were made.
- A04: new settings and generations use 0600; new home uses 0700. Boot restricts existing settings
  generations without changing bytes, with no-follow file handles. Retained backups may still contain
  old passwords; disconnecting does not erase backup history.
- A06: unverified billing and work mode are distinct from confirmed Free. The UI does not imply that
  an unavailable entitlement check cancels billing; management remains discoverable with instructions.
- A07/A11: Owner sandbox settings disclose that SDK Workers lack OS sandboxing; separate command
  guards remain. Worker trials are Owner-only in UI/API and on worker launch, preserving saved values.
- R03: Electron 31 -> 43.7.11, electron-builder -> 26.15.3, @electron/rebuild -> 4.2.1.
  Electron 43 preserves the existing clipboard API while using a patched supported release.
  [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes) reviewed.
  Native dependency installation returned 0 but warned about spaces in the checkout path;
  actual runtime and packaged candidate checks must decide compatibility.

## Further quality fixes

- All API responses carrying settings now apply the same Owner filter. A regression test
  exposed WordPress/experiments/trials in `/api/projects` before the fix; Free/Pro reads no
  longer return them, while Owner reads and saved bytes remain intact.
- Settings saves require an applied-key receipt, so HTTP 200 with a dropped preference is
  not described as saved. Retry keeps the newest value when an older request fails. Failed/in-flight
  drafts survive closing/reopening the drawer; saved sound/update preferences refresh on reopen.
  Both reopen regressions failed before the fix and passed afterward.
- A10: README, landing, privacy and the in-app storage/plan help now describe actual local
  and external storage, model/integration network traffic, Owner-only project tabs,
  Free multi-terminal access, automatic update/resume limits and Windows experimental status.
  Removed blanket no-files/no-network claims and Windows warning-bypass instructions.
- A12: generated core orchestrator/overseer questions and notifications, resume/failure notices,
  SDK/PTY usage-limit notices, process/integrity warnings and update notices use Settings.language.
  Existing records and user/AI-authored questions are preserved, not rewritten. Some Owner-only
  reports/internal diagnostics retain their original wording; this is not complete app-wide translation.
- A13: [DATA_BACKUP_RECOVERY.md](./DATA_BACKUP_RECOVERY.md) covers central files, project folders,
  Electron profile, NENE and Claude-owned storage. Automatic generations still protect only two files.
  `node scripts/verify-product-data.mjs` uses copied fixtures and the built server under Electron;
  it pins every writable home/project to a canonical temporary sandbox, never the installed app.
- Ground placement: new cards now avoid saved card geometry rather than assuming card count equals
  occupied grid cells. Existing user positions stay unchanged. Two new geometric regressions failed
  on the old code; the fixed layout plus App/search regression set passed (37 tests).
- CI's imported-project search could press Enter before its result appeared. The E2E now waits
  for the actual row before exercising keyboard navigation; no force-click or fixed sleep was added.

## Verification evidence

- Negative controls: old settings UI lost a fast change; old blog code failed overlap/site/corruption
  cases; removing private modes and restoring old billing display failed three cases; old overseer
  failed the English notice; old `/api/projects` exposed the Owner secret; old placement failed two cases.
  Fixed production sources are restored. No real WordPress posts or charges were made.
- Full unit run after localization: 487 files, 8,581 passed, 4 skipped. The first run found 6 failures
  (locale-specific expectations, script types, isolation inventory); the corrected set passed 141 tests.
  The next full run including placement had 8,583 passed / 1 timing failure / 4 skipped: an unchanged
  512 KB secret-filter performance assertion took 101.44 ms against its 100 ms limit during parallel
  checks. The isolated 110-test settings/performance/isolation set passed without relaxing the limit.
  Final full run remains pending.
- Root and Worker typecheck passed. ESLint: 0 errors, 205 existing warnings.
- `npm run build` passed (existing large-chunk warnings). Free Playwright: 25 passed before the
  final placement fix; final Free/Owner runs remain pending for that fix.
- Copy/restore acceptance passed: 13 copied files, 7 protected project/custom-module files with identical
  SHA-256 hashes; Owner → Free → Owner across three Electron server boots; Board/Canvas/custom source/
  research/WordPress/trials read back; non-Owner API denial; native PTY launched. Original copy unchanged.
  Fixture-copy mtimes can round below a millisecond; content hashes, not identical mtime floats, verify data.
- Native dependency installation returned 0. PTY passed under Node 22 and Electron 43.7.11 / Node 24.21.0.
  The restored server check is not packaged-GUI, installed-app-update or real-Claude acceptance.
- Cloudflare local collab and Phone relay runtime checks passed. Billing Wrangler dry-run passed;
  no Worker deployed and no production database touched.

## Dependency risk still open

`npm audit`: 29 → 17 findings (critical 1 → 0, high 22 → 7, moderate 6 → 10).
Production-only audit: 0. Electron is a shipped runtime despite being a devDependency;
its upgrade is covered separately above, not excluded by that production-only number.
Picomatch was patched within its existing major versions.

Remaining chains are build/distribution tools: Tailwind 3 / patch-package use braces 3.0.3;
Tailwind/PostCSS use selector-parser 6; electron-builder download logging uses sprintf-js 1.1.3.
The npm registry currently has no newer braces or sprintf-js release. Audit suggestions include
major framework changes or tool downgrades; those are not a verified repair. These parsing/logging
packages are not imported by the shipped server for public request handling. Build only reviewed
repository CSS/globs/config with trusted tool configuration. Complete compatible upstream updates
or a separately validated framework/tool migration before declaring the distribution chain cleared.
Do not treat these 17 findings as fixed or claim the whole dependency audit is clean.

## Remaining release work

1. Finish the final Free/Owner E2E and local distribution-candidate checks, then update this evidence.
2. Real Supabase Auth/RLS/RPC, Stripe test/live checkout/portal/webhook and cross-account/device
   cancellation/expiry/recovery remain unconfigured/unverified; follow BILLING_PLAN.md.
3. Run a non-Owner Pro user's real Claude SDK dispatch → independent review → return → completion,
   stop/crash/restart/expiry acceptance with that person's subscription. Fake CLI tests do not replace it.
4. A new signed/notarized candidate must pass Finder launch, browser auth/billing return, native/SDK,
   safe update/rollback and copied Owner-data checks on supported macOS hardware. The existing installed
   app is running on its fixed primary port and was not stopped or replaced for this work.
5. Real NENE/Songs, WordPress, iPhone and deployed collaboration acceptance remain distinct from
   fixture and local relay tests. Backup instructions include their separate stores; their real data
   was not copied, restored, altered or deleted.
6. Resolve dependency findings above and the individual operator's actual sales/legal/support details.
   Do not invent a company, contact policy, refund rules or business registration details.
7. Provider conditions remain unresolved. The submitted OpenAI inquiry is not approval. No AI API-key
   migration or Codex/MCP rewrite was introduced; Codex is not a first-release requirement.
8. Review the draft PR and CI. Do not merge, tag, deploy, publish or replace the installed application
   as a side effect of these checks. Public launch follows the macOS small beta and explicit release decision.

New paid workspace differences (A09), connection-test convenience and per-report sync pause are
explicitly deferred. Free multi-project/multi-terminal limits were not changed.
