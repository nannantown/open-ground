// gitBranches.ts — list a project's LOCAL git branches for the Settings UI
// ("Target branch" select). Read-only: two plumbing-ish git calls via execFile
// with argv arrays (never a shell string), so project paths with spaces or
// quotes can't be interpreted. Any failure — git missing, not a repo, no
// commits yet — degrades to { branches: [], current: null } instead of
// throwing: the UI just falls back to free-text entry.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import type { ProjectBranchesResponse } from '../types'

const execFile = promisify(execFileCb)

/** Run git in the project dir; null on any failure (no git, not a repo, …). */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', args, { cwd })
    return stdout
  } catch {
    return null
  }
}

export async function listProjectBranches(
  projectPath: string,
): Promise<ProjectBranchesResponse> {
  // refs/heads only — remote branches are not valid "Target branch" values.
  const refsOut = await git(projectPath, [
    'for-each-ref',
    'refs/heads',
    '--format=%(refname:short)',
  ])
  if (refsOut === null) return { branches: [], current: null }

  // Empty output on detached HEAD; treat as "no current branch".
  const currentOut = await git(projectPath, ['branch', '--show-current'])
  const reported = currentOut?.trim() || null

  const names = refsOut
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // INVARIANT: `current` is null or a member of `branches` — the select
  // consumer indexes options by it. A commitless repo reports its UNBORN
  // branch name via --show-current while refs/heads is still empty; clamp
  // that (and any other mismatch) to null instead of leaking a phantom ref.
  const current = reported && names.includes(reported) ? reported : null

  const rest = names.filter((n) => n !== current).sort()
  const branches = current ? [current, ...rest] : rest

  return { branches, current }
}
