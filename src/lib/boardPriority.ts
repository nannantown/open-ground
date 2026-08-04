// Board card PRIORITY + AGING — the single source of truth shared by the in-app
// swarm dispatcher (server: swarmOrchestrator.sortTodos) and the Board UI
// (client: the drawer priority picker + the card chip). Pure, no React / no
// server deps, so both layers import the SAME ranking and can never drift.
//
// Two halves of one feature ("急ぎを先に・古いカードの放置を防ぐ"):
//   1. PRIORITY  — an explicit per-card rank: urgent > high > normal > low.
//   2. AGING     — a card that lingers in `todo` climbs the queue over time so a
//                  low/normal card can never starve behind a steady trickle of
//                  higher-priority work.

import type { ProjectTask, TaskPriority } from './types'

/** Static rank for the dispatch queue (higher = pulled sooner). 'normal' is the
 *  default an absent `priority` folds to. */
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
}

/** A card's static priority rank — absent `priority` ⇒ 'normal'. */
export const basePriorityRank = (t: Pick<ProjectTask, 'priority'>): number =>
  PRIORITY_RANK[t.priority ?? 'normal']

// ── Aging ────────────────────────────────────────────────────────────────────
// One extra rank per AGING_STEP_MS the card has waited, capped at
// AGING_MAX_BOOST. Age is measured from `createdAt`: a swarm card starts life in
// `todo`, so createdAt-age ≈ todo dwell time (no separate "entered todo" stamp to
// maintain — minimal surface, and it matches sortTodos' existing oldest-first
// tiebreak). With the defaults a card waiting ≥ 9h gains +3, enough for a 'low'
// card (rank 0) to reach 'urgent'-equivalent (rank 3) — classic anti-starvation
// aging, the same idea OS schedulers use.

/** Wait time that earns one extra rank of aging boost. */
export const AGING_STEP_MS = 3 * 60 * 60_000 // 3h
/** Maximum aging boost (ranks) — a card can climb at most this far. */
export const AGING_MAX_BOOST = 3

/** How many ranks `t` has gained from sitting in the queue, as of `now`
 *  (epoch ms). 0 for a fresh card, an unparseable createdAt, or a future
 *  createdAt (clock skew). */
export const agingBoost = (t: Pick<ProjectTask, 'createdAt'>, now: number): number => {
  const created = Date.parse(t.createdAt ?? '')
  if (!Number.isFinite(created)) return 0
  const ageMs = now - created
  if (ageMs <= 0) return 0
  return Math.min(Math.floor(ageMs / AGING_STEP_MS), AGING_MAX_BOOST)
}

/** The rank the dispatcher actually sorts on: static priority + aging boost. */
export const effectivePriorityRank = (
  t: Pick<ProjectTask, 'priority' | 'createdAt'>,
  now: number,
): number => basePriorityRank(t) + agingBoost(t, now)

const cmpCreatedAt = (a: ProjectTask, b: ProjectTask): number =>
  (a.createdAt ?? '').localeCompare(b.createdAt ?? '')

/** Queue order for the `todo` column. Total + stable + pure:
 *    ① effective priority (static + aging) — higher first ("急ぎを先に",
 *       "古いカードの放置を防ぐ");
 *    ② WITHIN one priority bucket, the owner's explicit drag order (boardOrder)
 *       ascending, ordered-before-unordered — the existing manual queue is
 *       preserved as the tiebreak (既存 sortTodos と整合);
 *    ③ then oldest createdAt first.
 *  `now` (epoch ms) is injected so callers/tests are deterministic. */
export const sortByPriority = (
  todos: readonly ProjectTask[],
  now: number,
): ProjectTask[] =>
  [...todos].sort((a, b) => {
    const pa = effectivePriorityRank(a, now)
    const pb = effectivePriorityRank(b, now)
    if (pa !== pb) return pb - pa // higher effective rank first
    const ao = a.boardOrder
    const bo = b.boardOrder
    if (ao != null && bo != null) return ao !== bo ? ao - bo : cmpCreatedAt(a, b)
    if (ao != null) return -1 // an ordered card precedes an un-ordered one
    if (bo != null) return 1
    return cmpCreatedAt(a, b)
  })

// ── UI metadata ──────────────────────────────────────────────────────────────
// Display data for the priority picker (drawer) + the card chip. Co-located here
// so the two UI surfaces share ONE definition (no drift between picker label and
// chip color). i18n key per priority lives in src/i18n/messages/board.ts.

export interface PriorityMeta {
  /** i18n key for the human label, e.g. 'board.detail.priority.urgent'. */
  labelKey: string
  /** Card chip classes (paper theme): border + soft tint + text, at-a-glance. */
  chipClass: string
  /** Drawer pill classes when THIS priority is selected (bg + text together so
   *  the active state always clears contrast — ui-interactive-states rule). */
  pillSelectedClass: string
}

export const PRIORITY_META: Record<TaskPriority, PriorityMeta> = {
  urgent: {
    labelKey: 'board.detail.priority.urgent',
    // Above 高 in the ladder, so it keeps the solid fill AND adds a ring —
    // 高 is now solid vermillion, and a tint would read as LOWER than it.
    chipClass: 'bg-verm text-bg-inset ring-1 ring-inset ring-ink/40',
    pillSelectedClass: 'border-accent bg-accent text-bg-card hover:bg-accent-hover',
  },
  high: {
    labelKey: 'board.detail.priority.high',
    // 案C: 高 = 朱のベタ塗り (`.chip-high` — vermillion fill, dark text, no
    // border, pill). It was an ochre TINT, which collided with the language's
    // own meaning for ochre (待ち) and read as a fourth state on the board.
    // `verm` is a fill-only token: the text sitting ON it is bg-inset, so this
    // pair is checked as a fill, not as vermillion text.
    chipClass: 'bg-verm text-bg-inset',
    pillSelectedClass: 'border-ochre-deep bg-ochre-deep text-bg-card hover:bg-ochre-deeper',
  },
  normal: {
    labelKey: 'board.detail.priority.normal',
    chipClass: 'border-line bg-bg-inset text-ink-muted',
    pillSelectedClass: 'border-ink-muted bg-ink-muted text-bg-card hover:bg-ink',
  },
  low: {
    labelKey: 'board.detail.priority.low',
    // text-ink-muted (not ink-faint): on the chip's bg-inset (#E6DEC6) ink-faint
    // is only 3.96:1 — below WCAG AA. ink-muted clears 5.02:1. (The selected pill
    // below — cream on ink-faint — is already 4.84:1, so it stays.)
    chipClass: 'border-line bg-bg-inset text-ink-muted',
    pillSelectedClass: 'border-ink-faint bg-ink-faint text-bg-card hover:bg-ink-muted',
  },
}
