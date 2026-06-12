// branchChanges.ts — the "what's different on this branch?" view behind
// GET /api/project/branch-changes and GET /api/project/file-diff (ProjectPanel
// header chip + modal). Read-only git, house style of gitBranches.ts /
// mergedBranches.ts: every call is execFile with an argv array (never a shell
// string), network-free, and failure degrades instead of throwing — a non-repo
// dir answers { isGit: false }, a missing target just empties the committed
// section.
//
// Target resolution: the project's shared config targetBranch wins (sanitized
// through the same gate reviewWorktree uses before touching argv); otherwise
// the first of main / master that exists. The target REF prefers the local
// branch tip and falls back to origin/<name> — on a fresh clone the target may
// exist only as a remote-tracking ref.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { isAbsolute } from 'path'
import type {
  BranchChangesResponse,
  BranchCommittedChange,
  BranchWorkingChange,
  FileDiffResponse,
  FileDiffScope,
} from '../types'
import { sanitizeBranch } from './reviewWorktree'

const execFile = promisify(execFileCb)

// House convention (mergedBranches.ts / gitShare.ts): git never hangs on a
// credential prompt and gets a hard timeout. maxBuffer is generous because a
// big working tree's status / numstat can exceed node's 1MB default.
const GIT_OPTS = {
  timeout: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  maxBuffer: 32 * 1024 * 1024,
}

/** Run git in the project dir; null on any failure (no git, not a repo, …). */
const git = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', args, { cwd, ...GIT_OPTS })
    return stdout
  } catch {
    return null
  }
}

/** Does this FULL ref (refs/heads/x or refs/remotes/origin/x) exist? */
const refExists = async (cwd: string, ref: string): Promise<boolean> =>
  (await git(cwd, ['show-ref', '--verify', '--quiet', ref])) !== null

/** Resolve the target branch: configured name first (invalid → ignored, fall
 *  through to detection), else the first of main/master that exists. Returns
 *  the display NAME plus the concrete REF to diff against (local tip first,
 *  then origin's), or null when no target is resolvable. */
const resolveTarget = async (
  cwd: string,
  configured?: string,
): Promise<{ name: string; ref: string } | null> => {
  const candidates: string[] = []
  if (configured && configured.trim()) {
    try {
      candidates.push(sanitizeBranch(configured))
    } catch {
      /* unusable configured name — detection below */
    }
  }
  candidates.push('main', 'master')
  for (const name of candidates) {
    const local = `refs/heads/${name}`
    if (await refExists(cwd, local)) return { name, ref: local }
    const remote = `refs/remotes/origin/${name}`
    if (await refExists(cwd, remote)) return { name, ref: remote }
  }
  return null
}

/** `git status --porcelain -z` → {status, path}[]. -z so paths with spaces /
 *  non-ASCII arrive verbatim (no quoting); a rename/copy entry carries the
 *  ORIGINAL path as an extra NUL field, folded into "old → new" display. */
const parseStatusZ = (raw: string): BranchWorkingChange[] => {
  const out: BranchWorkingChange[] = []
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry.length < 4) continue // "XY path" minimum
    const status = entry.slice(0, 2).trim()
    let path = entry.slice(3)
    if (/[RC]/.test(entry.slice(0, 2))) {
      // Next NUL field is the rename/copy source.
      const from = fields[++i]
      if (from) path = `${from} → ${path}`
    }
    out.push({ status, path })
  }
  return out
}

/** `git diff --numstat` → {path, additions, deletions}[]. Binary files report
 *  "-\t-" — surfaced as 0/0 rather than dropped. */
const parseNumstat = (raw: string): BranchCommittedChange[] => {
  const out: BranchCommittedChange[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    out.push({
      path: m[3],
      additions: m[1] === '-' ? 0 : parseInt(m[1], 10),
      deletions: m[2] === '-' ? 0 : parseInt(m[2], 10),
    })
  }
  return out
}

export const getBranchChanges = async (
  projectPath: string,
  configuredTarget?: string,
): Promise<BranchChangesResponse> => {
  const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree'])
  if (inside === null || inside.trim() !== 'true') return { isGit: false }

  // Empty on detached HEAD; works on an unborn (commitless) branch too.
  const branchOut = await git(projectPath, ['branch', '--show-current'])
  const branch = branchOut?.trim() || null

  const statusOut = await git(projectPath, ['status', '--porcelain', '-z'])
  const working = statusOut ? parseStatusZ(statusOut) : []

  const target = await resolveTarget(projectPath, configuredTarget)
  const sameBranch = target !== null && branch !== null && branch === target.name

  let committed: BranchCommittedChange[] = []
  let ahead = 0
  let behind = 0
  if (target && !sameBranch) {
    const numstat = await git(projectPath, [
      'diff',
      '--numstat',
      `${target.ref}...HEAD`,
    ])
    committed = numstat ? parseNumstat(numstat) : []
    const counts = await git(projectPath, [
      'rev-list',
      '--left-right',
      '--count',
      `${target.ref}...HEAD`,
    ])
    const m = counts?.trim().match(/^(\d+)\s+(\d+)$/)
    if (m) {
      behind = parseInt(m[1], 10) // left = commits only in target
      ahead = parseInt(m[2], 10) // right = commits only on HEAD
    }
  }

  return {
    isGit: true,
    branch,
    target: target?.name ?? null,
    sameBranch,
    ahead,
    behind,
    working,
    committed,
  }
}

// ── file diff ────────────────────────────────────────────────────────────────

/** Repo-relative file guard for /api/project/file-diff: no absolute paths, no
 *  `..` segments (either separator), no NULs, non-empty. The path is only ever
 *  passed to git AFTER `--`, but this keeps traversal out structurally. */
export const isSafeRepoRelFile = (file: string): boolean => {
  if (!file || file.includes('\0')) return false
  if (isAbsolute(file) || file.startsWith('\\')) return false
  if (file.split(/[/\\]/).some((seg) => seg === '..')) return false
  return true
}

// Unified-diff payload cap. A pathological file (lockfile, generated bundle)
// can be megabytes of diff; the viewer truncates at a line boundary and says
// so instead of shipping it all to the browser.
export const MAX_DIFF_BYTES = 200_000

const truncateDiff = (text: string): FileDiffResponse => {
  if (text.length <= MAX_DIFF_BYTES) return { diff: text, truncated: false }
  const cut = text.lastIndexOf('\n', MAX_DIFF_BYTES)
  return { diff: text.slice(0, cut > 0 ? cut : MAX_DIFF_BYTES), truncated: true }
}

/** Full-content diff for an UNTRACKED file: `git diff --no-index /dev/null f`
 *  exits 1 when the file has content (that's "differs", not an error), with
 *  the diff on stdout — so the catch arm is the success path. */
const untrackedDiff = async (cwd: string, file: string): Promise<string> => {
  try {
    const { stdout } = await execFile(
      'git',
      ['diff', '--no-index', '--', '/dev/null', file],
      { cwd, ...GIT_OPTS },
    )
    return stdout
  } catch (e: unknown) {
    const err = e as { code?: unknown; stdout?: unknown }
    if (err?.code === 1 && typeof err.stdout === 'string') return err.stdout
    return ''
  }
}

/** Unified diff text for one file.
 *  - scope 'working': uncommitted changes vs HEAD (staged + unstaged), with
 *    the /dev/null trick for untracked files (full content as one + hunk).
 *  - scope 'branch': what the branch changed vs the merge-base with target
 *    (target...HEAD), mirroring the committed list. */
export const getFileDiff = async (
  projectPath: string,
  file: string,
  scope: FileDiffScope,
  configuredTarget?: string,
): Promise<FileDiffResponse> => {
  if (!isSafeRepoRelFile(file)) throw new Error('invalid file path')

  if (scope === 'branch') {
    const target = await resolveTarget(projectPath, configuredTarget)
    if (!target) return { diff: '', truncated: false }
    const out = await git(projectPath, ['diff', `${target.ref}...HEAD`, '--', file])
    return truncateDiff(out ?? '')
  }

  // working: HEAD-relative first (covers staged + unstaged in one view); a
  // commitless repo has no HEAD — fall back to the index-relative diff.
  let out = await git(projectPath, ['diff', 'HEAD', '--', file])
  if (out === null) out = await git(projectPath, ['diff', '--', file])
  if (!out || !out.trim()) {
    const status = await git(projectPath, ['status', '--porcelain', '--', file])
    if (status?.startsWith('??')) {
      return truncateDiff(await untrackedDiff(projectPath, file))
    }
  }
  return truncateDiff(out ?? '')
}
