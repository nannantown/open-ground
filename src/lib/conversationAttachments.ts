/** Owner-scoped local attachment spool. No credential or provider data enters it. */
const DB = 'openground-conversation-attachments'
const STORE = 'photos'
export const PHOTO_DATA_MAX = 7_000_000
export const validConversationPhoto = (photo: unknown): photo is string => typeof photo === 'string' && photo.length <= PHOTO_DATA_MAX && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(photo)
const referencedPhotos = (): Set<string> => {
  const keep = new Set<string>()
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key || (!key.startsWith('openground:conversation-draft:') && !key.startsWith('openground:conversation-outbox:'))) continue
    const raw = localStorage.getItem(key)
    if (!raw || raw.length > (key.startsWith('openground:conversation-outbox:') ? 3_000_000 : 256_000)) continue
    try {
      const saved = JSON.parse(raw) as { photoKey?: unknown; attempt?: { photoKey?: unknown } } | { photoKey?: unknown }[]
      const references = Array.isArray(saved) ? saved.map(item => item.photoKey) : [saved.photoKey, saved.attempt?.photoKey]
      for (const reference of references) if (typeof reference === 'string' && reference.startsWith(key + ':photo:')) keep.add(reference)
    } catch { /* A corrupt mirror cannot authorize reading another attachment. */ }
  }
  return keep
}
const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(STORE)
  request.onerror = () => reject(new Error('photo-save-failed'))
  request.onsuccess = () => resolve(request.result)
})
export const writeConversationPhoto = async (key: string, photo: string | null): Promise<void> => {
  if (photo !== null && !validConversationPhoto(photo)) throw new Error('photo-save-failed')
  const database = await open()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readwrite', { durability: 'strict' })
      if (photo === null) tx.objectStore(STORE).delete(key)
      else {
        const keys = tx.objectStore(STORE).getAllKeys()
        keys.onsuccess = () => {
          const referenced = referencedPhotos(); referenced.add(key)
          const retained = keys.result.filter(existing => typeof existing === 'string' && referenced.has(existing))
          if (retained.length >= 32 && !retained.includes(key)) { tx.abort(); return }
          for (const existing of keys.result) if (typeof existing === 'string' && !referenced.has(existing)) tx.objectStore(STORE).delete(existing)
          tx.objectStore(STORE).put(new Blob([photo], { type: 'text/plain' }), key)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(new Error('photo-save-failed'))
    })
  } finally { database.close() }
}
export const readConversationPhoto = async (key: string): Promise<string> => {
  const database = await open()
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readonly')
      const request = tx.objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('photo-recovery-failed'))
    })
    if (!(value instanceof Blob) || value.size > PHOTO_DATA_MAX) throw new Error('photo-recovery-failed')
    const photo = await value.text()
    if (!validConversationPhoto(photo)) throw new Error('photo-recovery-failed')
    return photo
  } finally { database.close() }
}
