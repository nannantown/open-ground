import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { openGroundHome } from './paths'
import { atomicWriteJson } from './atomicWrite'
import type { RuntimeProfile, RuntimeScope, RuntimeTransitionStatus } from '../types'
export type { RuntimeProfile, RuntimeScope, RuntimeTransitionStatus } from '../types'

const profile = z.object({ provider: z.enum(['claude', 'chatgpt']), model: z.string().max(128).optional(), effort: z.string().max(32).optional() }).strict()
const status = z.object({ scope: z.enum(['assistant', 'swarm']), revision: z.number().int().nonnegative(), phase: z.enum(['stable', 'draining', 'checkpointed', 'retiring', 'launching', 'attention']), effective: profile, desired: profile, updatedAt: z.string().datetime(), error: z.string().max(500).optional() }).strict()
const journalSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  scopes: z.object({ assistant: status, swarm: status }).strict(),
  pending: z.object({
    ownerKey: z.string().min(1).max(128),
    patch: z.record(z.string(), z.union([z.string().max(128), z.null()])),
    previousPreferences: z.record(z.string(), z.union([z.string().max(128), z.null()])),
    scopes: z.array(z.enum(['assistant', 'swarm'])).min(1).max(2),
    checkpoints: z.record(z.string(), z.unknown()),
    seeds: z.record(z.string(), z.unknown()).default({}),
    retired: z.array(z.enum(['assistant', 'swarm'])).max(2),
    committed: z.boolean(),
    retirementStarted: z.boolean().default(false),
  }).strict().optional(),
}).strict()
export type RuntimeJournal = z.infer<typeof journalSchema>
type Cache = { path: string; value?: RuntimeJournal; fault?: unknown; loading?: boolean; queue: Promise<unknown> }
let cache: Cache | undefined
const current = (): Cache => {
  const path = join(openGroundHome(), 'runtime', 'transitions.json')
  if (cache?.path !== path) cache = { path, queue: Promise.resolve() }
  return cache
}
const clone = <T>(value: T): T => structuredClone(value)
const stable = (scope: RuntimeScope, effective: RuntimeProfile): RuntimeTransitionStatus => ({ scope, revision: 0, phase: 'stable', effective, desired: effective, updatedAt: new Date().toISOString() })

/** Missing is a new install; malformed/unreadable is a recovery fault, never empty state. */
export const initializeRuntimeTransitions = async (profiles: Record<RuntimeScope, RuntimeProfile>): Promise<RuntimeJournal> => {
  const c = current()
  c.loading = true
  const load = async () => {
    if (c.fault) throw c.fault
    if (c.value) { c.loading = false; return clone(c.value) }
    try {
      const raw = await readFile(c.path, 'utf8')
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Runtime recovery journal exceeds its limit.')
      c.value = journalSchema.parse(JSON.parse(raw))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { c.fault = error; throw error }
      c.value = { version: 1, revision: 0, scopes: { assistant: stable('assistant', profiles.assistant), swarm: stable('swarm', profiles.swarm) } }
    }
    c.loading = false
    return clone(c.value)
  }
  const result = c.queue.then(load)
  c.queue = result.catch(() => {})
  return result
}

/** Single writer; publish in memory only after durable rename succeeds. */
export const updateRuntimeJournal = async (change: (journal: RuntimeJournal) => void): Promise<RuntimeJournal> => {
  const c = current()
  const result = c.queue.then(async () => {
    if (c.fault) throw c.fault
    if (!c.value) throw new Error('Runtime recovery is not initialized.')
    const next = clone(c.value)
    change(next)
    const validated = journalSchema.parse(next)
    if (Buffer.byteLength(JSON.stringify(validated)) > 4 * 1024 * 1024) throw new Error('Runtime recovery journal exceeds its limit.')
    await mkdir(join(openGroundHome(), 'runtime'), { recursive: true, mode: 0o700 })
    await atomicWriteJson(c.path, validated, { mode: 0o600, fsync: true })
    c.value = validated
    return clone(validated)
  })
  c.queue = result.catch(() => {})
  return result
}

export const getRuntimeJournal = (): RuntimeJournal | undefined => { const c = current(); return c.value ? clone(c.value) : undefined }
export const getRuntimeTransition = (scope: RuntimeScope): RuntimeTransitionStatus | undefined => getRuntimeJournal()?.scopes[scope]
/** Reads are synchronous at hot dispatch gates. Boot initializes before engines resume. */
export const runtimeAdmissionBlocked = (scope: RuntimeScope): boolean => {
  const c = current()
  return !!c.fault || !!c.loading || (c.value !== undefined && c.value.scopes[scope].phase !== 'stable')
}

/** A provider turn can finish under its admitted profile while desired changes. */
export const runtimeEffectiveProfile = (scope: RuntimeScope): RuntimeProfile | undefined => getRuntimeTransition(scope)?.effective

/** Participant progress lives inside the same transaction journal, so a
 * partially launched team cannot replay its already restored seats/inputs. */
export const updateRuntimeCheckpoint = async (scope: RuntimeScope, revision: number, change: (checkpoint: unknown) => unknown): Promise<unknown> => {
  const next = await updateRuntimeJournal((j) => {
    if (!j.pending || !j.pending.scopes.includes(scope) || j.scopes[scope].revision !== revision || !['retiring', 'launching', 'attention'].includes(j.scopes[scope].phase)) throw new Error('The runtime handoff checkpoint changed.')
    j.pending.checkpoints[scope] = change(structuredClone(j.pending.checkpoints[scope]))
  })
  return next.pending!.checkpoints[scope]
}
