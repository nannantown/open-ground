# President conversation and iPhone compatibility

Decision: 2026-11-05. The owner's requirement is an ordinary, always-visible
conversation input for the president, with no metered inference API.

## Input and execution are separate

`SwarmSupplyPane` owns one persistent `SwarmSeatSay` below either conversation
surface. ChatGPT presidents keep their structured SDK-style transport. Claude
presidents keep the user's unmodified Claude Code CLI in a PTY. The Claude
terminal remains available for direct input and native Remote Control.

The input stays open after sending and does not take focus when mounted. Enter
sends, Shift+Enter inserts a newline, and an active IME composition does not
send. Starting, stopping and exited seats cannot receive a new message; their
unsent draft is owned by the project's `SwarmModule`, so it survives the pane
being unmounted by desk reconciliation or bar folding. It is not written to
disk, and does not imply recovery after quitting the app.

On narrow windows the president seat fits the space left beside the folded
seat rail. Its minimum width must not force the input and send control outside
that space. Wider windows retain the seat resizing and horizontal row layout.

Claude's conversation input uses the same guarded owner lane as the iPhone,
not raw terminal keystrokes and not the manager-reply `/supply/say` route. Busy
desks, menus and existing terminal drafts hold the message for later delivery.
Acceptance into this queue is distinct from confirmed delivery. The existing
owner-lane plain-text normalization and length limit apply.

## Why this does not migrate Claude presidents to the Agent SDK

The earlier explanation that only implementation work remained was incomplete.
The SDK can technically run the user's CLI with subscription authentication,
but that alone does not establish permission to offer subscription-backed
agents in a third-party product. The current official SDK documentation says
that offering claude.ai login or rate limits in third-party products requires
prior approval. The legal page separately permits an end user to sign in to an
unmodified hosted Claude Code binary. It also mentions ordinary individual SDK
use. These statements must not be collapsed into a claim that every owner-only
product integration has approval.

The older owner-only worker migration decision in
`SDK_CLIENT_INVESTIGATION.md` is historical context, not evidence of Anthropic
approval for another integration. This change does not migrate the Claude
president or alter the existing worker/manager/assistant runtimes. A future
migration needs a confirmed permitted subscription-only integration and a
separate billing-boundary review. No API key or paid fallback is introduced.

Authentication and billing are independent of PTY versus SDK: inherited API
keys, custom providers, helpers and account extra-usage settings can affect
which allowance is consumed. A `loggedIn` flag or removing one environment
variable is not a complete guarantee. Do not disable or modify Claude Code's
built-in authentication mechanisms to work around the product restrictions.

Official references, checked 2026-11-05:

- [Agent SDK: getting started](https://code.claude.com/docs/en/agent-sdk/overview#get-started)
- [Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
- [Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)

## OPEN GROUND iPhone app versus Claude Remote Control

They are separate connections. Claude's native Remote Control belongs to the
interactive CLI. The OPEN GROUND iPhone app uses the encrypted `phoneLink`
relay and speaks a provider-independent frame protocol. The Mac selects the
runtime; the iPhone does not launch an SDK or hold provider credentials.

- Phone `say` frames target a project president or the cross-project assistant.
- The Mac checks access, queues owner messages safely and returns
  `queued` / `delivered` / `rejected` acknowledgements.
- `supplyTranscriptFile` selects the live president's append-only transcript:
  Claude JSONL or ChatGPT's phone-compatible transcript. Reply frames and
  history pages keep the same wire shapes for both providers.
- Transcript IDs and relay cursors support deduplication and reconnection.
- Interrupting voice playback on the iPhone is distinct from interrupting the
  model or cancelling an already accepted instruction. No new model-cancel
  command is implied by the voice control.

The compatibility checks use synthetic Mac-side integration fixtures and the
iOS Core tests. They do not establish an end-to-end test on a physical iPhone,
including background execution, push delivery or audio routing.

iOS audit, 2026-11-05: reviewed `Frames`, `Talk`, `Feed`, `Transcript`,
`ConnectionLifecycle` and `App/Phone.swift` in `openground-ios`. The existing
frames cover sending, acknowledgement, replies and reconnect/history merging
without a provider or runtime field. Voice barge-in stops local playback and
starts listening; it sends no model-interrupt command.

Verification command:

```sh
# Run in the sibling openground-ios checkout.
swift test --package-path Core --scratch-path /tmp/og-ios-core-sdk-audit-build
```

All 332 tests passed (322 PhoneLinkCore and 10 PhoneAudio). This verifies Core
logic and its wiring checks on macOS, not a full iOS app build or
physical-device SDK integration.
