// sdkGuardHook — arms the A3/L4 deny veto for a worker running under the Agent
// SDK instead of a PTY.
//
// WHY THIS FILE HAS TO EXIST. A worker runs permission-bypass, so the PreToolUse
// deny veto is its ONLY deterministic block. In the PTY path that veto is
// `scripts/openground-guard.js`, wired into the user's global
// ~/.claude/settings.json by hooksInstall.ts and armed per-session by
// OPENGROUND_GUARD=1.
//
// **The Agent SDK does not load filesystem settings.** Measured 2026-07-30
// (migration plan appendix B-1): an SDK session launched with OPENGROUND_GUARD=1
// and write roots pointing elsewhere happily wrote the file — the installed hook
// never fired. So a naive SDK worker is UNARMED, and it is unarmed SILENTLY,
// because Claude Code fails a missing hook OPEN. The SDK's own runtime warning
// says the same thing from the other side: under `bypassPermissions`,
// `canUseTool` is never consulted and "to gate every tool call, use a PreToolUse
// hook instead".
//
// So the veto is re-armed IN PROCESS here, reusing the SAME rule engine the PTY
// path uses (`evaluate` from openground-guard.js) rather than a second copy of
// the rules. One set of rules, two ways of reaching it.
//
// ⚠ THE ONE THING THIS FILE MUST NEVER GET WRONG. Measured in the same spike: a
// programmatic hook that THROWS fails OPEN — the tool ran. A veto that
// disappears when its own code errors is not a veto, and it is the exact shape
// of the accident this migration exists to remove. Every path below therefore
// ends in a deny: unresolvable guard, unloadable module, malformed verdict,
// thrown exception. That mirrors openground-guard.js's own CLI contract, which
// initialises its verdict to DENY and never emits exit 1.
//
// See docs/SDK_WORKER_MIGRATION_PLAN.md §4-G.

import { existsSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { createRequire } from 'module'
import { resolveHookSourceRoot } from './hooksInstall'

/** The rule engine's contract, as openground-guard.js exports it (and as
 *  swarmGuardPushBan.test.ts already consumes it). */
export type GuardVerdict = { decision: 'allow' | 'deny'; reason?: string }
export type GuardEvaluate = (
  payload: unknown,
  env: Record<string, string | undefined>,
) => GuardVerdict

/** The subset of the SDK's PreToolUseHookInput this adapter reads. Declared
 *  structurally so this module does not depend on the SDK's types (and so the
 *  unit tests need nothing installed). */
export interface SdkPreToolUseInput {
  tool_name: string
  tool_input: unknown
  cwd?: string
  agent_id?: string
  tool_use_id?: string
}

/** The SDK hook return shape for a PreToolUse decision. */
export interface SdkHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'allow' | 'deny'
    permissionDecisionReason?: string
  }
}

const allow = (): SdkHookOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
})

const deny = (reason: string): SdkHookOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `openground-guard BLOCKED: ${reason}`,
  },
})

/** Absolute path of the guard source, or null with the reason it could not be
 *  found. Uses the SAME resolver hooksInstall uses to find its copy sources, so
 *  the in-process veto and the installed one can never come from different
 *  checkouts. */
export const resolveGuardModulePath = (): { path: string | null; problem: string | null } => {
  const { root, problem } = resolveHookSourceRoot()
  if (!root) return { path: null, problem: problem ?? 'hook source root not found' }
  const p = join(root, 'scripts', 'openground-guard.js')
  if (!existsSync(p)) return { path: null, problem: `guard source missing at ${p}` }
  return { path: p, problem: null }
}

let cached: { path: string; evaluate: GuardEvaluate } | null = null

/** Load `evaluate` from the guard source. Cached per path; throws with a
 *  precise reason so the caller can fail CLOSED with something actionable. */
export const loadGuardEvaluate = (guardPath?: string): GuardEvaluate => {
  const resolved = guardPath ?? resolveGuardModulePath().path
  if (!resolved) {
    throw new Error(resolveGuardModulePath().problem ?? 'guard source not resolvable')
  }
  if (cached && cached.path === resolved) return cached.evaluate
  // ⚠ THE REQUIRE BASE IS THE GUARD FILE, NEVER `import.meta.url`. This module
  // is bundled into `server/dist/index.cjs` by esbuild, which has no import.meta
  // in CJS output and emits `{}` for it — so `import.meta.url` is `undefined`
  // there and `createRequire(undefined)` THROWS. The hook fails closed, which
  // means the SDK worker preflight fails, which means **the SDK runtime never
  // starts in the packaged app at all** while every dev run (real ESM) works.
  // esbuild's own `empty-import-meta` warning would have said so; the build
  // silenced it for an unrelated, genuinely-dead branch in hooksInstall.ts.
  // `resolved` is the absolute path of the guard we are about to load — the
  // correct resolution base anyway, and one that exists in both worlds.
  const require_ = createRequire(isAbsolute(resolved) ? resolved : resolve(resolved))
  // Load fresh: a stale module object from a previous checkout would be a veto
  // built from rules that are no longer the ones on disk.
  delete require_.cache?.[require_.resolve(resolved)]
  const mod = require_(resolved) as { evaluate?: unknown }
  if (typeof mod?.evaluate !== 'function') {
    throw new Error(`guard at ${resolved} does not export evaluate()`)
  }
  cached = { path: resolved, evaluate: mod.evaluate as GuardEvaluate }
  return cached.evaluate
}

/** Test seam: drop the cached module. */
export const __resetGuardCacheForTests = (): void => {
  cached = null
}

export interface SdkGuardHookOpts {
  /** Absolute roots the worker may write to (its worktree). Same value the PTY
   *  path passes as OPENGROUND_GUARD_WRITE_ROOTS. */
  writeRoots: string[]
  /** HOME as the guard should see it (its home/parent rules depend on it). */
  home: string
  /** Override the guard source path (tests / a pinned copy). */
  guardPath?: string
  /** Inject the rule engine directly (unit tests). */
  evaluateFn?: GuardEvaluate
  /** Called for every denial — the engine's record of what the veto stopped.
   *  ⚠ Do NOT read `result.permission_denials` for this instead: measured
   *  2026-07-30, a deny of a SUB-AGENT's tool blocked the call but left that
   *  array empty. The hook is the only complete record. */
  onDeny?: (info: { toolName: string; reason: string; agentId?: string }) => void
}

/** Build the PreToolUse hook callback for one SDK worker session.
 *
 *  The returned function NEVER throws and NEVER returns undefined: every
 *  failure mode resolves to a deny. */
export const makeSdkGuardHook = (
  opts: SdkGuardHookOpts,
): ((input: SdkPreToolUseInput) => Promise<SdkHookOutput>) => {
  // The env the rule engine sees. Synthesised rather than read from
  // process.env: the server process is NOT a guarded worker, and arming the
  // guard by mutating the server's own environment would police every other
  // in-process consumer too.
  const env: Record<string, string | undefined> = {
    OPENGROUND_GUARD: '1',
    OPENGROUND_GUARD_WRITE_ROOTS: opts.writeRoots.join(':'),
    HOME: opts.home,
  }

  return async (input: SdkPreToolUseInput): Promise<SdkHookOutput> => {
    try {
      const evaluate = opts.evaluateFn ?? loadGuardEvaluate(opts.guardPath)
      const verdict = evaluate(
        { tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd },
        env,
      )
      // A well-formed verdict is {decision:'allow'|'deny'}. Anything else is a
      // bug in the engine, and a bug must not read as permission — the same
      // rule openground-guard.js's CLI applies to its own output.
      if (verdict && verdict.decision === 'allow') return allow()
      if (verdict && verdict.decision === 'deny') {
        const reason = verdict.reason ?? 'denied by policy'
        opts.onDeny?.({ toolName: input.tool_name, reason, agentId: input.agent_id })
        return deny(reason)
      }
      const reason = 'guard returned a malformed verdict — denying by default'
      opts.onDeny?.({ toolName: input.tool_name, reason, agentId: input.agent_id })
      return deny(reason)
    } catch (e) {
      // FAIL-CLOSED. A thrown hook fails OPEN in the SDK (measured), so the
      // throw must be absorbed HERE and turned into a denial.
      const reason = `guard error (${(e as Error)?.message ?? 'unknown'}) — denying by default`
      opts.onDeny?.({ toolName: input.tool_name, reason, agentId: input.agent_id })
      return deny(reason)
    }
  }
}

export interface SdkGuardCheck {
  ok: boolean
  problems: string[]
}

/** Spawn-time verification that the in-process veto will actually bite.
 *
 *  The PTY path refuses to launch a worker whose guard wiring cannot be
 *  VERIFIED (GuardWiringError, fail-closed) because Claude Code fails a missing
 *  hook open. The SDK path needs the same gate for the same reason, so this
 *  does not merely check that the module loads — it runs a KNOWN-BAD command
 *  through it and requires a deny. A guard that loads but no longer denies is
 *  the failure that would otherwise ship silently. */
export const verifySdkGuard = (opts: {
  writeRoots: string[]
  home: string
  guardPath?: string
  evaluateFn?: GuardEvaluate
}): SdkGuardCheck => {
  const problems: string[] = []
  try {
    const evaluate = opts.evaluateFn ?? loadGuardEvaluate(opts.guardPath)
    const env = {
      OPENGROUND_GUARD: '1',
      OPENGROUND_GUARD_WRITE_ROOTS: opts.writeRoots.join(':'),
      HOME: opts.home,
    }
    const cwd = opts.writeRoots[0] ?? opts.home
    // `git push` is the canonical worker-forbidden operation (INVARIANT F).
    const push = evaluate({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd }, env)
    if (push?.decision !== 'deny') problems.push('guard did not deny `git push` for a worker session')
    // And an ordinary local operation must still be allowed, or the "veto"
    // is just a broken session.
    const ok = evaluate({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd }, env)
    if (ok?.decision !== 'allow') problems.push('guard denied `git status`, which a worker must be able to run')
  } catch (e) {
    problems.push(`guard could not be loaded: ${(e as Error)?.message ?? 'unknown'}`)
  }
  return { ok: problems.length === 0, problems }
}
