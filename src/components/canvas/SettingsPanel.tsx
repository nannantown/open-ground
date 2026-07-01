import { useCallback, useEffect, useRef, useState } from 'react'
import {
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
import { DialogHeader } from '@/components/ui/overlay'
import { Markdown } from '@/components/canvas/Markdown'
import { ModuleReviewInbox } from '@/components/canvas/modules/ModuleReviewInbox'
import { pickReleaseNotesLang } from '@/lib/releaseNotesLang'
import type {
  Settings,
  SettingsResponse,
  FeedbackItem,
  FeedbackListResponse,
  ReleaseNotesResponse,
} from '@/lib/types'
import type { Health } from '@/lib/healthSchema'
import { api } from '@/lib/api-client'
import { pickFolder } from '@/lib/pickFolder'
import { feedbackImageDataUrl } from '@/lib/feedbackImages'
import { useClaudeConnection } from '@/lib/useClaudeConnection'
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
  /** When true the server can read the module submission queue (owner build), so
   *  the "Tab submissions" review inbox shows. False on the public build. */
  moduleReviewCanReview?: boolean
  /** Called once the review inbox loads, with the newest submission's created_at. */
  onModuleSubmissionSeen?: (latestCreatedAt: string | null) => void
  /** Owner-only: when true, reveal the experiment toggles (Advanced). Resolved
   *  server-side from the og_roles owner role. Non-owners get false, so the
   *  toggles — and the very existence of the experiments — stay hidden. */
  experimentsEligible?: boolean
}

// Settings drawer. Deliberately minimal: only real preferences are visible
// (Language, Feedback). The setup prerequisite (Claude CLI) is taught in
// onboarding; the knobs with working defaults (workspace, a CLI re-check)
// live under Advanced so the surface stays calm.
// One owner-only experiment switch (segmented Off / On). Extracted so every
// experiment row shares the EXACT same interactive states (hover / pressed /
// focus-visible) instead of each re-declaring them — add a row by adding a
// caller, never by copying the button markup. Persists immediately via
// `onChange` (a discrete switch, not debounced text).
const ExperimentToggle = ({
  label,
  value,
  onChange,
  offLabel,
  onLabel,
}: {
  label: string
  value: boolean
  onChange: (next: boolean) => void
  offLabel: string
  onLabel: string
}) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-[13px] text-ink">{label}</span>
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center gap-0 border border-line rounded-[3px] p-0.5"
    >
      {([
        [false, offLabel],
        [true, onLabel],
      ] as [boolean, string][]).map(([v, l]) => {
        const active = value === v
        return (
          <button
            key={String(v)}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={active}
            className={[
              'h-7 min-w-[44px] px-3 rounded-[2px] text-[12px] font-medium cursor-pointer transition-all duration-150',
              'border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              active
                ? 'bg-accent text-bg-card border-accent'
                : 'bg-transparent text-ink-muted border-line hover:bg-bg-inset hover:text-ink hover:border-line-strong',
            ].join(' ')}
          >
            {l}
          </button>
        )
      })}
    </div>
  </div>
)

export const SettingsPanel = ({
  open,
  settings,
  onClose,
  onSave,
  onReload,
  feedbackCanRead = false,
  onFeedbackSeen,
  onOpenFeedback,
  moduleReviewCanReview = false,
  onModuleSubmissionSeen,
  experimentsEligible = false,
}: Props) => {
  const { t, lang, setLang } = useT()
  const [defaultWorkspace, setDefaultWorkspace] = useState(settings.defaultWorkspace ?? '')
  const [displayName, setDisplayName] = useState(settings.displayName ?? '')
  // Owner-only experiment toggles. Local state for instant feedback; persisted
  // immediately on toggle (below) and re-seeded from settings on open.
  const [swarmExp, setSwarmExp] = useState(settings.experiments?.swarm === true)
  const [sandboxExp, setSandboxExp] = useState(settings.experiments?.sandbox === true)
  // Non-persisted placeholder for the Display name input: the user's global
  // git identity, served by GET /api/settings as `suggestedDisplayName`.
  const [suggestedName, setSuggestedName] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [picking, setPicking] = useState(false)
  const [claudeNonce, setClaudeNonce] = useState(0)
  const claudeConn = useClaudeConnection(open && showAdvanced, claudeNonce)

  // --- Autosave plumbing ------------------------------------------------
  // The panel saves as you type (debounced) instead of via a Save button.
  // Local input state is the source of truth while editing: the persist step
  // reads the *latest* values from refs and normalizes (trim / '' → null)
  // only at write time, never touching the in-progress input value (IME-safe
  // — a composition is never interrupted by a round-tripped server value).
  const latest = useRef({ defaultWorkspace, displayName })
  latest.current = { defaultWorkspace, displayName }
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Persist now (if anything actually changed). Stable identity so effects
  // can depend on it without re-running.
  const flush = useCallback(() => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    const s = settingsRef.current
    const nextWorkspace = latest.current.defaultWorkspace.trim() || null
    // '' is saved explicitly (not dropped) so clearing the field clears the
    // setting through the server's merge-on-write.
    const nextName = latest.current.displayName.trim()
    if (nextWorkspace === (s.defaultWorkspace ?? null) && nextName === (s.displayName ?? '')) return
    onSaveRef.current({ ...s, defaultWorkspace: nextWorkspace, displayName: nextName })
  }, [])

  const schedulePersist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(flush, 500)
  }, [flush])

  // Flush on close (the open→false transition) and on unmount, so a pending
  // debounce is never lost.
  useEffect(() => {
    if (!open) flush()
  }, [open, flush])
  useEffect(() => () => flush(), [flush])

  // Re-seed from live settings only on the open→true transition (see the long
  // note kept below) so an in-session load() can't wipe unsaved edits.
  useEffect(() => {
    if (!open) return
    setDefaultWorkspace(settings.defaultWorkspace ?? '')
    setDisplayName(settings.displayName ?? '')
    setSwarmExp(settings.experiments?.swarm === true)
    setSandboxExp(settings.experiments?.sandbox === true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Set an owner-only experiment and persist immediately (a discrete switch, not
  // debounced text). Save the explicit value, preserving any pending
  // workspace/displayName edits via the same normalization flush uses — so
  // toggling never drops an in-progress text edit, and `{ ...s }` keeps every
  // other experiment flag intact.
  const setSwarm = (next: boolean) => {
    if (next === swarmExp) return
    setSwarmExp(next)
    const s = settingsRef.current
    onSaveRef.current({
      ...s,
      defaultWorkspace: latest.current.defaultWorkspace.trim() || null,
      displayName: latest.current.displayName.trim(),
      experiments: { ...s.experiments, swarm: next },
    })
  }

  const setSandbox = (next: boolean) => {
    if (next === sandboxExp) return
    setSandboxExp(next)
    const s = settingsRef.current
    onSaveRef.current({
      ...s,
      defaultWorkspace: latest.current.defaultWorkspace.trim() || null,
      displayName: latest.current.displayName.trim(),
      experiments: { ...s.experiments, sandbox: next },
    })
  }

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
      // Electron dialog under the desktop app (cross-platform); osascript route
      // in a plain dev browser — see src/lib/pickFolder.ts.
      const data = await pickFolder()
      if (data.path) {
        setDefaultWorkspace(data.path)
        // Discrete action — persist right away (the state set above hasn't
        // rendered yet, so go through the ref directly).
        latest.current = { ...latest.current, defaultWorkspace: data.path }
        flush()
      }
    } finally {
      // pickFolder never throws, but keep the spinner guaranteed-cleared.
      setPicking(false)
    }
  }

  return (
    <>
      <div
        aria-hidden={!open}
        onClick={onClose}
        // Stays mounted (opacity transition) - the esc-overlay tag must only
        // exist while actually open, or it would permanently swallow the
        // Board drawer's Escape.
        {...(open ? { 'data-esc-overlay': '' } : {})}
        className={[
          'fixed inset-0 z-overlay-modal bg-ink/30 backdrop-blur-sm transition-opacity duration-200 ease-out',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        className={[
          'fixed top-0 right-0 z-overlay-modal h-full w-[440px] max-w-[92vw]',
          'bg-bg-card border-l border-line shadow-card-hover flex flex-col',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
        ].join(' ')}
      >
        <DialogHeader
          align="baseline"
          eyebrow={t('settings.eyebrow')}
          title={<span style={{ fontVariationSettings: "'opsz' 24, 'SOFT' 40" }}>Settings</span>}
          titleClassName="font-display text-[22px] leading-none tracking-tightest text-ink"
          onClose={onClose}
          closeLabel={t('common.close')}
        />

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
              onChange={(e) => {
                setDisplayName(e.target.value)
                schedulePersist()
              }}
              onBlur={flush}
              placeholder={suggestedName ?? ''}
              className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
          </Section>

          {/* Owner-only inboxes — only when the server can read submissions. */}
          {open && feedbackCanRead && <FeedbackInbox onSeen={onFeedbackSeen} />}
          {open && moduleReviewCanReview && (
            <ModuleReviewInbox onSeen={onModuleSubmissionSeen} />
          )}

          {/* Release notes — what changed, per published version. */}
          {open && <ReleaseNotesSection />}

          {/* Current app version — always visible (not behind Advanced) so a user
              can confirm an update took effect. Reads GET /api/health. */}
          {open && <AppVersionSection />}

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
                      onChange={(e) => {
                        setDefaultWorkspace(e.target.value)
                        schedulePersist()
                      }}
                      onBlur={flush}
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

                {/* Claude connection status — passive reflection of the local
                    `claude` CLI (installed + signed in via `claude auth status`).
                    Informational only: OPEN GROUND never gates anything on it. */}
                <Section flush heading={
                  <span className="inline-flex items-center gap-1.5"><Terminal size={12} />{t('settings.connection.heading')}</span>
                } action={
                  <button
                    onClick={() => setClaudeNonce((n) => n + 1)}
                    className="label-cap text-ink-subtle hover:text-ink transition-colors"
                  >
                    {t('settings.connection.recheck')}
                  </button>
                }>
                  <div className="text-[11px] leading-relaxed">
                    {claudeConn === null && (
                      <span className="inline-flex items-center gap-1 text-ink-subtle">
                        <Loader2 size={12} className="animate-spin" />
                        {t('settings.connection.checking')}
                      </span>
                    )}
                    {claudeConn?.installed && claudeConn.loggedIn && (
                      <span className="inline-flex items-center gap-1 text-moss">
                        <Check size={12} strokeWidth={2.5} />
                        {t('settings.connection.connected')}
                        {claudeConn.plan && (
                          <span className="text-ink-subtle">
                            {' · '}{t('settings.connection.plan', { plan: claudeConn.plan })}
                          </span>
                        )}
                        {claudeConn.email && (
                          <span className="font-mono text-ink-subtle">{' · '}{claudeConn.email}</span>
                        )}
                      </span>
                    )}
                    {claudeConn && !claudeConn.installed && (
                      <div className="inline-flex items-start gap-1 text-accent">
                        <AlertCircle size={12} className="mt-[2px] shrink-0" />
                        <span>{t('settings.connection.notInstalled')}</span>
                      </div>
                    )}
                    {claudeConn?.installed && !claudeConn.loggedIn && (
                      <div className="inline-flex items-start gap-1 text-accent">
                        <AlertCircle size={12} className="mt-[2px] shrink-0" />
                        <span>{t('settings.connection.notSignedIn')}</span>
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] text-ink-subtle leading-relaxed">{t('settings.connection.hint')}</p>
                </Section>

                {/* Experiments — owner only (experimentsEligible from the
                    server's og_roles owner check). Hidden for everyone else, so
                    the toggles never betray the feature's existence. The same
                    segmented On/Off pattern as the language switch, persisted
                    immediately. */}
                {experimentsEligible && (
                  <Section
                    heading={t('settings.experiments.heading')}
                    hint={t('settings.experiments.hint')}
                  >
                    <div className="flex flex-col gap-3">
                      <ExperimentToggle
                        label={t('settings.experiments.swarm')}
                        value={swarmExp}
                        onChange={setSwarm}
                        offLabel={t('settings.experiments.off')}
                        onLabel={t('settings.experiments.on')}
                      />
                      <ExperimentToggle
                        label={t('settings.experiments.sandbox')}
                        value={sandboxExp}
                        onChange={setSandbox}
                        offLabel={t('settings.experiments.off')}
                        onLabel={t('settings.experiments.on')}
                      />
                    </div>
                  </Section>
                )}
              </div>
            )}
          </div>
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

// Collapsed-by-default disclosure listing every published release of the
// distribution repo, newest first, with its bilingual notes filtered to the
// active UI language. Fetch is lazy (first expand) — opening Settings costs
// no GitHub round-trip; the server caches the list for 10 minutes anyway.
const ReleaseNotesSection = () => {
  const { t, lang } = useT()
  const [expanded, setExpanded] = useState(false)
  const [data, setData] = useState<ReleaseNotesResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!expanded || data) return
    let cancelled = false
    setLoading(true)
    fetch('/api/release-notes')
      .then((res) => (res.ok ? (res.json() as Promise<ReleaseNotesResponse>) : null))
      .then((body) => {
        if (!cancelled && body) setData(body)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [expanded, data])

  return (
    <div className="mt-6 border-t border-line pt-4">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1.5 label-cap text-ink-muted hover:text-ink transition-colors"
      >
        <ChevronRight
          size={13}
          className={'transition-transform duration-150 ' + (expanded ? 'rotate-90' : '')}
        />
        {t('settings.releaseNotes.heading')}
      </button>

      {expanded && (
        <div className="mt-3">
          {loading && !data && (
            <span className="inline-flex items-center gap-1 text-[11px] text-ink-subtle">
              <Loader2 size={12} className="animate-spin" />
              {t('settings.releaseNotes.loading')}
            </span>
          )}
          {!loading && data && data.releases.length === 0 && (
            <div className="inline-flex items-start gap-1 text-[11px] text-accent">
              <AlertCircle size={12} className="mt-[2px] shrink-0" />
              <span>{t('settings.releaseNotes.error')}</span>
            </div>
          )}
          {data && data.releases.length > 0 && (
            <ul className="max-h-[320px] space-y-4 overflow-y-auto -mx-1 px-1">
              {data.releases.map((r) => (
                <li key={r.version} className="rounded-[2px] border border-line bg-bg p-3">
                  <div className="mb-1.5 flex items-baseline gap-2">
                    <span className="font-mono text-[12px] font-semibold text-ink">v{r.version}</span>
                    {r.version === data.current && (
                      <span className="rounded-[2px] border border-accent px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-accent">
                        {t('settings.releaseNotes.current')}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-ink-subtle">
                      {r.publishedAt.slice(0, 10)}
                    </span>
                  </div>
                  {r.body ? (
                    <div className="text-[12px] leading-relaxed">
                      <Markdown source={pickReleaseNotesLang(r.body, lang)} />
                    </div>
                  ) : (
                    <p className="text-[11px] text-ink-subtle">—</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// The running app's version, shown so a user can confirm an update took effect
// (e.g. after the auto-updater restarts the app). Reads GET /api/health, whose
// `version` is package.json inlined at build time — always the real running
// build, never a stale hard-coded value.
const AppVersionSection = () => {
  const { t } = useT()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then((res) => (res.ok ? (res.json() as Promise<Health>) : null))
      .then((body) => {
        if (!cancelled && body && typeof body.version === 'string') setVersion(body.version)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="mt-6 border-t border-line pt-4">
      <p className="label-cap text-ink-muted mb-1.5">{t('settings.version.heading')}</p>
      <p className="font-mono text-[12px] text-ink-subtle">
        OPEN GROUND{version ? ` v${version}` : ''}
      </p>
    </div>
  )
}

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
              {f.images && f.images.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {f.images.map((img, i) => (
                    <a
                      key={i}
                      href={feedbackImageDataUrl(img)}
                      target="_blank"
                      rel="noreferrer"
                      title={img.name || t('settings.inbox.imageAlt')}
                      className="block overflow-hidden rounded-[2px] border border-line transition-colors hover:border-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <img
                        src={feedbackImageDataUrl(img)}
                        alt={img.name || t('settings.inbox.imageAlt')}
                        loading="lazy"
                        className="h-16 w-16 object-cover"
                      />
                    </a>
                  ))}
                </div>
              )}
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

