// swarmManager — the in-app, tmux-free replacement for the shell swarm's
// `manager` cockpit pane (the `/manage` commander). It is the "commander
// (司令官)" CONVERSATION primitive of the OPEN GROUND swarm port (docs /
// auto-memory project_inapp_swarm_port): the owner's INTEGRATION DESK. Given a
// registered project it launches ONE interactive `claude` PTY in the project's
// PRIMARY checkout running the `/og-manage` skill — the tmux-free commander
// protocol — which monitors the workers, answers "状況 / マージ / 掃除 / 相談",
// and integrates finished `swarm/*` branches (FF / rebase only, never forced)
// — all in conversation with the user, driving the app's own HTTP API (never
// tmux; the shell cockpit's `/manage` skill stays tmux-land, untouched).
//
// This is the human-in-the-loop counterpart to the AUTONOMOUS engine
// (swarmOrchestrator, behind /api/swarm/orchestrator): the engine is the
// unattended drain → dispatch → monitor → integrate loop the commander dashboard
// arms with its toggles; THIS session is the commander you talk to. The two
// coexist on the same tab.
//
// Like the SUPPLY officer (swarmSupply.ts) and UNLIKE a WORKER (swarmWorker.ts),
// the commander conversation gets NO worktree: it operates on the primary
// checkout. It runs bypass and — under WORKER-ONLY guard scoping (2026-07) — is
// NOT policed by the PreToolUse veto: the commander is the human-in-the-loop
// integration desk, a TRUSTED session the user talks to, so it runs with the same
// freedom as a plain claude (the veto polices only the confined, unattended worker
// — see scripts/openground-guard.js). SWARM_MANAGER=1 now only TAGS the session as
// the commander for tooling/skills, not as a guard opt-in. There is nothing to
// tear down on stop; stopping it is a plain PTY kill (the terminal DELETE route).
//
// This mirrors the shell `manager` launcher's FLAGS exactly — but hands claude
// the app-native skill instead of the cockpit one:
//   shell:  exec env SWARM_MANAGER=1 claude --model opus --effort max \
//               --dangerously-skip-permissions --remote-control manager "/manage"
//   in-app: same flags, positional prompt = "/og-manage"
//   - SWARM_MANAGER=1 — TAGS the session as the swarm commander (for tooling /
//     the commander skill). Under worker-only guard scoping it is NOT a guard
//     opt-in: the trusted commander is not policed by the PreToolUse veto.
//   - bypass (--dangerously-skip-permissions) — the commander runs git
//     (status / merge / branch -d) and Board moves unattended-style so the
//     conversation isn't interrupted by a tool-approval prompt each turn; its
//     safety net is the human in the loop, not the veto.
//   - opus / max — the commander reasons about integration order, conflicts and
//     worker state at full capability (mirrors the shell launcher).
//   - /og-manage as claude's POSITIONAL prompt — claude runs the skill on
//     startup, then stays interactive for the conversation. (A TUI-injected
//     slash command would not submit — the delivery fix swarmSupply/swarmWorker
//     document.) The skill difference is the point: /manage assumes a tmux
//     cockpit (swarm-pane.sh dispatch, respawn, swarm-watch), none of which
//     exist inside the app's PTY; /og-manage speaks the app's HTTP API instead.
// Subscription-only: launchClaude drives the user's `claude` CLI, never
// `claude -p` / the SDK.

import { randomUUID } from 'crypto'
import { launchClaude, type LaunchClaudeOpts } from './claudeTerminal'
import { swarmLaunchDefaults, resolveSwarmModelEffort } from './swarmLaunch'
import { NoAllowedModelTierError } from './swarmAllowedModels'
import { installOgManageSkill } from './ogManageSkill'
import { getExecutionMode, getAllowedModelTiers } from './store'
import type { ClaudeEffort } from '../types'
import { type SpawnSwarmManagerResponse } from '../types'

/** The skill the commander session runs, handed to claude as its positional
 *  prompt (claude submits it on startup; a TUI-injected slash command would
 *  not). The role is the `manager` (Remote Control label) running `/og-manage`
 *  — the tmux-FREE commander protocol (~/.claude/skills/og-manage/): its eyes
 *  are GET /api/swarm/workers + git, it dispatches via POST /api/swarm/worker,
 *  and it never mentions or runs tmux. The shell cockpit's `/manage` (tmux
 *  panes, swarm-pane.sh dispatch) stays untouched for the terminal cockpit —
 *  an in-app commander running THAT skill would advise tmux commands that
 *  cannot work inside the app's PTY, which is exactly why this injection
 *  points at the app-native sibling instead. */
export const MANAGER_INJECTION = '/og-manage'

export interface SpawnSwarmManagerOpts {
  /** The registered project to command — the commander PTY's cwd (its primary
   *  checkout). The route validates this with validateProjectPath first. */
  projectPath: string
  cols?: number
  rows?: number
}

/** Build the LaunchClaudeOpts for a commander conversation — pure + exported so
 *  the launch contract is unit-tested without spawning a PTY:
 *   - cwd = the project's PRIMARY checkout (NOT a worktree); the commander reads
 *     the repo, moves Board cards and integrates `swarm/*` branches on the trunk.
 *   - permissionMode:'bypass' — so its git + Board moves aren't gated by a
 *     tool-approval prompt on every turn (mirrors the shell `--dangerously-skip-…`).
 *   - env { SWARM_MANAGER:'1' } — TAGS the session as the swarm commander for
 *     tooling / the /manage skill. Under worker-only guard scoping this is NOT a
 *     guard opt-in: the trusted commander is unpoliced (the veto polices only the
 *     confined worker, which passes OPENGROUND_GUARD=1 + write roots instead).
 *   - appContext:true — the commander drives the Board (drain todo → review →
 *     done) through the app's HTTP API, so the app-context card is on-mission
 *     (same as supply; the worker turns it off for leanness).
 *   - model/effort/remoteControl — opus/max + Remote Control ON via the shared
 *     swarm launch default (swarmLaunch.ts), mirroring the shell commander's
 *     `--model opus --effort max … --remote-control manager`. effort is
 *     CLAUDE_EFFORTS-guarded there; the Remote Control session is named 'manager'.
 *   - initialPrompt — `/og-manage` positional (claude runs the tmux-free
 *     commander skill on startup). */
export const managerLaunchOpts = (
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
  // The manager is NOT policed by the PreToolUse veto (worker-only scoping), so
  // strictMcpConfig is no longer a veto-pairing requirement here. Kept as
  // DEFENSE-IN-DEPTH: the commander boots with only its explicit MCP config (none)
  // instead of inheriting whatever user-scope MCP servers happen to be present,
  // keeping the engine-driven commander deterministic. (The confined WORKER still
  // REQUIRES strictMcpConfig — mcp__* tools bypass ITS veto; see swarmWorker.ts.)
  strictMcpConfig: true,
  ...swarmLaunchDefaults('manager', me),
  env: { SWARM_MANAGER: '1' },
  cols: opts.cols,
  rows: opts.rows,
  initialPrompt: MANAGER_INJECTION,
})

/** Launch ONE interactive claude PTY in the project's primary checkout running
 *  the `/og-manage` skill (handed positionally so claude submits it on startup).
 *  Subscription-only (launchClaude — never `claude -p`/the SDK). Returns as soon
 *  as the PTY is up; claude boots and invokes /manage on its own. No worktree is
 *  created, so there is nothing to clean up on stop — the caller just kills the
 *  PTY. */
export const spawnSwarmManager = async (
  opts: SpawnSwarmManagerOpts,
): Promise<SpawnSwarmManagerResponse> => {
  const agentSessionId = randomUUID()
  // Self-repair the /og-manage skill RIGHT BEFORE launch (idempotent, best-
  // effort): the boot-time install covers the normal path, but a skill deleted
  // mid-session — or a dev server that booted before the skill shipped — would
  // otherwise hand claude a slash command that resolves to nothing. A
  // user-authored file (managed-by marker removed) is still never overwritten,
  // and a failure never blocks the spawn (the commander then just reports the
  // missing skill conversationally).
  await installOgManageSkill().catch(() => {})
  // Token budget (card 68d8e00f): economy runs the commander on sonnet; optimize keeps
  // it on the top tier (its integration / safety-review judgment is quality-critical).
  // Null ⇒ the owner switched every tier OFF: no model, no spawn (fail-CLOSED — the
  // commander is a claude PTY like any other and honors the same hard mask).
  const me = resolveSwarmModelEffort(
    await getExecutionMode(),
    'manager',
    undefined,
    Date.now(),
    await getAllowedModelTiers(),
  )
  if (!me) throw new NoAllowedModelTierError()
  const ref = launchClaude(
    managerLaunchOpts(opts.projectPath, agentSessionId, { cols: opts.cols, rows: opts.rows }, me),
  )
  return { terminalId: ref.terminalId, agentSessionId }
}
