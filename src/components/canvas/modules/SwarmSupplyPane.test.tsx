// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SwarmSupplyPane } from './SwarmSupplyPane'
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k, lang: 'en' }) }))
vi.mock('@/components/canvas/ClaudeTerminalPane', () => ({ ClaudeTerminalPane: () => <div>real terminal surface</div> }))
vi.mock('./SwarmSeatHeader', () => ({ SwarmSeatHeader: () => <div>president</div> }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('shows durable project call notes next to the real terminal using its registered path', async () => {
  const urls: string[] = []
  vi.stubGlobal('fetch', (u: string) => { urls.push(u); return Promise.resolve(new Response(JSON.stringify({ entries: [{ id: 'call:c', at: Date.now(), text: 'Call 1:42' }] }))) })
  const view = render(<SwarmSupplyPane projectPath="/p one" terminalId="t1" status="waiting" busy={false} onExit={() => {}} onStop={() => {}} onRestart={() => {}} />)
  await view.findByText(/Call 1:42/)
  expect(urls[0]).toBe('/api/phone-link/call-notes?path=%2Fp%20one')
  expect(view.getByText('real terminal surface')).toBeInTheDocument()
})
