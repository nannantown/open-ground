// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))

import { CollabSharedDialog } from './CollabSharedDialog'

// Route the fetch mock by url + method. /api/collab/projects returns owner +
// member rows; /api/collab/join echoes a joined id.
const stub = (joinResult: unknown = { ok: true, collabProjectId: 'b' }) => {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/collab/projects'))
      return new Response(
        JSON.stringify({
          projects: [
            { id: 'a', label: 'Alpha', owned: false }, // shared with me
            { id: 'b', label: 'Beta', owned: false }, // shared with me
            { id: 'c', label: 'Mine', owned: true }, // owned → excluded
          ],
        }),
        { status: 200 },
      )
    if (url.includes('/api/collab/join') && init?.method === 'POST')
      return new Response(JSON.stringify(joinResult), { status: 200 })
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', spy as unknown as typeof fetch)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('CollabSharedDialog (member: join + open)', () => {
  it('lists only the projects shared with me (owned:false), not owned ones', async () => {
    stub()
    render(<CollabSharedDialog onOpen={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.queryByText('Mine')).toBeNull() // owned → not a shared card
  })

  it('clicking a shared project opens it (onOpen with id + label)', async () => {
    stub()
    const onOpen = vi.fn()
    render(<CollabSharedDialog onOpen={onOpen} onClose={() => {}} />)
    fireEvent.click(await screen.findByText('Alpha'))
    expect(onOpen).toHaveBeenCalledWith('a', 'Alpha')
  })

  it('joining with a valid code redeems it then opens the joined project', async () => {
    const spy = stub({ ok: true, collabProjectId: 'b' })
    const onOpen = vi.fn()
    render(<CollabSharedDialog onOpen={onOpen} onClose={() => {}} />)
    await screen.findByText('Alpha') // initial load done

    fireEvent.change(screen.getByPlaceholderText('projectPanel.collabSharedDialogJoinPlaceholder'), {
      target: { value: '  my-code  ' },
    })
    fireEvent.click(screen.getByText('projectPanel.collabSharedDialogJoin'))

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('b', 'Beta'))
    // The join POST carried the trimmed code.
    const joinCall = spy.mock.calls.find(
      ([u, i]) => String(u).includes('/api/collab/join') && (i as RequestInit)?.method === 'POST',
    )
    expect(JSON.parse((joinCall![1] as RequestInit).body as string)).toEqual({ code: 'my-code' })
  })

  it('a failed join shows an inline error and does not open anything', async () => {
    stub({ ok: false, error: 'invalid or expired invite' })
    const onOpen = vi.fn()
    render(<CollabSharedDialog onOpen={onOpen} onClose={() => {}} />)
    await screen.findByText('Alpha')

    fireEvent.change(screen.getByPlaceholderText('projectPanel.collabSharedDialogJoinPlaceholder'), {
      target: { value: 'bad' },
    })
    fireEvent.click(screen.getByText('projectPanel.collabSharedDialogJoin'))

    expect(await screen.findByText('projectPanel.collabSharedDialogJoinFailed')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('a pending join (approval mode) shows "awaiting approval", not onOpen', async () => {
    stub({ ok: true, collabProjectId: 'b', status: 'pending' })
    const onOpen = vi.fn()
    render(<CollabSharedDialog onOpen={onOpen} onClose={() => {}} />)
    await screen.findByText('Alpha')

    fireEvent.change(
      screen.getByPlaceholderText('projectPanel.collabSharedDialogJoinPlaceholder'),
      { target: { value: 'approval-code' } },
    )
    fireEvent.click(screen.getByText('projectPanel.collabSharedDialogJoin'))

    expect(await screen.findByText('projectPanel.collabSharedDialogAwaiting')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('auto-redeems an initialCode (deep link) on mount and opens the joined project', async () => {
    const spy = stub({ ok: true, collabProjectId: 'b' })
    const onOpen = vi.fn()
    render(<CollabSharedDialog initialCode="deep-code" onOpen={onOpen} onClose={() => {}} />)

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('b', 'Beta'))
    const joinCall = spy.mock.calls.find(
      ([u, i]) => String(u).includes('/api/collab/join') && (i as RequestInit)?.method === 'POST',
    )
    expect(JSON.parse((joinCall![1] as RequestInit).body as string)).toEqual({ code: 'deep-code' })
  })

  it('an initialCode for an approval link auto-redeems then awaits approval', async () => {
    stub({ ok: true, collabProjectId: 'b', status: 'pending' })
    const onOpen = vi.fn()
    render(<CollabSharedDialog initialCode="approval-code" onOpen={onOpen} onClose={() => {}} />)

    expect(await screen.findByText('projectPanel.collabSharedDialogAwaiting')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })
})
