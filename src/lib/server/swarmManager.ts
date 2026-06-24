// swarmManager — the in-app, tmux-free replacement for the shell swarm's
// `manager` cockpit pane (the `/manage` commander). It is the "commander
// (司令官)" CONVERSATION primitive of the OPEN GROUND swarm port (docs /
// auto-memory project_inapp_swarm_port): the owner's INTEGRATION DESK. Given a
// registered project it launches ONE interactive `claude` PTY in the project's
// PRIMARY checkout running the `/manage` skill, which monitors the workers,
// answers "状況 / マージ / 掃除 / 相談", and integrates finished `swarm/*`
// branches (FF / rebase only, never forced) — all in conversation with the user.
//
// This is the human-in-the-loop counterpart to the AUTONOMOUS engine
// (swarmOrchestrator, behind /api/swarm/orchestrator): the engine is the
// unattended drain → dispatch → monitor → integrate loop the commander dashboard
// arms with its toggles; THIS session is the commander you talk to. The two
// coexist on the same tab.
//
// Like the SUPPLY officer (swarmSupply.ts) and UNLIKE a WORKER (swarmWorker.ts),
// the commander conversation gets NO worktree: it operates on the primary
// checkout. It DOES run git (it integrates branches), so it runs bypass but opts
// INTO the swarm PreToolUse guard (SWARM_MANAGER=1) — the same real-tree safety
// net supply uses, which blocks any stray destructive git (force-push, etc.).
// There is nothing to tear down on stop; stopping it is a plain PTY kill (the
// terminal DELETE route).
//
// This mirrors the shell `manager` launcher exactly:
//   exec env SWARM_MANAGER=1 claude --model opus --effort max \
//        --dangerously-skip-permissions --remote-control manager "/manage"
//   - SWARM_MANAGER=1 — the commander runs bypass IN THE REAL CHECKOUT, so
//     (unlike a worker, contained in a throwaway worktree and passing NO env) it
//     opts INTO the swarm guard. This is the exact purpose of launchClaude's
//     `env` port.
//   - bypass (--dangerously-skip-permissions) — the commander runs git
//     (status / merge / branch -d) and Board moves unattended-style so the
//     conversation isn't interrupted by a tool-approval prompt each turn; the
//     guard above is the safety net (it blocks force-push / dangerous git).
//   - opus / max — the commander reasons about integration order, conflicts and
//     worker state at full capability (mirrors the shell launcher).
//   - /manage as claude's POSITIONAL prompt — claude runs the skill on startup,
//     then stays interactive for the conversation. (A TUI-injected slash command
//     would not submit — the same delivery fix swarmSupply/swarmWorker document.)
// Subscription-only: launchClaude drives the user's `claude` CLI, never
// `claude -p` / the SDK.

import { randomUUID } from 'crypto'
import { launchClaude, type LaunchClaudeOpts } from './claudeTerminal'
import { swarmLaunchDefaults } from './swarmLaunch'
import { type SpawnSwarmManagerResponse } from '../types'

/** The skill the commander session runs, handed to claude as its positional
 *  prompt (claude submits it on startup; a TUI-injected slash command would
 *  not). The role is the `manager` (Remote Control label) running `/manage`. */
export const MANAGER_INJECTION = '/manage'

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
 *   - env { SWARM_MANAGER:'1' } — the commander runs bypass in the REAL checkout,
 *     so it opts INTO the swarm guard (which blocks stray destructive git, e.g.
 *     force-push). The WORKER deliberately passes none (contained worktree); the
 *     commander, like supply, must NOT (real tree).
 *   - appContext:true — the commander drives the Board (drain todo → review →
 *     done) through the app's HTTP API, so the app-context card is on-mission
 *     (same as supply; the worker turns it off for leanness).
 *   - model/effort/remoteControl — opus/max + Remote Control ON via the shared
 *     swarm launch default (swarmLaunch.ts), mirroring the shell commander's
 *     `--model opus --effort max … --remote-control manager`. effort is
 *     CLAUDE_EFFORTS-guarded there; the Remote Control session is named 'manager'.
 *   - initialPrompt — `/manage` positional (claude runs the skill on startup). */
export const managerLaunchOpts = (
  cwd: string,
  agentSessionId: string,
  opts: { cols?: number; rows?: number } = {},
): LaunchClaudeOpts => ({
  cwd,
  agentSessionId,
  permissionMode: 'bypass',
  appContext: true,
  ...swarmLaunchDefaults('manager'),
  env: { SWARM_MANAGER: '1' },
  cols: opts.cols,
  rows: opts.rows,
  initialPrompt: MANAGER_INJECTION,
})

/** Launch ONE interactive claude PTY in the project's primary checkout running
 *  the `/manage` skill (handed positionally so claude submits it on startup).
 *  Subscription-only (launchClaude — never `claude -p`/the SDK). Returns as soon
 *  as the PTY is up; claude boots and invokes /manage on its own. No worktree is
 *  created, so there is nothing to clean up on stop — the caller just kills the
 *  PTY. */
export const spawnSwarmManager = async (
  opts: SpawnSwarmManagerOpts,
): Promise<SpawnSwarmManagerResponse> => {
  const agentSessionId = randomUUID()
  const ref = launchClaude(
    managerLaunchOpts(opts.projectPath, agentSessionId, { cols: opts.cols, rows: opts.rows }),
  )
  return { terminalId: ref.terminalId, agentSessionId }
}
