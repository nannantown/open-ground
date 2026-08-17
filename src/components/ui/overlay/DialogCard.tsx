import { DragEventHandler, ReactNode } from 'react'

function cx(...cs: (string | false | null | undefined)[]) {
  return cs.filter(Boolean).join(' ')
}

/**
 * The centred-modal "card" that sits inside an `<Overlay placement="center|top">`.
 * Provides the shared card chrome (paper bg, hairline border, rounded corners,
 * hover-card shadow, clipped overflow, column flex). Size + max-height are the
 * caller's concern (pass via `className`, e.g. `w-[560px] max-w-[94vw]
 * max-h-[82vh]`).
 *
 * The click stopPropagation is NOT what keeps the backdrop from closing — Overlay
 * decides that by asking whether the press landed on the backdrop itself, so a
 * card no longer has to cooperate. It stays because it also stops clicks reaching
 * whatever the overlay is nested inside (a canvas that deselects on click, say),
 * which is a different job and still a real one.
 */
export function DialogCard({
  children,
  className,
  role = 'dialog',
  ariaModal = true,
  ariaLabel,
  ariaLabelledby,
  onKeyDown,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  children: ReactNode
  className?: string
  role?: string
  ariaModal?: boolean
  ariaLabel?: string
  ariaLabelledby?: string
  onKeyDown?: (e: React.KeyboardEvent) => void
  // A card can be a file-drop target (e.g. FeedbackModal); pass `relative` via
  // className so an inner absolute drag-highlight pins to it.
  onDragEnter?: DragEventHandler<HTMLDivElement>
  onDragOver?: DragEventHandler<HTMLDivElement>
  onDragLeave?: DragEventHandler<HTMLDivElement>
  onDrop?: DragEventHandler<HTMLDivElement>
}): JSX.Element {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      role={role}
      aria-modal={ariaModal}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      className={cx(
        'flex min-h-0 flex-col overflow-hidden rounded-[3px] border border-line bg-bg-card shadow-card-hover',
        className,
      )}
    >
      {children}
    </div>
  )
}
