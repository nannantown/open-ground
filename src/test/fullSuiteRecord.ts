// The full-suite pass record: what the full-suite gate (fullSuiteGate.ts)
// writes when a whole-suite run ends on a clean tree, and the commander's check
// that reads it. Kept apart from the gate so a plain tsx script
// (scripts/full-suite-passed.mts) can import it without loading vitest.

import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export function git(args: string[], cwd?: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** The tree id of HEAD if the working tree is clean (untracked files count as
 *  dirty), else null. Keyed on the tree, not the commit: rewording the WIP
 *  commit after the run leaves the tested content — and the record — valid. */
export function cleanTree(cwd?: string): string | null {
  return git(['status', '--porcelain', '--untracked-files=all'], cwd) === ''
    ? git(['rev-parse', 'HEAD^{tree}'], cwd)
    : null
}

/** File a finished clean full run is recorded in (per worktree). The commander
 *  reads it to skip re-running the suite on an unchanged, up-to-date HEAD. */
export const FULL_SUITE_RECORD = 'og-full-suite.json'

/** Gate side, from the vitest process's 'exit' handler: record the run's exit
 *  code for `startTree` (the clean tree it started on; null = started dirty,
 *  no record). The exit code (not the reporter's reason) is what counts:
 *  vitest 4.1.7 reports reason 'passed' even when unhandled errors turn the
 *  run red (exit 1). A tree changed mid-run needs no check here: the verdict
 *  compares the recorded tree with the tree that would land. */
export function writeRunRecord(gitDir: string, startTree: string | null, exitCode: number): void {
  if (!startTree) return
  writeFileSync(
    join(gitDir, FULL_SUITE_RECORD),
    JSON.stringify({ tree: startTree, exitCode, finishedAt: new Date().toISOString() }) + '\n',
  )
}

/**
 * Commander side (skills/og-manage "Re-verify"): may the full suite be skipped
 * for the worktree at `cwd`? Only when the last plain full run on exactly the
 * current (clean) tree exited 0, and HEAD already contains `base` — then an FF
 * push lands the very tree that was tested. Anything else (main moved, more
 * changes, dirty, failed, no record) = run the suite.
 */
export function fullSuiteVerdict(cwd: string, base = 'origin/main'): { ok: boolean; why: string } {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd)
  if (!gitDir) return { ok: false, why: 'not a git worktree' }
  let rec: { tree?: string; exitCode?: number }
  try {
    rec = JSON.parse(readFileSync(join(gitDir, FULL_SUITE_RECORD), 'utf8'))
  } catch {
    return { ok: false, why: 'no full-suite record' }
  }
  const tree = cleanTree(cwd)
  if (!tree) return { ok: false, why: 'tree is dirty (untracked files count)' }
  if (rec.tree !== tree) return { ok: false, why: 'the last full run was on different contents than HEAD' }
  if (rec.exitCode !== 0) return { ok: false, why: `the last full run on HEAD exited ${rec.exitCode}` }
  if (git(['merge-base', '--is-ancestor', base, 'HEAD'], cwd) === null)
    return { ok: false, why: `HEAD does not contain ${base} (rebase, then run the suite)` }
  return { ok: true, why: `full suite passed on HEAD's exact contents, which contain ${base}` }
}
