// src/lib/server/gitShare.ts — the git engine behind "Share via Git".
//
// Pure git, no GitHub API (docs/SHARED_DATA_PLAN.md, locked decision #1): the
// project's existing `git remote` + the user's own git auth do all the work.
// Every command runs via execFile('git', [...]) with cwd = the validated
// project path — never a shell string, so paths/args can't be injected.
//
// HARD SCOPE RULE: add/commit are ALWAYS pathspec-limited to `.openground/`.
// The app never touches paths outside `.openground/` and never disturbs the
// user's staged code changes (a pathspec commit records the working-tree state
// of those paths only and leaves the rest of the index exactly as it was).
// `git stash` is never invoked explicitly — `--autostash` is git-internal and
// self-restoring (repo-discipline: no stashes a later session can't see).

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { isAbsolute, join } from 'path'
import { stat } from 'fs/promises'
import type { ShareStatus, ShareSyncResult } from '../types'
import { isShared, SHARED_DIR, SHARED_MARKER_FILE } from './sharedData'

const execFile = promisify(execFileCb)

// Local plumbing (rev-parse / status / add / commit) is bounded by disk speed;
// pull/push talk to a remote and get the long leash.
const LOCAL_TIMEOUT_MS = 10_000
const NETWORK_TIMEOUT_MS = 60_000

const git = (
  projectPath: string,
  args: string[],
  timeout: number = LOCAL_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> =>
  execFile('git', args, {
    cwd: projectPath,
    timeout,
    // Never let a credential prompt hang the server: a missing credential
    // must fail fast (and surface as a useful `message`), not block 60s.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })

/** Best human-readable text out of a (promisified) execFile error. */
const gitErrorText = (e: unknown): string => {
  const err = e as { stderr?: unknown; stdout?: unknown; message?: unknown }
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
  if (stderr) return stderr
  const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : ''
  if (stdout) return stdout
  return typeof err?.message === 'string' ? err.message : String(e)
}

/** First non-empty line — git errors are multi-paragraph; toasts want one. */
const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.replace(/^(fatal|error|warning):\s*/i, '').trim())
    .find((l) => l.length > 0) ?? text.trim()

// "There is nothing to pull from / push to" failure modes — not errors for
// sync, just facts about a repo that has no remote (yet). Matched loosely
// because the exact phrasing varies across git versions.
const NO_UPSTREAM_RE =
  /no tracking information|no upstream branch|no configured push destination|no remote repository specified|does not appear to be a git repository|'origin' does not exist|could not read from remote repository/i

const isGitRepo = async (projectPath: string): Promise<boolean> => {
  try {
    const { stdout } = await git(projectPath, ['rev-parse', '--is-inside-work-tree'])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

const getRemoteUrl = async (projectPath: string): Promise<string | null> => {
  try {
    const { stdout } = await git(projectPath, ['remote', 'get-url', 'origin'])
    const url = stdout.trim()
    return url || null
  } catch {
    return null
  }
}

/** Any working-tree / index changes under `.openground/`? (false on error —
 *  e.g. not a git repo — so callers can use it unconditionally). */
const openGroundDirty = async (projectPath: string): Promise<boolean> => {
  try {
    const { stdout } = await git(projectPath, ['status', '--porcelain', '--', SHARED_DIR])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/** Is a rebase mid-flight? Checks both rebase state dirs (`rebase-merge` for
 *  the default backend, `rebase-apply` for the am backend) via
 *  `rev-parse --git-path`, which resolves worktree-correct paths. */
const rebaseInProgress = async (projectPath: string): Promise<boolean> => {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const { stdout } = await git(projectPath, ['rev-parse', '--git-path', dir])
      const p = stdout.trim()
      if (!p) continue
      await stat(isAbsolute(p) ? p : join(projectPath, p))
      return true // stat succeeded → the state dir exists → rebasing
    } catch {
      // rev-parse failed or the dir doesn't exist — try the other backend.
    }
  }
  return false
}

// ── Remote awareness (ahead/behind) ──────────────────────────────────────────
// "Sync" hides push+pull behind one button, which is right — but without a
// fetch the user can't KNOW a teammate pushed. shareStatus therefore runs a
// throttled `git fetch` (at most one per project per FETCH_THROTTLE_MS) and
// reports commit counts SCOPED TO .openground/ in both directions. Stored on
// globalThis so tsx-watch reloads don't reset the throttle clock (same idiom
// as the terminal pool).
const FETCH_THROTTLE_MS = 60_000
const FETCH_TIMEOUT_MS = 15_000
const fetchTimes: Map<string, number> = ((
  globalThis as unknown as { __openground_share_fetch?: Map<string, number> }
).__openground_share_fetch ??= new Map())

/** Test-only: forget all fetch timestamps so the next shareStatus re-fetches. */
export const __resetShareFetchThrottle = (): void => fetchTimes.clear()

const maybeFetch = async (projectPath: string): Promise<void> => {
  const last = fetchTimes.get(projectPath) ?? 0
  if (Date.now() - last < FETCH_THROTTLE_MS) return
  // Stamp BEFORE awaiting so concurrent status calls don't pile up fetches.
  fetchTimes.set(projectPath, Date.now())
  try {
    await git(projectPath, ['fetch', '--quiet'], FETCH_TIMEOUT_MS)
  } catch {
    // Offline / no remote / auth — the counts below degrade to 0 on their own.
  }
}

/** Commits in `range` that touch `.openground/` — 0 on any error (the
 *  canonical one: no upstream configured). */
const sharedCommitCount = async (projectPath: string, range: string): Promise<number> => {
  try {
    const { stdout } = await git(projectPath, ['rev-list', '--count', range, '--', SHARED_DIR])
    const n = Number(stdout.trim())
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** GET /api/project/share/status — where the project's data lives and whether
 *  the repo copy has unsynced local changes. Every field degrades to its
 *  "no" value on git errors; this endpoint never throws for a valid path. */
export const shareStatus = async (projectPath: string): Promise<ShareStatus> => {
  const shared = await isShared(projectPath)
  const gitRepo = await isGitRepo(projectPath)
  const remoteUrl = gitRepo ? await getRemoteUrl(projectPath) : null
  // `dirty` drives the dot on the Sync button — only meaningful when shared.
  const dirty = shared && gitRepo ? await openGroundDirty(projectPath) : false
  let ahead = 0
  let behind = 0
  if (shared && gitRepo && remoteUrl) {
    await maybeFetch(projectPath)
    ;[ahead, behind] = await Promise.all([
      sharedCommitCount(projectPath, '@{upstream}..HEAD'),
      sharedCommitCount(projectPath, 'HEAD..@{upstream}'),
    ])
  }
  return { shared, gitRepo, remoteUrl, dirty, ahead, behind }
}

/** POST /api/project/share/sync — commit (scoped to `.openground/` only) →
 *  `git pull --rebase --autostash` → `git push`.
 *
 *  Failure philosophy: the only `ok:false` outcomes are the ones that need
 *  the user's hands (a rebase conflict — aborted, repo left clean — or a
 *  failed commit). A repo with no remote/upstream syncs "successfully" to
 *  nowhere: ok:true, pulled/pushed:false, message says why. Auth/network
 *  push failures likewise report through `message`, never a throw — the
 *  local commit already succeeded and nothing is broken. */
export const shareSync = async (projectPath: string): Promise<ShareSyncResult> => {
  const notes: string[] = []

  // a. Stage everything under .openground/ (adds + modifications + deletions).
  // A pathspec that matches nothing (e.g. the dir isn't there yet on a fresh
  // collaborator clone) makes `git add` exit non-zero — that's fine, the
  // status check below just finds nothing to commit.
  try {
    await git(projectPath, ['add', '-A', '--', SHARED_DIR])
  } catch {
    // Nothing matched the pathspec — proceed; commit is gated on status.
  }

  // b. Commit only when there is something to commit, and only the pathspec.
  // CONTRACT: a pathspec commit must leave the user's OTHER staged changes
  // staged and uncommitted (pinned by test).
  let committed = false
  if (await openGroundDirty(projectPath)) {
    try {
      await git(projectPath, ['commit', '-m', 'openground: sync', '--', SHARED_DIR])
      committed = true
    } catch (e) {
      // e.g. mid-merge ("cannot do a partial commit during a merge") or a
      // hook rejection. Nothing has been pulled/pushed; stop here.
      return {
        ok: false,
        committed: false,
        pulled: false,
        pushed: false,
        message: `commit failed: ${firstLine(gitErrorText(e))}`,
      }
    }
  }

  // c. Pull. --rebase keeps the shared history linear; --autostash carries any
  // unrelated dirty working-tree files across the rebase (git-internal and
  // self-restoring — NOT a `git stash` the user could lose).
  let pulled = false
  try {
    await git(projectPath, ['pull', '--rebase', '--autostash'], NETWORK_TIMEOUT_MS)
    pulled = true
    // The pull fetched — push the throttle window out so the status call that
    // follows a Sync doesn't immediately re-fetch.
    fetchTimes.set(projectPath, Date.now())
  } catch (e) {
    const text = gitErrorText(e)
    if ((await rebaseInProgress(projectPath)) || /conflict/i.test(text)) {
      // A teammate's change collides with ours. Put the repo back into a
      // clean, non-rebasing state and hand the resolution to the user.
      try {
        await git(projectPath, ['rebase', '--abort'])
      } catch {
        // Best-effort: if there is no rebase to abort, the repo is already clean.
      }
      return {
        ok: false,
        committed,
        pulled: false,
        pushed: false,
        conflict: true,
        message:
          'Sync hit a rebase conflict and was rolled back. ' +
          'Run `git pull` in the project and resolve the conflict manually, then sync again.',
      }
    }
    if (NO_UPSTREAM_RE.test(text)) {
      notes.push('no remote/upstream configured — nothing to pull')
    } else {
      notes.push(`pull failed: ${firstLine(text)}`)
    }
  }

  // d. Push. Failures (no upstream, auth, offline) are reported, not thrown —
  // the commit is safely local and the next sync will retry.
  let pushed = false
  try {
    await git(projectPath, ['push'], NETWORK_TIMEOUT_MS)
    pushed = true
  } catch (e) {
    const text = gitErrorText(e)
    if (NO_UPSTREAM_RE.test(text)) {
      notes.push('no remote/upstream configured — push skipped')
    } else {
      notes.push(`push failed: ${firstLine(text)}`)
    }
  }

  return {
    ok: true,
    committed,
    pulled,
    pushed,
    ...(notes.length > 0 ? { message: notes.join('; ') } : {}),
  }
}

/** Why "Share via Git" can't be enabled for a project (or `{ok:true}`).
 *  Exported for the enable route (integration phase) — the route maps these
 *  to its 412-style errors. `ignored` = the repo's gitignore rules would
 *  swallow `.openground/`, so sharing could never actually commit anything. */
export type EnablePreconditionResult =
  | { ok: true }
  | { ok: false; reason: 'not-git' | 'already-shared' | 'ignored' }

export const enablePreconditions = async (
  projectPath: string,
): Promise<EnablePreconditionResult> => {
  if (!(await isGitRepo(projectPath))) return { ok: false, reason: 'not-git' }
  if (await isShared(projectPath)) return { ok: false, reason: 'already-shared' }
  try {
    // Exit 0 ⇔ the path IS ignored. Exit 1 (not ignored) / 128 throw.
    // Checked via the MARKER path, not the bare dir name: a dir-only pattern
    // like `.openground/` doesn't match a name git can't see as a directory
    // (the dir doesn't exist before enable), but it does swallow any child —
    // and if the marker can't be committed, sharing can't work at all.
    await git(projectPath, ['check-ignore', '-q', '--', `${SHARED_DIR}/${SHARED_MARKER_FILE}`])
    return { ok: false, reason: 'ignored' }
  } catch {
    return { ok: true }
  }
}
