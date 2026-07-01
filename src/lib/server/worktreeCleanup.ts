// worktreeCleanup — sweep the worktrees that pile up under a project's CENTRAL
// worktrees dir (~/.openground/projects/<uuid>/worktrees/): claude's task/*
// checkouts and the reviewer's review-* checkouts (B012 / Board flow F082).
//
// Safety rules, in order of importance:
//   - Only worktrees whose dir sits AT-OR-UNDER the central worktrees dir are
//     ever touched — the main working tree and any user-made worktree
//     elsewhere on disk are invisible to this module. Both sides of the
//     prefix check are canonicalized (macOS /var→/private/var, symlinked
//     test homes), and the comparison is sep-terminated so `worktrees-evil`
//     can't match `worktrees`.
//   - A DIRTY worktree (any `git status --porcelain` output — staged,
//     unstaged, or untracked) is never removed, only reported. A status
//     probe that FAILS also counts as dirty: when in doubt, keep it.
//   - A worktree a LIVE claude PTY is working in is never removed even when
//     clean (a freshly-launched or just-committed tree is clean while the
//     session runs in it). The pool's live cwds are canonicalized to the same
//     form as the worktree dir before matching, so a symlink-only difference
//     can't read as "not live" (see cleanProjectWorktrees).
//   - All git calls are execFile with argv arrays (never a shell string).

import { execFile as execFileCb } from 'child_process'
import { listActiveTerminalCwds } from './terminal'
import { promisify } from 'util'
import { sep } from 'path'
import { canonicalize } from './canonicalize'
import { centralWorktreesDir } from './paths'
import { projectUUIDFromPath } from './projectDataPath'
import { removeClaudeFolderTrust } from './claudeTrust'
import type { ProjectWorktreeInfo, CleanWorktreesResult } from '../types'

const execFile = promisify(execFileCb)

/** Run git in `cwd`; null on any failure (no git, not a repo, …). */
const git = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', args, { cwd })
    return stdout
  } catch {
    return null
  }
}

/** Parse `git worktree list --porcelain` into { dir, branch } entries.
 *  branch is the short ref name, or null (detached HEAD / bare). The FIRST
 *  entry git prints is always the main working tree — callers filter by
 *  location, so it is included here. Exported for unit tests (pure). */
export const parseWorktreePorcelain = (
  out: string,
): { dir: string; branch: string | null }[] => {
  const entries: { dir: string; branch: string | null }[] = []
  let current: { dir: string; branch: string | null } | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { dir: line.slice('worktree '.length).trim(), branch: null }
    } else if (line.startsWith('branch ') && current) {
      current.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '')
    }
  }
  if (current) entries.push(current)
  return entries
}

/** Is `target` the dir `root` itself, or a descendant? Both must already be
 *  canonical. Exported for unit tests (pure). */
export const isUnderCentralDir = (target: string, root: string): boolean =>
  target === root || target.startsWith(root + sep)

/** The canonical central worktrees dir for the project owning `projectPath`.
 *  Throws when no registered project owns the path (same contract as
 *  projectUUIDFromPath — routes have already passed validateProjectPath). */
const canonicalCentralDir = async (projectPath: string): Promise<string> =>
  canonicalize(centralWorktreesDir(await projectUUIDFromPath(projectPath)))

/** Worktrees of this repo living under the project's central worktrees dir.
 *  `dirty` = any status output (or a failed probe — treated as dirty so the
 *  cleaner never removes something it can't see into). Non-git folder or any
 *  listing failure degrades to []. */
export const listProjectWorktrees = async (
  projectPath: string,
): Promise<ProjectWorktreeInfo[]> => {
  const central = await canonicalCentralDir(projectPath)
  const out = await git(projectPath, ['worktree', 'list', '--porcelain'])
  if (!out) return []
  const result: ProjectWorktreeInfo[] = []
  for (const entry of parseWorktreePorcelain(out)) {
    const dir = await canonicalize(entry.dir)
    if (!isUnderCentralDir(dir, central)) continue
    const status = await git(dir, ['status', '--porcelain'])
    result.push({
      dir,
      branch: entry.branch,
      dirty: status === null || status.trim() !== '',
    })
  }
  return result
}

/** Remove every CLEAN central worktree of this repo (dirty ones are skipped,
 *  never forced), then `git worktree prune` to drop stale bookkeeping. */
export const cleanProjectWorktrees = async (
  projectPath: string,
): Promise<CleanWorktreesResult> => {
  const removed: string[] = []
  const skippedDirty: string[] = []
  // The trust prune below must drop the SAME ~/.claude.json key launchClaude
  // seeded — and that seed used the worktree's RAW (pre-realpath) path:
  // createSwarmWorktree builds it from centralWorktreesDir(uuid), rooted at
  // openGroundHome() VERBATIM, so under a SYMLINKED home the seed key is the
  // un-resolved form (ensureClaudeFolderTrusted's pathKeys seeds that AND its
  // realpath — two keys). But listProjectWorktrees canonicalizes every dir
  // (git itself reports already-resolved paths), so wt.dir is ONLY the resolved
  // form; pruning by it would leak the raw-form key forever — and the raw form
  // is unrecoverable from git's listing. Rebuild it by re-rooting each
  // worktree's central-relative tail on the UN-canonicalized central dir; the
  // canonical central is needed to slice that tail off wt.dir.
  const rawCentral = centralWorktreesDir(await projectUUIDFromPath(projectPath))
  const canonCentral = await canonicalize(rawCentral)
  // A clean tree says nothing about a LIVE claude session working in it —
  // right after launch (or right after a mid-task commit) the tree is clean
  // while the PTY's cwd is the worktree. Deleting a running session's cwd
  // out from under it is never acceptable; the pool knows every live cwd.
  //
  // The pool stores each PTY's RAW spawn cwd (createTerminal keeps opts.cwd
  // verbatim), which can be in a different normalization form than wt.dir —
  // that one is canonicalized in listProjectWorktrees (macOS /var→/private/var,
  // symlinked home dirs). Canonicalize the live cwds to the SAME form before
  // matching; otherwise a symlink-only difference makes isLive return false and
  // the running worktree gets removed out from under the session.
  const liveCwds = await Promise.all(
    listActiveTerminalCwds().map((cwd) => canonicalize(cwd)),
  )
  const isLive = (dir: string) =>
    liveCwds.some((cwd) => cwd === dir || cwd.startsWith(dir + sep))
  for (const wt of await listProjectWorktrees(projectPath)) {
    if (wt.dirty || isLive(wt.dir)) {
      skippedDirty.push(wt.dir)
      continue
    }
    // Rebuild the RAW seed path LEXICALLY (re-root the central-relative tail on
    // the un-canonicalized central) — launchClaude seeded BOTH this raw key and
    // its realpath, but listProjectWorktrees only yields the resolved wt.dir.
    const rawDir = rawCentral + wt.dir.slice(canonCentral.length)
    // No --force: even after our own dirty probe, git re-checks and refuses
    // a worktree that picked up changes in the race window — that refusal
    // lands in skippedDirty instead of destroying work.
    const ok = await git(projectPath, ['worktree', 'remove', wt.dir])
    if (ok !== null) {
      removed.push(wt.dir)
      // CONFIRMED gone (task/* and review-* checkouts both launch via launchClaude,
      // which seeds a ~/.claude.json folder-trust entry). Drop it so swept paths
      // don't pile up in claude's projects map. The dir no longer exists so pathKeys
      // can't realpath either form — delete BOTH known keys by literal lookup: the
      // RAW seed key (else it leaks forever under a symlinked home) and the resolved
      // key (== wt.dir). A REFUSED worktree is left WHOLLY untouched below: it
      // survives and may host a live session, so its full entry (history /
      // mcpServers / allowedTools, not just the trust flag) must be preserved —
      // pruning only on confirmed removal is the sole way to never mutate it.
      removeClaudeFolderTrust(rawDir)
      removeClaudeFolderTrust(wt.dir)
    } else {
      skippedDirty.push(wt.dir)
    }
  }
  await git(projectPath, ['worktree', 'prune'])
  return { removed, skippedDirty }
}
