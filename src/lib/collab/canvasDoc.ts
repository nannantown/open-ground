import * as Y from 'yjs'
import type { CanvasElement, CanvasFile } from '../types'
import { ORIGIN_SEED, readCollectionFlat, reconcileCollectionFlat, setKey } from './ydoc'

// Canvas scope (one doc per canvas) = one Y.Map (flat-key encoding, see
// ydoc.ts). Only the shared design state lives here: elements (one flat key per
// element field) + name + element order (z-order, whole-array LWW). Personal/
// ephemeral state (viewport, chats, activeId, sidebar, id, timestamps) rides
// `base`. See docs/COLLAB_PLAN.md.
export const CANVAS_ROOT = 'og'
const EL_PREFIX = 'e:'
const K_NAME = 'm:name'
const K_ORDER = 'm:order'

/** Authoritatively make `doc` reflect `file`'s shared state. Idempotent;
 *  converges across independently-seeded peer docs. */
export const canvasFileToDoc = (doc: Y.Doc, file: CanvasFile): void => {
  const map = doc.getMap<unknown>(CANVAS_ROOT)
  doc.transact(() => {
    setKey(map, K_NAME, file.name)
    setKey(map, K_ORDER, (file.elements ?? []).map((e) => e.id))
    reconcileCollectionFlat(map, EL_PREFIX, file.elements ?? [])
  }, ORIGIN_SEED)
}

/** Build a CanvasFile from the doc's shared state layered over `base`. */
export const docToCanvasFile = (doc: Y.Doc, base: CanvasFile): CanvasFile => {
  const map = doc.getMap<unknown>(CANVAS_ROOT)
  const order = (map.get(K_ORDER) as string[] | undefined) ?? []
  return {
    ...base,
    name: (map.get(K_NAME) as string | undefined) ?? base.name,
    elements: readCollectionFlat(map, EL_PREFIX, order) as unknown as CanvasElement[],
  }
}
