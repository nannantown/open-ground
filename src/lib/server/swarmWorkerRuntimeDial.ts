// swarmWorkerRuntimeDial — decides WHICH runtime the next dispatched worker
// gets, and is the kill switch for the whole Agent SDK migration.
//
// The rule is deliberately conservative and lives in ONE function so there is
// exactly one place to read when asking "why did this worker come up as a PTY?":
//
//   • the dial is absent or 'pty'            → PTY   (the shipped default)
//   • the SDK slot budget is already full    → PTY
//   • the SDK preflight does not pass        → PTY   (+ the reason, surfaced)
//   • otherwise                              → SDK
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

/** Live SDK workers among the engine's roster. */
export const countSdkWorkers = (workers: readonly WorkerHandle[]): number =>
  workers.reduce((n, w) => (workerRuntimeKind(w) === 'sdk' ? n + 1 : n), 0)

/** Decide the runtime for ONE about-to-be-dispatched worker. */
export const chooseWorkerRuntime = (opts: {
  settings: Pick<Settings, 'swarmWorkerRuntime'>
  /** The engine's current roster (to count live SDK slots). */
  workers: readonly WorkerHandle[]
  /** The worktree this worker will run in — the guard's write root. */
  worktree: string
  home?: string
  /** Injected for tests. */
  preflight?: (o: { writeRoots: string[]; home?: string }) => SdkPreflightResult
}): RuntimeChoice => {
  const mode = opts.settings.swarmWorkerRuntime?.mode ?? 'pty'
  if (mode !== 'sdk') return { runtime: 'pty' }

  const limit = sdkSlotLimit(opts.settings)
  const live = countSdkWorkers(opts.workers)
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
