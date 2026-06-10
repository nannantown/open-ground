// Post-sync board digest — a compact one-liner describing WHAT a share Sync's
// pull changed on the Board, shown in ProjectPanel's share notice instead of
// the generic "Synced". Pure (tasks in → string out) so it unit-tests without
// React or the server; the caller owns snapshotting before/after task lists.

import type { ProjectTask } from '@/lib/types'

/** Minimal translate signature (structurally matches I18nContext's `t`) so the
 *  helper stays decoupled from the React context. */
export type TranslateFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string

/** Undefined column = 'todo' (back-compat, same rule the Board itself uses) —
 *  a card whose column key merely materialised did not actually move. */
const column = (task: ProjectTask): string => task.boardColumn ?? 'todo'

/** Diff `before` → `after` board tasks into a compact digest line, e.g.
 *  `+2 cards (Yuki) · 1 done · 1 moved` / `カード+2（Yuki） · 完了1 · 移動1`.
 *
 *  Counted, in display order:
 *  - added cards (in `after` only), listing the distinct assignees of those
 *    added cards when any are set;
 *  - newly done cards (done flipped false → true). Completion usually parks
 *    the card in the done column too, so a newly-done card is NOT also
 *    counted as a column move;
 *  - column moves (same card, different column, not newly done);
 *  - removed cards (in `before` only).
 *
 *  Returns null when nothing board-visible changed — the caller falls back to
 *  the generic success message. */
export const boardDiffDigest = (
  before: ProjectTask[],
  after: ProjectTask[],
  t: TranslateFn,
): string | null => {
  const beforeById = new Map(before.map(task => [task.id, task]))
  const afterIds = new Set(after.map(task => task.id))

  const added = after.filter(task => !beforeById.has(task.id))
  const removedCount = before.filter(task => !afterIds.has(task.id)).length

  let doneCount = 0
  let movedCount = 0
  for (const task of after) {
    const prev = beforeById.get(task.id)
    if (!prev) continue
    if (!prev.done && task.done) doneCount++
    else if (column(prev) !== column(task)) movedCount++
  }

  const segments: string[] = []
  if (added.length > 0) {
    const names = Array.from(
      new Set(added.map(task => (task.assignee ?? '').trim()).filter(Boolean)),
    ).join(', ')
    const key =
      added.length === 1
        ? names
          ? 'projectPanel.syncDigestAddedOneBy'
          : 'projectPanel.syncDigestAddedOne'
        : names
          ? 'projectPanel.syncDigestAddedBy'
          : 'projectPanel.syncDigestAdded'
    segments.push(t(key, { count: added.length, names }))
  }
  if (doneCount > 0) segments.push(t('projectPanel.syncDigestDone', { count: doneCount }))
  if (movedCount > 0) segments.push(t('projectPanel.syncDigestMoved', { count: movedCount }))
  if (removedCount > 0)
    segments.push(t('projectPanel.syncDigestRemoved', { count: removedCount }))

  return segments.length > 0 ? segments.join(' · ') : null
}
