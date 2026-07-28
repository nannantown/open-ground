import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
