// Subset cloning for ⌥-drag duplicate (and any future "copy these in place").
//
// Clones the given elements with fresh ids, remapping parentId / anchorId
// references that point INSIDE the cloned set (a reference to an element
// outside the set is kept only for parentId — the clone stays in the same
// container; a dangling anchorId would point a comment at an uncloned design,
// which is right, since the source element still exists).
//
// Pure + side-effect-free (mirrors canvasGroup.ts); the caller supplies the id
// factory so tests stay deterministic.

import type { CanvasElement } from './types'

export interface CloneResult {
  /** The clone elements, in the sources' relative order. */
  clones: CanvasElement[]
  /** source id → clone id for every cloned element. */
  idMap: Map<string, string>
}

/** Clone the elements whose id is in `ids` (array order preserved). Volatile
 *  per-instance fields (chatId, resolved) are dropped, matching the canvas
 *  paste path. Returns null when `ids` matches nothing. */
export function cloneSubset(
  elements: CanvasElement[],
  ids: ReadonlySet<string>,
  mkId: () => string,
): CloneResult | null {
  const sources = elements.filter((el) => ids.has(el.id))
  if (!sources.length) return null
  const idMap = new Map(sources.map((el) => [el.id, mkId()]))
  const clones = sources.map((el) => {
    const { chatId: _chatId, resolved: _resolved, ...rest } = el
    const next: CanvasElement = { ...rest, id: idMap.get(el.id)! }
    if (el.parentId && idMap.has(el.parentId)) next.parentId = idMap.get(el.parentId)!
    if (el.anchorId) {
      if (idMap.has(el.anchorId)) next.anchorId = idMap.get(el.anchorId)!
      else delete next.anchorId
    }
    return next
  })
  return { clones, idMap }
}
