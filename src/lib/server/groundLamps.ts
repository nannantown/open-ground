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

import { startedTaskCount } from '@/lib/groundLamp'
import { canonicalize } from './canonicalize'
import { readProjectData } from './projectData'
import { getSettings } from './store'
import { countOpenEscalationsByProject } from './swarmEscalations'
import { listSwarmWorkers } from './swarmWorkerRegistry'
import { listAllActiveDesks } from './liveDesks'
import type { GroundLampRow, GroundLampsResponse } from '@/lib/types'

export interface GroundLampDeps {
  /** DI: every registered project, as `{ id, path }`. */
  projects?: () => Promise<Array<{ id: string; path: string }>>
  /** DI: started-card count for one project, or undefined when unreadable. */
  startedFor?: (projectPath: string) => Promise<number | undefined>
  /** DI: open questions per canonical project path, or null when unreadable. */
  openQuestions?: () => Promise<Map<string, number> | null>
  /** DI: is anything actually running for this project. */
  liveWorkFor?: (projectPath: string) => Promise<boolean>
}

/** Started cards for one project. `undefined` (never 0) when the board could not
 *  be read: an unreadable board is not an empty board, and a 0 here would go
 *  straight out as "this project has nothing in flight". */
const defaultStartedFor = async (projectPath: string): Promise<number | undefined> => {
  try {
    const data = await readProjectData(projectPath)
    return startedTaskCount(data.tasks ?? [])
  } catch {
    return undefined
  }
}

/** Is anything ACTUALLY moving this project — either runtime.
 *
 *  A swarm worker counts when it holds a live handle: a `terminalId` (PTY) or an
 *  `sdkSessionId` (the SDK pool). Both are written only while the runtime is
 *  alive, which is what makes them a liveness signal rather than a record of one.
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
 *  is visible on its own: dispatched workers hold live handles (counted above),
 *  and a desk that needs the owner raises an escalation, which outranks
 *  everything in groundLamp(). `ClaudeActivity.desk` is the marker (set from
 *  TerminalInfo.deskLabel / the SDK session's role — only desk launchers write
 *  those; a hand-started `claude` in the same repo never carries one), so the
 *  owner's own pane mid-generation still counts as the project working.
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
  try {
    const workers = await listWorkers(projectPath)
    if (workers.some((w) => w.terminalId || w.sdkSessionId)) return true
  } catch {
    /* the registry is unreadable — fall through to the PTY list */
  }
  try {
    const canonPath = await canon(projectPath)
    return listDesks().claude.some(
      (a) =>
        !a.desk &&
        a.status === 'working' &&
        (a.cwd === canonPath || a.cwd.startsWith(canonPath + '/')),
    )
  } catch {
    return false
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
  const startedFor = deps.startedFor ?? defaultStartedFor
  const liveWorkFor = deps.liveWorkFor ?? liveWorkForProject
  const readQuestions = deps.openQuestions ?? countOpenEscalationsByProject

  let projects: Array<{ id: string; path: string }>
  try {
    projects = await listProjects()
  } catch {
    return { lamps: [] }
  }
  // ONE inbox read for the whole Ground. `null` ⇒ unreadable, which every row
  // then reports as an ABSENT count rather than a zero.
  const questions = await readQuestions().catch(() => null)

  const lamps = await Promise.all(
    projects.map(async (p): Promise<GroundLampRow> => {
      const started = await startedFor(p.path)
      let open: number | undefined
      if (questions) {
        const canon = await canonicalize(p.path).catch(() => p.path)
        open = questions.get(canon) ?? 0
      }
      // The short-circuit that keeps this cheap: with nothing started the lamp
      // is dark whatever the processes are doing, so do not go looking.
      const liveWork = started ? await liveWorkFor(p.path).catch(() => false) : false
      return {
        projectId: p.id,
        ...(started === undefined ? {} : { started }),
        ...(open === undefined ? {} : { openQuestions: open }),
        liveWork,
      }
    }),
  )
  return { lamps }
}
