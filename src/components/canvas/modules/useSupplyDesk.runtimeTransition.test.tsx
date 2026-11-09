// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationDraftOwnerContext, resetConversationDraftControllersForTests } from '@/lib/useConversationDraft'
import type { ProjectMeta, RuntimeTransitionStatus } from '@/lib/types'
const h = vi.hoisted(() => ({ desk: null as { runtime: 'sdk' | 'pty'; handleId: string; agentSessionId: string } | null }))
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (key: string) => key, lang: 'en' }) }))
vi.mock('./useSwarmEngine', async original => {
  const real = await original<typeof import('./useSwarmEngine')>()
  return { ...real, useSwarmEngine: () => ({ engine: real.sanitizeEngineState({ ...real.DEFAULT_ENGINE, running: true, supplyDesk: h.desk }), realWorkers: [], available: true, busy: false, error: null,
    toggleAutonomy: vi.fn(), dismissAutonomyReminder: vi.fn(), envIssues: [], refreshEnvPreflight: vi.fn() }) }
})
vi.mock('@/components/canvas/ClaudeTerminalPane', () => ({ ClaudeTerminalPane: () => <div>fixture native president</div> }))
import { useSupplyDesk, supplyStorageKey } from './useSupplyDesk'
import { SwarmModule } from './SwarmModule'
const project: ProjectMeta = { id: 'switch-project', name: 'Switch fixture', path: '/fixture/switch', description: '', lastModified: '2026-11-09T00:00:00Z', hasGit: true, openTaskCount: 0, totalTaskCount: 0 }
const owner = ({ children }: { children: ReactNode }) => <ConversationDraftOwnerContext.Provider value="fixture-owner">{children}</ConversationDraftOwnerContext.Provider>
let phase: RuntimeTransitionStatus['phase'], mutations: { url: string; body?: unknown }[]
const runtime = (): RuntimeTransitionStatus => ({ scope: 'swarm', revision: 3, phase, effective: { provider: 'chatgpt' }, desired: { provider: 'claude' }, updatedAt: '2026-11-09T00:00:00Z', ...(phase === 'attention' ? { error: 'Sign in to the Claude subscription before retrying.' } : {}) })
beforeEach(() => {
  localStorage.clear(); phase = 'attention'; h.desk = null; mutations = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' || init?.method === 'DELETE') mutations.push({ url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (url.startsWith('/api/conversation/president/status?')) return new Response(JSON.stringify({ state: 'delivered', conversationId: 'fixture-conversation', epoch: 1, capabilities: { conversationControl: 1 }, runtime: runtime() }))
    if (url === '/api/chatgpt/transition') {
      expect((init?.headers as Record<string, string>)['X-OpenGround-Owner']).toBe('fixture-owner')
      phase = 'stable'; h.desk = { runtime: 'sdk', handleId: 'sdk-replacement', agentSessionId: 'chatgpt-replacement' }
      return new Response(JSON.stringify({ runtime: { swarm: runtime() } }), { status: 202 })
    }
    if (url === '/api/swarm/supply/open') return new Response(JSON.stringify({ terminalId: 'native-opened', agentSessionId: 'native-conversation' }))
    if (url.startsWith('/api/conversation/draft?')) return new Response(JSON.stringify({ revision: 0, text: '', updatedAt: '2026-11-09T00:00:00Z' }))
    if (url === '/api/terminal/active') return new Response(JSON.stringify({ claude: [{ id: 'sdk-replacement', status: 'waiting' }] }))
    if (url.includes('/tail?')) return new Response(JSON.stringify({ frames: [], reaped: false }))
    return new Response(JSON.stringify({ entries: [], escalations: [] }))
  }))
})
afterEach(() => { cleanup(); resetConversationDraftControllersForTests(); localStorage.clear(); vi.unstubAllGlobals() })
it.each(['draining', 'attention'] as const)('refuses open and restart before deleting any old handle during %s', async state => {
  phase = state
  localStorage.setItem(supplyStorageKey(project.id), JSON.stringify({ terminalId: '', runtime: 'sdk', sdkSessionId: 'sdk-old', agentSessionId: 'chatgpt-old', startedAt: '2026-11-09T00:00:00Z' }))
  const view = renderHook(() => useSupplyDesk({ projectId: project.id, projectPath: project.path, supplyDesk: undefined, exitedIds: new Set(), forgetPty: vi.fn(), enabled: true }), { wrapper: owner })
  await act(async () => { await view.result.current.restart() })
  expect(mutations).toEqual([])
  view.unmount(); localStorage.removeItem(supplyStorageKey(project.id))
  const empty = renderHook(() => useSupplyDesk({ projectId: project.id, projectPath: project.path, supplyDesk: undefined, exitedIds: new Set(), forgetPty: vi.fn(), enabled: true }), { wrapper: owner })
  await act(async () => { await empty.result.current.launch() })
  expect(mutations).toEqual([])
})
it.each(['retry', 'cancel'] as const)('exposes revision-bound %s beside the closed president and adopts the replacement without a spawn', async action => {
  const view = render(<SwarmModule project={project} ownerFeatures />, { wrapper: owner })
  const control = await view.findByRole('button', { name: `settings.runtime.${action}` })
  expect(view.getByText('Sign in to the Claude subscription before retrying.')).toBeVisible()
  expect(view.getByRole('button', { name: 'projectPanel.swarm.supply.launch' })).toBeDisabled()
  fireEvent.click(control)
  await waitFor(() => expect(mutations).toEqual([{ url: '/api/chatgpt/transition', body: { action, scope: 'swarm', revision: 3 } }]))
  expect(await view.findByRole('textbox', { name: 'projectPanel.swarm.say.presidentPlaceholder' })).toBeVisible()
  expect(localStorage.getItem(supplyStorageKey(project.id))).toContain('sdk-replacement')
})
it('preserves a public legacy president launch without reading private owner status', async () => {
  const view = renderHook(() => useSupplyDesk({ projectId: project.id, projectPath: project.path, supplyDesk: undefined, exitedIds: new Set(), forgetPty: vi.fn(), enabled: true }))
  await act(async () => { await view.result.current.launch() })
  expect(mutations).toEqual([{ url: '/api/swarm/supply/open', body: { path: project.path } }])
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/conversation/president/status'))).toBe(false)
})
