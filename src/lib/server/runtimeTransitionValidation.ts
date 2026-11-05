import { z } from 'zod'
import { getSettings } from './store'
import { hasChatGptAccess } from './chatgptAccess'
import { listChatGptModels } from './chatgptAuth'
import { claudeRunPreflight } from './claudePreflight'
import { chatGptShellPreflight } from './chatgptTools'
import { CHATGPT_EFFORTS } from '../types'
import type { RuntimePreferencePatch } from './runtimeTransitions'

const patchSchema = z.object({
  assistantProvider: z.enum(['claude', 'chatgpt']).nullable().optional(),
  swarmProvider: z.enum(['claude', 'chatgpt']).nullable().optional(),
  chatgptModel: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).nullable().optional(),
  chatgptEffort: z.enum(CHATGPT_EFFORTS).nullable().optional(),
}).strict()
export const validateRuntimePreferences = async (raw: RuntimePreferencePatch): Promise<void> => {
  const patch = patchSchema.parse(raw)
  if (!Object.keys(patch).length) throw new Error('No runtime preferences were supplied.')
  if (!await hasChatGptAccess()) throw new Error('Owner sign-in is required.')
  const current = await getSettings()
  const target = { ...current, ...patch }
  const sharedModel = 'chatgptModel' in patch || 'chatgptEffort' in patch
  const assistantAffected = 'assistantProvider' in patch || sharedModel
  const swarmAffected = 'swarmProvider' in patch || sharedModel
  const needsChatGpt = assistantAffected && target.assistantProvider === 'chatgpt' || swarmAffected && target.swarmProvider === 'chatgpt'
  if (needsChatGpt) {
    if (current.lockdownMode) throw new Error('ChatGPT is unavailable in work mode.')
    const models = await listChatGptModels()
    const model = target.chatgptModel ? models.find((m) => m.id === target.chatgptModel) : models[0]
    if (!model) throw new Error('Connect ChatGPT and choose a model available to this account.')
    if (target.chatgptEffort && model.supportedEfforts?.length && !model.supportedEfforts.includes(target.chatgptEffort)) throw new Error('The selected model does not support this reasoning setting.')
    if (swarmAffected && target.swarmProvider === 'chatgpt') await chatGptShellPreflight()
  }
  if (patch.assistantProvider === 'claude' || patch.swarmProvider === 'claude' || patch.assistantProvider === null || patch.swarmProvider === null) {
    const result = await claudeRunPreflight()
    if (!result.ok) throw new Error(result.body.error)
  }
}
