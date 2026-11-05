import type { CustomTabRole } from '../types'
import { getCustomTabRole } from './roles'
import { isSwarmLocalOwnerUnlocked } from './swarmGate'

/** Existing local assistant permission. Public Swarm opt-in grants no access,
 * and this permission does not authorize the owner-only ChatGPT provider. */
export const canUseAssistant = (role: CustomTabRole, localUnlock: boolean): boolean =>
  role === 'owner' || localUnlock

export const hasAssistantAccess = async (): Promise<boolean> => {
  const localUnlock = await isSwarmLocalOwnerUnlocked()
  // Preserve local/offline use without consulting the signed-in role.
  const role = localUnlock ? 'none' : await getCustomTabRole()
  return canUseAssistant(role, localUnlock)
}
