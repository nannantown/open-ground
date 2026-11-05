import { getSettings } from './store'
import { hasChatGptAccess } from './chatgptAccess'
import { listChatGptModels } from './chatgptAuth'
import { chatGptCoolingUntil, ChatGptQuotaError } from './chatgptQuota'
import type { ClaudeEffort, SwarmAllowedModels } from '../types'
import { spawnBlock } from './swarmAllowedModels'
import { chatGptShellPreflight } from './chatgptTools'
import { claudeRunPreflight } from './claudePreflight'

export type SwarmRuntimePreflightResult =
  | { ok: true }
  | { ok: false; body: { error: string; claudeMissing?: true; claudeLoggedOut?: true; chatgptUnavailable?: true } }

export type RuntimeUse = 'assistant' | 'swarm'

/** Resolve on the server for every new operation. Saved owner preferences do
 * not confer access after logout, and switching providers never falls back to
 * spending a different subscription without the owner's choice. */
export const selectedRuntime = async (use: RuntimeUse): Promise<'claude' | 'chatgpt'> => {
  const settings = await getSettings()
  const provider = use === 'assistant' ? settings.assistantProvider : settings.swarmProvider
  if (provider !== 'chatgpt') return 'claude'
  if (!(await hasChatGptAccess())) throw new Error('ChatGPT is available only to the OPEN GROUND owner.')
  if (settings.lockdownMode) throw new Error('ChatGPT is unavailable in work mode.')
  return 'chatgpt'
}

export const chatGptLaunchConfig = async (use: RuntimeUse): Promise<{ model: string; effort?: ClaudeEffort }> => {
  if (await selectedRuntime(use) !== 'chatgpt') throw new Error('ChatGPT is not selected.')
  const until = chatGptCoolingUntil()
  if (until) throw new ChatGptQuotaError(until)
  if (use === 'swarm') await chatGptShellPreflight()
  const [settings, models] = await Promise.all([getSettings(), listChatGptModels()])
  const model = settings.chatgptModel ? models.find((m) => m.id === settings.chatgptModel) : models[0]
  if (!model) throw new Error('Connect ChatGPT and choose a model available to this account.')
  const effort = settings.chatgptEffort
  if (effort && model.supportedEfforts?.length && !model.supportedEfforts.includes(effort)) {
    throw new Error('The selected ChatGPT model does not support this reasoning setting.')
  }
  return { model: model.id, ...(effort ? { effort } : {}) }
}

export const runtimeSpawnBlock = async (now: number, allowed: SwarmAllowedModels) => {
  if (await selectedRuntime('swarm') === 'claude') return spawnBlock(now, allowed)
  const until = chatGptCoolingUntil(now)
  return until ? { kind: 'all-cooling' as const, until } : null
}

/** Every manual, relayed and automatic launch checks the selected runtime.
 * A disconnected Claude CLI must not prevent a plan-authorized ChatGPT run. */
export const swarmRunPreflight = async (): Promise<SwarmRuntimePreflightResult> => {
  try {
    if (await selectedRuntime('swarm') === 'chatgpt') {
      await chatGptLaunchConfig('swarm')
      return { ok: true }
    }
  } catch (error) {
    return { ok: false, body: { error: error instanceof Error ? error.message : 'ChatGPT is unavailable.', chatgptUnavailable: true } }
  }
  return claudeRunPreflight()
}
