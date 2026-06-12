import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type {
  CustomModuleDef,
  CustomModuleSourceResponse,
  CustomTabRole,
} from '@/lib/types'
import { buildScreenSrcdoc } from '@/lib/screenSrcdoc'
import { TerminalDock } from '@/components/canvas/EmbeddedClaudeTerminal'

// Renders a custom tab (docs/CUSTOM_TABS_PLAN.md): the module's source.tsx /
// source.html runs inside the SAME sandboxed-iframe pipeline a Canvas screen
// uses (buildScreenSrcdoc — Babel transpile, design tokens, lucide shim,
// sandbox="allow-scripts" so the component can't reach the host page). While
// visible we poll the source's mtime and rebuild the srcDoc on change — that's
// the hot-reload loop the dock's claude session drives by saving source.tsx.
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
  role,
  setup,
  onSetupConsumed,
  onChanged,
}: {
  module: CustomModuleDef
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
  const [src, setSrc] = useState<CustomModuleSourceResponse | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // Publish progress + inline notice (the panel has no toast system; inline
  // text next to the buttons is the established pattern).
  const [publishing, setPublishing] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const onSetupConsumedRef = useRef(onSetupConsumed)
  onSetupConsumedRef.current = onSetupConsumed
  // Live mirror for the poll's failure branch (an updater must stay pure).
  const srcRef = useRef(src)
  srcRef.current = src
  // The create flow's one-shot brush-up paste: armed while `setup`, fired by
  // the dock's first ACTUAL spawn, then never again (a ref so StrictMode's
  // doubled effects and re-renders can't re-arm it).
  const pastePendingRef = useRef(isOwner && !!setup)
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

  const srcDoc = useMemo(
    () =>
      src === null
        ? null
        : buildScreenSrcdoc(src.source, module.framework, 'dark'),
    [src, module.framework],
  )

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

  const headerBtn =
    'shrink-0 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isOwner && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-8 py-2">
            <span
              className="min-w-0 flex-1 truncate text-[12px] text-ink-muted"
              title={module.description || module.label}
            >
              {module.label}
              {typeof module.version === 'number' && (
                <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
                  {t('customTabs.publishedBadge', { version: String(module.version) })}
                </span>
              )}
            </span>
            {notice && (
              <span
                role="status"
                title={notice.text}
                className={[
                  'max-w-[320px] truncate text-[11px]',
                  notice.kind === 'error' ? 'text-accent' : 'text-ink-faint',
                ].join(' ')}
              >
                {notice.text}
              </span>
            )}
            <button
              type="button"
              onClick={() => void publish()}
              disabled={publishing}
              className={headerBtn}
            >
              {publishing && (
                <Loader2 size={10} className="mr-1 inline animate-spin" />
              )}
              {publishing ? t('customTabs.publishing') : t('customTabs.publish')}
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 bg-bg-deep">
          {srcDoc !== null ? (
            // Same sandbox as Canvas screens/mocks: scripts only, no
            // same-origin — the custom component can't touch the host page.
            <iframe
              title={module.label}
              sandbox="allow-scripts"
              srcDoc={srcDoc}
              className="h-full w-full border-0"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-8 text-center text-[12px] text-ink-faint">
              {loadFailed
                ? t('customTabs.sourceLoadFailed')
                : t('customTabs.sourceLoading')}
            </div>
          )}
        </div>
      </div>
      {isOwner && (
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
