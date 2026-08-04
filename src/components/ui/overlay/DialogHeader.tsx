import { ReactNode } from 'react'
import { BackLink } from '@/components/ui/BackLink'
import { CloseButton } from './CloseButton'

function cx(...cs: (string | false | null | undefined)[]) {
  return cs.filter(Boolean).join(' ')
}

/** Separator under the header — `double` is the cartographic house style. */
const SEPARATOR = {
  double: 'rule-double',
  line: 'border-b border-line',
  none: '',
} as const
type Separator = keyof typeof SEPARATOR

/** Header padding. One of a small fixed set so every header reads the same. */
const DENSITY = {
  /** Back/Close-only or otherwise compact bars. */
  bar: 'px-4 py-2.5',
  /** Full-screen panel headers. */
  panel: 'px-5 py-3',
  /** Centred-modal card headers. */
  modal: 'px-6 pt-5 pb-4',
} as const
type Density = keyof typeof DENSITY

const ALIGN = {
  start: 'items-start',
  center: 'items-center',
  baseline: 'items-baseline',
} as const
type Align = keyof typeof ALIGN

/**
 * The shared header chrome for overlay surfaces: a `Back` affordance on the left,
 * an optional eyebrow + title, optional actions, and a `Close` ✕ on the right —
 * all in one bar with a consistent separator + padding. Replaces the per-surface
 * hand-rolled header blocks (each picking its own `<ArrowLeft>`/`<X>`, padding,
 * and separator) so Invite / settings / Skills / manual read as the same shell.
 *
 * Slots, left → right:
 * - `onBack` (+ `backLabel`)  → a shared `BackLink`
 * - `leading`                  → custom left content (e.g. a brand mark). When
 *                                given it REPLACES the eyebrow/title block.
 * - `eyebrow` / `title`        → the standard label-cap + display-title pair
 * - `actions`                  → custom right content before the close button
 * - `onClose` (+ `closeLabel`) → a shared `CloseButton`
 *
 * For a header too bespoke for these slots (functional control clusters), pass
 * `children`: it fills the bar while still inheriting the shared separator +
 * padding, so even custom headers get their chrome from one place.
 */
export function DialogHeader({
  onBack,
  backLabel,
  leading,
  eyebrow,
  title,
  titleClassName,
  actions,
  onClose,
  closeLabel,
  closeDisabled,
  separator = 'double',
  density = 'modal',
  align = 'start',
  className,
  children,
}: {
  onBack?: () => void
  backLabel?: string
  leading?: ReactNode
  eyebrow?: ReactNode
  title?: ReactNode
  titleClassName?: string
  actions?: ReactNode
  onClose?: () => void
  closeLabel?: string
  /** Disable the close ✕ (e.g. while a non-cancellable op is mid-flight). */
  closeDisabled?: boolean
  separator?: Separator
  density?: Density
  align?: Align
  className?: string
  children?: ReactNode
}): JSX.Element {
  const bar = cx('flex shrink-0', SEPARATOR[separator], DENSITY[density], className)

  if (children) {
    return <header className={cx(bar, ALIGN[align])}>{children}</header>
  }

  const titleBlock = leading ?? (
    (eyebrow || title) && (
      <div className="min-w-0">
        {eyebrow && (
          <div className="label-cap mb-1.5 flex items-center gap-1.5 text-accent">{eyebrow}</div>
        )}
        {title && (
          <h2
            className={
              // titleClassName REPLACES the default (not appends) so a surface
              // with bespoke title type — e.g. a mono path/name — never fights two
              // conflicting `text-*` utilities.
              titleClassName ?? 'font-display text-title leading-snug tracking-tightest text-ink'
            }
          >
            {title}
          </h2>
        )}
      </div>
    )
  )

  return (
    <header className={cx(bar, ALIGN[align], 'justify-between gap-3')}>
      <div className="flex min-w-0 items-center gap-2.5">
        {onBack && <BackLink label={backLabel ?? ''} onClick={onBack} className="shrink-0" />}
        {titleBlock}
      </div>
      {(actions || onClose) && (
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {onClose && (
            <CloseButton onClick={onClose} label={closeLabel ?? ''} disabled={closeDisabled} />
          )}
        </div>
      )}
    </header>
  )
}
