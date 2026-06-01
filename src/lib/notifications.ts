import type { RunSession } from './types'
import { runKind } from './runStatus'

export interface NotifyOptions {
  enabled: boolean
  sound: boolean
  /** True when the user is currently looking at this project's panel — skip
   *  the notification then (they can already see the run). */
  isViewingProject?: (projectId: string) => boolean
  /** Click handler — pull focus back and surface the run. */
  onPick?: (projectId: string, taskId: string | undefined) => void
}

const KIND_GLYPH: Record<string, string> = {
  done: '✓',
  needs_followup: '✓',
  blocker: '⚠',
  error: '✗',
  cancelled: '·',
  running: '·',
  pending: '·',
}

// Brief, friendly tone — pleasant 660→880 Hz chirp, ~180 ms.
let audioCtx: AudioContext | null = null
const playPop = () => {
  try {
    audioCtx ??= new (window.AudioContext || (window as any).webkitAudioContext)()
    const ctx = audioCtx
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(660, now)
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.08)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.2)
  } catch {
    /* audio unavailable — silent fallback */
  }
}

// Browsers gate Notification.requestPermission to a user gesture; call this
// from a click handler (e.g. the first Run). Idempotent.
export const ensureNotifyPermission = () => {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
}

/** Fire a desktop notification for the just-finished run, with the sound. */
export const notifyRunFinished = (session: RunSession, opts: NotifyOptions) => {
  if (!opts.enabled) return
  const entry = session.entries[0]
  if (!entry) return
  // Skip if the user is actively looking at this project — the dock + thread
  // already shows the result, double-prompting would be noise.
  if (opts.isViewingProject?.(entry.projectId)) return
  if (typeof document !== 'undefined' && document.hasFocus() && opts.isViewingProject?.(entry.projectId)) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    // Still play the sound if the user opted in — useful even without notif perms.
    if (opts.sound) playPop()
    return
  }
  const kind = runKind(entry)
  const glyph = KIND_GLYPH[kind] ?? '·'
  const taskTitle = entry.targetedTasks[0]?.title ?? entry.projectName
  const summary = entry.parsedResult?.summary?.trim()
  const blocker = entry.parsedResult?.blockers?.trim()
  const body = [
    taskTitle,
    blocker ? `⚠ ${truncate(blocker, 90)}` : summary ? truncate(summary, 110) : null,
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const n = new Notification(`${glyph} ${entry.projectName}`, {
      body,
      tag: `hove-run-${session.id}`,
    })
    n.onclick = () => {
      window.focus()
      opts.onPick?.(entry.projectId, entry.targetedTasks[0]?.id)
      n.close()
    }
  } catch {
    /* Notification constructor blew up — sound alone */
  }
  if (opts.sound) playPop()
}

const truncate = (s: string, n: number) =>
  s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'
