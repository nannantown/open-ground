import * as Y from 'yjs'
import type { ProjectData, ProjectTask } from '../types'
import { ORIGIN_SEED, readCollectionFlat, reconcileCollectionFlat, setKey } from './ydoc'

// Board scope = one Y.Map (flat-key encoding, see ydoc.ts). Only the SHARED
// fields of ProjectData live here; personal/central fields (tabOrder, customTabs,
// launch, updatedAt) NEVER enter the doc — they ride the `base` arg of
// boardDocToProjectData. notes + task order are whole-value LWW (NOT char-merge);
// see docs/COLLAB_PLAN.md for why.
export const BOARD_ROOT = 'og'
export const TASK_PREFIX = 't:'
export const K_DESCRIPTION = 'm:description'
export const K_DESCRIPTION_JA = 'm:descriptionJa'
export const K_DESCRIPTION_EN = 'm:descriptionEn'
export const K_CONFIG = 'm:config'
export const K_NOTES = 'm:notes'
export const K_ORDER = 'm:order'
// The SHARED canvas index ([{id,name}]) lives on the board doc so a folder-less
// member can discover the project's canvases. CRITICAL: it has a DIFFERENT writer
// than the rest of the board — the owner's Canvas tab publishes it via
// writeBoardCanvasIndex, while the Board tab's full seed (projectDataToBoardDoc)
// must NOT touch it (a Board-tab seed carries no canvas list, so seeding it would
// LWW-delete the index the Canvas tab set). So this key is deliberately excluded
// from projectDataToBoardDoc and round-tripped only by the dedicated helpers +
// the member read in boardDocToProjectData.
const K_CANVAS_INDEX = 'm:canvasIndex'

type CanvasIndexEntry = { id: string; name: string }

/** Authoritatively make `doc` reflect `data`'s shared fields. Idempotent
 *  (re-applying identical data emits zero updates → loop-safe to call on every
 *  local persist). Converges across INDEPENDENTLY-seeded peer docs. */
export const projectDataToBoardDoc = (doc: Y.Doc, data: ProjectData): void => {
  const map = doc.getMap<unknown>(BOARD_ROOT)
  doc.transact(() => {
    setKey(map, K_DESCRIPTION, data.description)
    setKey(map, K_DESCRIPTION_JA, data.descriptionJa)
    setKey(map, K_DESCRIPTION_EN, data.descriptionEn)
    setKey(map, K_CONFIG, data.config)
    setKey(map, K_NOTES, data.notes ?? '')
    setKey(map, K_ORDER, (data.tasks ?? []).map((t) => t.id))
    reconcileCollectionFlat(map, TASK_PREFIX, data.tasks ?? [])
    // NOTE: K_CANVAS_INDEX is intentionally NOT written here — see its comment.
  }, ORIGIN_SEED)
}

/** Publish the SHARED canvas index into the board doc (owner's Canvas tab). Kept
 *  separate from projectDataToBoardDoc so a Board-tab seed never clobbers it.
 *  LWW whole-value; idempotent (no update when unchanged). */
export const writeBoardCanvasIndex = (
  doc: Y.Doc,
  index: CanvasIndexEntry[],
): void => {
  const map = doc.getMap<unknown>(BOARD_ROOT)
  doc.transact(() => {
    setKey(
      map,
      K_CANVAS_INDEX,
      index.map((c) => ({ id: c.id, name: c.name })),
    )
  }, ORIGIN_SEED)
}

/** Read the shared canvas index back (the member's canvas list). [] when unset. */
export const readBoardCanvasIndex = (doc: Y.Doc): CanvasIndexEntry[] => {
  const map = doc.getMap<unknown>(BOARD_ROOT)
  const raw = map.get(K_CANVAS_INDEX)
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).filter(
    (e): e is CanvasIndexEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as CanvasIndexEntry).id === 'string' &&
      typeof (e as CanvasIndexEntry).name === 'string',
  )
}

/** Build a ProjectData from the doc's shared fields layered over `base` (which
 *  supplies the personal/central fields). Doc-present meta overrides; absent
 *  inherits base, so the doc never silently wipes on-disk state it lacks. */
export const boardDocToProjectData = (doc: Y.Doc, base: ProjectData): ProjectData => {
  const map = doc.getMap<unknown>(BOARD_ROOT)
  const order = (map.get(K_ORDER) as string[] | undefined) ?? []
  const out: ProjectData = {
    ...base,
    description: (map.get(K_DESCRIPTION) as string | undefined) ?? base.description ?? '',
    tasks: readCollectionFlat(map, TASK_PREFIX, order) as unknown as ProjectTask[],
    notes: (map.get(K_NOTES) as string | undefined) ?? base.notes ?? '',
  }
  if (map.has(K_DESCRIPTION_JA)) out.descriptionJa = map.get(K_DESCRIPTION_JA) as string
  if (map.has(K_DESCRIPTION_EN)) out.descriptionEn = map.get(K_DESCRIPTION_EN) as string
  if (map.has(K_CONFIG)) out.config = map.get(K_CONFIG) as ProjectData['config']
  // The shared canvas index — what a member uses to list/open canvases. Read via
  // the validating helper so a malformed value can't poison the member's UI.
  if (map.has(K_CANVAS_INDEX)) out.canvasIndex = readBoardCanvasIndex(doc)
  return out
}
