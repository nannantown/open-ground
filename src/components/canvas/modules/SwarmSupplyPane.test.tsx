// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SwarmSupplyPane, callStamp } from './SwarmSupplyPane'
// t: the real substitution shape, keyed by the current language.
const h = vi.hoisted(() => ({ lang: 'en' }))
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ lang: h.lang, t: (k: string, v?: Record<string, string>) => (k === 'projectPanel.swarm.supply.call' ? `${h.lang === 'ja' ? '通話' : 'Call'} ${v?.duration}` : k) }),
}))
vi.mock('@/components/canvas/ClaudeTerminalPane', () => ({ ClaudeTerminalPane: () => <div>real terminal surface</div> }))
vi.mock('./SwarmSeatHeader', () => ({ SwarmSeatHeader: () => <div>president</div> }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); h.lang = 'en' })
const pane = () => <SwarmSupplyPane projectPath="/p one" terminalId="t1" status="waiting" busy={false} onExit={() => {}} onStop={() => {}} onRestart={() => {}} />

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
