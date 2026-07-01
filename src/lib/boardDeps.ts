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
 *  skipped here (render-time) but stay untouched in the saved data.
 *
 *  The second argument is EITHER the full task array (the original signature —
 *  builds its lookup internally; kept for the unit tests + ad-hoc callers) OR a
 *  pre-built `id → task` Map. The Map path exists for the Board's hot render
 *  loop: calling this per card with the array rebuilt the lookup O(N) times per
 *  card → O(N²) per board render (and a board render happens on every drag
 *  frame). The Board now hoists the Map once per render (useMemo over
 *  data.tasks) and passes it here, collapsing the whole pass back to O(N). Both
 *  forms return identical results. */
export function unresolvedDeps(
  task: Pick<ProjectTask, 'id' | 'dependsOn'>,
  tasks: ProjectTask[],
): ProjectTask[]
export function unresolvedDeps(
  task: Pick<ProjectTask, 'id' | 'dependsOn'>,
  byId: ReadonlyMap<string, ProjectTask>,
): ProjectTask[]
export function unresolvedDeps(
  task: Pick<ProjectTask, 'id' | 'dependsOn'>,
  tasksOrById: ProjectTask[] | ReadonlyMap<string, ProjectTask>,
): ProjectTask[] {
  const ids = task.dependsOn ?? []
  if (ids.length === 0) return []
  const byId = Array.isArray(tasksOrById)
    ? new Map(tasksOrById.map(t => [t.id, t]))
    : tasksOrById
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

/** Card ids that lie on at least one dependency CYCLE (A→B→…→A). A card on a
 *  cycle can never have all its prerequisites land, so the in-app swarm's ⑤
 *  DEPENDS gate (selectDispatch) would hold every card on the loop FOREVER — a
 *  silent deadlock (無限待ち). The Board surfaces these ids as a warning chip so
 *  the owner notices and breaks the loop; this helper only DETECTS — it never
 *  mutates data or unblocks dispatch on its own (auto-overriding a declared
 *  order would be worse than the stall it replaces).
 *
 *  Membership is decided by STRONGLY CONNECTED COMPONENTS (Tarjan): a card is on
 *  a cycle iff its SCC has ≥ 2 members. This is exact and ORDER-INDEPENDENT — a
 *  plain back-edge DFS silently MISSES a node reachable only through a cross edge
 *  (e.g. 1→2, 2→[3,4], 3→1, 4→3: node 4 sits on the loop 1→2→4→3→1, but a
 *  back-edge walk that finishes node 3 before exploring 4 drops 4 — and worse,
 *  its answer flips with the dependsOn array order). SCC has neither failure.
 *
 *  Edges followed are only dependsOn ids pointing at a card ACTUALLY on the board
 *  (a deleted / typo'd id is a dead edge — exactly how the dispatch gate treats
 *  it, and it can't close a real cycle); self-edges are dropped (A→A is a data
 *  quirk, an SCC of one, never a scheduling deadlock — mirrors unresolvedDeps).
 *  Reports EVERY id on a cycle, across multiple disjoint OR overlapping cycles,
 *  and excludes a card that merely points INTO a cycle without sitting on it.
 *  Each card is explored once (the `index` guard), so recursion depth ≤ the card
 *  count and a pre-existing cycle can never loop forever. */
export const dependencyCycleIds = (
  tasks: Pick<ProjectTask, 'id' | 'dependsOn'>[],
): Set<string> => {
  const byId = new Map(tasks.map(t => [t.id, t]))
  // Adjacency: dependsOn ids on the board, self-edges dropped (an SCC of one is
  // never a deadlock — keeps A→A out of the result by construction).
  const edgesOf = (id: string): string[] => {
    const deps = byId.get(id)?.dependsOn
    if (!Array.isArray(deps)) return []
    return deps.filter(d => d !== id && byId.has(d))
  }

  // Tarjan's SCC. `index` = discovery order (doubles as the visited guard),
  // `low` = lowest index reachable, `stack`/`onStack` = current component
  // frontier. A component of size ≥ 2 is exactly a set of cards on a cycle.
  const onCycle = new Set<string>()
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let counter = 0

  const strongconnect = (v: string): void => {
    const vIndex = counter++
    index.set(v, vIndex)
    stack.push(v)
    onStack.add(v)
    let vLow = vIndex
    for (const w of edgesOf(v)) {
      const wIndex = index.get(w)
      if (wIndex === undefined) {
        strongconnect(w) // tree edge — w not yet visited
        const wLow = low.get(w)
        if (wLow !== undefined && wLow < vLow) vLow = wLow
      } else if (onStack.has(w) && wIndex < vLow) {
        vLow = wIndex // back / cross edge into a still-open component
      }
    }
    low.set(v, vLow)
    if (vLow === vIndex) {
      // v roots an SCC — pop the component off the stack down to v inclusive.
      const component: string[] = []
      while (stack.length > 0) {
        const w = stack.pop()
        if (w === undefined) break
        onStack.delete(w)
        component.push(w)
        if (w === v) break
      }
      if (component.length >= 2) for (const id of component) onCycle.add(id)
    }
  }

  for (const t of tasks) if (!index.has(t.id)) strongconnect(t.id)
  return onCycle
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
