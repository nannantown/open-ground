// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { useConversationDraft } from '@/lib/useConversationDraft'
import { SwarmSupplyPane, callStamp } from './SwarmSupplyPane'
// t: the real substitution shape, keyed by the current language.
const h = vi.hoisted(() => ({ lang: 'en' }))
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ lang: h.lang, t: (k: string, v?: Record<string, string>) => (k === 'projectPanel.swarm.supply.call' ? `${h.lang === 'ja' ? '通話' : 'Call'} ${v?.duration}` : k) }),
}))
vi.mock('@/components/canvas/ClaudeTerminalPane', () => ({ ClaudeTerminalPane: () => <div>real terminal surface</div> }))
vi.mock('./SwarmSeatHeader', () => ({ SwarmSeatHeader: ({ children }: { children: ReactNode }) => <div>president{children}</div> }))
vi.mock('./SwarmSeatTalk', async (importOriginal) => ({
  ...await importOriginal<typeof import('./SwarmSeatTalk')>(),
  SwarmSeatFeed: ({ sdkSessionId }: { sdkSessionId: string }) => <div>structured president {sdkSessionId}</div>,
}))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); h.lang = 'en' })
const pane = () => <SwarmSupplyPane projectPath="/p one" terminalId="t1" status="waiting" busy={false} onExit={() => {}} onStop={() => {}} onRestart={() => {}} />

it('attaches an SDK president to its own transcript and always-visible composer, preserving the legacy PTY surface', () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ entries: [] }))))
  const view = render(<SwarmSupplyPane projectPath="/p one" terminalId="" runtime="sdk" sdkSessionId="sdk-president"
    status="waiting" busy={false} onExit={() => {}} onStop={() => {}} onRestart={() => {}} />)
  expect(view.getByText('structured president sdk-president')).toBeInTheDocument()
  expect(view.getByRole('textbox', { name: 'projectPanel.swarm.say.presidentPlaceholder' })).toBeInTheDocument()
  expect(view.queryByText('real terminal surface')).toBeNull()
})

it('names the header action as ending the president rather than stopping only a response', () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ entries: [] }))))
  const stop = vi.fn()
  const view = render(<SwarmSupplyPane projectPath="/fixture" terminalId="" runtime="sdk" sdkSessionId="sdk-president"
    status="waiting" busy={false} onExit={() => {}} onStop={stop} onRestart={() => {}} />)
  const end = view.getByRole('button', { name: 'projectPanel.swarm.supply.stopHint' })
  expect(end).toHaveAttribute('title', 'projectPanel.swarm.supply.stopHint')
  fireEvent.click(end)
  expect(stop).toHaveBeenCalledOnce()
})

it('keeps an unsent president draft across exit and SDK restart, refusing input until the new desk is ready', async () => {
  const posts: { url: string; text: string }[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ url, text: JSON.parse(init.body as string).text })
    return Promise.resolve(new Response(JSON.stringify(init?.method === 'POST' ? { ok: true, queued: true } : { entries: [] })))
  })
  const props = { projectPath: '/p one', terminalId: '', runtime: 'sdk' as const, sdkSessionId: 'sdk-old', status: 'waiting' as const,
    busy: false, onExit: vi.fn(), onStop: vi.fn(), onRestart: vi.fn() }
  const view = render(<SwarmSupplyPane {...props} />)
  const box = view.getByRole('textbox')
  fireEvent.change(box, { target: { value: '再起動しても残す' } })
  view.rerender(<SwarmSupplyPane {...props} status="exited" />)
  expect(box).toBeInTheDocument()
  expect(box).toHaveValue('再起動しても残す')
  expect(box).toBeDisabled()
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(posts).toHaveLength(0)
  fireEvent.click(view.getByRole('button', { name: 'projectPanel.swarm.restart' }))
  expect(props.onRestart).toHaveBeenCalledOnce()
  view.rerender(<SwarmSupplyPane {...props} sdkSessionId="sdk-new" status="starting" />)
  expect(box).toBeDisabled()
  expect(box).toHaveValue('再起動しても残す')
  view.rerender(<SwarmSupplyPane {...props} sdkSessionId="sdk-new" status="waiting" />)
  expect(box).toBeEnabled()
  expect(box).toHaveValue('再起動しても残す')
  fireEvent.keyDown(box, { key: 'Enter' })
  await waitFor(() => expect(posts).toEqual([{ url: '/api/sdk-session/sdk-new/input?path=%2Fp%20one', text: '再起動しても残す' }]))
  await waitFor(() => expect(box).toHaveValue(''))
  expect(box).toBeInTheDocument()
})

it('hides the extra composer on PTY and restores its parent-owned SDK draft without sending it', async () => {
  const posts: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(init.body as string) })
    return Promise.resolve(new Response(JSON.stringify(init?.method === 'POST' ? { queued: true, delivered: false } : { entries: [] })))
  })
  const props = { projectPath: '/p one', status: 'waiting' as const,
    busy: false, onExit: vi.fn(), onStop: vi.fn(), onRestart: vi.fn() }
  const Harness = ({ runtime, terminalId = '', sdkSessionId, busy = false }: { runtime: 'pty' | 'sdk'; terminalId?: string; sdkSessionId?: string; busy?: boolean }) => {
    const [value, onChange] = useState('')
    const [pending, onPendingChange] = useState(false)
    return <SwarmSupplyPane {...props} runtime={runtime} terminalId={terminalId} sdkSessionId={sdkSessionId} busy={busy}
      draftState={{ value, onChange, pending, onPendingChange }} />
  }
  const view = render(<Harness runtime="sdk" sdkSessionId="sdk-old" />)
  const box = view.getByRole('textbox')
  fireEvent.change(box, { target: { value: 'どちらの接続でも残す' } })
  view.rerender(<Harness runtime="pty" terminalId="pty-new" />)
  expect(view.getByText('real terminal surface')).toBeInTheDocument()
  expect(view.queryByRole('textbox')).toBeNull()
  expect(view.queryByRole('button', { name: 'projectPanel.swarm.say.send' })).toBeNull()
  expect(posts).toHaveLength(0)
  view.rerender(<Harness runtime="sdk" sdkSessionId="sdk-new" busy />)
  const restored = view.getByRole('textbox')
  expect(restored).toHaveValue('どちらの接続でも残す')
  expect(restored).toBeDisabled()
  fireEvent.keyDown(restored, { key: 'Enter' })
  expect(posts).toHaveLength(0)
  view.rerender(<Harness runtime="sdk" sdkSessionId="sdk-new" />)
  fireEvent.keyDown(restored, { key: 'Enter' })
  await waitFor(() => expect(posts).toEqual([{ url: '/api/sdk-session/sdk-new/input?path=%2Fp%20one', body: { text: 'どちらの接続でも残す' } }]))
  await waitFor(() => expect(restored).toHaveValue(''))
})

it('keeps pending instruction cancellation available on PTY without a second input', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ entries: [] }))))
  const base = renderHook(() => useConversationDraft('project-fixture')).result.current
  const cancelReceipt = vi.fn(async () => {})
  const durable = { ...base, enabled: true, cancelReceipt, receipts: [{ id: 'queued-input', state: 'queued', text: '確認待ちの指示' }] }
  const view = render(<SwarmSupplyPane projectPath="/p one" terminalId="pty-new" runtime="pty" status="waiting" busy={false}
    onExit={vi.fn()} onStop={vi.fn()} onRestart={vi.fn()}
    draftState={{ value: '', onChange: vi.fn(), pending: false, onPendingChange: vi.fn(), durable }} />)
  expect(view.getByText('real terminal surface')).toBeInTheDocument()
  expect(view.queryByRole('textbox')).toBeNull()
  expect(view.queryByRole('button', { name: 'projectPanel.swarm.say.send' })).toBeNull()
  fireEvent.click(view.getByText('settings.assistant.queued'))
  fireEvent.click(view.getByRole('button', { name: 'settings.draft.cancelInput' }))
  await waitFor(() => expect(cancelReceipt).toHaveBeenCalledExactlyOnceWith('/p one', 'queued-input', 'settings.draft.cancelNote'))
})

it('shows durable project call notes next to the real terminal using its registered path', async () => {
  const urls: string[] = []
  vi.stubGlobal('fetch', (u: string) => { urls.push(u); return Promise.resolve(new Response(JSON.stringify({ entries: [{ id: 'call:c', at: Date.now(), seconds: 102, text: 'Call 1:42' }] }))) })
  const view = render(pane())
  await view.findByText(/Call 1:42/)
  expect(urls[0]).toBe('/api/phone-link/call-notes?path=%2Fp%20one')
  expect(view.getByText('real terminal surface')).toBeInTheDocument()
})

it('builds the line in the CURRENT language from the saved seconds, not the text saved back then', async () => {
  h.lang = 'ja'
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ entries: [{ id: 'call:c', at: Date.now(), seconds: 102, text: 'Call 1:42' }] }))))
  const view = render(pane())
  await view.findByText(/通話 1:42/)
  expect(view.queryByText(/Call 1:42/)).toBeNull()
  expect(view.getByRole('list').getAttribute('aria-label')).toBe('projectPanel.swarm.supply.calls')
})

it('dates a call from another day; today shows the time alone', () => {
  const now = new Date(2026, 9, 6, 15, 0).getTime()
  expect(callStamp(new Date(2026, 9, 6, 14, 5).getTime(), 'ja', now)).toBe('14:05')
  expect(callStamp(new Date(2026, 9, 5, 14, 5).getTime(), 'ja', now)).toBe('10/5 14:05')
})

it('clears the records on the second press only, with DELETE on the same registered path', async () => {
  const calls: { u: string; m?: string }[] = []
  vi.stubGlobal('fetch', (u: string, init?: RequestInit) => {
    calls.push({ u, m: init?.method })
    return Promise.resolve(new Response(JSON.stringify(init?.method === 'DELETE' ? { ok: true } : { entries: [{ id: 'call:c', at: Date.now(), seconds: 5, text: '' }] })))
  })
  const view = render(pane())
  await view.findByText(/Call 0:05/)
  const button = view.getByRole('button', { name: 'projectPanel.swarm.supply.clearCalls' })
  fireEvent.click(button)
  expect(calls.some((c) => c.m === 'DELETE')).toBe(false)
  fireEvent.click(view.getByRole('button', { name: 'projectPanel.swarm.supply.clearCallsConfirm' }))
  await waitFor(() => expect(view.queryByText(/Call 0:05/)).toBeNull())
  expect(calls.filter((c) => c.m === 'DELETE').map((c) => c.u)).toEqual(['/api/phone-link/call-notes?path=%2Fp%20one'])
})
