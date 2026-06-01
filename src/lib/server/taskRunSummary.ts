import type { RunEntry, RunSession, TaskRunSummary, TranscriptRef } from '../types'
import { runKind } from '../runStatus'
import { sessionJsonlPath } from './observer'
import { readProjectData, writeProjectData } from './projectData'

// The settled subset of RunKind that a persisted TaskRunSummary may carry.
// runStatus.ts is the single source of truth for the classification; this
// type just narrows away the transient states (queued/running/merging/
// conflict) that never reach a persisted summary.
export type SettledRunKind = TaskRunSummary['kind']

// Map a (settled) RunEntry to the kind we persist on the task. Reuses the
// shared `runKind` classifier so client (card hero, derived on the fly) and
// server (this persisted snapshot) can never disagree on what a run "was".
//
// `runKind` can return transient kinds when an entry still carries an
// in-flight mergeStatus ('merging'/'conflict') or hasn't settled. Those
// don't belong in a persisted summary, so we fold them onto the underlying
// terminal status: a merge that's still moving is, from the task's POV,
// effectively done (the work landed); anything else collapses to its raw
// status. The persistence caller only invokes this on settled entries, so
// the transient branches are belt-and-suspenders.
export const taskRunKind = (entry: RunEntry): SettledRunKind => {
  const k = runKind(entry)
  switch (k) {
    case 'done':
    case 'review':
    case 'skipped':
    case 'error':
    case 'overloaded':
    case 'cancelled':
      return k
    case 'merging':
    case 'conflict':
      // Mid-merge entry: classify by its terminal run status instead.
      if (entry.status === 'error') return entry.overloaded ? 'overloaded' : 'error'
      if (entry.status === 'cancelled') return 'cancelled'
      return 'done'
    case 'queued':
    case 'running':
      // Should never reach a persisted summary; treat as cancelled so we
      // never write a half-baked "still going" snapshot.
      return 'cancelled'
  }
}

// Build the lightweight, persisted summary for a settled run entry. Carries
// the narrative half only — the conversation body stays in the claude JSONL,
// referenced via TranscriptRef (see persistTaskRunSummaries).
export const buildTaskRunSummary = (entry: RunEntry): TaskRunSummary => {
  const pr = entry.parsedResult
  return {
    kind: taskRunKind(entry),
    ...(pr?.topic?.trim() ? { topic: pr.topic.trim() } : {}),
    summary: pr?.summary?.trim() ?? '',
    blockers: pr?.blockers?.trim() ?? '',
    ...(pr?.decisions && pr.decisions.length ? { decisions: pr.decisions } : {}),
    ...(pr?.followups && pr.followups.length ? { followups: pr.followups } : {}),
    ...(pr?.question?.trim() ? { question: pr.question.trim() } : {}),
    ...(typeof pr?.taskComplete === 'boolean' ? { taskComplete: pr.taskComplete } : {}),
    sessionId: entry.agentSessionId ?? '',
    finishedAt: entry.finishedAt ?? new Date().toISOString(),
  }
}

// Persist `latestRun` / `agentSessionId` / `transcriptRef` onto every task
// this run targeted. Called once per entry at run finalize (runOne tail,
// resolveConflict tail).
//
// Contract (confirmed plan decisions):
//  - Only writes a task that still exists in tasks.json. A run that targeted a
//    since-deleted task is dropped (no resurrection).
//  - finishedAt-newer-wins: never overwrite a task whose existing
//    latestRun.finishedAt is at-or-after this run's — so a slow run that
//    finishes after a faster, later-started one can't clobber the newer hero.
//  - Best-effort: any error is swallowed by the caller's try/catch; persistence
//    must never break the run lifecycle.
export const persistTaskRunSummaries = async (
  entry: RunEntry,
  effectiveCwd: string,
): Promise<void> => {
  if (!entry.targetedTasks.length) return
  // No agentSessionId means we can't build a usable transcript ref / resume
  // pointer; skip rather than persist a dangling summary.
  if (!entry.agentSessionId) return

  const summary = buildTaskRunSummary(entry)
  const transcriptRef: TranscriptRef = {
    sessionId: entry.agentSessionId,
    cwd: effectiveCwd,
    jsonlPath: sessionJsonlPath(effectiveCwd, entry.agentSessionId),
  }

  // Re-read inside the same call so we operate on the freshest tasks.json
  // (the run's own milestone/verify writes, or a concurrent edit, may have
  // landed between run start and here).
  const data = await readProjectData(entry.projectPath)
  const targetIds = new Set(entry.targetedTasks.map(t => t.id))
  let dirty = false
  for (const task of data.tasks) {
    if (!targetIds.has(task.id)) continue
    const prev = task.latestRun?.finishedAt
    // finishedAt-newer-wins. A missing/empty prior summary always loses.
    if (prev && prev >= summary.finishedAt) continue
    task.latestRun = summary
    task.agentSessionId = entry.agentSessionId
    task.transcriptRef = transcriptRef
    dirty = true
  }
  if (dirty) await writeProjectData(entry.projectPath, data)
}

// The settled run statuses a persisted run-file entry can carry. A
// not-yet-finished entry (no finishedAt) is never migrated — its summary
// would be half-baked, and it's almost certainly still live in-memory.
const SETTLED_ENTRY = new Set<RunEntry['status']>(['done', 'error', 'cancelled'])

// Phase 5.B — one-time migration: fold a persisted run-file session's
// narrative onto each targeted task's `latestRun`. This is the back-fill for
// installs that accumulated runs/*.json before P2/P3 started writing
// `task.latestRun` at run-finalize. It is pure leverage over the existing
// persistTaskRunSummaries: same finishedAt-newer-wins, same task-existence
// guard, same best-effort error swallowing — so re-running it is idempotent
// (a task whose latestRun is already at-or-newer is skipped) and it never
// resurrects a deleted task or clobbers a fresher hero.
//
// effectiveCwd is reconstructed from the entry's own persisted worktreePath
// (where claude actually ran) falling back to projectPath — mirroring how the
// live runner builds the transcript ref.
//
// runs/*.json is NOT touched: it stays as a cache, and the sessionId on each
// entry remains the resume/observer/transcript pointer it always was.
export const migrateRunSessionToLatestRun = async (
  session: RunSession,
): Promise<void> => {
  for (const entry of session.entries) {
    if (!SETTLED_ENTRY.has(entry.status)) continue
    if (!entry.finishedAt) continue
    if (!entry.agentSessionId) continue
    if (!entry.targetedTasks.length) continue
    // Pick the cwd the transcript JSONL actually lives under — must match the
    // live runner's choice (runner.ts, after runWorktreeMerge): a clean merge
    // relocates the JSONL from the worktree to the main project dir, so once
    // mergeStatus==='merged' the resume-correct cwd is projectPath. Only an
    // unmerged / conflicted worktree still holds the transcript at worktreePath.
    const effectiveCwd =
      entry.worktreePath && entry.mergeStatus !== 'merged'
        ? entry.worktreePath
        : entry.projectPath
    try {
      await persistTaskRunSummaries(entry, effectiveCwd)
    } catch {
      // Best-effort: a malformed entry / unreadable tasks.json must not
      // abort the whole sweep. The next startup retries it.
    }
  }
}
