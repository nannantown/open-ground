// swarmWorker — the in-app, tmux-free replacement for the shell swarm's
// `swarm-new.sh` (worktree) + `swarm-dispatch.sh` (/order injection). It is the
// "worker spawn" primitive of the OPEN GROUND swarm port (docs / auto-memory
// project_inapp_swarm_port): given a registered project and a Board goal it
//   1. creates an ISOLATED git worktree under the project's CENTRAL worktrees
//      dir (~/.openground/projects/<uuid>/worktrees/ — already inside
//      validateProjectPath's boundary, NEVER a repo sibling), on a fresh
//      `swarm/*` branch off origin/main, with node_modules symlinked;
//   2. launches ONE interactive `claude` PTY (subscription-only — launchClaude,
//      never `claude -p`/SDK) in that worktree; and
//   3. hands it the `/order ゴール: …` goal as claude's POSITIONAL prompt so
//      claude runs the command on startup. (See the delivery NOTE below for why
//      this beats typing it into the TUI — a TUI-injected slash command does not
//      submit — and why it sidesteps the tmux send-keys Enter-lag entirely.)
//
// Worktree REMOVAL (kill / completion) reuses the same central-only safety the
// worktree cleaner enforces — this module never removes anything outside the
// central worktrees dir, even with `force`. It is a CAPABILITY: callers invoke
// removeSwarmWorktree on kill/completion; nothing auto-sweeps on PTY exit yet
// (that belongs to the future in-app orchestrator, P2).
//
// All git calls are execFile with argv arrays (never a shell string).

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { lstat, mkdir, stat, symlink, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { centralWorktreesDir } from './paths'
import { projectUUIDFromPath } from './projectDataPath'
import { canonicalize } from './canonicalize'
import { isUnderCentralDir } from './worktreeCleanup'
import { killTerminalsByCwd } from './terminal'
import { launchClaude, type LaunchClaudeOpts } from './claudeTerminal'
import { swarmLaunchDefaults } from './swarmLaunch'
import type { RemoveSwarmWorktreeResponse, SpawnSwarmWorkerResponse } from '../types'

const execFile = promisify(execFileCb)

// House convention (mergedBranches / reviewWorktree): network git must never
// hang on a credential prompt, and gets a hard timeout.
const GIT_OPTS = {
  timeout: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}

/** Run git in `cwd`; null on any failure (no git, not a repo, …). */
const git = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', args, { cwd, ...GIT_OPTS })
    return stdout
  } catch {
    return null
  }
}

// ── Branch + base-ref naming (pure, unit-tested) ────────────────────────────

/** Candidate base refs for a new worker worktree, most- to least-preferred.
 *  origin/main is the swarm convention (a clean trunk the manager merges back
 *  into); local `main` covers an offline repo; HEAD is the last-ditch fallback
 *  so a repo with neither still yields a worktree. */
export const SWARM_BASE_REF_PREFERENCE = ['origin/main', 'main', 'HEAD'] as const

/** Pick the most-preferred base ref that actually exists. Pure + exported so
 *  the precedence is unit-tested without a repo. */
export const pickBaseRef = (existing: ReadonlySet<string>): string =>
  SWARM_BASE_REF_PREFERENCE.find((r) => existing.has(r)) ?? 'HEAD'

/** Deterministic, argv-safe `swarm/*` branch name. `stamp` carries the
 *  uniqueness (caller passes a timestamp+random token); `hint` only decorates.
 *  Pure + exported so the charset/shape is unit-tested. Mirrors swarm-new.sh:
 *  identity is the `swarm/` prefix, never the dir name. */
export const swarmBranchName = (stamp: string, hint?: string): string => {
  const slug = (hint ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const safeStamp = stamp.replace(/[^A-Za-z0-9-]+/g, '') || 'x'
  return slug ? `swarm/${slug}-${safeStamp}` : `swarm/${safeStamp}`
}

/** The worktree dir name for a branch — the segment after `swarm/`. Pure. */
export const swarmWorktreeDirName = (branch: string): string =>
  branch.replace(/^swarm\//, '').replace(/\//g, '-')

// ── /order injection text (pure, unit-tested) ───────────────────────────────

const ORDER_PREFIX = '/order ゴール: '

/** Flatten + sanitize a string for safe single-line use in the /order command:
 *  drop ESC / C0 control bytes (a title or note could otherwise smuggle a
 *  terminal control sequence — the same injection vector pastePrompt guards),
 *  collapse all whitespace (incl. newlines) to single spaces, trim. */
const flattenOneLine = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()

/** Build the `/order ゴール: …` text handed to the worker as claude's positional
 *  prompt (see the delivery note below). Kept to ONE line on purpose: the whole
 *  goal must be a single slash-command argument, and a multi-line value risks
 *  being split or (if ever pasted instead) collapsed into a `[Pasted text]`
 *  chip, where `/order` is not parsed as a command. title + notes are joined
 *  (notes optional). Pure + exported for unit tests. */
export const buildOrderInjection = (title: string, notes?: string): string => {
  const t = flattenOneLine(title || '')
  const n = flattenOneLine(notes || '')
  const goal = t && n ? `${t} — ${n}` : t || n
  return ORDER_PREFIX + goal
}

// NOTE on delivery: the /order goal is handed to claude as its POSITIONAL
// argument (launchClaude's initialPrompt), NOT typed into the live TUI. That is
// deliberate — and it is the key correctness fix here:
//   - A slash command injected into the running TUI does NOT submit: typing
//     `/order …` opens claude's command-autocomplete, which swallows the Enter
//     (even repeated Enters), so the command lands in the input box unsent
//     (observed directly against claude 2.1.185).
//   - Passing it positionally (`claude "/order …"`) makes claude run the command
//     on startup — no Enter to send, so the tmux `send-keys … Enter` lag the
//     spec warns about simply does not exist in this path. This mirrors how the
//     Board "実行" launch hands a task prompt to claude.
// The goal text is still built single-line by buildOrderInjection (above) so the
// whole goal is one slash-command argument.

// ── Worktree lifecycle ──────────────────────────────────────────────────────

export interface SwarmWorktree {
  /** Absolute path of the new worktree (under the central worktrees dir). */
  worktree: string
  /** The `swarm/*` branch checked out there. */
  branch: string
  /** Owning registry UUID. */
  uuid: string
}

/** Create an isolated `swarm/*` worktree for `projectPath` under its central
 *  worktrees dir, node_modules symlinked from the main checkout. Throws if the
 *  path isn't a registered project (projectUUIDFromPath) or `git worktree add`
 *  fails (after cleaning up a partial worktree + branch, so a lost race never
 *  orphans state). */
export const createSwarmWorktree = async (
  projectPath: string,
  opts: { hint?: string } = {},
): Promise<SwarmWorktree> => {
  const uuid = await projectUUIDFromPath(projectPath)
  const parent = centralWorktreesDir(uuid)
  await mkdir(parent, { recursive: true })

  // Freshen origin/main best-effort (offline / no remote still works via the
  // local fallbacks below) so workers branch off the latest trunk.
  await git(projectPath, ['fetch', 'origin', 'main'])

  // Which base refs actually exist → pick the most-preferred.
  const existing = new Set<string>()
  for (const ref of SWARM_BASE_REF_PREFERENCE) {
    if ((await git(projectPath, ['rev-parse', '--verify', '--quiet', ref])) !== null) {
      existing.add(ref)
    }
  }
  const base = pickBaseRef(existing)

  // Uniqueness: timestamp + a 48-bit random token (two same-second spawns won't
  // collide; the old 16-bit token had a 1/65536 collision that — because the
  // dir name is derived from the branch — could make a loser's failure-cleanup
  // --force-remove the WINNER's identical dir). The branch charset is
  // constrained by swarmBranchName.
  const stamp = `${tsStamp()}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const branch = swarmBranchName(stamp, opts.hint)
  const dir = join(parent, swarmWorktreeDirName(branch))

  // Never touch a dir we didn't create: if the name somehow already exists
  // (collision / leftover), fail loudly BEFORE `worktree add` so the cleanup
  // below can only ever remove a dir THIS call made — a loser can't tear down a
  // concurrent winner's live worktree.
  if (await stat(dir).then(() => true).catch(() => false)) {
    throw new Error(`createSwarmWorktree: worktree dir already exists: ${dir}`)
  }

  // -c branch.autoSetupMerge=false: don't write upstream-tracking into the
  // SHARED .git/config, so concurrent `worktree add` (several workers at once)
  // don't contend on the config lock. Clean up on failure (the dir did not
  // pre-exist, so this only removes what we just created).
  const added = await git(projectPath, [
    '-c',
    'branch.autoSetupMerge=false',
    'worktree',
    'add',
    '-b',
    branch,
    dir,
    base,
  ])
  if (added === null) {
    await git(projectPath, ['worktree', 'remove', '--force', dir])
    await git(projectPath, ['branch', '-D', branch])
    throw new Error(`createSwarmWorktree: git worktree add failed for ${branch}`)
  }

  // Symlink node_modules from the main checkout (only if the project has one
  // and the worktree didn't inherit one). Best-effort — npm/dev simply won't
  // work in the worktree if it fails, which doesn't block claude itself.
  try {
    const repoNm = join(projectPath, 'node_modules')
    const wtNm = join(dir, 'node_modules')
    const hasRepoNm = await stat(repoNm).then(() => true).catch(() => false)
    const hasWtNm = await stat(wtNm).then(() => true).catch(() => false)
    if (hasRepoNm && !hasWtNm) await symlink(repoNm, wtNm)
  } catch {
    // ignore — node_modules is a convenience, not a correctness requirement
  }

  return { worktree: dir, branch, uuid }
}

/** Remove a worker worktree (kill / completion). Hard safety: the dir MUST sit
 *  under this project's central worktrees dir (canonicalized, sep-terminated),
 *  and the bare central root itself is refused — so a crafted path can never
 *  remove the main checkout or another project's data. Any live PTY in the
 *  worktree is killed first. `force` (the kill/abandon case) passes
 *  `--force` so a dirty mid-implementation tree can still be torn down; without
 *  it git refuses a dirty/locked worktree (the safe default). */
export const removeSwarmWorktree = async (
  projectPath: string,
  worktree: string,
  opts: { force?: boolean } = {},
): Promise<RemoveSwarmWorktreeResponse> => {
  const central = await canonicalize(centralWorktreesDir(await projectUUIDFromPath(projectPath)))
  // Security guard FIRST (canonicalized, symlink-resolved): refuse anything that
  // isn't strictly under this project's central worktrees dir, and the bare
  // central root itself. canonicalize tolerates a not-yet/no-longer-existing
  // path (it resolves the existing ancestor + re-appends the tail), so an
  // out-of-central path is refused whether or not it currently exists on disk.
  const canon = await canonicalize(worktree)
  if (canon === central || !isUnderCentralDir(canon, central)) {
    return { removed: false, reason: 'not a central worktree' }
  }
  // Idempotent: already gone on disk → treat as removed (still prune stale
  // worktree bookkeeping in the project's repo).
  if (!(await stat(worktree).then(() => true).catch(() => false))) {
    await git(projectPath, ['worktree', 'prune'])
    return { removed: true }
  }
  // Kill any live PTY in the worktree first, by the EXACT spawn-returned path —
  // that is the cwd recorded on the PTY (killTerminalsByCwd exact-matches), so
  // the canonicalized form would silently miss under a symlinked home. The
  // session then lingers but drops out of the live-cwd set.
  killTerminalsByCwd(worktree)
  // Drop the node_modules convenience symlink before removing: under a
  // `node_modules/` (trailing-slash) .gitignore — the dominant convention — the
  // SYMLINK reads as UNTRACKED (the pattern matches directories only), which
  // would block a non-force removal of an otherwise-clean tree AND make the
  // periodic worktree sweep skip it forever. Unlinking removes only the pointer,
  // never the real modules it targets. Real uncommitted work still (correctly)
  // blocks a non-force removal.
  try {
    const nm = join(worktree, 'node_modules')
    if ((await lstat(nm)).isSymbolicLink()) await unlink(nm)
  } catch {
    // ignore — best effort (no symlink, or already gone)
  }
  const removed = await git(projectPath, [
    'worktree',
    'remove',
    ...(opts.force ? ['--force'] : []),
    worktree,
  ])
  await git(projectPath, ['worktree', 'prune'])
  return removed !== null
    ? { removed: true }
    : { removed: false, reason: opts.force ? 'git refused' : 'worktree dirty or locked' }
}

// ── Spawn orchestration ─────────────────────────────────────────────────────

export interface SpawnSwarmWorkerOpts {
  projectPath: string
  /** Board goal — typically a card's title (+ notes). Injected as the /order. */
  title: string
  notes?: string
  /** Optional branch-name decoration (uniqueness comes from the timestamp). */
  hint?: string
  /** Extra env for the claude invocation — the MANAGER port. WORKERS pass none
   *  (so the SWARM_MANAGER=1 guard stays inert). Never an API body value. */
  env?: Record<string, string>
  cols?: number
  rows?: number
}

/** Build the LaunchClaudeOpts for a worker — pure + exported so the worker's
 *  launch contract is unit-tested without spawning a PTY:
 *   - permissionMode:'bypass' — a worker runs UNATTENDED in a throwaway central
 *     worktree (contained — the manager merges its branch back), so it must not
 *     stall on the first tool-approval prompt with no human watching. Mirrors
 *     swarm-new.sh's `--dangerously-skip-permissions`.
 *   - appContext:false — lean; the /order skill is the worker's protocol, not
 *     the board-API usage card.
 *   - env passthrough — the MANAGER port; a worker's `opts.env` is undefined, so
 *     the SWARM_MANAGER=1 guard stays inert (buildLaunchCommand emits no extra
 *     env), exactly as the shell worker does today.
 *   - model/effort/remoteControl — opus/max + Remote Control ON via the shared
 *     swarm launch default (swarmLaunch.ts), so a worker runs at full capability
 *     and is controllable from claude.ai / mobile like the supply officer
 *     (mirrors swarm-new.sh). effort is CLAUDE_EFFORTS-guarded there, never a
 *     broken argv; the Remote Control session is named 'worker'.
 *   - initialPrompt — the goal as a positional `/order …` (claude submits it on
 *     startup; a TUI-injected slash command would not). */
export const workerLaunchOpts = (
  worktree: string,
  agentSessionId: string,
  opts: { title: string; notes?: string; env?: Record<string, string>; cols?: number; rows?: number },
): LaunchClaudeOpts => ({
  cwd: worktree,
  agentSessionId,
  permissionMode: 'bypass',
  appContext: false,
  ...swarmLaunchDefaults('worker'),
  env: opts.env,
  cols: opts.cols,
  rows: opts.rows,
  initialPrompt: buildOrderInjection(opts.title, opts.notes),
})

/** Create the worktree and launch ONE interactive claude PTY in it, handing the
 *  `/order ゴール: …` goal to claude as its POSITIONAL prompt so it runs the
 *  command on startup (see the delivery note above — a TUI-injected slash
 *  command does not submit). Subscription-only: launchClaude drives the user's
 *  `claude` CLI, never `claude -p`/the SDK. Returns as soon as the PTY is up;
 *  claude boots and begins on the goal on its own. */
export const spawnSwarmWorker = async (
  opts: SpawnSwarmWorkerOpts,
): Promise<SpawnSwarmWorkerResponse> => {
  const { worktree, branch } = await createSwarmWorktree(opts.projectPath, { hint: opts.hint })
  const agentSessionId = randomUUID()
  const ref = launchClaude(workerLaunchOpts(worktree, agentSessionId, opts))
  return { terminalId: ref.terminalId, agentSessionId, worktree, branch }
}

/** Wall-clock stamp `MMDD-HHMMSS` for branch uniqueness. Isolated in one helper
 *  so the rest of the module stays clock-free + unit-testable. */
const tsStamp = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}
