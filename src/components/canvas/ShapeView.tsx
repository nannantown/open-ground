import type { CanvasElement } from '@/lib/types'
import {
  resolveShapeKind,
  resolveShapeStyle,
  SHAPE_DEFAULT_W,
  SHAPE_DEFAULT_H,
} from '@/lib/canvasShape'
import { cornerRadiusCss, resolveOpacity } from '@/lib/canvasTransform'
import { shadowsCss } from '@/lib/canvasShadow'
import { imageFillStyle } from '@/lib/canvasImageFill'
import { canvasAssetUrl } from '@/lib/canvasAssets'
import { bodyBorder, StrokeOverlay } from './StrokeOverlay'
import { useCanvasAsset } from './CanvasAssetContext'

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
  const radius = kind === 'ellipse' ? '50%' : cornerRadiusCss(element, w, h)
  const sb = bodyBorder(element, strokeColor, strokeWidth, selected)
  const asset = useCanvasAsset()
  const imgFill =
    element.fillImageId && asset
      ? imageFillStyle(element, canvasAssetUrl(asset.projectPath, asset.canvasId, element.fillImageId))
      : null

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: 'relative', // anchor a center/outside StrokeOverlay
        width: w,
        height: h,
        background: fill,
        ...(imgFill ?? {}),
        borderStyle: sb.borderStyle,
        borderWidth: sb.borderWidth,
        borderColor: sb.borderColor,
        borderRadius: radius,
        boxShadow: shadowsCss(element),
        opacity: resolveOpacity(element),
      }}
      className={[
        'cursor-grab active:cursor-grabbing',
        selected ? 'border-accent' : '',
      ].join(' ')}
    >
      <StrokeOverlay
        element={element}
        w={w}
        h={h}
        strokeColor={strokeColor}
        strokeWidth={strokeWidth}
        radius={kind === 'ellipse' ? '50%' : undefined}
      />
    </div>
  )
}
