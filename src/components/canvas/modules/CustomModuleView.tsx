import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import type {
  CustomModuleDef,
  CustomModuleSourceResponse,
} from '@/lib/types'
import { buildScreenSrcdoc } from '@/lib/screenSrcdoc'
import { useClientLockdown } from '@/lib/lockdownClient'
import { localAppUrl } from '@/lib/localAppFrame'
import {
  attachFrameAnchor,
  detachFrameAnchor,
  setFrameSource,
  useCustomFrames,
  getCustomFramesSnapshot,
} from '@/components/canvas/modules/CustomFrameHost'

// Renders a custom tab (docs/CUSTOM_TABS_PLAN.md): the module's source.tsx /
// source.html runs inside the SAME sandboxed-iframe pipeline a Canvas screen
// uses (buildScreenSrcdoc — Babel transpile, design tokens, lucide shim,
// sandbox="allow-scripts" so the component can't reach the host page). While
// visible we poll the source's mtime and rebuild srcDoc when it changes.
// Editing happens outside the tab preview.
// The explicit NENE capability instead loads a fixed cross-origin document;
// an opaque srcDoc cannot request microphone permission (see localAppFrame).
//
// The iframe itself is NOT rendered here: it lives in CustomFrameHost (mounted
// once at App level) and is drawn over the anchor div this view provides, so a
// tab whose embedded app is playing audio can outlive this view (tab/project
// switches) without the iframe ever unmounting — see CustomFrameHost. This
// view stays the source-fetch / hot-reload driver, which also means the poll
// runs ONLY while the tab is visible: a hidden keep-alive frame keeps its last
// srcDoc untouched (a rebuild would reload the iframe and cut the audio).
//
// The preview owns the full tab width. No side terminal mounts or auto-spawns,
// including when an older version saved an open dock in localStorage.

const POLL_MS = 1500

/** Legacy identity retained only for explicit module-deletion cleanup. */
export const customModuleStorageId = (moduleId: string) =>
  `custom-module:${moduleId}`

export const CustomModuleView = ({
  module,
  projectPath,
}: {
  module: CustomModuleDef
  /** The project whose tab row hosts this view — stamped onto the hosted
   *  frame so letting go of the project (delete / remove / bulk) can tear
   *  down exactly the frames it owns (destroyFramesForProject). */
  projectPath: string
}) => {
  const { t } = useT()
  const [src, setSrc] = useState<CustomModuleSourceResponse | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // Live mirror for the poll's failure branch (an updater must stay pure).
  const srcRef = useRef(src)
  srcRef.current = src

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
  const localUrl = lockdown ? null : localAppUrl(module, window.location.origin)
  const [localReady, setLocalReady] = useState(() => !!getCustomFramesSnapshot().get(module.id)?.localAppUrl)
  // Keep the existing launcher while the local server is down. Once connected,
  // transient health failures must not replace an active recording document.
  useEffect(() => {
    if (!localUrl || localReady) return
    let cancelled = false
    const check = async () => {
      try {
        const r = await fetch(`${localUrl}songs-data.js`, { method: 'HEAD', signal: AbortSignal.timeout(3000) })
        if (!cancelled && r.ok) setLocalReady(true)
      } catch { /* The sandboxed launcher remains available. */ }
    }
    void check()
    const timer = window.setInterval(() => void check(), 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [localUrl, localReady])
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
    if (srcDoc !== null) setFrameSource(module.id, srcDoc, module.label, localReady ? localUrl : null)
  }, [srcDoc, module.id, module.label, localUrl, localReady])

  // Whether the hosted frame is already rendering content — if so, skip the
  // loading placeholder entirely (e.g. re-entering a tab that kept playing).
  const hostedFrames = useCustomFrames()
  const frameLive = hostedFrames.get(module.id)?.srcDoc != null

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
    </div>
  )
}
