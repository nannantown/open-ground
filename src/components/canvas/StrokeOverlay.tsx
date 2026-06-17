import type { CanvasElement } from '@/lib/types'
import { resolveStrokeStyle, renderStrokeWidth, resolveStrokeAlign } from '@/lib/canvasFillStyle'
import { strokeOverlayBox } from '@/lib/canvasTransform'

// Stroke alignment (Figma inside / center / outside) for a frame or shape.
// 'inside' (default) keeps the legacy border on the body itself. center /
// outside can't be a border (a border-box border is always inside), so the
// real stroke moves to an absolutely-positioned overlay grown outward; the body
// then carries only the accent selection ring. These two helpers keep the body
// + overlay in agreement and are shared by DesignFrameView and ShapeView.

/** The body div's border, honouring stroke alignment. For 'inside' it's the
 *  element's own stroke (recoloured to the accent while selected — the legacy
 *  look). For center / outside the stroke lives on the overlay, so the body
 *  shows only a thin accent ring while selected, and nothing otherwise. */
export function bodyBorder(
  el: CanvasElement,
  strokeColor: string,
  strokeWidth: number,
  selected: boolean,
): {
  borderStyle: 'solid' | 'dashed' | 'dotted'
  borderWidth: number
  borderColor: string | undefined
} {
  if (resolveStrokeAlign(el) === 'inside') {
    return {
      // Selected → SOLID accent ring (Figma's selection outline is always solid);
      // else the element's own dashed/dotted style.
      borderStyle: selected ? 'solid' : resolveStrokeStyle(el),
      borderWidth: renderStrokeWidth(strokeColor, strokeWidth, selected),
      borderColor: selected ? undefined : strokeColor,
    }
  }
  return {
    borderStyle: 'solid',
    borderWidth: selected ? 1 : 0,
    borderColor: selected ? undefined : 'transparent',
  }
}

/** The center / outside stroke overlay (null for inside, no-fill, or zero
 *  width). Render it as a child of a `position:relative` body so its negative
 *  offsets grow the stroke outward. `radius` overrides the computed rounded-rect
 *  border-radius — ShapeView passes '50%' for an ellipse so its outline stays an
 *  ellipse rather than a rounded rectangle. */
export const StrokeOverlay = ({
  element,
  w,
  h,
  strokeColor,
  strokeWidth,
  radius,
}: {
  element: CanvasElement
  w: number
  h: number
  strokeColor: string
  strokeWidth: number
  radius?: string
}) => {
  const align = resolveStrokeAlign(element)
  // The real stroke width — collapses to 0 for a no-fill stroke (→ no overlay).
  const effWidth = renderStrokeWidth(strokeColor, strokeWidth, false)
  const box = strokeOverlayBox(element, w, h, effWidth, align)
  if (!box) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        boxSizing: 'border-box',
        borderStyle: resolveStrokeStyle(element),
        borderWidth: effWidth,
        borderColor: strokeColor,
        borderRadius: radius ?? box.borderRadius,
      }}
    />
  )
}
