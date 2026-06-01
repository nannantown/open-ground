import type { RunEntry } from './types'

// Shared run-status vocabulary — the kind classifier, palette, and small
// formatters used by ProjectPanel and ProjectCard. Keeping these in one place
// avoids the run-status logic drifting between call sites.

/** A run is "live" — started or queued, not yet settled. */
export const isLive = (status?: RunEntry['status']) =>
  status === 'running' || status === 'pending'

/** mm:ss for an elapsed millisecond span. */
export const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Compact local date+time for a chat round header. Today → `HH:MM`,
 * same year → `M/D HH:MM`, otherwise `YYYY/M/D HH:MM`. Keeps the meta line
 * short so it doesn't crowd the elapsed counter / status badge.
 */
export const fmtChatTime = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return hm
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  if (d.getFullYear() === now.getFullYear()) return `${md} ${hm}`
  return `${d.getFullYear()}/${md} ${hm}`
}

/**
 * For a finished run: did it truly close the task (`clean`), leave follow-up
 * work / hit blockers (`followup`), or skip the task (`skipped`)? Lets the UI
 * avoid showing a green "done" when the task is not actually complete.
 */
export const runOutcome = (
  entry: RunEntry,
): 'clean' | 'followup' | 'skipped' | undefined => {
  if (entry.status !== 'done') return undefined
  const pr = entry.parsedResult
  if (!pr) return 'clean'
  // Prefer the explicit completion signal — follow-ups are optional extras
  // and do not by themselves mean the task is unfinished.
  if (pr.taskComplete === true) return 'clean'
  if (pr.taskComplete === false) return 'followup'
  // Older runs without the signal — fall back to the heuristic.
  const norm = (s: string) => s.trim().toLowerCase()
  const title = entry.targetedTasks[0]?.title
  if (title && pr.skipped.some(s => norm(s) === norm(title))) return 'skipped'
  const hasFollowup = (pr.followups?.length ?? 0) > 0 || pr.blockers.trim() !== ''
  return hasFollowup ? 'followup' : 'clean'
}

/** The display kind of a run — a finished run that left work becomes "review". */
export type RunKind =
  | 'queued'
  | 'running'
  | 'done'
  | 'review'
  | 'skipped'
  | 'error'
  | 'overloaded'
  | 'cancelled'
  | 'merging'
  | 'conflict'

export const runKind = (entry: RunEntry): RunKind => {
  if (entry.status === 'pending') return 'queued'
  if (entry.status === 'running') return 'running'
  if (entry.mergeStatus === 'merging') return 'merging'
  if (entry.mergeStatus === 'conflict') return 'conflict'
  // 529 is Anthropic-side congestion, not a real run error. Showing the same
  // red "Error" badge makes the user think OPEN GROUND broke; give it its own state.
  if (entry.status === 'error' && entry.overloaded) return 'overloaded'
  if (entry.status === 'error') return 'error'
  if (entry.status === 'cancelled') return 'cancelled'
  const o = runOutcome(entry)
  return o === 'followup' ? 'review' : o === 'skipped' ? 'skipped' : 'done'
}

/** Colour (text, soft background, solid dot) and label per run kind. */
export const RUN_KIND: Record<
  RunKind,
  { text: string; wrap: string; dot: string; label: string }
> = {
  queued:     { text: 'text-ink-subtle', wrap: 'bg-bg-inset',    dot: 'bg-ink-subtle', label: 'Queued' },
  running:    { text: 'text-azure',      wrap: 'bg-azure-soft',  dot: 'bg-azure',      label: 'Running' },
  done:       { text: 'text-moss',       wrap: 'bg-moss-soft',   dot: 'bg-moss',       label: 'Done' },
  review:     { text: 'text-ochre',      wrap: 'bg-ochre-soft',  dot: 'bg-ochre',      label: 'Review' },
  skipped:    { text: 'text-ochre',      wrap: 'bg-ochre-soft',  dot: 'bg-ochre',      label: 'Skipped' },
  error:      { text: 'text-accent',     wrap: 'bg-accent-soft', dot: 'bg-accent',     label: 'Error' },
  overloaded: { text: 'text-ochre',      wrap: 'bg-ochre-soft',  dot: 'bg-ochre',      label: 'API混雑' },
  cancelled:  { text: 'text-ink-subtle', wrap: 'bg-bg-inset',    dot: 'bg-ink-faint',  label: 'Cancelled' },
  merging:    { text: 'text-azure',      wrap: 'bg-azure-soft',  dot: 'bg-azure',      label: 'Merging' },
  conflict:   { text: 'text-ochre',      wrap: 'bg-ochre-soft',  dot: 'bg-ochre',      label: 'Conflict' },
}
