# Assistant release candidate — 2026-10-21

The assistant distinguishes unavailable evidence from an empty Board, cites
observed records, and follows the exact card created through an owner button.
This is a local review candidate. Release acceptance is incomplete.

## Branch and scope

- Base and current HEAD: `ddfce3896f888808788cfbe70aae6caf402cb630`
  (`0.11.179`). Branch: `codex/assistant-release-candidate-20261021`.
- No candidate commit exists. The dedicated checkout contains an unstaged diff;
  original main and pre-existing worktrees were preserved. No fetch, pull or
  reset was used.
- Production scope: sourced status, read-only evidence guidance and exact-card
  tracking. No UI, iOS, sealed-frame schema, automatic approval, dispatch,
  resend or authentication behavior changes.
- Supporting test fixes isolate the native compiler cache and run a pure child
  probe with the runner's Node. Native helper production source is unchanged.

## Behavior and Mac/iOS alignment

`assistantStatus.ts` supplies `assistantDigest`, re-exported by
`phoneAssistant.ts`. Results include observation time, Board timestamps,
source paths and exact card/question IDs. Missing folders, corrupt Boards and
unreadable owner inboxes remain unknown. Existing read allowlists and redaction
still apply; no private transcript reader or filesystem permission is added.

The internal SDK `status` tool accepts optional `projectId` and `taskId`.
Project lookup names retained `engine-journal.jsonl` evidence for existing
read-only tools. This is not a president/commander conversation transcript;
missing conversation evidence remains unverified. Exact-card lookup returns
the recorded column and notes. Absence does not mean completion and does not
trigger recreation or resend.

Live App notes and rebuilt session history preserve the created card's IDs.
The prompt separates recorded claims, observed results, creation and completion.
Every proposal still requires the exact displayed-text hash and an explicit
owner button. Source content remains data rather than authority.

Mac and iOS already share assistant/proposal entry points. Empty status arguments
remain valid and existing `AssistantEntry.card` metadata is reused. iOS S20
overview, S28 follow-up and S12/S27 confirmation semantics align. S14 partner
search and assistant-only photo support are unchanged. Actual iPhone/relay
acceptance and the separate iOS candidate are not certified here.

## Measured verification

Private evidence is outside this repository in the task's
`mac-release-verification/` folder (`<LOCAL_VERIFICATION_DIR>` below).
Reproduction uses installed dependencies and Node 22.22.0.

- Five sourced-status cases failed on original code (`status-red.log`); exact
  receipt tracking failed on the original assistant (`receipt-red.log`). Final
  related aggregate: **7 files / 142 tests passed**, no skips (`aggregate.log`).
- Full app/scripts typecheck passed. Lint passed with no errors and 204 existing
  warnings. Web/server builds passed. Universal native helper built using a
  dedicated writable cache; compilation is not speech or packaged acceptance.
- Existing proposal-frame browser acceptance: **12 Chromium tests passed in
  14.8 seconds**, exit 0, using fake Claude, temporary data and loopback 47876.
  No live assistant, external API, credentials or publication was used. See
  `authorized-retry/BROWSER-RESULTS.md` in local evidence.
- Original full suite: **472 files passed / 13 failed; 8585 tests passed /
  44 failed / 2 pre-existing skips; 11 unhandled errors**, 542.73 seconds.
  Four failures caused by concurrent build-generated root entries passed exact
  rechecks without concurrent builds; no app fix was needed.
- Of the remaining 40, the safe selected **38 cases failed on both base and
  candidate**, with matching observed categories. They shared selection,
  dependencies, sandbox and outer Node; inherited PATH selected an older Node
  for child CLIs. Matching categories establish pre-diff reproduction, not a
  universal environmental root cause. Local listen/spawn, protected fixture
  paths and child runtime gates remain incomplete. See
  `authorized-retry/paired-case-results.tsv` and `AUTHORIZED-RETRY-RESULTS.md`.
- Previously hidden native stderr identified a denied default module-cache
  write. The same native source compiled with a temporary writable cache.
  The opaque child probe failed with PATH's Node syntax handling; Node 22's
  tsx CLI then exposed an unrelated IPC `EPERM`. Its standard import hook ran
  the pure probe successfully without that CLI server. These diagnoses justify
  test-harness fixes; they do not establish a shipping native/audio bug.
  After these fixes, the exact three non-recording native cases and the pure
  child probe passed: **4 tests / 2 files, exit 0, 29.30 seconds**. The other
  48 tests were not selected; no assertion, timeout or skip logic was changed.
  Changed-test lint and both app/scripts typechecks passed.
  A file-scope follow-up executed all 47 home-guard tests and the three safe
  native cases: **41 passed / 9 failed / 2 speech cases not selected**, exit 1,
  7.53 seconds. All nine failures match the observed pre-diff baseline category:
  five denied non-temp fixture creations and four unchanged CLI probes using
  PATH's Node 16.9.0. The outer runner used Node 22.22.0; PATH and sandbox were
  unchanged, and the native cache was isolated by the fixed fixture. No new
  failing case was observed in these files. A separately recorded supported-
  environment run put Node 22 first in PATH and submitted the same 50 cases
  through normal approval review with their temporary fixtures/local IPC:
  **50 passed / 2 speech cases not selected**, exit 0, 6.82 seconds. All nine
  previously blocked cases reached and passed their assertions. No additional
  source, timeout, skip or assertion change was made for that run; the earlier
  41/9 result is retained. Of the original 44 failures, four build-interference
  rechecks, four corrected fixtures and these nine environment-gated cases now
  have passing evidence. **25 other paired cases and the two prohibited speech
  cases were not rechecked in this phase**; the full suite is not green.
  Details are in `local-blockers-20261021/RESULTS.md` in local evidence.
- Two speech cases were **not executed** on either base or candidate:
  `hears a voice that sits on channel 3 of 12` and
  `a finished sentence is handed on within about a second of the voice ending`.
  They can reach cloud recognition when on-device recognition is unavailable.
  Nonselection is not a passing or skipped acceptance result.

Related assistant regression command:

```sh
node node_modules/vitest/vitest.mjs run src/lib/server/assistantStatus.test.ts src/lib/server/phoneAssistant.test.ts src/lib/server/assistantSession.test.ts src/lib/server/assistantProposals.test.ts src/lib/server/assistantTools.test.ts src/lib/server/projectData.test.ts src/lib/server/phoneLinkSealed.test.ts --maxWorkers=2
```

Safe non-recording harness command (do not run the entire native file under a
local-only/no-cloud policy):

```sh
node node_modules/vitest/vitest.mjs run src/lib/server/ogListenNative.test.ts src/lib/server/testHomeGuard.test.ts --maxWorkers=1 -t "takes the built-in mic only for a multi-channel default, and never with the lid shut|reads this Mac's lid state and current input|how long a pause ends the words depends on how they end|isTestProcess\(\) is false, and the real home stays writable, with only NODE_ENV=test set"
```

## Changed files and limits

- `assistantStatus.ts` / its test: strict sourced status and nine regressions.
- `phoneAssistant.ts` / its test: evidence guidance and exact live/history receipt.
- `assistantSession.ts`: optional filters on the existing internal status tool.
- `projectData.ts`: exports the existing pure legacy normalizer; body unchanged.
- `ogListenNative.test.ts`: fixture compiler cache and retained build stderr.
- `testHomeGuard.test.ts`: current-Node standard loader for the pure
  `NODE_ENV=test` probe; original assertions and production guard unchanged.
- `docs/MAP.md` and this document: entry points and portable verification notes.

Status is sequential, not an atomic portfolio snapshot. Board columns record
work state rather than liveness. Engine journals cannot replace missing
conversation evidence. Boards over 10 MiB are conservatively unknown.

An explicit PII manifest covers tracked files plus the three intended new
source/document files, including this untracked handoff. Credential/environment
filenames are excluded before opening, along with binary/nonregular files.
The final manifest had 1327 entries with 1277 text files inspected. Personal
home-path detections and known personal-identifier hash matches both fell from
8 to 0 after this document was made portable; provider-email detections were 0.
Six credential/environment names and 43 binary-extension files were excluded
before opening; one further binary-content file was excluded from text checks.
This is not a credential-content audit or proof that uninspected files are safe.
Do not copy personal paths, matched fragments or credential values from private
evidence into publication artifacts.

## Release gates, integration and rollback

1. Review the diff and local blocker report. Complete unresolved local/process/
   socket tests in a suitable authorized environment. Do not weaken assertions,
   hide failures with longer timeouts or count prohibited cases as passed.
2. Separately verify the packaged Electron app and paired iPhone/relay: source
   freshness, missing evidence and exact-card follow-up using an approved
   disposable fixture and the existing confirmation button. Actual microphone
   and speech acceptance remain separate from compilation.
3. After review and separate authorization, commit and integrate onto a current
   approved branch without overwriting dirty work. Follow `docs/VERIFICATION.md`
   and `docs/DISTRIBUTION.md` for packaged acceptance, signing and release gates.
   No commit, push, merge, distribution or publication was performed here.

Before integration, retain this checkout for review and continue using original
main. There is no user-data migration to reverse. After an approved integration,
revert its candidate commit and rebuild normally; never reset user branches or
delete work. Claude and automatic dispatch remain paused until explicitly resumed.
