// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatGptSetting } from './ChatGptSetting'
import type { ChatGptStatus } from '@/lib/types'
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (key: string) => key }) }))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let status: ChatGptStatus
let allowed: boolean
let rejectSave: boolean
let posted: Record<string, unknown>[]
let authorizationUrl: string

beforeEach(() => {
  status = { connection: { state: 'connected', email: 'owner@example.test', models: [{ id: 'from-authorized-catalog', name: 'Catalog model', supportedEfforts: ['high'] }] }, lockdown: false, preferences: { assistantProvider: 'claude', swarmProvider: 'claude' } }
  allowed = true; rejectSave = false; posted = []
  authorizationUrl = 'https://auth.openai.com/api/accounts/authorize?state=opaque'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/status')) return allowed ? json(status) : json({ error: 'forbidden' }, 403)
    if (path.endsWith('/preferences')) {
      const patch = JSON.parse(String(init?.body)) as Record<string, unknown>
      posted.push(patch)
      if (rejectSave) return json({ error: 'refused' }, 400)
      Object.assign(status.preferences, Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? undefined])))
      return json({ preferences: status.preferences })
    }
    if (path.endsWith('/login')) { status.connection.state = 'connecting'; return json({ authorizationUrl, loginId: 'login-1' }) }
    if (path.endsWith('/cancel')) { status.connection.state = 'signed-out'; return json({ ok: true }) }
    return json({ ok: true })
  }))
  Object.defineProperty(window, 'openground', { value: { openExternal: vi.fn(async () => true) }, configurable: true })
})

describe('owner ChatGPT controls', () => {
  it('hides the feature when the server denies owner access', async () => {
    allowed = false
    render(<ChatGptSetting enabled lockdown={false} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'ChatGPT' })).toBeNull()
  })
  it('uses the returned catalog and saves independent runtime picks; refusal restores the selection', async () => {
    render(<ChatGptSetting enabled lockdown={false} />)
    const region = await screen.findByRole('region', { name: 'ChatGPT' })
    expect(within(region).getByRole('option', { name: 'Catalog model' })).toBeTruthy()
    expect(within(region).queryByRole('option', { name: 'GPT-5' })).toBeNull()
    const assistant = within(region).getByRole('group', { name: 'settings.chatgpt.assistant' })
    fireEvent.click(within(assistant).getByRole('button', { name: 'ChatGPT' }))
    await waitFor(() => expect(posted).toEqual([{ assistantProvider: 'chatgpt' }]))
    await waitFor(() => expect(within(assistant).getByRole('button', { name: 'ChatGPT' })).not.toBeDisabled())
    expect(within(assistant).getByRole('button', { name: 'ChatGPT' })).toHaveAttribute('aria-pressed', 'true')
    const automatic = within(region).getByRole('group', { name: 'settings.chatgpt.automation' })
    expect(within(automatic).getByRole('button', { name: 'Claude' })).toHaveAttribute('aria-pressed', 'true')
    rejectSave = true
    fireEvent.click(within(assistant).getByRole('button', { name: 'Claude' }))
    await screen.findByRole('alert')
    expect(within(assistant).getByRole('button', { name: 'ChatGPT' })).toHaveAttribute('aria-pressed', 'true')
    expect(status.preferences.assistantProvider).toBe('chatgpt')
  })
  it('resetting the model sends an explicit null and preserves Claude settings', async () => {
    status.preferences.chatgptModel = 'from-authorized-catalog'
    render(<ChatGptSetting enabled lockdown={false} />)
    const model = await screen.findByRole('combobox', { name: 'settings.chatgpt.model' })
    fireEvent.change(model, { target: { value: '' } })
    await waitFor(() => expect(posted).toEqual([{ chatgptModel: null }]))
    await waitFor(() => expect(model).toHaveValue(''))
  })
  it('work mode disables ChatGPT sign-in and use, while keeping Claude selectable', async () => {
    status.lockdown = true
    status.connection = { state: 'error', models: [], error: 'work-mode' }
    render(<ChatGptSetting enabled lockdown />)
    expect(await screen.findByRole('button', { name: 'settings.chatgpt.connect' })).toBeDisabled()
    for (const button of screen.getAllByRole('button', { name: 'ChatGPT' })) expect(button).toBeDisabled()
    expect(screen.getByText('settings.chatgpt.workMode')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('opens only an official sign-in URL, and retains a deliberate browser link', async () => {
    status.connection = { state: 'signed-out', models: [] }
    render(<ChatGptSetting enabled lockdown={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.chatgpt.connect' }))
    const link = await screen.findByRole('link', { name: 'settings.chatgpt.openBrowser' })
    expect(link).toHaveAttribute('href', authorizationUrl)
    expect((window as unknown as { openground: { openExternal: ReturnType<typeof vi.fn> } }).openground.openExternal).toHaveBeenCalledWith(authorizationUrl)
  })
  it('rejects a foreign authorize URL without opening a browser', async () => {
    status.connection = { state: 'signed-out', models: [] }
    authorizationUrl = 'https://foreign.example/authorize'
    render(<ChatGptSetting enabled lockdown={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.chatgpt.connect' }))
    await screen.findByRole('alert')
    expect((window as unknown as { openground: { openExternal: ReturnType<typeof vi.fn> } }).openground.openExternal).not.toHaveBeenCalled()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
