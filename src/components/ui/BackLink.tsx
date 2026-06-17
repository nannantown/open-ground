import { ChevronLeft } from 'lucide-react'

/** The single "back / close / cancel" affordance — always rendered top-left,
 *  matching the "Ground に戻る" button in the project header. Every full-screen
 *  panel (project settings, manual, share) uses this so "go back" lives in one
 *  consistent place and style (a ChevronLeft + label-cap accent link), instead
 *  of each surface inventing its own (bottom-right Cancel, top-right ✕, …).
 *
 *  Style mirrors the header's Ground-return link verbatim, with a focus-visible
 *  ring added for keyboard users (per the interactive-states rules). */
export function BackLink({
  label,
  onClick,
  className,
  disabled,
}: {
  label: string
  onClick: () => void
  className?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex items-center gap-1 label-cap text-accent transition-colors',
        'hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-accent',
        'rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <ChevronLeft size={11} strokeWidth={2.5} />
      {label}
    </button>
  )
}
