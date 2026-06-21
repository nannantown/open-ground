// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
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
beforeEach(() => {
  localStorage.clear()
  // Most specs exercise the post-consent join UI; seed member consent so the
  // privacy gate is skipped. The dedicated consent-gate spec clears this first.
  localStorage.setItem('og-collab-consent-member-v1', 'accepted')
})

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

  it('does NOT auto-join an initialCode (deep link) on mount — prefills and waits for a click', async () => {
    const spy = stub({ ok: true, collabProjectId: 'b' })
    const onOpen = vi.fn()
    render(<CollabSharedDialog initialCode="deep-code" onOpen={onOpen} onClose={() => {}} />)
    await screen.findByText('Alpha') // initial projects load settled

    // The code is prefilled and a confirmation prompt is shown…
    const field = screen.getByPlaceholderText(
      'projectPanel.collabSharedDialogJoinPlaceholder',
    ) as HTMLInputElement
    expect(field.value).toBe('deep-code')
    // …but nothing was joined automatically: no onOpen, no join POST.
    expect(onOpen).not.toHaveBeenCalled()
    const joinPost = spy.mock.calls.find(
      ([u, i]) => String(u).includes('/api/collab/join') && (i as RequestInit)?.method === 'POST',
    )
    expect(joinPost).toBeUndefined()
  })

  it('joins a deep-link code only after an explicit click', async () => {
    const spy = stub({ ok: true, collabProjectId: 'b' })
    const onOpen = vi.fn()
    render(<CollabSharedDialog initialCode="deep-code" onOpen={onOpen} onClose={() => {}} />)
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByText('projectPanel.collabSharedDialogJoin'))

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('b', 'Beta'))
    const joinCall = spy.mock.calls.find(
      ([u, i]) => String(u).includes('/api/collab/join') && (i as RequestInit)?.method === 'POST',
    )
    expect(JSON.parse((joinCall![1] as RequestInit).body as string)).toEqual({ code: 'deep-code' })
  })

  it('shows the privacy consent inline; the join stays gated until the box is ticked', async () => {
    localStorage.clear() // no prior consent → the inline consent notice shows
    stub()
    // A deep-link code prefills the field so the Join button toggles purely on consent.
    render(<CollabSharedDialog initialCode="deep-code" onOpen={() => {}} onClose={() => {}} />)

    // The join field is visible from the first paint (no separate gate), but Join
    // is disabled and the "I agree" box is unticked…
    const joinBtn = (
      await screen.findByText('projectPanel.collabSharedDialogJoin')
    ).closest('button')!
    expect(joinBtn.disabled).toBe(true)
    const agree = screen.getByRole('checkbox', { name: /privacy policy/i })
    // …and the disclosure names destinations by ROLE (no vendor brands) + links the policy.
    expect(screen.getByText(/login service/i)).toBeTruthy()
    expect(screen.getByText(/sync server/i)).toBeTruthy()
    expect(screen.getByText(/privacy policy/i)).toBeTruthy()
    expect(screen.queryByText(/Supabase/)).toBeNull()
    expect(screen.queryByText(/Cloudflare/)).toBeNull()

    // Ticking the box records consent and enables Join.
    fireEvent.click(agree)
    await waitFor(() =>
      expect(
        screen.getByText('projectPanel.collabSharedDialogJoin').closest('button')!.disabled,
      ).toBe(false),
    )
  })

  it('does NOT join before consent — the write is gated on the "I agree" tick', async () => {
    localStorage.clear() // no prior consent
    const spy = stub({ ok: true, collabProjectId: 'b' })
    const onOpen = vi.fn()
    render(<CollabSharedDialog initialCode="deep-code" onOpen={onOpen} onClose={() => {}} />)
    await screen.findByRole('checkbox', { name: /privacy policy/i })

    const joinPostFired = () =>
      spy.mock.calls.some(
        ([u, i]) =>
          String(u).includes('/api/collab/join') && (i as RequestInit)?.method === 'POST',
      )

    // Join is disabled pre-consent AND the join() guard refuses to write — so even
    // a click lands no POST /api/collab/join and opens nothing.
    fireEvent.click(screen.getByText('projectPanel.collabSharedDialogJoin'))
    expect(joinPostFired()).toBe(false)
    expect(onOpen).not.toHaveBeenCalled()

    // After ticking consent, the same join writes + opens the joined project.
    fireEvent.click(screen.getByRole('checkbox', { name: /privacy policy/i }))
    fireEvent.click(screen.getByText('projectPanel.collabSharedDialogJoin'))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('b', 'Beta'))
    expect(joinPostFired()).toBe(true)
  })
})
