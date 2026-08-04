import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import {
  clearPlayback,
  getPlaybackSnapshot,
  isPlaybackMessage,
  reportPlayback,
  usePlayback,
} from '@/lib/playback/playbackStore'
import { PlaybackEq } from '@/components/canvas/PlaybackEq'

// ─── Persistent host for custom-tab iframes ─────────────────────────────────
// A custom tab's sandboxed iframe used to live INSIDE CustomModuleView, so
// switching tab (or project, or back to Ground) unmounted it — killing any
// audio the embedded app was playing (the Songs tab wraps the NENE player).
// Browsers reload an iframe on ANY reparenting, so "move it somewhere safe on
// unmount" is impossible; the only way to keep it alive is to never move it.
//
// So the iframe now lives HERE, in a host mounted once at App level, for the
// custom tab's whole lifecycle — and CustomModuleView renders only a
// placeholder ("anchor") div in the tab body. While the tab is visible the
// hosted iframe is drawn position:fixed over the anchor's rect (tracked via
// ResizeObserver + window resize; the tab body is statically laid out, so
// those two cover every geometry change — dock open/close, window resize).
// When the tab goes away:
//   - not playing audio → the frame is destroyed (exactly the old lifecycle);
//   - playing audio     → the frame stays mounted but display:none, so the
//     audio keeps flowing across tab/project switches. display:none does not
//     pause HTML5 media; only unmounting does.
// A hidden frame that stops playing is destroyed after a short grace period
// (so "pause, wander off, come back and resume" survives, but nothing lives
// hidden forever). Liveness is guarded by the playback store's heartbeat
// staleness sweep, so a crashed iframe can't pin itself alive.
//
// The host also owns the `og-playback` message intake: the embedded app posts
// to window.top with targetOrigin '*' (its sandbox chain runs on an opaque
// origin), so instead of trusting origins we verify the SENDER — the event's
// source window must sit inside one of our hosted iframes (walking
// `source.parent` up; window identity comparison is allowed cross-origin).
// A message from any other surface (Canvas mock screens etc.) never matches.

export interface HostedCustomFrame {
  moduleId: string
  label: string
  /** Built srcDoc (null until CustomModuleView's first source fetch lands —
   *  the host renders nothing for a srcDoc-less frame). */
  srcDoc: string | null
  /** The tab body placeholder to draw over; null = keep-alive (hidden). */
  anchor: HTMLElement | null
  /** When this frame went hidden (anchor dropped) — null while visible. Drives
   *  the per-frame silence grace AND the hidden hard cap below. */
  hiddenSince: number | null
  /** The project whose tab this frame was (last) opened from — the owner of
   *  any audio it keeps playing. Every way of letting go of that project
   *  (delete, remove-from-Ground, the bulk bar) tears its frames down via
   *  destroyFramesForProject; re-opening the module from a DIFFERENT project
   *  takes the frame over fresh instead of surfacing this project's session. */
  projectPath: string
}

/** How long a HIDDEN, no-longer-playing frame survives before it's destroyed.
 *  Long enough to pause the music, work elsewhere and resume; short enough
 *  that a stopped player doesn't haunt memory forever. */
export const KEEPALIVE_GRACE_MS = 5 * 60_000

/** Absolute ceiling on how long ANY frame may live hidden — even with fresh
 *  playback heartbeats. A malicious/buggy embedded app could forge
 *  playing:true forever to keep itself running invisibly; this cap (plus the
 *  always-on background indicator below) bounds that to a window the user can
 *  see and end. Re-opening the tab resets it (the frame becomes visible). */
export const HIDDEN_HARD_CAP_MS = 2 * 60 * 60_000

let frames: ReadonlyMap<string, HostedCustomFrame> = new Map()
const frameListeners = new Set<() => void>()

const notifyFrames = () => {
  frameListeners.forEach((l) => l())
}

const subscribeFrames = (fn: () => void): (() => void) => {
  frameListeners.add(fn)
  return () => frameListeners.delete(fn)
}

export const getCustomFramesSnapshot = (): ReadonlyMap<string, HostedCustomFrame> =>
  frames

/** All hosted frames (visible + keep-alive). CustomModuleView uses this to know
 *  whether its module already has a live frame (skip the loading state). */
export const useCustomFrames = (): ReadonlyMap<string, HostedCustomFrame> =>
  useSyncExternalStore(subscribeFrames, getCustomFramesSnapshot)

/** Tab shown: bind the module's frame to this placeholder. An existing
 *  keep-alive frame from the SAME project re-surfaces as-is (same iframe,
 *  audio uninterrupted). One left over from a DIFFERENT project (the module is
 *  global and can be attached to several) is torn down and replaced fresh —
 *  surfacing another project's live session (its audio, its state) under this
 *  project's tab would cross the streams. */
export const attachFrameAnchor = (
  moduleId: string,
  anchor: HTMLElement,
  label: string,
  projectPath: string,
): void => {
  const cur = frames.get(moduleId)
  const carryOver = cur && cur.projectPath === projectPath ? cur : undefined
  if (cur && !carryOver) clearPlayback(moduleId)
  const next = new Map(frames)
  next.set(
    moduleId,
    carryOver
      ? { ...carryOver, anchor, label, hiddenSince: null }
      : { moduleId, label, srcDoc: null, anchor, hiddenSince: null, projectPath },
  )
  frames = next
  notifyFrames()
}

/** Source (re)built by CustomModuleView's fetch/hot-reload poll. Same string →
 *  no-op, so re-opening an unchanged tab never reloads the iframe (React only
 *  touches the srcDoc attribute when the value actually differs). */
export const setFrameSource = (
  moduleId: string,
  srcDoc: string,
  label: string,
): void => {
  const cur = frames.get(moduleId)
  if (!cur) return // detached before the fetch landed — nothing to feed
  if (cur.srcDoc === srcDoc && cur.label === label) return
  const next = new Map(frames)
  next.set(moduleId, { ...cur, srcDoc, label })
  frames = next
  notifyFrames()
}

/** Tab hidden (unmounted): keep the frame alive only while its module is
 *  audibly playing; otherwise destroy it — the pre-host lifecycle. */
export const detachFrameAnchor = (moduleId: string): void => {
  const cur = frames.get(moduleId)
  if (!cur) return
  const next = new Map(frames)
  if (getPlaybackSnapshot().has(moduleId)) {
    next.set(moduleId, { ...cur, anchor: null, hiddenSince: Date.now() })
  } else {
    next.delete(moduleId)
    clearPlayback(moduleId)
  }
  frames = next
  notifyFrames()
}

export const destroyFrame = (moduleId: string): void => {
  if (!frames.has(moduleId)) return
  const next = new Map(frames)
  next.delete(moduleId)
  frames = next
  clearPlayback(moduleId)
  notifyFrames()
}

/** Destroy the module's frame ONLY if it belongs to this project. The guard
 *  matters for per-project intents (detaching a tab): the same module may be
 *  live from ANOTHER project's tab — that session isn't ours to kill. Library
 *  deletion keeps using the unguarded destroyFrame (the module itself dies). */
export const destroyFrameIfProject = (
  moduleId: string,
  projectPath: string,
): void => {
  const f = frames.get(moduleId)
  if (f && f.projectPath === projectPath) destroyFrame(moduleId)
}

/** Tear down every frame opened from this project — audio started there must
 *  not outlive letting the project go. ONE entry point for all of them:
 *  panel delete, "Remove from Ground" (App), and the bulk bar's per-project
 *  successes. Callers outside the panel hold no project→module mapping, which
 *  is exactly why the frame carries its projectPath. */
export const destroyFramesForProject = (projectPath: string): void => {
  for (const f of Array.from(frames.values())) {
    if (f.projectPath === projectPath) destroyFrame(f.moduleId)
  }
}

/** Test-only: wipe module-level state between cases. */
export const __resetCustomFramesForTest = (): void => {
  frames = new Map()
  frameElements.clear()
}

// Live iframe elements by module id — the message intake resolves a sender
// against these. A plain module-level registry (not React state): it changes
// only via ref callbacks and is read only inside event handlers.
const frameElements = new Map<string, HTMLIFrameElement>()

/** Does `target` appear in `source`'s window.parent chain (source included)?
 *  Cross-origin windows expose `parent` and allow identity comparison, so this
 *  works through the sandbox chain (top ← sandbox srcdoc ← embedded app). */
export const windowChainContains = (
  source: unknown,
  target: Window | null,
): boolean => {
  if (!target || source == null || typeof source !== 'object') return false
  let w = source as Window
  for (let depth = 0; depth < 10; depth++) {
    if (w === target) return true
    let parent: Window | null
    try {
      parent = w.parent
    } catch {
      return false
    }
    if (!parent || parent === w) return false
    w = parent
  }
  return false
}

/** Which hosted frame (if any) does this message sender live inside? */
export const resolveFrameModuleId = (source: unknown): string | null => {
  for (const [id, el] of Array.from(frameElements)) {
    if (windowChainContains(source, el.contentWindow)) return id
  }
  return null
}

const rectsEqual = (
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height

const HostedFrame = ({
  frame,
  covered,
}: {
  frame: HostedCustomFrame
  /** An overlay dialog is open somewhere ([data-esc-overlay]) — hide the frame
   *  for the duration so the dialog is never buried under it. display:none
   *  keeps the audio running; this is the same mechanism as keep-alive. */
  covered: boolean
}) => {
  const [rect, setRect] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const anchor = frame.anchor
  const elRef = useRef<HTMLIFrameElement | null>(null)

  useLayoutEffect(() => {
    if (!anchor) {
      setRect(null)
      return
    }
    const measure = () => {
      const r = anchor.getBoundingClientRect()
      const next = { left: r.left, top: r.top, width: r.width, height: r.height }
      setRect((prev) => (prev && rectsEqual(prev, next) ? prev : next))
    }
    measure()
    // The tab body is static layout (no scrolling ancestors), so its rect only
    // moves when its SIZE changes (dock/header reflow) or the window resizes.
    const ro = new ResizeObserver(measure)
    ro.observe(anchor)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [anchor])

  const visible = anchor !== null && rect !== null && !covered

  // Redisplay after keep-alive (hidden → visible): the embedded app's own
  // keydown forwarder (Songs tab's source.tsx) only wires up once ITS window
  // gets a 'focus' event — but going display:none→visible again never fires
  // one on its own (unlike the initial mount, which the module's iframe
  // onLoad already covers). Re-focusing the outer hosted iframe here is what
  // triggers that 'focus' event, so keyboard shortcuts (Space, etc.) work
  // again without an extra click. Skipped on the FIRST visible render (ref
  // starts null) so a brand-new frame's initial-open behaviour is unchanged —
  // only a real hidden→visible transition should steal focus.
  const wasVisibleRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (wasVisibleRef.current === false && visible) {
      elRef.current?.focus()
    }
    wasVisibleRef.current = visible
  }, [visible])

  if (frame.srcDoc === null) return null
  return (
    <iframe
      ref={(el) => {
        elRef.current = el
        if (el) frameElements.set(frame.moduleId, el)
        else frameElements.delete(frame.moduleId)
      }}
      title={frame.label}
      // Same sandbox as before the host existed (and as Canvas screens/mocks):
      // scripts only, no same-origin — the custom component can't reach us.
      sandbox="allow-scripts"
      srcDoc={frame.srcDoc}
      // z sits between the project panel (40) and app modals (50) — see
      // tailwind.config.ts zIndex scale — so the frame covers the tab body it
      // is anchored to, while panel popups (portaled to body at modal z) and
      // every app-level modal still open above it.
      className="z-overlay-frame border-0"
      style={
        visible
          ? {
              position: 'fixed',
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            }
          : // Hidden keep-alive: display:none never pauses HTML5 media — the
            // audio pipeline keeps running; only unmounting would kill it.
            { position: 'fixed', left: 0, top: 0, display: 'none' }
      }
    />
  )
}

/** Mounted ONCE in App (never conditionally — a remount would reload every
 *  frame). Renders all hosted frames and owns playback intake + keep-alive GC. */
export const CustomFrameHost = () => {
  const hosted = useCustomFrames()
  const playback = usePlayback()

  // `og-playback` intake: verify the sender is one of OUR hosted frames, then
  // report into the global playback store (which the tab row / Ground cards /
  // the GC below all subscribe to).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isPlaybackMessage(e.data)) return
      const moduleId = resolveFrameModuleId(e.source)
      if (!moduleId) return
      reportPlayback(moduleId, e.data)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Is any overlay dialog open? Every <Overlay> surface (panel dialogs at
  // layer 'local', pickers, app modals…) marks its root [data-esc-overlay] —
  // the same contract App's global Escape handler keys on. While one exists,
  // every VISIBLE frame drops to display:none (audio unaffected) so a dialog
  // can never be buried under the z-45 iframe — a 'local'-layer (z 20) dialog
  // has no z that could beat it, and enumerating dialog call sites would rot.
  // Watched via MutationObserver; the callback is cheap (one querySelector,
  // state write skipped when unchanged).
  const [overlayUp, setOverlayUp] = useState(false)
  useEffect(() => {
    const check = () =>
      setOverlayUp(document.querySelector('[data-esc-overlay]') !== null)
    check()
    const mo = new MutationObserver(check)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])

  // Keep-alive GC, per frame:
  //  - silence grace: hidden AND silent for a CONTINUOUS KEEPALIVE_GRACE_MS →
  //    destroy. The silence start is pinned in a ref, so effect re-runs caused
  //    by OTHER frames (or a track change elsewhere) never reset an in-flight
  //    grace window; only this frame turning audible or visible clears it.
  //  - hidden hard cap: hidden for HIDDEN_HARD_CAP_MS → destroy regardless of
  //    heartbeats (see the cap's rationale above). Anchored to hiddenSince,
  //    which only re-opening the tab resets.
  const silentSinceRef = useRef(new Map<string, number>())
  useEffect(() => {
    const silentSince = silentSinceRef.current
    const now = Date.now()
    // Drop tracking for frames that no longer exist.
    for (const id of Array.from(silentSince.keys())) {
      if (!hosted.has(id)) silentSince.delete(id)
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const f of Array.from(hosted.values())) {
      if (f.anchor !== null) {
        silentSince.delete(f.moduleId)
        continue
      }
      const capDeadline = (f.hiddenSince ?? now) + HIDDEN_HARD_CAP_MS
      let deadline = capDeadline
      if (playback.has(f.moduleId)) {
        silentSince.delete(f.moduleId)
      } else {
        const since = silentSince.get(f.moduleId) ?? now
        silentSince.set(f.moduleId, since)
        deadline = Math.min(capDeadline, since + KEEPALIVE_GRACE_MS)
      }
      timers.push(
        setTimeout(() => destroyFrame(f.moduleId), Math.max(0, deadline - now)),
      )
    }
    return () => timers.forEach(clearTimeout)
  }, [hosted, playback])

  if (hosted.size === 0) return null
  const hiddenFrames = Array.from(hosted.values()).filter((f) => f.anchor === null)
  return (
    <>
      {Array.from(hosted.values()).map((f) => (
        // Keyed by module id and rendered in Map insertion order: additions
        // append, removals splice — existing siblings never REORDER in the
        // DOM. That matters: moving an iframe node reloads it.
        <HostedFrame key={f.moduleId} frame={f} covered={overlayUp} />
      ))}
      {/* Always-on background-audio indicator: whenever ANY frame lives on
          hidden (keep-alive), name it here — bottom-centre, visible from the
          Ground and every tab — with a stop button that destroys the frame
          outright. Together with the hidden hard cap this bounds what a forged
          playing:true heartbeat could buy: nothing runs hidden unlisted, and
          nothing runs hidden forever. */}
      {hiddenFrames.length > 0 && (
        <div className="pointer-events-none fixed bottom-3 left-1/2 z-overlay-frame -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-bg-card/95 px-3 py-1.5 shadow-card backdrop-blur">
            {hiddenFrames.map((f) => {
              const p = playback.get(f.moduleId)
              return (
                <span
                  key={f.moduleId}
                  title={p?.title ?? f.label}
                  className="flex items-center gap-1.5 text-meta font-medium text-ink-muted"
                >
                  {p && (
                    <span className="text-accent">
                      <PlaybackEq size={9} />
                    </span>
                  )}
                  <span>{f.label}</span>
                  <button
                    type="button"
                    onClick={() => destroyFrame(f.moduleId)}
                    title="Stop background audio"
                    aria-label={`Stop ${f.label}`}
                    className="rounded-full p-0.5 text-ink-faint transition-colors hover:bg-plane hover:text-ink active:bg-plane active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <X size={10} strokeWidth={2.25} />
                  </button>
                </span>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
