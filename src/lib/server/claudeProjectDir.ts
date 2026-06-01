import { realpathSync } from 'fs'

// Mirror of the (canonical) directory naming Claude Code uses when persisting
// session JSONLs under ~/.claude/projects/<dir>/<session-id>.jsonl.
//
// Claude derives the dir name from the absolute project cwd by replacing the
// path separators and a few other path chars with `-`:
//   - POSIX: `/`, `.`, and space  →  `-`
//     e.g. `/Users/me/projects/OPEN GROUND` → `-Users-me-projects-OPEN-GROUND`
//   - Windows: additionally the backslash separator `\` and the drive colon `:`
//     e.g. `C:\Users\foo\My Proj` → `C--Users-foo-My-Proj`
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
  return canonical.replace(/[/.\\: ]/g, '-')
}
