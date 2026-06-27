import { DragEventHandler, KeyboardEventHandler, MouseEventHandler, ReactNode, useEffect } from 'react'
import {
  OVERLAY_BACKDROP,
  OVERLAY_LAYER,
  OVERLAY_PLACEMENT,
  type OverlayBackdrop,
  type OverlayLayer,
  type OverlayPlacement,
  type OverlayPosition,
} from './layers'

function cx(...cs: (string | false | null | undefined)[]) {
  return cs.filter(Boolean).join(' ')
}

// Per-placement padding lives here (not in the layout tokens) so the `top`
// variant can override only padding-top without a p-4/pt-[14vh] shorthand clash,
// and so `padded={false}` can drop it entirely for surfaces with their own gutter.
const PLACEMENT_PADDING: Record<OverlayPlacement, string> = {
  fill: '', // header + body own their own padding
  center: 'p-4',
  top: 'px-4 pb-4 pt-[14vh]',
  scroll: '', // the scrolling child owns its gutter
}

export interface OverlayProps {
  children: ReactNode
  /** z-index layer (see layers.ts). Default `modal`. */
  layer?: OverlayLayer
  /** `fixed` (viewport) vs `absolute` (fills the positioned ancestor). Default `fixed`. */
  position?: OverlayPosition
  /** Backdrop tone. Default `scrim`. */
  backdrop?: OverlayBackdrop
  /** How children are arranged. Default `center`. */
  placement?: OverlayPlacement
  /** Apply the placement's default padding (center/top). Set `false` when the
   *  surface supplies its own gutter via `className`. Default `true`. */
  padded?: boolean
  /** Esc and (for center/top) a backdrop click call this. */
  onClose?: () => void
  /**
   * Mark the root `[data-esc-overlay]` so App's global Escape handler (and the
   * board-drawer one) defer to this overlay — they won't clear the Ground
   * selection / close the drawer beneath. Default `true`. The MAIN ProjectPanel
   * passes `false`: its Esc path *is* the global selection-clear, so it must NOT
   * claim the Escape.
   */
  escOverlay?: boolean
  /**
   * Wire a window Escape→onClose listener (IME-guarded, preventDefault so App's
   * bubble handler bails). Default `true` when `onClose` is given. Pass `false`
   * to keep a surface's bespoke key handling (e.g. a card-scoped Esc + arrow
   * nav, or a surface that intentionally does NOT close on Esc).
   */
  closeOnEsc?: boolean
  /** center/top: a click on the backdrop closes. Default `true` when `onClose` is given. */
  closeOnBackdrop?: boolean
  className?: string
  role?: string
  'aria-modal'?: boolean
  'aria-label'?: string
  'aria-labelledby'?: string
  'data-testid'?: string
  // Passthrough handlers for surfaces that wire extra behaviour on the root
  // (a ⌘Enter submit shortcut, a file-drop backstop, …).
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
  onMouseDown?: MouseEventHandler<HTMLDivElement>
  onDragEnter?: DragEventHandler<HTMLDivElement>
  onDragOver?: DragEventHandler<HTMLDivElement>
  onDragLeave?: DragEventHandler<HTMLDivElement>
  onDrop?: DragEventHandler<HTMLDivElement>
}

/**
 * The shared root for every full-screen panel and modal surface: it owns the
 * positioning (`fixed`/`absolute inset-0`), the z-layer, the backdrop, the
 * `data-esc-overlay` contract, the Escape→close wiring, and (for centred
 * surfaces) backdrop-click-to-close — all from the tokens in `layers.ts`, so no
 * surface hand-rolls these again.
 *
 * Compose with `DialogCard` (centred modals), `DialogHeader`, and `DialogBody`:
 *
 *   // full-screen panel
 *   <Overlay placement="fill" backdrop="surface" layer="panel" onClose={close}>
 *     <DialogHeader onBack={close} title="…" />
 *     <DialogBody>…</DialogBody>
 *   </Overlay>
 *
 *   // centred modal
 *   <Overlay onClose={close}>
 *     <DialogCard className="w-[560px]">
 *       <DialogHeader title="…" onClose={close} />
 *       <DialogBody>…</DialogBody>
 *     </DialogCard>
 *   </Overlay>
 */
export function Overlay({
  children,
  layer = 'modal',
  position = 'fixed',
  backdrop = 'scrim',
  placement = 'center',
  padded = true,
  onClose,
  escOverlay = true,
  closeOnEsc,
  closeOnBackdrop,
  className,
  role,
  'aria-modal': ariaModal,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'data-testid': dataTestid,
  onKeyDown,
  onMouseDown,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}: OverlayProps): JSX.Element {
  const wantEsc = (closeOnEsc ?? true) && !!onClose
  useEffect(() => {
    if (!wantEsc || !onClose) return
    const handler = (e: KeyboardEvent) => {
      // Skip an Escape that cancels an IME composition, or one another overlay
      // (stacked above) already consumed + preventDefaulted.
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
      // preventDefault → App's global keydown bubble listener sees
      // defaultPrevented and won't ALSO clear the Ground selection.
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [wantEsc, onClose])

  const backdropClose = (closeOnBackdrop ?? true) && !!onClose && placement !== 'fill' && placement !== 'scroll'

  return (
    <div
      {...(escOverlay ? { 'data-esc-overlay': '' } : {})}
      className={cx(
        position,
        'inset-0',
        OVERLAY_LAYER[layer],
        OVERLAY_BACKDROP[backdrop],
        OVERLAY_PLACEMENT[placement],
        padded ? PLACEMENT_PADDING[placement] : '',
        className,
      )}
      onClick={backdropClose ? onClose : undefined}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      role={role}
      aria-modal={ariaModal}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      data-testid={dataTestid}
    >
      {children}
    </div>
  )
}
