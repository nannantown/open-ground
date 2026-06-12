// Share-start dialog + invite panel (docs/SHARE_UX_FLOWS.md §2c/§2d).
//
// One screen, one vertical column — every choice the share starts with
// (display name, members, workflow) is visible before the user commits, and
// a successful enable swaps the content to the InvitePanel in place (the
// "what do I hand my teammate?" answer, S008/S015) instead of closing.
//
// Also exports the workflow/members FIELD components + the branches hook —
// the ProjectSettingsDialog renders the exact same fields, so the start
// dialog's confirmation step and the settings stay one implementation.

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import type {
  ProjectBranchesResponse,
  ProjectConfig,
  SettingsResponse,
  ShareStatus,
} from '@/lib/types'
import { enableShare, remoteShortName } from '@/lib/shareClient'
import { sharePublished } from '@/lib/shareUx'

/** What the parent's Sync actually did — the InvitePanel shows failures
 *  INLINE (the parent's header notice is hidden behind this dialog, so a
 *  fire-and-forget onSync would fail invisibly). `error` is already-localized
 *  display text (the same line doSync posts to its own notice). */
export type SyncOutcome = { ok: true } | { ok: false; error: string }

export const FIELD_INPUT_CSS =
  'w-full rounded-[3px] border border-line bg-bg px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-faint transition-colors focus:border-accent focus:outline-none'

/** The repo's branch list — fetched once per dialog open so Target branch is
 *  a pick-from-list instead of a typo-prone text field. branches null while
 *  loading; `failed` (fetch error / empty list / non-git) falls back to the
 *  plain text input. */
export const useProjectBranches = (
  projectPath: string,
): { branches: string[] | null; failed: boolean } => {
  const [branches, setBranches] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/project/branches?path=${encodeURIComponent(projectPath)}`)
      .then(r =>
        r.ok
          ? (r.json() as Promise<ProjectBranchesResponse>)
          : Promise.reject(new Error(String(r.status))),
      )
      .then(body => {
        if (cancelled) return
        if (Array.isArray(body.branches) && body.branches.length > 0) {
          setBranches(body.branches.filter((b): b is string => typeof b === 'string'))
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])
  return { branches, failed }
}

/** completionFlow segmented toggle + per-choice hint + the gh CLI pre-check
 *  (probed lazily the first time 'pr' is picked — failing at completion time
 *  is too late). */
export const CompletionFlowField = ({
  flow,
  onChange,
}: {
  flow: 'merge' | 'pr'
  onChange: (flow: 'merge' | 'pr') => void
}) => {
  const { t } = useT()
  const [ghStatus, setGhStatus] = useState<{
    installed: boolean
    authenticated: boolean
  } | null>(null)
  useEffect(() => {
    if (flow !== 'pr' || ghStatus) return
    let cancelled = false
    fetch('/api/gh-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j) setGhStatus(j)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [flow, ghStatus])
  return (
    <div>
      <label className="mb-1.5 block label-cap text-ink-muted">
        {t('projectPanel.settingsCompletionFlow')}
      </label>
      <div
        role="group"
        aria-label={t('projectPanel.settingsCompletionFlow')}
        className="inline-flex items-center gap-0 rounded-[3px] border border-line p-0.5"
      >
        {(['merge', 'pr'] as const).map(v => {
          const active = flow === v
          return (
            <button
              key={v}
              type="button"
              onClick={() => onChange(v)}
              aria-pressed={active}
              className={[
                'h-7 px-3 rounded-[2px] text-[12px] font-medium cursor-pointer transition-all duration-150',
                'border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                active
                  ? 'bg-accent text-bg-card border-accent'
                  : 'bg-transparent text-ink-muted border-line hover:bg-bg-inset hover:text-ink hover:border-line-strong',
              ].join(' ')}
            >
              {t(
                v === 'merge'
                  ? 'projectPanel.settingsFlowMerge'
                  : 'projectPanel.settingsFlowPr',
              )}
            </button>
          )
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
        {t(
          flow === 'pr'
            ? 'projectPanel.settingsFlowPrHint'
            : 'projectPanel.settingsFlowMergeHint',
        )}
      </p>
      {flow === 'pr' && ghStatus && (!ghStatus.installed || !ghStatus.authenticated) && (
        <p className="mt-1 text-[11px] leading-relaxed text-accent">
          {ghStatus.installed
            ? t('projectPanel.settingsGhUnauthenticated')
            : t('projectPanel.settingsGhMissing')}
        </p>
      )}
    </div>
  )
}

/** Target branch — select from the live branch list when available, plain
 *  text input otherwise. A saved branch the list doesn't carry (deleted, or
 *  still loading) stays selectable so open+save never drops it. */
export const TargetBranchField = ({
  value,
  onChange,
  branches,
  branchesFailed,
  savedBranch,
}: {
  value: string
  onChange: (v: string) => void
  branches: string[] | null
  branchesFailed: boolean
  savedBranch: string
}) => {
  const { t } = useT()
  const extraBranch =
    savedBranch && !(branches ?? []).includes(savedBranch) ? savedBranch : null
  return (
    <div>
      <label className="mb-1 block label-cap text-ink-muted">
        {t('projectPanel.settingsTargetBranch')}
      </label>
      {branchesFailed ? (
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={t('projectPanel.settingsTargetBranchPlaceholder')}
          className={FIELD_INPUT_CSS}
        />
      ) : (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className={`${FIELD_INPUT_CSS} cursor-pointer`}
        >
          <option value="">{t('projectPanel.settingsBranchDefault')}</option>
          {extraBranch && <option value={extraBranch}>{extraBranch}</option>}
          {(branches ?? []).map(b => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/** Member chips + add input. Case-insensitive dedupe on add; the caller owns
 *  the list state. `hint` lets each surface explain the list in its own
 *  context (settings: assignee picker / start dialog: auto-includes you). */
export const MembersField = ({
  members,
  onChange,
  hint,
  label,
}: {
  members: string[]
  onChange: (members: string[]) => void
  hint: string
  /** Field label override. Default is the shared vocabulary ("Members");
   *  the unshared settings dialog passes the share-free "Assignee names". */
  label?: string
}) => {
  const { t } = useT()
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (!v) return
    setDraft('')
    if (!members.some(m => m.toLowerCase() === v.toLowerCase()))
      onChange([...members, v])
  }
  return (
    <div>
      <label className="mb-1 block label-cap text-ink-muted">
        {label ?? t('projectPanel.settingsMembers')}
      </label>
      {members.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {members.map(name => (
            <span
              key={name}
              className="flex max-w-full items-center gap-1 rounded-sm border border-line px-2 py-1 text-[11px] text-ink"
            >
              <span className="min-w-0 truncate">{name}</span>
              <button
                type="button"
                onClick={() => onChange(members.filter(m => m !== name))}
                title={t('projectPanel.settingsMemberRemove', { name })}
                aria-label={t('projectPanel.settingsMemberRemove', { name })}
                className="text-ink-faint transition-colors hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // Never steal the Enter that confirms an IME composition.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              add()
            }
          }}
          placeholder={t('projectPanel.settingsMemberAddPlaceholder')}
          className={FIELD_INPUT_CSS}
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="shrink-0 rounded-sm border border-line px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('projectPanel.settingsMemberAdd')}
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{hint}</p>
    </div>
  )
}

// ── InvitePanel — what to hand the teammate (S015), shown right after a
//    successful enable and re-openable from settings ("招待方法を表示…"). ──
const InvitePanel = ({
  shareStatus,
  syncing,
  onSync,
  onClose,
}: {
  shareStatus: ShareStatus | null
  syncing: boolean
  onSync: () => Promise<SyncOutcome>
  onClose: () => void
}) => {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  // Publish-now failure, shown INLINE — the parent's shareNotice sits under
  // this full-panel overlay and would never be seen.
  const [publishError, setPublishError] = useState<string | null>(null)
  const remoteUrl = shareStatus?.remoteUrl ?? null
  const published = sharePublished(shareStatus)
  const publish = async () => {
    setPublishError(null)
    const r = await onSync()
    if (!r.ok) setPublishError(r.error)
  }
  const inviteText = remoteUrl
    ? t('projectPanel.inviteText', { url: remoteUrl })
    : null
  const copy = async () => {
    if (!inviteText) return
    try {
      await navigator.clipboard.writeText(inviteText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard refused — the text stays selectable */
    }
  }
  return (
    <div className="mx-auto w-full max-w-[480px]">
      <p className="label-cap text-accent mb-2">{t('projectPanel.inviteLabel')}</p>
      <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
        {t('projectPanel.inviteTitle')}
      </h3>

      {/* Publish state — enable commits NOTHING; the first Sync publishes. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {published ? (
          <p className="text-[12px] leading-relaxed text-ink-muted">
            {t('projectPanel.invitePublished')}
          </p>
        ) : (
          <>
            <p className="text-[12px] leading-relaxed text-accent">
              {t('projectPanel.inviteUnpublished')}
            </p>
            <Btn
              variant="primary"
              size="xs"
              onClick={() => void publish()}
              // Without a remote there is nowhere to publish — Sync would
              // soft-succeed having pushed nothing. Disabled with the reason.
              disabled={syncing || !remoteUrl}
              title={!remoteUrl ? t('projectPanel.invitePublishNoRemote') : undefined}
            >
              {syncing ? t('projectPanel.syncing') : t('projectPanel.invitePublishNow')}
            </Btn>
          </>
        )}
      </div>
      {publishError && !published && (
        <p className="mt-2 text-[11px] leading-relaxed text-accent">
          {publishError}
        </p>
      )}

      {/* The three steps a teammate actually takes. */}
      <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-[12px] leading-relaxed text-ink-muted">
        <li>{t('projectPanel.inviteStep1')}</li>
        <li>{t('projectPanel.inviteStep2')}</li>
        <li>{t('projectPanel.inviteStep3')}</li>
      </ol>

      {/* Copyable invite message (remote URL embedded, UI language). */}
      <div className="mt-4">
        <label className="mb-1 block label-cap text-ink-muted">
          {t('projectPanel.inviteTextLabel')}
        </label>
        {inviteText ? (
          <div className="flex items-start gap-1.5">
            <p className="min-w-0 flex-1 select-all rounded-[3px] border border-line bg-bg px-2.5 py-2 text-[12px] leading-relaxed text-ink">
              {inviteText}
            </p>
            <button
              type="button"
              onClick={() => void copy()}
              className="shrink-0 rounded-sm border border-line px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {copied ? t('projectPanel.inviteCopied') : t('projectPanel.inviteCopy')}
            </button>
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-ink-faint">
            {t('projectPanel.inviteTextNoRemote')}
          </p>
        )}
      </div>

      <div className="mt-5 flex items-center justify-end">
        <Btn variant="primary" size="md" onClick={onClose}>
          {t('projectPanel.inviteDone')}
        </Btn>
      </div>
    </div>
  )
}

// ── ShareStartDialog ────────────────────────────────────────────────────────
export const ShareStartDialog = ({
  projectName,
  projectPath,
  mode,
  shareStatus,
  initialConfig,
  syncing,
  onSync,
  onEnabled,
  onClose,
}: {
  projectName: string
  projectPath: string
  /** 'start' = the full enable form; 'invite' = jump straight to the invite
   *  panel (settings の「招待方法を表示…」 re-entry for already-shared). */
  mode: 'start' | 'invite'
  shareStatus: ShareStatus | null
  initialConfig: ProjectConfig | undefined
  syncing: boolean
  /** Resolves with what the sync did — the InvitePanel reports failures
   *  inline (the parent's notice is invisible behind this overlay). */
  onSync: () => Promise<SyncOutcome>
  /** Called once enable succeeded (refresh status/data in the parent) —
   *  the dialog then switches to the invite panel in place. */
  onEnabled: () => Promise<void> | void
  onClose: () => void
}) => {
  const { t } = useT()
  const [phase, setPhase] = useState<'form' | 'invite'>(
    mode === 'invite' ? 'invite' : 'form',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Display name — global settings value, prefilled from GET /api/settings
  // (null while loading so a slow fetch can't be overwritten by the prefill).
  const [name, setName] = useState<string | null>(mode === 'invite' ? '' : null)
  useEffect(() => {
    if (mode === 'invite') return
    let cancelled = false
    fetch('/api/settings', { cache: 'no-store' })
      .then(r => (r.ok ? (r.json() as Promise<SettingsResponse>) : null))
      .then(body => {
        if (cancelled) return
        setName(prev =>
          prev !== null
            ? prev
            : (body?.displayName ?? body?.suggestedDisplayName ?? ''),
        )
      })
      .catch(() => {
        if (!cancelled) setName(prev => (prev !== null ? prev : ''))
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  // Workflow + members drafts (prefilled from the current config — the start
  // confirms the team's rules instead of starting on unknown defaults, S011).
  const [flow, setFlow] = useState<'merge' | 'pr'>(
    initialConfig?.completionFlow ?? 'merge',
  )
  const [targetBranch, setTargetBranch] = useState(initialConfig?.targetBranch ?? '')
  const [members, setMembers] = useState<string[]>(() =>
    Array.from(new Set(initialConfig?.members ?? [])),
  )
  const { branches, failed: branchesFailed } = useProjectBranches(projectPath)

  const remoteUrl = shareStatus?.remoteUrl ?? null
  const remoteName = remoteShortName(remoteUrl)
  const branch = shareStatus?.branch

  const trimmedName = (name ?? '').trim()
  const canStart = !!trimmedName && !busy && name !== null

  const start = async () => {
    if (!canStart) return
    setBusy(true)
    setError(null)
    try {
      // 1. Display name → global settings FIRST (separate concern from the
      //    enable; a failed save stops here so "shared but nameless" can't
      //    happen).
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: trimmedName }),
      }).catch(() => null)
      if (!res || !res.ok) {
        setError(t('projectPanel.networkError'))
        return
      }
      // 2. Enable with the confirmed policy. The owner is always a member.
      const allMembers = members.some(
        m => m.toLowerCase() === trimmedName.toLowerCase(),
      )
        ? members
        : [...members, trimmedName]
      // targetBranch is ALWAYS sent: '' is the explicit "branch at launch"
      // choice and clears any previously saved branch server-side (the route
      // drops the key from the merged config) — omitting it would silently
      // resurrect a stale saved value.
      const r = await enableShare(projectPath, {
        completionFlow: flow,
        targetBranch: targetBranch.trim(),
        members: allMembers,
      })
      if (!r.ok) {
        setError(r.error)
        return
      }
      await onEnabled()
      setPhase('invite')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-esc-overlay
      className="absolute inset-0 z-20 overflow-y-auto bg-bg-card"
    >
      <div className="grid min-h-full place-items-center">
        <div className="w-full px-6 py-10">
          {phase === 'invite' ? (
            <InvitePanel
              shareStatus={shareStatus}
              syncing={syncing}
              onSync={onSync}
              onClose={onClose}
            />
          ) : (
            <div className="mx-auto w-full max-w-[480px]">
              <p className="label-cap text-accent mb-2">
                {t('projectPanel.shareDialogLabel')}
              </p>
              <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
                {t('projectPanel.shareStartTitle', { name: projectName })}
              </h3>
              <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
                {t('projectPanel.shareDialogExplain')}
                {branch
                  ? ` ${t('projectPanel.shareStartBranchNote', { branch })}`
                  : ''}
              </p>

              {/* Where the data goes — or the no-remote warning (S005;
                  non-blocking: a later `git remote add` + Sync auto-publishes). */}
              <div className="mt-3">
                {remoteUrl ? (
                  <p
                    className="truncate text-[12px] text-ink-muted"
                    title={remoteUrl}
                  >
                    <span className="label-cap text-ink-muted">
                      {t('projectPanel.shareStartRemoteLabel')}
                    </span>{' '}
                    <span className="font-mono text-[11px]">
                      {remoteName ?? remoteUrl}
                    </span>
                  </p>
                ) : (
                  <p className="text-[11px] leading-relaxed text-accent">
                    {t('projectPanel.shareStartNoRemote')}
                  </p>
                )}
              </div>

              <div className="mt-4 space-y-3.5">
                {/* Display name — REQUIRED (assignees, mineOnly and the
                    teammate's welcome strip all depend on it, S009). */}
                <div>
                  <label className="mb-1 block label-cap text-ink-muted">
                    {t('projectPanel.shareStartDisplayName')}
                  </label>
                  <input
                    autoFocus
                    value={name ?? ''}
                    onChange={e => setName(e.target.value)}
                    // While the saved name is loading the input is disabled —
                    // say so instead of looking silently broken.
                    placeholder={
                      name === null
                        ? t('projectPanel.shareStartNameLoading')
                        : t('projectPanel.shareStartDisplayName')
                    }
                    title={
                      name === null
                        ? t('projectPanel.shareStartNameLoading')
                        : undefined
                    }
                    disabled={name === null}
                    className={FIELD_INPUT_CSS}
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                    {t('projectPanel.shareStartDisplayNameHint')}
                  </p>
                </div>

                <MembersField
                  members={members}
                  onChange={setMembers}
                  hint={t('projectPanel.shareStartMembersHint')}
                />

                <CompletionFlowField flow={flow} onChange={setFlow} />
                <TargetBranchField
                  value={targetBranch}
                  onChange={setTargetBranch}
                  branches={branches}
                  branchesFailed={branchesFailed}
                  savedBranch={(initialConfig?.targetBranch ?? '').trim()}
                />
              </div>

              {error && (
                <p className="mt-3 text-[11px] leading-relaxed text-accent">
                  {t('projectPanel.shareFailed', { error })}
                </p>
              )}

              <div className="mt-5 flex items-center justify-end gap-2">
                <Btn variant="subtle" size="md" onClick={onClose} disabled={busy}>
                  {t('common.cancel')}
                </Btn>
                <Btn
                  variant="primary"
                  size="md"
                  onClick={() => void start()}
                  disabled={!canStart}
                  title={
                    !trimmedName
                      ? t('projectPanel.shareStartNameRequired')
                      : undefined
                  }
                >
                  {busy
                    ? t('projectPanel.shareStartWorking')
                    : t('projectPanel.shareStartConfirm')}
                </Btn>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
