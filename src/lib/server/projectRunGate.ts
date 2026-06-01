// Per-project bounded-parallelism gate for worktree (non-resume) chat runs.
//
// Slice 1 (Approach A) made EVERY non-resume chat run execute in its own
// git worktree+branch, merging back via the serialized merge queue. Because
// each run gets its own worktree, two same-project chats already run fully
// concurrently — there was NO serialization and, critically, NO cap. Firing
// "run all open chats" on a project with 12 open chats would therefore spawn
// 12 worktrees + 12 `claude` PTYs at once, which is the kind of unbounded fan-
// out that exhausts file handles / CPU / the user's rate-limit pool.
//
// This module is the safety cap: a per-project FIFO semaphore. A worktree run
// must `acquire()` a slot before it creates its worktree/PTY; runs beyond the
// cap park in a queue and are handed a slot (in arrival order) as earlier runs
// `release()`. Resume / in-tree / plan runs do NOT go through this gate — they
// keep their existing behaviour (serial projectLocks for resume/no-git, free
// concurrency for plan).
//
// The gate is intentionally a *pure* data structure (no timers, no globals of
// its own) so the queueing/cap logic is unit-testable in isolation. The runner
// owns the single long-lived instance (on globalThis, HMR-safe) and is the only
// place acquire/release are paired across a run's lifecycle.

export interface ProjectRunGate {
  /** Acquire a slot for `projectId`. Resolves immediately if a slot is free,
   *  otherwise resolves later (in FIFO order) when a slot frees up. The
   *  resolved value is the `release` fn — call it exactly once when the run
   *  finishes (success, failure, or cancel) to free the slot. */
  acquire(projectId: string): Promise<() => void>
  /** How many slots are currently held for a project (live runs). Test/debug. */
  active(projectId: string): number
  /** How many runs are parked waiting for a slot in a project. Test/debug. */
  waiting(projectId: string): number
}

interface Waiter {
  resolve: (release: () => void) => void
}

interface GateState {
  // projectId → number of slots currently held.
  active: Map<string, number>
  // projectId → FIFO queue of parked waiters.
  queues: Map<string, Waiter[]>
}

// `cap` is read per-acquire via the supplied getter so a settings change takes
// effect for runs that start after it (we never preempt a run already holding a
// slot). cap is clamped to >= 1 so a misconfigured 0 can never deadlock.
export const createProjectRunGate = (
  getCap: () => number,
): ProjectRunGate => {
  const state: GateState = { active: new Map(), queues: new Map() }

  const cap = () => {
    const n = getCap()
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
  }

  const active = (projectId: string) => state.active.get(projectId) ?? 0
  const waiting = (projectId: string) => state.queues.get(projectId)?.length ?? 0

  // Build a release fn bound to one acquired slot. Guarded by a `released`
  // flag so a double-release (caller bug, or a watchdog + finally racing) can
  // never drive the count negative or hand out two slots for one release.
  const makeRelease = (projectId: string): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      const queue = state.queues.get(projectId)
      const next = queue && queue.length > 0 ? queue.shift() : undefined
      if (queue && queue.length === 0) state.queues.delete(projectId)
      if (next) {
        // Hand this slot straight to the next waiter — active count is
        // unchanged (slot transfers ownership), so the cap is preserved.
        next.resolve(makeRelease(projectId))
        return
      }
      // No one waiting — actually free the slot.
      const remaining = active(projectId) - 1
      if (remaining <= 0) state.active.delete(projectId)
      else state.active.set(projectId, remaining)
    }
  }

  const acquire = (projectId: string): Promise<() => void> => {
    if (active(projectId) < cap()) {
      state.active.set(projectId, active(projectId) + 1)
      return Promise.resolve(makeRelease(projectId))
    }
    return new Promise<() => void>((resolve) => {
      const q = state.queues.get(projectId) ?? []
      q.push({ resolve })
      state.queues.set(projectId, q)
    })
  }

  return { acquire, active, waiting }
}
