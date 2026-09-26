// swarmWorkerReaper — puts finished swarm workers away, automatically.
//
// WHY (owner report 2026-09-26): the agent-team bar's seat rail kept growing —
// six worker seats, four of them long finished (phase=done, heartbeats 1-2 days
// old). Since the 2026-07-15 manager-only rework the ENGINE no longer lands a
// branch, so it no longer tears a worker down after integration either: the only
// "put it away" step left was the commander's manual og-manage §マージ step 7
// (remove worktree → branch -d → rm heartbeat). A commander that skipped it (a
// compacted context, a restart mid-merge) left the worktree + heartbeat on disk,
// and every automatic sweep treats "worktree still exists" as "worker still
// exists" — the janitor (overseer-only, and it never removes worktrees), the boot
// retention sweep, and GET /api/swarm/workers' heartbeat arm. Nothing ever asked
// "is this worker's work already in main?", so the seat stayed forever.
//
// This module asks exactly that, on its own boot loop (engine-independent — the
// leftovers it exists for are the ones nobody is managing). A central `swarm/*`
// worktree is removed only when ALL of these hold:
//
//   1. CLEAN — no uncommitted change (a failed status probe counts as dirty; the
//      worktree's own node_modules convenience symlink is not a change).
//   2. INTEGRATED — checkMergedBranches says 'merged': the tip is reachable from
//      the trunk, or every commit's patch is already there. Anything else
//      ('open' or 'unknown') keeps it. Work is never lost on a guess. (No fetch —
//      a stale trunk ref only makes a branch look unmerged, the safe side.)
//   3. FINISHED — either
//        (a) the engine holds it (live roster OR the saved roster.json) and its
//            card is `done`, and no session in it has moved for REAP_IDLE_MS —
//            the post-integration case. The idle session is stopped by
//            removeSwarmWorktree, exactly as the commander's own step 7 does.
//            The column and the idleness are re-read right before removal; or
//        (b) the engine does not hold it, no session (PTY or SDK) is in it, and
//            it has been quiet for REAP_GRACE_MS. Removal then REFUSES rather
//            than stops if a session appeared meanwhile (refuseIfOccupied) —
//            (b) never kills anything.
//      A roster row whose card is anywhere else — including MISSING, which a
//      transient empty Board read would also look like — is the engine's to
//      manage. A live session with no roster row cannot be proven finished.
//
// PRIMARY INSTANCE ONLY (server/index.ts): sessions and the engine live in ONE
// server process, and a second one (npm run dev:alt shares ~/.openground) would
// see another process's working workers as dead.
//
// After a removal the janitor sweep deletes the now-merged branch (`-d` only) and
// the orphaned heartbeat. A non-force `git worktree remove` also deletes
// gitignored files in the tree — the same as the commander's step 7; a worker's
// deliverable is its commits.

import { lstat, readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { canonicalize } from './canonicalize'
import { centralWorktreesDir } from './paths'
import { projectUUIDFromPath } from './projectDataPath'
import { listProjectWorktrees } from './worktreeCleanup'
import { checkMergedBranches } from './mergedBranches'
import { canonicalLiveDeskCwds, deskRecentlyActiveIn, isDirOccupied } from './liveDesks'
import { getOrchestratorState } from './swarmOrchestrator'
import { rosterFile } from './swarmWorkerRoster'
import { readProjectData } from './projectData'
import { readHeartbeats } from './swarmWorkerRegistry'
import { removeSwarmWorktree } from './swarmWorker'
import { runSwarmJanitor } from './swarmJanitor'
import { isGitRepoRoot } from './gitRepoGuard'
import { getSettings } from './store'
import type { MergedBranchStatus } from '../types'

const execFile = promisify(execFileCb)

/** How long a worker nobody holds must have been quiet (heartbeat, worktree
 *  creation) before it may be removed. Longer than the 30-min "silent worker"
 *  threshold on purpose: a leftover costs a seat for an hour, a wrong removal
 *  costs a worker. */
export const REAP_GRACE_MS = 60 * 60_000

/** (a) only: a session whose last event is younger than this is still moving. */
export const REAP_IDLE_MS = 10 * 60_000

/** Boot-loop cadence. */
export const WORKER_REAP_INTERVAL_MS = 3 * 60_000

export type ReapKeepReason =
  | 'not-swarm'
  | 'dirty'
  | 'unmerged'
  | 'engine-owned'
  | 'busy'
  | 'live'
  | 'recent'
  | 'remove-refused'

export interface ReapCandidate {
  branch: string | null
  dirty: boolean
  merged: MergedBranchStatus
  /** The engine's card id, when the engine (live or saved roster) holds it. */
  rosterTaskId?: string
  live: boolean
  /** (a) only: a session in it moved within REAP_IDLE_MS. */
  busy: boolean
  /** Newest activity signal (heartbeat updatedAt / worktree creation), epoch ms. */
  lastActivityMs: number
}

/** The whole decision, pure. `cardColumns` null = the Board could not be read —
 *  then no card counts as done (unknown never condemns). */
export const reapVerdict = (
  c: ReapCandidate,
  cardColumns: Map<string, string> | null,
  now: number,
): 'reap' | ReapKeepReason => {
  if (!c.branch?.startsWith('swarm/')) return 'not-swarm'
  if (c.dirty) return 'dirty'
  if (c.merged !== 'merged') return 'unmerged'
  if (c.rosterTaskId !== undefined) {
    if (cardColumns?.get(c.rosterTaskId) !== 'done') return 'engine-owned'
    return c.busy ? 'busy' : 'reap'
  }
  if (c.live) return 'live'
  if (now - c.lastActivityMs < REAP_GRACE_MS) return 'recent'
  return 'reap'
}

export interface ReapFinishedWorkersDeps {
  /** Central `swarm/*`-or-other worktrees: canonical dir + branch. */
  listWorktrees: (projectPath: string) => Promise<{ dir: string; branch: string | null }[]>
  isDirty: (worktree: string) => Promise<boolean>
  checkMerged: (projectPath: string, branches: string[]) => Promise<Record<string, MergedBranchStatus>>
  liveCwds: () => Promise<string[]>
  /** Engine rows (in-memory roster + saved roster.json): raw worktree + card id. */
  roster: (projectPath: string) => Promise<{ worktree: string; taskId: string }[]>
  /** Card id → Board column; null when the Board can't be read. */
  cardColumns: (projectPath: string) => Promise<Map<string, string> | null>
  /** Last heartbeat per worktree (canonical), epoch ms. */
  heartbeatTimes: (projectPath: string) => Promise<Map<string, number>>
  createdMs: (worktree: string) => Promise<number>
  /** Did a session in this dir move within `withinMs`? (mid-turn always counts) */
  recentlyActive: (worktree: string, now: number, withinMs: number) => Promise<boolean>
  removeWorktree: (
    projectPath: string,
    worktree: string,
    opts: { refuseIfOccupied: boolean },
  ) => Promise<{ removed: boolean }>
  now: () => number
}

const canon = (p: string) => canonicalize(p).catch(() => p)

/** `git status --porcelain`, minus the worktree's own node_modules SYMLINK (under
 *  a `node_modules/` gitignore it reads as untracked — linkWorktreeNodeModules put
 *  it there, it is not work). A failed probe is dirty. */
const defaultIsDirty = async (wt: string): Promise<boolean> => {
  if (!isGitRepoRoot(wt)) return true
  let out: string
  try {
    out = (await execFile('git', ['status', '--porcelain'], { cwd: wt, timeout: 30_000 })).stdout
  } catch {
    return true
  }
  const nmIsLink = await lstat(join(wt, 'node_modules')).then((s) => s.isSymbolicLink(), () => false)
  return out
    .split('\n')
    .filter((l) => l.trim() && !(nmIsLink && /^\?\? node_modules\/?$/.test(l)))
    .length > 0
}

/** The saved roster.json, STRICT. readRoster reads a corrupt file as [] — right
 *  for its callers (a boot resume degrades to "external worker"), wrong here,
 *  where [] means "the engine holds nothing" and licenses removal. So: no file (or
 *  no repo key) is an empty roster; a file that cannot be read or parsed throws,
 *  and reapFinishedWorkers removes nothing that round. A row is kept on its
 *  worktree alone (readRoster would also drop a row missing its branch). */
export const readSavedRosterStrict = async (projectPath: string): Promise<{ worktree: string; taskId: string }[]> => {
  const path = await rosterFile(projectPath)
  if (!path) return []
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const workers = (JSON.parse(text) as { workers?: unknown }).workers
  if (!Array.isArray(workers)) throw new Error('roster.json has no workers array')
  return workers.flatMap((w) => {
    const r = (w ?? {}) as Record<string, unknown>
    return typeof r.worktree === 'string' && r.worktree
      ? [{ worktree: r.worktree, taskId: typeof r.taskId === 'string' ? r.taskId : '' }]
      : []
  })
}

export const defaultReapDeps = (): ReapFinishedWorkersDeps => ({
  listWorktrees: listProjectWorktrees,
  isDirty: defaultIsDirty,
  checkMerged: (p, b) => checkMergedBranches(p, b, undefined, { fetch: false }),
  liveCwds: () => canonicalLiveDeskCwds(),
  roster: async (p) => {
    const live = ((await getOrchestratorState(p)).workers ?? []).map((w) => ({ worktree: w.worktree, taskId: w.taskId }))
    // The saved roster covers the restart window, when the in-memory engine is
    // empty but its workers are still due to be resumed. Corrupt ⇒ throws ⇒
    // nothing is removed this round (readSavedRosterStrict).
    return [...live, ...(await readSavedRosterStrict(p))]
  },
  cardColumns: async (p) => {
    try {
      const { tasks } = await readProjectData(p)
      return new Map(tasks.map((t) => [t.id, t.boardColumn ?? 'todo']))
    } catch {
      return null
    }
  },
  heartbeatTimes: async (p) => {
    const out = new Map<string, number>()
    for (const [wt, hb] of Array.from(await readHeartbeats(p))) {
      const ms = hb.updatedAt ? Date.parse(hb.updatedAt) : NaN
      if (!Number.isNaN(ms)) out.set(await canon(wt), ms)
    }
    return out
  },
  // `<wt>/.git` is the file `git worktree add` writes — its mtime is the birth of
  // the worktree. Unreadable ⇒ "just now" (never reads as old).
  createdMs: (wt) => stat(join(wt, '.git')).then((s) => s.mtimeMs, () => Date.now()),
  recentlyActive: (wt, now, withinMs) => deskRecentlyActiveIn(wt, now, withinMs, Number.POSITIVE_INFINITY),
  removeWorktree: (p, wt, o) => removeSwarmWorktree(p, wt, { force: false, refuseIfOccupied: o.refuseIfOccupied }),
  now: Date.now,
})

export interface ReapFinishedWorkersResult {
  removedDirs: string[]
  kept: { worktree: string; reason: ReapKeepReason }[]
}

/** Remove every finished, fully-integrated worker worktree of this project (see
 *  the header for the rule). Never throws on a missing repo/dir — degrades to
 *  empty results. */
export const reapFinishedWorkers = async (
  projectPath: string,
  deps: ReapFinishedWorkersDeps = defaultReapDeps(),
): Promise<ReapFinishedWorkersResult> => {
  const removedDirs: string[] = []
  const kept: ReapFinishedWorkersResult['kept'] = []
  const worktrees = (await deps.listWorktrees(projectPath)).filter((w) => w.branch?.startsWith('swarm/'))
  if (worktrees.length === 0) return { removedDirs, kept }

  // Roster unreadable (the saved roster.json corrupt — readSavedRosterStrict
  // throws) ⇒ we cannot tell whether the engine holds a worktree, so nothing is
  // removed this round.
  const readRosterMap = async (): Promise<Map<string, { raw: string; taskId: string }> | null> => {
    const rows = await deps.roster(projectPath).catch(() => null)
    if (!rows) return null
    const m = new Map<string, { raw: string; taskId: string }>()
    for (const r of rows) m.set(await canon(r.worktree), { raw: r.worktree, taskId: r.taskId })
    return m
  }
  const [merged, live, roster, columns, hbTimes] = await Promise.all([
    deps.checkMerged(projectPath, worktrees.map((w) => w.branch as string)),
    deps.liveCwds(),
    readRosterMap(),
    deps.cardColumns(projectPath),
    deps.heartbeatTimes(projectPath),
  ])
  if (roster === null) return { removedDirs, kept }

  for (const wt of worktrees) {
    const row = roster.get(wt.dir)
    const now = deps.now()
    const verdict = reapVerdict(
      {
        branch: wt.branch,
        dirty: await deps.isDirty(wt.dir),
        merged: merged[wt.branch as string] ?? 'unknown',
        rosterTaskId: row?.taskId,
        live: isDirOccupied(live, wt.dir),
        busy: row ? await deps.recentlyActive(wt.dir, now, REAP_IDLE_MS) : false,
        lastActivityMs: Math.max(hbTimes.get(wt.dir) ?? 0, await deps.createdMs(wt.dir)),
      },
      columns,
      now,
    )
    const keep = (reason: ReapKeepReason) => kept.push({ worktree: wt.dir, reason })
    if (verdict !== 'reap') {
      keep(verdict)
      continue
    }
    // Re-check what may have changed since the snapshot above (earlier removals
    // in this pass can each take seconds).
    if (row) {
      if ((await deps.cardColumns(projectPath))?.get(row.taskId) !== 'done') {
        keep('engine-owned')
        continue
      }
      if (await deps.recentlyActive(wt.dir, deps.now(), REAP_IDLE_MS)) {
        keep('busy')
        continue
      }
    } else {
      const fresh = await readRosterMap()
      if (!fresh || fresh.has(wt.dir)) {
        keep('engine-owned')
        continue
      }
    }
    // (a) passes the path the session was SPAWNED with — the PTY kill matches the
    // raw cwd — and may stop the idle session; (b) never stops anything.
    const res = await deps
      .removeWorktree(projectPath, row ? row.raw : wt.dir, { refuseIfOccupied: !row })
      .catch(() => ({ removed: false }))
    if (res.removed) removedDirs.push(wt.dir)
    else keep('remove-refused')
  }
  return { removedDirs, kept }
}

/** One pass over every registered project that has anything in its central
 *  worktrees dir: reap finished workers, then — only when something was removed —
 *  the janitor's safe sweep (merged `swarm/*` branches with `-d`, heartbeats whose
 *  worktree is gone). */
export const runWorkerReapPass = async (): Promise<void> => {
  const settings = await getSettings()
  for (const entry of settings.projects ?? []) {
    try {
      const central = centralWorktreesDir(await projectUUIDFromPath(entry.path))
      if ((await readdir(central).catch(() => [])).length === 0) continue
      const { removedDirs } = await reapFinishedWorkers(entry.path)
      if (removedDirs.length > 0) await runSwarmJanitor(entry.path) // NO force / deleteRemote
    } catch {
      /* one project failing must not stop the others */
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_worker_reap_timer: ReturnType<typeof setInterval> | null | undefined
  // eslint-disable-next-line no-var
  var __openground_worker_reap_inflight: boolean | undefined
}

/** Boot loop (server/index.ts only, primary instance only — unit tests mount the
 *  app, not the entry). Reload-safe, unref'd, overlap-free. Kill-switch:
 *  OPENGROUND_WORKER_REAP=0. */
export const startWorkerReapLoop = (intervalMs: number = WORKER_REAP_INTERVAL_MS): void => {
  if (globalThis.__openground_worker_reap_timer) clearInterval(globalThis.__openground_worker_reap_timer)
  const timer = setInterval(() => {
    if (globalThis.__openground_worker_reap_inflight) return
    globalThis.__openground_worker_reap_inflight = true
    void runWorkerReapPass()
      .catch(() => {})
      .finally(() => {
        globalThis.__openground_worker_reap_inflight = false
      })
  }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  globalThis.__openground_worker_reap_timer = timer
}
