// @vitest-environment jsdom
import { render, renderHook, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useConversationDraft } from '@/lib/useConversationDraft'
import { ConversationDraftStatus } from './ConversationDraftStatus'
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (key: string) => key }) }))
it('uses live runtime as the display source for the same ID and retains unmatched durable receipts', () => {
  const base = renderHook(() => useConversationDraft('assistant')).result.current
  const draft = { ...base, enabled: true, receipts: [{ id: 'same-input', state: 'uncertain', text: 'この指示' }, { id: 'other-input', state: 'uncertain', text: '別の指示' }] }
  const view = render(<ConversationDraftStatus draft={draft} excludeReceiptIds={new Set(['same-input'])} />)
  expect(screen.getAllByText('settings.assistant.uncertain')).toHaveLength(1)
  expect(screen.queryByText('same-input')).toBeNull()
  expect(screen.getByText('other-input')).toBeTruthy()
  // On reconnect while runtime is unavailable, persisted receipts stay visible.
  view.rerender(<ConversationDraftStatus draft={draft} />)
  expect(screen.getAllByText('settings.assistant.uncertain')).toHaveLength(2)
})
