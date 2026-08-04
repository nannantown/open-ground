// swarmWorkerRoster — card 3 (docs/ENGINE_PERSISTENCE_PLAN.md §3/§4-3): the
// commander engine's OWN worker roster, write-through to disk, so a restart can
// reconcile "who was I running" against reality (git / heartbeat / Board) BEFORE
// it dispatches anything new — instead of booting with an empty in-memory roster
// and either double-dispatching a card a live worktree already owns, or resetting
// every worker's runaway clock to zero (the "worker 若返り" the plan §3 names).
//
// PLACEMENT — the heartbeat's neighbour, NOT projectDataDir. The roster lives at
// `~/.openground/swarm/<repoKey>/roster.json`, keyed by the SAME swarmRepoKey the
// heartbeat files use (swarmJanitor / swarmWorkerRegistry), because a worker's
// identity here is its worktree and the swarm dir is where all per-worker,
// engine-owned scratch already lives. Routing through openGroundHome() (re-read
// every call) + swarmRepoKey keeps it under the testHomeGuard fence automatically,
// exactly like readHeartbeats (07 章 / paths.ts fence note).
//
// WRITE REGIME (plan §3, bottom) — mirrors swarmEnginePersistence.ts:
//   • every write goes through atomicWriteJson;
//   • a WRITE fault is FAIL-OPEN — writeRoster/removeRoster return `false`, never
//     throw (a broken disk must not stop a healthy in-memory engine; the roster is
//     a best-effort mirror for the NEXT boot);
//   • a READ fault is FAIL-QUIET-TO-EMPTY — a missing / unreadable / corrupt file,
//     or a repo with no swarm key, resolves to `[]`. Completion condition ④: a
//     corrupt roster must DEGRADE the whole engine to "no roster memory" (every
//     live worker is then surfaced by swarmWorkerRegistry as an EXTERNAL worker via
//     its heartbeat + live PTY), never crash a boot. Never throws.

import { readFile, mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJson } from './atomicWrite'
import { openGroundHome } from './paths'
import { swarmRepoKey } from './swarmJanitor'
import type { ProjectTask } from '../types'

/** One persisted worker — the roster's row. IDENTITY = `worktree` (one worker per
 *  isolated worktree, matching swarmWorkerRegistry). The plan §3 field list:
 *  sessionId / taskId / branch / worktree / tier / spawnAt / workedMs / reworkCount.
 *
 *  - `sessionId` — the worker's `claude --session-id` UUID (swarmWorker.ts's
 *    agentSessionId), captured at spawn. Card 4 uses it for `claude --resume`;
 *    card 3 only PERSISTS it. Its lifetime = this entry's lifetime = worker
 *    teardown (plan §3 note — it never enters swarm-sessions.json's role-desk file).
 *  - `tier` — the CLI `--model` alias the worker launched on (OrchestratorWorker.model).
 *  - `spawnAt` — epoch ms of dispatch (parsed from startedAt).
 *  - `workedMs` — accumulated WORKING time ON THE CURRENT ASSIGNMENT (wall-clock from
 *    the execution ceiling's own origin — the 差し戻し when there is one, else the
 *    spawn — minus the banked idle credits that origin does not already exclude),
 *    snapshotted at each state-transition write. Persisting it is
 *    what stops a restart from resetting the runaway clock to zero and handing the
 *    worker an unbounded fresh budget (plan §3). A DURATION, never an absolute
 *    re-work timestamp: that is what keeps the app's downtime off the clock. It is
 *    also why it is per-assignment — a resumed worker has no `reworkAt` left to move
 *    the origin, so a lifetime ledger would tear down a 差し戻し中 worker on the first
 *    pass after a restart (02章 §5.5(c)(d)). It is transition-granular, NOT
 *    per-tick (plan §3: "書くのは状態遷移点のみ") — so it can lag reality by the time
 *    since the last transition, which only ever makes a resumed clock MORE lenient
 *    by a bounded amount; the per-tick write the plan explicitly rejects is the cost
 *    it is not worth paying.
 *  - `reworkCount` — how many 差し戻し rounds this worker's card has taken. */
export interface RosterEntry {
  sessionId: string
  taskId: string
  branch: string
  worktree: string
  tier: string
  spawnAt: number
  workedMs: number
  reworkCount: number
}

interface RosterFile {
  workers: RosterEntry[]
}

/** Absolute path of a project's roster.json under its swarm heartbeat dir, or
 *  `null` when `projectPath` has no swarm repo key (not a git repo). Async because
 *  swarmRepoKey shells out to `git rev-parse`. */
export const rosterFile = async (projectPath: string): Promise<string | null> => {
  const key = await swarmRepoKey(projectPath)
  if (!key) return null
  return join(openGroundHome(), 'swarm', key, 'roster.json')
}

/** Tolerant parse of ONE raw entry — an absent/wrong-typed field takes its safe
 *  default; only `worktree` + `branch` (the identity + integration handle) are
 *  load-bearing, so an entry missing either is dropped rather than resurrected as a
 *  phantom. Numbers are floored to finite non-negative (a hand-corrupted ledger
 *  can never grant negative/NaN worked time). */
const parseEntry = (raw: unknown): RosterEntry | null => {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.worktree !== 'string' || !e.worktree) return null
  if (typeof e.branch !== 'string' || !e.branch) return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  return {
    sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
    taskId: typeof e.taskId === 'string' ? e.taskId : '',
    branch: e.branch,
    worktree: e.worktree,
    tier: typeof e.tier === 'string' ? e.tier : '',
    spawnAt: num(e.spawnAt),
    workedMs: num(e.workedMs),
    reworkCount: num(e.reworkCount),
  }
}

/** Read a project's persisted roster. FAIL-QUIET-TO-EMPTY: a missing file, an
 *  unreadable one, a corrupt/unparseable one, or a repo with no swarm key all
 *  resolve to `[]` — the completion-condition-④ degrade ("外部 worker 扱い"). Never
 *  throws. Malformed individual entries are skipped, not fatal. */
export const readRoster = async (projectPath: string): Promise<RosterEntry[]> => {
  try {
    const path = await rosterFile(projectPath)
    if (!path) return []
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<RosterFile>
    if (!Array.isArray(parsed.workers)) return []
    return parsed.workers.map(parseEntry).filter((e): e is RosterEntry => e !== null)
  } catch {
    return []
  }
}

/** Write-through the full roster. FAIL-OPEN: returns `false` (never throws) on any
 *  fault — the in-memory engine is this process's truth; disk is a best-effort
 *  mirror for the next boot. mkdir's the swarm dir first (a worker may be persisted
 *  before it has written its first heartbeat, so the dir need not exist yet — same
 *  ensure-then-write shape as swarmEnginePersistence.writeEngineIntent). */
export const writeRoster = async (projectPath: string, workers: RosterEntry[]): Promise<boolean> => {
  try {
    const key = await swarmRepoKey(projectPath)
    if (!key) return false
    const dir = join(openGroundHome(), 'swarm', key)
    await mkdir(dir, { recursive: true })
    await atomicWriteJson(join(dir, 'roster.json'), { workers } satisfies RosterFile)
    return true
  } catch {
    return false
  }
}

/** Add-or-replace one entry (keyed by worktree) via read-modify-write. FAIL-OPEN.
 *  A read that degrades to `[]` (corrupt file) is silently HEALED here — the write
 *  replaces the corrupt file with a valid one carrying this entry. */
export const upsertRosterEntry = async (projectPath: string, entry: RosterEntry): Promise<boolean> => {
  const current = await readRoster(projectPath)
  const next = current.filter((e) => e.worktree !== entry.worktree)
  next.push(entry)
  return writeRoster(projectPath, next)
}

/** Drop the entry for a worktree (teardown — completion condition ③). Idempotent:
 *  a worktree not present is a no-op that still rewrites the (unchanged) file.
 *  FAIL-OPEN. */
export const removeRosterEntry = async (projectPath: string, worktree: string): Promise<boolean> => {
  const current = await readRoster(projectPath)
  return writeRoster(
    projectPath,
    current.filter((e) => e.worktree !== worktree),
  )
}

// ─── boot reconciliation (plan §4-3b) ─────────────────────────────────────────

/** The 4-way classification of one roster entry at boot (plan §4-3b). Each maps to
 *  a disjoint reality and a disjoint action — completion condition ①. */
export type RosterEntryClass =
  /** worktree gone → entry dropped; the card follows the existing reclaim rule. */
  | 'vanished'
  /** card deleted, or a human moved it OUT of the active columns while the engine
   *  was down (消滅/移動) → entry dropped; existing card-vanished rule. */
  | 'card-gone'
  /** branch has integrable commits AND the worker beat readyToMerge → it already
   *  delivered; the existing manager-wake reflex integrates it. Entry dropped. */
  | 'ready'
  /** worktree alive, card still active, not yet ready → a RESUME CANDIDATE. Card 3
   *  KEEPS the entry (card 4 does the actual `claude --resume`); the plan forbids
   *  card 3 from re-adding it to the in-memory roster (no live PTY yet). */
  | 'in-progress'

/** The four reality probes classification consumes — resolved to primitives so
 *  this module never imports swarmOrchestrator (which imports IT). */
export interface RosterReality {
  worktreeExists: boolean
  /** Card found on the Board AND in an ACTIVE column (todo/doing/review). A card
   *  in done/blocked, or absent, is NOT active (消滅/移動). */
  cardActive: boolean
  branchAhead: boolean
  heartbeatReady: boolean
  /** Is the card sitting in `review` — i.e. has the work actually been HANDED OVER?
   *  Load-bearing because `heartbeatReady` is STICKY: `swarm-beat.sh` writes
   *  `readyToMerge:true` once and never unsets it, so a worker whose card was sent
   *  back (差し戻し → the card returns to `doing` and the SAME worker keeps working)
   *  still reports ready forever. Without this, that worker classified as
   *  'ready' — "delivered, drop the row" — and its row was pruned from the roster
   *  while the worker was mid-rework. Nothing then owned the card: selectDispatch
   *  only reads `todo`, and crash reclaim only walks `engine.workers`, so the card
   *  sat in `doing` permanently with a live worktree nobody would ever collect. */
  cardInReview: boolean
}

/** Pure classifier (plan §4-3b). Precedence is load-bearing: worktree existence is
 *  checked first (a gone worktree is 'vanished' no matter what the Board says), then
 *  the card, then readiness, else in-progress.
 *
 *  'ready' requires the BOARD to agree that the work was handed over
 *  (`cardInReview`), not just the worker's own sticky heartbeat — see
 *  {@link RosterReality.cardInReview}. */
export const classifyRosterEntry = (reality: RosterReality): RosterEntryClass => {
  if (!reality.worktreeExists) return 'vanished'
  if (!reality.cardActive) return 'card-gone'
  if (reality.branchAhead && reality.heartbeatReady && reality.cardInReview) return 'ready'
  return 'in-progress'
}

/** The probes reconcileRoster needs — supplied by swarmOrchestrator's resumeEngines
 *  from its own OrchestratorDeps (so the roster module stays decoupled + the boot
 *  test can inject fakes). */
export interface RosterReconcileDeps {
  fetchTasks: (projectPath: string) => Promise<ProjectTask[]>
  /** `null` ⇒ git could not answer (see swarmOrchestrator's
   *  defaultCountCommitsAhead). Read as "assume the branch HAS work": the roster's
   *  classification decides whether an entry can be dropped, and dropping one that
   *  holds commits is the loss. */
  countCommitsAhead: (projectPath: string, branch: string) => Promise<number | null>
  heartbeatReady: (projectPath: string, branch: string) => Promise<boolean>
  worktreeExists: (worktree: string) => Promise<boolean>
}

/** Does a worktree path still exist on disk? Any stat failure ⇒ false (a gone /
 *  unreadable worktree is 'vanished'). The default probe for RosterReconcileDeps. */
export const defaultWorktreeExists = async (worktree: string): Promise<boolean> => {
  try {
    await stat(worktree)
    return true
  } catch {
    return false
  }
}

const ACTIVE_COLUMNS = new Set(['todo', 'doing', 'review'])
const columnOf = (t: ProjectTask): string => t.boardColumn ?? (t.done ? 'done' : 'todo')

/** The classification outcome for a whole project's roster — completion condition ①
 *  (each bucket independently observable in a fixture). `resumeCandidates` are what
 *  card 4 will `--resume`; the other three are dropped from the persisted roster
 *  here. */
export interface RosterReconcileResult {
  resumeCandidates: RosterEntry[]
  ready: RosterEntry[]
  vanished: RosterEntry[]
  cardGone: RosterEntry[]
}

const EMPTY_RECONCILE: RosterReconcileResult = {
  resumeCandidates: [],
  ready: [],
  vanished: [],
  cardGone: [],
}

/** BOOT RECONCILE (plan §4-3). Read this project's roster, probe reality for every
 *  entry, classify it (§4-3b), and PRUNE everything that is not an in-progress
 *  resume candidate back to disk. Returns the 4-way split so resumeEngines can log /
 *  a test can assert it.
 *
 *  MUST NEVER THROW — resumeEngines calls it inside its per-project try, but the
 *  freeze it provides (dispatch is awaited AFTER this resolves) means a throw here
 *  would abort a project's resume; instead every fault degrades to "no roster"
 *  (completion condition ④). A corrupt roster ⇒ readRoster returns [] ⇒ an
 *  all-empty result ⇒ the engine boots with no roster memory and its live workers
 *  are surfaced as external by swarmWorkerRegistry. */
export const reconcileRoster = async (
  projectPath: string,
  deps: RosterReconcileDeps,
): Promise<RosterReconcileResult> => {
  try {
    const entries = await readRoster(projectPath)
    if (!entries.length) return EMPTY_RECONCILE

    // One Board read for the whole roster (card lookup by id).
    //
    // A read FAILURE is not evidence of anything. This used to degrade to "every
    // card reads as gone", which sounds conservative but is the opposite: every
    // entry then classified 'card-gone' and the prune below wrote the roster back
    // EMPTY — a transient Board blip at boot (the loopback API not up yet, a
    // momentarily locked file) permanently destroyed the memory of every live
    // worker, and the next boot had nothing left to recover from. Absence of
    // evidence was being written to disk as evidence of absence.
    //
    // Now a failed read ABORTS the reconcile: return the empty result (so the
    // caller adopts nobody this boot — the same freeze it already handles) while
    // leaving the on-disk roster untouched, so the NEXT boot can still recover.
    let byId = new Map<string, ProjectTask>()
    try {
      byId = new Map((await deps.fetchTasks(projectPath)).map((t) => [t.id, t]))
    } catch {
      return EMPTY_RECONCILE // roster on disk is preserved for the next attempt
    }

    const result: RosterReconcileResult = {
      resumeCandidates: [],
      ready: [],
      vanished: [],
      cardGone: [],
    }

    for (const entry of entries) {
      const worktreeExists = await deps.worktreeExists(entry.worktree)
      // Short-circuit the git/heartbeat probes when the worktree is already gone —
      // they'd only fail anyway, and this keeps a 'vanished' fixture from needing
      // to stub them.
      let cardActive = false
      let cardInReview = false
      let branchAhead = false
      let heartbeatReady = false
      if (worktreeExists) {
        const card = entry.taskId ? byId.get(entry.taskId) : undefined
        cardActive = !!card && ACTIVE_COLUMNS.has(columnOf(card))
        // Where the card actually SITS decides whether the work was handed over —
        // the worker's own `readyToMerge` is sticky and survives a 差し戻し.
        cardInReview = !!card && columnOf(card) === 'review'
        if (cardActive) {
          // `null` (git could not answer) and a THROW both mean "unknown", and
          // unknown counts as AHEAD here — the safe direction for a decision that
          // can retire a roster entry whose branch may hold the only copy of the
          // work. A genuine 0 still reads as not-ahead.
          const counted = await deps
            .countCommitsAhead(projectPath, entry.branch)
            .catch(() => null)
          branchAhead = counted === null || counted > 0
          heartbeatReady = await deps.heartbeatReady(projectPath, entry.branch).catch(() => false)
        }
      }
      const klass = classifyRosterEntry({
        worktreeExists,
        cardActive,
        branchAhead,
        heartbeatReady,
        cardInReview,
      })
      switch (klass) {
        case 'vanished':
          result.vanished.push(entry)
          break
        case 'card-gone':
          result.cardGone.push(entry)
          break
        case 'ready':
          result.ready.push(entry)
          break
        case 'in-progress':
          result.resumeCandidates.push(entry)
          break
      }
    }

    // Persist the pruned roster: only resume candidates survive (the other three
    // buckets delivered / vanished / lost their card). Write only when it actually
    // shrank, so a boot with an all-in-progress roster does no needless I/O.
    if (result.resumeCandidates.length !== entries.length) {
      await writeRoster(projectPath, result.resumeCandidates)
    }
    return result
  } catch {
    // Belt-and-suspenders: any unforeseen fault degrades to "no roster" rather
    // than throwing into resumeEngines' per-project try (which would still catch
    // it, but the contract is this never throws — plan §3 read-fault handling).
    return EMPTY_RECONCILE
  }
}
