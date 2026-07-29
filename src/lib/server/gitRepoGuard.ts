import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * True iff `cwd` is a git repo/worktree ROOT — it has a `.git` entry (a `.git`
 * DIR for a main clone, or a `.git` gitdir-pointer FILE for a linked worktree).
 *
 * WHY THIS EXISTS (2026-07-28 machine-freeze post-mortem): every swarm `git()`
 * helper spawns `execFile('git', …, { cwd })`. When `cwd` is NOT a repo — most
 * importantly a test's `mkdtemp` temp dir, or any dir being `rm -rf`'d out from
 * under a still-running git — `git` walks the filesystem looking for a repo and,
 * if the dir vanishes mid-syscall, wedges in UNINTERRUPTIBLE (`U`) sleep that
 * NEITHER a SIGKILL NOR execFile's own `timeout` can reap (the signal is only
 * delivered when the process returns from the kernel, which never happens). Such
 * orphans (reparented to launchd) accumulate and congest the machine until a
 * reboot — observed as dozens of 5-hour-hung `git` from swarm unit tests whose
 * `afterEach` deleted the temp cwd while a fire-and-forget engine pass still had
 * git in flight.
 *
 * Gating every swarm git spawn on this check makes that impossible: a non-repo
 * cwd never spawns git at all (the helper returns its usual null/failure value),
 * so nothing can wedge. Every swarm cwd is a repo/worktree ROOT (project path,
 * worktree path), so a root-level `.git` check is exact for this codebase — a
 * sub-directory of a repo is never passed as a git cwd here. `existsSync` is a
 * single cheap stat, far cheaper than the subprocess spawn it guards, and it is
 * cross-platform (Windows-safe via `join`).
 */
export const isGitRepoRoot = (cwd: string): boolean => existsSync(join(cwd, '.git'))

/**
 * Is `cwd` inside a git repo — itself a root, OR any descendant of one?
 *
 * NARROW PURPOSE, and it must stay narrow. A handful of calls exist whose WHOLE
 * JOB is to walk upward and find the repo root (`git rev-parse --git-common-dir`
 * in swarmRepoKey). Gating those on {@link isGitRepoRoot} is wrong in the other
 * direction: a project the user registered as a SUB-DIRECTORY of a repo has no
 * `.git` of its own, so the guard returned null and the whole per-repo state
 * directory — worker heartbeats, roster.json, the commander's manager.json —
 * became unreachable. The engine then behaved as if a live repo had no memory.
 *
 * The wedge protection is preserved and is the FIRST thing checked: a cwd that
 * does not exist (the removed-out-from-under-us case that puts `git` into
 * uninterruptible sleep — 07 章 §7) returns false before any walk. Beyond that
 * this is pure fs — it never spawns anything — and terminates at the filesystem
 * root.
 *
 * DO NOT widen this to the general git helpers. `isGitRepoRoot` is what keeps
 * them from spawning git in a non-repo; swapping in this looser predicate would
 * re-open exactly the hole §7.4 closed (and would turn the self-supply teeth in
 * swarmSelfSupply.test.ts red, which is the intended alarm).
 */
export const isUnderGitRepo = (cwd: string): boolean => {
  if (!existsSync(cwd)) return false // vanished cwd — never spawn into it
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false // reached the filesystem root
    dir = parent
  }
}
