// Group / ungroup (Figma ⌘G / ⌘⇧G) for the embedded Canvas.
//
// A *group* is an explicit, invisible container element (`type: 'group'`): it
// renders nothing on the canvas and owns its members purely via `parentId`
// (unlike a frame, whose membership is geometric). Grouping wraps the selected
// top-level elements under one new group element; ungrouping dissolves it and
// hands each child back to the group's own parent (so nested groups survive).
//
// On the canvas a group is the *selection unit*: clicking any member selects the
// whole group, and the existing multi-select drag then moves them together.
// {@link expandSelectionForElement} encodes that "click a member → select the
// group" rule, shared by the canvas and the Layers panel.
//
// Pure + side-effect-free so it unit-tests in isolation (mirrors
// canvasContainment.ts / canvasLayerTree.ts).

import type { CanvasElement } from './types'

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

export interface GroupResult {
  elements: CanvasElement[]
  groupId: string
  /** The members that were placed under the new group (its direct children). */
  memberIds: string[]
}

/** Wrap the selected *top-level* elements in a new group element.
 *
 *  "Top-level within the selection" means an element whose own parent isn't also
 *  selected — so selecting a frame and a sticky inside it groups just the frame
 *  (the sticky stays the frame's child). Returns null (no-op) when fewer than 2
 *  such elements are selected. The new group adopts the members' common parent
 *  when they all share one, so grouping inside a frame keeps the group in the
 *  frame. `makeId` supplies the group's id (passed in for testability); `bounds`
 *  measures an element's box so the group can record its enclosing rect. */
export const groupElements = (
  els: CanvasElement[],
  selectedIds: string[],
  makeId: () => string,
  bounds: (el: CanvasElement) => Bounds,
): GroupResult | null => {
  const idSet = new Set(selectedIds)
  const members = els.filter(
    (e) => idSet.has(e.id) && !(e.parentId && idSet.has(e.parentId)),
  )
  if (members.length < 2) return null

  // Enclosing rect of the members → the (invisible) group's recorded box.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const m of members) {
    const b = bounds(m)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }

  // Adopt the members' common parent when they all share one (group nests there).
  const parents = new Set(members.map((m) => m.parentId ?? null))
  const groupParent = parents.size === 1 ? members[0].parentId : undefined

  const groupId = makeId()
  const memberIds = new Set(members.map((m) => m.id))
  const reparented = els.map((e) =>
    memberIds.has(e.id) ? { ...e, parentId: groupId } : e,
  )
  const group = {
    id: groupId,
    type: 'group',
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    text: '',
    ...(groupParent ? { parentId: groupParent } : {}),
  } as unknown as CanvasElement
  // Append at the front of z-order; the panel nests members under it.
  return { elements: [...reparented, group], groupId, memberIds: Array.from(memberIds) }
}

export interface UngroupResult {
  elements: CanvasElement[]
  /** Ids of the elements freed from the dissolved group(s) — the new selection. */
  freedIds: string[]
}

/** Dissolve every group implicated by the selection: a selected group element
 *  itself, or the parent group of any selected member. Each child of a dissolved
 *  group is handed to that group's own parent (so an outer group survives), and
 *  the group elements are removed. Returns null (no-op) when the selection
 *  touches no group. */
export const ungroupElements = (
  els: CanvasElement[],
  selectedIds: string[],
): UngroupResult | null => {
  const byId = new Map(els.map((e) => [e.id, e]))
  const groupIds = new Set<string>()
  for (const id of selectedIds) {
    const el = byId.get(id)
    if (!el) continue
    // A directly-selected group dissolves itself; a selected *member* dissolves
    // the group it sits in. (else-if so selecting a nested group doesn't also
    // dissolve its outer group.)
    if (el.type === 'group') groupIds.add(el.id)
    else if (el.parentId && byId.get(el.parentId)?.type === 'group')
      groupIds.add(el.parentId)
  }
  if (!groupIds.size) return null

  const freedIds: string[] = []
  const elements = els
    .filter((e) => !groupIds.has(e.id)) // drop the group elements
    .map((e) => {
      if (e.parentId && groupIds.has(e.parentId)) {
        freedIds.push(e.id)
        // Rehome to the nearest ancestor that ISN'T also being dissolved — when
        // an outer + inner group are ungrouped together, the child must land on
        // whatever survives above them (or top level), never on a just-removed
        // grandparent. Cycle-safe via the seen guard.
        let gp = byId.get(e.parentId)?.parentId
        const seen = new Set<string>([e.id, e.parentId])
        while (gp && groupIds.has(gp) && !seen.has(gp)) {
          seen.add(gp)
          gp = byId.get(gp)?.parentId
        }
        // Top level reached, OR the walk terminated on a cycle still inside the
        // dissolved set — either way there's no surviving ancestor, so free it.
        if (gp === undefined || groupIds.has(gp)) {
          const { parentId: _drop, ...rest } = e
          return rest as CanvasElement
        }
        return { ...e, parentId: gp }
      }
      return e
    })
  return { elements, freedIds }
}

/** Figma ⌘⇧G on frames: dissolve every DIRECTLY-selected frame — its children
 *  are handed to the frame's own parent (so a frame inside a frame survives)
 *  and the frame element is removed, its auto layout dying with it. This is
 *  the unwrap counterpart to ⇧A's wrap, mirroring Figma where ungroup also
 *  dissolves an auto-layout frame. Unlike {@link ungroupElements}, a selected
 *  MEMBER does not dissolve its frame — frames are first-class design objects,
 *  not invisible selection units. Returns null when no selected id is a
 *  frame. */
export const dissolveFrames = (
  els: CanvasElement[],
  selectedIds: string[],
): UngroupResult | null => {
  const byId = new Map(els.map((e) => [e.id, e]))
  const frameIds = new Set(
    selectedIds.filter((id) => byId.get(id)?.type === 'frame'),
  )
  if (!frameIds.size) return null

  const freedIds: string[] = []
  const elements = els
    .filter((e) => !frameIds.has(e.id))
    .map((e) => {
      if (e.parentId && frameIds.has(e.parentId)) {
        freedIds.push(e.id)
        // Rehome to the nearest ancestor that survives the dissolve — same
        // walk as ungroupElements (an outer frame dissolved in the same press
        // can't adopt). Cycle-safe via the seen guard.
        let gp = byId.get(e.parentId)?.parentId
        const seen = new Set<string>([e.id, e.parentId])
        while (gp && frameIds.has(gp) && !seen.has(gp)) {
          seen.add(gp)
          gp = byId.get(gp)?.parentId
        }
        if (gp === undefined || frameIds.has(gp)) {
          const { parentId: _drop, ...rest } = e
          return rest as CanvasElement
        }
        return { ...e, parentId: gp }
      }
      return e
    })
  return { elements, freedIds }
}

/** True when `id` has a GROUP ancestor (along the parentId chain) whose `flag`
 *  is set — used to cascade a group's `hidden` / `locked` to its members (a
 *  group is invisible, so the toggle must take effect through its children).
 *  Only group ancestors count, so existing frame/design behavior is unchanged.
 *  Cycle-safe. O(depth) per call — for a whole-canvas pass prefer
 *  {@link groupCascadeSets}, which is O(n) total. */
export const hasGroupAncestorFlag = (
  els: CanvasElement[],
  id: string,
  flag: 'hidden' | 'locked',
): boolean => {
  const byId = new Map(els.map((e) => [e.id, e]))
  const seen = new Set<string>()
  let cur = byId.get(id)
  while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
    seen.add(cur.id)
    const parent = byId.get(cur.parentId)!
    if (parent.type === 'group' && parent[flag]) return true
    cur = parent
  }
  return false
}

/** Precompute, in ONE O(n) pass, the set of element ids hidden / locked because
 *  a GROUP ancestor carries that flag. The render loop calls this once and does
 *  O(1) `.has` lookups, instead of an O(depth) ancestor walk per element (which
 *  made the whole render O(n²)). Cycle-safe. */
export const groupCascadeSets = (
  els: CanvasElement[],
): { hiddenViaGroup: Set<string>; lockedViaGroup: Set<string> } => {
  const childrenOf = new Map<string, string[]>()
  for (const e of els) {
    if (!e.parentId) continue
    const list = childrenOf.get(e.parentId)
    if (list) list.push(e.id)
    else childrenOf.set(e.parentId, [e.id])
  }
  // Add every descendant of `rootId` to `into` (the set doubles as the visited
  // guard, so a cycle can't loop forever).
  const markDescendants = (rootId: string, into: Set<string>) => {
    const stack = [...(childrenOf.get(rootId) ?? [])]
    while (stack.length) {
      const id = stack.pop()!
      if (into.has(id)) continue
      into.add(id)
      for (const kid of childrenOf.get(id) ?? []) stack.push(kid)
    }
  }
  const hiddenViaGroup = new Set<string>()
  const lockedViaGroup = new Set<string>()
  for (const e of els) {
    if (e.type !== 'group') continue
    if (e.hidden) markDescendants(e.id, hiddenViaGroup)
    if (e.locked) markDescendants(e.id, lockedViaGroup)
  }
  return { hiddenViaGroup, lockedViaGroup }
}

/** The top-most group ancestor of `id` along the parentId chain, or undefined
 *  when `id` is not inside any group. Cycle-safe. */
export const topGroupId = (
  els: CanvasElement[],
  id: string,
): string | undefined => {
  const byId = new Map(els.map((e) => [e.id, e]))
  let top: string | undefined
  const seen = new Set<string>()
  let cur = byId.get(id)
  while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
    seen.add(cur.id)
    const parent = byId.get(cur.parentId)!
    if (parent.type === 'group') top = parent.id
    cur = parent
  }
  return top
}

/** Every non-group element transitively inside `groupId` — the movable members
 *  that selecting the group should select. Cycle-safe. */
export const groupLeafIds = (els: CanvasElement[], groupId: string): string[] => {
  const childrenOf = new Map<string, CanvasElement[]>()
  for (const e of els) {
    if (!e.parentId) continue
    const list = childrenOf.get(e.parentId)
    if (list) list.push(e)
    else childrenOf.set(e.parentId, [e])
  }
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [groupId]
  while (stack.length) {
    const cur = stack.pop()!
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      if (child.type === 'group') stack.push(child.id)
      else {
        out.push(child.id)
        // a non-group container (frame) inside a group still has descendants
        // that ride along, so keep walking.
        stack.push(child.id)
      }
    }
  }
  return out
}

/** The ids to select when the user clicks element `id`: the whole group when
 *  `id` is (or sits inside) a group, otherwise just `id` itself. This is the
 *  "click a member → select the group" rule, shared by canvas + Layers panel. */
export const expandSelectionForElement = (
  els: CanvasElement[],
  id: string,
): string[] => {
  const byId = new Map(els.map((e) => [e.id, e]))
  const el = byId.get(id)
  if (!el) return [id]
  if (el.type === 'group') {
    const leaves = groupLeafIds(els, id)
    return leaves.length ? leaves : [id]
  }
  const top = topGroupId(els, id)
  if (!top) return [id]
  const leaves = groupLeafIds(els, top)
  return leaves.length ? leaves : [id]
}

/** Expand a set of element ids to also include each GROUP element whose members
 *  are ALL in the set — used by copy/cut/duplicate so a fully-selected group's
 *  invisible element travels with its members (cloneForPaste remaps parentId and
 *  the copies stay grouped), while a PARTIAL selection of a group's members does
 *  NOT drag the group along (those copies come out loose). Frame/design ancestors
 *  are never added. Cycle-safe. */
export const withGroupAncestors = (
  els: CanvasElement[],
  ids: Iterable<string>,
): string[] => {
  const byId = new Map(els.map((e) => [e.id, e]))
  const idSet = new Set(ids)
  const out = new Set<string>(idSet)
  // Collect every group that is an ancestor of a selected element.
  const candidates = new Set<string>()
  for (const id of Array.from(idSet)) {
    const seen = new Set<string>()
    let cur = byId.get(id)
    while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id)
      const parent = byId.get(cur.parentId)!
      if (parent.type === 'group') candidates.add(parent.id)
      cur = parent
    }
  }
  // Keep only groups whose entire membership is selected (preserve a whole
  // group, not a fragment).
  for (const gid of Array.from(candidates)) {
    const leaves = groupLeafIds(els, gid)
    if (leaves.length && leaves.every((l) => idSet.has(l))) out.add(gid)
  }
  return Array.from(out)
}
