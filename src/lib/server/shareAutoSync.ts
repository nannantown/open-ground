// shareAutoSync — the background engine that gives the git-shared Board a
// Notion-like feel: edits push themselves a few seconds after you stop, and a
// teammate's push applies itself moments later. No new infrastructure — the
// engine only decides WHEN to run the same gitShare primitives the Sync
// button uses; all git stays in gitShare.ts.
//
// THE ONE HARD RULE — code is sacred: the engine runs NOTHING automatic
// (no pull-rebase, no push) while any commit in @{upstream}..HEAD touches a
// path outside .openground/. Rebasing would silently rewrite the user's own
// commits; pushing would publish code they never chose to publish. In that
// state the engine parks in 'paused-code' and the UI falls back to the
// manual Sync button.
//
// Adaptive cadence (the 壁打ち decision, 2026-06-11): fetch every
// MIN_INTERVAL while there is activity (a fetch that moved refs, a local
// shared-data edit, a successful sync), decaying ×2 per idle round up to
// MAX_INTERVAL. Two people working at the same time converge on the tight
// interval; an idle evening costs one cheap ref-ping every 2 minutes.
//
// State lives on globalThis (tsx-watch reload safe, same idiom as the
// terminal pool). One in-flight tick per project, ever.

import type { ShareAutoStatus, ShareConflict, ShareSyncResult } from '../types'
import {
  aheadIsSharedOnly,
  fetchRemote,
  sharedAheadBehind,
  sharedDirty,
  shareSync,
} from './gitShare'
import { isShared } from './sharedData'

export const MIN_INTERVAL_MS = 15_000
export const MAX_INTERVAL_MS = 120_000
const PUSH_DEBOUNCE_MS = 5_000
// First tick after a project comes on the engine's radar — almost immediate,
// so opening a shared project pulls the latest without waiting a full round.
const FIRST_TICK_MS = 1_500

/** Pure cadence rule: activity snaps to the tight end, idleness backs off. */
export const nextInterval = (prev: number, activity: boolean): number =>
  activity ? MIN_INTERVAL_MS : Math.min(Math.max(prev, MIN_INTERVAL_MS) * 2, MAX_INTERVAL_MS)

interface AutoState {
  enabled: boolean
  mode: ShareAutoStatus['mode']
  intervalMs: number
  lastSyncAt: number | null
  pendingPush: boolean
  message?: string
  /** Last conflict set an auto round produced (the dialog's data on demand). */
  conflicts?: ShareConflict[]
  running: boolean
  fetchTimer: ReturnType<typeof setTimeout> | null
  pushTimer: ReturnType<typeof setTimeout> | null
}

const states: Map<string, AutoState> = ((
  globalThis as unknown as { __openground_share_auto?: Map<string, AutoState> }
).__openground_share_auto ??= new Map())

// Tests drive ticks by hand — scheduling timers there would leak into other
// tests and make assertions racy.
let schedulingEnabled = true
export const __setAutoSyncSchedulingForTests = (on: boolean): void => {
  schedulingEnabled = on
}
export const __resetAutoSyncForTests = (): void => {
  states.forEach((s) => {
    if (s.fetchTimer) clearTimeout(s.fetchTimer)
    if (s.pushTimer) clearTimeout(s.pushTimer)
  })
  states.clear()
}

const getState = (projectPath: string): AutoState => {
  let s = states.get(projectPath)
  if (!s) {
    s = {
      enabled: true,
      mode: 'live',
      intervalMs: MIN_INTERVAL_MS,
      lastSyncAt: null,
      pendingPush: false,
      running: false,
      fetchTimer: null,
      pushTimer: null,
    }
    states.set(projectPath, s)
  }
  return s
}

const schedule = (projectPath: string, delayMs: number): void => {
  if (!schedulingEnabled) return
  const s = getState(projectPath)
  if (s.fetchTimer) clearTimeout(s.fetchTimer)
  s.fetchTimer = setTimeout(() => {
    s.fetchTimer = null
    void autoSyncTick(projectPath)
  }, delayMs)
  // Never keep the node process alive just for a background ping.
  s.fetchTimer.unref?.()
}

/** Bring a project onto the engine's radar (idempotent). Called by the
 *  status route on every poll — also the channel that keeps the personal
 *  pref fresh. `enabled:false` parks the engine without forgetting state. */
export const ensureAutoSync = (projectPath: string, enabled: boolean): void => {
  const s = getState(projectPath)
  const wasEnabled = s.enabled
  s.enabled = enabled
  if (!enabled) {
    s.mode = 'disabled'
    if (s.fetchTimer) clearTimeout(s.fetchTimer)
    if (s.pushTimer) clearTimeout(s.pushTimer)
    s.fetchTimer = null
    s.pushTimer = null
    return
  }
  if (s.mode === 'disabled') s.mode = 'live'
  // Newly enabled (or first sighting): tick almost immediately.
  if (!wasEnabled || (!s.fetchTimer && !s.running)) schedule(projectPath, FIRST_TICK_MS)
}

/** A shared-data write just landed on disk (board card, notes, canvas).
 *  Debounce a push — several quick edits ride one commit — and treat it as
 *  activity for the fetch cadence. */
export const noteSharedWrite = (projectPath: string): void => {
  const s = getState(projectPath)
  s.pendingPush = true
  if (!s.enabled) return
  s.intervalMs = nextInterval(s.intervalMs, true)
  if (!schedulingEnabled) return
  if (s.pushTimer) clearTimeout(s.pushTimer)
  s.pushTimer = setTimeout(() => {
    s.pushTimer = null
    void autoSyncTick(projectPath)
  }, PUSH_DEBOUNCE_MS)
  s.pushTimer.unref?.()
}

/** The user ran a MANUAL sync (button / resolve dialog) — adopt its outcome
 *  so the auto state never contradicts what the user just saw. */
export const noteManualSync = (projectPath: string, result: ShareSyncResult): void => {
  const s = getState(projectPath)
  applyResult(s, result)
  if (s.enabled) schedule(projectPath, s.intervalMs)
}

const applyResult = (s: AutoState, r: ShareSyncResult): void => {
  if (r.ok) {
    s.mode = 'live'
    s.lastSyncAt = Date.now()
    s.pendingPush = false
    s.conflicts = undefined
    s.message = r.message
    s.intervalMs = nextInterval(s.intervalMs, true)
    return
  }
  if (r.conflict) {
    s.mode = 'conflict'
    s.conflicts = r.conflicts
    s.message = r.message
    return
  }
  switch (r.reason) {
    case 'rebase-in-progress':
    case 'merge-in-progress':
    case 'detached-head':
      s.mode = 'blocked'
      break
    case 'autostash-conflict':
      s.mode = 'error'
      break
    default:
      s.mode = 'error'
  }
  s.message = r.message
}

/** One engine round. Exported so tests drive it directly (no timers):
 *  fetch → decide → (maybe) sync → reschedule. Never throws. */
export const autoSyncTick = async (projectPath: string): Promise<void> => {
  const s = getState(projectPath)
  if (!s.enabled || s.running) return
  s.running = true
  try {
    // Still a shared project? (Unshare while the timer was armed.)
    if (!(await isShared(projectPath))) {
      states.delete(projectPath)
      return
    }

    const fetched = await fetchRemote(projectPath)
    if (fetched === null) {
      // Remote unreachable (offline / no remote): nothing to do but back off.
      // Pending local edits stay pending — they ship when the link returns.
      s.mode = 'offline'
      s.intervalMs = nextInterval(s.intervalMs, false)
      return
    }

    const { behind } = await sharedAheadBehind(projectPath)
    const dirty = s.pendingPush || (await sharedDirty(projectPath))
    if (behind === 0 && !dirty) {
      // In sync and idle.
      if (s.mode === 'offline' || s.mode === 'syncing') s.mode = 'live'
      if (s.mode === 'blocked') s.mode = 'live'
      s.intervalMs = nextInterval(s.intervalMs, fetched.changed)
      return
    }

    // Something to move — the code-is-sacred gate decides if WE may move it.
    if (!(await aheadIsSharedOnly(projectPath))) {
      s.mode = 'paused-code'
      // Keep watching at a moderate cadence; the user unblocks by pushing.
      s.intervalMs = nextInterval(s.intervalMs, false)
      return
    }

    s.mode = 'syncing'
    const result = await shareSync(projectPath)
    applyResult(s, result)
  } catch (e) {
    s.mode = 'error'
    s.message = e instanceof Error ? e.message : String(e)
  } finally {
    s.running = false
    if (s.enabled && states.has(projectPath)) schedule(projectPath, s.intervalMs)
  }
}

/** Status-route view of the engine (ShareStatus.auto). */
export const autoSyncSnapshot = (projectPath: string): ShareAutoStatus => {
  const s = states.get(projectPath)
  if (!s) {
    return {
      enabled: false,
      mode: 'disabled',
      lastSyncAt: null,
      pendingPush: false,
      intervalMs: MIN_INTERVAL_MS,
    }
  }
  return {
    enabled: s.enabled,
    mode: s.mode,
    lastSyncAt: s.lastSyncAt,
    pendingPush: s.pendingPush,
    intervalMs: s.intervalMs,
    ...(s.message ? { message: s.message } : {}),
  }
}

/** The conflict set the last auto round captured — the Sync button's click
 *  opens the resolution dialog from this without re-running a sync. */
export const autoSyncConflicts = (projectPath: string): ShareConflict[] | null =>
  states.get(projectPath)?.conflicts ?? null

/** Project unshared / removed — drop timers and state. */
export const stopAutoSync = (projectPath: string): void => {
  const s = states.get(projectPath)
  if (!s) return
  if (s.fetchTimer) clearTimeout(s.fetchTimer)
  if (s.pushTimer) clearTimeout(s.pushTimer)
  states.delete(projectPath)
}
