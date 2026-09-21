// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData, ProjectMeta } from '@/lib/types'
import { ProjectPanel } from './ProjectPanel'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k, lang: 'en' }) }))
vi.mock('@/lib/useClaudeConnection', () => ({ useClaudeConnection: () => ({ installed: true, loggedIn: true }) }))
vi.mock('@/components/canvas/modules/BoardModule', () => ({ BoardModule: () => <div>Loaded board</div> }))
const h = vi.hoisted(() => ({ get: vi.fn(), describe: vi.fn() }))
vi.mock('@/lib/api-client', () => {
  const deep = (path: string[]): unknown => new Proxy(() => {}, {
    get: (_t, p) => p === 'then' ? undefined : deep([...path, String(p)]),
    apply: () => path.join('.') === 'project.$get' ? h.get()
      : path.join('.') === 'project.describe.$post' ? h.describe()
      : Promise.resolve(new Response('{}')),
  })
  return { api: { api: deep([]) } }
})

const initial: ProjectData = { description: '', tasks: [], notes: '', updatedAt: '2026-09-21T00:00:00.000Z' }
const generated: ProjectData = { ...initial, description: 'Generated project summary', descriptionEn: 'Generated project summary', updatedAt: '2026-09-21T00:00:01.000Z' }
const project: ProjectMeta = { id: 'desc', path: '/tmp/desc', name: 'Description fixture', description: '', lastModified: '', hasGit: false, openTaskCount: 0, totalTaskCount: 0 }
const response = (d: unknown) => new Response(JSON.stringify(d))

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  h.get.mockReset().mockImplementation(async () => response(initial))
  h.describe.mockReset().mockResolvedValue(response({ jobId: 'job' }))
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/describe/active')) return response({ jobs: [] })
    if (url.includes('/describe/job/job')) return response({ status: 'done' })
    return response({})
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('description response ordering', () => {
  it('does not erase a newly generated description when an older board poll finishes late', async () => {
    await act(async () => { render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />) })
    let finishOld!: (r: Response) => void
    h.get.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(finishOld).toBeTypeOf('function')
    h.get.mockImplementation(async () => response(generated))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'projectPanel.generateDescription' })) })
    expect(screen.getByText(generated.description)).toBeTruthy()
    await act(async () => { finishOld(response(initial)) })
    expect(screen.getByText(generated.description)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'projectPanel.generateDescription' })).toBeNull()
  })

  it('ignores a delayed job refresh when the normal poll already adopted a newer description', async () => {
    await act(async () => { render(<ProjectPanel project={project} onClose={() => {}} onRemove={() => {}} frameLabel={null} />) })
    let finishJobRead!: (r: Response) => void
    h.get.mockImplementationOnce(() => new Promise<Response>(resolve => { finishJobRead = resolve }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'projectPanel.generateDescription' })) })
    expect(finishJobRead).toBeTypeOf('function')
    h.get.mockImplementation(async () => response(generated))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText(generated.description)).toBeTruthy()
    await act(async () => { finishJobRead(response(initial)) })
    expect(screen.getByText(generated.description)).toBeTruthy()
  })
})
