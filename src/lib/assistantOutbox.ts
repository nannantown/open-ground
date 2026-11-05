import { readConversationPhoto, writeConversationPhoto } from './conversationAttachments'
export interface AssistantOutboxItem { clientId: string; text: string; photoKey?: string; photoHash?: string; sent?: boolean; at: number; conversationId?: string; epoch?: number }
const withLock = async <T>(owner: string, action: () => Promise<T>): Promise<T> => {
  if (!navigator.locks) throw new Error('outbox-unavailable')
  return navigator.locks.request(`openground:assistant-outbox:${owner}`, action)
}
const storageKey = (owner: string) => `openground:conversation-outbox:${encodeURIComponent(owner)}`
export const readAssistantOutbox = (owner: string): AssistantOutboxItem[] => {
  const key = storageKey(owner)
  const raw = localStorage.getItem(key)
  if (!raw) return []
  if (raw.length > 3_000_000) throw new Error('outbox-unavailable')
  const items: unknown = JSON.parse(raw)
  if (!Array.isArray(items) || items.length > 64 || !items.every(item => item && typeof item.clientId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(item.clientId) && typeof item.text === 'string' && item.text.length <= 32768 && typeof item.at === 'number' && (!item.photoKey || typeof item.photoKey === 'string' && item.photoKey.startsWith(key + ':photo:')))) throw new Error('outbox-unavailable')
  return items
}
export const persistAssistantOutbox = async (owner: string, item: AssistantOutboxItem, photo?: string): Promise<AssistantOutboxItem> => withLock(owner, async () => {
  const key = storageKey(owner)
  const items = readAssistantOutbox(owner)
  const previous = items.find(record => record.clientId === item.clientId)
  if (previous && previous.text !== item.text) throw new Error('outbox-id-conflict')
  const photoHash = photo ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(photo)))).map(byte => byte.toString(16).padStart(2, '0')).join('') : undefined
  if (previous && !!previous.photoKey !== !!photo) throw new Error('outbox-id-conflict')
  if (previous?.photoHash && photoHash !== previous.photoHash) throw new Error('outbox-id-conflict')
  if (previous?.photoKey && !previous.photoHash) {
    const saved = await readConversationPhoto(previous.photoKey).catch(() => undefined)
    if (!saved || saved !== photo) throw new Error('outbox-id-conflict')
  }
  const record = previous ?? { ...item, ...(photo ? { photoKey: `${key}:photo:${item.clientId}`, photoHash } : {}) }
  if (!previous) {
    if (items.length >= 64) throw new Error('outbox-full')
    localStorage.setItem(key, JSON.stringify([...items, record]))
  }
  if (photo && record.photoKey) await writeConversationPhoto(record.photoKey, photo)
  return record
})
export const forgetAssistantOutbox = async (owner: string, clientId: string): Promise<void> => withLock(owner, async () => {
  const items = readAssistantOutbox(owner)
  const item = items.find(record => record.clientId === clientId)
  localStorage.setItem(storageKey(owner), JSON.stringify(items.filter(record => record.clientId !== clientId)))
  if (item?.photoKey) await writeConversationPhoto(item.photoKey, null)
})
export const outboxPhoto = (item: AssistantOutboxItem) => item.photoKey ? readConversationPhoto(item.photoKey) : Promise.resolve(undefined)

export const bindAssistantOutbox = (owner: string, clientId: string, context: { conversationId: string; epoch: number }): Promise<AssistantOutboxItem> => withLock(owner, async () => {
  if (!context.conversationId || !Number.isSafeInteger(context.epoch) || context.epoch < 0) throw new Error('conversation-unavailable')
  const items = readAssistantOutbox(owner)
  const previous = items.find(item => item.clientId === clientId)
  if (!previous) throw new Error('outbox-unavailable')
  if (previous.sent) return previous
  const bound = { ...previous, conversationId: context.conversationId, epoch: context.epoch, sent: true }
  localStorage.setItem(storageKey(owner), JSON.stringify(items.map(item => item.clientId === clientId ? bound : item)))
  return bound
})
