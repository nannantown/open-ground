// swarmSupply — the in-app, tmux-free replacement for the shell swarm's
// `swarm-supply.sh`. It is the "supply officer (補給官)" primitive of the OPEN
// GROUND swarm port (docs / auto-memory project_inapp_swarm_port): the user's
// CONVERSATION DESK. Given a registered project it launches ONE interactive
// `claude` PTY in the project's PRIMARY checkout running the `/supply` skill,
// which listens to the user's vague requests, sharpens each into an OBSERVABLE
// task, and files it into the project's Board `todo` column (via the Board HTTP
// API / swarm-board.sh). It does NOT dispatch workers and does NOT merge — it
// only fills the queue; the human (or a future manager) drains todo → workers.
//
// Unlike a WORKER (swarmWorker.ts) the supply officer gets NO worktree: it
// operates on the primary checkout — it only READS the repo + writes the
// recoverable Board, never editing code or pushing. So there is nothing to tear
// down on stop; stopping it is a plain PTY kill (the terminal DELETE route).
//
// This mirrors `swarm-supply.sh` exactly:
//   exec env SWARM_MANAGER=1 claude --model opus --effort max \
//        --dangerously-skip-permissions --remote-control supply "/supply"
//   - SWARM_MANAGER=1 — TAGS the session as the supply officer (for tooling / the
//     /supply skill). Under WORKER-ONLY guard scoping (2026-07) this is NOT a guard
//     opt-in: like the commander, the supply desk is a TRUSTED session (it only
//     READS the repo + writes the recoverable Board), so the PreToolUse veto —
//     which polices only the confined worker — does not apply to it.
//   - bypass (--dangerously-skip-permissions) — the desk writes Board cards
//     unattended-style so the conversation isn't interrupted by a tool-approval
//     prompt on every `swarm-board.sh add`; its safety net is the human, not the veto.
//   - opus / max — the supply officer is a PM translating intent into precise,
//     observable tasks; it runs at full capability (mirrors the shell launcher).
//   - /supply as claude's POSITIONAL prompt — claude runs the skill on startup,
//     then stays interactive for the conversation. (A TUI-injected slash command
//     would not submit — the same delivery fix swarmWorker documents for /order.)
// Subscription-only: launchClaude drives the user's `claude` CLI, never
// `claude -p` / the SDK.

import { randomUUID } from 'crypto'
import { launchClaude, type LaunchClaudeOpts } from './claudeTerminal'
import {
  swarmLaunchDefaults,
  resolveSwarmModelEffortProbed,
  resolveSwarmRemoteName,
} from './swarmLaunch'
import { NoAllowedModelTierError } from './swarmAllowedModels'
import { resolveSwarmSession, recordSwarmSession } from './swarmSessions'
import { getExecutionMode, getAllowedModelTiers } from './store'
import type { ClaudeEffort } from '../types'
import { type SpawnSwarmSupplyResponse } from '../types'

/** The skill the supply session runs, handed to claude as its positional prompt
 *  (claude submits it on startup; a TUI-injected slash command would not). */
export const SUPPLY_INJECTION = '/supply'

/** The positional prompt for a RESUMED supply desk (swarmSessions.ts): the same
 *  `/supply` skill, plus the one thing a restored conversation must be told —
 *  its memory of the Board is STALE. The desk was last awake before an app
 *  restart, and in the meantime the commander may have dispatched, merged or
 *  closed the very cards it remembers filing, so anything it "knows" about the
 *  queue is a guess. Re-reading the Board before filing is also the standing
 *  house rule for this role (積む前に必ず現状調査): a supply officer working from
 *  stale memory files duplicates of work that already shipped.
 *
 *  ONE LINE, on purpose — the same hard-won delivery contract buildOrderInjection
 *  (swarmWorker.ts) documents: the whole thing must land as a SINGLE slash-command
 *  argument. A multi-line positional risks being split, or collapsed into a
 *  `[Pasted text]` chip where `/supply` is never parsed as a command at all. */
export const SUPPLY_RESUME_INJECTION =
  '/supply セッション再開: アプリ再起動をまたいで前回の会話を復元した。あなたの記憶は古い — 前回以降に司令官が配車・統合・完了させたカードがある。新しいカードを積む前に、まず Board の現状(todo/doing/review)を API で読み直し、既に実装済み・重複・前提が変わったタスクを積まないこと。読み直した結果を1行で報告してから待機する。'

export interface SpawnSwarmSupplyOpts {
  /** The registered project to feed — the supply PTY's cwd (its primary
   *  checkout). The route validates this with validateProjectPath first. */
  projectPath: string
  cols?: number
  rows?: number
  /** Force a BRAND-NEW conversation, ignoring (and overwriting) the persisted
   *  session id. The escape hatch for a desk whose restored context has gone bad
   *  — off by default, so the normal button always resumes. */
  fresh?: boolean
}

/** Build the LaunchClaudeOpts for a supply session — pure + exported so the
 *  launch contract is unit-tested without spawning a PTY:
 *   - cwd = the project's PRIMARY checkout (NOT a worktree); supply reads the
 *     repo + writes the Board, it never branches.
 *   - permissionMode:'bypass' — so board writes aren't gated by a tool-approval
 *     prompt on every turn (mirrors swarm-supply.sh's --dangerously-skip-…).
 *   - env { SWARM_MANAGER:'1' } — TAGS the session as the supply officer for
 *     tooling / the /supply skill. Under worker-only guard scoping this is NOT a
 *     guard opt-in: the trusted supply desk is unpoliced (the veto polices only the
 *     confined worker, which passes OPENGROUND_GUARD=1 + write roots instead).
 *   - appContext:true — supply's whole job is writing Board cards, so the
 *     app-context card (board API + "track on the Board, not an internal todo")
 *     is exactly on-mission (the worker turns it off for leanness; supply keeps it).
 *   - model/effort/remoteControl — opus/max + Remote Control ON via the shared
 *     swarm launch default (swarmLaunch.ts), mirroring the shell supply officer's
 *     `--model opus --effort max … --remote-control <name>`. effort is
 *     CLAUDE_EFFORTS-guarded there. The Remote Control session name is the
 *     IDENTIFIABLE one the spawn path resolved (resolveSwarmRemoteName:
 *     「タスク窓口 <プロジェクト表示名>」/ "Supply officer <project>" per the app
 *     language) — opts.remoteName; absent (legacy caller) it falls back to the
 *     historical fixed 'supply'.
 *   - initialPrompt — `/supply` positional (claude runs the skill on startup). */
//   - resume — when the project already has a supply conversation claude can load
//     (swarmSessions.resolveSwarmSession proved it), the SAME session id rides
//     `--resume` instead of `--session-id` (buildClaudeArgv) and the desk wakes up
//     with its memory intact, plus the stale-Board warning above. Absent ⇒ the
//     historical fresh-session launch, byte-for-byte.
export const supplyLaunchOpts = (
  cwd: string,
  agentSessionId: string,
  opts: { cols?: number; rows?: number; resume?: boolean; remoteName?: string } = {},
  // Mode-resolved model/effort (omitted ⇒ opus/max, back-compat).
  me?: { model: string; effort?: ClaudeEffort },
): LaunchClaudeOpts => ({
  cwd,
  agentSessionId,
  permissionMode: 'bypass',
  appContext: true,
  // Supply is NOT policed by the PreToolUse veto (worker-only scoping), so
  // strictMcpConfig is no longer a veto-pairing requirement here. Kept as
  // DEFENSE-IN-DEPTH: the supply desk boots with only its explicit MCP config
  // (none) instead of inheriting user-scope MCP servers. (The confined WORKER
  // still REQUIRES strictMcpConfig — mcp__* tools bypass ITS veto.)
  strictMcpConfig: true,
  // A DESK the owner talks to (フワッとした要望 → Board カード), not an unattended
  // worker: a model-limit stop here stops the owner's own conversation. Watched by
  // ownerDeskLimit.ts, which names it by the role the owner knows it as.
  ownerDesk: true,
  deskLabel: '補給官',
  ...swarmLaunchDefaults(opts.remoteName ?? 'supply', me),
  env: { SWARM_MANAGER: '1' },
  cols: opts.cols,
  rows: opts.rows,
  ...(opts.resume ? { resume: true } : {}),
  initialPrompt: opts.resume ? SUPPLY_RESUME_INJECTION : SUPPLY_INJECTION,
})

/** Launch ONE interactive claude PTY in the project's primary checkout running
 *  the `/supply` skill (handed positionally so claude submits it on startup).
 *  Subscription-only (launchClaude — never `claude -p`/the SDK). Returns as soon
 *  as the PTY is up; claude boots and invokes /supply on its own. No worktree is
 *  created, so there is nothing to clean up on stop — the caller just kills the
 *  PTY.
 *
 *  RESUMES the project's previous supply conversation whenever claude can still
 *  load it (swarmSessions.ts) — the desk is a days-long conversation, not a
 *  disposable worker, so an app restart must not wipe its memory. Fail-open: any
 *  doubt about the persisted session (gone, corrupt, still open, project moved)
 *  and it opens a fresh one instead. The desk always launches. */
export const spawnSwarmSupply = async (
  opts: SpawnSwarmSupplyOpts,
): Promise<SpawnSwarmSupplyResponse> => {
  // `fresh` skips the lookup entirely (and overwrites the record below) — the
  // owner's way out of a restored context that has gone bad.
  const session = opts.fresh
    ? { agentSessionId: randomUUID(), resume: false }
    : await resolveSwarmSession(opts.projectPath, 'supply')
  // Token budget (card 68d8e00f): economy/optimize run the supply officer on sonnet.
  // Null ⇒ every tier switched OFF: no model, no spawn (the same hard mask every
  // other swarm role obeys — fail-CLOSED). Checked BEFORE we record anything, so a
  // refused launch never leaves a session id pointing at a conversation that
  // does not exist.
  // PROBED (2026-07-13): same pre-launch wall check as every other spawn path —
  // an UNKNOWN tier gets one collapsed headless probe before the desk is seated
  // on it (swarmTierProbe); wall ⇒ cool + one rung down, unknown ⇒ fail-open.
  const me = await resolveSwarmModelEffortProbed(
    await getExecutionMode(),
    'supply',
    undefined,
    Date.now(),
    await getAllowedModelTiers(),
  )
  if (!me) throw new NoAllowedModelTierError()
  // Remote Control 名の識別化: 「タスク窓口 <プロジェクト表示名>」/ "Supply officer
  // <project>"(言語は Settings.language、表示名は registry の displayName ||
  // フォルダ名)。resolveSwarmRemoteName は never-throws — 解決に失敗しても旧固定名
  // 'supply' で spawn は通る。
  const remoteName = await resolveSwarmRemoteName('supply', opts.projectPath)
  const ref = launchClaude(
    supplyLaunchOpts(
      opts.projectPath,
      session.agentSessionId,
      { cols: opts.cols, rows: opts.rows, resume: session.resume, remoteName },
      me,
    ),
  )
  // Persist for the NEXT boot. Best-effort by design: a failed write only costs the
  // desk its memory on the following launch (it starts fresh — the old behaviour),
  // and must NEVER turn a successfully-spawned PTY into a 500.
  await recordSwarmSession(opts.projectPath, 'supply', session.agentSessionId).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[swarmSupply] could not persist the supply session id: ${String(e)}`)
  })
  return {
    terminalId: ref.terminalId,
    agentSessionId: session.agentSessionId,
    resumed: session.resume,
  }
}
