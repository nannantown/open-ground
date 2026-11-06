import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteJson } from './atomicWrite'
import { openGroundHome } from './paths'
import { runtimeOwnerKey } from './runtimeOwner'

const bootId = randomUUID()
const receiptSchema = z.object({
  id: z.string().min(1).max(128), scope: z.string().min(1).max(128), owner: z.string().max(128),
  hash: z.string().length(64), body: z.unknown(),
  state: z.enum(['queued', 'executing', 'delivered', 'rejected', 'uncertain', 'cancelled']),
  acceptedAt: z.string().datetime(), updatedAt: z.string().datetime(),
  attemptBoot: z.string().optional(), result: z.unknown().optional(), error: z.string().max(500).optional(),
  conversationId: z.string().optional(), epoch: z.number().int().nonnegative().optional(),
  execution: z.object({ sessionId: z.string(), handleId: z.string(), runtime: z.enum(['sdk', 'pty']), nativeOffset: z.number().int().nonnegative().optional() }).optional(),
  acceptedRuntime: z.object({ provider: z.enum(['claude', 'chatgpt']), accountKey: z.string().max(256).optional() }).optional(),
}).strict()
export type ConversationReceipt = z.infer<typeof receiptSchema>
const contextSchema = z.object({ conversationId: z.string(), epoch: z.number().int().nonnegative() }).strict()
export type ConversationContext = z.infer<typeof contextSchema>
const hashKey = z.string().regex(/^[a-f0-9]{64}$/)
const schema = z.object({ version: z.literal(1), receipts: z.record(hashKey, receiptSchema), contexts: z.record(hashKey, contextSchema).default({}),
  acceptedDrafts: z.record(hashKey, z.number().int().nonnegative()).default({}) }).strict()
const archiveSchema = z.object({ version: z.literal(1), prefix: z.string().regex(/^[a-f0-9]{3}$/), receipts: z.record(hashKey, receiptSchema) }).strict()
const MAX_RECEIPTS = 4096
const MAX_BYTES = 16 * 1024 * 1024
const ARCHIVE_AT = 3072
const terminal = (receipt: ConversationReceipt): boolean => ['delivered', 'rejected', 'cancelled'].includes(receipt.state)
const byteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, null, 2))
export class ReceiptConflict extends Error { constructor() { super('This message ID was already used for different content.'); this.name = 'ReceiptConflict' } }
const validId = /^[a-zA-Z0-9_-]{1,128}$/
let writer: Promise<unknown> = Promise.resolve()
const listeners = new Set<(receipt: ConversationReceipt) => void>()
export const onConversationReceipt = (listener: (receipt: ConversationReceipt) => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const publish = (receipt: ConversationReceipt): ConversationReceipt => {
  for (const listener of Array.from(listeners)) { try { listener(structuredClone(receipt)) } catch { /* delivery is retrievable from the durable receipt */ } }
  return receipt
}
const canonical = (body: unknown): string => {
  if (Array.isArray(body)) return `[${body.map(canonical).join(',')}]`
  if (body && typeof body === 'object') return `{${Object.entries(body).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(body) ?? 'null'
}
const keyFor = (owner: string, scope: string, id: string) => {
  if (!validId.test(scope) || !validId.test(id)) throw new Error('Invalid conversation or message ID.')
  return createHash('sha256').update(JSON.stringify([owner, scope, id])).digest('hex')
}
const recordAcceptedDraft = (receipt: ConversationReceipt, accepted: Record<string, number>): void => {
  const body = receipt.body as { draftClientId?: unknown; draftRevision?: unknown } | null
  if (!body || typeof body.draftClientId !== 'string' || !validId.test(body.draftClientId)
    || typeof body.draftRevision !== 'number' || !Number.isSafeInteger(body.draftRevision) || body.draftRevision < 0) return
  const key = keyFor(receipt.owner, receipt.scope, body.draftClientId)
  accepted[key] = Math.max(accepted[key] ?? -1, body.draftRevision)
}
const persist = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    // Persist a newly created archive/runtime directory in its parent before
    // relying on any entry inside it as the sole durable receipt copy.
    const parent = await open(dirname(dirname(path)), 'r')
    try { await parent.sync() } finally { await parent.close() }
  }
  await atomicWriteJson(path, value, { mode: 0o600, fsync: true })
  // The archive must be durable before its active copy is pruned. Unlike a
  // best-effort cache write, a directory-sync failure cannot acknowledge this.
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}
type Change<T> = (receipts: Record<string, ConversationReceipt>, contexts: Record<string, ConversationContext>, acceptedDrafts: Record<string, number>, archived?: ConversationReceipt, archivedBatch?: Record<string, ConversationReceipt>) => { result: T; write: boolean }
const transaction = <T>(change: Change<T>, lookupKey?: string, options?: { lookupKeys?: string[]; authorize?: () => Promise<unknown> }): Promise<T> => {
  const home = openGroundHome()
  const path = join(home, 'runtime', 'receipts.json')
  const result = writer.then(async () => {
    let receipts: Record<string, ConversationReceipt> = {}
    let contexts: Record<string, ConversationContext> = {}
    let acceptedDrafts: Record<string, number> = {}
    let recovered = false
    try {
      const raw = await readFile(path, 'utf8')
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Receipt journal exceeds its limit.')
      const saved = schema.parse(JSON.parse(raw)); receipts = saved.receipts; contexts = saved.contexts; acceptedDrafts = saved.acceptedDrafts
      for (const receipt of Object.values(receipts)) {
        if (receipt.state === 'executing' && receipt.attemptBoot !== bootId) {
          receipt.state = 'uncertain'; receipt.error = 'The app restarted after this operation began. Inspect its result before continuing.'; recovered = true
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // Upgrade legacy active receipts before any copy can leave this document.
    for (const [key, receipt] of Object.entries(receipts)) {
      if (keyFor(receipt.owner, receipt.scope, receipt.id) !== key) throw new Error('Receipt journal identity is invalid.')
      recordAcceptedDraft(receipt, acceptedDrafts)
    }
    const archives = new Map<string, Record<string, ConversationReceipt>>()
    const archivePath = (prefix: string) => join(home, 'runtime', 'receipt-archive', `${prefix}.json`)
    const readArchive = async (prefix: string): Promise<Record<string, ConversationReceipt>> => {
      const cached = archives.get(prefix)
      if (cached) return cached
      let entries: Record<string, ConversationReceipt> = {}
      try {
        const raw = await readFile(archivePath(prefix), 'utf8')
        if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Receipt archive exceeds its limit.')
        const saved = archiveSchema.parse(JSON.parse(raw))
        if (saved.prefix !== prefix || Object.keys(saved.receipts).length > MAX_RECEIPTS) throw new Error('Receipt archive exceeds its limit or changed identity.')
        for (const [key, receipt] of Object.entries(saved.receipts)) if (!terminal(receipt) || !key.startsWith(prefix) || keyFor(receipt.owner, receipt.scope, receipt.id) !== key) throw new Error('Receipt archive is invalid.')
        entries = saved.receipts
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      archives.set(prefix, entries)
      return entries
    }
    const document = () => ({ version: 1 as const, receipts, contexts, acceptedDrafts })
    const validateActive = (): void => {
      if (Object.keys(receipts).length > MAX_RECEIPTS || Object.keys(acceptedDrafts).length > 16384 || byteSize(document()) > MAX_BYTES)
        throw new Error('Receipt storage is full. Existing work was retained.')
    }
    // Only archive finals already persisted in the previous active document.
    // A crash between these writes can duplicate a terminal copy, never turn a
    // still-executing active receipt into an unobserved archived final.
    if (Object.keys(receipts).length >= ARCHIVE_AT || byteSize(document()) >= MAX_BYTES / 2) {
      const finals = Object.entries(receipts).filter(([, receipt]) => terminal(receipt))
      const groups = new Map<string, typeof finals>()
      for (const entry of finals) { const prefix = entry[0].slice(0, 3); groups.set(prefix, [...(groups.get(prefix) ?? []), entry]) }
      const batches = Array.from(groups)
      for (let offset = 0; offset < batches.length; offset += 8) {
        // Wait for every independent shard write, including on partial failure,
        // before another transaction can acquire the shared writer.
        const saved = await Promise.allSettled(batches.slice(offset, offset + 8).map(async ([prefix, group]) => {
          const entries = { ...await readArchive(prefix) }
          let dirty = false
          for (const [key, receipt] of group) {
            if (entries[key] && canonical(entries[key]) !== canonical(receipt)) throw new ReceiptConflict()
            if (!entries[key]) { entries[key] = receipt; dirty = true }
          }
          const archive = { version: 1 as const, prefix, receipts: entries }
          if (Object.keys(entries).length > MAX_RECEIPTS || byteSize(archive) > MAX_BYTES) throw new Error('Receipt archive is full. Existing work was retained.')
          if (dirty) await persist(archivePath(prefix), archive)
          archives.set(prefix, entries)
        }))
        for (const savedShard of saved) if (savedShard.status === 'rejected') throw savedShard.reason
      }
      if (finals.length) {
        for (const [key] of finals) delete receipts[key]
        validateActive()
        await persist(path, document())
        recovered = false
      }
    }
    const archived = lookupKey ? (await readArchive(lookupKey.slice(0, 3)))[lookupKey] : undefined
    if (lookupKey && archived && receipts[lookupKey] && canonical(archived) !== canonical(receipts[lookupKey])) throw new ReceiptConflict()
    const archivedBatch: Record<string, ConversationReceipt> = {}
    for (const key of options?.lookupKeys ?? []) {
      const value = (await readArchive(key.slice(0, 3)))[key]
      if (value && receipts[key] && canonical(value) !== canonical(receipts[key])) throw new ReceiptConflict()
      if (value) archivedBatch[key] = value
    }
    // A batch decision runs after all I/O under the same writer as claims.
    // No await separates its final owner/actor checks from its state changes.
    await options?.authorize?.()
    const next = change(receipts, contexts, acceptedDrafts, archived, archivedBatch)
    if (next.write || recovered) {
      // Fail closed at capacity. An unresolved operation is never evicted to
      // make a retry look new and executable again.
      validateActive()
      await persist(path, document())
    }
    return structuredClone(next.result)
  })
  writer = result.catch(() => {})
  return result
}
export const acceptConversationReceipt = async (scope: string, id: string, body: unknown, expectedContext?: Partial<ConversationContext>, expectedOwnerKey?: string, acceptedRuntime?: ConversationReceipt['acceptedRuntime']): Promise<ConversationReceipt> => {
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  const key = keyFor(owner, scope, id)
  const hash = createHash('sha256').update(canonical(body)).digest('hex')
  return transaction((receipts, contexts, acceptedDrafts, archived) => {
    const existing = receipts[key] ?? archived
    if (existing) {
      if (existing.hash !== hash) throw new ReceiptConflict()
      return { result: existing, write: false }
    }
    const now = new Date().toISOString()
    const contextKey = keyFor(owner, scope, 'context')
    const context = contexts[contextKey] ?? { conversationId: randomUUID(), epoch: 0 }
    if ((expectedContext?.conversationId !== undefined && expectedContext.conversationId !== context.conversationId) || (expectedContext?.epoch !== undefined && expectedContext.epoch !== context.epoch)) throw new ReceiptConflict()
    contexts[contextKey] = context
    const receipt: ConversationReceipt = { id, scope, owner, hash, body, ...context, state: 'queued', acceptedAt: now, updatedAt: now }
    if (acceptedRuntime) receipt.acceptedRuntime = acceptedRuntime
    receipts[key] = receipt
    recordAcceptedDraft(receipt, acceptedDrafts)
    return { result: receipt, write: true }
  }, key)
}
export const readConversationReceipt = async (scope: string, id: string, expectedOwnerKey?: string): Promise<ConversationReceipt | undefined> => {
  const key = keyFor(await runtimeOwnerKey(expectedOwnerKey), scope, id)
  return transaction((receipts, _contexts, _accepted, archived) => ({ result: receipts[key] ?? archived, write: false }), key)
}
/** The same atomic acceptance document keeps this compact index after finals
 * move to an archive. A newer draft revision remains untouched. */
export const acceptedConversationDraftRevision = async (scope: string, clientId: string, expectedOwnerKey?: string): Promise<number | undefined> => {
  const key = keyFor(await runtimeOwnerKey(expectedOwnerKey), scope, clientId)
  return transaction((_receipts, _contexts, accepted) => ({ result: accepted[key], write: false }))
}
export const listConversationReceipts = async (expectedOwnerKey?: string): Promise<ConversationReceipt[]> => {
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  return transaction((receipts) => ({ result: Object.values(receipts).filter((r) => r.owner === owner), write: false }))
}
/** Compare-and-set claims execution once, before bytes reach a provider/tool. */
export const claimConversationReceipt = async (scope: string, id: string, execution?: ConversationReceipt['execution'], expectedOwnerKey?: string): Promise<boolean> => {
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  const key = keyFor(owner, scope, id)
  return transaction((receipts, contexts, _accepted, archived) => {
    const receipt = receipts[key] ?? archived
    if (!receipt || receipt.state !== 'queued') return { result: false, write: false }
    const context = contexts[keyFor(owner, scope, 'context')]
    if (context && receipt.epoch !== context.epoch) { receipt.state = 'cancelled'; return { result: false, write: true } }
    receipt.state = 'executing'; receipt.attemptBoot = bootId; receipt.updatedAt = new Date().toISOString()
    if (execution) receipt.execution = execution
    return { result: true, write: true }
  }, key)
}
export const readConversationContext = async (scope: string): Promise<ConversationContext> => {
  const key = keyFor(await runtimeOwnerKey(), scope, 'context')
  return transaction((_receipts, contexts) => {
    if (contexts[key]) return { result: contexts[key], write: false }
    contexts[key] = { conversationId: randomUUID(), epoch: 0 }
    return { result: contexts[key], write: true }
  })
}
/** A new conversation cancels only unconsumed inputs; effects remain recorded. */
export const rotateConversationContext = async (scope: string, expected: ConversationContext): Promise<ConversationContext> => {
  const owner = await runtimeOwnerKey()
  const key = keyFor(owner, scope, 'context')
  return transaction((receipts, contexts) => {
    const previous = contexts[key]
    if (!previous || previous.epoch !== expected.epoch || previous.conversationId !== expected.conversationId) throw new ReceiptConflict()
    const next = { conversationId: randomUUID(), epoch: previous.epoch + 1 }
    contexts[key] = next
    for (const receipt of Object.values(receipts)) {
      if (receipt.owner === owner && receipt.scope === scope && receipt.state === 'queued' && receipt.epoch === previous.epoch) { receipt.state = 'cancelled'; receipt.updatedAt = new Date().toISOString() }
    }
    return { result: next, write: true }
  })
}
export const finishConversationReceipt = async (scope: string, id: string, state: 'delivered' | 'rejected' | 'uncertain' | 'cancelled', result?: unknown, expectedOwnerKey?: string): Promise<ConversationReceipt> => {
  const key = keyFor(await runtimeOwnerKey(expectedOwnerKey), scope, id)
  return transaction((receipts, _contexts, _accepted, archived) => {
    const receipt = receipts[key] ?? archived
    if (!receipt) throw new Error('Message receipt does not exist.')
    // An old callback may not resurrect a cancelled or already settled input.
    if (['delivered', 'rejected', 'cancelled', 'uncertain'].includes(receipt.state)) return { result: receipt, write: false }
    receipt.state = state; receipt.result = result; receipt.updatedAt = new Date().toISOString()
    return { result: receipt, write: true }
  }, key).then(publish)
}
/** Native Enter acknowledgement is delivery, not a settled effect boundary. */
export const markConversationReceiptHeard = async (scope: string, id: string, expectedOwnerKey: string): Promise<ConversationReceipt> => {
  const key = keyFor(await runtimeOwnerKey(expectedOwnerKey), scope, id)
  return transaction((receipts, _contexts, _accepted, archived) => {
    const receipt = receipts[key] ?? archived
    if (!receipt || receipt.state !== 'executing' || receipt.execution?.runtime !== 'pty') throw new ReceiptConflict()
    receipt.result = { heard: true }; receipt.updatedAt = new Date().toISOString()
    return { result: receipt, write: true }
  }, key).then(publish)
}
export const publicConversationReceipt = (receipt: ConversationReceipt) => {
  const { owner: _owner, hash: _hash, body: _body, attemptBoot: _boot, execution: _execution, acceptedRuntime: _runtime, ...shown } = receipt
  return shown
}

export class PresidentCancellationConflict extends Error {
  constructor(public readonly code: 'input-occupied' | 'input-executing' | 'input-unavailable' | 'stale-conversation' | 'operation-conflict') {
    super('The selected president instructions cannot be cancelled in their current state.')
    this.name = 'PresidentCancellationConflict'
  }
}
export interface CancelPresidentInputsOptions extends ConversationContext {
  scope: string
  path: string
  operationId: string
  messageIds: string[]
  note: string
  expectedOwnerKey: string
}
/** Revoke future intent, never assert that an unknown effect was rolled back.
 * The operation receipt and every selected cancellation share one fsync write.
 * A competing execution claim therefore wins or loses the whole batch. */
export const cancelPresidentInputs = async (options: CancelPresidentInputsOptions) => {
  const { scope, path, operationId, conversationId, epoch, expectedOwnerKey } = options
  const note = options.note.trim(), messageIds = [...options.messageIds].sort()
  if (!validId.test(scope) || !validId.test(operationId) || !path || path.length > 4096 || !conversationId || conversationId.length > 128
    || !Number.isSafeInteger(epoch) || epoch < 0 || !note || note.length > 1000 || !messageIds.length || messageIds.length > 128
    || new Set(messageIds).size !== messageIds.length || messageIds.some(id => !validId.test(id))) throw new Error('Invalid president cancellation.')
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  const { isAgentConversationOccupied, isRecordedRuntimeHandleOccupied } = await import('./liveDesks')
  const controlScope = 'control-president-cancel', operationKey = keyFor(owner, controlScope, operationId)
  const inputKeys = messageIds.map(id => keyFor(owner, scope, id))
  const body = { kind: 'president-cancel-inputs', scope, path, conversationId, epoch, messageIds, note }
  const hash = createHash('sha256').update(canonical(body)).digest('hex')
  const result = await transaction((receipts, contexts, _accepted, _archived, batch = {}) => {
    const previous = receipts[operationKey] ?? batch[operationKey]
    const targets = inputKeys.map(key => receipts[key] ?? batch[key])
    if (previous) {
      if (previous.hash !== hash || previous.state !== 'delivered') throw new PresidentCancellationConflict('operation-conflict')
      if (targets.some(receipt => !receipt || receipt.state !== 'cancelled'
        || (receipt.result as { operationId?: unknown } | null)?.operationId !== operationId)) throw new PresidentCancellationConflict('operation-conflict')
      return { result: { ok: true as const, conversationId, epoch, receipts: targets.map(publicConversationReceipt) }, write: false }
    }
    const context = contexts[keyFor(owner, scope, 'context')]
    if (!context || context.conversationId !== conversationId || context.epoch !== epoch) throw new PresidentCancellationConflict('stale-conversation')
    for (const receipt of targets) {
      const input = receipt?.body as { kind?: unknown; path?: unknown } | null
      if (!receipt || receipt.owner !== owner || receipt.scope !== scope || receipt.conversationId !== conversationId || receipt.epoch !== epoch
        || input?.kind !== 'president-input' || input.path !== path) throw new PresidentCancellationConflict('input-unavailable')
      if (receipt.state === 'executing') throw new PresidentCancellationConflict('input-executing')
      if (receipt.state !== 'queued' && receipt.state !== 'uncertain') throw new PresidentCancellationConflict('input-unavailable')
      if (receipt.execution && (isRecordedRuntimeHandleOccupied(receipt.execution.runtime, receipt.execution.handleId)
        || isAgentConversationOccupied(receipt.execution.sessionId))) throw new PresidentCancellationConflict('input-occupied')
    }
    const now = new Date().toISOString()
    for (const receipt of targets) {
      const previousState = receipt.state, previousResult = receipt.result
      receipt.state = 'cancelled'; receipt.updatedAt = now
      receipt.result = { cancelledByOwner: true, previousState, ...(previousResult !== undefined ? { previousResult } : {}),
        operationId, automaticReplay: false, effectsRolledBack: false, note }
    }
    receipts[operationKey] = { id: operationId, scope: controlScope, owner, hash, body, conversationId, epoch,
      state: 'delivered', acceptedAt: now, updatedAt: now, result: { cancelledMessageIds: messageIds, effectsRolledBack: false } }
    return { result: { ok: true as const, conversationId, epoch, receipts: targets.map(publicConversationReceipt) }, write: true }
  }, undefined, { lookupKeys: [operationKey, ...inputKeys], authorize: () => runtimeOwnerKey(owner) })
  // Native delivery observers may drop their reservations only AFTER durability.
  for (const receipt of result.receipts) {
    const saved = await readConversationReceipt(scope, receipt.id, owner)
    if (saved) publish(saved)
  }
  return result
}
/** Owner inspection records a known boundary; it never invokes the old body. */
export const reviewConversationReceipt = async (scope: string, id: string, note: string, operationId: string, expectedOwnerKey?: string): Promise<ConversationReceipt> => {
  if (note.length > 1000) throw new Error('Review note is too long.')
  const key = keyFor(await runtimeOwnerKey(expectedOwnerKey), scope, id)
  return transaction((receipts, _contexts, _accepted, archived) => {
    const receipt = receipts[key] ?? archived
    const previous = receipt?.result as { ownerReviewed?: boolean; operationId?: string; note?: string } | undefined
    if (previous?.ownerReviewed && previous.operationId === operationId && previous.note === note) return { result: receipt, write: false }
    if (!receipt || receipt.state !== 'uncertain') throw new ReceiptConflict()
    receipt.state = 'delivered'; receipt.result = { ownerReviewed: true, operationId, note, automaticReplay: false }; receipt.updatedAt = new Date().toISOString()
    return { result: receipt, write: true }
  }, key).then(publish)
}
export const settleRecoveryReviewReceipt = async (id: string, result: unknown, expectedOwnerKey?: string): Promise<void> => {
  const key = keyFor(await runtimeOwnerKey(expectedOwnerKey), 'control-recovery', id)
  await transaction((receipts, _contexts, _accepted, archived) => {
    const receipt = receipts[key] ?? archived
    if (!receipt || (receipt.body as { kind?: unknown } | null)?.kind !== 'recovery-review') throw new ReceiptConflict()
    if (terminal(receipt)) return { result: null, write: false }
    receipt.state = 'delivered'; receipt.result = result; receipt.updatedAt = new Date().toISOString()
    return { result: null, write: true }
  }, key)
}
