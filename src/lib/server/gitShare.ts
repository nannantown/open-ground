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
import type { ShareConflict, ShareStatus, ShareSyncResult } from '../types'
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
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> =>
  execFile('git', args, {
    cwd: projectPath,
    timeout,
    // Never let a credential prompt hang the server: a missing credential
    // must fail fast (and surface as a useful `message`), not block 60s.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
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

// The remote exists but can't be REACHED right now — offline, DNS, refused,
// timed out. Distinct from NO_UPSTREAM_RE (a setup fact) so the UI can say
// "check your connection and sync again" instead of dumping raw git (S23).
const OFFLINE_RE =
  /could not resolve host|unable to access|connection timed out|connection refused|network is unreachable|operation timed out|could not connect|timed out/i

// `git commit` with no configured identity (fresh machine) — actionable: the
// fix is two git config commands, so give the UI a machine-readable reason
// instead of the raw "Author identity unknown" paragraph (S28).
const NO_IDENTITY_RE =
  /author identity unknown|please tell me who you are|empty ident name|no (?:email|name) was given|auto-detection is disabled/i

// `git fetch` / `git pull` line marking a rewritten ref: "+ abc...def main ->
// origin/main  (forced update)" — someone force-pushed the upstream (S25).
const FORCED_UPDATE_RE = /\(forced update\)/i

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

/** Is a merge mid-flight (MERGE_HEAD exists)? Same --git-path resolution. */
const mergeInProgress = async (projectPath: string): Promise<boolean> => {
  try {
    const { stdout } = await git(projectPath, ['rev-parse', '--git-path', 'MERGE_HEAD'])
    const p = stdout.trim()
    if (!p) return false
    await stat(isAbsolute(p) ? p : join(projectPath, p))
    return true
  } catch {
    return false
  }
}

/** The checked-out branch name, or null on a detached HEAD (or any error).
 *  `symbolic-ref -q` exits non-zero when HEAD is detached. */
export const currentBranch = async (projectPath: string): Promise<string | null> => {
  try {
    const { stdout } = await git(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

// ── Conflict inspection (mid-rebase) ─────────────────────────────────────────
// Index-stage semantics during `pull --rebase` are INVERTED from the user's
// view: stage 2 ("ours") is the UPSTREAM side (the teammate), stage 3
// ("theirs") is the local commit being replayed (the user's own change). All
// user-facing fields here are named mine/theirs from the USER's perspective;
// only this section knows about the inversion.
const STAGE_TEAMMATE = 2
const STAGE_MINE = 3

interface UnmergedFile {
  path: string
  stages: Set<number>
}

/** Unmerged index entries (`git ls-files -u`), grouped per path. */
const listUnmerged = async (projectPath: string): Promise<UnmergedFile[]> => {
  const { stdout } = await git(projectPath, ['ls-files', '-u'])
  const byPath = new Map<string, Set<number>>()
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\d+ [0-9a-f]+ ([123])\t(.+)$/)
    if (!m) continue
    const set = byPath.get(m[2]) ?? new Set<number>()
    set.add(Number(m[1]))
    byPath.set(m[2], set)
  }
  return Array.from(byPath, ([path, stages]) => ({ path, stages }))
}

/** A side's blob content mid-conflict, or null when that side has no blob
 *  (the delete half of a delete/modify conflict). */
const showStage = async (
  projectPath: string,
  stage: number,
  file: string,
): Promise<string | null> => {
  try {
    return (await git(projectPath, ['show', `:${stage}:${file}`])).stdout
  } catch {
    return null
  }
}

const titleOf = (content: string | null): string | undefined => {
  if (!content) return undefined
  try {
    const parsed = JSON.parse(content) as { title?: unknown }
    return typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : undefined
  } catch {
    return undefined
  }
}

const CARD_FILE_RE = new RegExp(`^${SHARED_DIR}/board/cards/(.+)\\.json$`)

/** Describe every unmerged file for the resolution dialog — MUST run while
 *  the rebase is still stopped (the unmerged index is the data source). */
const collectConflicts = async (projectPath: string): Promise<ShareConflict[]> => {
  const out: ShareConflict[] = []
  for (const u of await listUnmerged(projectPath)) {
    const card = u.path.match(CARD_FILE_RE)
    const kind: ShareConflict['kind'] = card
      ? 'card'
      : u.path === `${SHARED_DIR}/board/notes.md`
        ? 'notes'
        : 'other'
    const mineExists = u.stages.has(STAGE_MINE)
    const theirsExists = u.stages.has(STAGE_TEAMMATE)
    let mineTitle: string | undefined
    let theirsTitle: string | undefined
    if (kind === 'card') {
      mineTitle = titleOf(mineExists ? await showStage(projectPath, STAGE_MINE, u.path) : null)
      theirsTitle = titleOf(
        theirsExists ? await showStage(projectPath, STAGE_TEAMMATE, u.path) : null,
      )
    }
    const label =
      kind === 'card'
        ? `card "${mineTitle ?? theirsTitle ?? card![1]}"`
        : kind === 'notes'
          ? 'notes'
          : u.path.startsWith(`${SHARED_DIR}/`)
            ? u.path.slice(SHARED_DIR.length + 1)
            : u.path
    out.push({
      file: u.path,
      label,
      kind,
      mine: { exists: mineExists, ...(mineTitle ? { title: mineTitle } : {}) },
      theirs: { exists: theirsExists, ...(theirsTitle ? { title: theirsTitle } : {}) },
    })
  }
  return out
}

/** Resolve ONE unmerged file to the chosen side, from the USER's view.
 *  Keeping a side that deleted the file means deleting it. */
const resolveOne = async (
  projectPath: string,
  u: UnmergedFile,
  choice: 'mine' | 'theirs',
): Promise<void> => {
  const keepStage = choice === 'mine' ? STAGE_MINE : STAGE_TEAMMATE
  if (u.stages.has(keepStage)) {
    // NB inversion: the user's "mine" is git's --theirs during a rebase.
    await git(projectPath, ['checkout', choice === 'mine' ? '--theirs' : '--ours', '--', u.path])
    await git(projectPath, ['add', '--', u.path])
  } else {
    await git(projectPath, ['rm', '-f', '--', u.path])
  }
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
// Sticky per-project "the upstream was rewritten" flag (S25) — set by a fetch
// that reports "(forced update)", cleared by the next clean fetch. globalThis
// for the same tsx-watch-reload reason as the throttle map.
const forcedUpdates: Map<string, boolean> = ((
  globalThis as unknown as { __openground_share_forced?: Map<string, boolean> }
).__openground_share_forced ??= new Map())

/** Test-only: forget all fetch timestamps so the next shareStatus re-fetches. */
export const __resetShareFetchThrottle = (): void => fetchTimes.clear()

const maybeFetch = async (projectPath: string): Promise<void> => {
  const last = fetchTimes.get(projectPath) ?? 0
  if (Date.now() - last < FETCH_THROTTLE_MS) return
  // Stamp BEFORE awaiting so concurrent status calls don't pile up fetches.
  fetchTimes.set(projectPath, Date.now())
  try {
    // NOT --quiet: the ref-update lines are how a force-pushed upstream
    // announces itself ("(forced update)"). Sticky once seen — only the sync
    // that actually absorbs the rewrite (shareSync below) clears it, so a
    // quiet follow-up fetch can't hide the warning before the user saw it.
    const { stdout, stderr } = await git(projectPath, ['fetch'], FETCH_TIMEOUT_MS)
    if (FORCED_UPDATE_RE.test(stdout + '\n' + stderr)) forcedUpdates.set(projectPath, true)
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

// ── Auto-sync primitives (consumed by shareAutoSync.ts) ─────────────────────
// The adaptive engine owns its own cadence, so it needs throttle-free git
// plumbing; everything stays in this module so the engine never runs git
// itself.

/** Unthrottled fetch on the engine's own schedule. Stamps the status-call
 *  throttle so a fetch never runs twice back-to-back. Returns whether the
 *  fetch CHANGED any ref (the "a teammate is active" signal), or null when
 *  the remote is unreachable / absent. */
export const fetchRemote = async (projectPath: string): Promise<{ changed: boolean } | null> => {
  fetchTimes.set(projectPath, Date.now())
  try {
    const { stdout, stderr } = await git(projectPath, ['fetch'], FETCH_TIMEOUT_MS)
    const out = stdout + '\n' + stderr
    if (FORCED_UPDATE_RE.test(out)) forcedUpdates.set(projectPath, true)
    // Any ref-update line (fetch prints one per moved ref) = remote activity.
    return { changed: /->/.test(out) }
  } catch {
    return null
  }
}

/** Commits upstream hasn't seen ↔ has that we haven't, .openground-scoped
 *  (same ranges the status badges use). */
export const sharedAheadBehind = async (
  projectPath: string,
): Promise<{ ahead: number; behind: number }> => {
  const [ahead, behind] = await Promise.all([
    sharedCommitCount(projectPath, '@{upstream}..HEAD'),
    sharedCommitCount(projectPath, 'HEAD..@{upstream}'),
  ])
  return { ahead, behind }
}

/** Any uncommitted .openground/ changes? (exported for the engine). */
export const sharedDirty = (projectPath: string): Promise<boolean> => openGroundDirty(projectPath)

/** The code-is-sacred gate: true ⇔ EVERY commit in @{upstream}..HEAD touches
 *  ONLY .openground/ paths. The auto engine refuses to pull-rebase or push
 *  when the user's own code commits sit in the span — those publish on the
 *  USER's command, never on a timer. No upstream / errors → false (be safe);
 *  an empty span → true. Capped: >50 ahead commits reads as "not shared-only". */
export const aheadIsSharedOnly = async (projectPath: string): Promise<boolean> => {
  let shas: string[]
  try {
    const { stdout } = await git(projectPath, ['rev-list', '@{upstream}..HEAD'])
    shas = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return false
  }
  if (shas.length === 0) return true
  if (shas.length > 50) return false
  for (const sha of shas) {
    try {
      const { stdout } = await git(projectPath, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        '--root',
        sha,
      ])
      const files = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      // An empty commit is fine; any file outside .openground/ is not.
      if (files.some((f) => !f.startsWith(`${SHARED_DIR}/`))) return false
    } catch {
      return false
    }
  }
  return true
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
    // Give the (throttled) fetch a short grace window, then answer with the
    // refs we have: a fast fetch (LAN, warm connection) lands in the counts
    // immediately, a slow one finishes in the background and the next poll
    // (90s client-side) reports what it found. The status endpoint must never
    // stall the UI for the full FETCH_TIMEOUT_MS.
    await Promise.race([
      maybeFetch(projectPath),
      new Promise<void>((resolve) => setTimeout(resolve, 2_500)),
    ])
    ;[ahead, behind] = await Promise.all([
      sharedCommitCount(projectPath, '@{upstream}..HEAD'),
      sharedCommitCount(projectPath, 'HEAD..@{upstream}'),
    ])
  }
  const branch = gitRepo ? await currentBranch(projectPath) : null
  return {
    shared,
    gitRepo,
    remoteUrl,
    dirty,
    ahead,
    behind,
    ...(forcedUpdates.get(projectPath) ? { forcedUpdate: true } : {}),
    ...(branch ? { branch } : {}),
  }
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

  // Preflight — refuse to touch a repo whose state isn't ours to manage:
  //  - A rebase/merge ALREADY in progress is the user's own operation
  //    (possibly half-resolved). Running our pull would fail and the
  //    conflict-handler's `rebase --abort` would destroy THEIR progress (S29).
  //  - A detached HEAD would accept our sync commit onto no branch — it would
  //    float unreachable and push/pull would both fail anyway (S26).
  // Nothing has been staged or committed when these fire.
  const blocked = (
    reason: NonNullable<ShareSyncResult['reason']>,
    message: string,
  ): ShareSyncResult => ({ ok: false, committed: false, pulled: false, pushed: false, reason, message })
  if (await rebaseInProgress(projectPath)) {
    return blocked(
      'rebase-in-progress',
      'A rebase is already in progress in this repo — finish or abort it first (git rebase --continue / --abort), then sync again.',
    )
  }
  if (await mergeInProgress(projectPath)) {
    return blocked(
      'merge-in-progress',
      'A merge is in progress in this repo — finish or abort it first (git merge --continue / --abort), then sync again.',
    )
  }
  if ((await currentBranch(projectPath)) === null) {
    return blocked(
      'detached-head',
      'The repo is on a detached HEAD — a sync commit would not belong to any branch. Switch back to a branch (git switch <branch>), then sync again.',
    )
  }

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
      const text = gitErrorText(e)
      return {
        ok: false,
        committed: false,
        pulled: false,
        pushed: false,
        // Fresh machine without user.name/email — the one commit failure with
        // a copy-pasteable fix; give the UI the machine-readable reason.
        ...(NO_IDENTITY_RE.test(text) ? { reason: 'no-identity' as const } : {}),
        message: `commit failed: ${firstLine(text)}`,
      }
    }
  }

  // c. Pull. --rebase keeps the shared history linear; --autostash carries any
  // unrelated dirty working-tree files across the rebase (git-internal and
  // self-restoring — NOT a `git stash` the user could lose). Factored into
  // pullOnce because the push-retry below (S24) needs a second round.
  // S22: when re-applying the autostash conflicts, git prints a warning but
  // EXITS 0 — the user's code is left with conflict markers (and a copy in
  // the stash) while a silent "Synced" would be a lie. Detect it on the
  // SUCCESS path and surface it loudly at the end.
  const pullOnce = async (): Promise<
    | { kind: 'ok'; autostashConflict: boolean; forcedUpdate: boolean }
    | { kind: 'conflict'; conflicts: ShareConflict[] }
    | { kind: 'note'; note: string; offline?: boolean; noRemote?: boolean }
  > => {
    try {
      const { stdout, stderr } = await git(
        projectPath,
        ['pull', '--rebase', '--autostash'],
        NETWORK_TIMEOUT_MS,
      )
      // The pull fetched — push the throttle window out so the status call
      // that follows a Sync doesn't immediately re-fetch.
      fetchTimes.set(projectPath, Date.now())
      const out = stdout + '\n' + stderr
      // This pull absorbed whatever the upstream looks like now — a sticky
      // forced-update warning from an earlier fetch is resolved either way
      // (the sync result below still tells the user it happened).
      const forced = FORCED_UPDATE_RE.test(out) || forcedUpdates.get(projectPath) === true
      forcedUpdates.delete(projectPath)
      return {
        kind: 'ok',
        autostashConflict: /applying autostash resulted in conflicts/i.test(out),
        forcedUpdate: forced,
      }
    } catch (e) {
      const text = gitErrorText(e)
      if ((await rebaseInProgress(projectPath)) || /conflict/i.test(text)) {
        // A teammate's change collides with ours. Capture WHAT conflicted
        // (sides + card titles, for the resolution dialog) while the unmerged
        // index still exists, then put the repo back into a clean,
        // non-rebasing state and hand the resolution to the user.
        // (The preflight guarantees any in-progress rebase here is OUR pull's.)
        let conflicts: ShareConflict[] = []
        try {
          conflicts = await collectConflicts(projectPath)
        } catch {
          // Listing is best-effort; the conflict handling below works without it.
        }
        try {
          await git(projectPath, ['rebase', '--abort'])
        } catch {
          // Best-effort: if there is no rebase to abort, the repo is already clean.
        }
        return { kind: 'conflict', conflicts }
      }
      if (NO_UPSTREAM_RE.test(text)) {
        return {
          kind: 'note',
          note: 'no remote/upstream configured — nothing to pull',
          noRemote: true,
        }
      }
      return {
        kind: 'note',
        note: `pull failed: ${firstLine(text)}`,
        ...(OFFLINE_RE.test(text) ? { offline: true } : {}),
      }
    }
  }
  const conflictResult = (conflicts: ShareConflict[]): ShareSyncResult => {
    const labels = conflicts.slice(0, 8).map((c) => c.label)
    if (conflicts.length > 8) labels.push(`+${conflicts.length - 8} more`)
    return {
      ok: false,
      committed,
      pulled: false,
      pushed: false,
      conflict: true,
      ...(labels.length > 0 ? { conflictFiles: labels } : {}),
      ...(conflicts.length > 0 ? { conflicts } : {}),
      message:
        'Sync hit a rebase conflict and was rolled back. ' +
        (labels.length > 0 ? `Conflicted: ${labels.join(', ')}. ` : '') +
        'Run `git pull` in the project and resolve the conflict manually, then sync again.',
    }
  }

  let pulled = false
  let autostashConflict = false
  let offline = false
  let noRemote = false
  let forcedUpdate = false
  const p1 = await pullOnce()
  if (p1.kind === 'conflict') return conflictResult(p1.conflicts)
  if (p1.kind === 'note') {
    notes.push(p1.note)
    offline = offline || p1.offline === true
    noRemote = noRemote || p1.noRemote === true
  } else {
    pulled = true
    autostashConflict = p1.autostashConflict
    forcedUpdate = p1.forcedUpdate
  }

  // d. Push. Failures (no upstream, auth, offline) are reported, not thrown —
  // the commit is safely local and the next sync will retry. Two recoverable
  // shapes are handled here instead of bounced to the user:
  //  - S4  no upstream + an origin exists → publish the branch (push -u).
  //  - S24 non-fast-forward (someone pushed between our pull and push) → one
  //    transparent retry round: pull --rebase again, push again.
  const tryPush = async (args: string[]): Promise<{ ok: true } | { ok: false; text: string }> => {
    try {
      await git(projectPath, ['push', ...args], NETWORK_TIMEOUT_MS)
      return { ok: true }
    } catch (e) {
      return { ok: false, text: gitErrorText(e) }
    }
  }
  const NON_FF_RE = /non-fast-forward|fetch first|failed to push some refs/i
  let pushed = false
  const push1 = await tryPush([])
  if (push1.ok) {
    pushed = true
  } else if (NO_UPSTREAM_RE.test(push1.text)) {
    const branch = await currentBranch(projectPath)
    if (branch && (await getRemoteUrl(projectPath))) {
      const publish = await tryPush(['-u', 'origin', branch])
      if (publish.ok) {
        pushed = true
        notes.push(`published branch '${branch}' to origin`)
      } else {
        notes.push(`push failed: ${firstLine(publish.text)}`)
        offline = offline || OFFLINE_RE.test(publish.text)
      }
    } else {
      notes.push('no remote/upstream configured — push skipped')
      noRemote = true
    }
  } else if (NON_FF_RE.test(push1.text)) {
    const p2 = await pullOnce()
    if (p2.kind === 'conflict') return conflictResult(p2.conflicts)
    if (p2.kind === 'ok') {
      pulled = true
      autostashConflict = autostashConflict || p2.autostashConflict
      forcedUpdate = forcedUpdate || p2.forcedUpdate
      const push2 = await tryPush([])
      if (push2.ok) pushed = true
      else notes.push(`push failed: ${firstLine(push2.text)}`)
    } else {
      notes.push(`push failed: ${firstLine(push1.text)}`)
    }
  } else {
    notes.push(`push failed: ${firstLine(push1.text)}`)
    offline = offline || OFFLINE_RE.test(push1.text)
  }

  // S22, surfaced LAST so the shared data still pushed above: the board sync
  // itself worked, but the user's own code is sitting in conflict markers —
  // never bury that under an ok-toast.
  if (autostashConflict) {
    return {
      ok: false,
      committed,
      pulled,
      pushed,
      ...(forcedUpdate ? { forcedUpdate: true } : {}),
      reason: 'autostash-conflict',
      message:
        'The board synced, but restoring your uncommitted code changes hit a conflict — ' +
        'they are also saved in the stash (git stash list). Resolve the conflict markers ' +
        '(or restore from the stash), then continue working as usual.',
    }
  }

  return {
    ok: true,
    committed,
    pulled,
    pushed,
    ...(offline ? { offline: true } : {}),
    ...(noRemote ? { noRemote: true } : {}),
    ...(forcedUpdate ? { forcedUpdate: true } : {}),
    ...(notes.length > 0 ? { message: notes.join('; ') } : {}),
  }
}

/** POST /api/project/share/resolve — re-run the sync, resolving each
 *  conflicted file to the side the user chose in the dialog ('mine' = the
 *  local version, 'theirs' = the teammate's). Drives the rebase to completion
 *  (`checkout --ours/--theirs` per file → `rebase --continue`, looping across
 *  replayed commits; an emptied commit is `--skip`ped), then pushes.
 *
 *  Safety: a conflicted file with NO recorded choice aborts the rebase and
 *  returns the (fresh) conflict result — the app never auto-picks a side the
 *  user didn't see. The same preflight as shareSync applies. */
export const shareResolve = async (
  projectPath: string,
  choices: Record<string, 'mine' | 'theirs'>,
): Promise<ShareSyncResult> => {
  const fail = (message: string, extra: Partial<ShareSyncResult> = {}): ShareSyncResult => ({
    ok: false,
    committed: false,
    pulled: false,
    pushed: false,
    message,
    ...extra,
  })
  if (await rebaseInProgress(projectPath)) {
    return fail(
      'A rebase is already in progress in this repo — finish or abort it first, then sync again.',
      { reason: 'rebase-in-progress' },
    )
  }
  if (await mergeInProgress(projectPath)) {
    return fail('A merge is in progress in this repo — finish or abort it first, then sync again.', {
      reason: 'merge-in-progress',
    })
  }
  if ((await currentBranch(projectPath)) === null) {
    return fail('The repo is on a detached HEAD — switch back to a branch, then sync again.', {
      reason: 'detached-head',
    })
  }

  // Commit any (new) local .openground changes first — same as shareSync; the
  // failed sync that produced the dialog usually committed already, making
  // this a no-op.
  let committed = false
  try {
    await git(projectPath, ['add', '-A', '--', SHARED_DIR])
  } catch {
    // pathspec matched nothing — fine
  }
  if (await openGroundDirty(projectPath)) {
    try {
      await git(projectPath, ['commit', '-m', 'openground: sync', '--', SHARED_DIR])
      committed = true
    } catch (e) {
      return fail(`commit failed: ${firstLine(gitErrorText(e))}`)
    }
  }

  const abort = async (): Promise<void> => {
    try {
      await git(projectPath, ['rebase', '--abort'])
    } catch {
      // already clean
    }
  }

  // Pull; expected to stop on the same conflict the dialog described.
  let autostashConflict = false
  let pullOut = ''
  try {
    const { stdout, stderr } = await git(
      projectPath,
      ['pull', '--rebase', '--autostash'],
      NETWORK_TIMEOUT_MS,
    )
    pullOut = stdout + '\n' + stderr
    fetchTimes.set(projectPath, Date.now())
    forcedUpdates.delete(projectPath)
  } catch (e) {
    const rebasing = await rebaseInProgress(projectPath)
    if (!rebasing) {
      const text = gitErrorText(e)
      // No remote/upstream is a setup fact, not a failure (same contract as
      // shareSync) — there is nothing to resolve against; carry on to push.
      if (!NO_UPSTREAM_RE.test(text)) {
        return fail(`pull failed: ${firstLine(text)}`)
      }
    }
    // Resolution loop: each replayed commit can stop the rebase again, and a
    // multi-commit history can conflict repeatedly — bounded, never infinite.
    const MAX_ROUNDS = 30
    let finished = !rebasing
    for (let round = 0; round < MAX_ROUNDS && !finished; round++) {
      const unmerged = await listUnmerged(projectPath)
      for (const u of unmerged) {
        const choice = choices[u.path]
        if (!choice) {
          // A conflict the user never saw (file changed since the dialog) —
          // never guess: roll back and re-describe.
          const conflicts = await collectConflicts(projectPath)
          await abort()
          const labels = conflicts.slice(0, 8).map((c) => c.label)
          return {
            ok: false,
            committed,
            pulled: false,
            pushed: false,
            conflict: true,
            ...(labels.length > 0 ? { conflictFiles: labels } : {}),
            ...(conflicts.length > 0 ? { conflicts } : {}),
            message: 'New conflicts appeared — please choose again.',
          }
        }
        try {
          await resolveOne(projectPath, u, choice)
        } catch (e2) {
          await abort()
          return fail(`resolve failed: ${firstLine(gitErrorText(e2))}`)
        }
      }
      try {
        // GIT_EDITOR=true: --continue must never open an editor on a server.
        const { stdout, stderr } = await git(
          projectPath,
          ['rebase', '--continue'],
          NETWORK_TIMEOUT_MS,
          { GIT_EDITOR: 'true' },
        )
        pullOut += '\n' + stdout + '\n' + stderr
      } catch (e2) {
        const text = gitErrorText(e2)
        if (/no changes|nothing to commit|patch is empty/i.test(text)) {
          // Choosing the teammate's side for everything emptied this commit.
          try {
            const { stdout, stderr } = await git(
              projectPath,
              ['rebase', '--skip'],
              NETWORK_TIMEOUT_MS,
              { GIT_EDITOR: 'true' },
            )
            pullOut += '\n' + stdout + '\n' + stderr
          } catch {
            if (!(await rebaseInProgress(projectPath))) {
              await abort()
              return fail(`resolve failed: ${firstLine(text)}`)
            }
            // skip stopped on the NEXT commit's conflict — next round handles it.
          }
        } else if (!(await rebaseInProgress(projectPath))) {
          await abort()
          return fail(`resolve failed: ${firstLine(text)}`)
        }
        // else: --continue stopped on the next conflicted commit — loop.
      }
      finished = !(await rebaseInProgress(projectPath))
    }
    if (!finished) {
      await abort()
      return fail('resolve failed: too many conflicted commits — please pull manually.')
    }
  }
  autostashConflict = /applying autostash resulted in conflicts/i.test(pullOut)

  // Push — one transparent retry is shareSync's job; here a plain push
  // suffices (we JUST rebased onto the freshest upstream). A race in that
  // window reports as a note and the next Sync retries.
  let pushed = false
  let note: string | undefined
  try {
    await git(projectPath, ['push'], NETWORK_TIMEOUT_MS)
    pushed = true
  } catch (e) {
    note = `push failed: ${firstLine(gitErrorText(e))}`
  }

  if (autostashConflict) {
    return {
      ok: false,
      committed,
      pulled: true,
      pushed,
      reason: 'autostash-conflict',
      message:
        'The board synced, but restoring your uncommitted code changes hit a conflict — ' +
        'they are also saved in the stash (git stash list). Resolve the conflict markers ' +
        '(or restore from the stash), then continue working as usual.',
    }
  }
  return {
    ok: true,
    committed,
    pulled: true,
    pushed,
    ...(note ? { message: note } : {}),
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
