import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const auth = vi.hoisted(() => ({ owner: 'owner-a' }))
vi.mock('./runtimeOwner', async original => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async (expected?: string) => { if (expected && expected !== auth.owner) throw new Error('owner changed'); return auth.owner } }))
import { acceptConversationReceipt, claimConversationReceipt, finishConversationReceipt, listConversationReceipts, readConversationContext, readConversationReceipt, rotateConversationContext, ReceiptConflict, publicConversationReceipt } from './conversationReceipts'
import { readConversationDraft, saveConversationDraft, clearAcceptedConversationDraft, DraftConflict } from './conversationDrafts'

let previousHome: string | undefined
beforeEach(async () => { previousHome = process.env.OPENGROUND_HOME; process.env.OPENGROUND_HOME = await mkdtemp(join(tmpdir(), 'og-inbox-recovery-')); auth.owner = 'owner-a' })
afterEach(() => { process.env.OPENGROUND_HOME = previousHome; vi.restoreAllMocks() })
describe('durable conversation receipts and drafts', () => {
  it('replays an accepted ID, rejects different content and claims a side effect only once', async () => {
    const first = await acceptConversationReceipt('project-a', 'message-a', { text: 'do this', kind: 'president-input' })
    const replay = await acceptConversationReceipt('project-a', 'message-a', { kind: 'president-input', text: 'do this' })
    expect(replay).toEqual(first)
    await expect(acceptConversationReceipt('project-a', 'message-a', { text: 'do something else' })).rejects.toBeInstanceOf(ReceiptConflict)
    expect(await Promise.all([claimConversationReceipt('project-a', 'message-a'), claimConversationReceipt('project-a', 'message-a')])).toEqual([true, false])
    await finishConversationReceipt('project-a', 'message-a', 'delivered', { confirmed: true })
    expect(await claimConversationReceipt('project-a', 'message-a')).toBe(false)
    expect(publicConversationReceipt((await readConversationReceipt('project-a', 'message-a'))!)).not.toHaveProperty('owner')
  })
  it('holds a started operation from an earlier process instead of re-executing it', async () => {
    await acceptConversationReceipt('project-a', 'message-a', { text: 'effect' })
    await claimConversationReceipt('project-a', 'message-a')
    const file = join(process.env.OPENGROUND_HOME!, 'runtime', 'receipts.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    Object.values(saved.receipts).forEach((receipt) => { (receipt as { attemptBoot: string }).attemptBoot = 'previous-process' })
    await writeFile(file, JSON.stringify(saved))
    expect((await listConversationReceipts())[0].state).toBe('uncertain')
    expect(await claimConversationReceipt('project-a', 'message-a')).toBe(false)
    // A late completion cannot overwrite the uncertainty from recovery.
    expect((await finishConversationReceipt('project-a', 'message-a', 'delivered')).state).toBe('uncertain')
  })
  it('revokes old queued inputs on new conversation and rejects a stale context', async () => {
    const context = await readConversationContext('project-a')
    await acceptConversationReceipt('project-a', 'message-a', { text: 'old' }, context)
    const next = await rotateConversationContext('project-a', context)
    expect(next.epoch).toBe(context.epoch + 1)
    expect((await readConversationReceipt('project-a', 'message-a'))!.state).toBe('cancelled')
    await expect(acceptConversationReceipt('project-a', 'message-b', { text: 'stale' }, context)).rejects.toBeInstanceOf(ReceiptConflict)
    expect(await claimConversationReceipt('project-a', 'message-a')).toBe(false)
  })
  it('keeps drafts and receipts in the signed-in owner namespace', async () => {
    await saveConversationDraft('project-a', 'device-a', 0, 'private')
    await acceptConversationReceipt('project-a', 'message-a', { text: 'private' })
    auth.owner = 'owner-b'
    expect((await readConversationDraft('project-a', 'device-a')).text).toBe('')
    expect(await readConversationReceipt('project-a', 'message-a')).toBeUndefined()
    await expect(saveConversationDraft('project-a', 'device-a', 0, 'late request', 'owner-a')).rejects.toThrow('owner changed')
  })
  it('uses CAS and preserves a newer draft even when its text repeats the sent text (ABA)', async () => {
    const sent = await saveConversationDraft('project-a', 'device-a', 0, 'same words')
    expect(await saveConversationDraft('project-a', 'device-a', 0, 'same words')).toEqual(sent)
    await saveConversationDraft('project-a', 'device-a', sent.revision, 'other words')
    const editedAgain = await saveConversationDraft('project-a', 'device-a', 2, 'same words')
    expect(await clearAcceptedConversationDraft('project-a', 'device-a', sent.revision)).toEqual(editedAgain)
    await expect(saveConversationDraft('project-a', 'device-a', 1, 'stale')).rejects.toBeInstanceOf(DraftConflict)
  })
  it('reconciles a crash after receipt acceptance but before clearing its matching draft', async () => {
    const draft = await saveConversationDraft('project-a', 'device-a', 0, 'accepted line')
    await acceptConversationReceipt('project-a', 'message-a', { kind: 'president-input', text: 'accepted line', draftClientId: 'device-a', draftRevision: draft.revision })
    expect(await readConversationDraft('project-a', 'device-a')).toMatchObject({ revision: draft.revision + 1, text: '' })
    const newer = await saveConversationDraft('project-a', 'device-a', draft.revision + 1, 'newer line')
    expect(await readConversationDraft('project-a', 'device-a')).toEqual(newer)
  })
  it('does not reset a corrupt receipt file or expose its old accepted draft as unsent', async () => {
    await saveConversationDraft('project-a', 'device-a', 0, 'held line')
    const file = join(process.env.OPENGROUND_HOME!, 'runtime', 'receipts.json')
    await writeFile(file, '{corrupt')
    await expect(readConversationDraft('project-a', 'device-a')).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{corrupt')
  })
})
