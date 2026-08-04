import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type {
  CustomModuleDef,
  CustomModuleSourceResponse,
  CustomTabRole,
} from '@/lib/types'
import { buildScreenSrcdoc } from '@/lib/screenSrcdoc'
import { useClientLockdown } from '@/lib/lockdownClient'
import { TerminalDock } from '@/components/canvas/EmbeddedClaudeTerminal'
import {
  attachFrameAnchor,
  detachFrameAnchor,
  setFrameSource,
  useCustomFrames,
} from '@/components/canvas/modules/CustomFrameHost'

// Renders a custom tab (docs/CUSTOM_TABS_PLAN.md): the module's source.tsx /
// source.html runs inside the SAME sandboxed-iframe pipeline a Canvas screen
// uses (buildScreenSrcdoc — Babel transpile, design tokens, lucide shim,
// sandbox="allow-scripts" so the component can't reach the host page). While
// visible we poll the source's mtime and rebuild the srcDoc on change — that's
// the hot-reload loop the dock's claude session drives by saving source.tsx.
//
// The iframe itself is NOT rendered here: it lives in CustomFrameHost (mounted
// once at App level) and is drawn over the anchor div this view provides, so a
// tab whose embedded app is playing audio can outlive this view (tab/project
// switches) without the iframe ever unmounting — see CustomFrameHost. This
// view stays the source-fetch / hot-reload driver, which also means the poll
// runs ONLY while the tab is visible: a hidden keep-alive frame keeps its last
// srcDoc untouched (a rebuild would reload the iframe and cut the audio).
//
// Editing lives in the SAME right-edge TerminalDock Canvas and Board use — the
// collapsed rail expands into tabbed claude PTYs — except its sessions are
// cwd'd at the MODULE dir (server-resolved from the moduleId, so the
// validateProjectPath boundary stays untouched) and they auto-spawn: the dock's
// whole point here is "claude inside this tab". The header keeps only Publish
// (cosmetic gating; the server enforces roles); delete/uninstall live in the
// tab row's right-click menu (ViewTabs).

const POLL_MS = 1500

// claude reads bracketed-paste only once its line editor is up; pasting in the
// same tick as a fresh spawn can land in the boot noise. Same reasoning as the
// Board flow, where a human click naturally provides this gap.
const PASTE_AFTER_LAUNCH_MS = 1500

/** localStorage identity for a module's dock + PTY bindings — the module is
 *  global, so the same dock follows it across projects. ProjectPanel's delete
 *  flow tears this namespace down via killEmbeddedTerminals. */
export const customModuleStorageId = (moduleId: string) =>
  `custom-module:${moduleId}`

export const CustomModuleView = ({
  module,
  projectPath,
  role,
  setup,
  onSetupConsumed,
  onChanged,
}: {
  module: CustomModuleDef
  /** The project whose tab row hosts this view — stamped onto the hosted
   *  frame so letting go of the project (delete / remove / bulk) can tear
   *  down exactly the frames it owns (destroyFramesForProject). */
  projectPath: string
  role: CustomTabRole
  /** True right after this module was created: open the dock, spawn claude
   *  and paste the brush-up prompt (unsent). Consumed once. */
  setup?: boolean
  onSetupConsumed?: () => void
  /** The module def changed server-side (publish bumps version) — re-fetch. */
  onChanged: () => Promise<void> | void
}) => {
  const { t } = useT()
  const isOwner = role === 'owner'
  // Authoring — the sidebar claude session AND the header actions — is open to
  // testers too: a tester builds a tab locally, then SUBMITS it to the owner for
  // review (docs/CUSTOM_TABS_PLAN.md). Only role 'none' renders read-only.
  const canAuthor = role !== 'none'
  const [src, setSrc] = useState<CustomModuleSourceResponse | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // Publish/submit progress + inline notice (the panel has no toast system;
  // inline text next to the buttons is the established pattern).
  const [publishing, setPublishing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const onSetupConsumedRef = useRef(onSetupConsumed)
  onSetupConsumedRef.current = onSetupConsumed
  // Live mirror for the poll's failure branch (an updater must stay pure).
  const srcRef = useRef(src)
  srcRef.current = src
  // The create flow's one-shot brush-up paste: armed while `setup`, fired by
  // the dock's first ACTUAL spawn, then never again (a ref so StrictMode's
  // doubled effects and re-renders can't re-arm it).
  const pastePendingRef = useRef(canAuthor && !!setup)
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tell the parent the one-shot setup flag was adopted, so a later remount
  // of this tab opens plain.
  useEffect(() => {
    if (setup) onSetupConsumedRef.current?.()
    // Consume exactly once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(
    () => () => {
      if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current)
    },
    [],
  )

  // Source fetch + hot-reload poll: while the tab is visible, re-read every
  // POLL_MS (skipping hidden windows) and adopt the body only when mtimeMs
  // moved — an unchanged file never re-renders the iframe.
  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setLoadFailed(false)
    const tick = async (initial: boolean) => {
      if (!initial && document.hidden) return
      try {
        const r = await fetch(`/api/custom-modules/${module.id}/source`, {
          cache: 'no-store',
        })
        if (cancelled) return
        if (!r.ok) {
          // Surface only when we have nothing to show — a transient failure
          // mid-session keeps the last good render.
          if (srcRef.current === null) setLoadFailed(true)
          return
        }
        const body = (await r.json()) as CustomModuleSourceResponse
        if (cancelled) return
        setLoadFailed(false)
        setSrc(prev =>
          prev && prev.mtimeMs === body.mtimeMs ? prev : body,
        )
      } catch {
        // Offline / server restarting — keep the current render quietly.
      }
    }
    void tick(true)
    const iv = setInterval(() => void tick(false), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [module.id])

  // Work mode: a custom tab is exactly the third-party-code surface lockdown
  // must contain — swap in the explicit placeholder while it is on.
  const lockdown = useClientLockdown()
  const srcDoc = useMemo(
    () =>
      src === null
        ? null
        : buildScreenSrcdoc(src.source, module.framework, 'dark', undefined, { lockdown }),
    [src, module.framework, lockdown],
  )

  // ── Hosted-frame plumbing (CustomFrameHost) ──
  // Bind the module's persistent iframe to this tab body for as long as the
  // tab is visible; on unmount the host decides keep-alive (audio playing) vs
  // destroy (the old lifecycle). useLayoutEffect so the anchor is bound before
  // paint — a re-surfacing keep-alive frame snaps into place with no flash.
  const anchorRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = anchorRef.current
    if (!el) return
    attachFrameAnchor(module.id, el, module.label, projectPath)
    return () => detachFrameAnchor(module.id)
  }, [module.id, module.label, projectPath])

  // Feed the (re)built srcDoc to the hosted frame. Same-string feeds are
  // no-ops in the store, so re-opening an unchanged tab never reloads the
  // iframe — only an actual source edit does.
  useEffect(() => {
    if (srcDoc !== null) setFrameSource(module.id, srcDoc, module.label)
  }, [srcDoc, module.id, module.label])

  // Whether the hosted frame is already rendering content — if so, skip the
  // loading placeholder entirely (e.g. re-entering a tab that kept playing).
  const hostedFrames = useCustomFrames()
  const frameLive = hostedFrames.get(module.id)?.srcDoc != null

  // Spawner the dock uses instead of claude-in-project: the server resolves
  // the cwd from the moduleId (POST /api/terminal/custom-module) — no path
  // ever leaves the client.
  const launchModuleTerminal = useCallback(async (): Promise<string> => {
    const r = await fetch('/api/terminal/custom-module', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moduleId: module.id }),
    })
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as {
        claudeMissing?: boolean
        error?: string
      }
      throw new Error(
        body.claudeMissing
          ? t('customTabs.claudeNotFound')
          : body.error || t('customTabs.launchFailed'),
      )
    }
    const info = (await r.json()) as { id?: string }
    if (!info?.id) throw new Error(t('customTabs.launchFailed'))
    return info.id
  }, [module.id, t])

  // First create only: once the dock's spawn lands, inject the brush-up
  // prompt UNSENT (bracketed paste — the user reviews and presses Enter).
  const onDockLaunched = useCallback(
    (terminalId: string) => {
      if (!pastePendingRef.current) return
      pastePendingRef.current = false
      pasteTimerRef.current = setTimeout(() => {
        void fetch(`/api/terminal/${terminalId}/paste-custom-module`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ moduleId: module.id }),
        }).catch(() => {
          // Paste is a convenience — the user can always type; stay quiet.
        })
      }, PASTE_AFTER_LAUNCH_MS)
    },
    [module.id],
  )

  const publish = async () => {
    if (publishing) return
    setPublishing(true)
    setNotice(null)
    try {
      const r = await fetch(`/api/custom-modules/${module.id}/publish`, {
        method: 'POST',
      })
      const body = (await r.json().catch(() => ({}))) as {
        version?: number
        error?: string
        publishUnavailable?: boolean
      }
      if (!r.ok) {
        setNotice({
          kind: 'error',
          text: body.publishUnavailable
            ? t('customTabs.publishUnavailable')
            : t('customTabs.publishFailed', { error: body.error ?? `HTTP ${r.status}` }),
        })
        return
      }
      setNotice({
        kind: 'ok',
        text: t('customTabs.published', {
          version: String(body.version ?? (module.version ?? 0) + 1),
        }),
      })
      await onChanged() // pick up remoteId / publishedAt / version
    } catch {
      setNotice({
        kind: 'error',
        text: t('customTabs.publishFailed', { error: t('projectPanel.networkError') }),
      })
    } finally {
      setPublishing(false)
    }
  }

  // Tester action: submit the CURRENT source to the owner for review
  // (docs/CUSTOM_TABS_PLAN.md). The owner approves → it's published to the
  // marketplace. Reuses the inline-notice pattern; disabled until source loads.
  const submit = async () => {
    if (submitting || !src) return
    setSubmitting(true)
    setNotice(null)
    try {
      const r = await fetch('/api/module-submissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: module.label,
          description: module.description,
          framework: module.framework,
          source: src.source,
        }),
      })
      const body = (await r.json().catch(() => ({}))) as { error?: string }
      if (!r.ok) {
        setNotice({
          kind: 'error',
          text:
            r.status === 503
              ? t('customTabs.submitUnavailable')
              : t('customTabs.submitFailed', { error: body.error ?? `HTTP ${r.status}` }),
        })
        return
      }
      setNotice({ kind: 'ok', text: t('customTabs.submitted') })
    } catch {
      setNotice({
        kind: 'error',
        text: t('customTabs.submitFailed', { error: t('projectPanel.networkError') }),
      })
    } finally {
      setSubmitting(false)
    }
  }

  const headerBtn =
    'shrink-0 rounded-sm border border-line px-2.5 py-1 text-meta text-ink-muted transition-colors hover:bg-plane hover:text-ink active:bg-plane active:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {canAuthor && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-8 py-2">
            <span
              className="min-w-0 flex-1 truncate text-ui text-ink-muted"
              title={module.description || module.label}
            >
              {module.label}
              {typeof module.version === 'number' && (
                <span className="ml-1.5 font-mono text-micro text-ink-faint">
                  {t('customTabs.publishedBadge', { version: String(module.version) })}
                </span>
              )}
            </span>
            {notice && (
              <span
                role="status"
                title={notice.text}
                className={[
                  'max-w-[320px] truncate text-meta',
                  notice.kind === 'error' ? 'text-accent' : 'text-ink-faint',
                ].join(' ')}
              >
                {notice.text}
              </span>
            )}
            {/* owner publishes official modules; a tester submits the current
                source to the owner for review (then approve publishes it). */}
            {isOwner ? (
              <button
                type="button"
                onClick={() => void publish()}
                disabled={publishing}
                className={headerBtn}
              >
                {publishing && <Loader2 size={10} className="mr-1 inline animate-spin" />}
                {publishing ? t('customTabs.publishing') : t('customTabs.publish')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={submitting || !src}
                className={headerBtn}
              >
                {submitting && <Loader2 size={10} className="mr-1 inline animate-spin" />}
                {submitting ? t('customTabs.submitting') : t('customTabs.submit')}
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 bg-bg-deep">
          {/* The hosted iframe (CustomFrameHost) draws itself over this anchor
              while the tab is visible; the div only supplies the geometry. */}
          <div ref={anchorRef} className="relative h-full w-full">
            {!frameLive && (
              <div className="flex h-full items-center justify-center px-8 text-center text-ui text-ink-faint">
                {loadFailed
                  ? t('customTabs.sourceLoadFailed')
                  : t('customTabs.sourceLoading')}
              </div>
            )}
          </div>
        </div>
      </div>
      {canAuthor && (
        <TerminalDock
          key={`dock-custom-${module.id}`}
          projectPath=""
          storageId={customModuleStorageId(module.id)}
          context="custom"
          hint={t('customTabs.sidebarHint')}
          launchOverride={launchModuleTerminal}
          autoLaunch
          onLaunched={onDockLaunched}
          initialOpen={!!setup}
        />
      )}
    </div>
  )
}
