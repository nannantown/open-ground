// activeBranches.ts — list a project's LOCAL branches, each annotated with the
// worktree it's currently checked out in (its "active" location). Powers the
// ProjectPanel header branch dropdown. Read-only: git via execFile argv arrays
// (never a shell string), so project paths with spaces or quotes can't be
// interpreted; every failure — git missing, not a repo, no commits — degrades
// to { isGit: false, branches: [] } instead of throwing. Same house style as
// gitBranches.ts; reuses parseWorktreePorcelain from worktreeCleanup.ts.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { parseWorktreePorcelain } from './worktreeCleanup'
import { isGitRepoRoot } from './gitRepoGuard'
import type { ActiveBranchesResponse } from '../types'

const execFile = promisify(execFileCb)

/** Run git in the project dir; null on any failure (no git, not a repo, …). */
async function git(cwd: string, args: string[]): Promise<string | null> {
  if (!isGitRepoRoot(cwd)) return null // never spawn git in a non-repo/vanishing cwd (gitRepoGuard)
  try {
    const { stdout } = await execFile('git', args, { cwd })
    return stdout
  } catch {
    return null
  }
}

export async function listActiveBranches(
  projectPath: string,
): Promise<ActiveBranchesResponse> {
  // `git worktree list` succeeds in any repo (≥1 entry: the main tree). null
  // means no git / not a repo — the chip doesn't render anyway.
  const wtOut = await git(projectPath, ['worktree', 'list', '--porcelain'])
  if (wtOut === null) return { isGit: false, branches: [] }

  // branch → the worktree dir it's checked out in. Detached/bare entries
  // (branch null) contribute no mapping.
  const checkedOut = new Map<string, string>()
  for (const w of parseWorktreePorcelain(wtOut)) {
    if (w.branch) checkedOut.set(w.branch, w.dir)
  }

  // All local heads — the dropdown lists every branch, not only the
  // checked-out ones, so a plain branch (no worktree) is still visible.
  const refsOut = await git(projectPath, [
    'for-each-ref',
    'refs/heads',
    '--format=%(refname:short)',
  ])
  const names = (refsOut ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // Empty output on detached HEAD → no current branch.
  const currentOut = await git(projectPath, ['branch', '--show-current'])
  const reported = currentOut?.trim() || null

  // Union of heads and any checked-out branch name (defensive — a worktree's
  // branch is normally already a head). `current` is honored only when it's a
  // real head: a commitless repo reports an UNBORN branch via --show-current
  // while refs/heads is still empty; clamp that phantom to null.
  const set = new Set(names)
  checkedOut.forEach((_dir, b) => set.add(b))
  const current = reported && set.has(reported) ? reported : null

  const rest = Array.from(set)
    .filter((n) => n !== current)
    .sort((a, b) => a.localeCompare(b))
  const ordered = current ? [current, ...rest] : rest

  return {
    isGit: true,
    branches: ordered.map((name) => ({
      name,
      current: name === current,
      worktreePath: checkedOut.get(name) ?? null,
    })),
  }
}
