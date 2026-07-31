import { realpathSync } from 'fs'

// Mirror of the (canonical) directory naming Claude Code uses when persisting
// session JSONLs under ~/.claude/projects/<dir>/<session-id>.jsonl.
//
// Claude derives the dir name from the absolute project cwd by replacing
// EVERY non-alphanumeric character with `-` (one `-` per character — runs are
// not collapsed):
//   - POSIX: `/Users/me/projects/OPEN GROUND` → `-Users-me-projects-OPEN-GROUND`
//   - Windows: the backslash separator and the drive colon fall out of the same
//     rule, e.g. `C:\Users\foo\My Proj` → `C--Users-foo-My-Proj`
//
// ⚠ THIS USED TO BE A CHARACTER LIST (`/`, `.`, `\`, `:`, space) AND THAT WAS
// WRONG — measured 2026-07-30. `_` was missing from it, so every project whose
// path contained an underscore resolved to a directory that does not exist, and
// every transcript-backed reading silently degraded to "no evidence":
// swarmTranscriptProof, the orchestrator's stall probe + subagent-activity probe
// + consumption read, swarmSessions' resumability probe, claudeUsage,
// sessionContext. All of those fail OPEN, so the symptom was never an error —
// just decisions made on absent data.
//
// The rule was established by measuring the CLI, not by reading it:
//   `/private/tmp/ogprobechars_vtkh/x.y_z+w@v e-f~g`
//     → `-private-tmp-ogprobechars-vtkh-x-y-z-w-v-e-f-g`
//   (`/` `_` `.` `+` `@` space `~` all became `-`; `-` passed through)
// and corroborated across 560 real dirs in ~/.claude/projects, whose names
// contain NO character other than [A-Za-z0-9-] — except five stale dirs from
// 2026-07-24/28 that still carry `_`, i.e. the CLI's own rule tightened and
// this mirror had not followed. Re-measure with a live run before editing;
// an existing directory listing is history, not the current rule.
//
// The cwd is realpath'd first because Claude follows symlinks before
// hyphenating — on macOS `/tmp` resolves to `/private/tmp`, so a session run
// from `/tmp/x` lands in `~/.claude/projects/-private-tmp-x/`. On a path that
// doesn't exist yet (a worktree-creation race) realpath throws and we fall
// back to the literal path; the observer retries on the next dir-watch event.
//
// NOTE: This is a pure string transform of the (realpath'd) input so it can be
// unit-tested for both POSIX and Windows paths regardless of host OS.
export const claudeDirName = (cwd: string): string => {
  let canonical = cwd
  try {
    canonical = realpathSync(cwd)
  } catch {
    // The cwd may not exist yet — fall back to the literal path.
  }
  return canonical.replace(/[^a-zA-Z0-9]/g, '-')
}
