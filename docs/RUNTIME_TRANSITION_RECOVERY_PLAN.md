# Runtime switching and recovery — completion contract

Owner goal, 2026-11-05: finish the owner-only Claude / ChatGPT assistant and
automatic-work feature, including switching during work, resets, app restarts
and the OPEN GROUND iPhone connection. Subscription-only; no metered inference
API, API-key fallback or automatic switch to another provider.

This is the implementation plan and acceptance checklist for that goal.
The previous 0.11.196 release unified president input; it did not implement
cross-provider handoff or durable in-flight conversation state.

## Behavior to deliver

1. A provider selection requests a transition. The UI separately shows the
   provider currently executing, the requested provider, and progress/errors.
2. The old accepted turn reaches a safe boundary. New messages are accepted
   durably into an inbox, not sent into a retiring process. Dispatch and new
   integration are gated without rewriting the owner's engine ON/OFF intent.
3. State is checkpointed before the old actor retires. The next actor receives
   the owner's goal, conversation summary, Board / worktree references,
   confirmed action receipts and queued messages. Native provider histories
   remain separate; neither credentials nor hidden reasoning are transferred.
4. A target which cannot authenticate or start leaves a visible recoverable
   state. It does not silently run another provider or use an API key.
5. App and renderer restarts restore drafts, accepted messages, transition
   progress and pending proposals. A duplicate request ID returns its existing
   receipt; the same ID with different content is rejected.
6. Reset operations have explicit scopes: stop the current turn, start a new
   conversation, delete memory, and delete history are different operations.
   Starting a new conversation cancels its old queued messages and supersedes
   unapproved proposals. A late old result cannot recreate cleared data.
7. Files and Board data are preserved. An action already performed is not
   described as undone by a reset. An interrupted action with an unknown result
   is held for inspection instead of being automatically executed a second time.
8. The existing iPhone say/event/history protocol stays compatible. Delivery
   acknowledgements follow durable receipt state, including retries/reconnects.
   iPhone drafts/outbox survive client restarts, scoped to the paired owner and
   selected conversation. New controls require a current capability handshake.

## Safety and state model

Requested settings and effective execution are distinct. Immutable execution
leases bind owner identity, provider account, conversation epoch, generation,
turn ID and attempt ID. Changing the requested provider does not revoke an
already admitted turn halfway through a tool. Logout, work mode, account
replacement and explicit stop/reset continue to revoke access.

Transition phases are `stable -> draining -> checkpointed -> retiring ->
launching -> stable`. An error enters `attention`, retaining the checkpoint and
inbox. Revision checks and a single writer prevent a stale attempt or a second
window from committing over a newer request. Cancel/retry actions are explicit
and idempotent; cancellation never implies undoing a completed external action.

Each scope has a durable journal written atomically with fsync, restrictive
permissions and validated bounded schemas. A receipt is persisted before ACK or
execution. Results are committed before projecting them into conversation
history or delivering them to a client. Boot recovery runs before ordinary
engine resume / assistant queue drain.

Safe quiescence requires more than an SDK `waiting` flag. Inputs must not be
prefetched beyond an outstanding turn, and the adapter must report a settled
boundary after saving its history, tool receipts and phone transcript. Existing
integration runs outside the normal engine lock and must also settle before
handoff. Retirement targets only recorded actor handles, never unrelated owner
terminals or processes in the same checkout.

Recovery cannot promise rollback or exact continuation of an arbitrary external
command across process/power loss. A durable started-but-unsettled receipt is
`uncertain`. Read-only work can be safely repeated; effects need deterministic
evidence or an explicit reviewed recovery decision. An unresumable native
history must not silently become permission to repeat an unknown effect.

Claude's existing unmodified CLI / native Remote Control is preserved unless a
separate permitted subscription SDK integration is established. Transport
uniformity is not required for the shared lifecycle contract. Existing signed-in
owner checks and ChatGPT credential / host-tool boundaries remain mandatory.

## Work ownership

- Root: transition journal/coordinator, settings and status contract, execution
  lease authorization, shared operation receipts / recovery primitives and boot
  ordering. Integrates each participant and owns release/installed acceptance.
- Swarm track: SDK settled/input gate, worker/manager/president handoff adapter,
  engine dispatch/integration freeze, checkpointed worktree re-entry and boot
  integration. No generic settings or coordinator edits.
- Assistant track: durable inbox/turns/proposals/approval receipts, reset epochs,
  assistant participant and idempotent history projection. No shared provider
  selection or desktop UI edits.
- UI/iPhone track: requested/effective progress and recovery controls, persisted
  drafts and stable request IDs, backward-compatible sealed frames and native
  client outbox recovery. Shared contracts are owned by root; overlapping edits
  must be serialized or isolated in worktrees.

## Observable acceptance checklist

- [ ] Owner-only access remains enforced; logout, work mode and account changes
      revoke old leases. No test or production path uses a metered key fallback.
- [ ] Claude -> ChatGPT and ChatGPT -> Claude work while idle, answering, using
      a host tool, waiting for input and integrating a completed task.
- [ ] Repeated clicks, two windows and cancelled/retried transitions preserve
      one effective actor and one ordered message inbox.
- [ ] Target authentication/model/start failure retains work and exposes a
      useful retry/cancel state without silent provider fallback.
- [ ] Each transition phase survives a fresh process/module restart. No new
      engine work starts before its recovery barrier is resolved.
- [ ] Worker branches/worktrees, uncommitted changes, Board identity, progress
      and budget survive handoff; a finished worker is not restarted as work.
- [ ] Same-provider resume and cross-provider handoff use the latest approved
      shared state, not a stale provider-local conversation alone.
- [ ] Crash before action, during action, after effect and before receipt is
      covered. Unknown effects cannot be automatically repeated or called undone.
- [ ] Assistant pending messages/proposals and approved receipts survive restart;
      ID/body mismatch and duplicate approval cannot perform a second action.
- [ ] Stop/new conversation/delete memory/delete history have tested independent
      semantics. Old callbacks and queued messages cannot resurrect a reset epoch.
- [ ] President and assistant drafts survive fold/reconcile/renderer/app restart;
      late ACKs cannot clear a newer draft or another project's draft.
- [ ] iPhone retries/reconnects/client restart preserve delivery state and drafts;
      legacy clients keep their three ACK states and optional-field compatibility.
- [ ] Both providers, both themes, narrow/desktop widths, IME input and all five
      interactive control states pass browser regressions.
- [ ] Focused and full tests, type checks, lint, builds, protocol/Swift tests and
      fresh-process fault fixtures pass without contacting real model services.
- [ ] Signed normal release is published from the tested tree, installed through
      the normal updater, and verified without touching real in-flight user work.

Physical-device network/audio behavior is reported separately from Core/simulator
and synthetic relay tests. Do not label it verified without a real device run.
