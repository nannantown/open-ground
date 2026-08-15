// deskSpawnLock — ONE spawn at a time, per (role, project).
//
// WHY THIS IS ITS OWN MODULE (2026-08-15). It was born inside swarmManager.ts to
// close the commander's check-then-act window, and it stayed there while the
// SUPPLY desk — the other one-per-project desk in this app — had no guard at
// all. That asymmetry was invisible as long as the supply desk had exactly one
// door (the Swarm tab's button, which also carries a client-side `if (supply ||
// supplyBusy) return`). The Board's front-desk seat is a SECOND door, so the
// client-side guard stops being the only thing between the owner and two 補給官
// PTYs — and a client-side guard was never the right place for it anyway.
//
// WHAT GOING UNGUARDED COSTS, precisely (swarmSessions.ts states it in so many
// words): a second POST does not fail and does not no-op. `resolveSwarmSession`
// refuses to resume a conversation it can see is still open, so the second
// spawn mints a FRESH session id, and `recordSwarmSession` then OVERWRITES the
// project's single stored slot with it. The first desk's days-long conversation
// is not skipped — it is FORGOTTEN, while its PTY keeps running and burning
// quota with nothing pointing at it.
//
// The lock is deliberately SERIALISING, not coalescing: the second caller
// re-runs its own check after the first releases, so its answer still comes
// from the pool (the authority) rather than being inherited from a call that
// may have failed.

/** How long a caller waits for an in-flight desk spawn in the SAME project
 *  before giving up on the lock.
 *
 *  Sized off the critical section's own worst case, not off a round number: the
 *  slow step is `resolveSwarmModelEffortProbed`, which may probe several tiers in
 *  turn and budgets `TIER_PROBE_LAUNCH_WAIT_MS`-scale seconds for each (8s per
 *  rung), on top of a session probe, a skill install and two settings reads. 120s
 *  clears a full ladder walk with room to spare while still being a BOUND — a
 *  holder that never settles must not wedge the commander button forever.
 *
 *  Shared by both desks because both critical sections are the same shape (the
 *  tier probe dominates each). */
export const DESK_SPAWN_LOCK_WAIT_MS = 120_000

/** key → a promise that settles when the holder releases.
 *
 *  On globalThis so the critical section survives `tsx watch` reloads in dev —
 *  the same rule the PTY pool it guards follows (`globalThis.__openground_terminal`).
 *  A lock that reloaded while the pool did not would stop excluding anything at
 *  exactly the moment the pool still remembered the desk.
 *
 *  ⚠ THE GLOBAL KEY KEEPS ITS HISTORICAL `_manager_` NAME on purpose. Renaming
 *  it would, for exactly one dev reload, leave a call still holding the OLD map
 *  invisible to code reading the new one — the one window this global exists to
 *  cover. The name is a storage key, not a description; the KEYS INSIDE it are
 *  what separate the roles (see {@link deskSpawnLockKey}). */
const lockGlobal = globalThis as typeof globalThis & {
  __openground_manager_spawn_locks?: Map<string, Promise<void>>
}
const deskSpawnLocks: Map<string, Promise<void>> =
  lockGlobal.__openground_manager_spawn_locks ??
  (lockGlobal.__openground_manager_spawn_locks = new Map())

/** true ⇒ `p` settled within `ms`; false ⇒ the wait expired. Leaves no live timer
 *  behind either way, and the timer never holds the process open. */
const settledWithin = (p: Promise<void>, ms: number): Promise<boolean> =>
  new Promise((res) => {
    const timer = setTimeout(() => res(false), ms)
    timer.unref?.()
    const done = () => {
      clearTimeout(timer)
      res(true)
    }
    p.then(done, done)
  })

/** Take the lock for `key`, waiting out any current holder. Returns the release
 *  fn (idempotent-safe: it only clears the map slot that is still OURS), or null
 *  when the wait expired.
 *
 *  ⚠ THE COMPARE-AND-SET BELOW IS THE WHOLE MECHANISM. There is deliberately NO
 *  `await` between the map read and the map write, so on JS's single thread the
 *  pair is atomic — precisely the property the old read-pool-then-launch
 *  sequence lacked. Inserting any await in between (a log, a metric, a "just
 *  one" async check) silently restores the race this closes, and nothing will
 *  fail loudly when it does. */
export const acquireDeskSpawnLock = async (
  key: string,
  waitMs: number,
): Promise<(() => void) | null> => {
  const deadline = Date.now() + waitMs
  for (;;) {
    const held = deskSpawnLocks.get(key)
    if (!held) {
      // COMPARE-AND-SET. There is deliberately NO `await` between this read and
      // the write below, so on JS's single thread the pair is atomic — precisely
      // the property the old read-pool-then-launch sequence lacked.
      let release!: () => void
      const mine = new Promise<void>((r) => (release = r))
      deskSpawnLocks.set(key, mine)
      return () => {
        if (deskSpawnLocks.get(key) === mine) deskSpawnLocks.delete(key)
        release()
      }
    }
    if (!(await settledWithin(held, Math.max(0, deadline - Date.now())))) return null
    // The holder released — loop and re-test. Several waiters wake together and
    // only one wins the compare-and-set above; the losers simply wait again.
  }
}

/** The lock key for one desk of one project.
 *
 *  `path` must already be `resolve()`d by the caller — EXACTLY the identity
 *  `listLiveDesksIn` uses to decide whether a desk is "in this project" (it
 *  compares `resolve(d.cwd)`), so the lock is never coarser or finer than the
 *  check it guards.
 *
 *  ⚠ The COMMANDER's key is the bare resolved path, with no role prefix. That is
 *  not an oversight — it is the key that shipped, and re-prefixing it would, for
 *  one dev reload, make an in-flight commander spawn hold a slot nobody else
 *  looks at. `role: 'manager'` therefore returns the historical key verbatim
 *  while `'supply'` gets its own namespace, so the two desks of one project
 *  never wait on each other (they are independent — a project may hold one of
 *  each). */
export const deskSpawnLockKey = (role: 'manager' | 'supply', resolvedPath: string): string =>
  role === 'manager' ? resolvedPath : `${role}:${resolvedPath}`
