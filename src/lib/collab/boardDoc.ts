import * as Y from 'yjs'
import type { ProjectData, ProjectTask } from '../types'
import { ORIGIN_SEED, jsonEqual, readCollectionFlat, reconcileCollectionFlat, setKey } from './ydoc'

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
// DISK-AUTHORITY STAMP (bug 74ec0b0d — a `done` card silently rolled back to
// `review`, twice, with no writer in any log).
//
// For the OWNER the disk (central tasks.json) is the authority and the doc is a
// projection of it: every server-side board write mirrors itself into the doc
// (collabMirror.ts). The owner's client closes that loop by writing the doc BACK
// to disk on every remote update (BoardModule's onRemote → persist), taking the
// task list WHOLESALE from the doc. That write carries a FRESH CAS token, so the
// store's compare-and-swap can't stop it.
//
// The hole: the mirror is fire-and-forget with retries, and an out-of-band writer
// (swarm-board.sh's app-down fallback) skips it entirely. While the doc is BEHIND
// disk — for the length of a mirror retry backoff, or forever after a direct file
// write — ANY remote doc update (a peer's edit, the owner's own Canvas tab
// publishing m:canvasIndex through a SECOND board binding, a reconnect sync)
// makes the client persist the doc's stale task list over the newer disk state.
// A card the engine had just moved review→done reappears in `review`.
//
// So the doc records WHICH disk state its board content was derived from. Only
// the two writers that assert disk truth stamp it — the server mirror and the
// owner's authoritative seed — and the owner refuses to adopt doc→disk until the
// stamp PROVABLY covers the disk state it holds (see docSeesDisk: stamps come in
// two precisions and are compared as intervals, never as values). A doc that is
// behind, or that merely MIGHT be behind, is left alone: the mirror's retry
// brings it forward, and its update re-enters the adoption path. Nothing is lost
// in either direction, and no writer — server, browser, or a second-precision
// shell writing tasks.json straight — can walk a card backwards on disk.
const K_DISK_STAMP = 'm:diskStamp'

type CanvasIndexEntry = { id: string; name: string }

// STAMPS HAVE TWO PRECISIONS, and comparing them as plain numbers is a trap.
// The server mints millisecond ISO (nextUpdatedAt); `swarm-board.sh` writes
// `now | todateiso8601`, which TRUNCATES to the second ("…T01:19:00Z"). A shell
// write at real time 01:19:00.85 therefore stamps 01:19:00.000 — numerically
// SMALLER than a server stamp of 01:19:00.800 that happened EARLIER. Ordering
// them by value silently inverts real time inside a shared wall-second.
//
// So a stamp is not a point, it is the INTERVAL of instants it could denote:
// millisecond stamps are [t, t]; a second-precision stamp is [t, t+999]. Every
// comparison below asks a question that must be answered with certainty
// ("is the doc PROVABLY caught up?", "is this seed PROVABLY older?") and falls to
// the safe side whenever the intervals overlap.

/** Earliest instant a stamp can denote; NaN for absent/empty/unparseable. */
const stampLo = (v: unknown): number => (typeof v === 'string' && v ? Date.parse(v) : NaN)

/** True when the stamp carries no sub-second digits — it names a whole second,
 *  not an instant. Detected on the STRING (a server stamp of `…:00.000Z` keeps
 *  its fractional part, so it is NOT coarse). */
const isCoarse = (v: unknown): boolean => typeof v === 'string' && !/\.\d/.test(v)

/** Latest instant a stamp can denote. */
const stampHi = (v: unknown): number => {
  const lo = stampLo(v)
  return Number.isFinite(lo) && isCoarse(v) ? lo + 999 : lo
}

/** May a writer assert `data.updatedAt`-era board CONTENT into this doc?
 *
 *  No, if the doc already reflects a PROVABLY newer disk state. The stamp's whole
 *  meaning is "the board content here was derived from that disk state" — a writer
 *  that overwrites the content with an older snapshot while the stamp stays put
 *  (it is monotonic) would break that invariant and hand `docSeesDisk` a lie.
 *
 *  This is the exact rollback observed in the field on 2026-07-09: the mirror had
 *  brought the doc to `done`, the owner's client then OPTIMISTICALLY re-seeded a
 *  stale snapshot still holding `review` (persistLocal seeds `next` before the
 *  PUT resolves), the store REFUSED that snapshot with a 409 and the client
 *  adopted the fresh disk state — leaving a doc whose content said `review` under
 *  a stamp that said `done`. The next remote update passed the gate and wrote
 *  `review` back to disk. Refusing the stale seed outright is what closes it.
 *
 *  PROVABLY older = the seed's LATEST possible instant still precedes the doc's
 *  EARLIEST. A coarse (second-precision) seed sharing the doc's wall-second is
 *  therefore NOT refused: it may well be the newer write (the shell truncates
 *  01:19:00.85 to 01:19:00.000), and refusing it would leave the doc holding
 *  content the disk has already left. `docSeesDisk` is the one that stays shut.
 *
 *  A writer with no usable stamp (the MEMBER flow — no local folder, no disk) is
 *  never refused: it isn't asserting disk truth, it's making a peer edit. */
const seedIsStale = (map: Y.Map<unknown>, updatedAt: string | undefined): boolean => {
  const incomingHi = stampHi(updatedAt)
  if (!Number.isFinite(incomingHi)) return false
  const seenLo = stampLo(map.get(K_DISK_STAMP))
  return Number.isFinite(seenLo) && incomingHi < seenLo
}

/** Stamp `map` with the disk state its board content now reflects. MONOTONIC in
 *  the stamp's own value: a coarse write inside the doc's wall-second leaves the
 *  stamp alone rather than advancing it to an instant it cannot vouch for. The
 *  gate reads the resulting (possibly conservative) stamp and simply stays shut
 *  until a stamp that PROVABLY covers the disk arrives. Unparseable/absent input
 *  writes nothing (a member never stamps). */
export const writeBoardDiskStamp = (map: Y.Map<unknown>, updatedAt: string | undefined): void => {
  const next = stampLo(updatedAt)
  if (!Number.isFinite(next)) return
  const cur = stampLo(map.get(K_DISK_STAMP))
  if (Number.isFinite(cur) && cur >= next) return
  map.set(K_DISK_STAMP, updatedAt)
}

/** Would a write of `updatedAt`-era content be refused as stale? Exported for
 *  the server mirror, which must obey the same rule (its retry can re-apply a
 *  payload that an out-of-band direct write to tasks.json has since superseded). */
export const boardSeedIsStale = (doc: Y.Doc, updatedAt: string | undefined): boolean =>
  seedIsStale(doc.getMap<unknown>(BOARD_ROOT), updatedAt)

/** Has `doc` PROVABLY seen the disk state stamped `diskUpdatedAt`?
 *
 *  Only then may its contents be written back to disk. "Provably" is the load-
 *  bearing word: the doc's EARLIEST possible instant must reach the disk stamp's
 *  LATEST possible one. A coarse disk stamp (`swarm-board.sh` truncates to the
 *  second) covers its whole wall-second, so a millisecond doc stamp inside that
 *  same second proves nothing — the shell write may have happened after it. The
 *  gate stays shut and the mirror's next pass opens it.
 *
 *  Without that, this rollback survives: the room's last mirror is `review` at
 *  01:19:00.800; the shell writes `done` to tasks.json at real 01:19:00.85,
 *  stamping 01:19:00.000. A value comparison reads 0.800 >= 0.000 as "caught up",
 *  opens the gate, and the owner's client writes the room's `review` over the
 *  `done` on disk — the very symptom this file exists to kill.
 *
 *  An identical stamp string is exact proof (same disk state), checked first so a
 *  coarse-stamped disk still gets adopted rather than stalling until the next
 *  server write.
 *
 *  A base with no usable stamp (the MEMBER flow — no local folder, `updatedAt: ''`
 *  — and legacy callers) has no disk authority to protect: always adopt. */
export const docSeesDisk = (doc: Y.Doc, diskUpdatedAt: string | undefined): boolean => {
  if (!Number.isFinite(stampLo(diskUpdatedAt))) return true
  const seenRaw = doc.getMap<unknown>(BOARD_ROOT).get(K_DISK_STAMP)
  if (typeof seenRaw === 'string' && seenRaw === diskUpdatedAt) return true
  const seenLo = stampLo(seenRaw)
  return Number.isFinite(seenLo) && seenLo >= stampHi(diskUpdatedAt)
}

/** Authoritatively make `doc` reflect `data`'s shared fields. Idempotent
 *  (re-applying identical data emits zero updates → loop-safe to call on every
 *  local persist). Converges across INDEPENDENTLY-seeded peer docs. */
export const projectDataToBoardDoc = (doc: Y.Doc, data: ProjectData): void => {
  const map = doc.getMap<unknown>(BOARD_ROOT)
  // A snapshot older than the disk state this doc already reflects must not be
  // written at all — not even the parts that "look" unchanged. See seedIsStale.
  if (seedIsStale(map, data.updatedAt)) return
  doc.transact(() => {
    setKey(map, K_DESCRIPTION, data.description)
    setKey(map, K_DESCRIPTION_JA, data.descriptionJa)
    setKey(map, K_DESCRIPTION_EN, data.descriptionEn)
    setKey(map, K_CONFIG, data.config)
    setKey(map, K_NOTES, data.notes ?? '')
    setKey(map, K_ORDER, (data.tasks ?? []).map((t) => t.id))
    reconcileCollectionFlat(map, TASK_PREFIX, data.tasks ?? [])
    // This seed IS an assertion of disk truth, so it carries the disk stamp
    // (monotonic — an optimistic pre-PUT re-seed can't regress it).
    writeBoardDiskStamp(map, data.updatedAt)
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

/** The doc-owned fields. Everything else on ProjectData is personal/central and
 *  rides `base` untouched, so it can never differ here. */
const sharedFieldsEqual = (a: ProjectData, b: ProjectData): boolean =>
  a.description === b.description &&
  a.descriptionJa === b.descriptionJa &&
  a.descriptionEn === b.descriptionEn &&
  a.notes === b.notes &&
  jsonEqual(a.tasks, b.tasks) &&
  jsonEqual(a.config, b.config) &&
  jsonEqual(a.canvasIndex, b.canvasIndex)

/** Build a ProjectData from the doc's shared fields layered over `base` (which
 *  supplies the personal/central fields). Doc-present meta overrides; absent
 *  inherits base, so the doc never silently wipes on-disk state it lacks.
 *
 *  Returns `base` ITSELF — the same reference — when there is nothing to adopt,
 *  for two distinct reasons. Callers detect both by identity and skip the persist
 *  (React's setState also bails out on an unchanged reference):
 *
 *   1. GATED (74ec0b0d) — `base` names a disk state the doc has not seen
 *      (m:diskStamp behind base.updatedAt: a mirror still retrying, an
 *      out-of-band write straight to tasks.json, or a room that predates the
 *      stamp). The doc's task list is stale with respect to disk, and writing it
 *      back would roll the board to a state the disk already left. This also
 *      covers the unseeded-room case, where the doc's empty task list would
 *      otherwise WIPE the board (c2e4c57c).
 *   2. ECHO — the doc's shared fields already equal `base`'s. Nothing changed,
 *      so nothing is persisted. This is the loop guard: the mirror emits one
 *      doc update per disk write (it must stamp every one, or the gate above
 *      never re-opens), and without an echo check the owner would answer each
 *      stamp with a content-identical PUT, whose write would mirror, whose stamp
 *      would... — a ping-pong at the debounce cadence. Compared structurally
 *      (jsonEqual), so a mere key-order difference between the doc's rebuilt
 *      tasks and the disk JSON can't masquerade as a change. */
export const boardDocToProjectData = (doc: Y.Doc, base: ProjectData): ProjectData => {
  if (!docSeesDisk(doc, base.updatedAt)) return base
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
  return sharedFieldsEqual(out, base) ? base : out
}
