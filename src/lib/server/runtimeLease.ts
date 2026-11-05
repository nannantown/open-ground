import type { RuntimeScope } from '../types'
import { runtimeOwnerKey } from './runtimeOwner'
import { getSettings } from './store'
import { getChatGptAccountKey } from './chatgptAuth'
import { selectedRuntime } from './chatgptRuntime'

/** Admission pins both accounts. A requested provider change cannot revoke an
 * accepted turn halfway through an effect; security/account changes still do. */
export const admitChatGptRuntime = async (scope: RuntimeScope, expectedOwnerKey?: string): Promise<() => Promise<void>> => {
  if (await selectedRuntime(scope) !== 'chatgpt') throw new Error('ChatGPT is not selected.')
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  const account = await getChatGptAccountKey()
  return async () => {
    if (await runtimeOwnerKey() !== owner) throw new Error('The owner account changed. This turn has stopped.')
    if ((await getSettings()).lockdownMode) throw new Error('ChatGPT is unavailable in work mode.')
    if (await getChatGptAccountKey() !== account) throw new Error('The ChatGPT account changed. This turn has stopped.')
  }
}
