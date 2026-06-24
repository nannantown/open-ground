import type { ProjectData } from '@/lib/types'

// ── Dual-writer reconciliation (the Board "live refresh" policy) ─────────────
//
// OPEN GROUND is a multi-writer-to-one-file system even when single-user: an
// out-of-band actor (a terminal `claude` calling POST /api/project/tasks, the
// `swarm-board.sh` CLI, a raw API PUT) can rewrite the central tasks.json while
// the panel holds an in-memory snapshot. ProjectPanel polls the file every few
// seconds (and on window focus) and feeds the result here to decide whether to
// adopt it — without clobbering local work or churning the board needlessly.
//
// The three outcomes, and WHY each exists:
//
//  • skip-local-edit — the panel has an unsaved local edit (its current data no
//    longer matches what it last persisted/loaded). The local edit wins THIS
//    round: the debounced persist is what reconciles with the store (its CAS
//    `updatedAt` token 409s a stale write, so an external change is never lost —
//    a 409 makes the panel re-GET and adopt). Once the edit flushes (current
//    === lastSaved again) the NEXT poll adopts any still-pending external change.
//    This is the "never lose the user's typing" guarantee — after-wins for the
//    EXTERNAL store, local-wins for the IN-FLIGHT edit, with CAS as the arbiter.
//
//  • echo — the fetched bytes equal what we last adopted: this is the echo of
//    OUR OWN write coming back. Do NOT setData: swapping in a fresh-but-identical
//    object would replace the `tasks` ARRAY IDENTITY, which BoardModule's
//    external-adoption effect reads as a remote replacement and answers by
//    dropping the undo/redo stacks — so a naive poll would wipe ⌘Z history on
//    every tick. (Comparing serialized bytes, not `updatedAt`, also means a
//    content change that reused the same token is still detected as external.)
//
//  • adopt — the store genuinely moved under us (an external writer). Hand the
//    fetched data back so the caller setData()s it; the new array identity flows
//    through BoardModule's external-adoption path, which rebases its undo
//    baseline without polluting history.
//
// Single-user, after-wins, byte-comparison — kept as a pure function so the
// policy is one place, documented, and unit-tested independent of the panel.
export type ReconcileDecision =
  | { kind: 'skip-local-edit' }
  | { kind: 'echo' }
  | { kind: 'adopt'; data: ProjectData; json: string }

export const reconcileExternalData = ({
  current,
  lastSavedJson,
  fetched,
}: {
  /** The panel's live in-memory ProjectData (null before the first load). */
  current: ProjectData | null
  /** JSON of whatever setData last adopted (load / poll / persist-success). */
  lastSavedJson: string
  /** The freshly-fetched ProjectData from the poll / focus refetch. */
  fetched: ProjectData
}): ReconcileDecision => {
  // A pending local edit diverges from the last saved snapshot → local wins.
  if (current && JSON.stringify(current) !== lastSavedJson) {
    return { kind: 'skip-local-edit' }
  }
  const json = JSON.stringify(fetched)
  // Our own echo — identical content → don't churn the tasks array identity.
  if (json === lastSavedJson) return { kind: 'echo' }
  // The store moved under us → adopt.
  return { kind: 'adopt', data: fetched, json }
}
