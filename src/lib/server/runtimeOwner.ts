import { createHash } from 'node:crypto'
import { readSession } from './authStore'
import { hasChatGptAccess } from './chatgptAccess'
import { AsyncLocalStorage } from 'node:async_hooks'

const admissionOwner = new AsyncLocalStorage<string>()
export const currentRuntimeOwnerKey = (): string | undefined => admissionOwner.getStore()
export const withRuntimeOwner = <T>(ownerKey: string, run: () => T): T => admissionOwner.run(ownerKey, run)

/** An app owner session, never the local unlock or a general Swarm opt-in. */
export const runtimeOwnerKey = async (expected?: string): Promise<string> => {
  if (!await hasChatGptAccess()) throw new Error('Owner sign-in is required.')
  const session = await readSession()
  if (!session?.user?.id) throw new Error('Owner sign-in is required.')
  const key = createHash('sha256').update(session.user.id).digest('hex')
  const pinned = expected ?? currentRuntimeOwnerKey()
  if (pinned && key !== pinned) throw new Error('The owner account changed.')
  return key
}
export const runtimeRequestOwnerKey = async (claimedOwnerId?: string): Promise<string> => runtimeOwnerKey(claimedOwnerId === undefined ? undefined : createHash('sha256').update(claimedOwnerId).digest('hex'))
