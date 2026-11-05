// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationDraftOwnerContext } from '@/lib/useConversationDraft'
import { ConversationRecoverySetting } from './ConversationRecoverySetting'
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (key: string) => key }) }))
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())
const ownerView = () => <ConversationDraftOwnerContext.Provider value="owner-fixture"><ConversationRecoverySetting /></ConversationDraftOwnerContext.Provider>
it('requires owner inspection notes and preserves one review request across a lost acknowledgement/restart', async () => {
  let issues = [{ id: 'tool-operation', scope: 'swarm', kind: 'tool', tool: 'Bash', conversationId: 'conversation-one', callId: 'call-one', state: 'uncertain' }]
  let fail = true
  const posted: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/review')) {
      posted.push(JSON.parse(String(init?.body)))
      if (fail) throw new Error('response-lost')
      issues = []
      return Response.json({ ok: true })
    }
    return Response.json({ issues })
  }))
  const first = render(ownerView())
  const review = await screen.findByRole('button', { name: 'settings.recovery.review' })
  expect(review).toBeDisabled()
  expect(posted).toEqual([])
  fireEvent.change(screen.getByRole('textbox', { name: 'settings.recovery.note' }), { target: { value: 'Git diffとBoardを確認しました。変更は残っています。' } })
  fireEvent.click(review)
  await screen.findByText('settings.recovery.failed')
  expect(posted).toHaveLength(1)
  first.unmount()
  fail = false
  render(ownerView())
  const retry = await screen.findByRole('button', { name: 'settings.recovery.retry' })
  fireEvent.click(retry)
  await waitFor(() => expect(posted).toHaveLength(2))
  expect(posted[1]).toEqual(posted[0])
  expect(fetch).toHaveBeenCalledWith('/api/conversation/recovery/review', expect.objectContaining({ headers: { 'Content-Type': 'application/json', 'X-OpenGround-Owner': 'owner-fixture' } }))
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull())
})
it('does not inspect or review another owner when no actual owner is confirmed', () => {
  vi.stubGlobal('fetch', vi.fn())
  render(<ConversationRecoverySetting />)
  expect(fetch).not.toHaveBeenCalled()
})
