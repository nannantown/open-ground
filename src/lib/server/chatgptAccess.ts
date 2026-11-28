// ChatGPT runtimes require the app's signed-in owner account. General Swarm
// opt-in and machine-local unlocks do not grant access to this provider.
import { getCustomTabRole } from './roles'

// Means "the signed-in app OWNER role" (receipts and owner keys hang on it), not a ChatGPT connection.
export const hasChatGptAccess = async (): Promise<boolean> =>
  (await getCustomTabRole()) === 'owner'
