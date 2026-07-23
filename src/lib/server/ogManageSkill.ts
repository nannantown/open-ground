// ogManageSkill — install the `og-manage` skill (the tmux-free in-app commander
// protocol) into the user's global claude skills dir:
// ~/.claude/skills/og-manage/SKILL.md.
//
// WHY the server installs it: the in-app commander PTY (spawnSwarmManager)
// hands claude `/og-manage` as its positional prompt, so the skill file must
// exist in the USER scope for that session to resolve it. The canonical text
// lives in THIS repo (skills/og-manage/SKILL.md) and ships with the app; a
// guarded swarm worker cannot write under ~/.claude (the A3 guard's write
// roots deny it — deliberately, so a policed session can never rewrite skills
// or the guard itself), and asking the user to hand-copy a file would break
// "works out of the box". So the SERVER process (outside any per-session
// guard) installs it idempotently at boot — exactly the hooksInstall.ts
// pattern that wires openground-guard.js.
//
// Ownership contract (mirrors hooksInstall's "never touch user-authored"):
//   - target missing                    → install (first boot / new machine).
//   - target carries our managed-by marker → OURS; rewrite when the content
//     drifted from the shipped source (version-follow on app update).
//   - target WITHOUT the marker         → a user-authored file that happens to
//     share the name; NEVER overwritten ('kept-user'). Deleting the marker is
//     therefore the documented way for a user to take ownership of the file.

import { join } from 'path'
import { homedir } from 'os'
import { resolveHookSourceRoot } from './hooksInstall'
import { assertTestHomeIsolated } from './testHomeGuard'
import { installManagedFile, type ManagedFileOutcome, type ManagedFileResult } from './managedFileInstall'

/** The ownership marker burned into the shipped skill (an HTML comment right
 *  after the frontmatter). Its ABSENCE in an existing target file marks that
 *  file user-authored — the installer then never touches it. */
export const OG_MANAGE_SKILL_MARKER = 'managed-by: openground'

/** Canonical source inside the app checkout / bundle — resolved through the
 *  same module-anchored, worktree-refusing root as hooksInstall.ts (NOT
 *  process.cwd(): a wrong boot cwd used to make this ENOENT, and an engine
 *  running from a swarm worktree must not ship that worktree's skill text
 *  into ~/.claude). null when no safe root exists — reported as an 'error'
 *  outcome, never thrown. */
const sourcePath = (): { file: string | null; problem: string | null } => {
  const { root, problem } = resolveHookSourceRoot()
  return root
    ? { file: join(root, 'skills', 'og-manage', 'SKILL.md'), problem: null }
    : { file: null, problem }
}

// FENCED (testHomeGuard.ts): installOgManageSkill() takes no required args and
// production callers pass none (server/index.ts, swarmManager.ts), so any test
// that reaches spawnSwarmManager would overwrite the user's REAL
// ~/.claude/skills/og-manage/SKILL.md. Not reachable today only because
// swarmManager.test.ts imports just the launch-opts helper — one import away.
const installedPath = (): string => {
  const home = homedir()
  assertTestHomeIsolated(home, 'ogManageSkill (homedir()/.claude/skills)')
  return join(home, '.claude', 'skills', 'og-manage', 'SKILL.md')
}

export type OgManageSkillOutcome = ManagedFileOutcome
export type OgManageSkillResult = ManagedFileResult

/** Idempotently install/refresh ~/.claude/skills/og-manage/SKILL.md from the
 *  shipped source. Never throws — boot must not die on a skill-install hiccup
 *  (the commander degrades to "skill missing", which the next boot repairs).
 *  `opts` exist for tests only (isolated tmp source/target); production callers
 *  pass nothing. */
export const installOgManageSkill = async (
  opts: { sourceFile?: string; targetFile?: string } = {},
): Promise<OgManageSkillResult> => {
  const target = opts.targetFile ?? installedPath()
  let source = opts.sourceFile ?? null
  if (source === null) {
    const resolved = sourcePath()
    if (resolved.file === null) {
      return {
        outcome: 'error',
        path: target,
        error: `skill source unresolvable: ${resolved.problem}`,
      }
    }
    source = resolved.file
  }
  return installManagedFile({ source, target, marker: OG_MANAGE_SKILL_MARKER })
}
