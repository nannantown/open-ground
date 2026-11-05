import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { openGroundHome } from './paths'
import { atomicWriteJson } from './atomicWrite'
import { runtimeOwnerKey } from './runtimeOwner'

const recordSchema = z.object({ revision: z.number().int().nonnegative(), text: z.string().max(32_768), updatedAt: z.string().datetime() }).strict()
export type ConversationDraft = z.infer<typeof recordSchema>
const storeSchema = z.object({ version: z.literal(1), records: z.record(z.string(), recordSchema) }).strict()
export class DraftConflict extends Error { constructor(readonly draft: ConversationDraft) { super('Draft changed on another request.'); this.name = 'DraftConflict' } }
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/
let writer: Promise<unknown> = Promise.resolve()
const keyFor = (owner: string, scope: string, client: string) => {
  if (!idPattern.test(scope) || !idPattern.test(client)) throw new Error('Invalid draft scope or client.')
  return createHash('sha256').update(JSON.stringify([owner, scope, client])).digest('hex')
}
const empty = (): ConversationDraft => ({ revision: 0, text: '', updatedAt: new Date(0).toISOString() })
const transact = async <T>(change: (records: Record<string, ConversationDraft>) => { result: T; write: boolean }): Promise<T> => {
  const home = openGroundHome()
  const path = join(home, 'runtime', 'drafts.json')
  const operation = writer.then(async () => {
    let records: Record<string, ConversationDraft> = {}
    try {
      const raw = await readFile(path, 'utf8')
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('Draft store exceeds its limit.')
      records = storeSchema.parse(JSON.parse(raw)).records
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const { result, write } = change(records)
    if (write) {
      if (Object.keys(records).length > 1024) throw new Error('Draft storage is full. Existing drafts were retained.')
      await mkdir(join(home, 'runtime'), { recursive: true, mode: 0o700 })
      await atomicWriteJson(path, { version: 1, records }, { mode: 0o600, fsync: true })
    }
    return structuredClone(result)
  })
  writer = operation.catch(() => {})
  return operation
}
export const readConversationDraft = async (scope: string, clientId: string, expectedOwner?: string): Promise<ConversationDraft> => {
  const owner = await runtimeOwnerKey(expectedOwner)
  const key = keyFor(owner, scope, clientId)
  // Reconcile the receipt-before-draft-clear crash window before exposing an
  // already accepted line as an unsent draft after relaunch.
  const accepted = new Set<number>()
  let acceptedThrough: number | undefined
  if (scope === 'assistant') {
    const { listAcceptedAssistantDrafts } = await import('./assistantRuntimeStore')
    for (const binding of listAcceptedAssistantDrafts(clientId, owner)) accepted.add(binding.draftRevision)
  } else {
    const { acceptedConversationDraftRevision } = await import('./conversationReceipts')
    acceptedThrough = await acceptedConversationDraftRevision(scope, clientId, owner)
  }
  return transact((records) => {
    const previous = records[key] ?? empty()
    if (!accepted.has(previous.revision) && (acceptedThrough === undefined || previous.revision > acceptedThrough)) return { result: previous, write: false }
    const revision = Math.max(previous.revision, acceptedThrough ?? previous.revision) + 1
    if (!Number.isSafeInteger(revision)) throw new Error('Draft revision limit reached. Saved content was retained.')
    const next = { revision, text: '', updatedAt: new Date().toISOString() }
    records[key] = next
    return { result: next, write: true }
  })
}
/** revision is the expected revision; a retry of an already saved body is harmless. */
export const saveConversationDraft = async (scope: string, clientId: string, revision: number, text: string, expectedOwner?: string): Promise<ConversationDraft> => {
  if (!Number.isSafeInteger(revision) || revision < 0 || typeof text !== 'string' || text.length > 32_768) throw new Error('Invalid draft.')
  const key = keyFor(await runtimeOwnerKey(expectedOwner), scope, clientId)
  return transact((records) => {
    const previous = records[key] ?? empty()
    if (previous.revision !== revision) {
      if (previous.revision === revision + 1 && previous.text === text) return { result: previous, write: false }
      throw new DraftConflict(previous)
    }
    const next = { revision: revision + 1, text, updatedAt: new Date().toISOString() }
    records[key] = next
    return { result: next, write: true }
  })
}
/** Called only AFTER the corresponding inbox receipt has been durably accepted. */
export const clearAcceptedConversationDraft = async (scope: string, clientId: string, revision: number, expectedOwner?: string): Promise<ConversationDraft> => {
  const key = keyFor(await runtimeOwnerKey(expectedOwner), scope, clientId)
  return transact((records) => {
    const previous = records[key] ?? empty()
    if (previous.revision !== revision) return { result: previous, write: false }
    const next = { revision: revision + 1, text: '', updatedAt: new Date().toISOString() }
    records[key] = next
    return { result: next, write: true }
  })
}
