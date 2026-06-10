import type { CanvasElement } from '@/lib/types'
import { resolveOpacity } from '@/lib/canvasTransform'
import { useT } from '@/i18n/I18nContext'

interface Props {
  element: CanvasElement
  selected: boolean
  onPointerDown: (e: React.PointerEvent) => void
  projectPath: string
  canvasId: string
}

// Default size used while a freshly pasted/dropped image is still measuring
// its intrinsic resolution. CanvasWorkspace replaces these with the actual
// width / height once the onload handler fires.
const DEFAULT_W = 320
const DEFAULT_H = 240

// One image element on the Canvas. Resolves via the per-canvas asset API
// (no asset bytes in the canvas JSON itself). Resize is handled by the
// shared resize-handle infra in InfiniteCanvas — this view just renders
// the box at whatever width/height is on the element.
export const ImageView = ({
  element,
  selected,
  onPointerDown,
  projectPath,
  canvasId,
}: Props) => {
  const { t } = useT()
  const w = element.width ?? DEFAULT_W
  const h = element.height ?? DEFAULT_H
  const opacity = resolveOpacity(element)
  const ring = selected
    ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg'
    : ''
  if (!element.assetId) {
    return (
      <div
        onPointerDown={onPointerDown}
        style={{ width: w, height: h, opacity }}
        className={[
          'flex items-center justify-center overflow-hidden rounded-[4px] border border-dashed border-line bg-bg-inset text-[11px] text-ink-faint cursor-grab active:cursor-grabbing',
          ring,
        ].join(' ')}
      >
        {t('canvasEl.image.notFound')}
      </div>
    )
  }
  const src =
    `/api/canvas/asset?path=${encodeURIComponent(projectPath)}` +
    `&canvasId=${encodeURIComponent(canvasId)}` +
    `&assetId=${encodeURIComponent(element.assetId)}`
  return (
    <div
      onPointerDown={onPointerDown}
      style={{ width: w, height: h, opacity }}
      className={[
        'relative overflow-hidden rounded-[4px] border border-line bg-bg-card shadow-card cursor-grab active:cursor-grabbing',
        ring,
      ].join(' ')}
      title={element.filename || element.alt || 'Image'}
    >
      <img
        src={src}
        alt={element.alt ?? element.filename ?? ''}
        draggable={false}
        style={{
          width: '100%',
          height: '100%',
          // 'fill' matches Figma's default Frame behaviour — the user resizes
          // the box and the image stretches with it. Use object-contain if
          // intrinsic-aspect-respect becomes a requirement later.
          objectFit: 'fill',
          display: 'block',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
