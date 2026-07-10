// terminalProjects.ts — attribute live claude PTYs to the project that owns
// their cwd, so GET /api/terminal/active can carry a `projectId` the Ground
// beacon aggregates on.
//
// Why this exists at all: a swarm worker runs in an ISOLATED git worktree under
// the project's CENTRAL worktrees dir (~/.openground/projects/<uuid>/worktrees/),
// which is deliberately OUTSIDE the project folder. The client used to attribute
// a session by comparing its cwd against the registered project path, so every
// worker pane was invisible to the card beacon: a project whose workers were all
// hard at work in worktrees showed WAITING (or nothing), driven only by whatever
// idle pane happened to sit in the repo root.
//
// Kept OUT of terminal.ts on purpose: that module is the pty pool and stays free
// of registry/filesystem lookups (listActiveTerminals is a synchronous Map scan).
// Attribution is a separate, async, registry-reading concern.

import type { ActiveTerminalsResponse } from '@/lib/types'
import { projectUUIDsForPaths } from './projectDataPath'

/** Resolve many cwds to their owning project UUID (null when unowned). */
export type ProjectIdResolver = (paths: readonly string[]) => Promise<Map<string, string | null>>

/** Copy of `res` whose claude entries carry `projectId` where a registered
 *  project owns the cwd. The resolver is injected for tests; production reads
 *  the registry ONCE per call (cwds are deduped first, so N panes in one
 *  worktree cost one lookup). Best-effort: a resolver failure yields the
 *  untouched response rather than a 500 — the client's path fallback still
 *  lights beacons for repo-root sessions. */
export const attachProjectIds = async (
  res: ActiveTerminalsResponse,
  resolve: ProjectIdResolver = projectUUIDsForPaths,
): Promise<ActiveTerminalsResponse> => {
  if (res.claude.length === 0) return res
  let byCwd: Map<string, string | null>
  try {
    byCwd = await resolve(Array.from(new Set(res.claude.map((a) => a.cwd))))
  } catch {
    return res
  }
  return {
    ...res,
    claude: res.claude.map((a) => {
      const projectId = byCwd.get(a.cwd)
      return projectId ? { ...a, projectId } : a
    }),
  }
}
