import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as atomic from './atomicWrite'
import { openGroundHome } from './paths'
import { acceptConversationReceipt, acceptedConversationDraftRevision, claimConversationReceipt, finishConversationReceipt,
  listConversationReceipts, publicConversationReceipt, readConversationReceipt, ReceiptConflict, reviewConversationReceipt,
  settleRecoveryReviewReceipt, type ConversationReceipt } from './conversationReceipts'
import { readConversationDraft, saveConversationDraft } from './conversationDrafts'

const h = vi.hoisted(() => ({ owner: 'owner-a', reads: [] as string[] }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => { h.reads.push(String(args[0])); return actual.readFile(...args) } }
})
vi.mock('./runtimeOwner', () => ({ runtimeOwnerKey: async (expected?: string) => {
  if (!h.owner || expected && h.owner !== expected) throw new Error('owner changed')
  return h.owner
} }))
const key = (scope: string, id: string, owner = h.owner) => createHash('sha256').update(JSON.stringify([owner, scope, id])).digest('hex')
const file = () => join(openGroundHome(), 'runtime', 'receipts.json')
const archive = (id = 'receipt-0', scope = 'project-a') => join(openGroundHome(), 'runtime', 'receipt-archive', `${key(scope, id).slice(0, 3)}.json`)
const entry = (index: number, state: ConversationReceipt['state'] = 'queued'): ConversationReceipt => ({
  id: `receipt-${index}`, scope: 'project-a', owner: h.owner, body: { ordinal: index },
  hash: createHash('sha256').update(JSON.stringify({ ordinal: index })).digest('hex'), state,
  conversationId: 'conversation-a', epoch: 0, acceptedAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
})
const seed = async (count: number, finals = 1) => {
  const receipts: Record<string, ConversationReceipt> = {}
  for (let i = 0; i < count; i++) {
    const value = entry(i, i < finals ? (['delivered', 'rejected', 'cancelled'] as const)[i % 3] : 'queued')
    if (i === 0) value.acceptedRuntime = { provider: 'chatgpt', accountKey: 'synthetic-private-account' }
    receipts[key(value.scope, value.id)] = value
  }
  await mkdir(join(openGroundHome(), 'runtime'), { recursive: true, mode: 0o700 })
  await writeFile(file(), JSON.stringify({ version: 1, receipts, contexts: { [key('project-a', 'context')]: { conversationId: 'conversation-a', epoch: 0 } } }), { mode: 0o600 })
  return receipts
}
const pad = async () => {
  const saved = JSON.parse(await readFile(file(), 'utf8'))
  for (let i = Object.keys(saved.receipts).length; i < 3072; i++) saved.receipts[key('project-a', `receipt-${i}`)] = entry(i)
  await writeFile(file(), JSON.stringify(saved))
}
beforeEach(async () => { h.owner = 'owner-a'; h.reads = []; await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true }) })
afterEach(() => vi.restoreAllMocks())

describe('bounded receipt archives retain execution identity', () => {
  it('frees terminal capacity, preserves unresolved work, and looks up an old ID in exactly one prefix shard', async () => {
    const seeded = await seed(4096, 4095)
    await acceptConversationReceipt('project-a', 'new-work', { text: 'new work' })
    const active = JSON.parse(await readFile(file(), 'utf8'))
    expect(Object.keys(active.receipts)).toHaveLength(2)
    expect(active.receipts[key('project-a', 'receipt-4095')].state).toBe('queued')
    expect((await readdir(join(openGroundHome(), 'runtime', 'receipt-archive'))).length).toBeGreaterThan(1)
    expect((await stat(archive())).mode & 0o777).toBe(0o600)
    expect((await stat(join(openGroundHome(), 'runtime', 'receipt-archive'))).mode & 0o777).toBe(0o700)
    h.reads = []
    const old = await readConversationReceipt('project-a', 'receipt-0')
    expect(old).toEqual(seeded[key('project-a', 'receipt-0')])
    expect(h.reads).toEqual([file(), archive()])
    expect(await acceptConversationReceipt('project-a', 'receipt-0', { ordinal: 0 })).toEqual(old)
    await expect(acceptConversationReceipt('project-a', 'receipt-0', { ordinal: 99 })).rejects.toBeInstanceOf(ReceiptConflict)
    for (const id of ['receipt-0', 'receipt-1', 'receipt-2']) expect(await claimConversationReceipt('project-a', id)).toBe(false)
    expect((await finishConversationReceipt('project-a', 'receipt-0', 'uncertain', { late: true }))).toEqual(old)
    expect(publicConversationReceipt(old!)).not.toHaveProperty('acceptedRuntime')
    expect(await claimConversationReceipt('project-a', 'new-work')).toBe(true)
  })
  it('never evicts an unresolved receipt to acknowledge one more message', async () => {
    await seed(4096, 0)
    const before = await readFile(file(), 'utf8')
    await expect(acceptConversationReceipt('project-a', 'over-capacity', { text: 'must remain with client' })).rejects.toThrow('storage is full')
    expect(await readFile(file(), 'utf8')).toBe(before)
    expect(await claimConversationReceipt('project-a', 'receipt-0')).toBe(true)
    expect(await listConversationReceipts()).toHaveLength(4096)
  })
  it('preserves the active document when a new payload would exceed its byte limit', async () => {
    await seed(1, 0)
    const before = await readFile(file(), 'utf8')
    await expect(acceptConversationReceipt('project-a', 'over-bytes', { payload: 'x'.repeat(16 * 1024 * 1024) })).rejects.toThrow('storage is full')
    expect(await readFile(file(), 'utf8')).toBe(before)
    expect((await readConversationReceipt('project-a', 'receipt-0'))?.state).toBe('queued')
  })
  it('does not acknowledge or claim after an archive write fails, leaving the active copy intact', async () => {
    await seed(3072)
    const before = await readFile(file(), 'utf8')
    const write = atomic.atomicWriteJson
    const fail = vi.spyOn(atomic, 'atomicWriteJson').mockImplementation(async (path, value, options) => {
      if (path.includes('receipt-archive')) throw new Error('synthetic archive fsync unavailable')
      return write(path, value, options)
    })
    await expect(acceptConversationReceipt('project-a', 'not-accepted', { text: 'retain me' })).rejects.toThrow('archive fsync')
    await expect(claimConversationReceipt('project-a', 'receipt-1')).rejects.toThrow('archive fsync')
    expect(await readFile(file(), 'utf8')).toBe(before)
    fail.mockRestore()
    expect((await readConversationReceipt('project-a', 'receipt-0'))?.state).toBe('delivered')
    expect(await claimConversationReceipt('project-a', 'receipt-1')).toBe(true)
  })
  it('survives archive-success/active-prune-failure as duplicate terminal copies and safely retries the same ID', async () => {
    await seed(3072)
    const before = await readFile(file(), 'utf8')
    const write = atomic.atomicWriteJson
    const fail = vi.spyOn(atomic, 'atomicWriteJson').mockImplementation(async (path, value, options) => {
      if (path === file()) throw new Error('synthetic active prune fsync unavailable')
      return write(path, value, options)
    })
    await expect(acceptConversationReceipt('project-a', 'not-yet-accepted', { text: 'retain me' })).rejects.toThrow('active prune')
    expect(await readFile(file(), 'utf8')).toBe(before)
    expect(JSON.parse(await readFile(archive(), 'utf8')).receipts[key('project-a', 'receipt-0')].state).toBe('delivered')
    fail.mockRestore()
    const writes = vi.spyOn(atomic, 'atomicWriteJson')
    expect((await acceptConversationReceipt('project-a', 'receipt-0', { ordinal: 0 })).state).toBe('delivered')
    expect(writes.mock.calls.filter(([path]) => path.includes('receipt-archive'))).toHaveLength(0)
    expect(await claimConversationReceipt('project-a', 'receipt-0')).toBe(false)
    expect(JSON.parse(await readFile(file(), 'utf8')).receipts[key('project-a', 'receipt-0')]).toBeUndefined()
  })
  it('persists draft acceptance in the same document and reconciles it after its receipt leaves active storage', async () => {
    const draft = await saveConversationDraft('project-a', 'phone-a', 0, 'accepted line')
    await acceptConversationReceipt('project-a', 'draft-bound', { text: 'accepted line', draftClientId: 'phone-a', draftRevision: draft.revision })
    expect(JSON.parse(await readFile(file(), 'utf8')).acceptedDrafts[key('project-a', 'phone-a')]).toBe(draft.revision)
    await finishConversationReceipt('project-a', 'draft-bound', 'delivered')
    await pad(); await listConversationReceipts()
    expect(JSON.parse(await readFile(file(), 'utf8')).receipts[key('project-a', 'draft-bound')]).toBeUndefined()
    // GET draft needs only the atomic index, even if an unrelated old payload
    // is unreadable. It must not scan receipt archive directories.
    await writeFile(archive('draft-bound'), '{unreadable archived payload')
    expect(await readConversationDraft('project-a', 'phone-a')).toMatchObject({ text: '', revision: 2 })
    const newer = await saveConversationDraft('project-a', 'phone-a', 2, 'accepted line')
    expect(await readConversationDraft('project-a', 'phone-a')).toEqual(newer)
    h.owner = 'owner-b'
    expect(await acceptedConversationDraftRevision('project-a', 'phone-a')).toBeUndefined()
    await expect(acceptedConversationDraftRevision('project-a', 'phone-a', 'owner-a')).rejects.toThrow('owner changed')
  })
  it('does not publish acceptance or mutate a claim before the active document fsync succeeds', async () => {
    await seed(1, 0)
    const before = await readFile(file(), 'utf8')
    const fail = vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValue(new Error('synthetic active fsync unavailable'))
    await expect(acceptConversationReceipt('project-a', 'no-ack', { draftClientId: 'phone-a', draftRevision: 4 })).rejects.toThrow('active fsync')
    await expect(claimConversationReceipt('project-a', 'receipt-0')).rejects.toThrow('active fsync')
    expect(await readFile(file(), 'utf8')).toBe(before)
    fail.mockRestore()
    expect(await acceptedConversationDraftRevision('project-a', 'phone-a')).toBeUndefined()
    expect((await readConversationReceipt('project-a', 'receipt-0'))?.state).toBe('queued')
  })
  it('holds corrupt and oversized archive shards instead of treating an old ID as a new executable message', async () => {
    await seed(0)
    await mkdir(join(openGroundHome(), 'runtime', 'receipt-archive'), { mode: 0o700 })
    await writeFile(archive(), '{corrupt')
    await expect(acceptConversationReceipt('project-a', 'receipt-0', { ordinal: 0 })).rejects.toThrow()
    expect(await readFile(archive(), 'utf8')).toBe('{corrupt')
    await writeFile(archive(), 'x'.repeat(16 * 1024 * 1024 + 1))
    await expect(readConversationReceipt('project-a', 'receipt-0')).rejects.toThrow('archive exceeds')
    expect((await stat(archive())).size).toBe(16 * 1024 * 1024 + 1)
    expect(await listConversationReceipts()).toEqual([])
  })
  it('keeps reviewed terminal receipts immutable and owner-bound after archiving', async () => {
    await acceptConversationReceipt('project-a', 'reviewed-action', { text: 'synthetic effect' })
    await claimConversationReceipt('project-a', 'reviewed-action')
    await finishConversationReceipt('project-a', 'reviewed-action', 'uncertain')
    const reviewed = await reviewConversationReceipt('project-a', 'reviewed-action', 'Inspected actual work.', 'review-operation', 'owner-a')
    await acceptConversationReceipt('control-recovery', 'review-operation', { kind: 'recovery-review' })
    await settleRecoveryReviewReceipt('review-operation', { inspected: true }, 'owner-a')
    await pad(); await listConversationReceipts()
    expect(await reviewConversationReceipt('project-a', 'reviewed-action', 'Inspected actual work.', 'review-operation', 'owner-a')).toEqual(reviewed)
    await expect(reviewConversationReceipt('project-a', 'reviewed-action', 'Different note.', 'review-operation', 'owner-a')).rejects.toBeInstanceOf(ReceiptConflict)
    await settleRecoveryReviewReceipt('review-operation', { lateReplacement: true }, 'owner-a')
    expect((await readConversationReceipt('control-recovery', 'review-operation'))?.result).toEqual({ inspected: true })
    h.owner = 'owner-b'
    await expect(reviewConversationReceipt('project-a', 'reviewed-action', 'Inspected actual work.', 'review-operation', 'owner-a')).rejects.toThrow('owner changed')
    await expect(settleRecoveryReviewReceipt('review-operation', {}, 'owner-a')).rejects.toThrow('owner changed')
  })
})
