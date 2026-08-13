// swarmWorkerSdk — the worker-shaped glue for the Agent SDK runtime.
//
// `workerLaunchOpts` (swarmWorker.ts) is the PTY worker's launch contract. This
// is its SDK counterpart, and the two must stay in step: the engine, the Board,
// the roster and the integration pipeline are identical either way, so anything
// that differs here is a behaviour difference the rest of the system does not
// know about.
//
// Parity is enumerated in docs/SDK_WORKER_MIGRATION_PLAN.md §4. The items that
// are NOT one-liners:
//
//   • THE GUARD (§4-G). The SDK does not load filesystem settings, so the A3/L4
//     veto has to be re-armed in process — see sdkGuardHook.ts. It is wired
//     here, and its wiring is VERIFIED before a worker may launch, the same way
//     the PTY path refuses to spawn on unverified hook wiring.
//   • THE BINARY (§4 #11). The SDK defaults to a claude it ships itself. OPEN
//     GROUND must drive the USER'S installed CLI — that is the subscription-only
//     rule and the thing the whole product claims about itself — so
//     `pathToClaudeCodeExecutable` is mandatory, not an option.
//   • REMOTE CONTROL (§4 #9) is simply GONE for an SDK worker: the flag does
//     nothing outside an interactive REPL (measured three ways). The owner's
//     phone window is the supply desk, which stays on a PTY.
//   • THE SANDBOX (§4 #10) is not supported in this stage; a caller asking for
//     both is told, rather than silently getting an unsandboxed worker.

import { homedir } from 'os'
import { execFileSync } from 'child_process'
import { resolvedClaudeBin, absoluteClaudeOnPath } from './claudeConnection'
import { makeSdkGuardHook, verifySdkGuard, type GuardEvaluate } from './sdkGuardHook'
import { buildOrderInjection, WORKER_RESUME_INJECTION } from './swarmWorker'
import { swarmLaunchDefaults } from './swarmLaunch'
import { languageDirective, type PromptLang } from './promptLang'
import type { ClaudeEffort } from '../types'

/** The oldest CLI whose stream-json contract this integration was measured
 *  against (2026-07-30). Older CLIs are refused rather than driven on
 *  assumptions — the caller falls back to a PTY worker. */
export const SDK_WORKER_MIN_CLI_VERSION = '2.1.220'

export class SdkWorkerUnavailableError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(`SDK worker cannot be launched: ${problems.join('; ')}`)
    this.name = 'SdkWorkerUnavailableError'
    this.problems = problems
  }
}

/** Resolve the user's own claude.
 *
 *  ⚠ `resolvedClaudeBin()` is a CACHE filled by claudeConnection() at server
 *  boot; a process that has not run it gets null. The pure resolver is the
 *  fallback so this never silently hands the SDK its bundled binary. */
export const resolveUserClaudeBin = (): string | null =>
  resolvedClaudeBin() ?? absoluteClaudeOnPath()

const parseVersion = (raw: string): number[] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** a >= b for dotted triples. */
const atLeast = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return true
}

export interface SdkPreflightResult {
  ok: boolean
  problems: string[]
  claudeBin: string | null
  cliVersion: string | null
}

/** The BINARY half of the preflight: the user's own claude must be resolvable,
 *  and new enough that the stream-json contract is the one this integration was
 *  measured against.
 *
 *  Split out because it is the ONLY half the commander shares. A worker also
 *  has to prove its veto has teeth; the commander has no veto by design
 *  (worker-only guard scoping — swarmManagerSdk.ts), so demanding one there
 *  would refuse to launch over the absence of something the PTY commander does
 *  not have either. */
export const sdkClaudeBinaryPreflight = (opts?: {
  claudeBin?: string | null
  readVersion?: (bin: string) => string
}): SdkPreflightResult => {
  const problems: string[] = []
  const claudeBin = opts?.claudeBin !== undefined ? opts.claudeBin : resolveUserClaudeBin()
  let cliVersion: string | null = null

  if (!claudeBin) {
    problems.push('the user\'s claude CLI could not be located (subscription-only: the bundled SDK binary must not be used)')
  } else {
    try {
      const raw = (opts?.readVersion ?? ((b: string) => execFileSync(b, ['--version'], { encoding: 'utf8', timeout: 10_000 })))(claudeBin)
      cliVersion = raw.trim().split(/\s+/)[0] ?? null
      const got = parseVersion(raw)
      const need = parseVersion(SDK_WORKER_MIN_CLI_VERSION)!
      if (!got) problems.push(`could not parse a version from \`claude --version\` (${raw.trim().slice(0, 60)})`)
      else if (!atLeast(got, need)) {
        problems.push(`claude ${got.join('.')} is older than the measured floor ${SDK_WORKER_MIN_CLI_VERSION}`)
      }
    } catch (e) {
      problems.push(`\`claude --version\` failed: ${(e as Error)?.message ?? 'unknown'}`)
    }
  }

  return { ok: problems.length === 0, problems, claudeBin, cliVersion }
}

/** Everything that must be true BEFORE an SDK worker is allowed to start.
 *  Fails closed: the caller runs a PTY worker instead rather than launching
 *  something whose veto or binary could not be established. */
export const sdkWorkerPreflight = (opts?: {
  writeRoots?: string[]
  home?: string
  /** Injected for tests. */
  claudeBin?: string | null
  readVersion?: (bin: string) => string
  evaluateFn?: GuardEvaluate
  guardPath?: string
}): SdkPreflightResult => {
  const bin = sdkClaudeBinaryPreflight({
    ...(opts?.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : {}),
    ...(opts?.readVersion ? { readVersion: opts.readVersion } : {}),
  })
  const problems = [...bin.problems]

  // The veto must be provably armed, not merely present — verifySdkGuard runs a
  // known-bad command through the real rule engine.
  const g = verifySdkGuard({
    writeRoots: opts?.writeRoots ?? [],
    home: opts?.home ?? homedir(),
    ...(opts?.evaluateFn ? { evaluateFn: opts.evaluateFn } : {}),
    ...(opts?.guardPath ? { guardPath: opts.guardPath } : {}),
  })
  problems.push(...g.problems)

  return { ok: problems.length === 0, problems, claudeBin: bin.claudeBin, cliVersion: bin.cliVersion }
}

/** Environment for ANY SDK-spawned claude (worker or commander — the stripping
 *  rule is about the parent process, not the role).
 *
 *  Strips CLAUDE_CODE_* / CLAUDECODE: a claude launched from inside another
 *  claude inherits child-session markers that change its behaviour (transcript
 *  handling among them), so a session spawned by an OG server that itself runs
 *  under claude would not behave like one spawned by a plain server. */
export const sdkSessionEnv = (
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') continue
    out[k] = v
  }
  return out
}

export interface SdkWorkerOptsInput {
  worktree: string
  agentSessionId: string
  title: string
  notes?: string
  priorFailure?: string
  /** Continue the recorded conversation instead of starting a fresh one. */
  resume?: boolean
  /** Mode-resolved model/effort. Omitted ⇒ the historical swarm defaults. */
  me?: { model: string; effort?: ClaudeEffort }
  /** Extra dirs the worker may read beyond its worktree (card attachments). */
  additionalDirectories?: string[]
  /** Owner sandbox experiment — NOT supported for an SDK worker in this stage. */
  sandbox?: boolean
  /** Resolved by the caller's preflight; must be the USER'S claude. */
  claudeBin: string
  home?: string
  env?: NodeJS.ProcessEnv
  /** Injected for tests. */
  evaluateFn?: GuardEvaluate
  guardPath?: string
  onDeny?: (info: { toolName: string; reason: string; agentId?: string }) => void
  /** Settings.language, resolved by the caller. REQUIRED — not optional — so
   *  a caller that forgets to thread it through fails `tsc` instead of
   *  silently spawning an SDK worker whose replies ignore the setting (see
   *  buildOrderInjection's doc comment, swarmWorker.ts, for why). */
  lang: PromptLang
}

export interface SdkWorkerLaunchPlan {
  /** Passed straight to sdkSession.spawnSdkSession. */
  options: Record<string, unknown>
  /** The first turn — the /order goal, or the resume injection. */
  initialPrompt: string
  /** Warnings the caller should surface (never silent degradations). */
  warnings: string[]
}

/** Build the SDK launch plan for one worker. Pure apart from reading `env`;
 *  the caller decides whether to actually spawn. */
export const sdkWorkerLaunchPlan = (opts: SdkWorkerOptsInput): SdkWorkerLaunchPlan => {
  const warnings: string[] = []
  const home = opts.home ?? homedir()
  const defaults = swarmLaunchDefaults('worker', opts.me)

  if (opts.sandbox) {
    // Stage 1 does not wrap an SDK worker in Seatbelt. Say so — a caller that
    // asked for containment and silently did not get it is the worst outcome.
    warnings.push(
      'the sandbox experiment is not supported for an SDK worker in this stage; this worker runs WITHOUT the OS sandbox (the A3/L4 guard still applies)',
    )
  }

  const guardHook = makeSdkGuardHook({
    writeRoots: [opts.worktree],
    home,
    ...(opts.evaluateFn ? { evaluateFn: opts.evaluateFn } : {}),
    ...(opts.guardPath ? { guardPath: opts.guardPath } : {}),
    ...(opts.onDeny ? { onDeny: opts.onDeny } : {}),
  })

  const options: Record<string, unknown> = {
    cwd: opts.worktree,
    // The USER'S claude — never the SDK's bundled copy (§4 #11).
    pathToClaudeCodeExecutable: opts.claudeBin,
    env: sdkSessionEnv(opts.env),
    // Unattended: a worker must never sit on a tool-approval prompt with nobody
    // watching. Mirrors workerLaunchOpts' unconditional permissionMode:'bypass'.
    permissionMode: 'bypassPermissions',
    // mcp__* tools sit OUTSIDE the PreToolUse veto's tool set, so a filesystem /
    // shell / sql MCP would be an unguarded path straight past it. Load none.
    strictMcpConfig: true,
    mcpServers: {},
    // The re-armed A3/L4 veto (§4-G). Every failure mode inside it denies.
    hooks: {
      PreToolUse: [{ hooks: [guardHook] }],
    },
    model: defaults.model,
    ...(defaults.effort ? { effort: defaults.effort } : {}),
    ...(opts.additionalDirectories?.length
      ? { additionalDirectories: opts.additionalDirectories }
      : {}),
    ...(opts.resume ? { resume: opts.agentSessionId } : { sessionId: opts.agentSessionId }),
  }

  return {
    options,
    initialPrompt: opts.resume
      ? WORKER_RESUME_INJECTION + languageDirective(opts.lang)
      : buildOrderInjection(opts.title, opts.notes, opts.priorFailure, opts.lang),
    warnings,
  }
}
