// @vitest-environment jsdom
// Keep the real module → supply reconcile → pane → composer ownership chain.
// Only network/terminal rendering are fixtures; no provider or agent is called.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ProjectMeta } from '@/lib/types'

const h = vi.hoisted(() => ({ desk: { runtime: 'pty', handleId: 'pty-old', agentSessionId: 'conversation-old' } as {
  runtime: 'pty' | 'sdk'; handleId: string; agentSessionId: string
} | null }))
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (key: string) => key, lang: 'en' }) }))
vi.mock('./useSwarmEngine', async original => {
  const real = await original<typeof import('./useSwarmEngine')>()
  return { ...real, useSwarmEngine: () => ({
    engine: { ...real.DEFAULT_ENGINE, running: true, supplyDesk: h.desk }, realWorkers: [],
    available: true, busy: false, error: null, toggleAutonomy: vi.fn(), dismissAutonomyReminder: vi.fn(),
    envIssues: [], refreshEnvPreflight: vi.fn(),
  }) }
})
vi.mock('@/components/canvas/ClaudeTerminalPane', () => ({
  ClaudeTerminalPane: ({ onExit }: { onExit: () => void }) => <button onClick={onExit}>fixture desk exit</button>,
}))

import { SwarmModule } from './SwarmModule'
import { supplyStorageKey } from './useSupplyDesk'

const project: ProjectMeta = { id: 'president-draft-a', name: 'a', path: '/fixture/a', description: '',
  lastModified: '2026-11-05T00:00:00.000Z', hasGit: true, openTaskCount: 0, totalTaskCount: 0 }
const placeholder = 'projectPanel.swarm.say.presidentPlaceholder'
const storeDesk = () => localStorage.setItem(supplyStorageKey(project.id), JSON.stringify({ terminalId: 'pty-old',
  agentSessionId: 'conversation-old', startedAt: '2026-11-05T00:00:00.000Z' }))

beforeEach(() => {
  h.desk = { runtime: 'pty', handleId: 'pty-old', agentSessionId: 'conversation-old' }
  storeDesk()
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const url = String(input)
    // Both projects' already-live desks are in the global status poll before
    // switching projects, so pending is the only possible send blocker.
    const body = url.includes('/api/terminal/active') ? { claude: ['pty-old', 'sdk-new', 'sdk-project-b'].map(id => ({ id, status: 'waiting' })) }
      : url.includes('/tail?') ? { frames: [], reaped: false }
      : { entries: [], escalations: [] }
    return Promise.resolve(new Response(JSON.stringify(body)))
  }))
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('president draft ownership above the real seat lifecycle', () => {
  it('keeps the draft when collapsing actually unmounts the seat', async () => {
    const view = render(<SwarmModule project={project} />)
    const box = await view.findByRole('textbox', { name: placeholder })
    fireEvent.change(box, { target: { value: 'keep through collapse' } })
    view.rerender(<SwarmModule project={project} collapsed />)
    expect(box).not.toBeInTheDocument()
    view.rerender(<SwarmModule project={project} />)
    expect(await view.findByRole('textbox', { name: placeholder })).toHaveValue('keep through collapse')
  })

  it('keeps the draft after exit/reconcile removes the record and a different runtime is adopted', async () => {
    const view = render(<SwarmModule project={project} />)
    const box = await view.findByRole('textbox', { name: placeholder })
    fireEvent.change(box, { target: { value: 'keep through exit' } })
    h.desk = null
    fireEvent.click(view.getByRole('button', { name: 'fixture desk exit' }))
    await waitFor(() => expect(view.queryByRole('textbox', { name: placeholder })).toBeNull())
    expect(localStorage.getItem(supplyStorageKey(project.id))).toBeNull()
    h.desk = { runtime: 'sdk', handleId: 'sdk-new', agentSessionId: 'conversation-new' }
    view.rerender(<SwarmModule project={project} />)
    expect(await view.findByRole('textbox', { name: placeholder })).toHaveValue('keep through exit')
  })

  it('never shows one project’s draft in another project', async () => {
    const view = render(<SwarmModule project={project} />)
    fireEvent.change(await view.findByRole('textbox', { name: placeholder }), { target: { value: 'only project a' } })
    h.desk = { runtime: 'sdk', handleId: 'sdk-project-b', agentSessionId: 'conversation-b' }
    view.rerender(<SwarmModule project={{ ...project, id: 'president-draft-b', path: '/fixture/b' }} />)
    expect(await view.findByRole('textbox', { name: placeholder })).toHaveValue('')
  })

  it('keeps a pending send read-only across collapse/remount and accepts another sentence only after its reply', async () => {
    const fetchFixture = globalThis.fetch
    let finish!: (response: Response) => void
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
      if (String(input) !== '/api/swarm/supply/input') return fetchFixture(input as RequestInfo, init)
      sent.push(JSON.parse(String(init?.body)).text)
      return sent.length === 1 ? new Promise<Response>(resolve => { finish = resolve })
        : Promise.resolve(new Response(JSON.stringify({ queued: true, delivered: false })))
    }))
    const view = render(<SwarmModule project={project} />)
    const box = await view.findByRole('textbox', { name: placeholder })
    fireEvent.change(box, { target: { value: 'the accepted sentence' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box).toHaveAttribute('readonly')
    view.rerender(<SwarmModule project={project} collapsed />)
    view.rerender(<SwarmModule project={project} />)
    const remounted = await view.findByRole('textbox', { name: placeholder })
    expect(remounted).toHaveAttribute('readonly')
    expect(view.getByRole('button', { name: 'projectPanel.swarm.say.send' })).toBeDisabled()
    fireEvent.keyDown(remounted, { key: 'Enter' })
    expect(sent).toEqual(['the accepted sentence'])
    await act(async () => { finish(new Response(JSON.stringify({ queued: true, delivered: false }))) })
    expect(remounted).not.toHaveAttribute('readonly')
    expect(remounted).toHaveValue('')
    fireEvent.change(remounted, { target: { value: 'the next sentence' } })
    fireEvent.keyDown(remounted, { key: 'Enter' })
    await waitFor(() => expect(sent).toEqual(['the accepted sentence', 'the next sentence']))
  })

  it('does not block another project while the first project’s send is pending', async () => {
    const fetchFixture = globalThis.fetch
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => String(input) === '/api/swarm/supply/input'
      ? new Promise<Response>(resolve => { finish = resolve })
      : fetchFixture(input as RequestInfo, init)))
    const view = render(<SwarmModule project={project} />)
    const first = await view.findByRole('textbox', { name: placeholder })
    fireEvent.change(first, { target: { value: 'project a waits' } })
    fireEvent.keyDown(first, { key: 'Enter' })
    h.desk = { runtime: 'sdk', handleId: 'sdk-project-b', agentSessionId: 'conversation-b' }
    view.rerender(<SwarmModule project={{ ...project, id: 'president-draft-b', path: '/fixture/b' }} />)
    const other = await view.findByRole('textbox', { name: placeholder })
    expect(other).not.toHaveAttribute('readonly')
    fireEvent.change(other, { target: { value: 'project b stays editable' } })
    expect(view.getByRole('button', { name: 'projectPanel.swarm.say.send' })).toBeEnabled()
    await act(async () => { finish(new Response(JSON.stringify({ queued: true, delivered: false }))) })
    expect(other).toHaveValue('project b stays editable')
  })
})
