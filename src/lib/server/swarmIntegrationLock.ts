// swarmIntegrationLock — a repo-scoped, CROSS-PROCESS lock guarding the
// integration step (rebase/push onto the trunk). Card: [swarm] cross-process
// integration lock (0708 二重司令塔事故フォロー).
//
// Why this exists: swarmOrchestrator's `engine.passInFlight` only bars a
// SECOND pass from overlapping WITHIN the same Node process. It does nothing
// to stop a separate `claude` process (a tmux 司令塔 session driving the same
// repo by hand) from rebasing/pushing the SAME branch onto the SAME trunk at
// the same moment the in-app engine is mid-integrate — the 0706 incident.
// This module adds a plain PID+timestamp lock FILE under
// ~/.openground/swarm/<repo-key>/integration.lock, readable/writable by any
// process (the in-app engine via this module, a tmux commander via
// scripts/swarm-lock.js) — a real cross-process mutex, not an in-memory flag.
//
// Design mirrors the house pattern for liveness probes (terminal.ts's
// defaultIsAlive: `process.kill(pid, 0)`, ESRCH ⇒ gone) and reuses
// swarmJanitor's `swarmRepoKey` so the lock lives in the SAME per-repo dir a
// worker's heartbeat does (`~/.openground/swarm/<repo-key>/`) — identical key
// derivation to swarm-beat.sh's `sw_repokey` (basename(parent) + sha1(git
// common dir)[:8]).
//
// Acquire writes the holder JSON to a private tmp file, then claims the FINAL
// path with `link()` (a hardlink create — EEXIST if the target already exists,
// atomic at the OS level, the same primitive a real mutex needs) and unlinks
// the tmp file. This means the lock file at its real path NEVER exists empty —
// a reader (readIntegrationLock, or a competitor's stale-check) can never
// observe a half-written lock and misparse it as "vanished" or corrupt. (An
// earlier version used a plain exclusive `open(path,'wx')`, which creates the
// 0-byte file BEFORE its content is written — a window a concurrent reader
// could catch mid-race.) A losing racer's link() just fails; the winner's file
// is never overwritten. A held-but-stale lock (holder process provably dead,
// or older than staleMs) is reclaimed: unlinked, then re-acquired. Release
// only removes the file if it still names OUR pid (a lock we lost to a
// stale-reclaim during a long integration is never yanked out from under its
// new, legitimate owner).

import { mkdir, link, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { openGroundHome } from './paths'
import { swarmRepoKey } from './swarmJanitor'

/** Who is holding the lock right now (as recorded in the lock file). */
export interface IntegrationLockHolder {
  pid: number
  /** ISO timestamp of acquisition. */
  acquiredAt: string
  /** Free-form label identifying the holder (e.g. 'engine', 'tmux-cli') —
   *  cosmetic only, surfaced in logs/CLI output. */
  label?: string
}

export type AcquireIntegrationLockResult =
  | { ok: true; holder: IntegrationLockHolder; release: () => Promise<void> }
  | { ok: false; reason: 'held'; holder: IntegrationLockHolder | null }
  | { ok: false; reason: 'no-repo-key' }

export interface AcquireIntegrationLockOpts {
  /** Cosmetic label stamped into the lock file. */
  label?: string
  /** A held lock older than this (ms) is considered stale and reclaimed even
   *  if its holder process happens to still be alive (e.g. a wedged/hung
   *  integration) — belt-and-suspenders alongside the pid-liveness check.
   *  Default 10 minutes: comfortably longer than any real rebase+push, short
   *  enough that a genuinely stuck holder doesn't block the repo for hours. */
  staleMs?: number
  /** Injected clock (epoch ms) — pure-testable, house style. */
  now?: number
  /** Injected pid — pure-testable, house style. */
  pid?: number
}

const DEFAULT_STALE_MS = 10 * 60_000

/** ESRCH ⇒ provably gone. EPERM ⇒ exists but not ours (still alive). Anything
 *  else is treated as alive — never reap on an ambiguous error. Mirrors
 *  terminal.ts's defaultIsAlive. */
const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

const lockDirFor = (key: string): string => join(openGroundHome(), 'swarm', key)
const lockPathFor = (key: string): string => join(lockDirFor(key), 'integration.lock')

/** The lock file path for this project, or null when it isn't a git repo /
 *  the repo key can't be resolved (mirrors swarmRepoKey's own null case).
 *  Exported so tests and the CLI can locate the exact file this module reads
 *  and writes. */
export const integrationLockPath = async (projectPath: string): Promise<string | null> => {
  const key = await swarmRepoKey(projectPath)
  if (!key) return null
  return lockPathFor(key)
}

/** Pure read of the current holder, WITHOUT mutating anything (no reclaim, no
 *  write) — safe to call from a GET route or a dashboard poll. null when
 *  unlocked, unparsable, or the repo key can't be resolved. */
export const readIntegrationLock = async (projectPath: string): Promise<IntegrationLockHolder | null> => {
  const path = await integrationLockPath(projectPath)
  if (!path) return null
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<IntegrationLockHolder>
    if (typeof parsed.pid !== 'number' || typeof parsed.acquiredAt !== 'string') return null
    return { pid: parsed.pid, acquiredAt: parsed.acquiredAt, label: parsed.label }
  } catch {
    return null
  }
}

/** Attempt to acquire the cross-process integration lock for `projectPath`.
 *  Never throws. On success, the caller MUST call the returned `release()`
 *  when integration for this pass is done (a `finally` around the
 *  integrate-loop). On failure ('held'), the caller must SKIP integration for
 *  this pass — never proceed past this call into a rebase/push. */
export const acquireIntegrationLock = async (
  projectPath: string,
  opts: AcquireIntegrationLockOpts = {},
): Promise<AcquireIntegrationLockResult> => {
  const key = await swarmRepoKey(projectPath)
  if (!key) return { ok: false, reason: 'no-repo-key' }

  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const now = opts.now ?? Date.now()
  const pid = opts.pid ?? process.pid
  const dir = lockDirFor(key)
  const path = lockPathFor(key)

  try {
    await mkdir(dir, { recursive: true })
  } catch {
    return { ok: false, reason: 'held', holder: null }
  }

  // At most 2 attempts: the first plain create, then (if the existing lock is
  // stale) one reclaim-and-retry. A second collision after a reclaim means a
  // racer won it first — back off as 'held' rather than loop unboundedly.
  for (let attempt = 0; attempt < 2; attempt++) {
    const holder: IntegrationLockHolder = { pid, acquiredAt: new Date(now).toISOString(), label: opts.label }
    // Write the content to a PRIVATE tmp file first (unique name — no
    // collision risk), then atomically claim the real path with link() (EEXIST
    // if already taken) and drop the tmp name. This guarantees the lock file
    // at `path` is never observably empty.
    const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}-${pid}`
    try {
      await writeFile(tmp, JSON.stringify(holder), { flag: 'wx' })
      await link(tmp, path)
      await unlink(tmp)
      return { ok: true, holder, release: () => releaseIfOwned(path, pid) }
    } catch (e) {
      // Best-effort tmp cleanup regardless of which step failed.
      try {
        await unlink(tmp)
      } catch {
        /* already gone (unlinked above) or never created */
      }
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return { ok: false, reason: 'held', holder: null }
      }
    }

    const existing = await readIntegrationLock(projectPath)
    if (!existing) {
      // Unparsable / vanished between the failed create and this read — try
      // once more (the next loop iteration's create may now succeed cleanly).
      try {
        await unlink(path)
      } catch {
        /* already gone or a racer's fresh lock — either way, retry the create */
      }
      continue
    }

    const age = now - Date.parse(existing.acquiredAt)
    const stale = !isPidAlive(existing.pid) || !Number.isFinite(age) || age > staleMs
    if (!stale) {
      return { ok: false, reason: 'held', holder: existing }
    }

    // Reclaim: atomically move the stale file aside (so a concurrent reclaimer
    // races on the rename, not a plain unlink+create window) before retrying.
    const graveyard = `${path}.stale-${randomUUID().slice(0, 8)}`
    try {
      await rename(path, graveyard)
      await unlink(graveyard)
    } catch {
      // Lost the reclaim race (someone else already rotated/recreated it) —
      // loop once more; the next create() attempt tells us the real outcome.
    }
  }

  const holder = await readIntegrationLock(projectPath)
  return { ok: false, reason: 'held', holder }
}

/** Remove the lock file only if it still names `pid` — never yank a lock a
 *  stale-reclaim already handed to a new owner. Best-effort: swallows any
 *  filesystem error (a lock left behind is cleaned up by the next stale
 *  reclaim anyway). */
const releaseIfOwned = async (path: string, pid: number): Promise<void> => {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<IntegrationLockHolder>
    if (parsed.pid !== pid) return // no longer ours — leave the new owner's lock alone
    await unlink(path)
  } catch {
    /* already gone, or unreadable — nothing more we can safely do */
  }
}
