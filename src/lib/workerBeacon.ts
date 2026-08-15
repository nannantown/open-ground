// workerBeacon — turn a pool beacon verdict into the word the Swarm tab's
// worker list shows. Pure, and deliberately EXHAUSTIVE over ClaudeBeaconStatus.
//
// WHY THIS IS ITS OWN FILE (2026-08-15). The mapping used to be three `===`
// comparisons inside SwarmModule with a fall-through that returned `exited`.
// When `ClaudeBeaconStatus` gained `idle`, that fall-through quietly started
// reporting a LIVE, parked worker as DEAD — a worse lie than the one the new
// value was added to fix, and completely invisible to tsc, because an
// unmatched `===` is not a type error.
//
// The repo's rule for a defect shape that has now appeared twice is to stop
// reviewing and make it structural (CLAUDE.md 検証の掟 §4): a Record keyed by
// the union cannot be written incompletely. Add a fourth beacon value and this
// file fails to compile, which is exactly where you want to find out.

import type { ClaudeBeaconStatus } from '@/lib/types'

/** What the Swarm tab's worker rows can say. */
export type WorkerBeaconStatus = 'working' | 'waiting' | 'starting' | 'exited'

/** Beacon verdict → worker word.
 *
 *  `idle` folds into `waiting` ON PURPOSE. The Ground card needs the two kept
 *  apart, because there an amber stamp is a claim on the owner's attention and
 *  a parked desk has no right to make one. This list is about workers, where
 *  「live but not painting」 is precisely what 待機中 means, and where the
 *  alternative — saying nothing — would read as "gone". */
const WORD: Record<ClaudeBeaconStatus, WorkerBeaconStatus> = {
  working: 'working',
  waiting: 'waiting',
  idle: 'waiting',
}

export interface WorkerBeaconInput {
  /** The pool's verdict for this PTY, or undefined when the pool does not list
   *  it (not started yet, or gone). */
  status: ClaudeBeaconStatus | undefined
  /** This PTY has been seen alive at least once in this session. */
  seen: boolean
  /** An exit was observed for this PTY. Wins outright. */
  exited: boolean
}

/** The one place a worker row's word is decided. */
export const workerBeaconStatus = ({
  status,
  seen,
  exited,
}: WorkerBeaconInput): WorkerBeaconStatus => {
  if (exited) return 'exited'
  if (status !== undefined) return WORD[status]
  // Absent from the pool: it either finished (we saw it once) or has not come
  // up yet. Never "waiting" — we have no evidence of a live process.
  return seen ? 'exited' : 'starting'
}
