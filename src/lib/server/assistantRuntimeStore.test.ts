import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openGroundHome } from './paths'
import { __resetAssistantRuntimeForTest, acceptAssistantTurn, assistantTurnCurrent, claimAssistantTurn,
  getAssistantTurnReceipt, listAcceptedAssistantDrafts, mutateAssistantRuntime, readAssistantRuntime,
  recoverAssistantRuntime, resetAssistantRuntimeState, settleAssistantTurn } from './assistantRuntimeStore'

beforeEach(() => __resetAssistantRuntimeForTest())
describe('durable assistant receipts', () => {
  it('initializes one stable conversation and commits acceptance before returning', () => {
    const initial = readAssistantRuntime()
    expect(readAssistantRuntime().conversationId).toBe(initial.conversationId)
    const accepted = acceptAssistantTurn({ id: 'request-a', text: 'synthetic request', ownerKey: 'owner-a', draftClientId: 'client-a', draftRevision: 3 })
    const disk = JSON.parse(readFileSync(join(openGroundHome(), 'assistant', 'runtime.json'), 'utf8'))
    expect(disk.turns).toEqual([accepted])
    expect(statSync(join(openGroundHome(), 'assistant', 'runtime.json')).mode & 0o777).toBe(0o600)
    expect(listAcceptedAssistantDrafts('client-a', 'owner-a')).toEqual([{ draftRevision: 3 }])
    expect(listAcceptedAssistantDrafts('client-a', 'owner-b')).toEqual([])
  })
  it('replays the same id/content and refuses another body without creating another turn', () => {
    const first = acceptAssistantTurn({ id: 'same', text: 'one' })
    expect(acceptAssistantTurn({ id: 'same', text: 'one' })).toEqual(first)
    expect(() => acceptAssistantTurn({ id: 'same', text: 'two' })).toThrow('request-id-content-mismatch')
    expect(readAssistantRuntime().turns).toHaveLength(1)
  })
  it('reuses the first photo receipt when identical bytes were saved under a fresh retry filename', () => {
    const first = acceptAssistantTurn({ id: 'photo', text: 'look', photo: 'first.png', photoDigest: 'a'.repeat(64) })
    expect(acceptAssistantTurn({ id: 'photo', text: 'look', photo: 'retry.png', photoDigest: 'a'.repeat(64) })).toEqual(first)
    expect(readAssistantRuntime().turns[0].photo).toBe('first.png')
    expect(getAssistantTurnReceipt('photo')).not.toHaveProperty('photoDigest')
    expect(() => acceptAssistantTurn({ id: 'photo', text: 'look', photo: 'retry.png', photoDigest: 'b'.repeat(64) })).toThrow('request-id-content-mismatch')
  })
  it('does not transfer a queued request to a replacement owner or provider account', () => {
    acceptAssistantTurn({ id: 'bound', text: 'one', ownerKey: 'owner-a', accountKey: 'account-a' })
    expect(() => acceptAssistantTurn({ id: 'bound', text: 'one', ownerKey: 'owner-b', accountKey: 'account-a' })).toThrow('owner-changed')
    expect(() => acceptAssistantTurn({ id: 'bound', text: 'one', ownerKey: 'owner-a', accountKey: 'account-b' })).toThrow('account-changed')
    expect(claimAssistantTurn('bound', { provider: 'chatgpt' }, 'account-b')).toBeNull()
    expect(getAssistantTurnReceipt('bound', 'owner-b')).toBeNull()
    const receipt = getAssistantTurnReceipt('bound', 'owner-a')!
    expect(receipt).not.toHaveProperty('ownerKey')
    expect(receipt).not.toHaveProperty('accountKey')
    expect(receipt).not.toHaveProperty('bodyHash')
  })
  it('orders the inbox, does not dequeue while paused, and commits one matching attempt', () => {
    acceptAssistantTurn({ id: 'one', text: 'first' }); acceptAssistantTurn({ id: 'two', text: 'second' })
    expect(claimAssistantTurn('two')).toBeNull()
    mutateAssistantRuntime(s => { s.paused = true })
    expect(claimAssistantTurn('one')).toBeNull()
    mutateAssistantRuntime(s => { s.paused = false })
    const running = claimAssistantTurn('one')!
    expect(claimAssistantTurn('two')).toBeNull()
    expect(settleAssistantTurn(running, { reply: 'done' })).toBe(true)
    expect(settleAssistantTurn(running, { reply: 'duplicate' })).toBe(false)
    expect(readAssistantRuntime().turns[0].result?.reply).toBe('done')
  })
  it('hands queued owner text from ChatGPT to Claude without retaining the old provider account lease', () => {
    acceptAssistantTurn({ id: 'handoff', text: 'continue after switching', ownerKey: 'same-owner', accountKey: 'old-gpt-account' })
    const admitted = claimAssistantTurn('handoff', { provider: 'claude', model: 'synthetic' })!
    expect(admitted.profile?.provider).toBe('claude')
    expect(admitted.accountKey).toBeUndefined()
    expect(admitted.ownerKey).toBe('same-owner')
  })
  it('new conversation cancels old queued work and rejects its late result and stale epoch', () => {
    const accepted = acceptAssistantTurn({ id: 'one', text: 'first' })
    const active = claimAssistantTurn('one')!
    acceptAssistantTurn({ id: 'two', text: 'second' })
    const reset = resetAssistantRuntimeState('new-conversation-op', 'new-conversation')
    expect(reset.turns).toEqual([])
    expect(['one', 'two'].map(id => getAssistantTurnReceipt(id)?.state)).toEqual(['cancelled', 'cancelled'])
    expect(assistantTurnCurrent(active)).toBe(false)
    expect(settleAssistantTurn(active, { reply: 'late answer' })).toBe(false)
    expect(() => acceptAssistantTurn({ id: 'late-input', text: 'old', conversationId: accepted.conversationId, epoch: accepted.epoch })).toThrow('conversation-changed')
    expect(resetAssistantRuntimeState('new-conversation-op', 'new-conversation').epoch).toBe(reset.epoch)
    expect(() => resetAssistantRuntimeState('new-conversation-op', 'delete-memory')).toThrow('operation-id-content-mismatch')
    expect(acceptAssistantTurn({ id: 'two', text: 'second' }).state).toBe('cancelled')
    mutateAssistantRuntime(s => { s.operations[0].phase = 'completed'; s.paused = false })
    resetAssistantRuntimeState('another-conversation-op', 'new-conversation')
    expect(resetAssistantRuntimeState('new-conversation-op', 'new-conversation').epoch).toBe(reset.epoch + 1)
  })
  it('recovers queued work but holds interrupted turns and unknown external effects', () => {
    acceptAssistantTurn({ id: 'active', text: 'one' }); claimAssistantTurn('active')
    acceptAssistantTurn({ id: 'queued', text: 'two' })
    mutateAssistantRuntime(s => { s.actions.push({ id: 'effect-a', proposalId: 'proposal-a', hash: 'a'.repeat(64),
      conversationId: s.conversationId, epoch: s.epoch, state: 'started', at: 1 }) })
    const recovered = recoverAssistantRuntime()
    expect(recovered.turns.map(t => t.state)).toEqual(['interrupted', 'queued'])
    expect(recovered.actions[0].state).toBe('uncertain')
    expect(claimAssistantTurn('active')).toBeNull()
    expect(claimAssistantTurn('queued')?.id).toBe('queued')
  })
  it('preserves a corrupt journal and refuses to replace it with an empty conversation', () => {
    readAssistantRuntime()
    const path = join(openGroundHome(), 'assistant', 'runtime.json')
    writeFileSync(path, '{broken')
    expect(() => acceptAssistantTurn({ id: 'lost', text: 'never acknowledge' })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
})
