import type { ProjectTask } from '@/lib/types'

// B025/B026 — pure helpers for the card-face chips and the drawer pickers.
// Dependencies and due dates are INFORMATION ONLY: nothing blocks a launch,
// nothing sorts, nothing notifies. These functions exist so the chip logic
// (what counts as "unresolved", what counts as "overdue") is unit-testable
// away from the JSX.

/** A dependency is satisfied when its card is done — either the `done` flag
 *  or being parked in the done column counts (mirrors columnOf's view). */
const isDoneCard = (t: ProjectTask): boolean => t.done || t.boardColumn === 'done'

/** The cards `task` depends on that still exist on this board AND are not
 *  done yet — the "⛓ n" chip's content. Ids pointing at deleted cards are
 *  skipped here (render-time) but stay untouched in the saved data. */
export const unresolvedDeps = (
  task: Pick<ProjectTask, 'id' | 'dependsOn'>,
  tasks: ProjectTask[],
): ProjectTask[] => {
  const ids = task.dependsOn ?? []
  if (ids.length === 0) return []
  const byId = new Map(tasks.map(t => [t.id, t]))
  const out: ProjectTask[] = []
  for (const id of ids) {
    const dep = byId.get(id)
    if (dep && dep.id !== task.id && !isDoneCard(dep)) out.push(dep)
  }
  return out
}

/** Drawer "+ Add" candidates: every other card on the board EXCEPT
 *  itself, cards already depended on, and cards that themselves depend on
 *  `task` (the one-level cycle check — enough for a minimal board; deeper
 *  cycles would need a graph walk we deliberately don't do). */
export const dependencyCandidates = (
  task: Pick<ProjectTask, 'id' | 'dependsOn'>,
  tasks: ProjectTask[],
): ProjectTask[] => {
  const already = new Set(task.dependsOn ?? [])
  return tasks.filter(
    c =>
      c.id !== task.id &&
      !already.has(c.id) &&
      !(c.dependsOn ?? []).includes(task.id),
  )
}

/** 'YYYY-MM-DD' of `now` in LOCAL time (the date the user's wall clock
 *  shows — not UTC, so a JST evening doesn't flip to tomorrow). */
export const localDateString = (now: Date = new Date()): string => {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Overdue = the due date is TODAY OR EARLIER in local time (due-today
 *  already wants attention). Plain string compare — both sides are
 *  'YYYY-MM-DD', which sorts lexicographically. */
export const isOverdue = (dueDate: string, now: Date = new Date()): boolean =>
  dueDate <= localDateString(now)

/** '2026-06-15' → '6/15' (no leading zeros, no year — the chip is a glance,
 *  the drawer's date input has the full value). Unparseable input is
 *  returned as-is rather than hidden. */
export const formatDueShort = (dueDate: string): string => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dueDate)
  if (!m) return dueDate
  return `${Number(m[1])}/${Number(m[2])}`
}
