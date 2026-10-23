# Isolated candidate validation — 0.11.181

This branch preserves public 0.11.180 (`7cf1bf9`) and integrates the assistant
status/card-receipt and required-signing patches from `2b6d62af` and `f8e88d5f`.
The Board detail/assistant-spacing changes remain in the base. This is not a
release instruction, a malware-safety verdict, or permission to resume automation.

The public smoke test verifies the actual non-owner 403/body and hidden
assistant. Its console exception is restricted to that exact verified response
URL and Chromium's 403 message; other URLs, runtime errors and failures remain
errors. The server's owner, Origin and Host checks are unchanged.

`candidate-validation.yml` runs only on the named validation branch. It has
read-only repository contents permission, no tag/release job and no stored
checkout credentials. Linux validation includes the app, worker, relay and full
Chromium E2E suites before the Mac job can use existing signing credentials.
Mac compilation has no product-service configuration or signing credentials;
only the packaging step receives the existing certificate/notarization inputs.
The candidate therefore does not certify production login/pairing configuration.

The builder configuration removes the publisher and uses `--publish never`.
Output stays in the runner temporary directory. Both architectures must pass
deep/strict signature, architecture, version and stapled-ticket validation,
without app execution. Only DMG/ZIP files plus a SHA/run-ID manifest enter Actions
artifacts. No Release, tag or latest update feed is uploaded or modified.
Actions artifacts are still files sent to GitHub with repository-dependent
visibility; they are not an auto-update or public-release channel.

Do not dispatch the ordinary release workflow with this version: its
`publish=false` still uploads release assets. Do not retry an uncertain Apple
submission; inspect the exact run/job and notarization result first.

Local tests use dedicated data/HOME, loopback 47876 and fake Claude. Historical
test results in the assistant handoff describe the earlier candidate; the new
integration must be judged from its own exact-commit CI results. Electron 31's
support status, original macOS detection evidence and real packaged/device
acceptance remain separate release gates. No suspect installed/quarantined app
is executed by this validation path.
