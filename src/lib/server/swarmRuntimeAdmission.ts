import { getRuntimeJournal, getRuntimeTransition, runtimeAdmissionBlocked, type RuntimeProfile } from './runtimeTransitionStore'
import { runtimeOwnerKey, withRuntimeOwner } from './runtimeOwner'
import { hasChatGptAccess } from './chatgptAccess'

export interface SwarmRuntimeHandoff {
  profile: RuntimeProfile
  instructions: string
  operationId?: string
  revision?: number
  runtimeOwnerKey?: string
  publicTranscript?: readonly { kind: 'input' | 'text'; text: string }[]
}
const globalState = globalThis as typeof globalThis & { __openground_swarm_runtime_launches?: Set<Promise<unknown>> }
const pending = globalState.__openground_swarm_runtime_launches ??= new Set<Promise<unknown>>()

export const trackSwarmRuntimeLaunch = async <T>(handoff: SwarmRuntimeHandoff | undefined, launch: () => Promise<T>): Promise<T> => {
  assertSwarmRuntimeAdmission(handoff)
  const operation = (async () => {
    const owner = handoff || await hasChatGptAccess() ? await runtimeOwnerKey(handoff?.runtimeOwnerKey) : undefined
    if (handoff) assertSwarmRuntimeAdmission(handoff)
    if (owner) return withRuntimeOwner(owner, launch)
    return launch()
  })().finally(() => { pending.delete(operation) })
  pending.add(operation)
  return operation
}

export const awaitSwarmRuntimeLaunches = async (timeoutMs = 120_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (pending.size) {
    if (Date.now() >= deadline) throw new Error('A previously admitted agent launch is still settling.')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

/** Internal handoffs must name the coordinator's approved launch revision.
 * A caller cannot turn the public admission gate off with a boolean override. */
export const assertSwarmRuntimeAdmission = (handoff?: SwarmRuntimeHandoff): void => {
  if (!handoff) {
    if (runtimeAdmissionBlocked('swarm')) throw new Error('The agent team is switching AI connections. Its work is preserved.')
    return
  }
  const state = getRuntimeTransition('swarm')
  if (!state || state.phase !== 'launching' || state.desired.provider !== handoff.profile.provider
    || !handoff.runtimeOwnerKey || getRuntimeJournal()?.pending?.ownerKey !== handoff.runtimeOwnerKey
    || state.revision !== handoff.revision
    || state.desired.model !== handoff.profile.model || state.desired.effort !== handoff.profile.effort) {
    throw new Error('The runtime handoff is not the current approved target.')
  }
  if (Buffer.byteLength(handoff.instructions) > 256 * 1024) throw new Error('The runtime handoff exceeds its context limit.')
}
