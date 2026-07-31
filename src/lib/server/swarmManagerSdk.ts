// swarmManagerSdk — the COMMANDER-shaped glue for the Agent SDK runtime.
//
// `managerLaunchOpts` (swarmManager.ts) is the PTY commander's launch contract;
// this is its SDK counterpart. The engine, the Board, the integration protocol
// and the owner's vocabulary («状況 / マージ / 掃除») are identical either way, so
// anything that differs here is a behaviour difference the rest of the system
// does not know about. Parity, item by item:
//
//   • THE SKILL. `/og-manage` IS the commander — every guarantee it carries
//     (never force-push, only `swarm/*`, adversarial review before merge) lives
//     in that file, handed to claude as the first message. In a PTY that is a
//     TUI slash command; in an SDK session it is just a user message starting
//     with a slash, so whether the CLI still expands it decides the whole
//     migration. MEASURED 2026-07-31 (scripts/probe-sdk-skill-resolution.mts):
//     an SDK session advertises 95 slash commands, `/og-manage` among them,
//     offers the `Skill` tool, and answering «what does your protocol forbid?»
//     it named `git stash` / force-push / `branch -D` — verbatim from the skill.
//     It resolves.
//
//   • THE APP-CONTEXT CARD. The PTY path appends it with
//     `--append-system-prompt` (claudeTerminal.ts); without it the commander
//     does not know the API base URL, and `/og-manage`'s entire toolbox is
//     `curl $OG/api/...`. The SDK equivalent is `systemPrompt.append`, MEASURED
//     to arrive (scripts/probe-sdk-system-prompt.mts returned the probe token
//     out of the system prompt). ⚠ The same probe found that an SDK session
//     does NOT identify as Claude Code — it says "You are a Claude agent, built
//     on Anthropic's Claude Agent SDK", with or without
//     `preset:'claude_code'`. The preset is passed anyway (it is the documented
//     way to ask for Claude Code's prompt, and `append` rides on it), but do not
//     read it as proving the two runtimes share a system prompt. They do not.
//
//   • NO GUARD. Deliberate, and the opposite of the worker. Under worker-only
//     guard scoping the commander is a TRUSTED desk the owner talks to: the PTY
//     path passes no `guard`, so arming the PreToolUse veto here would make the
//     SDK commander STRICTER than the PTY one and break the very `git push
//     origin HEAD:main` that integration is. The commander's safety net is the
//     human in the loop plus its own protocol — see swarmManager.ts's header.
//
//   • REMOTE CONTROL IS GONE. `--remote-control` does nothing outside an
//     interactive REPL, so an SDK commander cannot be reached from a phone.
//     That is the ONE capability this migration spends, and it is spent
//     deliberately: the SUPPLY desk stays on a PTY and carries the owner's
//     phone window, which is why it was given the status-reporting duty first
//     (skills/supply/SKILL.md, docs/SDK_CLIENT_INVESTIGATION.md §13-A).
//
//   • ONE DESK PER PROJECT still holds, and now spans both pools — see
//     swarmManagerRuntime.ts.

import { homedir } from 'os'
import {
  sdkClaudeBinaryPreflight,
  sdkSessionEnv,
  SdkWorkerUnavailableError,
  type SdkPreflightResult,
} from './swarmWorkerSdk'
import { buildAppContextPrompt } from './claudeTerminal'
import { MANAGER_INJECTION, MANAGER_RESUME_INJECTION } from './swarmManager'
import { swarmLaunchDefaults } from './swarmLaunch'
import type { ClaudeEffort } from '../types'

/** Raised when an SDK commander was asked for but cannot be launched safely.
 *  Reuses the worker's error type so callers have one thing to catch. */
export { SdkWorkerUnavailableError as SdkManagerUnavailableError }

/** Everything that must be true before an SDK commander may start.
 *
 *  Deliberately NOT the worker's preflight: that one also proves the A3/L4 veto
 *  has teeth, because a worker without its veto is an unpoliced unattended
 *  agent. The commander has no veto BY DESIGN (see the header), so demanding one
 *  here would refuse to launch over the absence of something the PTY commander
 *  also does not have. What remains is the part that is about the commander:
 *  the USER'S claude must be resolvable (subscription-only) and new enough that
 *  the stream-json contract is the measured one. */
export const sdkManagerPreflight = (opts?: {
  claudeBin?: string | null
  readVersion?: (bin: string) => string
}): SdkPreflightResult => sdkClaudeBinaryPreflight(opts)

export interface SdkManagerOptsInput {
  /** The project's PRIMARY checkout — the commander never gets a worktree. */
  projectPath: string
  /** The claude conversation id (`sessionId` fresh / `resume` continuing). */
  agentSessionId: string
  resume?: boolean
  /** Mode-resolved model/effort. Omitted ⇒ the historical swarm defaults. */
  me?: { model: string; effort?: ClaudeEffort }
  /** Resolved by the caller's preflight; must be the USER'S claude. */
  claudeBin: string
  /** Loopback port the app-context card points the commander's `curl` at. */
  port?: number
  env?: NodeJS.ProcessEnv
  home?: string
}

export interface SdkManagerLaunchPlan {
  options: Record<string, unknown>
  initialPrompt: string
  warnings: string[]
}

/** The port the app-context card advertises. Same resolution claudeTerminal.ts
 *  uses for the PTY card, so both runtimes point the commander at one API. */
const appPort = (): number => Number(process.env.PORT) || 47776

/** Build the SDK launch plan for the commander desk. Pure apart from reading
 *  `env`; the caller decides whether to actually spawn. */
export const sdkManagerLaunchPlan = (opts: SdkManagerOptsInput): SdkManagerLaunchPlan => {
  const warnings: string[] = []
  // `remoteControl` is the one field of swarmLaunchDefaults that cannot survive
  // the runtime change, so it is destructured off rather than silently passed
  // into options where it would do nothing.
  const { remoteControl: _rc, ...modelEffort } = swarmLaunchDefaults('manager', opts.me)
  void _rc
  warnings.push(
    'an SDK commander has no Remote Control session — the owner reaches OPEN GROUND from a phone through the SUPPLY desk (「タスク窓口」), which stays on a PTY',
  )

  const options: Record<string, unknown> = {
    cwd: opts.projectPath,
    // The USER'S claude — never the SDK's bundled copy (subscription-only).
    pathToClaudeCodeExecutable: opts.claudeBin,
    // SWARM_MANAGER=1 TAGS the session as the commander for tooling and skills.
    // It is NOT a guard opt-in (worker-only scoping) — same as the PTY path.
    env: { ...sdkSessionEnv(opts.env), SWARM_MANAGER: '1' },
    // The commander runs git and Board moves turn after turn; a tool-approval
    // prompt would stop the owner's own conversation dead. Mirrors the PTY
    // path's unconditional permissionMode:'bypass'.
    permissionMode: 'bypassPermissions',
    // Defense in depth, exactly as on the PTY side: boot with only the explicit
    // (empty) MCP config instead of inheriting user-scope MCP servers, so an
    // engine-driven commander stays deterministic.
    strictMcpConfig: true,
    mcpServers: {},
    // The app-context card — without it `/og-manage` has no API base URL.
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildAppContextPrompt(opts.projectPath, opts.port ?? appPort()),
    },
    ...modelEffort,
    ...(opts.resume ? { resume: opts.agentSessionId } : { sessionId: opts.agentSessionId }),
  }

  return {
    options,
    initialPrompt: opts.resume ? MANAGER_RESUME_INJECTION : MANAGER_INJECTION,
    warnings,
  }
}

/** Convenience for callers that want the plan or a clear refusal, never a
 *  half-configured commander. */
export const buildSdkManagerLaunch = (
  opts: Omit<SdkManagerOptsInput, 'claudeBin'> & { claudeBin?: string | null },
): SdkManagerLaunchPlan => {
  const pre = sdkManagerPreflight(
    opts.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : undefined,
  )
  if (!pre.ok || !pre.claudeBin) throw new SdkWorkerUnavailableError(pre.problems)
  return sdkManagerLaunchPlan({ ...opts, claudeBin: pre.claudeBin, home: opts.home ?? homedir() })
}
