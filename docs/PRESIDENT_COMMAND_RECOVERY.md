# President command continuity

## Confirmed failure and boundary

An application update could retire a president after its owner input was claimed
but before its durable receipt settled. Startup correctly retained that input as
`uncertain`, while the ordinary role bootstrap could still produce a reply. The
remaining owner inputs then waited behind the unresolved receipt. A responsive
model does not prove that the original input has settled. This shared inbox
boundary applies to both SDK and PTY presidents.

## Current behavior

- The restart-safety probe includes required `activeOwnerTurns`, combining live
  supply activity and executing owner input receipts. Automatic updates wait for
  those turns even with ASAP or the normal deferral ceiling. Background managers
  and workers retain their existing update/resume policy. Queued or already
  uncertain inputs alone do not prevent installing a repair.
- An SDK transport exit settles a consumed input as uncertain before releasing
  its lease. A failed receipt write retains the closing entry and retries the
  receipt write through existing pool observations; it never replays the input.
  Unconsumed inputs release their old reservation and can enter a replacement
  actor under the same durable ID. A cancelled input is skipped without killing
  the next unrelated turn.
- Exact-turn Stop checks the observed turn again at the synchronous interrupt
  boundary. A stale stop cannot interrupt a later turn.
- `POST /api/conversation/president/cancel-inputs` pins owner, project,
  conversation, epoch, operation ID and an explicit list of input IDs. All
  selected inputs and the cancellation receipt commit atomically. Queued inputs
  can be revoked before claim; executing or occupied recorded inputs reject.
  An owner may abandon an unoccupied uncertain instruction without claiming
  that its effects completed or were rolled back.
- Cancellation retains the original body, error, execution and prior result.
  Late callbacks cannot revive it. Tool receipts are independent and are never
  implicitly reviewed or erased by cancelling an owner instruction.
- The shared SDK/PTY resume prompt checks the live Board and waits for newly
  delivered input. President handoff also treats its old public conversation as
  context only. Neither prompt grants permission to resume an old owner command
  from conversation history; that bypassed the durable inbox and cancellation.
- The president's pending-input controls remain available after its seat closes.
  Cancellation survives an acknowledgement loss with the same operation ID and
  preserves newer unsent words. An earlier pending-status response cannot make
  a cancelled input appear queued again.

## Verification

Regression coverage includes receipt claim/cancel races and durable-write
failures, SDK transport exit with and without consumed input, old-turn Stop,
the actual restart probe for both pools, delayed browser status reads, and
desktop/narrow president conversations in both themes. Runtime acceptance uses
the signed installed Electron Node with isolated storage, denied network and a
fake model transport; those seams do not establish vendor availability.

An unexpected operating-system or process failure can still leave genuinely
unconfirmed work. It remains visible for inspection or explicit cancellation;
the application must not guess that an external effect did or did not happen.
