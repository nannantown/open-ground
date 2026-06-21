// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ProjectMember } from '@/lib/types'

// Identity translator (every t(key) renders its key, so we assert on keys) and
// a routed fetch mock. The dialog imports FIELD_INPUT_CSS from ProjectConfigFields,
// which transitively imports the i18n hook — mocking it here covers both.
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, p?: Record<string, string>) => (p?.name ? `${k}:${p.name}` : k),
    lang: 'en',
    setLang: () => {},
  }),
}))

import { CollabInviteDialog } from './CollabInviteDialog'

const PID = 'pid-123'

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
const stubFetch = (handler: Handler) => {
  const spy = vi.fn(async (url: string, init?: RequestInit) => handler(url, init))
  vi.stubGlobal('fetch', spy as unknown as typeof fetch)
  return spy
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

afterEach(() => {
  vi.unstubAllGlobals()
})
beforeEach(() => {
  localStorage.clear()
  // Most specs exercise the post-consent invite UI; seed owner consent so the
  // privacy gate is skipped. The dedicated consent-gate spec clears this first.
  localStorage.setItem('og-collab-consent-owner-v1', 'accepted')
})

describe('CollabInviteDialog (owner invite UI)', () => {
  it('shows a consent step before the first invite; reveals the invite UI only after agreeing', async () => {
    localStorage.clear() // no prior consent → the privacy gate shows
    stubFetch((url) =>
      url.includes('/api/collab/project')
        ? json({ collabProjectId: PID, member: true, label: 'X' })
        : json({}),
    )
    render(<CollabInviteDialog projectName="My Repo" projectPath="/p" onClose={() => {}} />)

    // The consent gate is shown; the mint action is NOT reachable yet…
    expect(await screen.findByText('Agree & continue')).toBeTruthy()
    expect(screen.queryByText('projectPanel.collabCreateLink')).toBeNull()
    // …and it names the cloud destinations and links the privacy policy.
    expect(screen.getByText(/Supabase/)).toBeTruthy()
    expect(screen.getByText(/Cloudflare/)).toBeTruthy()
    expect(screen.getByText(/privacy policy/i)).toBeTruthy()

    // Agreeing reveals the invite UI.
    fireEvent.click(screen.getByText('Agree & continue'))
    expect(await screen.findByText('projectPanel.collabCreateLink')).toBeTruthy()
  })

  it('does NOT touch the collab server before consent (no pre-agreement writes)', async () => {
    localStorage.clear() // no prior consent → the gate shows, nothing should fetch
    const spy = stubFetch((url) =>
      url.includes('/api/collab/project')
        ? json({ collabProjectId: PID, member: true, label: 'X' })
        : json({}),
    )
    render(<CollabInviteDialog projectName="My Repo" projectPath="/p" onClose={() => {}} />)

    // The consent gate is up and NOT a single collab call has fired — the project
    // GET would create the og_projects row + owner membership in Supabase, so it
    // must wait for consent.
    await screen.findByText('Agree & continue')
    expect(spy).not.toHaveBeenCalled()

    // Agreeing releases the gated fetches.
    fireEvent.click(screen.getByText('Agree & continue'))
    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).includes('/api/collab/project'))).toBe(true),
    )
  })

  it('prefills the shared name from the owner’s saved label', async () => {
    stubFetch((url) =>
      url.includes('/api/collab/project')
        ? json({ collabProjectId: PID, member: true, label: 'Design System' })
        : json({}),
    )
    render(<CollabInviteDialog projectName="My Repo" projectPath="/p" onClose={() => {}} />)
    // The saved label wins over the local project name as the prefill.
    expect(await screen.findByDisplayValue('Design System')).toBeTruthy()
  })

  it('falls back to the project name when no label is set', async () => {
    stubFetch((url) =>
      url.includes('/api/collab/project')
        ? json({ collabProjectId: PID, member: true })
        : json({}),
    )
    render(<CollabInviteDialog projectName="My Repo" projectPath="/p" onClose={() => {}} />)
    expect(await screen.findByDisplayValue('My Repo')).toBeTruthy()
  })

  it('saves a changed name, mints a code, and shows it', async () => {
    const seen: string[] = []
    stubFetch((url) => {
      seen.push(url)
      if (url.includes('/api/collab/project')) return json({ collabProjectId: PID, member: true }) // no label
      if (url.includes('/api/collab/label')) return json({ ok: true, label: 'My Repo' })
      if (url.includes('/api/collab/invite-link')) return json({ ok: true, code: 'SECRET-CODE', expiresAt: 1 })
      return json({})
    })
    render(<CollabInviteDialog projectName="My Repo" projectPath="/p" onClose={() => {}} />)
    await screen.findByDisplayValue('My Repo') // prefilled (label was empty → name)

    fireEvent.click(screen.getByText('projectPanel.collabCreateLink'))

    // The minted code is shown…
    expect(await screen.findByText('SECRET-CODE')).toBeTruthy()
    // …and because the prefilled name (project name) differs from the empty saved
    // label, the label was persisted before the mint.
    expect(seen.some((u) => u.includes('/api/collab/label'))).toBe(true)
    expect(seen.some((u) => u.includes('/api/collab/invite-link'))).toBe(true)
  })

  it('does NOT re-save the name when it is unchanged, then mints', async () => {
    const seen: string[] = []
    stubFetch((url) => {
      seen.push(url)
      if (url.includes('/api/collab/project')) return json({ collabProjectId: PID, member: true, label: 'Kept' })
      if (url.includes('/api/collab/invite-link')) return json({ ok: true, code: 'CODE2', expiresAt: 1 })
      return json({})
    })
    render(<CollabInviteDialog projectName="My Repo" projectPath="/p" onClose={() => {}} />)
    await screen.findByDisplayValue('Kept')

    fireEvent.click(screen.getByText('projectPanel.collabCreateLink'))
    expect(await screen.findByText('CODE2')).toBeTruthy()
    // Name unchanged (== saved label) → no /label write.
    expect(seen.some((u) => u.includes('/api/collab/label'))).toBe(false)
  })

  it('copies the code to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    stubFetch((url) => {
      if (url.includes('/api/collab/project')) return json({ collabProjectId: PID, member: true, label: 'X' })
      if (url.includes('/api/collab/invite-link')) return json({ ok: true, code: 'COPY-ME', expiresAt: 1 })
      return json({})
    })
    render(<CollabInviteDialog projectName="My Repo" projectPath="/p" onClose={() => {}} />)
    await screen.findByDisplayValue('X')
    fireEvent.click(screen.getByText('projectPanel.collabCreateLink'))
    await screen.findByText('COPY-ME')

    fireEvent.click(screen.getByText('projectPanel.inviteCopy'))
    expect(writeText).toHaveBeenCalledWith('COPY-ME')
  })

  it('surfaces an inline error when the mint fails', async () => {
    stubFetch((url) => {
      if (url.includes('/api/collab/project')) return json({ collabProjectId: PID, member: true, label: 'X' })
      if (url.includes('/api/collab/invite-link')) return new Response('nope', { status: 502 })
      return json({})
    })
    render(<CollabInviteDialog projectName="My Repo" projectPath="/p" onClose={() => {}} />)
    await screen.findByDisplayValue('X')
    fireEvent.click(screen.getByText('projectPanel.collabCreateLink'))
    expect(await screen.findByText('projectPanel.collabCreateFailed')).toBeTruthy()
  })

  it('lists collaborators, invites by email, and removes a member', async () => {
    let roster: ProjectMember[] = [
      { projectId: PID, email: 'owner@e.co', role: 'owner' },
      { projectId: PID, email: 'mate@e.co', role: 'member' },
    ]
    const seen: Array<{ url: string; body?: string }> = []
    stubFetch((url, init) => {
      seen.push({ url, body: init?.body as string | undefined })
      if (url.includes('/api/collab/members')) return json({ members: roster })
      if (url.includes('/api/collab/project')) return json({ collabProjectId: PID, member: true, label: 'X' })
      if (url.includes('/api/collab/invite') && !url.includes('invite-link')) {
        roster = [...roster, { projectId: PID, email: 'new@e.co', role: 'member' }]
        return json({ ok: true, written: 1 })
      }
      if (url.includes('/api/collab/remove')) {
        roster = roster.filter((m) => m.email !== 'mate@e.co')
        return json({ ok: true })
      }
      return json({})
    })
    render(<CollabInviteDialog projectName="R" projectPath="/p" onClose={() => {}} />)
    // Roster lists the existing member + owner badge.
    expect(await screen.findByText('mate@e.co')).toBeTruthy()
    expect(screen.getByText('projectPanel.collabMemberOwner')).toBeTruthy()

    // Invite by email → POST /api/collab/invite with the email, roster refreshes.
    fireEvent.change(screen.getByPlaceholderText('projectPanel.collabInviteEmailPlaceholder'), {
      target: { value: 'new@e.co' },
    })
    fireEvent.click(screen.getByText('projectPanel.collabInviteEmailBtn'))
    expect(await screen.findByText('new@e.co')).toBeTruthy()
    const inv = seen.find(
      (s) => s.url.includes('/api/collab/invite') && !s.url.includes('invite-link'),
    )
    expect(JSON.parse(inv!.body as string)).toEqual({ path: '/p', emails: ['new@e.co'] })

    // Remove the member → it disappears from the roster.
    fireEvent.click(screen.getAllByTitle('projectPanel.collabMemberRemove')[0])
    await waitFor(() => expect(screen.queryByText('mate@e.co')).toBeNull())
  })

  it('revokes all invite links (eviction) and confirms', async () => {
    const seen: string[] = []
    stubFetch((url) => {
      seen.push(url)
      // Check the more-specific revoke path BEFORE the invite-link prefix.
      if (url.includes('/api/collab/invite-link/revoke')) return json({ ok: true })
      if (url.includes('/api/collab/project')) return json({ collabProjectId: PID, member: true, label: 'X' })
      return json({})
    })
    render(<CollabInviteDialog projectName="My Repo" projectPath="/p" onClose={() => {}} />)
    await screen.findByDisplayValue('X')
    fireEvent.click(screen.getByText('projectPanel.collabRevoke'))
    expect(await screen.findByText('projectPanel.collabRevoked')).toBeTruthy()
    expect(seen.some((u) => u.includes('/api/collab/invite-link/revoke'))).toBe(true)
  })

  it('mints an approval-mode single-use link (sends mode + maxUses)', async () => {
    let mintBody: Record<string, unknown> | null = null
    stubFetch((url, init) => {
      if (url.includes('/api/collab/invite-links')) return json({ links: [], memberCap: null })
      if (url.includes('/api/collab/join-requests')) return json({ requests: [] })
      if (url.includes('/api/collab/members')) return json({ members: [] })
      if (url.includes('/api/collab/project'))
        return json({ collabProjectId: PID, member: true, label: 'X' })
      if (url.includes('/api/collab/invite-link') && init?.method === 'POST') {
        mintBody = JSON.parse(init.body as string)
        return json({ ok: true, code: 'NEW', id: 'i1', mode: 'approval', maxUses: 1, expiresAt: 1 })
      }
      return json({})
    })
    render(<CollabInviteDialog projectName="R" projectPath="/p" onClose={() => {}} />)
    await screen.findByDisplayValue('X')
    // Pick approval mode + single-use, then mint.
    fireEvent.click(screen.getByText('projectPanel.collabModeApproval'))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByText('projectPanel.collabCreateLink'))
    expect(await screen.findByText('NEW')).toBeTruthy()
    expect(mintBody).toMatchObject({ path: '/p', mode: 'approval', maxUses: 1 })
  })

  it('lists active links with the member cap and revokes one by id', async () => {
    let revokeBody: Record<string, unknown> | null = null
    const links = [{ id: 'lk1', mode: 'open', maxUses: null, useCount: 2 }]
    stubFetch((url, init) => {
      if (url.includes('/api/collab/invite-link/revoke')) {
        revokeBody = JSON.parse(init!.body as string)
        return json({ ok: true })
      }
      if (url.includes('/api/collab/invite-links')) return json({ links, memberCap: 5 })
      if (url.includes('/api/collab/join-requests')) return json({ requests: [] })
      if (url.includes('/api/collab/members')) return json({ members: [] })
      if (url.includes('/api/collab/project'))
        return json({ collabProjectId: PID, member: true, label: 'X' })
      return json({})
    })
    render(<CollabInviteDialog projectName="R" projectPath="/p" onClose={() => {}} />)
    // The link renders its mode badge + the project cap line.
    expect(await screen.findByText('projectPanel.collabLinkModeOpen')).toBeTruthy()
    expect(screen.getByText('projectPanel.collabMemberCapCurrent')).toBeTruthy()
    // Per-link revoke posts the inviteId.
    fireEvent.click(screen.getByTitle('projectPanel.collabLinkRevoke'))
    await waitFor(() => expect(revokeBody).toMatchObject({ path: '/p', inviteId: 'lk1' }))
  })

  it('resets the link (mints fresh) and shows the new code', async () => {
    const links = [{ id: 'old', mode: 'open', maxUses: null, useCount: 0 }]
    stubFetch((url) => {
      if (url.includes('/api/collab/invite-link/reset'))
        return json({ ok: true, code: 'RESET-CODE', id: 'new', mode: 'open', maxUses: null, expiresAt: 1 })
      if (url.includes('/api/collab/invite-links')) return json({ links, memberCap: null })
      if (url.includes('/api/collab/join-requests')) return json({ requests: [] })
      if (url.includes('/api/collab/members')) return json({ members: [] })
      if (url.includes('/api/collab/project'))
        return json({ collabProjectId: PID, member: true, label: 'X' })
      return json({})
    })
    render(<CollabInviteDialog projectName="R" projectPath="/p" onClose={() => {}} />)
    fireEvent.click(await screen.findByText('projectPanel.collabResetLink'))
    expect(await screen.findByText('RESET-CODE')).toBeTruthy()
  })

  it('shows pending requests and approves one (then it disappears)', async () => {
    let requests: Array<{ id: string; email: string }> = [{ id: 'rq1', email: 'wanna@join.co' }]
    let approveBody: Record<string, unknown> | null = null
    stubFetch((url, init) => {
      if (url.includes('/api/collab/join-requests/approve')) {
        approveBody = JSON.parse(init!.body as string)
        requests = []
        return json({ ok: true })
      }
      if (url.includes('/api/collab/join-requests')) return json({ requests })
      if (url.includes('/api/collab/invite-links')) return json({ links: [], memberCap: null })
      if (url.includes('/api/collab/members')) return json({ members: [] })
      if (url.includes('/api/collab/project'))
        return json({ collabProjectId: PID, member: true, label: 'X' })
      return json({})
    })
    render(<CollabInviteDialog projectName="R" projectPath="/p" onClose={() => {}} />)
    expect(await screen.findByText('wanna@join.co')).toBeTruthy()
    fireEvent.click(screen.getByText('projectPanel.collabApprove'))
    await waitFor(() => expect(approveBody).toMatchObject({ path: '/p', requestId: 'rq1' }))
    await waitFor(() => expect(screen.queryByText('wanna@join.co')).toBeNull())
  })
})
