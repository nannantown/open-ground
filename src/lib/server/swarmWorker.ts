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
import { removeClaudeFolderTrust } from './claudeTrust'
import { isExperimentEnabled } from './experiments'
import { swarmLaunchDefaults, resolveSwarmModelEffort } from './swarmLaunch'
import { NoAllowedModelTierError } from './swarmAllowedModels'
import { ensureGuardWiring } from './hooksInstall'
import { createSwarmFatalNotification } from './swarmNotifications'
import { getExecutionMode, getAllowedModelTiers } from './store'
import type { ClaudeEffort } from '../types'
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
 *  (notes optional). Pure + exported for unit tests.
 *
 *  LEARNING LOOP (card fdf714ef): when this SAME card was previously sent back
 *  — a 差し戻し / rollback: a RED verify (which tsc/test failed) or an
 *  adversarial-review must-fix — and is being RE-DISPATCHED to a FRESH worker,
 *  `priorFailure` carries WHY it failed last time. It is appended as a clearly
 *  LABELLED clause so the new worker doesn't repeat the same mistake. Still ONE
 *  line (flattenOneLine strips control bytes + collapses newlines, so even a
 *  multi-line tsc tail stays a single slash-command argument); omitted entirely
 *  when there is no prior failure (a first dispatch is byte-for-byte unchanged). */
/** Worker discipline, burned into EVERY spawn prompt — defense-in-depth over
 *  the guard's exit-2 veto (which now blanket-denies `git push` for policed
 *  sessions). 2e7beb2 was a worker following the /order skill's §4 integration
 *  steps ("FF 可 → git push origin <branch>:main" — written for the COMMANDER)
 *  instead of §6's worker rules, with zero heartbeats — so the order itself
 *  now states the worker contract explicitly: no push of any shape, commit +
 *  beat ready + STOP, integration belongs to the commander, and heartbeats are
 *  mandatory (30 min of none is flagged as an anomaly). Single line, same
 *  slash-command-argument constraint as the goal text. Exported so tests pin
 *  the exact contract. */
export const WORKER_ORDER_RULES =
  ' 【worker規律・厳守】あなたは in-app swarm の worker。git push は全形態禁止(guard が exit 2 で機械 block する)— /order スキル §4 の統合手順(push/merge)は司令塔用なので実行しない。実装→検証→git commit まで済ませたら §6 どおり心拍 done true で「停止」し、統合は司令塔に委ねる。心拍 bash ~/.claude/swarm-beat.sh はフェーズ境目ごとに必ず打つ(spawn 後 30 分無心拍は anomaly として司令塔に通報される)。'

export const buildOrderInjection = (title: string, notes?: string, priorFailure?: string): string => {
  const t = flattenOneLine(title || '')
  const n = flattenOneLine(notes || '')
  const goal = t && n ? `${t} — ${n}` : t || n
  const pf = flattenOneLine(priorFailure || '')
  const learn = pf
    ? ` 【前回の差し戻し理由・同じ失敗を繰り返さないこと】${pf}`
    : ''
  return ORDER_PREFIX + goal + learn + WORKER_ORDER_RULES
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
 *  it git refuses a dirty/locked worktree (the safe default).
 *
 *  On a CONFIRMED removal it also drops the worktree's ~/.claude.json folder-trust
 *  entry (ensureClaudeFolderTrusted seeded one on every launchClaude in this dir):
 *  without this, every ephemeral worker dir would pile up in claude's projects map
 *  forever, slowing every claude start's read/write of that file. Not dropped on a
 *  refused removal — the worktree is still live, and the next launch re-seeds it. */
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
  // worktree bookkeeping in the project's repo + any lingering trust entry).
  if (!(await stat(worktree).then(() => true).catch(() => false))) {
    await git(projectPath, ['worktree', 'prune'])
    removeClaudeFolderTrust(worktree)
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
  if (removed === null) {
    return { removed: false, reason: opts.force ? 'git refused' : 'worktree dirty or locked' }
  }
  // Confirmed gone — drop its ~/.claude.json trust entry so ephemeral worktree
  // paths don't accumulate in claude's projects map (see the doc note above).
  removeClaudeFolderTrust(worktree)
  return { removed: true }
}

/** Validate an EXISTING worktree for the RESTART path and read its branch. Same
 *  hard safety as removeSwarmWorktree: the dir MUST sit strictly under THIS
 *  project's central worktrees dir (canonicalized; the bare central root is
 *  refused), so an API-supplied path can never point relaunch at the main
 *  checkout or another project's tree. Returns the ORIGINAL (non-canonicalized)
 *  path so the relaunched PTY's cwd matches the first spawn's exactly (the
 *  killTerminalsByCwd / live-cwd bookkeeping is by exact path). Throws if the
 *  path escapes the central dir, no longer exists, or has no current branch. */
export const resolveExistingSwarmWorktree = async (
  projectPath: string,
  worktree: string,
): Promise<{ worktree: string; branch: string }> => {
  const central = await canonicalize(centralWorktreesDir(await projectUUIDFromPath(projectPath)))
  const canon = await canonicalize(worktree)
  if (canon === central || !isUnderCentralDir(canon, central)) {
    throw new Error('restart worktree is not under this project’s central worktrees dir')
  }
  if (!(await stat(worktree).then(() => true).catch(() => false))) {
    throw new Error('restart worktree no longer exists')
  }
  // The branch checked out there — the worker keeps working its same swarm/*
  // branch on relaunch (a detached HEAD has none, which we refuse).
  const branch = (await git(worktree, ['branch', '--show-current']))?.trim()
  if (!branch) throw new Error('restart worktree has no current branch')
  return { worktree, branch }
}

// ── Spawn orchestration ─────────────────────────────────────────────────────

export interface SpawnSwarmWorkerOpts {
  projectPath: string
  /** Board goal — typically a card's title (+ notes). Injected as the /order. */
  title: string
  notes?: string
  /** Optional branch-name decoration (uniqueness comes from the timestamp). */
  hint?: string
  /** Extra env for the claude invocation — the commander/supply SWARM_MANAGER=1
   *  role TAG rides this port; a worker passes none. Never an API body value. */
  env?: Record<string, string>
  cols?: number
  rows?: number
  /** RESTART path: reuse this EXISTING central worktree instead of creating a
   *  fresh one, so a dead worker relaunches in place — same `swarm/*` branch +
   *  its in-progress work, no orphan tree / twin branch. Validated to sit under
   *  the project's central worktrees dir (resolveExistingSwarmWorktree); throws
   *  otherwise. Omitted (a fresh dispatch) = create a new worktree off the trunk. */
  worktree?: string
  /** LEARNING LOOP (card fdf714ef): the reason this SAME card was previously
   *  差し戻し / rolled back (RED verify / review must-fix). Appended to the /order
   *  so a RE-DISPATCHED card's fresh worker doesn't repeat the failure. Omitted on
   *  a first dispatch. See {@link buildOrderInjection}. */
  priorFailure?: string
}

/** Build the LaunchClaudeOpts for a worker — pure + exported so the worker's
 *  launch contract is unit-tested without spawning a PTY:
 *   - permissionMode:'bypass' — a worker runs UNATTENDED in a throwaway central
 *     worktree (contained — the manager merges its branch back), so it must not
 *     stall on the first tool-approval prompt with no human watching. Mirrors
 *     swarm-new.sh's `--dangerously-skip-permissions`.
 *   - appContext:false — lean; the /order skill is the worker's protocol, not
 *     the board-API usage card.
 *   - env passthrough — the port the commander/supply SWARM_MANAGER=1 role TAG
 *     rides; a worker's `opts.env` is undefined (no extra env emitted). The
 *     worker's policing is the `guard` opt below (OPENGROUND_GUARD=1), not env.
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
  opts: {
    title: string
    notes?: string
    priorFailure?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
    // Owner-only sandbox experiment (resolved server-side in spawnSwarmWorker).
    // A worker is the prime case: it's ALREADY bypass (unattended), so the
    // sandbox adds OS-enforced containment to that prompt-free run rather than
    // changing prompting. sandboxWritePaths carries the repo's shared .git so the
    // worktree's `git commit`/`push` (objects/refs live in the main checkout) can
    // still land inside the otherwise cwd-confined writes.
    sandbox?: boolean
    sandboxWritePaths?: string[]
  },
  // Mode-resolved model/effort (see resolveSwarmModelEffort). Omitted ⇒ swarmLaunchDefaults
  // keeps the historical opus/max, so any non-mode-aware caller is unchanged.
  me?: { model: string; effort?: ClaudeEffort },
): LaunchClaudeOpts => ({
  cwd: worktree,
  agentSessionId,
  appContext: false,
  sandbox: opts.sandbox,
  sandboxWritePaths: opts.sandboxWritePaths,
  // A3/L4: arm the deterministic PreToolUse deny veto for EVERY worker,
  // sandbox experiment on or off — the worker runs bypass (no permission
  // prompts), so the exit-2 hook is the one deterministic veto left. Write
  // confinement = the worktree; the shared .git is NOT a write root (git
  // works through its own binary, which the guard's Bash rules govern —
  // a root there would only legitimize raw redirects into .git).
  guard: { writeRoots: [worktree] },
  // A3/L4 completeness: a bypass worker must NOT inherit the user-scope MCP
  // servers (~/.claude.json / project .mcp.json). The PreToolUse guard vetoes
  // Bash + the file-write tools, but MCP tools (mcp__*) sit OUTSIDE that set —
  // a filesystem/shell MCP, supabase execute_sql, or chrome javascript_tool
  // would be an unguarded RCE path straight past the veto. `--strict-mcp-config`
  // makes claude load ONLY explicitly-passed MCP config (none here), so those
  // tools don't exist in a worker at all — closing the gap at the source rather
  // than trying to enumerate every mcp__* into the hook matcher. Same rationale
  // as OG's other auto-triggered/bypass utility sessions. (Commander MUST-FIX 2.)
  strictMcpConfig: true,
  ...swarmLaunchDefaults('worker', me),
  // permissionMode LAST — AFTER the spread — so 'bypass' is UNCONDITIONAL: an
  // unattended worker must never wedge on a tool-approval / trust prompt with no
  // human watching (Card 4880e9c6's "塞ぐ権限待ち経路"). Positioned here so a
  // future field added to swarmLaunchDefaults can never silently clobber it; the
  // orchestrator's permission-wait detector is only the BACKSTOP for a prompt that
  // somehow still appears. (swarmLaunchDefaults sets no permissionMode today, so
  // this is purely defensive — no behavior change.)
  permissionMode: 'bypass',
  env: opts.env,
  cols: opts.cols,
  rows: opts.rows,
  initialPrompt: buildOrderInjection(opts.title, opts.notes, opts.priorFailure),
})

/** Thrown when the L4 guard wiring cannot be VERIFIED at spawn time (GAP-2).
 *  A worker runs bypass, so the PreToolUse deny veto is its only deterministic
 *  block — and Claude Code fails a MISSING hook OPEN. Unverified wiring ⇒ no
 *  worker (fail-closed), the same shape as NoAllowedModelTierError above. */
export class GuardWiringError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(
      'L4 guard wiring failed verification — worker spawn refused (fail-closed): ' +
        (problems.length ? problems.join('; ') : 'unknown wiring problem'),
    )
    this.name = 'GuardWiringError'
    this.problems = problems
  }
}

// One bell/toast per THROTTLE window, not per refused spawn — the engine's
// dispatch tick retries a refused spawn every few seconds, and the refusal
// itself (the throw) already repeats; only the human-facing notification needs
// deduping. In-memory on purpose: a restart re-notifying once is fine.
const GUARD_UNWIRED_NOTIFY_THROTTLE_MS = 10 * 60_000
let lastGuardUnwiredNotifyAt = 0
export const __resetGuardUnwiredNotifyThrottleForTests = (): void => {
  lastGuardUnwiredNotifyAt = 0
}
const notifyGuardUnwired = async (
  projectPath: string,
  problems: readonly string[],
): Promise<void> => {
  const now = Date.now()
  if (now - lastGuardUnwiredNotifyAt < GUARD_UNWIRED_NOTIFY_THROTTLE_MS) return
  lastGuardUnwiredNotifyAt = now
  // Awaited (persist BEFORE the refusal throws — a fire-and-forget write could
  // be lost with the process), but its own failure is swallowed: the
  // notification must never decide the refusal, which happens regardless.
  await createSwarmFatalNotification({
    event: 'guard-unwired',
    detail:
      'L4ガード(PreToolUse veto)の配線検証に失敗したため、worker の起動を拒否しました(fail-closed)。' +
      `詳細: ${problems.join(' / ')}`,
    projectPath,
    logHint:
      '~/.claude/settings.json と ~/.openground/guard/ を確認してください(OPEN GROUND 再起動で再インストールが走ります)。',
  }).catch(() => {})
}

/** Create the worktree and launch ONE interactive claude PTY in it, handing the
 *  `/order ゴール: …` goal to claude as its POSITIONAL prompt so it runs the
 *  command on startup (see the delivery note above — a TUI-injected slash
 *  command does not submit). Subscription-only: launchClaude drives the user's
 *  `claude` CLI, never `claude -p`/the SDK. Returns as soon as the PTY is up;
 *  claude boots and begins on the goal on its own. */
export const spawnSwarmWorker = async (
  opts: SpawnSwarmWorkerOpts,
): Promise<SpawnSwarmWorkerResponse> => {
  // Token budget (card 68d8e00f): the mode (+ this card's weight, in optimize) picks
  // the worker's model/effort. economy ⇒ sonnet/low, max ⇒ fable/max, optimize ⇒ heavy
  // cards fable, chores sonnet. A per-card explicit override still wins via the Board
  // 実行 button's task.run; unattended orchestrator dispatch has none, so it rides the mode.
  //
  // Resolved BEFORE the worktree is created: with every tier switched OFF there is
  // no model to launch on, and failing here leaves no orphan worktree/branch behind
  // (fail-CLOSED — the hard mask must never be worked around by "just spawn anyway").
  const me = resolveSwarmModelEffort(
    await getExecutionMode(),
    'worker',
    { title: opts.title, notes: opts.notes },
    Date.now(),
    await getAllowedModelTiers(),
  )
  if (!me) throw new NoAllowedModelTierError()
  // L4 WIRING GATE (GAP-2) — fail-closed, and like the model mask above it runs
  // BEFORE the worktree exists so a refusal leaves no orphan worktree/branch.
  // A worker runs bypass inside a worktree that SHARES the main repo's .git,
  // and Claude Code fails a MISSING PreToolUse hook OPEN — so boot-time
  // installHooks() being fire-and-forget (server/index.ts) used to mean a
  // failed install still let unguarded workers spawn. Here the wiring is
  // verified on every spawn (settings.json entries + installed guard body
  // byte-identical to the expected version), self-healing once through the
  // idempotent installHooks(); when it STILL doesn't verify, the spawn is
  // refused and the refusal is surfaced to the UI (bell + OS toast, throttled).
  // Covers every worker path — engine dispatch, POST /api/swarm/worker, RESTART.
  const wiring = await ensureGuardWiring()
  if (!wiring.ok) {
    await notifyGuardUnwired(opts.projectPath, wiring.problems)
    throw new GuardWiringError(wiring.problems)
  }
  // RESTART (opts.worktree) relaunches IN the existing worktree — same swarm/*
  // branch + work preserved; a fresh dispatch creates a new isolated worktree.
  const { worktree, branch } = opts.worktree
    ? await resolveExistingSwarmWorktree(opts.projectPath, opts.worktree)
    : await createSwarmWorktree(opts.projectPath, { hint: opts.hint })
  const agentSessionId = randomUUID()
  // Owner-only sandbox gate, resolved SERVER-side (owner role && the toggle) —
  // never from the dispatch request. When open, the worker's already-bypass run
  // is wrapped in a Seatbelt sandbox confined to its worktree; the repo's shared
  // `.git` is granted write so `git commit`/`push` still works (a worktree's
  // objects/refs live in the main checkout, outside the worktree cwd). macOS-only
  // (launchClaude no-ops it elsewhere); the worker's symlinked node_modules is left
  // fully READ-only — NO carve-out (a writable node_modules would let a sandboxed
  // worker poison code, e.g. `.vite/deps`, the owner later runs UN-sandboxed).
  const sandbox = await isExperimentEnabled('sandbox')
  const ref = launchClaude(
    workerLaunchOpts(
      worktree,
      agentSessionId,
      {
        ...opts,
        sandbox,
        sandboxWritePaths: sandbox ? [join(opts.projectPath, '.git')] : undefined,
      },
      me,
    ),
  )
  // `model` rides back so the orchestrator can attribute a later rate-limit
  // sighting on this worker to the RIGHT quota tier (swarmQuota cooling table).
  return { terminalId: ref.terminalId, agentSessionId, worktree, branch, model: me.model }
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
