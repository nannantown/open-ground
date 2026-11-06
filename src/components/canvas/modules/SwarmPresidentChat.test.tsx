// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SwarmSeatFeed, SwarmSeatSay } from './SwarmSeatTalk'
import { ConversationDraftOwnerContext } from '@/lib/useConversationDraft'
import { groupSdkFrames } from '@/lib/sdkTranscript'
import { PresidentChatTranscript } from './PresidentChatTranscript'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (key: string) => key }) }))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

const frames = [
  { seq: 1, ev: { kind: 'input', text: 'この変更を確認してください。' } },
  { seq: 2, ev: { kind: 'text', text: '確認します。\n\n**結果**をまとめます。' } },
  { seq: 3, ev: { kind: 'tool_use', name: 'Bash', detail: 'npm test -- --run' } },
  { seq: 4, ev: { kind: 'tool_result', ok: true, head: '17 tests passed' } },
  { seq: 5, ev: { kind: 'text', text: '検査は通りました。' } },
]

it('renders the president as owner bubbles, readable prose and a disclosure for actual tool details', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ frames, reaped: false }))))
  const view = render(<SwarmSeatFeed sdkSessionId="president-fixture" projectPath="/fixture" conversation />)
  await view.findByText('この変更を確認してください。')
  expect(view.getByText('この変更を確認してください。').closest('[data-chat-role="owner"]')).toBeInTheDocument()
  expect(view.getByText('検査は通りました。').closest('article')).toHaveAttribute('data-chat-role', 'assistant')
  expect(view.getByText('結果').tagName).toBe('STRONG')
  expect(view.queryByText('17 tests passed')).not.toBeInTheDocument()
  const activity = view.getByRole('button', { name: 'projectPanel.swarm.chat.commandDone' })
  expect(activity).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(activity)
  expect(view.getByText('npm test -- --run')).toBeVisible()
  expect(view.getByText('17 tests passed')).toBeVisible()
  fireEvent.click(activity)
  expect(view.queryByText('17 tests passed')).not.toBeInTheDocument()
})

it('keeps manual scroll while new messages arrive and follows again only on an explicit latest action', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  let polls = 0
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ frames: polls++ ? [{ seq: 6, ev: { kind: 'text', text: '追加の確認結果です。' } }] : frames, reaped: false }))))
  const view = render(<SwarmSeatFeed sdkSessionId="president-fixture" projectPath="/fixture" conversation />)
  await view.findByText('検査は通りました。')
  const scroll = view.container.querySelector('[data-president-scroll]') as HTMLDivElement
  expect(scroll).not.toBeNull()
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 300 } })
  scroll.scrollTop = 120
  fireEvent.scroll(scroll)
  await vi.advanceTimersByTimeAsync(3000)
  await view.findByText('追加の確認結果です。')
  expect(scroll.scrollTop).toBe(120)
  fireEvent.click(view.getByRole('button', { name: 'projectPanel.swarm.sdk.jumpLatest' }))
  expect(scroll.scrollTop).toBe(1000)
})

it('uses the exact-turn stop action without submitting or clearing an edited draft', async () => {
  const send = vi.fn(async () => ({ ok: true as const, note: 'accepted' }))
  const stop = vi.fn()
  const view = render(<SwarmSeatSay alwaysOpen appearance="chat" placeholder="Talk" onSend={send}
    turnControl={{ running: true, canStop: true, stopping: false, onStop: stop }} />)
  const box = view.getByRole('textbox')
  fireEvent.click(view.getByRole('button', { name: 'projectPanel.swarm.chat.stop' }))
  expect(stop).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled()
  fireEvent.change(box, { target: { value: '次の相談を残す' } })
  expect(view.getByRole('button', { name: 'projectPanel.swarm.say.send' })).toBeEnabled()
  expect(box).toHaveValue('次の相談を残す')
})

it('restores canonical public words beyond the tail, excludes kickoff and never duplicates text captured ahead of events', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  let revision = 1
  let unavailable = false
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/history?')) {
      expect((init?.headers as Record<string, string>)['X-OpenGround-Owner']).toBe('fixture-owner')
      if (unavailable) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ revision: String(revision), overflow: false, lines: [
        { kind: 'input', text: '前の会話から相談します。' }, { kind: 'text', text: '保存された返答です。' },
        ...(revision > 1 ? [{ kind: 'text', text: 'イベントより先に保存された返答です。' }] : []),
      ] }))
    }
    return new Response(JSON.stringify({ frames: [
      { seq: 40, ev: { kind: 'input', text: 'PRIVATE KICKOFF INSTRUCTIONS' } },
      { seq: 41, ev: { kind: 'text', text: '保存された返答です。' } },
      ...frames.slice(2, 4).map((frame, index) => ({ ...frame, seq: 42 + index })),
    ] }))
  })
  vi.stubGlobal('fetch', fetcher)
  const view = render(<ConversationDraftOwnerContext.Provider value="fixture-owner"><SwarmSeatFeed sdkSessionId="president-fixture" projectPath="/fixture" conversation /></ConversationDraftOwnerContext.Provider>)
  await view.findByText('前の会話から相談します。')
  expect(view.getAllByText('保存された返答です。')).toHaveLength(1)
  expect(view.queryByText('PRIVATE KICKOFF INSTRUCTIONS')).not.toBeInTheDocument()
  expect(view.queryByRole('button', { name: 'projectPanel.swarm.chat.commandDone' })).not.toBeInTheDocument()
  fireEvent.click(view.getByRole('button', { name: 'projectPanel.swarm.chat.activity' }))
  expect(view.getByRole('button', { name: 'projectPanel.swarm.chat.commandDone' })).toBeVisible()
  revision++
  await vi.advanceTimersByTimeAsync(3000)
  expect(view.getAllByText('イベントより先に保存された返答です。')).toHaveLength(1)
  unavailable = true
  await vi.advanceTimersByTimeAsync(3000)
  expect(view.getByText('前の会話から相談します。')).toBeVisible()
})

it('reveals a new public failure even if the reader closed an earlier failed activity', () => {
  const failure = (seq: number) => groupSdkFrames([{ seq, ev: { kind: 'api_error', status: 503, head: `Public failure ${seq}` } }])
  const view = render(<PresidentChatTranscript items={failure(1)} publicLines={[]} />)
  expect(view.getByText('503 — Public failure 1')).toBeVisible()
  fireEvent.click(view.getByRole('button', { name: 'projectPanel.swarm.chat.activity' }))
  expect(view.queryByText('503 — Public failure 1')).not.toBeInTheDocument()
  view.rerender(<PresidentChatTranscript items={[...failure(1), ...failure(2)]} publicLines={[]} />)
  expect(view.getByText('503 — Public failure 2')).toBeVisible()
})

it('waits for the owner-bound public history before rendering a tail kickoff or activities', async () => {
  let release: ((response: Response) => void) | undefined
  vi.stubGlobal('fetch', async (url: string) => url.includes('/history?') ? new Promise<Response>(resolve => { release = resolve })
    : new Response(JSON.stringify({ frames: [{ seq: 1, ev: { kind: 'input', text: 'INTERNAL KICKOFF' } }, ...frames.slice(2, 4)] })))
  const view = render(<ConversationDraftOwnerContext.Provider value="fixture-owner"><SwarmSeatFeed sdkSessionId="fixture-owner-gate" projectPath="/fixture" conversation /></ConversationDraftOwnerContext.Provider>)
  await waitFor(() => expect(release).toBeDefined())
  expect(view.queryByText('INTERNAL KICKOFF')).not.toBeInTheDocument()
  expect(view.queryByRole('button', { name: 'projectPanel.swarm.chat.commandDone' })).not.toBeInTheDocument()
  await act(async () => { release!(new Response(JSON.stringify({ lines: [{ kind: 'input', text: '本人の相談' }], overflow: false, revision: '1' }))) })
  expect(view.getByText('本人の相談')).toBeVisible()
})

it('clears the old conversation on a confirmed epoch change and rejects its delayed history response', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const history = (text: string) => new Response(JSON.stringify({ lines: [{ kind: 'text', text }], overflow: false, revision: text }))
  let reads = 0
  let oldPending: ((response: Response) => void) | undefined
  let newPending: ((response: Response) => void) | undefined
  vi.stubGlobal('fetch', async (url: string) => {
    if (!url.includes('/history?')) return new Response(JSON.stringify({ frames: [] }))
    reads++
    if (reads === 1) return history('前の会話の返答')
    return new Promise<Response>(resolve => { if (reads === 2) oldPending = resolve; else newPending = resolve })
  })
  const feed = (key: string) => <ConversationDraftOwnerContext.Provider value="fixture-owner"><SwarmSeatFeed sdkSessionId="same-handle" projectPath="/fixture" conversation conversationKey={key} /></ConversationDraftOwnerContext.Provider>
  const view = render(feed('conversation:1'))
  await view.findByText('前の会話の返答')
  await vi.advanceTimersByTimeAsync(3000)
  expect(oldPending).toBeDefined()
  view.rerender(feed('conversation:2'))
  expect(view.queryByText('前の会話の返答')).not.toBeInTheDocument()
  await vi.advanceTimersByTimeAsync(600)
  expect(newPending).toBeDefined()
  await act(async () => { oldPending!(history('遅れて届いた前の会話')) })
  expect(view.queryByText('遅れて届いた前の会話')).not.toBeInTheDocument()
  await act(async () => { newPending!(history('新しい会話の返答')) })
  expect(view.getByText('新しい会話の返答')).toBeVisible()
})

it('keeps authorized words across a handle handoff within the same conversation', async () => {
  let newPending: ((response: Response) => void) | undefined
  vi.stubGlobal('fetch', async (url: string) => {
    if (!url.includes('/history?')) return new Response(JSON.stringify({ frames: [] }))
    if (url.includes('sessionId=old-handle')) return new Response(JSON.stringify({ lines: [{ kind: 'text', text: '引き継ぐ会話の返答' }], overflow: false, revision: '1' }))
    return new Promise<Response>(resolve => { newPending = resolve })
  })
  const feed = (handle: string) => <ConversationDraftOwnerContext.Provider value="fixture-owner"><SwarmSeatFeed sdkSessionId={handle} projectPath="/fixture" conversation conversationKey="same-conversation:1" /></ConversationDraftOwnerContext.Provider>
  const view = render(feed('old-handle'))
  await view.findByText('引き継ぐ会話の返答')
  view.rerender(feed('new-handle'))
  await waitFor(() => expect(newPending).toBeDefined())
  expect(view.getByText('引き継ぐ会話の返答')).toBeVisible()
  await act(async () => { newPending!(new Response(JSON.stringify({ lines: [{ kind: 'text', text: '引き継いだ新しい席の返答' }], overflow: false, revision: '1' }))) })
  expect(view.getByText('引き継いだ新しい席の返答')).toBeVisible()
})
