// swarmHeartbeatFiles — the single source of truth for "what counts as a
// heartbeat" in the two sweeps that delete files out of the swarm state dir.
//
// TENANCY. `~/.openground/swarm/<repoKey>/` is NOT a heartbeat-only directory.
// Its residents:
//   • `<branch-with-slashes-as-dashes>.json` — a worker heartbeat
//     (scripts/swarm-beat.sh writes these; they carry branch + worktree + updatedAt)
//   • `roster.json`      — the engine's own worker roster (swarmWorkerRoster.ts,
//                          deliberately placed "the heartbeat's neighbour")
//   • `manager.json`     — the commander's heartbeat (03 章 §2.3 revival reflex)
//   • `integration.lock` — the integration lock (not .json, so never in scope)
//
// WHY THIS EXISTS (2026-07-29). Both sweeps —
// `swarmJanitor.sweepSwarmHeartbeats` (every 15 min while the overseer observes)
// and `retention.pruneGhostHeartbeats` (at boot, 48h) — walked every `*.json`
// and deleted anything they could not RECOGNISE as a live heartbeat: "no branch
// and no worktree ⇒ unidentifiable orphan ⇒ reap". `roster.json`
// (`{workers:[…]}`) and `manager.json` (`{role,updatedAt,…}`) have exactly that
// shape, so the engine's own state was being eaten by its own janitor. Observed
// consequences:
//   • roster gone → reconcileRoster degrades to [] → adoptResumeCandidates
//     no-ops → a surviving worker is orphaned across a restart, its workedMs
//     ledger (the runaway clock) resets, and its card sits in `doing` forever.
//   • manager.json gone → the revival reflex reads "no heartbeat" and, being
//     fail-open by design, simply never revives a hung commander again.
//
// THE FIX IS A POLARITY FLIP, and that is the whole point. The old rule was
// "delete what we cannot prove is a heartbeat" — a rule that condemns every
// FUTURE resident of this directory too. The rule here is "delete only what we
// can prove IS a heartbeat". A name denylist (`if (f === 'roster.json') continue`)
// was rejected as the primary defence precisely because this bug IS a missing
// denylist entry: roster.json and manager.json both moved in AFTER the sweeps
// were written, and the next tenant would repeat the accident. Names are used
// only as a secondary net for files that cannot be parsed at all.

/** Files that live in the swarm state dir and are NOT worker heartbeats. Used
 *  only for the unparseable case (a corrupt `roster.json` still must not be
 *  reaped as a ghost heartbeat); the shape check below is the primary rule. */
export const NON_HEARTBEAT_FILES: readonly string[] = ['roster.json', 'manager.json']

/** The identifying fields, as they APPEAR in the file. `null` = the key was
 *  absent (or not a string). Pass the RAW value — recognition is about whether
 *  the file carries a heartbeat's fields at all, NOT whether their values are
 *  usable. A heartbeat with a relative `worktree` is a MALFORMED HEARTBEAT
 *  (still sweepable once stale), whereas roster.json carries neither key and is
 *  a different kind of file entirely. Collapsing those two — by passing only
 *  values that passed validation — would quietly re-open the hole for malformed
 *  heartbeats while looking correct. */
export interface HeartbeatShape {
  branch: string | null
  worktree: string | null
}

/**
 * Is this file a WORKER HEARTBEAT — i.e. may a sweep consider deleting it?
 *
 * True only when the parsed content carries at least one of the two liveness
 * signals a heartbeat always writes (`branch` / `worktree`). Everything else —
 * the engine's roster, the commander's heartbeat, a future tenant, a foreign
 * file — is left alone, no matter how old it is.
 *
 * `parsed:false` (unreadable / not JSON) keeps the OLD behaviour of reaping a
 * stale corpse, because a shape check is impossible there — except for the
 * known non-heartbeat names, which must survive their own corruption rather
 * than be silently deleted (a truncated roster.json is a bug to notice, not a
 * ghost to sweep).
 */
export const isSweepableHeartbeat = (
  fileName: string,
  parsed: boolean,
  shape: HeartbeatShape,
): boolean => {
  if (NON_HEARTBEAT_FILES.includes(fileName)) return false
  if (!parsed) return true // corrupt: staleness alone governs, as before
  return shape.branch !== null || shape.worktree !== null
}
