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

## Latest verification

- Settings lost-update test failed on old production UI before implementation.
- Blog overlapping-send, destination-switch and corrupt-ledger tests failed on old production code.
- Removing private-file modes and restoring the old billing UI produced three expected failures;
  fixed sources were restored immediately.
- Latest checkpoint: 22 files / 296 tests passed, exit 0. This predates the additional local
  acknowledgement-failure test and the final verification below.
- Root typecheck passed. Lint: 0 errors, 205 existing warnings (before the latest small changes).
- npm audit after dependency update: 18 total, critical 0, high 8, moderate 10.
  Remaining development/distribution chains still need assessment; no blanket clean-audit claim.
- `patch-package` applied the existing node-pty patch. Native PTY smoke passed under Node 22 and
  the new Electron 43.7.11 / Node 24.21.0 runtime. This is not packaged-GUI acceptance.
- After the additional acknowledgement-failure test, blog / Research UI / Owner API tests:
  3 files, 68 passed, exit 0. Root typecheck passed again.
- Full tests, build, E2E, newly packaged GUI, real Claude, Stripe/Supabase, WordPress,
  NENE and iPhone acceptance are not completed for this implementation checkpoint.

## Open work

1. Finish regression coverage for failure/retry, legacy blog confirmation and Owner preservation;
   review the save queue's nested preferences and close/unmount behavior.
2. A10: align README, landing/pricing/privacy/manual, current storage and update behavior;
   remove stale current-tense claims. Keep Owner-only functionality described accurately.
3. A12: make generated user-facing notifications/questions follow the chosen language.
   Preserve historic records; do not rewrite user-authored questions.
4. A13: document full backup/recovery boundaries and verify copied fixture data across roles/restart.
5. Finish dependency risk assessment and Electron 43 runtime/native/GUI acceptance.
6. Run meaningful tests, full unit suite, lint/typecheck/build, Free/Owner E2E sequentially;
   do not overlap Vitest with build/Playwright artifact generation.
7. Update audit/launch-plan/handoff completion states with evidence, commit, push and update draft PR.
8. External configuration/real acceptance and legal/operator details remain explicit release gates.
   The submitted OpenAI inquiry is not an approval. No live credentials or provider-terms approval
   have been assumed; no live services or production DB were changed.

Connection testing and per-report blog pause would be new convenience features, not required to fix
the confirmed defects. Do not add them while the user has prioritized existing-feature quality.
