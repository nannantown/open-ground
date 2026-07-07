// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { SwarmEscalationsPane } from './SwarmEscalationsPane'
import type { EscalationView } from '@/lib/types'

// The Escalations inbox panel (C1) — UI-side contract only: renders nothing
// while the inbox is empty, lists an OPEN question with its stakes + proxy
// draft, and fires the owner-gated POSTs with the right bodies. The server
// journey (idempotency, delivery, memory) is covered in swarmEscalations.test.ts
// + escalations.routes.test.ts; here the fetch layer is stubbed.

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k) }),
}))

const escalation = (over: Partial<EscalationView> = {}): EscalationView => ({
  id: 'esc-1',
  receiptKey: 'rk-1',
  createdAt: new Date('2026-07-03T09:00:00Z').toISOString(),
  projectPath: '/proj',
  taskId: 'card-1',
  branch: 'swarm/card-1',
  question: '本番キーを埋めますか？',
  context: '公開リポに乗るため不可逆。',
  whyEscalated: 'irreversible',
  status: 'open',
  proxyDraft: { answer: '埋めないのが通例です', confidence: 'medium', isAbstention: false },
  ...over,
})

let fetchCalls: Array<{ url: string; init?: RequestInit }> = []
let listPayload: EscalationView[] = []

beforeEach(() => {
  fetchCalls = []
  listPayload = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init })
      if (url.startsWith('/api/swarm/escalations?')) {
        return new Response(JSON.stringify({ escalations: listPayload }), { status: 200 })
      }
      if (url === '/api/swarm/escalations/answer') {
        return new Response(
          JSON.stringify({
            escalation: { ...escalation(), status: 'answered' },
            delivery: 'queued',
            memoryWritten: true,
          }),
          { status: 200 },
        )
      }
      if (url === '/api/swarm/escalations/dismiss') {
        return new Response(JSON.stringify({ escalation: { ...escalation(), status: 'dismissed' } }), {
          status: 200,
        })
      }
      return new Response('{}', { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SwarmEscalationsPane', () => {
  it('renders NOTHING while the inbox is empty', async () => {
    const { container } = render(<SwarmEscalationsPane projectPath="/proj" />)
    await waitFor(() => expect(fetchCalls.length).toBeGreaterThan(0))
    expect(container.firstChild).toBeNull()
  })

  it('lists an open question with stakes + proxy draft, and answers with the typed text', async () => {
    listPayload = [escalation()]
    const { getByText, getByPlaceholderText } = render(<SwarmEscalationsPane projectPath="/proj" />)
    await waitFor(() => getByText('本番キーを埋めますか？'))
    getByText('公開リポに乗るため不可逆。')
    getByText('埋めないのが通例です')

    // The send button is disabled until an answer is typed (never a blank inject).
    const send = getByText('projectPanel.swarm.esc.answerSend').closest('button')!
    expect(send.disabled).toBe(true)
    fireEvent.change(getByPlaceholderText('projectPanel.swarm.esc.answerPlaceholder'), {
      target: { value: '埋めない。envから注入。' },
    })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)

    await waitFor(() => {
      const call = fetchCalls.find((c) => c.url === '/api/swarm/escalations/answer')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.init?.body))).toEqual({
        id: 'esc-1',
        answer: '埋めない。envから注入。',
      })
    })
    // The delivery outcome surfaces to the owner.
    await waitFor(() => getByText(/deliveryQueued/))
  })

  it('“use draft” copies the proxy draft into the textarea; dismiss posts the id', async () => {
    listPayload = [escalation()]
    const { getByText, getByPlaceholderText } = render(<SwarmEscalationsPane projectPath="/proj" />)
    await waitFor(() => getByText('本番キーを埋めますか？'))

    fireEvent.click(getByText('projectPanel.swarm.esc.useDraft'))
    expect(
      (getByPlaceholderText('projectPanel.swarm.esc.answerPlaceholder') as HTMLTextAreaElement)
        .value,
    ).toBe('埋めないのが通例です')

    fireEvent.click(getByText('projectPanel.swarm.esc.dismiss'))
    await waitFor(() => {
      const call = fetchCalls.find((c) => c.url === '/api/swarm/escalations/dismiss')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.init?.body))).toEqual({ id: 'esc-1' })
    })
  })
})
