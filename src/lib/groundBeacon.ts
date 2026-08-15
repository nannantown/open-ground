// groundBeacon.ts — collapse the live claude PTY list (GET /api/terminal/active)
// into ONE verdict per Ground card. Pure + framework-free so the aggregation
// rule is unit-testable apart from App's polling effect.
//
// Two rules, both learned the hard way:
//
//  1. ATTRIBUTION. A session belongs to the project the SERVER says owns its cwd
//     (`projectId`, resolved against the registry — see server/terminalProjects).
//     The cwd-prefix match below is only a fallback for a server that predates
//     that field. Prefix matching alone is wrong: a swarm worker's cwd is its
//     worktree under ~/.openground/projects/<uuid>/worktrees/, which is NOT under
//     the project folder, so every working worker was silently dropped and the
//     card reported the idle repo-root pane's `waiting`.
//
//  2. WORKING WINS, and 'waiting' beats 'idle'. One busy pane makes the whole
//     card busy, regardless of how many quiet panes sit beside it or what order
//     the server listed them in — and one pane genuinely blocked on the human
//     outranks any number of parked ones.
//
//  3. 'idle' IS NOT 'waiting' (2026-08-15). A live session parked at its prompt
//     is a fact about the machine, not a claim on the reader's attention. It is
//     kept in the map so a consumer can tell "a session is open" from "nothing
//     is running", but the Ground card draws no stamp for it. Collapsing the two
//     is what made every card read WAITING with every task done.

import type { ClaudeActivity, ClaudeBeaconStatus } from '@/lib/types'

/** The only fields the beacon needs off a Ground card's project. */
export interface BeaconProject {
  id: string
  path: string
}

/** projectId → beacon verdict. Projects with no live claude pane are absent
 *  (the card then shows no beacon at all). */
export const aggregateClaudeBeacons = (
  projects: readonly BeaconProject[],
  claude: readonly ClaudeActivity[],
): Map<string, ClaudeBeaconStatus> => {
  const known = new Set(projects.map((p) => p.id))
  const out = new Map<string, ClaudeBeaconStatus>()
  for (const a of claude) {
    // Trust the server's attribution only for a project actually on this
    // Ground; otherwise fall back to the cwd prefix (repo root or a subdir).
    const projectId =
      a.projectId && known.has(a.projectId)
        ? a.projectId
        : projects.find((p) => a.cwd === p.path || a.cwd.startsWith(p.path + '/'))?.id
    if (!projectId) continue
    // Rank, don't first-write-wins: the server lists panes in pool order, so a
    // parked desk listed before a blocked one used to decide the card.
    const prev = out.get(projectId)
    if (prev === undefined || RANK[a.status] < RANK[prev]) out.set(projectId, a.status)
  }
  return out
}

/** Precedence when one project holds several panes. Lower wins. */
const RANK: Record<ClaudeBeaconStatus, number> = { working: 0, waiting: 1, idle: 2 }
