// reviewWorktree — give a REVIEWER a local checkout of a task branch in one
// click (Board flow F061). Ensures a git worktree for the branch under the
// project's CENTRAL worktrees dir (validateProjectPath already admits it) and
// returns its absolute path; the route then reveals it in the file manager.
//
// Reuse rules, in order:
//   1. The branch is already checked out in SOME worktree of this repo (on the
//      author's machine that's the task worktree claude created) — reuse it.
//   2. A previous review worktree exists at our deterministic path — fast-
//      forward it (best-effort) and reuse.
//   3. Otherwise `git worktree add` — from the local branch when it exists,
//      else tracking origin/<branch> (the reviewer's machine usually only has
//      the remote ref; we fetch first, best-effort so offline still works for
//      local branches).
//
// All git calls are execFile with argv arrays (never a shell string).

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdir, realpath } from 'fs/promises'
import { join, sep } from 'path'
import { createHash } from 'crypto'
import { centralWorktreesDir } from './paths'
import { isGitRepoRoot } from './gitRepoGuard'
import { projectUUIDFromPath } from './projectDataPath'

const execFile = promisify(execFileCb)

// House convention (mergedBranches.ts): network git must never hang on a
// credential prompt, and gets a hard timeout.
const GIT_OPTS = {
  timeout: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}

// Branch names reach git argv — refuse anything that could read as an option
// or escape a path. git's own charset rules are looser; this subset covers
// every branch this app itself creates (task/<kebab>) plus normal human names.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** Machine-readable failure category for the review-worktree route — the
 *  client maps these to localized copy instead of echoing raw git English. */
export type ReviewWorktreeErrorCode = 'invalid-branch' | 'not-pushed' | 'git-failed'

/** Error with a stable `code` the route forwards as `{ error, code }`. */
export class ReviewWorktreeError extends Error {
  code: ReviewWorktreeErrorCode
  constructor(message: string, code: ReviewWorktreeErrorCode) {
    super(message)
    this.code = code
  }
}

/** Validate + normalize a branch name for use below. Throws on anything that
 *  could read as a git option (leading '-') or path escape ('..'). Exported
 *  for unit tests. */
export const sanitizeBranch = (branch: string): string => {
  const b = branch.trim()
  if (!b || b.length > 250) throw new ReviewWorktreeError('invalid branch name', 'invalid-branch')
  if (!BRANCH_RE.test(b)) throw new ReviewWorktreeError('invalid branch name', 'invalid-branch')
  if (b.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new ReviewWorktreeError('invalid branch name', 'invalid-branch')
  }
  return b
}

/** The deterministic review-worktree dir name for a branch ('/' → '-', with a
 *  review- prefix so it never collides with claude's task worktrees, which
 *  live in the same parent). Exported for unit tests. */
export const reviewWorktreeName = (branch: string): string =>
  // The short hash disambiguates names that flatten identically
  // ('task/foo-bar' vs 'task-foo-bar' both read review-task-foo-bar-…).
  'review-' +
  branch.replace(/\//g, '-') +
  '-' +
  createHash('sha1').update(branch).digest('hex').slice(0, 6)

const git = async (cwd: string, args: string[]): Promise<string | null> => {
  if (!isGitRepoRoot(cwd)) return null // gitRepoGuard: never spawn git in a non-repo/vanishing cwd
  try {
    const { stdout } = await execFile('git', args, { cwd, ...GIT_OPTS })
    return stdout
  } catch {
    return null
  }
}

/** True when `dir` sits under the project's central worktrees dir (both sides
 *  canonicalized). Only THERE may this module mutate a checkout — pulling
 *  inside the user's main tree (or any hand-made worktree) would move files
 *  under their feet. */
const isCentralWorktree = async (projectPath: string, dir: string): Promise<boolean> => {
  try {
    const parent = await realpath(centralWorktreesDir(await projectUUIDFromPath(projectPath)))
    const real = await realpath(dir)
    return real === parent || real.startsWith(parent + sep)
  } catch {
    return false
  }
}

/** Where `branch` is already checked out among this repo's worktrees, or null. */
const worktreeForBranch = async (
  projectPath: string,
  branch: string,
): Promise<string | null> => {
  const out = await git(projectPath, ['worktree', 'list', '--porcelain'])
  if (!out) return null
  let dir: string | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ') && dir) {
      const ref = line.slice('branch '.length).trim()
      if (ref === `refs/heads/${branch}`) return dir
    }
  }
  return null
}

/** Ensure a local checkout of `branch` and return its absolute path. */
export const ensureReviewWorktree = async (
  projectPath: string,
  rawBranch: string,
): Promise<{ dir: string; created: boolean }> => {
  const branch = sanitizeBranch(rawBranch)

  // Freshen the remote ref first — best-effort (offline reviewers can still
  // open a branch they already have).
  await git(projectPath, ['fetch', 'origin', branch])

  // 1. Already checked out somewhere. Mutate (pull) ONLY central worktrees —
  //    the main tree / a hand-made worktree / claude's live task worktree is
  //    returned untouched: moving files under a person's (or session's) feet
  //    is never this module's call.
  const existing = await worktreeForBranch(projectPath, branch)
  if (existing) {
    if (await isCentralWorktree(projectPath, existing)) {
      await git(existing, ['pull', '--ff-only'])
    }
    return { dir: existing, created: false }
  }

  const parent = centralWorktreesDir(await projectUUIDFromPath(projectPath))
  await mkdir(parent, { recursive: true })
  const dir = join(parent, reviewWorktreeName(branch))

  // 3. Create: local branch if present, else track the remote one.
  const local = await git(projectPath, [
    'show-ref',
    '--verify',
    `refs/heads/${branch}`,
  ])
  const added =
    local !== null
      ? await git(projectPath, ['worktree', 'add', dir, branch])
      : await git(projectPath, [
          'worktree',
          'add',
          '--track',
          '-b',
          branch,
          dir,
          `origin/${branch}`,
        ])
  if (added === null) {
    // 2. A stale dir from a previous review round makes `worktree add` fail —
    //    if it IS a worktree on this branch, freshen + reuse.
    const again = await worktreeForBranch(projectPath, branch)
    if (again) {
      if (await isCentralWorktree(projectPath, again)) {
        await git(again, ['pull', '--ff-only'])
      }
      return { dir: again, created: false }
    }
    throw new ReviewWorktreeError(
      `could not check out '${branch}' — was it pushed?`,
      'not-pushed',
    )
  }
  return { dir, created: true }
}
