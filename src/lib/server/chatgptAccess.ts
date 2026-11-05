// ChatGPT runtimes require the app's signed-in owner account. General Swarm
// opt-in and machine-local unlocks do not grant access to this provider.
import { getCustomTabRole } from './roles'

export const hasChatGptAccess = async (): Promise<boolean> =>
  (await getCustomTabRole()) === 'owner'
