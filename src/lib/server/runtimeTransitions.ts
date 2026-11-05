import type { RuntimeProfile, RuntimeScope, RuntimeTransitionStatus, Settings } from '../types'
import { getRuntimeJournal, initializeRuntimeTransitions, updateRuntimeJournal, type RuntimeJournal } from './runtimeTransitionStore'
import { openGroundHome } from './paths'
import { runtimeOwnerKey } from './runtimeOwner'

type PreferenceKey = 'assistantProvider' | 'swarmProvider' | 'chatgptModel' | 'chatgptEffort'
export type RuntimePreferencePatch = { [K in PreferenceKey]?: Settings[K] | null }
export interface RuntimeParticipant {
  drain(seed?: unknown): Promise<unknown>
  retire(checkpoint: unknown): Promise<void>
  resume(profile: RuntimeProfile, checkpoint: unknown): Promise<void>
  cancel?(): Promise<void>
}
export interface RuntimeTransitionDependencies {
  profiles(): Promise<Record<RuntimeScope, RuntimeProfile>>
  preferences?(): Promise<RuntimePreferencePatch>
  ownerKey(): Promise<string>
  validate(patch: RuntimePreferencePatch): Promise<void>
  commit(patch: RuntimePreferencePatch): Promise<void>
  participant(scope: RuntimeScope): Promise<RuntimeParticipant>
  settled?(): Promise<void>
  timeoutMs?: number
}
export class RuntimeTransitionConflict extends Error { constructor(message: string) { super(message); this.name = 'RuntimeTransitionConflict' } }
const scopes: RuntimeScope[] = ['assistant', 'swarm']
const equal = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())
const applyProfile = (current: RuntimeProfile, scope: RuntimeScope, patch: RuntimePreferencePatch): RuntimeProfile => {
  const key = scope === 'assistant' ? 'assistantProvider' : 'swarmProvider'
  const provider = key in patch ? patch[key] ?? 'claude' : current.provider
  if (provider !== 'chatgpt') return { provider }
  // Catalog/effort preferences are shared by every ChatGPT seat.
  const model = 'chatgptModel' in patch ? patch.chatgptModel : current.model
  const effort = 'chatgptEffort' in patch ? patch.chatgptEffort : current.effort
  return { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}
const stamp = (j: RuntimeJournal, phase: RuntimeTransitionStatus['phase'], error?: string) => {
  for (const scope of j.pending?.scopes ?? []) {
    j.scopes[scope].phase = phase
    j.scopes[scope].updatedAt = new Date().toISOString()
    if (error) j.scopes[scope].error = error
    else delete j.scopes[scope].error
  }
}

/** One transition transaction at a time. Its durable phases are recovery boundaries. */
export const createRuntimeTransitionCoordinator = (deps: RuntimeTransitionDependencies) => {
  let initialized: Promise<void> | undefined
  let running: Promise<void> | undefined
  let writer: Promise<unknown> = Promise.resolve()
  const initialize = () => initialized ??= (async () => {
    await initializeRuntimeTransitions(await deps.profiles())
    if (getRuntimeJournal()?.pending) {
      await updateRuntimeJournal((j) => stamp(j, 'attention', 'The app restarted during a switch. Review the saved work, then retry or cancel the switch.'))
    }
  })().catch((e) => { initialized = undefined; throw e })
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const result = writer.then(fn); writer = result.catch(() => {}); return result }
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('A running task has not reached a confirmed safe boundary. Work is retained; wait for it to finish, then retry.')), deps.timeoutMs ?? 120_000); timer.unref?.() })])
    } finally { clearTimeout(timer) }
  }
  const authorize = async (j: RuntimeJournal) => {
    if (!j.pending || await deps.ownerKey() !== j.pending.ownerKey) throw new Error('The owner account changed. Sign in with the account that requested this switch.')
  }
  const advance = async () => {
    try {
      let j = getRuntimeJournal()!
      if (!j.pending) return
      await authorize(j)
      await deps.validate(j.pending.patch as RuntimePreferencePatch)
      for (const scope of j.pending.scopes) {
        if (Object.prototype.hasOwnProperty.call(j.pending!.checkpoints, scope)) continue
        const checkpoint = await bounded((await deps.participant(scope)).drain(j.pending!.seeds[scope]))
        j = await updateRuntimeJournal((next) => { next.pending!.checkpoints[scope] = checkpoint ?? null; delete next.pending!.seeds[scope] })
      }
      j = await updateRuntimeJournal((next) => stamp(next, 'checkpointed'))
      await authorize(j)
      j = await updateRuntimeJournal((next) => { next.pending!.retirementStarted = true; stamp(next, 'retiring') })
      for (const scope of j.pending!.scopes) {
        if (j.pending!.retired.includes(scope)) continue
        await (await deps.participant(scope)).retire(j.pending!.checkpoints[scope])
        j = await updateRuntimeJournal((next) => { next.pending!.retired.push(scope) })
      }
      await authorize(j)
      // Idempotent settings projection. A crash here re-applies the same patch.
      if (!j.pending!.committed) {
        await deps.commit(j.pending!.patch as RuntimePreferencePatch)
        j = await updateRuntimeJournal((next) => { next.pending!.committed = true })
      }
      j = await updateRuntimeJournal((next) => stamp(next, 'launching'))
      for (const scope of j.pending!.scopes) {
        await authorize(j)
        await (await deps.participant(scope)).resume(j.scopes[scope].desired, j.pending!.checkpoints[scope])
      }
      await updateRuntimeJournal((next) => {
        for (const scope of next.pending!.scopes) next.scopes[scope].effective = next.scopes[scope].desired
        stamp(next, 'stable')
        delete next.pending
      })
      // Both queues revalidate owner/epoch at dequeue. They are kicked only
      // after the durable stable commit releases admission gates.
      await deps.settled?.()
    } catch (error) {
      // Do not expose host paths, vendor responses or credential material.
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Switch could not finish. Saved work was retained.'
      await updateRuntimeJournal((j) => stamp(j, 'attention', message))
    }
  }
  const start = () => { running = advance().finally(() => { running = undefined }); void running.catch(() => {}) }
  const request = async (raw: RuntimePreferencePatch, expectedOwnerKey?: string) => {
    const admittedOwner = await deps.ownerKey()
    if (expectedOwnerKey && admittedOwner !== expectedOwnerKey) throw new Error('The owner account changed.')
    await initialize()
    return serial(async () => {
      const patch = { ...raw }
      await deps.validate(patch)
      const ownerKey = await deps.ownerKey()
      if (ownerKey !== admittedOwner) throw new Error('The owner account changed.')
      const previousPreferences = await deps.preferences?.() ?? {}
      const previous = getRuntimeJournal()!
      if (previous.pending) {
        if (previous.pending.ownerKey === ownerKey && equal(previous.pending.patch, patch)) return previous.scopes
        throw new RuntimeTransitionConflict('A switch is already pending. Finish it, or cancel it after reviewing its state.')
      }
      const affected = scopes.filter((scope) => !equal(previous.scopes[scope].effective as unknown as Record<string, unknown>, applyProfile(previous.scopes[scope].effective, scope, { ...previousPreferences, ...patch }) as unknown as Record<string, unknown>))
      if (!Object.keys(patch).length) throw new Error('No runtime preferences were supplied.')
      if (!affected.length) {
        // A future ChatGPT model preference must not retire a working Claude
        // team whose effective execution profile has not changed.
        await deps.commit(patch)
        return previous.scopes
      }
      const j = await updateRuntimeJournal((next) => {
        next.revision++
        next.pending = { ownerKey, patch: patch as Record<string, string | null>, previousPreferences: previousPreferences as Record<string, string | null>, scopes: affected, checkpoints: {}, seeds: {}, retired: [], committed: false, retirementStarted: false }
        for (const scope of affected) {
          next.scopes[scope].desired = applyProfile(next.scopes[scope].effective, scope, { ...previousPreferences, ...patch })
          next.scopes[scope].revision = next.revision
        }
        stamp(next, 'draining')
      })
      start()
      return j.scopes
    })
  }
  const control = async (action: 'retry' | 'cancel', scope: RuntimeScope, revision: number, expectedOwnerKey?: string) => {
    if (expectedOwnerKey && await deps.ownerKey() !== expectedOwnerKey) throw new Error('The owner account changed.')
    await initialize()
    return serial(async () => {
      let j = getRuntimeJournal()!
      if (!j.pending || !j.pending.scopes.includes(scope) || j.scopes[scope].revision !== revision) throw new RuntimeTransitionConflict('The switch changed. Refresh its status before trying again.')
      await authorize(j)
      if (running || j.scopes[scope].phase !== 'attention') throw new RuntimeTransitionConflict('The switch is still reaching a safe boundary.')
      if (action === 'retry') {
        await updateRuntimeJournal((next) => stamp(next, 'draining'))
        start()
      } else {
        if (!j.pending.retirementStarted && !j.pending.committed) {
          for (const s of j.pending.scopes) await (await deps.participant(s)).cancel?.()
          const cancelled = await updateRuntimeJournal((next) => {
            for (const s of next.pending!.scopes) next.scopes[s].desired = next.scopes[s].effective
            stamp(next, 'stable')
            delete next.pending
          })
          await deps.settled?.()
          return cancelled.scopes
        }
        // Cancel can retire/relaunch actors too. Persist the reverse target so a
        // crash during cancellation follows the same recovery contract.
        const patch: RuntimePreferencePatch = { ...j.pending.previousPreferences }
        for (const s of j.pending.scopes) patch[s === 'assistant' ? 'assistantProvider' : 'swarmProvider'] = j.scopes[s].effective.provider
        j = await updateRuntimeJournal((next) => {
          next.revision++
          next.pending!.patch = patch as Record<string, string | null>
          // A launch may have completed before a crash. Drain the actual actors
          // again instead of treating old checkpoints as proof of current idle.
          next.pending!.seeds = structuredClone(next.pending!.checkpoints)
          next.pending!.checkpoints = {}; next.pending!.retired = []; next.pending!.committed = false; next.pending!.retirementStarted = false
          for (const s of next.pending!.scopes) { next.scopes[s].desired = next.scopes[s].effective; next.scopes[s].revision = next.revision }
          stamp(next, 'draining')
        })
        start()
      }
      return j.scopes
    })
  }
  return { initialize, request, control, settle: async () => { await running }, status: async () => { await initialize(); return getRuntimeJournal()!.scopes } }
}

let singleton: { home: string; value: ReturnType<typeof createRuntimeTransitionCoordinator> } | undefined
export const runtimeTransitions = () => {
  const home = openGroundHome()
  if (singleton?.home === home) return singleton.value
  const value = createRuntimeTransitionCoordinator({
    profiles: async () => {
      const { getSettings } = await import('./store')
      const settings = await getSettings()
      const p = (scope: RuntimeScope): RuntimeProfile => {
        const provider = settings[scope === 'assistant' ? 'assistantProvider' : 'swarmProvider'] ?? 'claude'
        return { provider, ...(provider === 'chatgpt' ? { model: settings.chatgptModel, effort: settings.chatgptEffort } : {}) }
      }
      return { assistant: p('assistant'), swarm: p('swarm') }
    },
    preferences: async () => {
      const { getSettings } = await import('./store')
      const s = await getSettings()
      return { assistantProvider: s.assistantProvider ?? 'claude', swarmProvider: s.swarmProvider ?? 'claude', chatgptModel: s.chatgptModel ?? null, chatgptEffort: s.chatgptEffort ?? null }
    },
    ownerKey: runtimeOwnerKey,
    validate: async (patch) => {
      const { validateRuntimePreferences } = await import('./runtimeTransitionValidation')
      await validateRuntimePreferences(patch)
    },
    commit: async (patch) => {
      const { setChatGptPreferences } = await import('./store')
      const applied = await setChatGptPreferences(patch)
      if (Object.keys(patch).some((key) => !applied.includes(key as keyof Settings))) throw new Error('Runtime preferences were refused. Work was retained.')
    },
    participant: async (scope) => {
      if (scope === 'assistant') {
        const p = await import('./assistantRuntimeTransition')
        return { drain: p.drainAssistantRuntime, retire: p.retireAssistantRuntime, resume: p.resumeAssistantRuntime, cancel: p.cancelAssistantRuntimeDrain }
      }
      const p = await import('./swarmRuntimeTransition')
      return { drain: p.drainSwarmRuntime, retire: p.retireSwarmRuntime, resume: p.resumeSwarmRuntime, cancel: p.cancelSwarmRuntimeDrain }
    },
    settled: async () => {
      const { resumeQueuedAssistantTurns } = await import('./phoneAssistant')
      resumeQueuedAssistantTurns()
      const { releaseRetiredPresidentInputs, flushPresidentInbox } = await import('./presidentInbox')
      releaseRetiredPresidentInputs()
      await flushPresidentInbox()
      const { flushSwarmHandoffInputs } = await import('./swarmRuntimeTransition')
      await flushSwarmHandoffInputs()
      const { notifyRuntimeRecoveryChanged } = await import('./runtimeRecoveryBoot')
      await notifyRuntimeRecoveryChanged()
    },
  })
  singleton = { home, value }
  return value
}
