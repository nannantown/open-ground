// swarmToolingInstall — install the worker-facing swarm toolkit into the
// user's global claude scope at boot:
//   ~/.claude/skills/order/SKILL.md     (the /order skill a spawned worker uses)
//   ~/.claude/skills/supply/SKILL.md    (the /supply skill the supply-officer session uses)
//   ~/.claude/openground-swarm-lib.sh   (shared helper sourced BY swarm-beat.sh)
//   ~/.claude/swarm-beat.sh             (the heartbeat CLI every worker calls)
//
// WHY the server installs these (same rationale as ogManageSkill.ts): a
// spawned worker PTY resolves `/order` and `bash ~/.claude/swarm-beat.sh` in
// the USER's global ~/.claude scope, not from this repo checkout — so without
// this installer, anyone who installs OPEN GROUND fresh (no hand-copied
// ~/.claude files) gets workers that can't find their own skill or heartbeat
// script. The canonical text ships in THIS repo (skills/order/SKILL.md,
// skills/supply/SKILL.md, scripts/swarm-beat.sh,
// scripts/openground-swarm-lib.sh); a guarded swarm worker cannot write under
// ~/.claude (the A3 guard denies it deliberately), so the SERVER process
// installs idempotently at boot — the same hooksInstall.ts / ogManageSkill.ts
// pattern.
//
// Ownership contract: see managedFileInstall.ts (missing → install, marker
// present & stale → refresh, marker absent → kept-user, never touched).

import { join } from 'path'
import { homedir } from 'os'
import { resolveHookSourceRoot } from './hooksInstall'
import { assertTestHomeIsolated } from './testHomeGuard'
import { installManagedFile, type ManagedFileResult } from './managedFileInstall'

export const ORDER_SKILL_MARKER = 'managed-by: openground'
export const SUPPLY_SKILL_MARKER = 'managed-by: openground'
export const SWARM_BEAT_MARKER = 'managed-by: openground'
export const SWARM_LIB_MARKER = 'managed-by: openground'

/** Basename of the shared shell helper, in BOTH places it lives: the shipped
 *  source (`scripts/<basename>`) and the install target (`~/.claude/<basename>`).
 *  They must match because swarm-beat.sh sources its helper by SCRIPT dir
 *  (`. "$(dirname "$0")/<basename>"`) — the same file text runs from a repo
 *  checkout and from ~/.claude.
 *
 *  ⚠ Deliberately NOT `swarm-lib.sh`. Existing machines carry a hand-written
 *  ~/.claude/swarm-lib.sh from the tmux-cockpit era (12 pane-resolution / send
 *  helpers) that ~a dozen other ~/.claude scripts source. Ours defines only 2
 *  functions, so shipping it under that name would strip 10 functions the
 *  moment the kept-user shield stops applying (e.g. a user reads the
 *  "kept-user (marker missing)" boot log, deletes their copy expecting OG to
 *  take over, and the next boot installs ours) — the dependents then fail
 *  silently with `sw_session: command not found`. A distinct name means the
 *  user's file is never a target at all. See swarmToolingInstall.test.ts
 *  ("legacy ~/.claude/swarm-lib.sh collision").
 *
 *  Machines that already received the short-lived `~/.claude/swarm-lib.sh`
 *  (marker-carrying, shipped 2026-07-22 → 2026-07-23) keep it as an inert
 *  orphan: nothing sources it once swarm-beat.sh is refreshed, and deleting
 *  files out of a user's home is a bigger risk class than leaving one behind. */
export const SWARM_LIB_BASENAME = 'openground-swarm-lib.sh'

interface ToolingFile {
  name: string
  /** Path segments relative to the app checkout root resolved by resolveHookSourceRoot(). */
  sourceRel: string[]
  /** Path segments relative to the real home dir. */
  targetRel: string[]
  marker: string
  mode?: number
}

const TOOLING_FILES: ToolingFile[] = [
  { name: 'order', sourceRel: ['skills', 'order', 'SKILL.md'], targetRel: ['.claude', 'skills', 'order', 'SKILL.md'], marker: ORDER_SKILL_MARKER },
  { name: 'supply', sourceRel: ['skills', 'supply', 'SKILL.md'], targetRel: ['.claude', 'skills', 'supply', 'SKILL.md'], marker: SUPPLY_SKILL_MARKER },
  // Keep the lib BEFORE swarm-beat.sh: on an app update the refreshed beat
  // sources the lib, so the lib must already be on disk when it lands.
  { name: SWARM_LIB_BASENAME, sourceRel: ['scripts', SWARM_LIB_BASENAME], targetRel: ['.claude', SWARM_LIB_BASENAME], marker: SWARM_LIB_MARKER, mode: 0o755 },
  { name: 'swarm-beat.sh', sourceRel: ['scripts', 'swarm-beat.sh'], targetRel: ['.claude', 'swarm-beat.sh'], marker: SWARM_BEAT_MARKER, mode: 0o755 },
]

export interface SwarmToolingInstallResult {
  name: string
  result: ManagedFileResult
}

/** The shipped-source paths (relative to the repo root) every tooling file is
 *  read from. Exported so a packaging test can assert each one is actually
 *  bundled into the distributed app (electron-builder's `build.files`
 *  allowlist in package.json) — a repo-resident file that isn't listed there
 *  installs fine in dev (repo checkout IS the root) but silently no-ops
 *  ('error' outcome, logged only) in every packaged build. */
export const SWARM_TOOLING_SOURCE_PATHS: string[] = TOOLING_FILES.map((f) => f.sourceRel.join('/'))

/** Every install target, relative to the home dir ('.claude/swarm-beat.sh', …).
 *  Exported so a test can pin that no target collides with a file OPEN GROUND
 *  does not own — see SWARM_LIB_BASENAME. */
export const SWARM_TOOLING_TARGET_PATHS: string[] = TOOLING_FILES.map((f) => f.targetRel.join('/'))

/** Idempotently install/refresh the order/supply skills + swarm-beat.sh and its
 *  helper (SWARM_LIB_BASENAME) from the shipped repo source into ~/.claude. Does not itself throw on an
 *  install hiccup (a worker degrades to "skill/script missing", which the next
 *  boot repairs) — but note `assertTestHomeIsolated` below DOES throw inside a
 *  test process pointed at the real home, by design (see testHomeGuard.ts);
 *  production callers never hit that path. `opts.sourceRoot`/`opts.homeDir`
 *  exist for tests only (isolated tmp source root + home dir); production
 *  callers pass nothing. */
export const installSwarmTooling = async (
  opts: { sourceRoot?: string; homeDir?: string } = {},
): Promise<SwarmToolingInstallResult[]> => {
  let sourceRoot = opts.sourceRoot ?? null
  let rootProblem: string | null = null
  if (sourceRoot === null) {
    const resolved = resolveHookSourceRoot()
    sourceRoot = resolved.root
    rootProblem = resolved.problem
  }

  const home = opts.homeDir ?? homedir()
  if (opts.homeDir === undefined) assertTestHomeIsolated(home, 'swarmToolingInstall (homedir()/.claude)')

  const out: SwarmToolingInstallResult[] = []
  for (const f of TOOLING_FILES) {
    const target = join(home, ...f.targetRel)
    if (sourceRoot === null) {
      out.push({ name: f.name, result: { outcome: 'error', path: target, error: `tooling source unresolvable: ${rootProblem}` } })
      continue
    }
    const source = join(sourceRoot, ...f.sourceRel)
    out.push({
      name: f.name,
      result: await installManagedFile({ source, target, marker: f.marker, mode: f.mode }),
    })
  }
  return out
}
