import { AlertCircle, Check, Flag, GitMerge, Loader2, Minus } from 'lucide-react'
import { RUN_KIND, type RunKind } from '@/lib/runStatus'

// One home for how a run's state is drawn. Every task row, run row and banner
// renders its status through these, so the look stays identical everywhere and
// a change lands in a single place.

/** The status icon for a run kind. Inherits `currentColor` — the caller tints. */
export const RunGlyph = ({ kind, size = 11 }: { kind: RunKind; size?: number }) => {
  if (kind === 'running')
    return <Loader2 size={size} strokeWidth={2.25} className="animate-spin" />
  if (kind === 'queued')
    return (
      <span
        className="rounded-full border border-current"
        style={{ width: size - 4, height: size - 4 }}
      />
    )
  if (kind === 'done') return <Check size={size} strokeWidth={3} />
  if (kind === 'review' || kind === 'skipped')
    return <Flag size={size - 1} strokeWidth={2.25} />
  if (kind === 'error') return <AlertCircle size={size} strokeWidth={2.5} />
  if (kind === 'overloaded') return <AlertCircle size={size} strokeWidth={2.5} />
  if (kind === 'merging') return <GitMerge size={size} strokeWidth={2} className="animate-spin" />
  if (kind === 'conflict') return <AlertCircle size={size} strokeWidth={2.5} />
  return <Minus size={size} strokeWidth={3} />
}

/** A bare status dot — the densest run indicator, for tight list rows. */
export const RunStatusDot = ({ kind }: { kind: RunKind }) => (
  <span
    title={RUN_KIND[kind].label}
    className={[
      'h-1.5 w-1.5 shrink-0 rounded-full',
      RUN_KIND[kind].dot,
      kind === 'running' ? 'run-pulse' : '',
    ].join(' ')}
  />
)

/** A run-status badge — glyph + label, tinted by the kind's palette colour. */
export const RunStatusBadge = ({
  kind,
  size = 11,
}: {
  kind: RunKind
  size?: number
}) => {
  const k = RUN_KIND[kind]
  return (
    <span
      className={['inline-flex items-center gap-1 label-cap', k.text].join(' ')}
    >
      <RunGlyph kind={kind} size={size} />
      {k.label}
    </span>
  )
}
