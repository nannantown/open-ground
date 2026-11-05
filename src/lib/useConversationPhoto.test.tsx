// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationDraftOwnerContext, resetConversationDraftControllersForTests, useConversationDraft } from './useConversationDraft'
const { photos, fail, write } = vi.hoisted(() => ({ photos: new Map<string, string>(), fail: { value: false }, write: vi.fn() }))
vi.mock('./conversationAttachments', () => ({
  validConversationPhoto: (value: unknown) => typeof value === 'string' && value.startsWith('data:image/png;base64,'),
  readConversationPhoto: async (key: string) => { const photo = photos.get(key); if (!photo) throw new Error('photo-recovery-failed'); return photo },
  writeConversationPhoto: async (key: string, value: string | null) => { write(key, value); if (fail.value) throw new Error('quota'); if (value) photos.set(key, value); else photos.delete(key) },
}))
const wrapper = ({ children }: { children: React.ReactNode }) => <ConversationDraftOwnerContext.Provider value="owner-fixture">{children}</ConversationDraftOwnerContext.Provider>
const firstPhoto = 'data:image/png;base64,aGVsbG8='
const nextPhoto = 'data:image/png;base64,d29ybGQ='
beforeEach(() => { localStorage.clear(); photos.clear(); fail.value = false; write.mockClear(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ revision: 0, text: '', updatedAt: '' }))) })
afterEach(() => { resetConversationDraftControllersForTests(); vi.unstubAllGlobals() })
const ready = async () => { const hook = renderHook(() => useConversationDraft('assistant'), { wrapper }); await waitFor(() => expect(hook.result.current.loaded).toBe(true)); return hook }
it('persists a bounded attachment before admission and replays its original bytes after renderer restart', async () => {
  const first = await ready()
  act(() => first.result.current.setPhoto!(firstPhoto))
  let send!: Awaited<ReturnType<NonNullable<typeof first.result.current.prepareSend>>>
  await act(async () => { send = await first.result.current.prepareSend!() })
  expect(send.photoKey).toBeTruthy()
  expect(photos.get(send.photoKey!)).toBe(firstPhoto)
  first.unmount(); resetConversationDraftControllersForTests()
  // A lost acknowledgement keeps the same request and original attachment.
  vi.mocked(fetch).mockImplementation(async input => String(input).includes('/receipt?') ? Response.json({}, { status: 404 }) : Response.json({ revision: 0, text: '', updatedAt: '' }))
  const second = await ready()
  expect(second.result.current.photo).toBe(firstPhoto)
  const replay = await second.result.current.prepareSend!()
  expect(replay.clientId).toBe(send.clientId)
  expect(await second.result.current.photoForSend!(replay)).toBe(firstPhoto)
})
it('retains the selected photo and blocks admission if its durable save fails', async () => {
  const hook = await ready(); fail.value = true
  act(() => hook.result.current.setPhoto!(firstPhoto))
  await waitFor(() => expect(hook.result.current.photoError).toBe('photo-save-failed'))
  await act(async () => { await expect(hook.result.current.prepareSend!()).rejects.toThrow('photo-save-failed') })
  expect(hook.result.current.attempt).toBeNull()
  expect(hook.result.current.photo).toBe(firstPhoto)
})
it('a late accepted photo cannot clear a replacement selected in the meantime', async () => {
  const hook = await ready()
  act(() => hook.result.current.setPhoto!(firstPhoto))
  const send = await hook.result.current.prepareSend!()
  act(() => hook.result.current.setPhoto!(nextPhoto))
  await act(async () => { await hook.result.current.accepted!(send) })
  expect(hook.result.current.photo).toBe(nextPhoto)
  const next = await hook.result.current.prepareSend!()
  expect(await hook.result.current.photoForSend!(next)).toBe(nextPhoto)
})
