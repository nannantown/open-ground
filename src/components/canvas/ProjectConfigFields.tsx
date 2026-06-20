// Project-config edit fields — the completion-flow / target-branch / members
// inputs (plus the shared FIELD_INPUT_CSS constant and the branch-list hook)
// rendered by the project settings dialog. Split into their own module so they
// outlive the (removed) Git-share feature: these edit ProjectConfig (board
// policy + assignee names), which is independent of any sharing. FIELD_INPUT_CSS
// is also reused by the realtime-collab dialogs.

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { ProjectBranchesResponse } from '@/lib/types'

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
