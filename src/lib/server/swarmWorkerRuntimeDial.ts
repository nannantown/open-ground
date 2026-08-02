// swarmWorkerRuntimeDial — decides WHICH runtime the next dispatched worker
// gets, and is the kill switch for the whole Agent SDK migration.
//
// The rule is deliberately conservative and lives in ONE function so there is
// exactly one place to read when asking "why did this worker come up as a PTY?":
//
//   • the dial says 'pty'                    → PTY   (the kill switch)
//   • the dial holds an unrecognised value   → PTY   (a VALUE we cannot read is
//                                                     not consent to the SDK)
//   • the SDK slot budget is already full    → PTY
//   • the SDK preflight does not pass        → PTY   (+ the reason, surfaced)
//   • the dial is absent, or says 'sdk'      → SDK
//
// ⚠ ABSENT ⇒ SDK SINCE 2026-08-01 — and NOTE THAT THIS FUNCTION'S RULE IS NOT
// WHAT SHIPS ON ITS OWN. The only production caller (swarmWorker.ts) never hands
// over the raw setting: it passes `await store.getWorkerRuntimeDial()`, so an
// absent dial arrives here already resolved and this branch sees it only through
// that reader. For one day the reader resolved absent to an EXPLICIT
// `{mode:'pty'}` while this rule said sdk, so the flip could not reach dispatch
// at all: measured 2026-08-02 (isolated HOME, nothing written) the composed path
// answered pty while this function and the Swarm panel both answered sdk, and
// 0.11.47 shipped that way. The reader now shares this polarity (absent ⇒ sdk),
// and the file-level rule stays separate on both: an UNREADABLE settings.json
// resolves to pty before either default is consulted.
//
// ⚠ DO NOT TEST THIS FUNCTION ALONE AND CALL IT A GUARANTEE ABOUT DISPATCH —
// that shortcut is exactly what kept the defect above green for a release.
// swarmRuntimeDialParity.test.ts composes reader→decision the way swarmWorker.ts
// does, and compares it against what the Swarm panel is served.
//
// Every fallback is a DEGRADATION TO THE KNOWN-GOOD PATH, never a refusal to
// dispatch: a worker that would have run fine as a PTY must not be blocked
// because an experimental runtime could not be established. The one thing that
// must never happen is the opposite — an SDK worker launched with an unverified
// veto — and that is why the preflight (which proves the guard actually denies)
// is part of this decision rather than something checked later.
//
// See docs/SDK_WORKER_MIGRATION_PLAN.md §8.

import type { Settings } from '../types'
import { sdkWorkerPreflight, type SdkPreflightResult } from './swarmWorkerSdk'
import { workerRuntimeKind, type WorkerHandle } from './workerRuntime'
import { listSdkSessions } from './sdkSession'

export const DEFAULT_SDK_MAX_WORKERS = 1

export interface RuntimeChoice {
  runtime: 'pty' | 'sdk'
  /** Why PTY was chosen when the dial asked for SDK. Absent when the dial is
   *  simply off (the ordinary case — not worth a message). */
  fellBackBecause?: string
  /** The preflight result, when one was run. */
  preflight?: SdkPreflightResult
}

/** How many SDK workers may run at once. */
export const sdkSlotLimit = (settings: Pick<Settings, 'swarmWorkerRuntime'>): number => {
  const n = settings.swarmWorkerRuntime?.sdkMaxWorkers
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SDK_MAX_WORKERS
}

/** Live SDK workers among the engine's roster.
 *
 *  ⚠ A ROSTER IS NOT THE FLEET. Kept for the engine's own accounting, but never
 *  use it alone to enforce the cap: a worker dispatched outside the engine
 *  (curl-direct `POST /api/swarm/worker` — the commander's documented and
 *  PRIMARY path) is in no roster at all. Counting only rosters is why the cap
 *  was silently unenforceable on that path. Use {@link liveSdkWorkerCount}. */
export const countSdkWorkers = (workers: readonly WorkerHandle[]): number =>
  workers.reduce((n, w) => (workerRuntimeKind(w) === 'sdk' ? n + 1 : n), 0)

/** How many SDK workers are ACTUALLY live, measured from the pool.
 *
 *  The pool is the only source that sees every worker however it was started,
 *  which is what a cap has to count. The engine roster is merged in for two
 *  cases: the instant between "the engine recorded a worker" and "its session
 *  appears in the pool", and a `runtime:'sdk'` record carrying no session id at
 *  all; ids dedupe the overlap.
 *
 *  Injectable so the decision stays a pure function under test. */
export const liveSdkWorkerCount = (
  rosterWorkers: readonly WorkerHandle[],
  poolSessions: readonly { id: string; role?: string; status: string; reaped?: boolean }[],
): number => {
  const poolIds = new Set<string>()
  for (const s of poolSessions) {
    if (s.role !== 'worker') continue
    // ⚠ `reaped` — AND NOTHING ELSE. The THIRD sibling of the same rule.
    // terminateSdkSession flips status to 'exited' synchronously, so a status
    // filter releases the slot of a worker whose claude is still unwinding in its
    // worktree: the dial dispatches a replacement immediately and the cap is
    // exceeded by exactly the workers that are hardest to see — two claudes, one
    // worktree.
    //
    // The status test is DELETED, not merely preceded by the new one. Adding
    // `if (reaped) continue` above it changed nothing at all, because the very
    // sessions it was meant to catch are the ones status already excluded; the
    // first attempt at this fix did exactly that and the guard below caught it.
    // `reaped` is complete on its own: a spawn-failure entry is stamped reaped,
    // and so is every session whose pump has unwound.
    if (s.reaped) continue
    poolIds.add(s.id)
  }
  let n = poolIds.size
  for (const w of rosterWorkers) {
    if (workerRuntimeKind(w) !== 'sdk') continue
    // AN ID MEANS THE POOL IS THE AUTHORITY. If it is not in `poolIds` the
    // session is not live, whether the pool still remembers it as finished or
    // has already swept it — the pool only ever forgets sessions that CLOSED
    // (sweepClosedSessions), and a pool reset means the process died and took
    // every session with it. Either way: not running, not a slot.
    //
    // An earlier version instead exempted only ids the pool still REMEMBERED as
    // finished, which quietly expired: 30 minutes after a worker ended, the
    // retention sweep dropped it, the roster entry became "unknown", and the
    // counter started charging a slot for work that finished half an hour ago —
    // the fix regressing itself on a timer.
    if (w.sdkSessionId) continue
    // No id at all: recorded between spawn and pool insertion, or a legacy
    // record that still carries `runtime:'sdk'` (one without the field was
    // already skipped above as 'pty'). The engine believes it dispatched this
    // worker, so ignoring it
    // under-counts. (Dropping these is how this counter first regressed the
    // shipped tests.)
    n++
  }
  return n
}

/** Decide the runtime for ONE about-to-be-dispatched worker. */
export const chooseWorkerRuntime = (opts: {
  settings: Pick<Settings, 'swarmWorkerRuntime'>
  /** The engine's current roster. Contributes to the slot count, but is NOT the
   *  authority — a curl-direct worker is in no roster (see liveSdkWorkerCount). */
  workers: readonly WorkerHandle[]
  /** The worktree this worker will run in — the guard's write root. */
  worktree: string
  home?: string
  /** Injected for tests. */
  preflight?: (o: { writeRoots: string[]; home?: string }) => SdkPreflightResult
  /** The SDK pool, for the slot count. Defaults to the real pool. Injected so
   *  the decision stays testable without spawning anything. */
  poolSessions?: () => readonly { id: string; role?: string; status: string; reaped?: boolean }[]
}): RuntimeChoice => {
  // ⚠ THE DEFAULT IS 'sdk' SINCE 2026-08-01 — and the ABSENT case is the one that
  // moved. The dial's two written values still mean exactly what they said:
  // 'pty' is the kill switch and still wins.
  //
  // WHAT EARNED THE FLIP. Nine adversarial review rounds fixed ~60 defects here,
  // but review is not what decided it — an acceptance pass against a real
  // `claude` on a real machine, through the packaged bundle, was:
  //   • a worker spawns, works, commits, and its worktree is torn down only
  //     after the desk has REALLY gone (0 wedged git processes)
  //   • the deny veto FIRES in a live session (`git checkout --` → BLOCKED). The
  //     model complying is not the guard; this is the guard.
  //   • the owner's inbox answer reaches a live SDK worker (`delivery:injected`)
  //   • three at once keep three distinct identities, the 4th degrades to PTY
  //     with the reason surfaced, and stopping one leaves the others untouched
  //   • the commander seats on SDK, stays a singleton, takes `say`, and can be
  //     stopped and relaunched
  // The one defect that pass found — Windows write roots shredded by a ':' join —
  // is fixed (swarmGuardWindowsRoots.test.ts).
  //
  // ⚠ THIS CHANGES NOTHING FOR ANYONE BUT THE OWNER. Every route that can create
  // a worker is behind `hasSwarmOwnerAccess` (all 26 of them, checked), so the
  // default only decides which runtime the OWNER's workers use.
  // ⚠ `??` WAS NOT THE RIGHT RESOLUTION, because it folds `null` in with absent.
  // A hand-edited `{"mode": null}` is not "nothing written yet" — it is a file we
  // cannot read, and that is not evidence the SDK runtime is wanted. The
  // commander's reader (store.getManagerRuntimeDial) already said so in words;
  // this one said it in `??`, and the two disagreed on exactly that input
  // (measured by swarmRuntimeDialParity.test.ts, minutes before shipping).
  // Explicit ⇒ that runtime. ABSENT ⇒ sdk. Anything else ⇒ pty.
  const raw = opts.settings.swarmWorkerRuntime?.mode
  const mode = raw === 'pty' ? 'pty' : raw === 'sdk' || raw === undefined ? 'sdk' : 'pty'
  if (mode !== 'sdk') return { runtime: 'pty' }

  const limit = sdkSlotLimit(opts.settings)
  // Measured from the POOL, not from the caller's roster. Passing `workers: []`
  // (which every curl-direct dispatch did, because there is no roster there)
  // made `live` 0 forever, so `live >= limit` was permanently false and the cap
  // never applied on the commander's main dispatch path — while the switch's own
  // copy promised "at most N at a time".
  const live = liveSdkWorkerCount(opts.workers, (opts.poolSessions ?? listSdkSessions)())
  if (live >= limit) {
    return {
      runtime: 'pty',
      fellBackBecause: `SDK worker slots are full (${live}/${limit}) — this worker runs as a PTY`,
    }
  }

  const run = opts.preflight ?? ((o) => sdkWorkerPreflight(o))
  const pre = run({ writeRoots: [opts.worktree], ...(opts.home ? { home: opts.home } : {}) })
  if (!pre.ok) {
    return {
      runtime: 'pty',
      fellBackBecause: `SDK preflight failed (${pre.problems.join('; ')}) — this worker runs as a PTY`,
      preflight: pre,
    }
  }
  return { runtime: 'sdk', preflight: pre }
}
