import { useCallback, useEffect, useRef, useState } from 'react'
import {
  X,
  FolderOpen,
  ChevronRight,
  Check,
  AlertCircle,
  Loader2,
  Terminal,
  Inbox,
  RefreshCw,
  MessageSquare,
} from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import type { Settings, SettingsResponse, FeedbackItem, FeedbackListResponse } from '@/lib/types'
import { api } from '@/lib/api-client'
import { useClaudeProbe } from '@/lib/useClaudeProbe'
import { useT } from '@/i18n/I18nContext'
import type { Lang } from '@/i18n/messages'

interface Props {
  open: boolean
  settings: Settings
  onClose: () => void
  onSave: (s: Settings) => void
  /** Re-fetch projects/settings after the registered-project list changes. */
  onReload?: () => void
  /** When true the server has a service-role key, so the owner-only "Incoming
   *  feedback" inbox can read submissions. False on the public build. */
  feedbackCanRead?: boolean
  /** Called once the inbox has loaded, with the newest submission's created_at. */
  onFeedbackSeen?: (latestCreatedAt: string | null) => void
  /** When provided, renders a clear "Send feedback" button that opens the
   *  composer. Omit to hide the entry entirely. */
  onOpenFeedback?: () => void
}

// Settings drawer. Deliberately minimal: only real preferences are visible
// (Language, Feedback). The setup prerequisite (Claude CLI) is taught in
// onboarding; the knobs with working defaults (workspace, a CLI re-check)
// live under Advanced so the surface stays calm.
export const SettingsPanel = ({
  open,
  settings,
  onClose,
  onSave,
  onReload,
  feedbackCanRead = false,
  onFeedbackSeen,
  onOpenFeedback,
}: Props) => {
  const { t, lang, setLang } = useT()
  const [defaultWorkspace, setDefaultWorkspace] = useState(settings.defaultWorkspace ?? '')
  const [displayName, setDisplayName] = useState(settings.displayName ?? '')
  // Non-persisted placeholder for the Display name input: the user's global
  // git identity, served by GET /api/settings as `suggestedDisplayName`.
  const [suggestedName, setSuggestedName] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [picking, setPicking] = useState(false)
  const [claudeNonce, setClaudeNonce] = useState(0)
  const claudeProbe = useClaudeProbe(open && showAdvanced, claudeNonce)

  // Re-seed from live settings only on the open→true transition (see the long
  // note kept below) so an in-session load() can't wipe unsaved edits.
  useEffect(() => {
    if (!open) return
    setDefaultWorkspace(settings.defaultWorkspace ?? '')
    setDisplayName(settings.displayName ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Fetch the display-name suggestion when the drawer opens (cheap: the server
  // caches the git lookup for its process lifetime). Best-effort — without it
  // the input simply has no placeholder.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api.api.settings
      .$get()
      .then(async (res) => {
        if (!res.ok) return
        const body = (await res.json()) as SettingsResponse
        if (!cancelled) setSuggestedName(body.suggestedDisplayName ?? null)
      })
      .catch(() => {
        /* no suggestion — the input still works */
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const browse = async () => {
    setPicking(true)
    try {
      const res = await api.api['pick-folder'].$post()
      const data = (await res.json()) as { path?: string }
      if (data.path) setDefaultWorkspace(data.path)
    } catch {
      /* user can still type the path manually */
    }
    setPicking(false)
  }

  const save = () => {
    onSave({
      ...settings,
      defaultWorkspace: defaultWorkspace.trim() || null,
      // '' is saved explicitly (not dropped) so clearing the field clears the
      // setting through the server's merge-on-write.
      displayName: displayName.trim(),
    })
  }

  return (
    <>
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={[
          'fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm transition-opacity duration-200 ease-out',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        className={[
          'fixed top-0 right-0 z-50 h-full w-[440px] max-w-[92vw]',
          'bg-bg-card border-l border-line shadow-card-hover flex flex-col',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
        ].join(' ')}
      >
        <header className="shrink-0 rule-double flex items-baseline justify-between px-6 pt-5 pb-4">
          <div>
            <p className="label-cap text-accent mb-1.5">{t('settings.eyebrow')}</p>
            <h2
              className="font-display text-[22px] text-ink leading-none tracking-tightest"
              style={{ fontVariationSettings: "'opsz' 24, 'SOFT' 40" }}
            >
              Settings
            </h2>
          </div>
          <Btn variant="icon" size="sm" onClick={onClose}>
            <X size={16} />
          </Btn>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          {/* Feedback — a clear, single call to action (not a label). */}
          {onOpenFeedback && (
            <section className="mb-6 rounded-[3px] border border-line bg-bg-inset/40 px-4 py-3.5">
              <p className="label-cap text-ink-muted mb-1">{t('settings.feedback.heading')}</p>
              <p className="text-[11px] text-ink-subtle leading-relaxed mb-3">
                {t('settings.feedback.body')}
              </p>
              <button
                onClick={onOpenFeedback}
                className="inline-flex w-full items-center justify-center gap-2 rounded-[2px] border border-line-strong bg-bg px-4 py-2.5 text-[13px] text-ink transition-all duration-150 hover:border-accent hover:bg-bg-inset hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <MessageSquare size={14} strokeWidth={1.75} />
                {t('settings.feedback.button')}
              </button>
            </section>
          )}

          {/* Language */}
          <Section heading={t('settings.language.heading')} hint={t('settings.language.hint')}>
            <div
              role="group"
              aria-label={t('settings.language.heading')}
              className="inline-flex items-center gap-0 border border-line rounded-[3px] p-0.5"
            >
              {([
                ['en', t('toolbar.langEn')],
                ['ja', t('toolbar.langJa')],
              ] as [Lang, string][]).map(([value, label]) => {
                const active = lang === value
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setLang(value)}
                    aria-pressed={active}
                    className={[
                      'h-7 min-w-[44px] px-3 rounded-[2px] text-[12px] font-medium cursor-pointer transition-all duration-150',
                      'border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                      active
                        ? 'bg-accent text-bg-card border-accent'
                        : 'bg-transparent text-ink-muted border-line hover:bg-bg-inset hover:text-ink hover:border-line-strong',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </Section>

          {/* Display name — assignee identity on shared boards. Placeholder is
              the non-persisted git user.name suggestion. */}
          <Section heading={t('settings.displayName.heading')} hint={t('settings.displayName.hint')}>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={suggestedName ?? ''}
              className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
          </Section>

          {/* Owner-only inbox — only when the server can read submissions. */}
          {open && feedbackCanRead && <FeedbackInbox onSeen={onFeedbackSeen} />}

          {/* Advanced — working defaults; hidden until needed. */}
          <div className="mt-6 border-t border-line pt-4">
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="inline-flex items-center gap-1.5 label-cap text-ink-muted hover:text-ink transition-colors"
            >
              <ChevronRight
                size={13}
                className={'transition-transform duration-150 ' + (showAdvanced ? 'rotate-90' : '')}
              />
              {t('settings.advanced')}
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-6">
                {/* Default workspace */}
                <Section heading={t('settings.workspace.heading')} hint={t('settings.workspace.hint')} flush>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={defaultWorkspace}
                      onChange={(e) => setDefaultWorkspace(e.target.value)}
                      placeholder="/Users/you/projects"
                      className="flex-1 min-w-0 rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
                    />
                    <button
                      onClick={browse}
                      disabled={picking}
                      className="shrink-0 inline-flex items-center gap-1.5 rounded-[2px] border border-line-strong bg-bg-elevated px-3 py-2 label-cap text-ink-muted hover:text-ink hover:bg-bg-inset hover:border-ink-subtle disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {picking ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
                      {t('settings.workspace.browse')}
                    </button>
                  </div>
                </Section>

                {/* Claude Code CLI status (troubleshooting; the requirement itself
                    is taught in onboarding) */}
                <Section flush heading={
                  <span className="inline-flex items-center gap-1.5"><Terminal size={12} />{t('settings.cli.heading')}</span>
                } action={
                  <button
                    onClick={() => setClaudeNonce((n) => n + 1)}
                    className="label-cap text-ink-subtle hover:text-ink transition-colors"
                  >
                    {t('settings.cli.recheck')}
                  </button>
                }>
                  <div className="text-[11px] leading-relaxed">
                    {claudeProbe === null && (
                      <span className="inline-flex items-center gap-1 text-ink-subtle">
                        <Loader2 size={12} className="animate-spin" />
                        {t('settings.cli.checking')}
                      </span>
                    )}
                    {claudeProbe?.installed && (
                      <span className="inline-flex items-center gap-1 text-moss">
                        <Check size={12} strokeWidth={2.5} />
                        {claudeProbe.message}
                      </span>
                    )}
                    {claudeProbe && !claudeProbe.installed && (
                      <div className="inline-flex items-start gap-1 text-accent">
                        <AlertCircle size={12} className="mt-[2px] shrink-0" />
                        <span>{claudeProbe.message}</span>
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] text-ink-subtle leading-relaxed">{t('settings.cli.hint')}</p>
                </Section>
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
          <Btn variant="subtle" size="md" onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn variant="primary" size="md" onClick={save}>{t('common.save')}</Btn>
        </div>
      </div>
    </>
  )
}

// A titled settings block. `flush` drops the top divider/margin (used inside the
// Advanced group, which already provides its own spacing).
const Section = ({
  heading,
  hint,
  action,
  flush,
  children,
}: {
  heading: React.ReactNode
  hint?: string
  action?: React.ReactNode
  flush?: boolean
  children: React.ReactNode
}) => (
  <div className={flush ? '' : 'mt-6 border-t border-line pt-4'}>
    <div className="mb-2 flex items-center justify-between gap-2">
      <p className="label-cap text-ink-muted">{heading}</p>
      {action}
    </div>
    {children}
    {hint && <p className="mt-2 text-[11px] text-ink-subtle leading-relaxed">{hint}</p>}
  </div>
)

const FeedbackInbox = ({ onSeen }: { onSeen?: (latestCreatedAt: string | null) => void }) => {
  const { t } = useT()
  const [items, setItems] = useState<FeedbackItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
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
    api.api.feedback.list
      .$get()
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<FeedbackListResponse>
      })
      .then((data) => {
        if (!mounted.current) return
        const next = data.items ?? []
        setItems(next)
        setTruncated(!!data.truncated)
        onSeen?.(next[0]?.created_at ?? null)
      })
      .catch(() => {
        if (mounted.current) setError(t('settings.inbox.error'))
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
  }, [onSeen, t])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="flex items-center justify-between mb-2">
        <p className="label-cap text-ink-muted inline-flex items-center gap-1.5">
          <Inbox size={12} />
          {t('settings.inbox.heading')}
          {items && items.length > 0 && (
            <span className="text-ink-subtle">({items.length}{truncated ? '+' : ''})</span>
          )}
        </p>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1 label-cap text-ink-subtle hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          {t('settings.inbox.refresh')}
        </button>
      </div>

      {loading && !items && (
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-subtle">
          <Loader2 size={12} className="animate-spin" />
          {t('settings.inbox.loading')}
        </span>
      )}
      {error && (
        <div className="inline-flex items-start gap-1 text-[11px] text-accent">
          <AlertCircle size={12} className="mt-[2px] shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {items && items.length === 0 && !error && (
        <p className="text-[11px] text-ink-subtle leading-relaxed">{t('settings.inbox.empty')}</p>
      )}
      {items && items.length > 0 && (
        <ul className="space-y-2 max-h-[280px] overflow-y-auto -mx-1 px-1">
          {items.map((f) => (
            <li key={f.id} className="rounded-[2px] border border-line bg-bg p-3 leading-relaxed">
              <p className="text-[12px] text-ink whitespace-pre-wrap break-words">{f.message}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-ink-subtle">
                <span>{formatFeedbackDate(f.created_at)}</span>
                {f.email && (
                  <>
                    <span className="text-ink-faint">·</span>
                    <a href={`mailto:${f.email}`} className="font-mono text-ink-muted hover:text-ink transition-colors">{f.email}</a>
                  </>
                )}
                {f.app_version && (
                  <>
                    <span className="text-ink-faint">·</span>
                    <span className="font-mono">v{f.app_version}</span>
                  </>
                )}
                {f.os && (
                  <>
                    <span className="text-ink-faint">·</span>
                    <span className="font-mono">{f.os}</span>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {truncated && (
        <p className="mt-2 text-[10px] text-ink-faint leading-relaxed">{t('settings.inbox.truncated')}</p>
      )}
    </div>
  )
}

const formatFeedbackDate = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

