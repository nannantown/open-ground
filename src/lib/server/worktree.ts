import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { access, readdir, rm, mkdir, stat } from 'fs/promises'
import { basename, join } from 'path'

// A worktree dir younger than this is assumed to belong to an in-flight
// `git worktree add` (which creates the directory before it finishes
// registering) — GC skips it so a concurrent run isn't rm'd mid-creation.
const WORKTREE_GC_MIN_AGE_MS = 60_000

const execFile = promisify(execFileCb)

export interface WorktreeInfo {
  worktreePath: string
  branch: string
}

// Cache per process so we don't shell out on every task start.
const gitCache = new Map<string, boolean>()

export const hasGit = async (projectPath: string): Promise<boolean> => {
  if (gitCache.has(projectPath)) return gitCache.get(projectPath)!
  try {
    await execFile('git', ['rev-parse', '--git-dir'], { cwd: projectPath })
    gitCache.set(projectPath, true)
    return true
  } catch {
    gitCache.set(projectPath, false)
    return false
  }
}

// Worktrees live inside the project's .openground directory so they're out
// of the way and consistent across all projects.
const worktreesDir = (projectPath: string) => join(projectPath, '.openground', 'worktrees')

export const createWorktree = async (
  projectPath: string,
  id: string,
): Promise<WorktreeInfo> => {
  const dir = worktreesDir(projectPath)
  await mkdir(dir, { recursive: true })
  const worktreePath = join(dir, id)
  const branch = `openground/${id}`
  await execFile('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: projectPath })
  return { worktreePath, branch }
}

// Commit any uncommitted changes so the worktree branch has a clean state
// before merge. Claude sometimes leaves changes staged or unstaged.
export const autoCommitIfDirty = async (cwd: string, message: string): Promise<void> => {
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd })
    if (!stdout.trim()) return
    await execFile('git', ['add', '-A'], { cwd })
    await execFile('git', ['commit', '-m', `OPEN GROUND: ${message}`], { cwd })
  } catch {
    // If git commit fails (e.g. nothing to commit after add) that's fine.
  }
}

// Merge the worktree branch into the current HEAD of the main directory, then
// clean up. Returns:
//   'merged'       — clean merge, worktree removed
//   'conflict'     — merge stopped on conflicts, --abort succeeded, worktree
//                    kept so resolveConflict can rerun Claude inside it
//   'failed-fatal' — both merge AND --abort failed (git index lock, perms,
//                    half-corrupt repo). The repo's HEAD may be in an
//                    intermediate state; UI must surface "open the worktree
//                    in your editor" rather than try another resolve cycle.
export const mergeAndCleanup = async (
  projectPath: string,
  info: WorktreeInfo,
): Promise<'merged' | 'conflict' | 'failed-fatal'> => {
  let merged = false
  try {
    await execFile(
      'git',
      ['merge', '--no-ff', info.branch, '-m', `OPEN GROUND merge: ${info.branch}`],
      { cwd: projectPath },
    )
    merged = true
    // Restore .openground/ from HEAD so task metadata is never overwritten by merge.
    await execFile('git', ['checkout', 'HEAD', '--', '.openground/'], { cwd: projectPath }).catch(() => {})
  } catch {
    // Merge failed — try to abort cleanly and leave the worktree for the
    // user to fix manually. Track abort outcome separately so we can
    // distinguish "clean conflict" from "git is locked / broken".
    let abortOk = true
    try {
      await execFile('git', ['merge', '--abort'], { cwd: projectPath })
    } catch {
      abortOk = false
    }
    return abortOk ? 'conflict' : 'failed-fatal'
  } finally {
    if (merged) {
      // Remove the worktree and its branch only on success.
      await execFile('git', ['worktree', 'remove', '--force', info.worktreePath], {
        cwd: projectPath,
      }).catch(() => {})
      await execFile('git', ['branch', '-D', info.branch], { cwd: projectPath }).catch(() => {})
    }
  }
  return 'merged'
}

// Remove a worktree without merging — for cancelled/error runs.
export const removeWorktree = async (
  projectPath: string,
  info: WorktreeInfo,
): Promise<void> => {
  await execFile('git', ['worktree', 'remove', '--force', info.worktreePath], {
    cwd: projectPath,
  }).catch(() => {})
  await execFile('git', ['branch', '-D', info.branch], { cwd: projectPath }).catch(() => {})
}

// Called on server startup: remove any stale worktrees left by a previous
// crashed process. Best-effort — if git complains we just skip.
export const cleanupStaleWorktrees = async (projectPath: string): Promise<void> => {
  const dir = worktreesDir(projectPath)
  try {
    await access(dir)
  } catch {
    return // directory doesn't exist
  }
  // `git worktree prune` removes stale worktree admin refs in one shot.
  await execFile('git', ['worktree', 'prune'], { cwd: projectPath }).catch(() => {})
  // Read the registered-worktree set ONCE (was one git call per entry = O(N²)).
  // Match by the trailing dir name (= worktree id), not by full-path substring:
  //  - substring `includes(p)` treated a leftover dir whose path is a prefix of
  //    a live worktree's path as "registered" and never cleaned it (leak);
  //  - full-path equality is brittle because git canonicalizes symlinks
  //    (/var → /private/var on macOS), which could mismatch a live worktree and
  //    delete it. The id basename is identical regardless of canonicalization.
  const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], {
    cwd: projectPath,
  }).catch(() => ({ stdout: '' }))
  const registeredIds = new Set(
    stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => basename(l.slice('worktree '.length).trim())),
  )
  const entries = await readdir(dir).catch(() => [] as string[])
  const now = Date.now()
  for (const name of entries) {
    if (registeredIds.has(name)) continue
    const p = join(dir, name)
    // Don't rm a directory a concurrent `git worktree add` just created but
    // hasn't registered yet.
    try {
      const st = await stat(p)
      if (now - st.mtimeMs < WORKTREE_GC_MIN_AGE_MS) continue
    } catch {
      continue // vanished between readdir and stat — nothing to do
    }
    await rm(p, { recursive: true, force: true }).catch(() => {})
  }
}
