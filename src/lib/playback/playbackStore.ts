import { useSyncExternalStore } from 'react'

// ─── Global media-playback store ────────────────────────────────────────────
// Which custom-tab modules are currently PLAYING AUDIO, keyed by module id.
// Fed by `og-playback` postMessages from embedded apps (e.g. the NENE Songs
// viewer inside the Songs custom tab — see CustomFrameHost, which resolves the
// message's source window to a hosted frame before reporting here). Consumed by
// three surfaces: the tab row's EQ badge (ViewTabs), the Ground card's
// "Playing" stamp (App → ProjectCard), and CustomFrameHost's keep-alive
// decision (a frame that is audibly playing survives leaving its tab).
//
// Liveness is heartbeat-based: the embedded app re-announces every few seconds
// while playing, and an entry whose beat goes stale is swept out. That way a
// killed server / crashed iframe can never leave a phantom "Playing" indicator
// (or an immortal keep-alive frame) behind.

export interface PlaybackInfo {
  /** Track title as self-reported by the embedded app (tooltip text). */
  title: string | null
  /** The project this audio "belongs to", self-reported by the embedded app
   *  (matched against Ground cards by name / folder basename in App). */
  projectName: string | null
}

/** The `og-playback` postMessage payload an embedded app sends to `window.top`
 *  whenever its play state changes, plus periodically while playing (the
 *  heartbeat). Sent with targetOrigin '*' — the sandboxed iframe chain runs on
 *  an opaque origin, so the sender cannot name us more precisely. */
export interface PlaybackMessage {
  type: 'og-playback'
  playing: boolean
  title?: string | null
  projectName?: string | null
  /** Free-form sender tag (e.g. 'nene-songs') — informational only. */
  app?: string
}

export const isPlaybackMessage = (d: unknown): d is PlaybackMessage => {
  if (typeof d !== 'object' || d === null) return false
  const m = d as Record<string, unknown>
  if (m.type !== 'og-playback' || typeof m.playing !== 'boolean') return false
  if (m.title != null && typeof m.title !== 'string') return false
  if (m.projectName != null && typeof m.projectName !== 'string') return false
  if (m.app != null && typeof m.app !== 'string') return false
  return true
}

/** A playing entry with no fresh beat for this long is considered dead. The
 *  sender heartbeats every ~5s, so 15s tolerates two dropped beats. */
const STALE_MS = 15_000
const SWEEP_MS = 5_000

// Snapshot holds ONLY currently-playing modules — absence means silence.
let playingByModule: ReadonlyMap<string, PlaybackInfo> = new Map()
// Beat times live OUTSIDE the snapshot so a heartbeat that changes nothing
// semantically keeps the snapshot identity (no re-render every 5 seconds).
const lastBeatMs = new Map<string, number>()
const listeners = new Set<() => void>()
let sweepTimer: ReturnType<typeof setInterval> | null = null

const notify = () => {
  listeners.forEach((l) => l())
}

export const clearPlayback = (moduleId: string): void => {
  lastBeatMs.delete(moduleId)
  if (!playingByModule.has(moduleId)) return
  const next = new Map(playingByModule)
  next.delete(moduleId)
  playingByModule = next
  notify()
}

export const reportPlayback = (moduleId: string, msg: PlaybackMessage): void => {
  if (!msg.playing) {
    clearPlayback(moduleId)
    return
  }
  lastBeatMs.set(moduleId, Date.now())
  const title = msg.title ?? null
  const projectName = msg.projectName ?? null
  const cur = playingByModule.get(moduleId)
  // Pure heartbeat (nothing semantically new) → beat recorded, snapshot kept.
  if (cur && cur.title === title && cur.projectName === projectName) return
  const next = new Map(playingByModule)
  next.set(moduleId, { title, projectName })
  playingByModule = next
  notify()
}

const sweep = () => {
  const now = Date.now()
  for (const id of Array.from(playingByModule.keys())) {
    if (now - (lastBeatMs.get(id) ?? 0) > STALE_MS) clearPlayback(id)
  }
}

export const subscribePlayback = (fn: () => void): (() => void) => {
  listeners.add(fn)
  // The stale sweeper runs only while someone is watching — no idle interval
  // in a window that never shows playback UI (and none at all in tests that
  // don't subscribe).
  if (!sweepTimer) sweepTimer = setInterval(sweep, SWEEP_MS)
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
  }
}

export const getPlaybackSnapshot = (): ReadonlyMap<string, PlaybackInfo> =>
  playingByModule

/** Currently-playing modules (moduleId → info). Snapshot identity only changes
 *  on semantic transitions (start/stop/title change), never on heartbeats. */
export const usePlayback = (): ReadonlyMap<string, PlaybackInfo> =>
  useSyncExternalStore(subscribePlayback, getPlaybackSnapshot)

/** Test-only: wipe module-level state between cases. */
export const __resetPlaybackForTest = (): void => {
  playingByModule = new Map()
  lastBeatMs.clear()
}
