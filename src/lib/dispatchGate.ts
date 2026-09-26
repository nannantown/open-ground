// dispatchGate — the per-card gates that decide whether the swarm engine may
// START a queued (todo) card. Pure and client-safe on purpose: the engine's
// selectDispatch (swarmOrchestrator.ts, gates ⑥⑦⑧) and the Ground lamp's
// inFlightTaskCount (src/lib/groundLamp.ts) both read THIS, so the lamp can never
// call a card "about to move" that the engine will never start (2026-09-26: a
// title-only memo card in todo held a project RUNNING forever).
//
// The board-dependent gates (② already in flight, ③ duplicate content, ④
// same-file conflict, ⑤ prerequisites) stay in selectDispatch — they are about
// the rest of the board, not the card.

import type { ProjectTask } from '@/lib/types'

/** Does this card carry the COMPLETION CONDITIONS a worker needs — i.e. is its
 *  `notes` body non-empty?
 *
 *  ⚠ THE ACCIDENT THIS EXISTS FOR (owner report, 2026-09-11). The supply officer
 *  queued two cards; autopilot dispatched BOTH to workers 8 seconds later, before
 *  the 完了条件 had been written. The workers started on a title alone. This was
 *  not a mistake by the writer — the SHIPPED supply procedure said to `add` the
 *  title first and fill `notes` in a second write (skills/supply/SKILL.md step
 *  4), so every queued card passed through a window where it was dispatchable
 *  and incomplete. The procedure is fixed too, but an instruction is not a
 *  guard: any writer (a human typing into the Board's 未着手 column included)
 *  can leave a card title-only for a moment, and the engine ticks every 3s.
 *
 *  So the invariant lives HERE, in the queue gate: a card with no body is not
 *  work, it is a placeholder. The owner's manual 実行 button is deliberately
 *  unaffected — pressing it IS the statement "dispatch this as it stands". */
export const hasCompletionConditions = (t: ProjectTask): boolean =>
  (t.notes ?? '').trim().length > 0

/** May the engine start this card at all, judged on the card alone?
 *  ⑥ SELF-SUPPLY APPROVAL (card b3fbbfba) — a card the engine PROPOSED itself
 *    (selfSupplyKey set) is an inert proposal until the owner approves it: the
 *    primary runaway defense. A human-authored card is unaffected.
 *  ⑦ CONTENT REQUIRED (2026-09-11) — an empty body is a placeholder, not work.
 *  ⑧ DRAFT (2026-09-26) — still being written, see ProjectTask.draft. */
export const isDispatchableCard = (t: ProjectTask): boolean =>
  !(t.selfSupplyKey && !t.selfSupplyApproved) && hasCompletionConditions(t) && !t.draft
