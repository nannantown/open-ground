// swarmToolingInstall — install the worker-facing swarm toolkit into the
// user's global claude scope at boot:
//   ~/.claude/skills/order/SKILL.md     (the /order skill a spawned worker uses)
//   ~/.claude/skills/supply/SKILL.md    (the /supply skill the supply-officer session uses)
//   ~/.claude/skills/research/SKILL.md  (the /research routing skill for research-shaped goals)
//   ~/.claude/openground-swarm-lib.sh   (shared helper sourced BY swarm-beat.sh)
//   ~/.claude/swarm-beat.sh             (the heartbeat CLI every worker calls)
//   ~/.claude/openground-research-doctor.sh (the /research skill's local-only channel doctor)
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
export const RESEARCH_SKILL_MARKER = 'managed-by: openground'
export const RESEARCH_DOCTOR_MARKER = 'managed-by: openground'

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

/** Basename of the /research skill's channel-diagnosis CLI, in both places it
 *  lives (`scripts/<basename>` shipped, `~/.claude/<basename>` installed).
 *  openground-prefixed for the same reason as {@link SWARM_LIB_BASENAME}: a
 *  name no user file can already own, so the installer never has to decide
 *  between clobbering and stranding (the 2026-07 swarm-lib.sh collision
 *  lesson). The /research skill invokes it by this exact installed path. */
export const RESEARCH_DOCTOR_BASENAME = 'openground-research-doctor.sh'

/** SHA-256 of the PRE-MARKER `~/.claude/skills/order/SKILL.md` — the tmux-era
 *  copy that existing machines received by hand, before 19e19e0f (2026-07-22)
 *  seeded the skill into this repo WITH the managed-by marker. Measured on the
 *  owner's machine 2026-07-31; identified by the clause the repo version
 *  deleted that day (auto-firing `/order` on phrases like 「ガチでやって」).
 *
 *  Listing it here is an explicit claim that those exact bytes are OPEN
 *  GROUND's own prior output, so the installer may adopt them instead of
 *  shielding them as user-authored forever (managedFileInstall.ts header).
 *  Bytes NOT listed stay shielded — a single hand-edit takes the file back. */
export const ORDER_SKILL_ADOPT_DIGESTS: readonly string[] = [
  'b66c00d0ffec2832174debb8c6ca7a3397e653077a2eb4695fa104f8d007627f',
]

/** Same, for `~/.claude/skills/supply/SKILL.md`. The pre-marker copy is the one
 *  that tells the desk it lives in a tmux cockpit window (`Ctrl-b 2`) — a
 *  protocol that has not existed inside the app since the in-app swarm port,
 *  and which the desk was still being handed on 2026-07-31. */
export const SUPPLY_SKILL_ADOPT_DIGESTS: readonly string[] = [
  '7b101a6f62ac9511451c1b77a6b5f84f6742eb6c6010c6731d14ba1770dc48b6',
]

/** Same, for `~/.claude/swarm-beat.sh` — the heartbeat CLI EVERY worker calls.
 *  The pre-marker copy differs from the shipped one in exactly one functional
 *  line: it sources `swarm-lib.sh` (the user's hand-written tmux-cockpit lib)
 *  instead of {@link SWARM_LIB_BASENAME}. That works today only because the
 *  legacy lib happens to define an identical `sw_hbdir` — verified 2026-07-31,
 *  both resolve to the same `~/.openground/swarm/<key>` — so every worker's
 *  heartbeat has been riding a file OPEN GROUND does not ship or control. If the
 *  owner ever tidied that lib away, heartbeats would break with a shell
 *  `command not found` and the commander would see a fleet of silent workers.
 *  Adopting moves the dependency onto our own installed helper; the heartbeat
 *  directory is byte-identical either way, so live workers do not move. */
export const SWARM_BEAT_ADOPT_DIGESTS: readonly string[] = [
  '6cafd125432c9f7d87953cc20f55a51fbe39c53610801ea7cad2c9efdf42cfb0',
]

interface ToolingFile {
  name: string
  /** Path segments relative to the app checkout root resolved by resolveHookSourceRoot(). */
  sourceRel: string[]
  /** Path segments relative to the real home dir. */
  targetRel: string[]
  marker: string
  mode?: number
  /** Pre-marker vintages of THIS file that the installer may claim as its own. */
  adoptDigests?: readonly string[]
}

const TOOLING_FILES: ToolingFile[] = [
  { name: 'order', sourceRel: ['skills', 'order', 'SKILL.md'], targetRel: ['.claude', 'skills', 'order', 'SKILL.md'], marker: ORDER_SKILL_MARKER, adoptDigests: ORDER_SKILL_ADOPT_DIGESTS },
  { name: 'supply', sourceRel: ['skills', 'supply', 'SKILL.md'], targetRel: ['.claude', 'skills', 'supply', 'SKILL.md'], marker: SUPPLY_SKILL_MARKER, adoptDigests: SUPPLY_SKILL_ADOPT_DIGESTS },
  // Keep the lib BEFORE swarm-beat.sh: on an app update the refreshed beat
  // sources the lib, so the lib must already be on disk when it lands.
  { name: SWARM_LIB_BASENAME, sourceRel: ['scripts', SWARM_LIB_BASENAME], targetRel: ['.claude', SWARM_LIB_BASENAME], marker: SWARM_LIB_MARKER, mode: 0o755 },
  { name: 'swarm-beat.sh', sourceRel: ['scripts', 'swarm-beat.sh'], targetRel: ['.claude', 'swarm-beat.sh'], marker: SWARM_BEAT_MARKER, mode: 0o755, adoptDigests: SWARM_BEAT_ADOPT_DIGESTS },
  // The multi-platform research system (docs/RESEARCH_REACH_NOTES.md,
  // 2026-08-13): the /research routing skill + its local-only channel doctor.
  // Brand-new names — no pre-marker vintages exist, so no adoptDigests.
  { name: 'research', sourceRel: ['skills', 'research', 'SKILL.md'], targetRel: ['.claude', 'skills', 'research', 'SKILL.md'], marker: RESEARCH_SKILL_MARKER },
  { name: RESEARCH_DOCTOR_BASENAME, sourceRel: ['scripts', RESEARCH_DOCTOR_BASENAME], targetRel: ['.claude', RESEARCH_DOCTOR_BASENAME], marker: RESEARCH_DOCTOR_MARKER, mode: 0o755 },
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
      result: await installManagedFile({
        source,
        target,
        marker: f.marker,
        mode: f.mode,
        ...(f.adoptDigests ? { adoptDigests: f.adoptDigests } : {}),
      }),
    })
  }
  return out
}
