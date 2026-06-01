import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { writeFile, readFile, readdir, unlink, stat, rename, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join, basename } from 'path'
import { ensureRunsArchiveDir, ensureRunsDir, runFile, runsArchiveDir, runsDir } from './paths'
import { readProjectData, writeProjectData } from './projectData'
import {
  hasGit,
  createWorktree,
  autoCommitIfDirty,
  mergeAndCleanup,
  removeWorktree,
  cleanupStaleWorktrees,
  type WorktreeInfo,
} from './worktree'
import { getSettings } from './store'
import { createProjectRunGate, type ProjectRunGate } from './projectRunGate'
import { launchClaude, sendInterrupt, forceKill, seedPrompt } from './claudeTerminal'
import { getTerminal, subscribeTerminal } from './terminal'
import { attach as observerAttach, nudge as observerNudge } from './observer'
import { claudeDirName } from './claudeProjectDir'
import { persistTaskRunSummaries, migrateRunSessionToLatestRun } from './taskRunSummary'
import type {
  CanvasContext,
  ParsedRunResult,
  PermissionMode,
  RunEntry,
  RunGitInfo,
  RunSession,
  TargetedTask,
} from '../types'

const execFile = promisify(execFileCb)

export type RunEvent =
  | { type: 'session'; session: RunSession }
  | { type: 'entry'; entry: RunEntry }
  | { type: 'log'; projectId: string; chunk: string }
  | { type: 'thought'; projectId: string; thought: { at: string; text: string } }
  | { type: 'done' }
  // observer fired CANVAS_ADD: / CANVAS_UPDATE: into a Canvas file. Carries the
  // project path + canvas id so the client can decide whether the currently-open
  // Canvas needs a refresh (matches → re-fetch; otherwise ignore).
  | { type: 'canvas-add'; projectPath: string; canvasId: string }
  // observer rejected a CANVAS_ADD / CANVAS_UPDATE marker (bad JSON, unknown
  // type, missing id, …). Surfaced to the client as a transient toast so the
  // user sees the failure instead of it dying silently in the run log.
  | { type: 'canvas-error'; projectPath: string; canvasId: string; message: string }

interface RunItem {
  projectId: string
  projectName: string
  projectPath: string
  prompt: string
  targetedTasks: TargetedTask[]
  /** Claude session id — assigned for a fresh run, reused to resume. */
  agentSessionId: string
  /** True to resume the existing Claude session rather than start fresh. */
  resume: boolean
  /** Auto-continue round (1-based) when this run is part of an auto-loop. */
  autoRound?: number
  /** The user-facing message that kicked this run off — task title for a
   *  fresh run, the typed instruction for a resume. Shown as the user bubble
   *  in the chat cockpit. */
  feedback?: string
  /** Permission mode for the spawned `claude` (defaults to bypass). */
  permissionMode?: PermissionMode
  /** When the run originates from a Canvas chat, this carries the Canvas
   *  id so the observer can route Claude's `CANVAS_ADD:` markers to the
   *  right Canvas file. Absent for Chats-tab runs (the marker is then
   *  ignored — keeps the Chats path completely untouched). */
  canvasContext?: CanvasContext
  /** Set by /api/run when the caller asked to resume a session but the
   *  session file couldn't be located (worktree gone etc.) and we rebuilt a
   *  fresh-run prompt instead. Surfaced on the resulting RunEntry so the UI
   *  can tell the user "the continue silently fell back to a new session". */
  resumeFallback?: boolean
  /** Phase 6.D: when this run is bound to a specific Milestone, the runner
   *  fires its verify pass at the end and the auto-loop switches to using
   *  the external shell verify as the source of truth for completion. */
  milestoneId?: string
}

interface StartRunOptions {
  items: RunItem[]
  concurrency: number
}

type GlobalListener = (sessionId: string, event: RunEvent, seq: number) => void

// Cap on the in-memory event replay buffer. With log events flushed at 200ms
// debounce client-side and SSE pings at 25s, ~2000 events is several minutes of
// busy chat — enough to cover a Wi-Fi blip / tab unfocus / dev-server reload.
// When the gap exceeds this, the client falls back to /api/run/list for a
// full snapshot (cursor event tells it so).
const EVENT_LOG_MAX = 2000

interface RunnerState {
  sessions: Map<string, RunSession>
  globalListeners: Set<GlobalListener>
  // Serial lock for non-worktree runs — two claude PTYs never share a project dir.
  projectLocks: Map<string, Promise<void>>
  // Run-session ids whose user-initiated cancel has been registered but not
  // yet acknowledged by the PTY exit listener.
  cancelled: Set<string>
  // How many tasks are currently running (or spawning) per project. Used to
  // decide whether a new task needs its own worktree.
  activeCount: Map<string, number>
  // Per-project sequential merge queue — worktree branches merge one at a time.
  mergeQueues: Map<string, Promise<void>>
  // Cancel-press counter for Phase 7's double-press hard-kill UX. Keyed by
  // `${sessionId}:${projectId}`. Cleared after a hard-kill or on PTY exit.
  cancelPress: Map<string, { count: number; lastAt: number }>
  // Ring buffer of recent events for SSE catch-up. When a client reconnects
  // with `Last-Event-ID: <seq>` (or `?since=<seq>`), we replay everything
  // newer. Survives HMR via globalThis.
  eventLog: Array<{ seq: number; sessionId: string; event: RunEvent }>
  // Monotonic event sequence number — incremented on every emit().
  nextSeq: number
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_runner: RunnerState | undefined
}

const state: RunnerState =
  globalThis.__openground_runner ??
  (globalThis.__openground_runner = {
    sessions: new Map(),
    globalListeners: new Set(),
    projectLocks: new Map(),
    cancelled: new Set(),
    activeCount: new Map(),
    mergeQueues: new Map(),
    cancelPress: new Map(),
    eventLog: [],
    nextSeq: 0,
  })
// Survive hot-reloads from before these fields existed.
state.globalListeners ??= new Set()
state.projectLocks ??= new Map()
state.cancelled ??= new Set()
state.activeCount ??= new Map()
state.mergeQueues ??= new Map()
state.cancelPress ??= new Map()
state.eventLog ??= []
state.nextSeq ??= 0
const { sessions, globalListeners, projectLocks, cancelled, activeCount, mergeQueues, cancelPress } = state

// Default cap on simultaneous same-project worktree (non-resume) runs. Slice 1
// made every non-resume chat run isolated in its own worktree, so same-project
// chats already run concurrently — but unbounded. This cap bounds that fan-out
// (e.g. "run all open chats" on 12 chats) so we don't spawn 12 worktrees + 12
// PTYs at once. Overridable via settings.maxConcurrentRunsPerProject.
export const DEFAULT_MAX_CONCURRENT_RUNS_PER_PROJECT = 3

// Per-project bounded-parallelism gate. Lives on globalThis so it survives
// `tsx watch` HMR reloads (same pattern as the rest of the runner state) — a
// reload mid-run must not lose the held-slot/queue bookkeeping or the cap would
// leak. The cap is read per-acquire from settings (cached briefly) so a
// settings change applies to subsequently-started runs without a restart.
declare global {
  // eslint-disable-next-line no-var
  var __openground_run_gate: ProjectRunGate | undefined
  // eslint-disable-next-line no-var
  var __openground_run_gate_cap: number | undefined
}
// Cache the cap so the synchronous gate getter doesn't have to await getSettings
// on every acquire. Refreshed asynchronously below; defaults until first read.
globalThis.__openground_run_gate_cap ??= DEFAULT_MAX_CONCURRENT_RUNS_PER_PROJECT
const runGate: ProjectRunGate =
  globalThis.__openground_run_gate ??
  (globalThis.__openground_run_gate = createProjectRunGate(
    () => globalThis.__openground_run_gate_cap ?? DEFAULT_MAX_CONCURRENT_RUNS_PER_PROJECT,
  ))

// Refresh the cached cap from settings — called once per startRun (cheap, and
// the cap rarely changes), so a Settings-panel edit takes effect for the next
// fired run without forcing a sync await into the gate's hot path.
const refreshRunGateCap = async () => {
  try {
    const s = await getSettings()
    const n = s.maxConcurrentRunsPerProject
    if (typeof n === 'number' && Number.isFinite(n) && n >= 1) {
      globalThis.__openground_run_gate_cap = Math.floor(n)
    } else {
      globalThis.__openground_run_gate_cap = DEFAULT_MAX_CONCURRENT_RUNS_PER_PROJECT
    }
  } catch {
    globalThis.__openground_run_gate_cap = DEFAULT_MAX_CONCURRENT_RUNS_PER_PROJECT
  }
}

export const emit = (sessionId: string, event: RunEvent) => {
  const seq = ++state.nextSeq
  state.eventLog.push({ seq, sessionId, event })
  if (state.eventLog.length > EVENT_LOG_MAX) {
    state.eventLog.splice(0, state.eventLog.length - EVENT_LOG_MAX)
  }
  Array.from(globalListeners).forEach(fn => fn(sessionId, event, seq))
}

// SSE catch-up: return every buffered event newer than `since`. If `since` is
// older than the oldest buffered seq, the gap is too wide for catch-up and the
// client should re-hydrate via /api/run/list (signalled by `currentSeq` being
// far ahead). Sorted ascending by seq — ready to replay in order.
export const getEventsSince = (
  since: number,
): Array<{ seq: number; sessionId: string; event: RunEvent }> => {
  return state.eventLog.filter((e) => e.seq > since)
}

// Current seq — used by /api/run/events to tell first-time clients where to
// resume from on the next reconnect.
export const currentSeq = () => state.nextSeq

// Oldest seq still in the buffer. A client whose `Last-Event-ID` is below this
// has missed events past our replay window and needs a full rehydrate.
export const oldestSeq = () =>
  state.eventLog.length > 0 ? state.eventLog[0].seq : state.nextSeq

// Watchdog: every 30s, sweep all in-memory sessions for entries whose PTY
// has gone but whose status is still 'running'. This happens when:
//   - the dev server hot-reloads runner.ts (the await Promise closure dies,
//     the terminal pool's exit listener fires into a function that no
//     longer transitions state)
//   - the PTY dies abnormally and the exit broadcast missed our listener
//   - any other path where the run-completion event is dropped
// Without this sweep, the chat shows "RUNNING" forever and the user has
// no clean recovery short of cancel-and-they-still-see-running.
// The interval id rides on the same globalThis state so HMR doesn't leak
// duplicate timers.
declare global {
  // eslint-disable-next-line no-var
  var __openground_runner_watchdog: ReturnType<typeof setInterval> | undefined
}
const WATCHDOG_INTERVAL_MS = 30_000

// Entries whose activeCount slot the watchdog has already released. runOne's
// `finally` consults this so a delayed await-resolution (the PTY exit finally
// reaches our closure after the sweep already cancelled the orphan) can't
// decrement activeCount a second time. WeakSet so it never pins memory and
// never touches the serialized RunEntry shape.
const watchdogReleased = new WeakSet<RunEntry>()

// Entry → its bounded-parallel gate release fn (set by runOne when it acquires
// a slot). The watchdog needs this so an orphaned run whose runOne `finally`
// never executes still frees its gate slot — otherwise the slot leaks and the
// effective per-project cap shrinks permanently. WeakMap so it never pins
// memory or touches the serialized RunEntry shape. makeRelease is
// double-release-safe, so runOne's own finally releasing it later is harmless.
const entryGateRelease = new WeakMap<RunEntry, () => void>()

// Mirror of runOne's `finally` activeCount-release, callable from the watchdog
// (which has no access to runOne's closure-local releaseLock / myChain).
// Decrements activeCount for the entry's project exactly once and, since the
// stuck run's myLock promise will never resolve, drops the wedged projectLocks
// chain so the next run for that project starts from a clean Promise.resolve()
// instead of eating the full PROJECT_LOCK_TIMEOUT_MS gate every time.
const releaseActiveSlot = (entry: RunEntry) => {
  const remaining = Math.max(0, (activeCount.get(entry.projectId) ?? 1) - 1)
  if (remaining === 0) activeCount.delete(entry.projectId)
  else activeCount.set(entry.projectId, remaining)
  // The stuck run owns the tail of the projectLocks chain (its myLock never
  // resolves). Clearing it advances the chain so future runs aren't gated
  // behind a lock that can never release.
  projectLocks.delete(entry.projectId)
  // Free its bounded-parallel slot too (no-op for serial/plan/resume runs that
  // never acquired one), so a queued same-project run can start.
  const release = entryGateRelease.get(entry)
  if (release) {
    entryGateRelease.delete(entry)
    try { release() } catch {}
  }
}

const sweepOrphanRuns = () => {
  for (const session of Array.from(sessions.values())) {
    if (session.finishedAt) continue
    let anyChanged = false
    for (const entry of session.entries) {
      if (entry.status !== 'running' || !entry.terminalId) continue
      const live = getTerminal(entry.terminalId)
      if (live && !live.finishedAt) continue
      // PTY is gone or finished but our runOne await never resolved.
      // Treat as cancelled (we can't tell if it was a clean /quit or a
      // crash; either way, the run is over from the user's POV).
      entry.status = 'cancelled'
      entry.finishedAt = new Date().toISOString()
      const parsed = parseResult(entry.log)
      if (parsed) entry.parsedResult = parsed
      // runOne's `finally` for this entry will never run (its await is wedged),
      // so it never decrements activeCount or releases the project lock chain —
      // mirror that bookkeeping here, exactly once, or this project leaks an
      // active slot and a stuck lock that wedges all its future runs.
      if (!watchdogReleased.has(entry)) {
        watchdogReleased.add(entry)
        releaseActiveSlot(entry)
      }
      emit(session.id, { type: 'entry', entry })
      anyChanged = true
    }
    if (anyChanged && session.entries.every((e) => e.finishedAt)) {
      session.finishedAt = new Date().toISOString()
      emit(session.id, { type: 'session', session })
    }
  }
}
if (globalThis.__openground_runner_watchdog) {
  clearInterval(globalThis.__openground_runner_watchdog)
}
globalThis.__openground_runner_watchdog = setInterval(
  () => { try { sweepOrphanRuns() } catch {} },
  WATCHDOG_INTERVAL_MS,
)

// Periodic worktree GC: cleanupStaleWorktrees scrubs orphan worktrees left
// by abnormally-exited runs. Startup paths already call it once, but Plan
// v2.3 §1 also asks for an ongoing sweep so long-running sessions don't
// accumulate dead `.openground/worktrees/<id>` directories. Once every
// 10 minutes is cheap (the function is a no-op when the dir doesn't exist).
declare global {
  // eslint-disable-next-line no-var
  var __openground_worktree_gc: ReturnType<typeof setInterval> | undefined
}
const WORKTREE_GC_INTERVAL_MS = 10 * 60 * 1000
const sweepAllWorktrees = async () => {
  try {
    const settings = await getSettings()
    if (!settings.projectsRoot) return
    const { readdir } = await import('fs/promises')
    let entries: string[]
    try {
      entries = await readdir(settings.projectsRoot)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      try {
        await cleanupStaleWorktrees(
          (await import('path')).join(settings.projectsRoot!, name),
        )
      } catch {}
    }
  } catch {}
}
if (globalThis.__openground_worktree_gc) {
  clearInterval(globalThis.__openground_worktree_gc)
}
globalThis.__openground_worktree_gc = setInterval(
  () => { void sweepAllWorktrees() },
  WORKTREE_GC_INTERVAL_MS,
)

// Phase 7 — stranded run-queue sweep.
//
// Run on startup AND on the same 10-minute heartbeat as the worktree GC.
// Scans every project's tasks.json for goals whose runQueue is still
// marked `running` even though no live session is driving it. Such
// queues are a casualty of a dev-server crash (the previous process
// died mid-sequence) or a hung/abandoned milestone session (a runaway
// claude PTY we already cancelled but never re-flipped the queue).
//
// We *don't* try to auto-resume — flipping to `paused` is safer: the UI
// can show "Resume from milestone N?" so the user is in control of when
// to re-enter that loop (especially important after a crash, where the
// reason for the crash may still apply).
declare global {
  // eslint-disable-next-line no-var
  var __openground_runqueue_gc: ReturnType<typeof setInterval> | undefined
}
const sweepStrandedRunQueues = async () => {
  try {
    const settings = await getSettings()
    if (!settings.projectsRoot) return
    const { readdir } = await import('fs/promises')
    const { join } = await import('path')
    let entries: string[]
    try {
      entries = await readdir(settings.projectsRoot)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const projectPath = join(settings.projectsRoot, name)
      try {
        const data = await readProjectData(projectPath)
        const goals = data.goals ?? []
        let dirty = false
        for (const g of goals) {
          const q = g.runQueue
          if (!q || q.status !== 'running') continue
          // Find the in-flight session id (last sessions entry with no
          // finishedAt). If we can't find one, the queue is definitely
          // stranded.
          const inFlight = (q.sessions ?? []).find(s => !s.finishedAt)
          const live = inFlight ? sessions.get(inFlight.sessionId) : null
          const isAlive = !!live && !live.finishedAt
          if (!isAlive) {
            q.status = 'paused'
            q.lastActivityAt = new Date().toISOString()
            dirty = true
          }
        }
        if (dirty) {
          await writeProjectData(projectPath, data)
        }
      } catch {
        // Skip projects whose tasks.json is unreadable / malformed —
        // the user will see them in the UI either way.
      }
    }
  } catch {}
}
if (globalThis.__openground_runqueue_gc) {
  clearInterval(globalThis.__openground_runqueue_gc)
}
// Run once at startup (next tick to dodge the HMR-restart initialisation
// races) then on the 10-min heartbeat.
setTimeout(() => { void sweepStrandedRunQueues() }, 2000)
globalThis.__openground_runqueue_gc = setInterval(
  () => { void sweepStrandedRunQueues() },
  WORKTREE_GC_INTERVAL_MS,
)

// Phase 5.B — one-time `latestRun` back-fill sweep.
//
// Reads every persisted run-file under runs/ and folds its settled entries'
// narrative onto each targeted task's `task.latestRun` (via
// migrateRunSessionToLatestRun → persistTaskRunSummaries). This is the
// back-fill for installs that accrued runs/*.json before P2/P3 began writing
// latestRun at run-finalize: after this sweep, the card hero + THREAD render
// from task.latestRun even when the in-memory / disk run-session list is
// empty, so runs/ becomes a pure cache rather than the source of truth.
//
// Idempotent by construction: persistTaskRunSummaries is finishedAt-newer-wins
// and task-existence-guarded, so a task already carrying an at-or-newer
// latestRun is skipped, a since-deleted task is dropped, and re-running on the
// next boot is a no-op. We therefore don't track a "migrated" flag — the data
// itself is the watermark. runs/*.json is left in place (cache; the sessionId
// stays the resume/observer/transcript pointer).
//
// HMR-safe: guarded by a global so a dev hot-reload doesn't re-spawn it, and
// it's a one-shot timeout (no interval) — there's nothing to keep sweeping
// once the disk run-files are folded in.
declare global {
  // eslint-disable-next-line no-var
  var __openground_latestrun_migrated: boolean | undefined
}
const sweepMigrateLatestRun = async () => {
  try {
    let files: string[]
    try {
      files = (await readdir(runsDir())).filter(f => f.endsWith('.json'))
    } catch {
      // No runs/ dir yet (fresh install) — nothing to migrate.
      return
    }
    for (const f of files) {
      let session: RunSession
      try {
        session = JSON.parse(await readFile(join(runsDir(), f), 'utf8')) as RunSession
      } catch {
        continue // skip a malformed / partially-written run-file.
      }
      // A still-live in-memory session will persist its own latestRun at
      // finalize; only migrate sessions that are genuinely settled on disk.
      if (!session.finishedAt) continue
      await migrateRunSessionToLatestRun(session)
    }
  } catch {}
}
if (!globalThis.__openground_latestrun_migrated) {
  globalThis.__openground_latestrun_migrated = true
  // Same 2s startup delay as the run-queue sweep — past the HMR init races,
  // and serialised after the project root settles.
  setTimeout(() => { void sweepMigrateLatestRun() }, 2000)
}

export const appendLog = (session: RunSession, entry: RunEntry, text: string) => {
  entry.log += text
  emit(session.id, { type: 'log', projectId: entry.projectId, chunk: text })
}

// Cap on retained thoughts per entry — keeps long runs from ballooning the
// session JSON. The full narrative is still recoverable from the log.
const MAX_THOUGHTS_PER_ENTRY = 50

export const appendThought = (session: RunSession, entry: RunEntry, text: string) => {
  const clean = text.trim()
  if (!clean) return
  // The OPENGROUND_RESULT line is the final structured answer, not in-flight thinking
  // — skip so the live UI does not flash the JSON blob right before "done".
  if (/(?:OPENGROUND_RESULT|HOVE_RESULT|PMMAP_RESULT):/.test(clean)) return
  // "No response requested." is a bookkeeping marker Claude emits as an
  // assistant text block when a turn is pure tool calls without user-facing
  // narrative. It's the absence of a thought, not a thought — surfacing it
  // as latestThought makes the chat look like Claude went silent or got
  // stuck. The user is better served by keeping the previous thought
  // visible until a real new one arrives.
  if (clean === 'No response requested.') return
  const thought = { at: new Date().toISOString(), text: clean }
  entry.thoughts = entry.thoughts ?? []
  entry.thoughts.push(thought)
  if (entry.thoughts.length > MAX_THOUGHTS_PER_ENTRY) {
    entry.thoughts.splice(0, entry.thoughts.length - MAX_THOUGHTS_PER_ENTRY)
  }
  emit(session.id, { type: 'thought', projectId: entry.projectId, thought })
}

// Same retention policy as thoughts — N most-recent actions stay on the entry
// so the JSON dump for finished runs doesn't grow without bound.
const MAX_ACTIONS_PER_ENTRY = 50

export const appendAction = (
  session: RunSession,
  entry: RunEntry,
  action: { tool: string; detail: string },
) => {
  const stamped = { at: new Date().toISOString(), ...action }
  entry.actions = entry.actions ?? []
  entry.actions.push(stamped)
  if (entry.actions.length > MAX_ACTIONS_PER_ENTRY) {
    entry.actions.splice(0, entry.actions.length - MAX_ACTIONS_PER_ENTRY)
  }
  emit(session.id, { type: 'entry', entry })
}

// Every run we can show — in-memory (live + recent) merged with the runs
// persisted on disk — so the cockpit survives even a full dev-server restart,
// not just a page reload. Capped to the most recent runs.
export const listSessions = async (): Promise<RunSession[]> => {
  const byId = new Map<string, RunSession>()
  try {
    const files = (await readdir(runsDir())).filter(f => f.endsWith('.json'))
    const loaded = await Promise.all(
      files.map(async f => {
        try {
          return JSON.parse(
            await readFile(join(runsDir(), f), 'utf8'),
          ) as RunSession
        } catch {
          return null
        }
      }),
    )
    for (const s of loaded) if (s) byId.set(s.id, s)
  } catch {}
  // In-memory wins — it carries live runs and the freshest state.
  sessions.forEach(s => byId.set(s.id, s))
  return Array.from(byId.values())
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(-25)
}

// Forget a finished run ("dismiss") — from memory and disk. A live run is kept.
const forget = (id: string) => {
  sessions.delete(id)
  cancelled.delete(id)
  // Clear cancel-press counters belonging to this session.
  for (const key of Array.from(cancelPress.keys())) {
    if (key.startsWith(`${id}:`)) cancelPress.delete(key)
  }
}

// Dismissing a run *moves* its JSON into runs-archive/ rather than deleting it.
// A misfired "dismiss all" once nuked a user's whole run history; archiving
// makes the operation recoverable. Real deletion is purgeArchivedRun() only.
//
// The archive filename suffixes the original id with the session's own
// finishedAt (when known) — purely from existing session data, never a fresh
// timestamp — so a re-dismiss of the same id can't clobber a prior archive.
const archiveRunFile = async (id: string, finishedAt?: string) => {
  await ensureRunsArchiveDir()
  const suffix = finishedAt ? `.${finishedAt.replace(/[:.]/g, '-')}` : ''
  const dest = join(runsArchiveDir(), `${id}${suffix}.json`)
  try {
    await rename(runFile(id), dest)
  } catch {
    // rename can fail if dest already exists (re-dismiss) or src is gone.
    // Fall back to an id-only name; if even that collides or the source is
    // already gone, swallow — the goal (run no longer in runs/) is met either
    // way and we must never throw out of a dismiss.
    try {
      await rename(runFile(id), join(runsArchiveDir(), `${id}.json`))
    } catch {}
  }
}

export const removeSession = async (id: string) => {
  const s = sessions.get(id)
  if (s && !s.finishedAt) return
  forget(id)
  // archiveRunFile names the archive `<id>.<finishedAt>.json` so the timestamp
  // survives the move. When the session isn't in-memory (disk-only) we'd
  // otherwise lose that suffix; recover finishedAt from the run file on disk
  // (best-effort — if it's unreadable/malformed we just fall back to id-only).
  let finishedAt = s?.finishedAt
  if (finishedAt === undefined) {
    try {
      const disk = JSON.parse(await readFile(runFile(id), 'utf8')) as RunSession
      finishedAt = disk.finishedAt
    } catch {}
  }
  await archiveRunFile(id, finishedAt)
}

export const clearFinishedSessions = async () => {
  const ids = new Map<string, string | undefined>()
  sessions.forEach(s => {
    if (s.finishedAt) ids.set(s.id, s.finishedAt)
  })
  try {
    for (const f of await readdir(runsDir())) {
      if (f.endsWith('.json')) {
        const id = f.replace(/\.json$/, '')
        if (!ids.has(id)) ids.set(id, undefined)
      }
    }
  } catch {}
  await Promise.all(
    Array.from(ids.entries()).map(async ([id, finishedAt]) => {
      forget(id)
      await archiveRunFile(id, finishedAt)
    }),
  )
}

// Explicit, irreversible deletion of archived run files — the only path that
// actually unlinks run JSON. Called by POST /api/run/purge; dismiss never
// reaches here. With no args it prunes archive entries older than the 30-day
// retention window (judged by file mtime). With ids it removes those entries.
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const purgeArchivedRuns = async (ids?: string[]) => {
  await ensureRunsArchiveDir()
  let files: string[]
  try {
    files = (await readdir(runsArchiveDir())).filter(f => f.endsWith('.json'))
  } catch {
    return
  }
  // ids-mode vs time-prune is decided by whether `ids` was *passed at all*,
  // not by whether it's non-empty. An explicit `ids: []` means "remove these
  // (none)" → no-op; it must NEVER fall through to the 30-day time prune and
  // wipe the whole archive. (Regression guard from the dismiss data-loss bug.)
  if (ids !== undefined) {
    if (ids.length === 0) return
    await Promise.all(
      files.map(async f => {
        const full = join(runsArchiveDir(), f)
        // An archive file is `<id>` or `<id>.<finishedAt>` + `.json`.
        const base = f.replace(/\.json$/, '')
        const matches = ids.some(id => base === id || base.startsWith(`${id}.`))
        if (matches) await unlink(full).catch(() => {})
      }),
    )
    return
  }
  // No ids argument at all → time-based prune of stale archive entries.
  const cutoff = Date.now() - ARCHIVE_RETENTION_MS
  await Promise.all(
    files.map(async f => {
      const full = join(runsArchiveDir(), f)
      try {
        const { mtimeMs } = await stat(full)
        if (mtimeMs < cutoff) await unlink(full).catch(() => {})
      } catch {}
    }),
  )
}

// Keep memory bounded — retain every live run, drop the oldest finished ones.
const MAX_FINISHED_SESSIONS = 30
const pruneSessions = () => {
  const finished = Array.from(sessions.values())
    .filter(s => s.finishedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  for (let i = 0; i < finished.length - MAX_FINISHED_SESSIONS; i++) {
    forget(finished[i].id)
  }
}

// Bound the on-disk run history so the runs directory can't grow forever.
// Over-the-cap files are *archived* (moved to runs-archive/), not deleted —
// the archive's own 30-day prune (purgeArchivedRuns) is the only place run
// JSON is actually unlinked.
const MAX_RUN_FILES = 60
const pruneRunFiles = async () => {
  try {
    const files = (await readdir(runsDir())).filter(f => f.endsWith('.json'))
    if (files.length <= MAX_RUN_FILES) return
    const dated = await Promise.all(
      files.map(async f => ({
        f,
        t: (await stat(join(runsDir(), f))).mtimeMs,
      })),
    )
    dated.sort((a, b) => a.t - b.t)
    const stale = dated.slice(0, dated.length - MAX_RUN_FILES)
    await ensureRunsArchiveDir()
    await Promise.all(
      stale.map(({ f }) =>
        rename(join(runsDir(), f), join(runsArchiveDir(), f)).catch(() => {}),
      ),
    )
    // Opportunistically reap archive entries past the retention window.
    await purgeArchivedRuns()
  } catch {}
}

// Subscribe to the multiplexed stream — events for every session.
export const subscribeAll = (fn: GlobalListener) => {
  globalListeners.add(fn)
  return () => {
    globalListeners.delete(fn)
  }
}

// How long after a soft-cancel (Ctrl-C) a second press counts as "force kill"
// rather than a fresh soft-cancel attempt. Phase 7's double-press cancel UX.
const FORCE_KILL_WINDOW_MS = 3000

// Cancel semantics in the post-`-p` world: there are no child processes to
// SIGTERM. Cancel maps to PTY signals instead.
//  - Pending (queued) entries are simply marked cancelled — no PTY exists yet.
//  - Running entries get a Ctrl-C sent through their PTY on the first press
//    (graceful: Claude's TUI handles it as "stop generation, stay alive").
//  - A second press within FORCE_KILL_WINDOW_MS sends SIGHUP via node-pty,
//    closing the PTY and triggering the observer's exit handler.
export const cancelSession = (sessionId: string) => {
  cancelled.add(sessionId)
  const session = sessions.get(sessionId)
  if (!session) return
  const now = Date.now()
  for (const entry of session.entries) {
    if (entry.status === 'pending') {
      // No PTY exists yet — just flip state.
      entry.status = 'cancelled'
      entry.finishedAt = new Date().toISOString()
      emit(sessionId, { type: 'entry', entry })
      continue
    }
    if (entry.status !== 'running' || !entry.terminalId) continue

    // Orphan recovery: if the PTY is no longer in terminal.ts's session map
    // (it exited and was reaped after the 30s grace period, or the dev
    // server reloaded and lost the runner's exit-listener closure while the
    // terminal pool persisted), the run is stuck in 'running' forever
    // because the await never resolves. Cancel from this state means
    // "release me" — flip the entry directly. The observer detach is
    // best-effort; if it's already gone we just emit the new status.
    const live = getTerminal(entry.terminalId)
    if (!live || live.finishedAt) {
      entry.status = 'cancelled'
      entry.finishedAt = new Date().toISOString()
      const parsed = parseResult(entry.log)
      if (parsed) entry.parsedResult = parsed
      emit(sessionId, { type: 'entry', entry })
      cancelPress.delete(`${sessionId}:${entry.projectId}`)
      continue
    }

    const key = `${sessionId}:${entry.projectId}`
    const prev = cancelPress.get(key)
    if (prev && now - prev.lastAt < FORCE_KILL_WINDOW_MS) {
      // Second press within window — force-kill the PTY.
      try { forceKill(entry.terminalId) } catch {}
      cancelPress.delete(key)
      // Belt-and-suspenders: forceKill should trigger the PTY exit listener
      // which marks `entry.finishedAt` and emits 'done'. But on some bug
      // paths (claude already dead while node-pty still considers the PTY
      // open, or the exit listener's closure died across an HMR reload),
      // the listener never fires and the entry stays 'running' forever —
      // jamming the serial lock so no new runs can start. Wait a short
      // grace period, then flip the entry ourselves if it didn't move.
      const stuckEntry = entry
      setTimeout(() => {
        if (stuckEntry.status !== 'running' || stuckEntry.finishedAt) return
        stuckEntry.status = 'cancelled'
        stuckEntry.finishedAt = new Date().toISOString()
        const parsed = parseResult(stuckEntry.log)
        if (parsed) stuckEntry.parsedResult = parsed
        emit(sessionId, { type: 'entry', entry: stuckEntry })
        // Promote to session-level done so the UI fully releases too —
        // mirrors the bookkeeping inside sweepOrphanRuns.
        const s = sessions.get(sessionId)
        if (s && !s.finishedAt && s.entries.every(e => e.finishedAt)) {
          s.finishedAt = new Date().toISOString()
          emit(sessionId, { type: 'session', session: s })
          emit(sessionId, { type: 'done' })
        }
      }, 2000)
    } else {
      // First press — graceful interrupt.
      try { sendInterrupt(entry.terminalId) } catch {}
      cancelPress.set(key, { count: 1, lastAt: now })
    }
  }
}

export const startRun = (opts: StartRunOptions): RunSession => {
  // Pick up any Settings-panel change to the per-project cap for runs fired
  // from here on. Fire-and-forget: the gate getter reads the cached value, and
  // a one-tick-stale cap is harmless (it only affects the next acquire).
  void refreshRunGateCap()
  const id = randomUUID()
  const session: RunSession = {
    id,
    startedAt: new Date().toISOString(),
    entries: opts.items.map(it => ({
      projectId: it.projectId,
      projectName: it.projectName,
      projectPath: it.projectPath,
      status: 'pending' as const,
      log: '',
      targetedTasks: it.targetedTasks,
      agentSessionId: it.agentSessionId,
      autoRound: it.autoRound,
      feedback: it.feedback,
    })),
  }
  // Stamp the entry with its permission mode so the UI can show it after the
  // fact (e.g. distinguish a plan-mode round from a normal one in the chat).
  session.entries.forEach((e, i) => {
    const it = opts.items[i]
    if (it.permissionMode) e.permissionMode = it.permissionMode
    if (it.resumeFallback) e.resumeFallback = true
    if (it.milestoneId) e.milestoneId = it.milestoneId
  })
  sessions.set(id, session)

  const queue = opts.items.slice()
  const concurrency = Math.max(1, Math.min(opts.concurrency, queue.length))

  // G1 crash resilience: a worker must never let an unexpected throw escape
  // into the Promise.all below — one bad item would reject the whole pool and,
  // because the pool runs in a fire-and-forget IIFE, surface as an
  // unhandledRejection that could take the Hono process down. runOne already
  // has its own try/finally, so reaching this catch means something truly
  // unforeseen (e.g. a sync throw before runOne's own guards). Record it on the
  // entry and keep the worker draining the rest of the queue.
  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) break
      const entry = session.entries.find(e => e.projectId === item.projectId)!
      try {
        await runOne(session, entry, item.prompt, item.resume, item.permissionMode ?? 'bypass', item.canvasContext)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[runner] worker: runOne threw unexpectedly', e)
        // A throw can reach here even AFTER runOne set entry.finishedAt — e.g.
        // runWorktreeMerge failing post-finalize. In that case the entry would
        // otherwise read "finished, status done, no reason" while the run
        // actually broke. So always surface the error: flip status to 'error',
        // set finishedAt if it wasn't already, and append the reason to the log
        // so the entry stays self-consistent (a finishedAt always has a cause).
        entry.status = 'error'
        if (!entry.finishedAt) entry.finishedAt = new Date().toISOString()
        appendLog(session, entry, `\n[runner] unexpected error: ${e instanceof Error ? e.message : String(e)}\n`)
        emit(session.id, { type: 'entry', entry })
      }
    }
  }

  // Fire-and-forget pool driver. Wrapped end-to-end in try/catch so neither a
  // worker rejection (defended above, but belt-and-suspenders) nor the
  // finalisation block (writeFile, emit) can become an unhandledRejection that
  // crashes the server or wedges other in-flight runs.
  ;(async () => {
    try {
      await Promise.all(Array.from({ length: concurrency }, worker))
      session.finishedAt = new Date().toISOString()
      try {
        await ensureRunsDir()
        await writeFile(runFile(id), JSON.stringify(session, null, 2), 'utf8')
      } catch {}
      emit(id, { type: 'session', session })
      emit(id, { type: 'done' })
      pruneSessions()
      pruneRunFiles()
    } catch (e) {
      // Last-resort guard — the session is left in whatever state the workers
      // reached. Mark it finished so the UI doesn't hang on "RUNNING" forever.
      // eslint-disable-next-line no-console
      console.error('[runner] startRun pool driver failed', e)
      try {
        if (!session.finishedAt) session.finishedAt = new Date().toISOString()
        emit(id, { type: 'session', session })
        emit(id, { type: 'done' })
      } catch {}
    }
  })()

  return session
}

// parseResult / looseParse / extractThought live in src/lib/parseResult.ts
// — pure helpers, no runner side effects, unit-tested in isolation. The
// re-exports below preserve the existing import surface for callers that
// pull these from `runner.ts`.
import { parseResult, extractThought } from '../parseResult'
export { parseResult, extractThought }

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

// Condense a tool_use input into one readable detail string.
const summarizeInput = (name: string, input: any): string => {
  if (!input || typeof input !== 'object') return ''
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return input.file_path
        ? String(input.file_path).split(/[/\\]/).slice(-2).join('/')
        : ''
    case 'Bash':
      return input.description
        ? String(input.description)
        : truncate(String(input.command ?? '').replace(/\s+/g, ' ').trim(), 80)
    case 'Glob':
    case 'Grep':
      return String(input.pattern ?? '')
    case 'Task':
      return String(input.description ?? '')
    default:
      return ''
  }
}

// Pull tool_use blocks out of one assistant event. The Chat UI uses these
// to render "Claude is currently editing src/auth.ts" / "Running npm test"
// status lines without the user having to open the raw terminal —
// answering the "what is it doing right now?" question that latestThought
// alone (which only surfaces text/thinking) doesn't.
export const extractActions = (
  obj: any,
): Array<{ tool: string; detail: string }> => {
  if (obj?.type !== 'assistant') return []
  const blocks = obj.message?.content
  if (!Array.isArray(blocks)) return []
  const out: Array<{ tool: string; detail: string }> = []
  for (const b of blocks) {
    if (b?.type === 'tool_use' && typeof b.name === 'string') {
      out.push({ tool: b.name, detail: summarizeInput(b.name, b.input) })
    }
  }
  return out
}

// Turn one stream-json NDJSON event into a human-readable progress line
// (newline-terminated), or null if it should not be shown.
export const formatEvent = (obj: any): string | null => {
  switch (obj?.type) {
    case 'system':
      return obj.subtype === 'init'
        ? `▶ session started${obj.model ? ` · ${obj.model}` : ''}\n`
        : null
    case 'assistant': {
      const blocks = obj.message?.content
      if (!Array.isArray(blocks)) return null
      let out = ''
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out += b.text.replace(/\s+$/, '') + '\n'
        } else if (b?.type === 'tool_use') {
          const detail = summarizeInput(b.name, b.input)
          out += `🔧 ${b.name}${detail ? ` ${detail}` : ''}\n`
        }
      }
      return out || null
    }
    case 'user': {
      const blocks = obj.message?.content
      if (!Array.isArray(blocks)) return null
      let out = ''
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue
        let content: any = b.content
        if (Array.isArray(content)) {
          content = content
            .filter((c: any) => c?.type === 'text')
            .map((c: any) => c.text)
            .join(' ')
        }
        const text = truncate(String(content ?? '').replace(/\s+/g, ' ').trim(), 120)
        out += `   ↳ ${b.is_error ? 'error' : 'ok'}${text ? `: ${text}` : ''}\n`
      }
      return out || null
    }
    // Note: `claude -p --output-format stream-json` emits a `result` event at
    // the end. Interactive claude (the post-2026-06-15 path) does NOT, so we
    // no longer surface it. PTY exit is the canonical "run finished" signal.
    default:
      return null
  }
}

const captureGitBefore = async (cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd })
    return stdout.trim()
  } catch {
    return null
  }
}

const captureGitAfter = async (
  cwd: string,
  headBefore: string | null,
): Promise<RunGitInfo> => {
  const info: RunGitInfo = {
    headBefore,
    headAfter: null,
    changedFiles: [],
    diffStat: '',
    commits: [],
  }
  try {
    const head = await execFile('git', ['rev-parse', 'HEAD'], { cwd })
    info.headAfter = head.stdout.trim()
  } catch {
    return info
  }
  try {
    const status = await execFile('git', ['status', '--porcelain'], { cwd })
    info.changedFiles = status.stdout
      .split('\n')
      .filter(Boolean)
      .map(l => l.slice(3))
  } catch {}
  if (headBefore && info.headAfter && headBefore !== info.headAfter) {
    try {
      const diff = await execFile('git', ['diff', '--stat', headBefore, info.headAfter], { cwd })
      info.diffStat = diff.stdout.trim()
    } catch {}
    try {
      const log = await execFile('git', ['log', '--oneline', `${headBefore}..${info.headAfter}`], { cwd })
      info.commits = log.stdout.split('\n').filter(Boolean)
    } catch {}
  }
  return info
}

// Orphaned serial lock (no-git projects) self-clears past this.
const PROJECT_LOCK_TIMEOUT_MS = 20 * 60 * 1000

// Run a worktree merge: commit any uncommitted work, queue the merge so only
// one project merges at a time, then relocate the Claude session file from
// the worktree's ~/.claude/projects/ dir to the main project's. Extracted
// from the old runOne so the merge logic stays in one place — both happy-
// path runs and Phase 6's conflict-resolve runs share it.
const runWorktreeMerge = async (
  session: RunSession,
  entry: RunEntry,
  worktreeInfo: WorktreeInfo,
  effectiveCwd: string,
) => {
  const taskTitle = entry.targetedTasks[0]?.title ?? 'OPEN GROUND task'
  await autoCommitIfDirty(effectiveCwd, taskTitle)

  const prevMerge = mergeQueues.get(entry.projectId) ?? Promise.resolve()
  const myMerge = prevMerge.then(async () => {
    entry.mergeStatus = 'merging'
    emit(session.id, { type: 'entry', entry })
    const result = await mergeAndCleanup(entry.projectPath, worktreeInfo)
    entry.mergeStatus = result
    if (result === 'conflict') {
      appendLog(
        session,
        entry,
        `\n[merge conflict] Changes remain in: ${worktreeInfo.worktreePath}\n`,
      )
    }
    if (result === 'merged' && entry.agentSessionId) {
      await relocateWorktreeSession(
        entry.projectPath,
        worktreeInfo.worktreePath,
        entry.agentSessionId,
      ).catch(() => {})
    }
    emit(session.id, { type: 'entry', entry })
  })
  mergeQueues.set(entry.projectId, myMerge)
  await myMerge
}

// Single-task run lifecycle in the post-`claude -p` world. Instead of
// spawning claude headless and parsing its stdout, runOne launches an
// interactive claude in a PTY (hosted by OPEN GROUND, drawn as xterm.js in
// the UI). The observer engine tails the resulting JSONL into entry.log /
// entry.thoughts in real-time, and PTY exit is the canonical "this run is
// over" signal. Why: post-2026-06-15, `-p` is metered against a separate
// programmatic credit pool; interactive (TTY) usage stays on the user's
// subscription rate-limit pool.
const runOne = async (
  session: RunSession,
  entry: RunEntry,
  prompt: string,
  resume: boolean,
  permissionMode: PermissionMode,
  canvasContext?: CanvasContext,
) => {
  // Emit immediately so the pending row appears in the UI without waiting.
  emit(session.id, { type: 'entry', entry })

  // Increment synchronously (before any await) so the per-project active-run
  // accounting stays correct under concurrency. (The worktree decision no
  // longer reads this count — Approach A branches every non-resume run — but
  // activeCount still gates the milestone re-kick "clean slate" check and the
  // orphan watchdog / projectLocks release, so the bookkeeping must stay.)
  const count = (activeCount.get(entry.projectId) ?? 0) + 1
  activeCount.set(entry.projectId, count)

  const isPlanMode = permissionMode === 'plan'

  let worktreeInfo: WorktreeInfo | null = null
  let effectiveCwd = entry.projectPath
  let releaseLock: () => void = () => {}
  let myChain: Promise<void> | null = null
  // Released in the `finally` for runs that took a gate slot. No-op otherwise
  // (plan / resume / no-git runs never enter the bounded-parallel gate).
  let releaseGate: () => void = () => {}

  if (isPlanMode) {
    // Plan mode is read-only — let N plan runs share the project directory
    // concurrently. Planning shouldn't gate edit work.
  } else {
    const gitAvailable = await hasGit(entry.projectPath)
    // Approach A — branch every run. EVERY non-resume run on a git project
    // now gets its own worktree+branch, not just when the project is already
    // busy (the old `count > 1` gate) or when it's a milestone run. The run
    // executes in the worktree and merges back via the existing serialized
    // merge queue (runWorktreeMerge → mergeAndCleanup) once it finishes
    // cleanly; conflicts are classified and surfaced exactly as before. This
    // keeps the live project working tree pristine during a run and means a
    // run's edits land in main only after the post-run merge.
    //
    // Three cases deliberately stay on the in-tree (serial-lock) path:
    //  - resume runs: Claude's session JSONL lives at the cwd the session was
    //    started from; relocating it is the merge step's job, not a "spin up
    //    another worktree" job. Resuming from a fresh empty worktree would
    //    also lose the conversation's working state.
    //  - plan mode: read-only, handled in the `isPlanMode` branch above —
    //    N plan runs share the dir concurrently.
    //  - no-git projects (`!gitAvailable`): nothing to branch; fall through
    //    to the serial projectLocks gate below.
    // Milestone-bound runs are subsumed by "every non-resume run branches"
    // — their verifyCommands (`npm run build` / `npm run lint`) still get an
    // isolated `.next/` for free, as before.
    const wantWorktree = gitAvailable && !resume

    if (wantWorktree) {
      // Bounded same-project parallelism: acquire a per-project slot BEFORE
      // spinning up the worktree/PTY. Up to the cap run concurrently; the rest
      // park here (FIFO) and proceed as earlier runs free their slot. This is
      // the only thing serializing overlapping same-project worktree runs —
      // and only past the cap. A cancel while parked is honoured below (the
      // `cancelled.has` guard in the try-block) right after the slot frees.
      releaseGate = await runGate.acquire(entry.projectId)
      // Expose the slot's release to the watchdog so an orphaned run frees it.
      entryGateRelease.set(entry, releaseGate)
      try {
        const id = `${Date.now()}-${randomUUID().slice(0, 8)}`
        worktreeInfo = await createWorktree(entry.projectPath, id)
        effectiveCwd = worktreeInfo.worktreePath
        entry.worktreePath = worktreeInfo.worktreePath
        emit(session.id, { type: 'entry', entry })
      } catch (e: any) {
        appendLog(session, entry, `[worktree] Creation failed, falling back to serial: ${e?.message ?? e}\n`)
        worktreeInfo = null
        // Worktree creation failed — we're dropping to the serial projectLocks
        // path below, which doesn't use the gate. Free the slot now so it
        // doesn't stay held for the whole serial run (that would shrink the
        // effective cap for sibling worktree runs).
        try { releaseGate() } catch {}
        releaseGate = () => {}
        entryGateRelease.delete(entry)
      }
    }

    if (!worktreeInfo) {
      const prevLock = projectLocks.get(entry.projectId) ?? Promise.resolve()
      const myLock = new Promise<void>(res => { releaseLock = res })
      const gate = Promise.race([
        prevLock,
        new Promise<void>(res => setTimeout(res, PROJECT_LOCK_TIMEOUT_MS)),
      ])
      myChain = gate.then(() => myLock)
      projectLocks.set(entry.projectId, myChain)
      await gate
    }
  }

  try {
    // Cancelled while still queued — never launch.
    if (cancelled.has(session.id)) {
      entry.status = 'cancelled'
      entry.finishedAt = new Date().toISOString()
      emit(session.id, { type: 'entry', entry })
      if (worktreeInfo) {
        await removeWorktree(entry.projectPath, worktreeInfo).catch(() => {})
      }
      return
    }

    entry.status = 'running'
    entry.startedAt = new Date().toISOString()
    entry.git = { headBefore: null, headAfter: null, changedFiles: [], diffStat: '', commits: [] }
    emit(session.id, { type: 'entry', entry })

    const headBefore = await captureGitBefore(effectiveCwd)
    entry.git.headBefore = headBefore

    // Defensive: /api/run normally assigns a session id, but a missing one
    // would silently break observer attachment so we backfill.
    if (!entry.agentSessionId) entry.agentSessionId = randomUUID()
    const agentSessionId = entry.agentSessionId

    let terminalRef
    try {
      terminalRef = launchClaude({
        cwd: effectiveCwd,
        agentSessionId,
        initialPrompt: prompt,
        permissionMode: permissionMode === 'plan' ? 'plan' : 'bypass',
        resume,
      })
    } catch (e: any) {
      entry.status = 'error'
      appendLog(session, entry, `Failed to launch claude PTY: ${e?.message ?? e}\n`)
      entry.finishedAt = new Date().toISOString()
      emit(session.id, { type: 'entry', entry })
      if (worktreeInfo) {
        await removeWorktree(entry.projectPath, worktreeInfo).catch(() => {})
      }
      return
    }

    entry.terminalId = terminalRef.terminalId
    emit(session.id, { type: 'entry', entry })

    // Close the race in cancelSession: status flips to 'running' BEFORE we
    // can store terminalId (captureGitBefore awaits between the two), so a
    // cancel arriving in that window silently no-ops. We catch it here, on
    // the first synchronous tick after launchClaude returns, by killing
    // the PTY we just created — the await below will see the exit and run
    // the normal cancelled-status finalisation.
    if (cancelled.has(session.id)) {
      try { forceKill(terminalRef.terminalId) } catch {}
    }

    // Observer mirrors JSONL events into entry.log / entry.thoughts and
    // stamps entry.parsedResult on OPENGROUND_RESULT. On taskComplete:true
    // we auto-/quit the PTY so the run finishes without the user having to
    // operate the embedded terminal — same UX as the old `claude -p` path
    // that exited automatically on completion. Question turns
    // (taskComplete:false) do NOT auto-quit; the user answers in the
    // embedded terminal and Claude continues the conversation.
    const detachObserver = observerAttach({
      agentSessionId,
      session,
      entry,
      effectiveCwd,
      canvasContext,
      projectPath: entry.projectPath,
      onComplete: () => {
        try { seedPrompt(terminalRef!.terminalId, '/quit') } catch {}
        // Stop-hook hang safety: claude's user-configurable Stop hooks
        // (~/.claude/settings.json) sometimes never return — afplay
        // blocking on coreaudiod, the openground-hook stdin read
        // stalling, etc — and claude's TUI shows "running stop hooks…
        // 0/N" indefinitely, swallowing the /quit we just seeded.
        // Without this fallback the PTY stays open, runOne's await
        // never resolves, and the entry sits as 'running' forever.
        // 15s is well past a healthy hook (<2s for our two) but well
        // below the user's patience threshold for "is it done yet?".
        setTimeout(() => {
          const t = getTerminal(terminalRef!.terminalId)
          if (t && !t.finishedAt) {
            try { forceKill(terminalRef!.terminalId) } catch {}
          }
        }, 15_000)
      },
    })

    // Wait for the PTY to exit (claude /quit, Ctrl-D, force-kill, etc.).
    // PTY exit is the canonical run-completion signal.
    await new Promise<void>((resolve) => {
      const sub = subscribeTerminal(
        terminalRef!.terminalId,
        () => {}, // raw bytes go to xterm.js via /api/terminal/<id>/stream
        () => {
          // Force a final JSONL drain in case OPENGROUND_RESULT arrived in
          // the same batch as the PTY exit and fs.watch coalesced.
          try { observerNudge(agentSessionId) } catch {}
          // Drop any pending cancel-press counter for this entry — the run
          // is settling, and leaving a stale timestamp in the map could
          // mis-classify a future cancel on a re-used (sessionId, projectId)
          // pair as a "second press → force-kill".
          cancelPress.delete(`${session.id}:${entry.projectId}`)
          resolve()
        },
      )
      // PTY might have exited between launchClaude and subscribe (the
      // launch-window forceKill above can fire a kill that wins this race
      // on slow machines). subscribeTerminal would have added our listener
      // to the set, but the onExit broadcast loop has already iterated —
      // our listener would never fire. Detect via finishedAt and resolve
      // immediately.
      if (!sub || sub.info.finishedAt) resolve()
    })

    try { detachObserver() } catch {}

    // Compute the final state from what observer + the post-exit drain saw.
    try {
      entry.git = await captureGitAfter(effectiveCwd, headBefore)
    } catch {}
    const finalParse = parseResult(entry.log)
    if (finalParse) entry.parsedResult = finalParse

    if (entry.parsedResult?.taskComplete === true) {
      entry.exitCode = 0
      entry.status = 'done'
    } else if (entry.parsedResult) {
      // Claude emitted an OPENGROUND_RESULT but didn't mark taskComplete —
      // partial work reported. Surface as done so the summary still shows.
      entry.exitCode = 0
      entry.status = 'done'
    } else if (cancelled.has(session.id)) {
      entry.status = 'cancelled'
    } else {
      // PTY closed without any OPENGROUND_RESULT — user /quit before
      // finishing, or claude crashed. We can't distinguish reliably; call
      // it cancelled, which is accurate for the common case (user /quit).
      entry.status = 'cancelled'
    }
    if (!entry.finishedAt) entry.finishedAt = new Date().toISOString()
    emit(session.id, { type: 'entry', entry })

    // Phase 6.D — auto-verify for milestone-bound runs.
    //
    // When Claude reports the round done (taskComplete=true) AND this run
    // was kicked off to advance a Milestone, run the milestone's
    // verifyCommands inside the *worktree* (so a buggy verify can't ruin
    // main). The verify result becomes the source of truth for the
    // auto-loop: pass → merge proceeds, fail → main is left alone and the
    // loop retries with the failure output fed back into Claude.
    if (
      entry.status === 'done' &&
      entry.milestoneId &&
      entry.parsedResult?.taskComplete === true
    ) {
      try {
        const { runVerifyCommands } = await import('./verifier')
        const pdata = await readProjectData(entry.projectPath)
        const mile = pdata.milestones.find(m => m.id === entry.milestoneId)
        const cmds = (mile?.verifyCommands ?? []).filter(
          c => typeof c === 'string' && c.trim(),
        )
        if (mile && cmds.length > 0) {
          // Verify against the worktree if we have one — that's the state
          // Claude actually produced. Falls back to the main project root
          // when running serial (no worktree).
          const verifyCwd = worktreeInfo?.worktreePath ?? entry.projectPath
          appendLog(
            session,
            entry,
            `\n[verify] running ${cmds.length} command(s) for milestone "${mile.name}"…\n`,
          )
          const v = await runVerifyCommands(verifyCwd, mile.id, cmds)
          const retryCount = entry.autoRound ?? 1
          entry.verifiedTaskComplete = {
            passed: v.passed,
            commands: v.commands,
            outputs: v.outputs,
            finishedAt: v.finishedAt,
            retryCount,
          }
          appendLog(
            session,
            entry,
            v.passed
              ? `[verify] ✓ all ${cmds.length} command(s) passed (${v.durationMs}ms)\n`
              : `[verify] ✗ failed (${v.durationMs}ms). Latest output:\n${(v.outputs.slice(-1)[0] ?? '').split('\n').slice(-12).join('\n')}\n`,
          )
          // Persist milestone state. Re-read first so a concurrent edit on
          // the project's tasks.json doesn't get clobbered.
          const fresh = await readProjectData(entry.projectPath)
          const idx = fresh.milestones.findIndex(m => m.id === entry.milestoneId)
          if (idx >= 0) {
            const cur = fresh.milestones[idx]
            fresh.milestones[idx] = {
              ...cur,
              status: v.passed ? 'verified' : 'failed',
              ...(v.passed ? { verifiedAt: v.finishedAt } : {}),
              lastVerify: {
                passed: v.passed,
                commands: v.commands,
                outputs: v.outputs,
                finishedAt: v.finishedAt,
                retryCount,
              },
              lastRunSessionId: session.id,
            }
            await writeProjectData(entry.projectPath, fresh)
          }
          emit(session.id, { type: 'entry', entry })
        }
      } catch (err) {
        appendLog(
          session,
          entry,
          `[verify] error: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    }

    if (worktreeInfo) {
      // Skip the merge when a milestone verify just failed — leaving main
      // untouched means the auto-loop's next round can keep iterating
      // safely. The worktree stays on disk; the retry resumes the same
      // Claude session inside it.
      const verifyBlocksMerge =
        entry.milestoneId &&
        entry.verifiedTaskComplete &&
        !entry.verifiedTaskComplete.passed
      if (entry.status === 'done' && !verifyBlocksMerge) {
        await runWorktreeMerge(session, entry, worktreeInfo, effectiveCwd)
      } else if (entry.status !== 'done') {
        await removeWorktree(entry.projectPath, worktreeInfo).catch(() => {})
      }
      // verifyBlocksMerge ケースは worktree を残す（次の auto-loop が同じ
      // worktree で resume するため）。merge も remove もしない。
    }

    // Phase 3 — persist the run's narrative onto its targeted tasks so the
    // card hero survives without re-deriving from full run sessions. The
    // transcript JSONL lives under the cwd Claude actually ran in: a clean
    // worktree merge relocates it to the main project dir (relocateWorktree
    // Session, run inside runWorktreeMerge), so the resume-correct cwd is the
    // main project path in that case; otherwise it's still the worktree.
    // Best-effort: never let persistence break the run lifecycle.
    try {
      const transcriptCwd =
        worktreeInfo && entry.mergeStatus === 'merged'
          ? entry.projectPath
          : effectiveCwd
      await persistTaskRunSummaries(entry, transcriptCwd)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[taskRunSummary] persist failed:', e)
    }
  } finally {
    // If the orphan watchdog already cancelled this entry, it has already
    // decremented activeCount and dropped the lock chain for this project;
    // a belated await-resolution here must not decrement a second time.
    if (watchdogReleased.has(entry)) {
      watchdogReleased.delete(entry)
    } else {
      const remaining = Math.max(0, (activeCount.get(entry.projectId) ?? 1) - 1)
      if (remaining === 0) activeCount.delete(entry.projectId)
      else activeCount.set(entry.projectId, remaining)
    }

    // Free the bounded-parallel slot so a queued same-project run can start.
    // Held through the post-run merge above (the merge is itself serialized by
    // mergeQueues, so a slot held during it just defers the next worktree run
    // slightly — conservative and correct). makeRelease is double-release-safe,
    // so the watchdog path releasing it too (releaseActiveSlot) is fine.
    entryGateRelease.delete(entry)
    try { releaseGate() } catch {}

    releaseLock()
    if (myChain && projectLocks.get(entry.projectId) === myChain) {
      projectLocks.delete(entry.projectId)
    }

    // Phase 7 — server-side run queue advance.
    //
    // Done AFTER the lock release / activeCount decrement so the next
    // milestone kick sees a clean slate (count back to 0 → serial-lock
    // path, not worktree-parallel) and doesn't queue behind our own lock.
    // The whole block is best-effort: any error here must not propagate
    // out of runOne because it'd be uncatchable from the caller's
    // perspective (runOne is awaited inside the worker pool).
    try {
      await advanceRunQueueIfNeeded(entry)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[runQueue] advance failed:', e)
    }
  }
}

// Phase 7 — read the goal's runQueue, record what this milestone-bound
// entry produced, and kick the next milestone if the queue is still live.
// No-op for entries that aren't part of a queue.
//
// Race notes:
//  - We re-read tasks.json instead of trusting any in-memory cache because
//    the auto-verify block already wrote `milestone.status` between the
//    runOne start and here.
//  - If the user paused the queue while the milestone was in flight
//    (status === 'paused'), we still record the result on the placeholder
//    session entry but do NOT kick the next one. Resume picks it up.
//  - currentIndex is advanced only on verify-pass; verify-fail / cancel
//    parks the queue in 'failed' so the user can fix-then-resume.
const advanceRunQueueIfNeeded = async (entry: RunEntry): Promise<void> => {
  if (!entry.milestoneId) return
  const data = await readProjectData(entry.projectPath)
  const goal = (data.goals ?? []).find(g =>
    data.milestones.some(
      m => m.id === entry.milestoneId && m.goalId === g.id,
    ),
  )
  if (!goal?.runQueue) return
  const queue = goal.runQueue
  const cursorMid = queue.milestoneIds[queue.currentIndex]
  if (cursorMid !== entry.milestoneId) return // not the queue's current run

  // Classify the outcome.
  const verifyPassed = entry.verifiedTaskComplete?.passed === true
  const verifyFailed = entry.verifiedTaskComplete?.passed === false
  let outcome: 'verified' | 'failed' | 'cancelled'
  if (verifyPassed) outcome = 'verified'
  else if (verifyFailed) outcome = 'failed'
  else if (entry.status === 'cancelled' || entry.status === 'error') outcome = 'cancelled'
  else outcome = 'failed' // status=done but no verify (e.g. no verifyCommands) — treat as needing review

  // Record the outcome on the placeholder session slot.
  queue.sessions = queue.sessions ?? []
  const lastSession = queue.sessions[queue.sessions.length - 1]
  if (lastSession && lastSession.milestoneId === entry.milestoneId && !lastSession.finishedAt) {
    lastSession.result = outcome
    lastSession.finishedAt = entry.finishedAt ?? new Date().toISOString()
  } else {
    // No matching placeholder — append (covers manual-kick-then-queue cases).
    queue.sessions.push({
      milestoneId: entry.milestoneId,
      sessionId: '', // unknown at this scope; ok to leave blank
      result: outcome,
      finishedAt: entry.finishedAt ?? new Date().toISOString(),
    })
  }
  queue.lastActivityAt = new Date().toISOString()

  // If the user paused mid-run, stop here — just persist the result.
  // The 'paused' branch is sticky: resume() flips back to 'running'.
  if (queue.status === 'paused') {
    await writeProjectData(entry.projectPath, data)
    return
  }

  if (outcome !== 'verified') {
    queue.status = 'failed'
    await writeProjectData(entry.projectPath, data)
    return
  }

  // Advance.
  queue.currentIndex += 1
  if (queue.currentIndex >= queue.milestoneIds.length) {
    queue.status = 'completed'
    await writeProjectData(entry.projectPath, data)
    return
  }

  // Kick the next milestone. Use a dynamic import to break the
  // milestoneRunner ↔ runner circular dep (milestoneRunner imports
  // startRun from this file).
  const nextMid = queue.milestoneIds[queue.currentIndex]
  const nextMilestone = data.milestones.find(m => m.id === nextMid)
  if (!nextMilestone) {
    queue.status = 'failed'
    await writeProjectData(entry.projectPath, data)
    return
  }

  // Persist BEFORE the kick so a crash between write and startRun leaves
  // a sane "next milestone awaiting kick" state for the startup sweep.
  await writeProjectData(entry.projectPath, data)

  const { kickMilestoneRun } = await import('./milestoneRunner')
  const session = kickMilestoneRun({
    projectPath: entry.projectPath,
    milestone: nextMilestone,
    goal,
    projectId: entry.projectId,
    projectName: entry.projectName,
  })

  // Append the new in-flight session placeholder.
  const fresh = await readProjectData(entry.projectPath)
  const freshGoal = (fresh.goals ?? []).find(g => g.id === goal.id)
  if (freshGoal?.runQueue) {
    freshGoal.runQueue.sessions = freshGoal.runQueue.sessions ?? []
    freshGoal.runQueue.sessions.push({
      milestoneId: nextMilestone.id,
      sessionId: session.id,
      result: 'cancelled',
      finishedAt: '',
    })
    freshGoal.runQueue.lastActivityAt = new Date().toISOString()
    await writeProjectData(entry.projectPath, fresh)
  }
}

// Claude stores sessions under ~/.claude/projects/<cwd-as-hyphenated-path>/.
// When a task ran in a worktree, the session lands under the worktree's
// derived path. After the worktree is merged and deleted, --resume from the
// main project dir won't find it. Move the JSONL file so it lives under the
// main project's session dir instead.
// Hyphenate a cwd into the form Claude Code uses for its ~/.claude/projects/
// directory names. Shared with the observer via claudeProjectDir.ts so the
// POSIX/Windows scheme stays in one place.
const toClaudeDirName = claudeDirName

const relocateWorktreeSession = async (
  projectPath: string,
  worktreePath: string,
  sessionId: string,
): Promise<void> => {
  const claudeProjects = join(homedir(), '.claude', 'projects')
  const srcDir = join(claudeProjects, toClaudeDirName(worktreePath))
  const dstDir = join(claudeProjects, toClaudeDirName(projectPath))
  const srcFile = join(srcDir, `${sessionId}.jsonl`)
  // Check source exists before attempting the move.
  await stat(srcFile)
  await mkdir(dstDir, { recursive: true })
  const dstFile = join(dstDir, `${sessionId}.jsonl`)
  await rename(srcFile, dstFile)
}

// Pre-flight check before resuming a Claude session by id. Returns true when
// `claude --resume <id>` from `projectPath` will find the JSONL file.
//
// Claude indexes sessions by the cwd at the time the session was created
// (hyphenated). When a previous round ran in a worktree, the file lives under
// that worktree's path and a resume from the main project dir fails with
// "No conversation found with session ID". This commonly happens after a
// merge conflict, because we only relocate the file on a clean merge.
//
// To make resumes from chat threads "just work" we silently move the JSONL
// from the worktree's claude-projects dir to the main project's before the
// run starts. Failure to locate the file anywhere returns false so the API
// route can fall back to a fresh run instead of letting the user see the
// "[再開できません]" stderr surfacing.
export const ensureSessionResumable = async (
  projectPath: string,
  sessionId: string,
): Promise<boolean> => {
  const claudeProjects = join(homedir(), '.claude', 'projects')
  const mainPath = join(claudeProjects, toClaudeDirName(projectPath), `${sessionId}.jsonl`)
  try {
    await stat(mainPath)
    return true
  } catch {}
  // Scan in-memory sessions for the entry that originally created this id —
  // its `worktreePath` tells us exactly where Claude wrote the JSONL.
  for (const s of Array.from(sessions.values())) {
    for (const e of s.entries) {
      if (e.agentSessionId === sessionId && e.worktreePath) {
        await relocateWorktreeSession(projectPath, e.worktreePath, sessionId).catch(() => {})
        try {
          await stat(mainPath)
          return true
        } catch {}
      }
    }
  }
  return false
}

// Mark a merge conflict as resolved by the user — without spawning Claude or
// rerunning the merge. Used when the user has fixed things manually (or
// considers the diverged worktree acceptable) and just wants OPEN GROUND to
// stop nagging. We clear `mergeStatus` on every entry that shares this worktree
// (the original conflicting run AND any earlier failed resolve attempts), try
// to move the Claude session file to the main project so future resumes in
// the same chat can still pick up the conversation, and best-effort remove
// the worktree itself so the canvas doesn't leak `.openground/worktrees/<id>`.
export const dismissConflict = async (
  sessionId: string,
  projectId: string,
): Promise<RunSession | null> => {
  let session = sessions.get(sessionId)
  if (!session) {
    try {
      const raw = await readFile(runFile(sessionId), 'utf8')
      session = JSON.parse(raw) as RunSession
      sessions.set(sessionId, session)
    } catch {
      return null
    }
  }
  const entry = session.entries.find(e => e.projectId === projectId)
  if (!entry) return null
  if (entry.mergeStatus !== 'conflict') return session
  const worktreePath = entry.worktreePath
  const projectPath = entry.projectPath

  // Relocate first so a successful move outlives a failed `worktree remove`.
  if (worktreePath && entry.agentSessionId) {
    await relocateWorktreeSession(projectPath, worktreePath, entry.agentSessionId).catch(() => {})
  }
  if (worktreePath) {
    const worktreeId = basename(worktreePath)
    await removeWorktree(projectPath, { worktreePath, branch: `openground/${worktreeId}` }).catch(
      () => {},
    )
  }

  // Clear conflict state on every in-memory entry that points to the same
  // worktree — the user dismissed the whole resolution lineage, not just one row.
  const touched = new Set<RunSession>()
  const clear = (e: RunEntry, s: RunSession) => {
    if (e.mergeStatus === 'conflict') {
      e.mergeStatus = 'merged'
      touched.add(s)
    }
  }
  for (const s of Array.from(sessions.values())) {
    for (const e of s.entries) {
      if (e.projectId === projectId && (e === entry || (worktreePath && e.worktreePath === worktreePath))) {
        clear(e, s)
      }
    }
  }
  // Always mark the requested entry, even if no worktree was tracked.
  clear(entry, session)

  // Persist each touched session and notify SSE listeners.
  for (const s of Array.from(touched)) {
    try {
      await ensureRunsDir()
      await writeFile(runFile(s.id), JSON.stringify(s, null, 2), 'utf8')
    } catch {}
    for (const e of s.entries) {
      if (e.projectId === projectId) emit(s.id, { type: 'entry', entry: e })
    }
  }
  return session
}

// Resolve a merge conflict by spawning Claude in the worktree to fix conflicts,
// then retrying the merge. Returns the new RunSession for the resolve run, or
// null if the session/entry is not found or not in a conflict state.
export const resolveConflict = async (sessionId: string, projectId: string): Promise<RunSession | null> => {
  // Check memory first; fall back to disk so this works after a server restart.
  let origSession = sessions.get(sessionId)
  if (!origSession) {
    try {
      const raw = await readFile(runFile(sessionId), 'utf8')
      origSession = JSON.parse(raw) as RunSession
      // Bring it into memory so subsequent emits reach SSE listeners.
      sessions.set(sessionId, origSession)
    } catch {
      return null
    }
  }
  const origEntry = origSession.entries.find(e => e.projectId === projectId)
  if (!origEntry || origEntry.mergeStatus !== 'conflict' || !origEntry.worktreePath) return null

  const worktreePath = origEntry.worktreePath
  // Branch name is encoded in the last path segment:
  //   .openground/worktrees/<id> → openground/<id>
  // (Legacy `hove/<id>` runs created before the rename still exist as branches
  // on disk; the dismiss / resolve paths can't reach them by branch name now,
  // but `worktree remove --force` still cleans them up via the path, so this
  // is only a "branch -D fails silently" annoyance on those old worktrees.)
  const worktreeId = basename(worktreePath)
  const worktreeInfo: WorktreeInfo = { worktreePath, branch: `openground/${worktreeId}` }
  const taskTitle = origEntry.targetedTasks[0]?.title ?? 'task'

  const resolvePrompt = [
    `チャット「${taskTitle}」の変更をメインブランチにマージしようとしましたが、コンフリクトが発生しました。`,
    ``,
    `現在このworktreeディレクトリにいます。以下を実行してください：`,
    `1. \`git merge main\` でメインブランチの最新変更を取り込む`,
    `2. \`git status\` でコンフリクトしているファイルを確認する`,
    `3. 各コンフリクトを解消する（両方の変更の意図を理解し、矛盾なく統合する）`,
    `4. \`git add -A && git commit\` でコミットする`,
    ``,
    `完了後に必ず以下の形式で結果を報告してください：`,
    `OPENGROUND_RESULT: {"completed":["コンフリクトを解消してコミット"],"skipped":[],"summary":"マージコンフリクトを解消しました","blockers":"","taskComplete":true}`,
  ].join('\n')

  const resolveId = randomUUID()
  const resolveAgentSessionId = randomUUID()
  const resolveEntry: RunEntry = {
    projectId: origEntry.projectId,
    projectName: origEntry.projectName,
    projectPath: origEntry.projectPath,
    status: 'pending',
    log: '',
    targetedTasks: origEntry.targetedTasks,
    agentSessionId: resolveAgentSessionId,
    feedback: 'コンフリクト解消',
    worktreePath,
  }
  const resolveSession: RunSession = {
    id: resolveId,
    startedAt: new Date().toISOString(),
    entries: [resolveEntry],
  }
  sessions.set(resolveId, resolveSession)
  emit(resolveId, { type: 'session', session: resolveSession })

  ;(async () => {
    // Launch claude interactively inside the conflicting worktree. The
    // resolve prompt asks claude to merge main, fix conflicts, commit, and
    // emit OPENGROUND_RESULT.taskComplete:true. Observer mirrors the JSONL
    // into resolveEntry.log / .thoughts as before.
    resolveEntry.status = 'running'
    resolveEntry.startedAt = new Date().toISOString()
    emit(resolveId, { type: 'entry', entry: resolveEntry })

    let terminalRef
    try {
      terminalRef = launchClaude({
        cwd: worktreePath,
        agentSessionId: resolveAgentSessionId,
        initialPrompt: resolvePrompt,
        permissionMode: 'bypass',
        resume: false,
      })
    } catch (e: any) {
      resolveEntry.status = 'error'
      appendLog(resolveSession, resolveEntry, `Failed to launch claude PTY: ${e?.message ?? e}\n`)
      resolveEntry.finishedAt = new Date().toISOString()
      emit(resolveId, { type: 'entry', entry: resolveEntry })
      resolveSession.finishedAt = new Date().toISOString()
      try {
        await ensureRunsDir()
        await writeFile(runFile(resolveId), JSON.stringify(resolveSession, null, 2), 'utf8')
      } catch {}
      emit(resolveId, { type: 'done' })
      return
    }
    resolveEntry.terminalId = terminalRef.terminalId
    emit(resolveId, { type: 'entry', entry: resolveEntry })

    // Same launch-window cancel race as runOne: if cancel was registered
    // while we were spinning up the PTY, force-kill it now so the await
    // below sees the exit and the normal cancelled-status path runs.
    if (cancelled.has(resolveId)) {
      try { forceKill(terminalRef.terminalId) } catch {}
    }

    const detachObserver = observerAttach({
      agentSessionId: resolveAgentSessionId,
      session: resolveSession,
      entry: resolveEntry,
      effectiveCwd: worktreePath,
      mode: 'conflict-resolve',
      onComplete: () => {
        try { seedPrompt(terminalRef!.terminalId, '/quit') } catch {}
        // Stop-hook hang safety: claude's user-configurable Stop hooks
        // (~/.claude/settings.json) sometimes never return — afplay
        // blocking on coreaudiod, the openground-hook stdin read
        // stalling, etc — and claude's TUI shows "running stop hooks…
        // 0/N" indefinitely, swallowing the /quit we just seeded.
        // Without this fallback the PTY stays open, runOne's await
        // never resolves, and the entry sits as 'running' forever.
        // 15s is well past a healthy hook (<2s for our two) but well
        // below the user's patience threshold for "is it done yet?".
        setTimeout(() => {
          const t = getTerminal(terminalRef!.terminalId)
          if (t && !t.finishedAt) {
            try { forceKill(terminalRef!.terminalId) } catch {}
          }
        }, 15_000)
      },
    })

    await new Promise<void>((resolve) => {
      const sub = subscribeTerminal(
        terminalRef!.terminalId,
        () => {},
        () => {
          try { observerNudge(resolveAgentSessionId) } catch {}
          cancelPress.delete(`${resolveId}:${resolveEntry.projectId}`)
          resolve()
        },
      )
      if (!sub || sub.info.finishedAt) resolve()
    })

    try { detachObserver() } catch {}

    const finalParse = parseResult(resolveEntry.log)
    if (finalParse) resolveEntry.parsedResult = finalParse
    if (resolveEntry.parsedResult?.taskComplete === true) {
      resolveEntry.exitCode = 0
      resolveEntry.status = 'done'
    } else {
      resolveEntry.status = resolveEntry.parsedResult ? 'done' : 'error'
      resolveEntry.exitCode = resolveEntry.parsedResult ? 0 : -1
    }
    resolveEntry.finishedAt = new Date().toISOString()
    emit(resolveId, { type: 'entry', entry: resolveEntry })

    if (resolveEntry.status === 'done') {
      await autoCommitIfDirty(worktreePath, `Resolve conflicts: ${taskTitle}`)

      origEntry.mergeStatus = 'merging'
      emit(origSession.id, { type: 'entry', entry: origEntry })

      const prevMerge = mergeQueues.get(origEntry.projectId) ?? Promise.resolve()
      const myMerge = prevMerge.then(async () => {
        const result = await mergeAndCleanup(origEntry.projectPath, worktreeInfo)
        origEntry.mergeStatus = result
        if (result === 'conflict') {
          appendLog(
            origSession,
            origEntry,
            `\n[resolve] コンフリクトが再度発生しました。ログを確認してください。\n`,
          )
          // Propagate conflict to the resolve entry so taskRuns (latest-session
          // map) correctly reflects the conflict state for the conflict banner.
          resolveEntry.mergeStatus = 'conflict'
          resolveEntry.worktreePath = worktreePath
        } else if (result === 'failed-fatal') {
          // Both `merge` and `merge --abort` failed (e.g. git index lock).
          // Propagate onto the resolve entry too — otherwise the latest-session
          // map reads a resolveEntry with no mergeStatus and the user gets no
          // (or a normal) banner while git is wedged, instead of the fatal one.
          resolveEntry.mergeStatus = 'failed-fatal'
          resolveEntry.worktreePath = worktreePath
        }
        emit(origSession.id, { type: 'entry', entry: origEntry })
        try {
          await ensureRunsDir()
          await writeFile(runFile(origSession.id), JSON.stringify(origSession, null, 2), 'utf8')
        } catch {}
      })
      mergeQueues.set(origEntry.projectId, myMerge)
      await myMerge
    }

    // Phase 3 — persist this resolve round's narrative onto the same targeted
    // tasks the original run touched. A clean merge relocated the JSONL to the
    // main project dir; an unresolved conflict left it in the worktree.
    try {
      const transcriptCwd =
        resolveEntry.mergeStatus === 'conflict' || origEntry.mergeStatus !== 'merged'
          ? worktreePath
          : origEntry.projectPath
      await persistTaskRunSummaries(resolveEntry, transcriptCwd)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[taskRunSummary] persist failed (resolveConflict):', e)
    }

    resolveSession.finishedAt = new Date().toISOString()
    try {
      await ensureRunsDir()
      await writeFile(runFile(resolveId), JSON.stringify(resolveSession, null, 2), 'utf8')
    } catch {}
    emit(resolveId, { type: 'session', session: resolveSession })
    emit(resolveId, { type: 'done' })
    pruneSessions()
    pruneRunFiles()
  })()

  return resolveSession
}
