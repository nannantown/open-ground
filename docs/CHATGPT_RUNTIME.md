# Owner ChatGPT plan runtime

This change adds a second runtime for the owner's assistant and agent team.
It starts from the current application trunk, not the productization/billing branch.
Access requires the signed-in OPEN GROUND account to have the `owner` role.
Tester access, general Swarm opt-in and local machine unlocks do not grant it;
signing out immediately removes access.

## Authentication and spending

- Sign in with ChatGPT grants OPEN GROUND access to the user's **ChatGPT plan
  usage**. It does not configure a paid Platform API project.
- No API-key input, environment-key fallback, shared provider account, or automatic
  switch to metered API billing exists. An installed Codex CLI's credentials are
  never copied or extracted.
- ChatGPT's account-side app limits also control paid-credit overflow. The app
  never enables credits or auto-recharge. For the owner's acceptance run,
  OPEN GROUND's plan allowance was enabled, app credit overflow was disabled,
  auto-recharge was disabled, and the credit balance was zero.
- The independent OAuth implementation uses a loopback callback, PKCE, state and
  nonce, verifies the signed ID token against OpenAI's JWKS, and requires the
  explicit ChatGPT-plan usage grant. Registration and tokens remain server-side.
- Credentials live in `OPENGROUND_HOME/secrets/chatgpt.json` (directory 0700,
  file 0600, no-follow reads and atomic writes). Responses never expose tokens.
- Model choices come from the connected account's authorized catalog. A catalog
  response is not proof of completed inference; acceptance must include a real turn.

The transport uses OpenAI's documented public Responses endpoint with the
plan-authorized OAuth token, `store: false` and streaming. These are subscription
requests, with no Platform API-key fallback. OAuth, scope or usage failures stop
the operation instead of changing its billing route.

SIWC can leave `response.completed.response.output` empty while sending complete
items in `response.output_item.done`. The transport assembles those items by
index and waits for `response.completed` before running any tool. Failed,
incomplete, duplicate or unfinished output never authorizes a host action.
Subscription-limit failures stop parent and child conversations without another
continuation request, and cool only ChatGPT.
Text deltas continue to stream to the assistant's `onText` callback. SDK seat
events follow Claude's completed-text-block contract: each validated completed
content block emits one text event, preserving paragraphs without filling the
80-frame seat tail with individual tokens.
Request deadlines retain their controller and cancellable timer through body
consumption, including under garbage collection in the packaged Node 20 runtime.

Primary specifications, checked 2026-11-05:

- [ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## Settings and conversations

The owner independently selects the assistant and automatic-work provider.
One ChatGPT model/effort pair is shared by both selections, including memo
maintenance and automatic-work roles. Independent reviews retain the parent's
launch configuration. Existing automatic seats keep their launch settings;
new assistant turns and newly launched seats read the latest selection.
Claude's model/effort settings remain intact. Dedicated preference writes prevent
an older full Settings snapshot from undoing a newer provider choice.
The UI waits for the server's assistant capability before loading history. The
legacy local unlock still permits the Claude assistant, while ChatGPT controls
and status requests require the separate signed-in owner capability.

Changing provider does not kill ongoing work. Stop and restart an existing
commander or president to use the new selection. Their Claude and ChatGPT
conversation pointers are stored separately. Worker re-entry retains the worktree
and starts a separate conversation when its selected provider changes.

ChatGPT conversations have `chatgpt-` UUID identities and separate, account-bound
local history. Claude's quota and transcript files are never treated as ChatGPT
quota or history. Genuine subscription-limit errors cool only ChatGPT; Claude
being fully cooled does not block new ChatGPT dispatch.

The assistant uses only its existing registered-project read tools and proposal
callbacks. Card creation and messages still require the existing proposal buttons.
Its raw tool/context history stays in memory. The president's phone relay uses a
separate append-only user/final-answer transcript, without tool results.
Background assistant memo maintenance follows the same provider selection. Its
ChatGPT Write tool is an in-memory JSON handoff with one fixed destination;
authentication failures preserve the memo without starting a Claude run.

## Execution boundary

Provider-native shell, file and MCP tools are not exposed. Every worker host
operation passes through the existing deterministic OPEN GROUND guard directly;
a missing, throwing or malformed decision denies the action. This avoids relying
on native CLI hooks that can fail open.

All shell calls, including commanders and presidents, additionally run under a
mandatory macOS Seatbelt credential boundary. It denies reads/writes of the
credential directory and renaming its ancestors; host file tools also reject that
directory and perform file I/O in a fixed helper under the same OS boundary,
so replacing a checked directory with a symlink cannot expose credentials.
A missing OS boundary refuses automatic work. Assistant-only use has
no shell requirement. This is separate from the optional worktree-sandbox experiment.

Commands have bounded output and deadlines. Interrupts, normal completion and
server shutdown during app quit or update reap remaining process-group members.
There is no persistent shell input channel.
The existing worktree occupancy and cleanup gates remain authoritative.
Independent review uses a fresh context on the same account, model and reasoning
setting. Its only tools are bounded project reads and fixed read-only Git
investigations. The child inherits the parent's stop signal and account identity;
it cannot delegate again, write files or use the network through host tools.

## Limits

- Automatic host tools currently require macOS. No unprotected Windows fallback.
- Conversation size and tool-round limits fail visibly and preserve history.
  Native `/compact` is not emulated by sending it as ordinary user text.
- Provider changes, logout, work mode and account changes are checked again before
  new requests and host actions. Accounts never inherit each other's context.
- A private app-factory preview and its signed Electron runtime are separate
  checks from the normal packaged startup, updater and general release.

## Owner acceptance — 2026-11-05

The real OAuth exchange, RSA signature verification and authorized eight-model
catalog succeeded. The received ID token used the documented singleton-array
audience; both that format and the string form retain exact client binding.
The OpenAI consent page's earlier availability error cleared on a normal retry;
no undocumented parameters or browser restrictions were bypassed.

With the owner's ChatGPT plan and `gpt-6.1-sol` / `medium`, a real assistant turn
invoked its status tool, continued inference and returned its final answer.
A separate automatic-work run dispatched a worker for a two-file task in a
disposable Git project, ran the checks, committed, produced a ready heartbeat,
started a commander, completed an independent Agent review, integrated into a
local bare origin's main branch and moved the Board card to done in 136 seconds.
The fixture engine, sessions and worktree were cleaned up; the original project
registry entries were preserved. The acceptance run pushed only the local fixture
origin and deployed no application.

The same automatic-work acceptance also passed in 141 seconds under the signed
Electron runtime with its packaged Node 20 environment. This exercised dispatch,
worker checks, independent review, local integration and Board completion rather
than relying only on a model-catalog or connection-status response.
