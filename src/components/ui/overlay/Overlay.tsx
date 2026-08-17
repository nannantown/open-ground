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
  /** A press on the backdrop closes. Default `true` when `onClose` is given. */
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

  // ⚠ EVERY OVERLAY CLOSES WHEN THE PRESS LANDS ON THE BACKDROP (owner,
  // 2026-08-17: 「モーダル系はモーダル外をタップすると閉じる仕様にしてね。全部」).
  //
  // Two decisions, and both of them are the reason the rule can now be stated
  // without exceptions:
  //
  // 1. MOUSEDOWN, not click. A `click` fires on the nearest common ancestor of
  //    press and release, so selecting text inside a card and releasing on the
  //    veil delivers a click whose target IS this root — and the surface would
  //    vanish mid-drag, losing whatever was typed. Marketplace and the tab
  //    picker had already found this the hard way and hand-rolled a mousedown
  //    dismiss, calling it load-bearing; this is that behaviour, moved into the
  //    shell so it holds everywhere instead of in the two files that remembered.
  // 2. TARGET, not bubbling. The old handler fired on anything that bubbled up,
  //    so it needed every child to stop propagation — `DialogCard` does, and
  //    everything not built on it had to be excluded by placement instead
  //    (`fill` and `scroll` were opted out for that reason alone). Comparing
  //    target to currentTarget asks the question directly — "was the pointer on
  //    empty backdrop?" — so no child has to cooperate and the exclusions go
  //    with it: a `fill` overlay's child covers the root, so it simply never
  //    fires there. Geometry decides, not a list of placements.
  const backdropClose = (closeOnBackdrop ?? true) && !!onClose

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
      onKeyDown={onKeyDown}
      onMouseDown={
        backdropClose
          ? e => {
              onMouseDown?.(e)
              if (e.target === e.currentTarget) onClose?.()
            }
          : onMouseDown
      }
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
