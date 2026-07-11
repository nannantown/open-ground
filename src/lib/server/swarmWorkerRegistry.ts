// swarmWorkerRegistry — the SERVER-TRUTH worker list for GET /api/swarm/workers.
//
// WHY: the Swarm worker tab used to be authoritative on "who dispatched this
// worker" (a client localStorage registry for UI/restart-launched workers,
// merged with the commander engine's own in-memory roster for engine-dispatched
// ones). A worker started a THIRD way — a direct `POST /api/swarm/worker` curl
// call, the swarm control plane's documented manual-dispatch path — was tracked
// by NEITHER registry, so it never appeared in the tab even while its PTY and
// heartbeat were both alive. This module inverts the authority: it asks the
// server what actually EXISTS (live PTYs in the terminal pool + heartbeat files
// `swarm-beat.sh` writes), rather than trusting whoever remembered to register a
// worker. The engine's own roster is folded in for the richer fields it alone
// carries (taskId / taskTitle / startedAt / stage) — not as a second source of
// IDENTITY, since every engine worker is also a live PTY in its own worktree.
//
// Identity = worktree path (one worker per isolated worktree — matches how
// spawnSwarmWorker mints one worktree per worker and cwd's the PTY into it).

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { openGroundHome, centralWorktreesDir } from './paths'
import { canonicalize } from './canonicalize'
import { isUnderCentralDir } from './worktreeCleanup'
import { projectUUIDFromPath } from './projectDataPath'
import { listActiveTerminals as defaultListActiveTerminals } from './terminal'
import { getOrchestratorState as defaultGetOrchestratorState } from './swarmOrchestrator'
import { swarmRepoKey } from './swarmJanitor'
import type { ActiveTerminalsResponse, SwarmOrchestratorState, SwarmWorkerRecord } from '../types'

const execFile = promisify(execFileCb)

// House convention (swarmWorker.ts GIT_OPTS): network-free git call, hard
// timeout, no credential prompt hang.
const GIT_OPTS = { timeout: 5_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }

/** The branch checked out in `cwd`, or null on any failure (not a worktree,
 *  git missing, detached-without-a-name, …). Used ONLY as a fallback for a live
 *  PTY the heartbeat/engine sources don't already name — a real worktree always
 *  has a real branch, so this is cheap and reliable when it succeeds. */
const branchOfWorktree = async (cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      ...GIT_OPTS,
    })
    const branch = stdout.trim()
    return branch && branch !== 'HEAD' ? branch : null
  } catch {
    return null
  }
}

export interface ParsedHeartbeat {
  branch?: string
  worktree?: string
  phase?: string
  task?: string
  readyToMerge?: boolean
  blockers?: string
  updatedAt?: string
}

/** Parse one heartbeat JSON file's raw text. Tolerant of any shape — an absent
 *  or wrong-typed field is simply omitted, never thrown. */
export const parseHeartbeat = (raw: string): ParsedHeartbeat => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const j = parsed as Record<string, unknown>
  return {
    branch: typeof j.branch === 'string' ? j.branch : undefined,
    worktree: typeof j.worktree === 'string' ? j.worktree : undefined,
    phase: typeof j.phase === 'string' ? j.phase : undefined,
    task: typeof j.task === 'string' ? j.task.trim() || undefined : undefined,
    readyToMerge: j.readyToMerge === true,
    blockers: typeof j.blockers === 'string' ? j.blockers.trim() || undefined : undefined,
    updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : undefined,
  }
}

/** Every heartbeat file under this project's `~/.openground/swarm/<key>/` dir,
 *  keyed by worktree path (only files carrying one — an older/foreign file
 *  without it can't be matched to anything and is skipped). []  when the repo
 *  has no heartbeat dir yet. */
export const readHeartbeats = async (
  projectPath: string,
): Promise<Map<string, ParsedHeartbeat>> => {
  const out = new Map<string, ParsedHeartbeat>()
  const key = await swarmRepoKey(projectPath)
  if (!key) return out
  const dir = join(openGroundHome(), 'swarm', key)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(join(dir, file), 'utf8')
    } catch {
      continue
    }
    const hb = parseHeartbeat(raw)
    if (hb.worktree) out.set(hb.worktree, hb)
  }
  return out
}

/** The canonical central worktrees dir owning `projectPath`, or null when it
 *  can't be resolved (not a registered project — shouldn't happen behind the
 *  route's validateProjectPath, but degrade safely rather than throw). Used to
 *  scope "live but unclaimed" PTYs to THIS project — without it, a live claude
 *  PTY from an unrelated place (the project's OWN Supply/Commander conversation
 *  in its primary checkout, or another project's terminal entirely — the pool
 *  is process-wide, not project-scoped) would be folded in as a phantom worker. */
const resolveCentralWorktreesDir = async (projectPath: string): Promise<string | null> => {
  try {
    return await canonicalize(centralWorktreesDir(await projectUUIDFromPath(projectPath)))
  } catch {
    return null
  }
}

/** Injected seams — defaults are the real IO; tests fake them so the merge
 *  logic (the actual thing worth testing) runs without a real terminal pool /
 *  engine / filesystem. */
export interface SwarmWorkerRegistryDeps {
  listActiveTerminals: () => ActiveTerminalsResponse
  getOrchestratorState: (projectPath: string) => Promise<SwarmOrchestratorState>
  readHeartbeats: (projectPath: string) => Promise<Map<string, ParsedHeartbeat>>
  branchOfWorktree: (cwd: string) => Promise<string | null>
  resolveCentralWorktreesDir: (projectPath: string) => Promise<string | null>
}

export const defaultRegistryDeps = (): SwarmWorkerRegistryDeps => ({
  listActiveTerminals: defaultListActiveTerminals,
  getOrchestratorState: defaultGetOrchestratorState,
  readHeartbeats,
  branchOfWorktree,
  resolveCentralWorktreesDir,
})

/** List every REAL swarm worker for `projectPath`: cross-references live PTYs
 *  (terminal pool), the commander engine's own roster, and heartbeat files.
 *  Dead workers (heartbeat on disk, no live PTY) are still returned — with
 *  `terminalId` absent — so the tab's restart affordance keeps working exactly
 *  as before (条件3). Never throws; a missing/unreadable source degrades to
 *  "not present" rather than failing the whole list. */
export const listSwarmWorkers = async (
  projectPath: string,
  deps: SwarmWorkerRegistryDeps = defaultRegistryDeps(),
): Promise<SwarmWorkerRecord[]> => {
  const [engineState, heartbeats, active, centralDir] = await Promise.all([
    deps.getOrchestratorState(projectPath).catch(() => null),
    deps.readHeartbeats(projectPath),
    Promise.resolve(deps.listActiveTerminals()),
    deps.resolveCentralWorktreesDir(projectPath),
  ])

  const liveCwdToTerminalId = new Map<string, string>()
  for (const c of active.claude) liveCwdToTerminalId.set(c.cwd, c.id)

  const byWorktree = new Map<string, SwarmWorkerRecord>()

  // 1) Engine-tracked workers — richest fields (taskId/taskTitle/startedAt/stage).
  //    phase/note come from the engine's own last-folded heartbeat read (only
  //    refreshed when the monitor re-probes a 'doing' worker — see withHeartbeat()
  //    in swarmOrchestrator.ts). heartbeatAt is different: we ALSO read heartbeats
  //    fresh off disk right here (`hb`, from deps.readHeartbeats() above), so prefer
  //    that live value over the engine's possibly-stale fold — otherwise a worker
  //    whose card isn't being actively re-probed (e.g. sitting in review/done) can
  //    show a heartbeat frozen at whatever the monitor last folded, hours behind the
  //    real disk timestamp (misdiagnosed as dead — see docs/commander/02-worker-lifecycle.md §4).
  for (const w of engineState?.workers ?? []) {
    const terminalId = liveCwdToTerminalId.get(w.worktree)
    const hb = heartbeats.get(w.worktree)
    const heartbeatAt = hb?.updatedAt ?? w.heartbeatAt
    byWorktree.set(w.worktree, {
      worktree: w.worktree,
      branch: w.branch,
      ...(terminalId ? { terminalId } : {}),
      taskId: w.taskId,
      taskTitle: w.taskTitle,
      startedAt: w.startedAt,
      stage: w.stage,
      ...(w.phase ? { phase: w.phase } : {}),
      ...(w.note ? { note: w.note } : {}),
      ...(heartbeatAt ? { heartbeatAt } : {}),
      ...(hb?.readyToMerge ? { ready: true } : {}),
      ...(hb && !hb.readyToMerge && (hb.phase === 'blocked' || !!hb.blockers)
        ? { blocked: true }
        : {}),
      ...(hb?.blockers ? { blockers: hb.blockers } : {}),
    })
  }

  // 2) Live claude PTYs not already claimed by an engine record — a worker
  //    started outside the engine (curl-direct `POST /api/swarm/worker`, or a
  //    UI restart). Enrich from its heartbeat file when one exists; otherwise
  //    fall back to reading the branch straight out of the worktree.
  //    SCOPED to this project's central worktrees dir + a `swarm/*` branch —
  //    listActiveTerminals() is process-wide (every live claude PTY, including
  //    THIS project's own Supply/Commander conversation in its primary
  //    checkout, and every other project's terminals), so without both checks
  //    those would be folded in as phantom workers (and a Terminate click on
  //    one would kill a real, unrelated session).
  for (const [cwd, terminalId] of Array.from(liveCwdToTerminalId)) {
    if (byWorktree.has(cwd)) continue
    if (!centralDir) continue // can't scope to this project — skip, never guess
    let canonCwd: string
    try {
      canonCwd = await canonicalize(cwd)
    } catch {
      continue
    }
    if (!isUnderCentralDir(canonCwd, centralDir)) continue
    const hb = heartbeats.get(cwd)
    const branch = hb?.branch ?? (await deps.branchOfWorktree(cwd))
    if (!branch?.startsWith('swarm/')) continue // not a swarm worker worktree — skip
    byWorktree.set(cwd, {
      worktree: cwd,
      branch,
      terminalId,
      ...(hb?.phase ? { phase: hb.phase } : {}),
      ...(hb?.task ? { note: hb.task } : {}),
      ...(hb?.updatedAt ? { heartbeatAt: hb.updatedAt } : {}),
      ...(hb?.readyToMerge ? { ready: true } : {}),
      ...(hb && !hb.readyToMerge && (hb.phase === 'blocked' || !!hb.blockers)
        ? { blocked: true }
        : {}),
      ...(hb?.blockers ? { blockers: hb.blockers } : {}),
    })
  }

  // 3) Heartbeat files with no live PTY and no engine record — a DEAD worker
  //    (PTY exited, work + branch still on disk). Kept so the restart
  //    affordance can still target it (条件3).
  for (const [worktree, hb] of Array.from(heartbeats)) {
    if (byWorktree.has(worktree)) continue
    if (!hb.branch) continue // can't identify the branch → nothing to restart
    byWorktree.set(worktree, {
      worktree,
      branch: hb.branch,
      ...(hb.phase ? { phase: hb.phase } : {}),
      ...(hb.task ? { note: hb.task } : {}),
      ...(hb.updatedAt ? { heartbeatAt: hb.updatedAt } : {}),
      ...(hb.readyToMerge ? { ready: true } : {}),
      ...(!hb.readyToMerge && (hb.phase === 'blocked' || !!hb.blockers) ? { blocked: true } : {}),
      ...(hb.blockers ? { blockers: hb.blockers } : {}),
    })
  }

  return Array.from(byWorktree.values())
}
