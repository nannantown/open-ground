// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { bindAssistantOutbox, forgetAssistantOutbox, outboxPhoto, persistAssistantOutbox, readAssistantOutbox } from './assistantOutbox'
const { photos } = vi.hoisted(() => ({ photos: new Map<string, string>() }))
vi.mock('./conversationAttachments', () => ({ writeConversationPhoto: async (key: string, photo: string | null) => { if (photo) photos.set(key, photo); else photos.delete(key) }, readConversationPhoto: async (key: string) => { const photo = photos.get(key); if (!photo) throw new Error('missing'); return photo } }))
beforeEach(() => { localStorage.clear(); photos.clear(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { locks: { request: async (_name: string, action: () => Promise<unknown>) => action() } }) })
afterEach(() => vi.unstubAllGlobals())
it('persists all owner sends before admission and restores the exact identity/body/photo', async () => {
  const item = { clientId: 'stable-retry', text: '元の指示を維持', at: Date.now() }
  await persistAssistantOutbox('owner-one', item, 'data:image/png;base64,aGVsbG8=')
  const restored = readAssistantOutbox('owner-one')[0]
  expect(restored).toMatchObject(item)
  expect(await outboxPhoto(restored)).toBe('data:image/png;base64,aGVsbG8=')
  expect(readAssistantOutbox('owner-two')).toEqual([])
  await expect(persistAssistantOutbox('owner-one', { ...item, text: '別の指示' })).rejects.toThrow('outbox-id-conflict')
  await expect(persistAssistantOutbox('owner-one', item, 'data:image/png;base64,d29ybGQ=')).rejects.toThrow('outbox-id-conflict')
  await forgetAssistantOutbox('owner-one', item.clientId)
  expect(readAssistantOutbox('owner-one')).toEqual([])
})
it('blocks a same-ID replay whose attachment bytes are unavailable', async () => {
  const item = { clientId: 'with-photo', text: '写真も確認', at: Date.now() }
  await persistAssistantOutbox('owner-one', item, 'data:image/png;base64,aGVsbG8=')
  photos.clear()
  await expect(persistAssistantOutbox('owner-one', item)).rejects.toThrow('outbox-id-conflict')
  expect(readAssistantOutbox('owner-one')).toHaveLength(1)
})

it('binds a prepared message to one conversation epoch before sending and never rebinds an unknown attempt', async () => {
  await persistAssistantOutbox('owner-one', { clientId: 'stable-message', text: 'この会話への指示', at: Date.now() })
  const first = await bindAssistantOutbox('owner-one', 'stable-message', { conversationId: 'conversation-one', epoch: 1 })
  expect(first.sent).toBe(true)
  const retry = await bindAssistantOutbox('owner-one', 'stable-message', { conversationId: 'conversation-two', epoch: 2 })
  expect(retry).toEqual(first)
  expect(readAssistantOutbox('owner-one')[0]).toMatchObject({ conversationId: 'conversation-one', epoch: 1 })
})
it('fails closed when this browser cannot serialize owner outbox writes', async () => {
  vi.stubGlobal('navigator', {})
  await expect(persistAssistantOutbox('owner-one', { clientId: 'stable-message', text: '保持する指示', at: Date.now() })).rejects.toThrow('outbox-unavailable')
  expect(readAssistantOutbox('owner-one')).toEqual([])
})
