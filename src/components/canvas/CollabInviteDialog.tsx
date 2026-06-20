// Realtime-collab invite dialog (OWNER side). The owner names the shared project
// and mints a 7-day invite CODE with a PERMISSION MODE (open = join immediately,
// approval = the owner approves each request) and optional bounds (single-use /
// max-uses, and a project-level collaborator cap). The code rides an
// `openground://join?code=…` deep link (Track C) or is pasted into "Shared with
// me". The owner manages the live links (per-link revoke + Reset link), approves /
// denies pending requests, and manages the roster — all from here.
//
// This dialog is light: it makes plain fetch() calls only and imports nothing
// from the heavy collab transport (yjs / y-partyserver), so it does NOT
// compromise the collab-OFF bundle guarantee. It is only ever MOUNTED behind the
// `useCollab().enabled` gate (the entry button in ProjectPanel), so the default
// build never shows it.
//
// Server contract (server/routes/collab.ts):
//   GET  /api/collab/project?path=          → { collabProjectId, member, label? }
//   POST /api/collab/label {path,label}       owner sets the member-visible name
//   POST /api/collab/invite-link {path,mode,maxUses,memberCap}  mint a link
//   POST /api/collab/invite-link/reset {…}    mint fresh + revoke the rest
//   POST /api/collab/invite-link/revoke {path,inviteId?}  revoke one / all links
//   GET  /api/collab/invite-links?path=     → { links, memberCap }
//   GET  /api/collab/join-requests?path=    → { requests }
//   POST /api/collab/join-requests/approve {path,requestId}
//   POST /api/collab/join-requests/deny {path,requestId}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import { FIELD_INPUT_CSS } from './ProjectConfigFields'
import type {
  CollabInviteLinkItem,
  CollabInviteLinkResponse,
  CollabInviteLinksResponse,
  CollabInviteMode,
  CollabJoinRequestItem,
  CollabJoinRequestsResponse,
  CollabLabelResponse,
  CollabMembersResponse,
  CollabProjectResponse,
  ProjectMember,
} from '@/lib/types'

export const CollabInviteDialog = ({
  projectName,
  projectPath,
  onClose,
}: {
  projectName: string
  projectPath: string
  onClose: () => void
}) => {
  const { t } = useT()
  // The shared name — null while the project resolves so a slow fetch can't be
  // clobbered by the prefill. Prefills from the owner's saved label, else the
  // local project name as a sensible default.
  const [name, setName] = useState<string | null>(null)
  const [loadedLabel, setLoadedLabel] = useState('')
  const [unavailable, setUnavailable] = useState(false) // no collabProjectId
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [revoked, setRevoked] = useState(false)
  // Permission mode + bounds for the NEXT minted link (Figma-style picker).
  const [mode, setMode] = useState<CollabInviteMode>('open')
  const [singleUse, setSingleUse] = useState(false)
  const [memberCap, setMemberCap] = useState('') // '' = no limit
  // The owner's live links + the approval queue + the roster.
  const [links, setLinks] = useState<CollabInviteLinkItem[] | null>(null)
  const [loadedCap, setLoadedCap] = useState<number | null>(null)
  const [requests, setRequests] = useState<CollabJoinRequestItem[] | null>(null)
  const [resetting, setResetting] = useState(false)
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null)
  const [busyReqId, setBusyReqId] = useState<string | null>(null)
  // Collaborator roster + email-invite (the owner's "manage who's in" surface).
  const [members, setMembers] = useState<ProjectMember[] | null>(null) // null=loading
  const [email, setEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  // Synchronous in-flight latch: `busy`/`disabled` gate clicks, but they only
  // take effect after a re-render, so a same-tick double-click could mint two
  // codes before the disable commits. The ref closes that window immediately.
  const inFlight = useRef(false)
  // Prefill the member-cap input from the project's saved cap exactly once, so a
  // later reload doesn't fight the owner's own edits.
  const prefilledCap = useRef(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/collab/project?path=${encodeURIComponent(projectPath)}`)
      .then((r) => (r.ok ? (r.json() as Promise<CollabProjectResponse>) : null))
      .then((info) => {
        if (cancelled) return
        if (!info?.collabProjectId) {
          setUnavailable(true)
          setName('')
          return
        }
        const label = info.label ?? ''
        setLoadedLabel(label)
        setName(label || projectName)
      })
      .catch(() => {
        if (!cancelled) {
          setUnavailable(true)
          setName('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, projectName])

  const trimmed = (name ?? '').trim()
  const canCreate = !!trimmed && !busy && name !== null && !unavailable
  // The collaborator cap parsed from the input: a positive int, else null (none).
  const parsedCap = (() => {
    const raw = memberCap.trim()
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
  })()
  // The bound applied to a newly-minted link.
  const mintOpts = () => ({
    mode,
    maxUses: singleUse ? 1 : null,
    memberCap: parsedCap,
  })

  // Roster / links / requests loaders (owner-gated server-side; non-owner → empty).
  const loadMembers = useCallback(async () => {
    const res = await fetch(`/api/collab/members?path=${encodeURIComponent(projectPath)}`)
      .then((r) => (r.ok ? (r.json() as Promise<CollabMembersResponse>) : null))
      .catch(() => null)
    setMembers(res?.members ?? [])
  }, [projectPath])

  const loadLinks = useCallback(async () => {
    const res = await fetch(`/api/collab/invite-links?path=${encodeURIComponent(projectPath)}`)
      .then((r) => (r.ok ? (r.json() as Promise<CollabInviteLinksResponse>) : null))
      .catch(() => null)
    setLinks(res?.links ?? [])
    const cap = res?.memberCap ?? null
    setLoadedCap(cap)
    if (!prefilledCap.current) {
      prefilledCap.current = true
      if (cap != null) setMemberCap(String(cap))
    }
  }, [projectPath])

  const loadRequests = useCallback(async () => {
    const res = await fetch(`/api/collab/join-requests?path=${encodeURIComponent(projectPath)}`)
      .then((r) => (r.ok ? (r.json() as Promise<CollabJoinRequestsResponse>) : null))
      .catch(() => null)
    setRequests(res?.requests ?? [])
  }, [projectPath])

  useEffect(() => {
    void loadMembers()
    void loadLinks()
    void loadRequests()
  }, [loadMembers, loadLinks, loadRequests])

  const createLink = async () => {
    if (!canCreate || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      // 1) Persist the shared name FIRST if it changed (separate concern from the
      //    mint; members read this label, so a "code but no name" state is wrong).
      if (trimmed !== loadedLabel.trim()) {
        const lr = await fetch('/api/collab/label', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: projectPath, label: trimmed }),
        })
          .then((r) => (r.ok ? (r.json() as Promise<CollabLabelResponse>) : null))
          .catch(() => null)
        if (!lr?.ok) {
          setError(t('projectPanel.collabCreateFailed'))
          return
        }
        setLoadedLabel(trimmed)
      }
      // 2) Mint the 7-day code with the chosen mode + bounds.
      const ir = await fetch('/api/collab/invite-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath, ...mintOpts() }),
      })
        .then((r) => (r.ok ? (r.json() as Promise<CollabInviteLinkResponse>) : null))
        .catch(() => null)
      if (!ir?.ok || !ir.code) {
        setError(t('projectPanel.collabCreateFailed'))
        return
      }
      setCode(ir.code)
      void loadLinks()
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  const copy = async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard refused — the code stays select-all-able */
    }
  }

  // Revoke ALL outstanding invite links — the second half of eviction (after
  // removing a member, revoke the links so they can't rejoin with an old code).
  const revokeLinks = async () => {
    if (revoking) return
    setRevoking(true)
    setError(null)
    try {
      const r = await fetch('/api/collab/invite-link/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      })
        .then((res) => (res.ok ? (res.json() as Promise<{ ok: boolean }>) : null))
        .catch(() => null)
      if (!r?.ok) {
        setError(t('projectPanel.collabRevokeFailed'))
        return
      }
      setCode(null) // any code shown is now invalid
      setRevoked(true)
      await loadLinks()
    } finally {
      setRevoking(false)
    }
  }

  // Revoke ONE link by id (kill a single leaked link, keep the rest).
  const revokeOne = async (id: string) => {
    if (busyLinkId) return
    setBusyLinkId(id)
    setError(null)
    try {
      const r = await fetch('/api/collab/invite-link/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath, inviteId: id }),
      })
        .then((res) => (res.ok ? (res.json() as Promise<{ ok: boolean }>) : null))
        .catch(() => null)
      if (!r?.ok) {
        setError(t('projectPanel.collabRevokeFailed'))
        return
      }
      await loadLinks()
    } finally {
      setBusyLinkId(null)
    }
  }

  // Reset the link: mint a fresh one and revoke the rest, in one action.
  const resetLink = async () => {
    if (resetting) return
    setResetting(true)
    setError(null)
    try {
      const r = await fetch('/api/collab/invite-link/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath, ...mintOpts() }),
      })
        .then((res) => (res.ok ? (res.json() as Promise<CollabInviteLinkResponse>) : null))
        .catch(() => null)
      if (!r?.ok || !r.code) {
        setError(t('projectPanel.collabResetFailed'))
        return
      }
      setCode(r.code)
      setRevoked(false)
      await loadLinks()
    } finally {
      setResetting(false)
    }
  }

  // Approve / deny a pending request. Approve enrols the requester (so refresh the
  // roster too); deny just clears the request.
  const actOnRequest = async (id: string, action: 'approve' | 'deny') => {
    if (busyReqId) return
    setBusyReqId(id)
    setError(null)
    try {
      const r = await fetch(`/api/collab/join-requests/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath, requestId: id }),
      })
        .then((res) => (res.ok ? (res.json() as Promise<{ ok: boolean }>) : null))
        .catch(() => null)
      if (!r?.ok) {
        setError(t('projectPanel.collabRequestFailed'))
        return
      }
      await Promise.all([loadRequests(), loadMembers()])
    } finally {
      setBusyReqId(null)
    }
  }

  const inviteEmail = async () => {
    const e = email.trim().toLowerCase()
    if (!e || !e.includes('@') || inviting) return
    setInviting(true)
    setError(null)
    try {
      const r = await fetch('/api/collab/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath, emails: [e] }),
      })
        .then((res) => (res.ok ? (res.json() as Promise<{ ok: boolean }>) : null))
        .catch(() => null)
      if (!r?.ok) {
        setError(t('projectPanel.collabInviteEmailFailed'))
        return
      }
      setEmail('')
      await loadMembers()
    } finally {
      setInviting(false)
    }
  }

  const removeMember = async (memberEmail: string) => {
    setError(null)
    const r = await fetch('/api/collab/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, email: memberEmail }),
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ ok: boolean }>) : null))
      .catch(() => null)
    if (!r?.ok) {
      setError(t('projectPanel.collabMemberRemoveFailed'))
      return
    }
    await loadMembers()
  }

  // Shared classes for the small text "link" buttons in the lists.
  const textBtn =
    'shrink-0 rounded-sm px-1.5 py-1 text-[11px] text-ink-muted transition-colors hover:text-accent active:text-accent disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const iconBtn =
    'shrink-0 rounded-sm p-1 text-ink-faint transition-colors hover:text-accent active:text-accent disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

  return (
    <div data-esc-overlay className="absolute inset-0 z-20 overflow-y-auto bg-bg-card">
      <div className="grid min-h-full place-items-center">
        <div className="w-full px-6 py-10">
          <div className="mx-auto w-full max-w-[480px]">
            <p className="label-cap text-accent mb-2">{t('projectPanel.collabLabel')}</p>
            <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
              {t('projectPanel.collabTitle', { name: projectName })}
            </h3>
            <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
              {t('projectPanel.collabExplain')}
            </p>

            {/* Shared name — what collaborators see (the local path stays private).
                Locked once a code is minted so the displayed name matches it. */}
            <div className="mt-4">
              <label className="mb-1 block label-cap text-ink-muted">
                {t('projectPanel.collabSharedName')}
              </label>
              <input
                autoFocus
                value={name ?? ''}
                onChange={(e) => setName(e.target.value)}
                disabled={name === null || unavailable || !!code}
                placeholder={t('projectPanel.collabSharedName')}
                className={FIELD_INPUT_CSS}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                {t('projectPanel.collabSharedNameHint')}
              </p>
            </div>

            {/* Permission mode + bounds picker — configures the NEXT minted link.
                Hidden while a freshly-minted code is on screen. */}
            {!code && !unavailable && (
              <div className="mt-4">
                <label className="mb-1.5 block label-cap text-ink-muted">
                  {t('projectPanel.collabModeLabel')}
                </label>
                <div className="flex gap-1.5" role="radiogroup" aria-label={t('projectPanel.collabModeLabel')}>
                  {(['open', 'approval'] as const).map((m) => {
                    const selected = mode === m
                    return (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setMode(m)}
                        disabled={name === null}
                        className={`flex-1 rounded-[3px] border px-2.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${
                          selected
                            ? 'border-accent bg-accent text-bg-card'
                            : 'border-line bg-transparent text-ink-muted hover:border-accent hover:text-accent'
                        }`}
                      >
                        {t(
                          m === 'open'
                            ? 'projectPanel.collabModeOpen'
                            : 'projectPanel.collabModeApproval',
                        )}
                      </button>
                    )
                  })}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                  {t(
                    mode === 'open'
                      ? 'projectPanel.collabModeOpenHint'
                      : 'projectPanel.collabModeApprovalHint',
                  )}
                </p>

                <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-ink-muted">
                  <input
                    type="checkbox"
                    checked={singleUse}
                    onChange={(e) => setSingleUse(e.target.checked)}
                    className="h-3.5 w-3.5 cursor-pointer"
                  />
                  {t('projectPanel.collabSingleUse')}
                </label>

                <div className="mt-2 flex items-center gap-2">
                  <label htmlFor="collab-member-cap" className="text-[12px] text-ink-muted">
                    {t('projectPanel.collabMemberCapField')}
                  </label>
                  <input
                    id="collab-member-cap"
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={memberCap}
                    onChange={(e) => setMemberCap(e.target.value)}
                    placeholder={t('projectPanel.collabMemberCapPlaceholder')}
                    className={`${FIELD_INPUT_CSS} w-28`}
                  />
                </div>
              </div>
            )}

            {/* The minted code — select-all + copy. */}
            {code && (
              <div className="mt-4">
                <label className="mb-1 block label-cap text-ink-muted">
                  {t('projectPanel.collabCodeLabel')}
                </label>
                <div className="flex items-stretch gap-1.5">
                  <p className="min-w-0 flex-1 select-all break-all rounded-[3px] border border-line bg-bg px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink">
                    {code}
                  </p>
                  <button
                    type="button"
                    onClick={() => void copy()}
                    className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] border border-line px-3 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {copied ? t('projectPanel.inviteCopied') : t('projectPanel.inviteCopy')}
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
                  {t('projectPanel.collabExpires')}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                  {t('projectPanel.collabAfterNote')}
                </p>
              </div>
            )}

            {error && (
              <p className="mt-3 text-[11px] leading-relaxed text-accent">{error}</p>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              {code ? (
                <>
                  <Btn
                    variant="subtle"
                    size="md"
                    onClick={() => {
                      setCode(null)
                      setError(null)
                    }}
                  >
                    {t('projectPanel.collabNewLink')}
                  </Btn>
                  <Btn variant="primary" size="md" onClick={onClose}>
                    {t('projectPanel.inviteDone')}
                  </Btn>
                </>
              ) : (
                <>
                  <Btn variant="subtle" size="md" onClick={onClose} disabled={busy}>
                    {t('common.cancel')}
                  </Btn>
                  <Btn
                    variant="primary"
                    size="md"
                    onClick={() => void createLink()}
                    disabled={!canCreate}
                    title={!trimmed ? t('projectPanel.collabSharedNameRequired') : undefined}
                  >
                    {busy
                      ? t('projectPanel.collabCreating')
                      : t('projectPanel.collabCreateLink')}
                  </Btn>
                </>
              )}
            </div>

            {/* Pending requests (approval mode) — the owner approves / denies each. */}
            {!unavailable && requests && requests.length > 0 && (
              <div className="mt-5 border-t border-line pt-4">
                <label className="mb-1.5 block label-cap text-ink-muted">
                  {t('projectPanel.collabRequestsLabel')}
                </label>
                <ul className="space-y-1">
                  {requests.map((rq) => (
                    <li
                      key={rq.id}
                      className="flex items-center gap-2 rounded-[3px] border border-line bg-bg px-2.5 py-1.5 text-[12px]"
                    >
                      <span className="min-w-0 flex-1 truncate text-ink">{rq.email}</span>
                      <Btn
                        variant="ghost"
                        size="xs"
                        className="shrink-0"
                        onClick={() => void actOnRequest(rq.id, 'approve')}
                        disabled={busyReqId === rq.id}
                      >
                        {busyReqId === rq.id
                          ? t('projectPanel.collabApproving')
                          : t('projectPanel.collabApprove')}
                      </Btn>
                      <button
                        type="button"
                        onClick={() => void actOnRequest(rq.id, 'deny')}
                        disabled={busyReqId === rq.id}
                        className={textBtn}
                      >
                        {t('projectPanel.collabDeny')}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Active links — per-link revoke + Reset link + the member cap. */}
            {!unavailable && links && links.length > 0 && (
              <div className="mt-5 border-t border-line pt-4">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label className="label-cap text-ink-muted">
                    {t('projectPanel.collabLinksLabel')}
                  </label>
                  <button
                    type="button"
                    onClick={() => void resetLink()}
                    disabled={resetting}
                    className={textBtn}
                  >
                    {resetting
                      ? t('projectPanel.collabResetting')
                      : t('projectPanel.collabResetLink')}
                  </button>
                </div>
                {loadedCap != null && (
                  <p className="mb-1.5 text-[11px] text-ink-faint">
                    {t('projectPanel.collabMemberCapCurrent', { cap: String(loadedCap) })}
                  </p>
                )}
                <ul className="space-y-1">
                  {links.map((lk) => (
                    <li
                      key={lk.id}
                      className="flex items-center gap-2 rounded-[3px] border border-line bg-bg px-2.5 py-1.5 text-[12px]"
                    >
                      <span className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                        {t(
                          lk.mode === 'approval'
                            ? 'projectPanel.collabLinkModeApproval'
                            : 'projectPanel.collabLinkModeOpen',
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink-faint">
                        {lk.maxUses != null
                          ? t('projectPanel.collabLinkUsesCapped', {
                              used: String(lk.useCount),
                              max: String(lk.maxUses),
                            })
                          : t('projectPanel.collabLinkUsesUnlimited', {
                              used: String(lk.useCount),
                            })}
                      </span>
                      <button
                        type="button"
                        onClick={() => void revokeOne(lk.id)}
                        disabled={busyLinkId === lk.id}
                        title={t('projectPanel.collabLinkRevoke')}
                        className={iconBtn}
                      >
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Collaborators — the roster + email invite + per-member remove. */}
            {!unavailable && (
              <div className="mt-5 border-t border-line pt-4">
                <label className="mb-1.5 block label-cap text-ink-muted">
                  {t('projectPanel.collabMembersLabel')}
                </label>
                {members === null ? (
                  <p className="text-[11px] text-ink-faint">{t('projectPanel.loading')}</p>
                ) : members.length === 0 ? (
                  <p className="text-[11px] leading-relaxed text-ink-faint">
                    {t('projectPanel.collabNoMembers')}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {members.map((m) => (
                      <li
                        key={(m.email ?? m.userId ?? '') + m.role}
                        className="flex items-center gap-2 rounded-[3px] border border-line bg-bg px-2.5 py-1.5 text-[12px]"
                      >
                        <span className="min-w-0 flex-1 truncate text-ink">
                          {m.email ?? t('projectPanel.collabMemberNoEmail')}
                        </span>
                        <span className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                          {m.role === 'owner'
                            ? t('projectPanel.collabMemberOwner')
                            : t('projectPanel.collabMemberRole')}
                        </span>
                        {m.role !== 'owner' && m.email && (
                          <button
                            type="button"
                            onClick={() => void removeMember(m.email as string)}
                            title={t('projectPanel.collabMemberRemove')}
                            className={iconBtn}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {/* Invite by email — the second membership path beside the link. */}
                <div className="mt-2 flex items-stretch gap-1.5">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void inviteEmail()
                      }
                    }}
                    placeholder={t('projectPanel.collabInviteEmailPlaceholder')}
                    className={`${FIELD_INPUT_CSS} min-w-0 flex-1`}
                  />
                  <Btn
                    variant="ghost"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => void inviteEmail()}
                    disabled={!email.trim() || inviting}
                  >
                    {inviting
                      ? t('projectPanel.collabInviteEmailBusy')
                      : t('projectPanel.collabInviteEmailBtn')}
                  </Btn>
                </div>
              </div>
            )}

            {/* Eviction: revoke ALL outstanding invite links (owner-gated). Quiet,
                separate from the mint action — used after removing a collaborator
                so an old 7-day code can't let them rejoin. */}
            {!unavailable && (
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
                <span className="min-w-0 text-[11px] leading-relaxed text-ink-faint">
                  {revoked
                    ? t('projectPanel.collabRevoked')
                    : t('projectPanel.collabRevokeHint')}
                </span>
                <button
                  type="button"
                  onClick={() => void revokeLinks()}
                  disabled={revoking}
                  className={textBtn}
                >
                  {revoking
                    ? t('projectPanel.collabRevoking')
                    : t('projectPanel.collabRevoke')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
