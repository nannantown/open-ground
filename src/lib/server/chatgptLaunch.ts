import { homedir } from 'os'
import { makeSdkGuardHook, verifySdkGuard } from './sdkGuardHook'
import { sdkSessionEnv, SdkWorkerUnavailableError } from './swarmWorkerSdk'
import type { ClaudeEffort } from '../types'
import { buildAppContextPrompt } from './claudeTerminal'

/** The direct plan-usage transport has no native model tools. Its host tools
 * call this same deterministic veto before doing any work. */
export const chatGptWorkerOptions = (o: {
  cwd: string
  agentSessionId: string
  resume: boolean
  model: string
  effort?: ClaudeEffort
  env?: NodeJS.ProcessEnv
}): Record<string, unknown> => {
  const guard = { writeRoots: [o.cwd], home: homedir() }
  const proof = verifySdkGuard(guard)
  if (!proof.ok) throw new SdkWorkerUnavailableError(proof.problems)
  return {
    cwd: o.cwd,
    model: o.model,
    ...(o.effort ? { effort: o.effort } : {}),
    env: sdkSessionEnv(o.env),
    runtimeRole: 'worker',
    hooks: { PreToolUse: [{ hooks: [makeSdkGuardHook(guard)] }] },
    ...(o.resume ? { resume: o.agentSessionId } : { sessionId: o.agentSessionId }),
  }
}

/** Commanders and presidents retain their existing owner authority. Their
 * host tool set is explicit; no filesystem MCP or native tool is inherited. */
export const chatGptDeskOptions = (o: {
  cwd: string
  role: 'manager' | 'supply'
  agentSessionId: string
  resume: boolean
  model: string
  effort?: ClaudeEffort
}): Record<string, unknown> => ({
  cwd: o.cwd,
  model: o.model,
  ...(o.effort ? { effort: o.effort } : {}),
  env: sdkSessionEnv(),
  runtimeRole: o.role,
  systemPrompt: buildAppContextPrompt(o.cwd, Number(process.env.PORT) || 47776),
  ...(o.resume ? { resume: o.agentSessionId } : { sessionId: o.agentSessionId }),
})
