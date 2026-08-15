// Board card ↔ escalation inbox — the DISPLAY-ONLY glue between the swarm's
// open questions (GET /api/swarm/escalations?status=open) and the card each one
// is rooted in. Pure (no React, no fetch) so the scoping rule below is
// unit-testable on its own; nothing here answers, dismisses or mutates a
// record. The inbox is owner-gated upstream.
//
// ⚠ THE SCOPING RULE IS THE WHOLE POINT. An escalation carries a `taskId` only
// when it is WORKER-ROOTED (S4 worker question, S1 rework-exhausted, S5
// blocked-dwell). The board-wide valves — S2 all-workers-down, S3/S10 edge
// fatals — carry none, because there is no one card they are about. Attaching
// one of those to a card (or to every card) is the 差し戻し M2 fabrication in a
// new costume: the surface would claim a fact the record does not hold. They
// are counted separately instead, and BoardModule reports the count at
// board altitude where it is true.

import type { EscalationView, EscalationWhy } from '@/lib/types'

/** What ONE card shows about an open question rooted in it. Deliberately tiny:
 *  the badge is READ-ONLY (answering an escalation declares a `declineEffect`
 *  and belongs on a surface with room for it, not on a 166px card). */
export interface BoardCardAlert {
  /** Which valve raised it — rendered as a short reason word. */
  reason: EscalationWhy
  /** 平易文 when the raiser wrote one, else the raw question. Tooltip ONLY —
   *  it is a full sentence and would blow the column width as body text. */
  hint?: string
}

export interface BoardEscalationIndex {
  /** taskId → the newest open question rooted in that card. */
  byTask: ReadonlyMap<string, BoardCardAlert>
  /** Open questions that name NO card. They are real and they are waiting on
   *  the owner — they simply have no card to sit on. */
  unattributed: number
}

const EMPTY: BoardEscalationIndex = { byTask: new Map(), unattributed: 0 }

/** Index the OPEN inbox by the card each question is rooted in.
 *
 *  Ties (two open questions on one card) are broken by newest `createdAt`; an
 *  unparseable/absent `createdAt` loses to any parseable one, and loses to the
 *  incumbent when both are unusable — a record we cannot order must not evict
 *  one we can. */
export const indexEscalationsByTask = (
  list: readonly EscalationView[] | undefined | null,
): BoardEscalationIndex => {
  if (!list || list.length === 0) return EMPTY
  const byTask = new Map<string, BoardCardAlert>()
  const createdAtByTask = new Map<string, number>()
  let unattributed = 0
  for (const e of list) {
    const taskId = typeof e?.taskId === 'string' ? e.taskId.trim() : ''
    if (!taskId) {
      unattributed++
      continue
    }
    const createdMs = Date.parse(e.createdAt ?? '')
    const rank = Number.isFinite(createdMs) ? createdMs : Number.NEGATIVE_INFINITY
    const incumbent = createdAtByTask.get(taskId)
    if (incumbent !== undefined && rank <= incumbent) continue
    const hint = (e.plainQuestion ?? e.question ?? '').trim()
    byTask.set(taskId, {
      reason: e.whyEscalated,
      ...(hint ? { hint } : {}),
    })
    createdAtByTask.set(taskId, rank)
  }
  return { byTask, unattributed }
}
