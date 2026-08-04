import { useCallback, useEffect, useRef, useState } from 'react'
import { Inbox, RefreshCw, Loader2, AlertCircle, Check, X, Code2 } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { buildScreenSrcdoc } from '@/lib/screenSrcdoc'
import { useClientLockdown } from '@/lib/lockdownClient'
import type { ModuleSubmissionItem, ModuleSubmissionsResponse } from '@/lib/types'

// Owner-only review inbox for tester tab submissions (docs/CUSTOM_TABS_PLAN.md —
// submit → review → publish). Lists the PENDING queue (GET /api/module-
// submissions), expands a row to fetch + preview its source (GET :id — the list
// omits source to stay light), and approves (→ the existing publishModule INSERTs
// it into the og_custom_modules marketplace) or rejects. Modeled on the
// SettingsPanel FeedbackInbox; renders the submitted source in the SAME
// sandboxed iframe a custom tab itself uses, so review never executes the code
// with host access. Mounted only when /config reports canReview (owner build).

type RowBusy = { id: string; action: 'approve' | 'reject' }

export const ModuleReviewInbox = ({
  onSeen,
}: {
  /** Called once submissions load: record the newest created_at as "seen" so the
   *  settings-gear dot clears (scoped per data source in App). */
  onSeen?: (latestCreatedAt: string | null) => void
}) => {
  const { t } = useT()
  // Work mode: submission previews render third-party code — placeholder while on.
  const lockdown = useClientLockdown()
  const [items, setItems] = useState<ModuleSubmissionItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  // The expanded row + its fetched source (the list omits source). null source
  // while the per-row fetch is in flight.
  const [openId, setOpenId] = useState<string | null>(null)
  const [openSource, setOpenSource] = useState<{
    id: string
    source: string
    framework: 'react' | 'html'
  } | null>(null)
  const [busy, setBusy] = useState<RowBusy | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch('/api/module-submissions')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<ModuleSubmissionsResponse>
      })
      .then((data) => {
        if (!mounted.current) return
        const next = data.items ?? []
        setItems(next)
        setTruncated(!!data.truncated)
        onSeen?.(next[0]?.created_at ?? null)
      })
      .catch(() => {
        if (mounted.current) setError(t('customTabs.reviewError'))
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
  }, [onSeen, t])

  useEffect(() => {
    load()
  }, [load])

  // Expand a row → fetch its source for the preview (the list payload omits it).
  const toggle = useCallback(
    (item: ModuleSubmissionItem) => {
      setActionError(null)
      if (openId === item.id) {
        setOpenId(null)
        setOpenSource(null)
        return
      }
      setOpenId(item.id)
      setOpenSource(null)
      fetch(`/api/module-submissions/${item.id}`)
        .then((res) => (res.ok ? (res.json() as Promise<ModuleSubmissionItem>) : null))
        .then((full) => {
          if (!mounted.current || !full) return
          setOpenSource({ id: item.id, source: full.source ?? '', framework: full.framework })
        })
        .catch(() => {
          /* preview is best-effort — the approve/reject actions still work */
        })
    },
    [openId],
  )

  // Approve (publish) or reject a submission, then drop it from the queue list.
  const act = useCallback(
    async (item: ModuleSubmissionItem, action: 'approve' | 'reject') => {
      if (busy) return
      setBusy({ id: item.id, action })
      setActionError(null)
      try {
        const r = await fetch(`/api/module-submissions/${item.id}/${action}`, { method: 'POST' })
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? `HTTP ${r.status}`)
        }
        if (!mounted.current) return
        setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev))
        if (openId === item.id) {
          setOpenId(null)
          setOpenSource(null)
        }
      } catch (e) {
        if (mounted.current) {
          setActionError(
            t('customTabs.reviewActionFailed', { error: e instanceof Error ? e.message : '' }),
          )
        }
      } finally {
        if (mounted.current) setBusy(null)
      }
    },
    [busy, openId, t],
  )

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="label-cap inline-flex items-center gap-1.5 text-ink-muted">
          <Inbox size={12} />
          {t('customTabs.reviewHeading')}
          {items && items.length > 0 && (
            <span className="text-ink-subtle">
              ({items.length}
              {truncated ? '+' : ''})
            </span>
          )}
        </p>
        <button
          onClick={load}
          disabled={loading}
          className="label-cap inline-flex items-center gap-1 text-ink-subtle transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          {t('customTabs.reviewRefresh')}
        </button>
      </div>

      {loading && !items && (
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-subtle">
          <Loader2 size={12} className="animate-spin" />
          {t('customTabs.reviewLoading')}
        </span>
      )}
      {error && (
        <div className="inline-flex items-start gap-1 text-[11px] text-accent">
          <AlertCircle size={12} className="mt-[2px] shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {items && items.length === 0 && !error && (
        <p className="text-[11px] leading-relaxed text-ink-subtle">{t('customTabs.reviewEmpty')}</p>
      )}
      {actionError && (
        <div className="mb-2 inline-flex items-start gap-1 text-[11px] text-accent">
          <AlertCircle size={12} className="mt-[2px] shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="-mx-1 max-h-[440px] space-y-2 overflow-y-auto px-1">
          {items.map((s) => {
            const open = openId === s.id
            const rowBusy = busy?.id === s.id
            const sourceReady = openSource?.id === s.id
            return (
              <li
                key={s.id}
                className="rounded-[2px] border border-line bg-bg p-3 leading-relaxed"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-medium text-ink">{s.name}</p>
                    {s.description && (
                      <p className="whitespace-pre-wrap break-words text-[11px] text-ink-muted">
                        {s.description}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-ink-subtle">
                      <span className="font-mono uppercase">{s.framework}</span>
                      {s.submitter_email && (
                        <>
                          <span className="text-ink-faint">·</span>
                          <span className="font-mono">
                            {t('customTabs.reviewBy', { email: s.submitter_email })}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => toggle(s)}
                    className="label-cap inline-flex shrink-0 items-center gap-1 text-ink-subtle transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <Code2 size={12} />
                    {open ? t('customTabs.hideCode') : t('customTabs.viewCode')}
                  </button>
                </div>

                {open && (
                  <div className="mt-3 space-y-2">
                    {sourceReady ? (
                      <>
                        {/* Live preview — the SAME sandboxed iframe the tab renders
                            in (scripts only, no same-origin), so review never runs
                            the submitted code with host access. */}
                        <div className="overflow-hidden rounded-[2px] border border-line bg-bg-deep">
                          <iframe
                            title={`${s.name} ${t('customTabs.reviewPreview')}`}
                            sandbox="allow-scripts"
                            srcDoc={buildScreenSrcdoc(
                              openSource!.source,
                              openSource!.framework,
                              'dark',
                              undefined,
                              { lockdown },
                            )}
                            className="h-[220px] w-full border-0"
                          />
                        </div>
                        {/* Raw source — text-escaped by React, never HTML. */}
                        <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-[2px] border border-line bg-bg-deep p-2 text-[10.5px] leading-[1.5] text-ink-muted">
                          {openSource!.source}
                        </pre>
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] text-ink-subtle">
                        <Loader2 size={12} className="animate-spin" />
                        {t('customTabs.reviewLoading')}
                      </span>
                    )}
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => void act(s, 'approve')}
                    disabled={rowBusy}
                    className="inline-flex items-center gap-1 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink transition-colors hover:bg-plane active:bg-plane disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {rowBusy && busy?.action === 'approve' ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Check size={12} />
                    )}
                    {rowBusy && busy?.action === 'approve'
                      ? t('customTabs.approving')
                      : t('customTabs.approve')}
                  </button>
                  <button
                    onClick={() => void act(s, 'reject')}
                    disabled={rowBusy}
                    className="inline-flex items-center gap-1 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-plane hover:text-ink active:bg-plane disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {rowBusy && busy?.action === 'reject' ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <X size={12} />
                    )}
                    {rowBusy && busy?.action === 'reject'
                      ? t('customTabs.rejecting')
                      : t('customTabs.reject')}
                  </button>
                </div>
              </li>
            )
          })}
          {truncated && (
            <li className="px-1 text-[10px] text-ink-subtle">{t('customTabs.reviewTruncated')}</li>
          )}
        </ul>
      )}
    </div>
  )
}
