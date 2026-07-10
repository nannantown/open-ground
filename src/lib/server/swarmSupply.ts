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
import { swarmLaunchDefaults, resolveSwarmModelEffort } from './swarmLaunch'
import { NoAllowedModelTierError } from './swarmAllowedModels'
import { getExecutionMode, getAllowedModelTiers } from './store'
import type { ClaudeEffort } from '../types'
import { type SpawnSwarmSupplyResponse } from '../types'

/** The skill the supply session runs, handed to claude as its positional prompt
 *  (claude submits it on startup; a TUI-injected slash command would not). */
export const SUPPLY_INJECTION = '/supply'

export interface SpawnSwarmSupplyOpts {
  /** The registered project to feed — the supply PTY's cwd (its primary
   *  checkout). The route validates this with validateProjectPath first. */
  projectPath: string
  cols?: number
  rows?: number
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
 *     `--model opus --effort max … --remote-control supply`. effort is
 *     CLAUDE_EFFORTS-guarded there; the Remote Control session is named 'supply'.
 *   - initialPrompt — `/supply` positional (claude runs the skill on startup). */
export const supplyLaunchOpts = (
  cwd: string,
  agentSessionId: string,
  opts: { cols?: number; rows?: number } = {},
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
  ...swarmLaunchDefaults('supply', me),
  env: { SWARM_MANAGER: '1' },
  cols: opts.cols,
  rows: opts.rows,
  initialPrompt: SUPPLY_INJECTION,
})

/** Launch ONE interactive claude PTY in the project's primary checkout running
 *  the `/supply` skill (handed positionally so claude submits it on startup).
 *  Subscription-only (launchClaude — never `claude -p`/the SDK). Returns as soon
 *  as the PTY is up; claude boots and invokes /supply on its own. No worktree is
 *  created, so there is nothing to clean up on stop — the caller just kills the
 *  PTY. */
export const spawnSwarmSupply = async (
  opts: SpawnSwarmSupplyOpts,
): Promise<SpawnSwarmSupplyResponse> => {
  const agentSessionId = randomUUID()
  // Token budget (card 68d8e00f): economy/optimize run the supply officer on sonnet.
  // Null ⇒ every tier switched OFF: no model, no spawn (the same hard mask every
  // other swarm role obeys — fail-CLOSED).
  const me = resolveSwarmModelEffort(
    await getExecutionMode(),
    'supply',
    undefined,
    Date.now(),
    await getAllowedModelTiers(),
  )
  if (!me) throw new NoAllowedModelTierError()
  const ref = launchClaude(
    supplyLaunchOpts(opts.projectPath, agentSessionId, { cols: opts.cols, rows: opts.rows }, me),
  )
  return { terminalId: ref.terminalId, agentSessionId }
}
