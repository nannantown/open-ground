// groundLamps — one row per registered project for the Ground card lamp.
//
// WHY THE SERVER COMPUTES THIS. The lamp answers a question about the project's
// WORK (src/lib/groundLamp.ts holds the owner's four cases), and the three facts
// it needs all live here: the board (`tasks.json` under the central data dir),
// the question inbox (`escalations.json`), and whether anything is actually
// running. The client has no business holding every project's board just to
// decide the colour of a stamp — and could not see the SDK worker pool at all.
//
// ⚠ THE SDK POOL IS THE REASON THIS IS NOT `/api/terminal/active` (2026-08-15).
// Swarm workers run through the Agent SDK, not a PTY, so they never appear in
// the terminal list the Ground beacon already polls. A lamp built from that list
// alone reports 「途中でとまっている」 over a swarm that is working perfectly —
// which is the same class of lie as the WAITING bug this whole lamp replaced,
// just pointing the other way. `liveWork` therefore asks the worker registry,
// which knows both runtimes.
//
// COST, because it runs every few seconds. The board read is one small JSON per
// project; the inbox is read ONCE for all of them. The expensive part — the
// worker registry, which touches heartbeat files and git — runs ONLY for a
// project that already has started cards, and a project with none is exactly the
// case the lamp answers with `null` regardless. Most Grounds do no worker reads
// at all.
//
// NOTHING HERE THROWS. A project whose board cannot be read contributes a row
// with no counts rather than taking the whole Ground's lamps down with it.

import { inFlightTaskCount, startedTaskCount } from '@/lib/groundLamp'
import { canonicalize } from './canonicalize'
import { readProjectData } from './projectData'
import { getSettings } from './store'
import { countOpenEscalationsByProject } from './swarmEscalations'
import { listSwarmWorkers } from './swarmWorkerRegistry'
import { listAllActiveDesks, listDeskIdsByRole } from './liveDesks'
import { SUPPLY_DESK_LABEL } from './swarmSupply'
import { MANAGER_DESK_LABEL } from './swarmManagerLabel'
import { isEngineRunning } from './swarmOrchestrator'
import { readDeliveredAt, readGroundOpenedAt, readGroundSeenAt, readPresidentAskedAt } from './groundMarks'
import type { ClaudeActivity, GroundLampRow, GroundLampsResponse } from '@/lib/types'

export interface GroundLampDeps {
  /** DI: every registered project, as `{ id, path }`. */
  projects?: () => Promise<Array<{ id: string; path: string }>>
  /** DI: the board's two counts for one project (started = doing/review/blocked,
   *  inFlight = inFlightTaskCount under this project's autopilot), or undefined
   *  when the board is unreadable. `canonPath` keys the autopilot lookup. */
  boardFor?: (projectPath: string, canonPath: string) => Promise<BoardCounts | undefined>
  /** DI: open questions per canonical project path, or null when unreadable. */
  openQuestions?: () => Promise<Map<string, number> | null>
  /** DI: is anything actually running for this project. */
  liveWorkFor?: (projectPath: string) => Promise<boolean>
  /** DI: cwds of president (supply) desks that are generating right now. */
  presidentWorkingCwds?: () => string[]
  /** DI: cwds of commander desks that are generating right now. */
  commanderWorkingCwds?: () => string[]
  /** DI: the question / review mark timestamps (groundMarks.ts), each ms or undefined. */
  presidentAskedAtFor?: (projectPath: string) => Promise<number | undefined>
  deliveredAtFor?: (projectPath: string) => Promise<number | undefined>
  seenAtFor?: (projectPath: string) => Promise<number | undefined>
  openedAtFor?: (projectPath: string) => Promise<number | undefined>
}

export interface BoardCounts {
  started: number
  inFlight: number
}

/** The board's counts for one project. `undefined` (never 0) when the board
 *  could not be read: an unreadable board is not an empty board, and a 0 here
 *  would go straight out as "this project has nothing in flight". The autopilot
 *  is an in-memory read (isEngineRunning) — no extra disk. */
const defaultBoardFor = async (projectPath: string, canonPath: string): Promise<BoardCounts | undefined> => {
  try {
    const tasks = (await readProjectData(projectPath)).tasks ?? []
    return {
      started: startedTaskCount(tasks),
      inFlight: inFlightTaskCount(tasks, { autopilot: isEngineRunning(canonPath) }),
    }
  } catch {
    return undefined
  }
}

/** Is anything ACTUALLY moving this project — either runtime.
 *
 *  A swarm worker counts while its session is WORKING. The registry's handle
 *  (`terminalId` for a PTY, `sdkSessionId` for the SDK pool) names a pane in the
 *  both-pools list, and THAT pane's status must be 'working'. The handle alone
 *  is not enough — measured 2026-09-17 on sns-hub: a worker that had FINISHED
 *  (heartbeat phase done, ready:true, last beat 3.5 h earlier) stays resident in
 *  the SDK pool until the commander integrates it, so its handle was live and
 *  the Ground card said RUNNING over a project where nothing moved; the owner
 *  asked 「なぜrunningになっている?」 twice. Alive is not working. A worker
 *  between turns (finished, asking, quota-parked) is judged by the same verdict
 *  the owner's own pane is judged by right below — and a handle no pool can
 *  vouch for (a roster row outliving its session) counts for nothing.
 *
 *  A plain `claude` pane counts when it is WORKING — not merely open. A session
 *  parked at its prompt is a fact about the machine; treating it as live work is
 *  how the old beacon stamped finished projects amber forever.
 *
 *  ⚠ DESKS DO NOT COUNT — owner decision, 2026-08-17: 「補給官の動きはrunning扱い
 *  じゃなくてもいいかも」, on a card stamped RUNNING beside a strip saying 稼働0.
 *  A desk (commander / supply) is machinery: it wakes every few minutes to read
 *  the Board, and each of those passes lit the lamp for a project where not one
 *  card was moving — the exact housekeeping-as-work lie this lamp was rebuilt to
 *  remove, re-entering through the working/waiting split. The work a desk DRIVES
 *  is visible on its own: dispatched workers mid-turn are counted above, and a
 *  desk that needs the owner raises an escalation, which outranks
 *  everything in groundLamp(). `ClaudeActivity.desk` is the marker (set from
 *  TerminalInfo.deskLabel / the SDK session's role — only desk launchers write
 *  those; a hand-started `claude` in the same repo never carries one), so the
 *  owner's own pane mid-generation still counts as the project working.
 *
 *  ⚠ AMENDED 2026-09-25 for the PRESIDENT only (supply desk, 社長): 「社長も動いて
 *  たら…ランニングって出るようにしてほしいな」. The president is the one seat the
 *  owner talks to, so its turn IS the work the owner is waiting on. It is NOT
 *  counted here — it has its own row field (it must light a card with nothing
 *  started too), see {@link presidentWorkingCwds}.
 *
 *  ⚠ AMENDED 2026-09-26 for the COMMANDER too (「マネージャーが動いてるんだったら
 *  …ランニング」): generating commanders light the lamp through their own row
 *  field (commanderWorkingCwds), not here — this function stays "workers and the
 *  owner's own panes".
 *
 *  ⚠ BOTH POOLS, VIA liveDesks. `listActiveTerminals` is the PTY pool alone and
 *  is lint-restricted for exactly the reason that bites here: an SDK session has
 *  no terminalId, so asking the PTY pool about one does not fail — it quietly
 *  answers "nothing is running". On this surface that renders as 「途中でとまって
 *  いる」 over a swarm working perfectly, which is the same shape of lie the lamp
 *  was rebuilt to remove.
 *
 *  Exported with injectable seams so the desk rule is testable without pools. */
export const liveWorkForProject = async (
  projectPath: string,
  deps: {
    listWorkers?: typeof listSwarmWorkers
    listDesks?: typeof listAllActiveDesks
    canon?: (p: string) => Promise<string>
  } = {},
): Promise<boolean> => {
  const listWorkers = deps.listWorkers ?? listSwarmWorkers
  const listDesks = deps.listDesks ?? listAllActiveDesks
  const canon = deps.canon ?? canonicalize
  // ONE both-pools read; both arms below are questions about it. Unreadable ⇒
  // empty: then no pane can be seen working, and "no evidence" is never "working".
  let panes: ClaudeActivity[]
  try {
    panes = listDesks().claude
  } catch {
    panes = []
  }
  const working = new Set(panes.filter((a) => a.status === 'working').map((a) => a.id))
  try {
    const workers = await listWorkers(projectPath)
    if (
      workers.some((w) => {
        // The ONE handle this worker's runtime names (pty ⇔ terminalId, sdk ⇔
        // sdkSessionId — the identity invariant, workerRuntime.ts), looked up in
        // the both-pools list. Absent on a dead worker ⇒ nothing to look up.
        const handle = w.sdkSessionId || w.terminalId
        return !!handle && working.has(handle)
      })
    )
      return true
  } catch {
    /* the registry is unreadable — fall through to the owner's own panes */
  }
  try {
    const canonPath = await canon(projectPath)
    return panes.some(
      (a) =>
        !a.desk &&
        a.status === 'working' &&
        (a.cwd === canonPath || a.cwd.startsWith(canonPath + '/')),
    )
  } catch {
    return false
  }
}

/** Where the PRESIDENT (supply desk) is generating right now — its cwds.
 *
 *  Owner, 2026-09-25: the Ground card says RUNNING while the president is
 *  answering / researching / writing cards, and nothing when it sits at its
 *  prompt. "Generating" is the pool's own beacon verdict (`status === 'working'`
 *  — claudeWorking for a PTY desk, working/starting for an SDK one); a desk that
 *  is merely ALIVE at its prompt reads 'waiting' and lights nothing, which keeps
 *  the 2026-08-15 rule (alive is not a lamp).
 *
 *  The president is recognised by the launcher-written identity only — PTY
 *  `deskLabel === SUPPLY_DESK_LABEL`, SDK `role === 'supply'` — so the commander
 *  (also a desk) and hand-started panes never pass. All reads are in-memory pool
 *  reads, done ONCE per lamps request. Unreadable ⇒ [] (no evidence ≠ working). */
export const presidentWorkingCwds = (
  deps: {
    listDesks?: typeof listAllActiveDesks
    presidentIds?: () => Set<string>
  } = {},
): string[] =>
  workingDeskCwds(deps.presidentIds ?? (() => listDeskIdsByRole(SUPPLY_DESK_LABEL, 'supply')), deps.listDesks)

/** Where the COMMANDER (司令官) is generating right now — the same read as the
 *  president's, keyed by the commander's launcher-written identity (PTY
 *  `deskLabel === MANAGER_DESK_LABEL`, SDK `role === 'manager'`). Owner,
 *  2026-09-26: 「マネージャーが動いてるんだったら…ランニング」 — this lifts the
 *  2026-08-17 "desks do not count" rule for the commander (see
 *  {@link liveWorkForProject}); a commander idle at its prompt still counts for
 *  nothing. */
export const commanderWorkingCwds = (
  deps: {
    listDesks?: typeof listAllActiveDesks
    commanderIds?: () => Set<string>
  } = {},
): string[] =>
  workingDeskCwds(deps.commanderIds ?? (() => listDeskIdsByRole(MANAGER_DESK_LABEL, 'manager')), deps.listDesks)

const workingDeskCwds = (
  readIds: () => Set<string>,
  listDesks: typeof listAllActiveDesks = listAllActiveDesks,
): string[] => {
  let ids: Set<string>
  try {
    ids = readIds()
  } catch {
    return []
  }
  if (ids.size === 0) return []
  try {
    return listDesks()
      .claude.filter((a) => a.status === 'working' && ids.has(a.id))
      .map((a) => a.cwd)
  } catch {
    return []
  }
}

/** Every registered project's lamp inputs. Never throws. */
export const readGroundLamps = async (deps: GroundLampDeps = {}): Promise<GroundLampsResponse> => {
  const listProjects =
    deps.projects ??
    (async () => {
      const settings = await getSettings()
      return (settings.projects ?? []).map((p) => ({ id: p.id, path: p.path }))
    })
  const boardFor = deps.boardFor ?? defaultBoardFor
  const liveWorkFor = deps.liveWorkFor ?? liveWorkForProject
  const readQuestions = deps.openQuestions ?? countOpenEscalationsByProject
  const readPresident = deps.presidentWorkingCwds ?? presidentWorkingCwds
  const readCommander = deps.commanderWorkingCwds ?? commanderWorkingCwds
  const askedAtFor = deps.presidentAskedAtFor ?? readPresidentAskedAt
  const deliveredAtFor = deps.deliveredAtFor ?? readDeliveredAt
  const seenAtFor = deps.seenAtFor ?? readGroundSeenAt
  const openedAtFor = deps.openedAtFor ?? readGroundOpenedAt

  let projects: Array<{ id: string; path: string }>
  try {
    projects = await listProjects()
  } catch {
    return { lamps: [] }
  }
  // ONE inbox read for the whole Ground. `null` ⇒ unreadable, which every row
  // then reports as an ABSENT count rather than a zero.
  const questions = await readQuestions().catch(() => null)
  // ONE in-memory pool read for every project's president / commander, likewise.
  const cwdsOf = (read: () => string[]): string[] => {
    try {
      return read()
    } catch {
      return []
    }
  }
  const presidentCwds = cwdsOf(readPresident)
  const commanderCwds = cwdsOf(readCommander)
  const under = (cwds: string[], canon: string) => cwds.some((c) => c === canon || c.startsWith(canon + '/'))

  const lamps = await Promise.all(
    projects.map(async (p): Promise<GroundLampRow> => {
      let open: number | undefined
      const canon = await canonicalize(p.path).catch(() => p.path)
      const board = await boardFor(p.path, canon).catch(() => undefined)
      const started = board?.started
      if (questions) open = questions.get(canon) ?? 0
      const presidentWorking = under(presidentCwds, canon)
      const commanderWorking = under(commanderCwds, canon)
      // The short-circuit that keeps this cheap: ask the worker registry ONLY
      // when its answer can change the verdict — something is started (else a
      // live process is not work) and nothing in flight (else it is running
      // already). In practice: a board holding only blocked cards.
      const liveWork = started && !board?.inFlight ? await liveWorkFor(p.path).catch(() => false) : false
      // The timed marks (2026-09-26). Three small file reads per project; the
      // president's transcript tail is walked incrementally, cached on path+offset (groundMarks.ts).
      const quiet = (f: (x: string) => Promise<number | undefined>) =>
        f(p.path).catch(() => undefined)
      const [presidentAskedAt, deliveredAt, seenAt, openedAt] = await Promise.all([
        quiet(askedAtFor),
        quiet(deliveredAtFor),
        quiet(seenAtFor),
        quiet(openedAtFor),
      ])
      return {
        projectId: p.id,
        ...(board === undefined ? {} : { started: board.started, inFlight: board.inFlight }),
        ...(open === undefined ? {} : { openQuestions: open }),
        liveWork,
        ...(presidentWorking ? { presidentWorking: true } : {}),
        ...(commanderWorking ? { commanderWorking: true } : {}),
        ...(presidentAskedAt === undefined ? {} : { presidentAskedAt }),
        ...(deliveredAt === undefined ? {} : { deliveredAt }),
        ...(seenAt === undefined ? {} : { seenAt }),
        ...(openedAt === undefined ? {} : { openedAt }),
      }
    }),
  )
  return { lamps }
}
