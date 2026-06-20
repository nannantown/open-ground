import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Users, X } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import { FIELD_INPUT_CSS } from './ProjectConfigFields'
import type {
  CollabJoinResponse,
  CollabProjectListItem,
  CollabProjectsListResponse,
} from '@/lib/types'

// "Shared with me" — the MEMBER entry point. Lists the folder-less projects the
// signed-in user was invited to (owned:false), and lets them redeem an invite
// CODE to join a new one. Picking a project opens it in SharedProjectPanel.
//
// Two ways a code arrives: pasted into the field, or carried by an
// `openground://join?code=…` deep link (Track C) → App passes it as `initialCode`,
// and we auto-redeem it once on mount. On an APPROVAL-mode link the join returns
// status:'pending' → we show an "awaiting approval" state instead of opening.
//
// This is the reachability surface for the member flow: a member has no local
// folder, so a shared project can't appear via the registry/Ground scan — it's
// discovered here instead. Fetch-only (no heavy collab import); only mounted
// behind the collab-enabled gate (the Toolbar entry / a deep link), so the default
// build never shows it.

export const CollabSharedDialog = ({
  initialCode,
  onOpen,
  onClose,
}: {
  /** A code carried in by a deep link — prefilled and auto-redeemed once on mount. */
  initialCode?: string
  /** Open a shared project (folder-less) in SharedProjectPanel. */
  onOpen: (collabProjectId: string, label: string) => void
  onClose: () => void
}) => {
  const { t } = useT()
  // null = still loading; [] = none.
  const [shared, setShared] = useState<CollabProjectListItem[] | null>(null)
  const [code, setCode] = useState(initialCode ?? '')
  const [joining, setJoining] = useState(false)
  const [awaiting, setAwaiting] = useState(false) // approval-mode request filed
  const [error, setError] = useState<string | null>(null)
  // Auto-redeem the deep-link code exactly once (StrictMode double-mounts effects).
  const autoJoined = useRef(false)

  // Shared-with-me = projects the caller can READ but does NOT own (owned:false);
  // owned ones already appear as local Ground cards. Returns the list so join()
  // can open the freshly-joined project without a second fetch / state race.
  const load = useCallback(async (): Promise<CollabProjectListItem[]> => {
    const res = await fetch('/api/collab/projects')
      .then((r) => (r.ok ? (r.json() as Promise<CollabProjectsListResponse>) : null))
      .catch(() => null)
    const list = (res?.projects ?? []).filter((p) => !p.owned)
    setShared(list)
    return list
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // `explicit` lets the deep-link auto-join pass the code directly (the field state
  // may not have committed yet); the button passes nothing and uses the field.
  const join = useCallback(
    async (explicit?: string) => {
      const c = (explicit ?? code).trim()
      if (!c || joining) return
      setJoining(true)
      setError(null)
      setAwaiting(false)
      try {
        const res = await fetch('/api/collab/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: c }),
        })
          .then((r) => (r.ok ? (r.json() as Promise<CollabJoinResponse>) : null))
          .catch(() => null)
        if (!res?.ok || !res.collabProjectId) {
          setError(t('projectPanel.collabSharedDialogJoinFailed'))
          return
        }
        setCode('')
        // Approval mode: a request was filed — don't open anything, show "awaiting".
        if (res.status === 'pending') {
          setAwaiting(true)
          return
        }
        const list = await load()
        const joined = list.find((p) => p.id === res.collabProjectId)
        onOpen(
          res.collabProjectId,
          joined?.label || t('projectPanel.collabSharedDialogUntitled'),
        )
      } finally {
        setJoining(false)
      }
    },
    [code, joining, load, onOpen, t],
  )

  // Auto-redeem a deep-link code once.
  useEffect(() => {
    const c = (initialCode ?? '').trim()
    if (!c || autoJoined.current) return
    autoJoined.current = true
    void join(c)
  }, [initialCode, join])

  return (
    <div
      data-esc-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[440px] max-w-[92vw] flex-col overflow-hidden rounded-[3px] border border-line bg-bg-card shadow-card-hover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 pt-4 pb-3">
          <h3 className="flex items-center gap-2 font-display text-[16px] text-ink">
            <Users size={15} className="text-ink-muted" />
            {t('projectPanel.collabSharedDialogTitle')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            title={t('common.cancel')}
            className="rounded-sm p-1 text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Awaiting approval (approval-mode link) — shown after a pending join. */}
          {awaiting && (
            <div className="flex items-start gap-2.5 rounded-[3px] border border-line bg-bg px-3 py-2.5">
              <Clock size={14} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-ink">
                  {t('projectPanel.collabSharedDialogAwaiting')}
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                  {t('projectPanel.collabSharedDialogAwaitingBody')}
                </p>
              </div>
            </div>
          )}

          {/* Join by code */}
          <div>
            <label className="mb-1 block label-cap text-ink-muted">
              {t('projectPanel.collabSharedDialogJoinLabel')}
            </label>
            <div className="flex items-stretch gap-1.5">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  // Enter submits — but never steal the IME confirm Enter.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void join()
                  }
                }}
                placeholder={t('projectPanel.collabSharedDialogJoinPlaceholder')}
                className={`${FIELD_INPUT_CSS} min-w-0 flex-1`}
              />
              <Btn
                variant="primary"
                size="sm"
                className="shrink-0 whitespace-nowrap"
                onClick={() => void join()}
                disabled={!code.trim() || joining}
              >
                {joining
                  ? t('projectPanel.collabSharedDialogJoining')
                  : t('projectPanel.collabSharedDialogJoin')}
              </Btn>
            </div>
            {error && <p className="mt-1.5 text-[11px] leading-relaxed text-accent">{error}</p>}
          </div>

          {/* The list of projects shared with me */}
          <div>
            <label className="mb-1 block label-cap text-ink-muted">
              {t('projectPanel.collabSharedDialogListLabel')}
            </label>
            {shared === null ? (
              <p className="text-[12px] text-ink-faint">{t('projectPanel.loading')}</p>
            ) : shared.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-ink-faint">
                {t('projectPanel.collabSharedDialogEmpty')}
              </p>
            ) : (
              <ul className="space-y-1">
                {shared.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onOpen(p.id, p.label || t('projectPanel.collabSharedDialogUntitled'))
                      }
                      className="flex w-full items-center gap-2 rounded-[3px] border border-line bg-bg px-2.5 py-2 text-left text-[12px] text-ink transition-colors hover:border-accent hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <Users size={13} className="shrink-0 text-ink-faint" />
                      <span className="truncate">
                        {p.label || t('projectPanel.collabSharedDialogUntitled')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
