// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useConversationDraft } from '@/lib/useConversationDraft'
import { ConversationDraftStatus } from './ConversationDraftStatus'
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (key: string) => key }) }))
it('uses live runtime as the display source for the same ID and retains unmatched durable receipts', () => {
  const base = renderHook(() => useConversationDraft('assistant')).result.current
  const draft = { ...base, enabled: true, receipts: [{ id: 'same-input', state: 'uncertain', text: 'この指示' }, { id: 'other-input', state: 'uncertain', text: '別の指示' }] }
  const view = render(<ConversationDraftStatus draft={draft} excludeReceiptIds={new Set(['same-input'])} />)
  expect(screen.getAllByText('settings.assistant.uncertain')).toHaveLength(1)
  expect(screen.queryByText('この指示')).toBeNull()
  expect(screen.getByText('別の指示')).toBeTruthy()
  expect(screen.queryByText('other-input')).toBeNull()
  // On reconnect while runtime is unavailable, persisted receipts stay visible.
  view.rerender(<ConversationDraftStatus draft={draft} />)
  expect(screen.getAllByText('settings.assistant.uncertain')).toHaveLength(2)
})

it('cancels the selected pending president input without resubmitting its text', async () => {
  const base = renderHook(() => useConversationDraft('project-fixture')).result.current
  const cancelReceipt = vi.fn(async () => {})
  const draft = { ...base, enabled: true, cancelReceipt, receipts: [{ id: 'cancel-this', state: 'queued', text: 'Old work' }, { id: 'keep-this', state: 'executing', text: 'New work' }] }
  render(<ConversationDraftStatus draft={draft} presidentPath="/fixture/project" />)
  expect(screen.getAllByRole('button', { name: 'settings.draft.cancelInput' })).toHaveLength(1)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.draft.cancelInput' })) })
  expect(cancelReceipt).toHaveBeenCalledExactlyOnceWith('/fixture/project', 'cancel-this', 'settings.draft.cancelNote')
})

it('keeps pending input visible and disables duplicate clicks while cancellation is unconfirmed', async () => {
  const base = renderHook(() => useConversationDraft('project-fixture')).result.current
  let reject!: (error: Error) => void
  const cancelReceipt = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const draft = { ...base, enabled: true, cancelReceipt, receipts: [{ id: 'old-work', state: 'uncertain', text: 'Old work' }] }
  render(<ConversationDraftStatus draft={draft} presidentPath="/fixture/project" />)
  const button = screen.getByRole('button', { name: 'settings.draft.cancelInput' })
  fireEvent.click(button)
  expect(button).toBeDisabled()
  expect(screen.getByText('settings.draft.blocked')).toBeTruthy()
  await act(async () => { reject(new Error('ack lost')) })
  await waitFor(() => expect(button).toBeEnabled())
  expect(screen.getByText('Old work')).toBeTruthy()
  expect(screen.getByText('settings.draft.cancelFailed')).toBeTruthy()
})
