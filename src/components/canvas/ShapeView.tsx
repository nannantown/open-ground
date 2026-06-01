import type { CanvasElement } from '@/lib/types'
import {
  resolveShapeKind,
  resolveShapeStyle,
  SHAPE_DEFAULT_W,
  SHAPE_DEFAULT_H,
} from '@/lib/canvasShape'
import { resolveFrameCornerRadius, clampRadiusToBox, resolveOpacity } from '@/lib/canvasTransform'

interface Props {
  element: CanvasElement
  selected: boolean
  onPointerDown: (e: React.PointerEvent) => void
}

// Renders a `shape` element: a plain axis-aligned rectangle or ellipse. It
// CONSUMES the same optional fill / strokeColor / strokeWidth fields a frame
// uses (via resolveShapeStyle), plus cornerRadius (rect only — an ellipse is a
// pill at any radius, so it rounds to 50% and ignores the field) and opacity.
// No header, no editable text — it's a pure decorative primitive, so the whole
// body is the drag handle. Selection recolours the border to the accent (like a
// frame, since a shape is essentially a frame body without the header strip);
// the resolved stroke width/colour still apply underneath so a custom border
// survives reselection.
export const ShapeView = ({ element, selected, onPointerDown }: Props) => {
  const kind = resolveShapeKind(element)
  const { fill, strokeColor, strokeWidth } = resolveShapeStyle(element)
  const w = element.width ?? SHAPE_DEFAULT_W
  const h = element.height ?? SHAPE_DEFAULT_H
  // Ellipse → 50% (a true ellipse at any size). Rect → the element's corner
  // radius (legacy 4px frame default via the shared resolver), capped at half
  // the smaller side so it never exceeds a pill.
  const radius =
    kind === 'ellipse'
      ? '50%'
      : clampRadiusToBox(resolveFrameCornerRadius(element), w, h)

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        width: w,
        height: h,
        background: fill,
        borderStyle: 'solid',
        // Keep the selection affordance visible even if the user zeroed the
        // stroke (≥1px while selected); otherwise honour the resolved width.
        borderWidth: selected ? Math.max(strokeWidth, 1) : strokeWidth,
        borderColor: selected ? undefined : strokeColor,
        borderRadius: radius,
        opacity: resolveOpacity(element),
      }}
      className={[
        'cursor-grab active:cursor-grabbing',
        selected ? 'border-accent' : '',
      ].join(' ')}
    />
  )
}
