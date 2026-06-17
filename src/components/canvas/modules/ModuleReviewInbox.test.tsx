// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'

// The owner review inbox (docs/CUSTOM_TABS_PLAN.md): lists the pending queue,
// approves (publish) / rejects, and reports the newest created_at via onSeen so
// the gear dot clears. All effects go through fetch — a URL-branching mock here
// (persistent, so it's robust to React's mount-effect double-invoke).

// IMPORTANT: a STABLE `t`. ModuleReviewInbox does `load = useCallback(..., [t])`
// + `useEffect(() => load(), [load])`; if the mock returns a fresh `t` each call
// the effect re-fires every render → load() setStates → re-render → infinite
// render loop (spins CPU forever). The real I18n context value is stable between
// the component's own re-renders, so production never loops — only this mock can.
vi.mock('@/i18n/I18nContext', () => {
  const t = (k: string, p?: Record<string, string>) =>
    p ? `${k}:${Object.values(p).join(',')}` : k
  return { useT: () => ({ t }) }
})

import { ModuleReviewInbox } from './ModuleReviewInbox'
import type { ModuleSubmissionItem } from '@/lib/types'

const item = (id: string, over: Partial<ModuleSubmissionItem> = {}): ModuleSubmissionItem => ({
  id,
  created_at: '2026-06-16T00:00:00Z',
  submitter_email: 'tester@example.com',
  name: `Tab ${id}`,
  description: `desc ${id}`,
  framework: 'react',
  status: 'pending',
  published_remote_id: null,
  ...over,
})

const listResponse = (items: ModuleSubmissionItem[], truncated = false) =>
  new Response(JSON.stringify({ items, truncated }), { status: 200 })

let listItems: ModuleSubmissionItem[]
let failList: boolean
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  listItems = []
  failList = false
  fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (/\/approve$/.test(u))
      return Promise.resolve(new Response(JSON.stringify({ remoteId: 'r1' }), { status: 200 }))
    if (/\/reject$/.test(u))
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    if (/\/module-submissions$/.test(u) && method === 'GET')
      return failList
        ? Promise.resolve(new Response('nope', { status: 500 }))
        : Promise.resolve(listResponse(listItems))
    if (/\/module-submissions\/[^/]+$/.test(u) && method === 'GET')
      return Promise.resolve(
        new Response(
          JSON.stringify({ ...(listItems[0] ?? item('a')), source: 'export default () => null' }),
          { status: 200 },
        ),
      )
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ModuleReviewInbox', () => {
  it('lists the pending queue and reports the newest created_at via onSeen', async () => {
    listItems = [item('a', { created_at: '2026-06-16T09:00:00Z' }), item('b')]
    const onSeen = vi.fn()
    const { getByText, getAllByText } = render(<ModuleReviewInbox onSeen={onSeen} />)
    await waitFor(() => getByText('Tab a'))
    expect(getByText('Tab b')).toBeTruthy()
    // The submitter is shown on each row (display-only); the newest row drives onSeen.
    expect(getAllByText('customTabs.reviewBy:tester@example.com')).toHaveLength(2)
    expect(onSeen).toHaveBeenCalledWith('2026-06-16T09:00:00Z')
  })

  it('shows the empty copy when the queue is clear', async () => {
    listItems = []
    const { getByText } = render(<ModuleReviewInbox />)
    await waitFor(() => getByText('customTabs.reviewEmpty'))
  })

  it('approve POSTs to /approve and drops the row from the list', async () => {
    listItems = [item('a')]
    const { getByText, queryByText } = render(<ModuleReviewInbox />)
    await waitFor(() => getByText('Tab a'))
    fireEvent.click(getByText('customTabs.approve'))
    await waitFor(() => expect(queryByText('Tab a')).toBeNull())
    const approve = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/a/approve'))
    expect(approve).toBeTruthy()
    expect((approve![1] as RequestInit).method).toBe('POST')
  })

  it('reject POSTs to /reject and drops the row', async () => {
    listItems = [item('a')]
    const { getByText, queryByText } = render(<ModuleReviewInbox />)
    await waitFor(() => getByText('Tab a'))
    fireEvent.click(getByText('customTabs.reject'))
    await waitFor(() => expect(queryByText('Tab a')).toBeNull())
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/a/reject'))).toBe(true)
  })

  it('surfaces a load error instead of crashing', async () => {
    failList = true
    const { getByText } = render(<ModuleReviewInbox />)
    await waitFor(() => getByText('customTabs.reviewError'))
  })
})
