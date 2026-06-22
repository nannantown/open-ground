// canvasMerge.ts — the conflict-resolution heart of Canvas optimistic
// concurrency control.
//
// A Canvas save can race a server-side Canvas AI job: the client loaded the
// canvas at rev N and has been editing locally, while an AI job appended /
// tweaked elements straight onto the file (bumping it to rev N+1). When the
// client's stale save is rejected (409, see canvasData.saveCanvasFile), it
// refetches the server's current elements and reconciles them with its own
// edits HERE, then retries. This is a pure 3-way merge so it is fully unit-
// testable and deterministic — the unit that backs OCC conditions (d) + (e).
//
// AI jobs only ever ADD elements (append) or REWRITE an existing element's
// source (tweak) — they never DELETE. So relative to the client's load `base`:
//   - an id present on the server but absent from base  → AI-appended,
//   - an existing element whose content differs on the server → AI-tweaked,
//   - an id present in base but absent from the client's `local` → the user
//     deleted it (and it must NOT come back).

import type { CanvasElement } from './types'

/** Order-insensitive structural equality for JSON values (canvas elements are
 *  plain JSON). Distinguishes "the client edited this element" from "the client
 *  left it untouched" — the pivot the tweak case (e) turns on.
 *
 *  CRUCIAL: an `undefined`-valued key is treated as ABSENT. The server's copies
 *  (`base`/`server`) come back through JSON, which DROPS undefined keys, while
 *  the client's in-memory `local` element can carry one — the Selection
 *  Inspector clears a field by patching `{ someField: undefined }`. Without this
 *  normalisation, such an element would read as "changed" against the JSON base,
 *  and a stale-save merge would keep the client's copy and silently drop an AI
 *  tweak to it (breaking condition (e)). Comparing only non-undefined keys makes
 *  the in-memory and JSON-round-tripped views compare equal. */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined)
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (bo[k] === undefined) return false
    if (!deepEqual(ao[k], bo[k])) return false
  }
  return true
}

/**
 * Three-way merge of canvas elements for OCC conflict resolution.
 *
 * @param base   the elements the client loaded (the rev it is now stale against)
 * @param local  the client's current elements — its edits, additions, deletions
 * @param server the server's current elements (= base + whatever an AI job
 *               appended/tweaked since the client's load)
 * @returns the reconciled element list that
 *   - keeps the client's edits and additions,
 *   - keeps AI-appended elements (on the server, absent from base),
 *   - applies an AI tweak to an element the client did NOT touch,
 *   - and NEVER resurrects an element the client deleted.
 *
 * Element identity is `id`. Result order = the client's order for the elements
 * it kept, with AI-appended elements tacked on at the end (the server already
 * placed them to the right of existing content).
 */
export const reconcileCanvasElements = (
  base: CanvasElement[],
  local: CanvasElement[],
  server: CanvasElement[],
): CanvasElement[] => {
  const baseById = new Map(base.map((e) => [e.id, e]))
  const localById = new Map(local.map((e) => [e.id, e]))

  const out: CanvasElement[] = []

  // 1. Walk the client's current elements in their order — what the user kept,
  //    added, or edited. For an element present in all three, an AI tweak wins
  //    ONLY when the client left it untouched; otherwise the client's edit wins
  //    (last-writer between the human and the AI on the very same element).
  const serverById = new Map(server.map((e) => [e.id, e]))
  for (const el of local) {
    const b = baseById.get(el.id)
    const s = serverById.get(el.id)
    if (b && s) {
      const localChanged = !deepEqual(el, b)
      const serverChanged = !deepEqual(s, b)
      out.push(!localChanged && serverChanged ? s : el)
    } else {
      // client-added (not in base) or server-removed — keep the client's copy.
      out.push(el)
    }
  }

  // 2. Bring in server elements the client doesn't currently hold. An id that
  //    was in `base` but is gone from `local` was DELETED by the user → skip it
  //    (no resurrection). An id absent from `base` is one the AI appended after
  //    the client's load → keep it.
  for (const s of server) {
    if (localById.has(s.id)) continue
    if (baseById.has(s.id)) continue // user-deleted — must not come back
    out.push(s)
  }

  return out
}
