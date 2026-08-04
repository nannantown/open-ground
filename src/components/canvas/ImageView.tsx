import { memo, useEffect, useState } from 'react'
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

// Build the same-origin loopback URL for a shared (R2) asset from its storageKey
// `<pid>/<canvasId>/<assetId>` (u14b). Returns null for a malformed key. The
// proxy re-authorizes membership of <pid> server-side, so deriving the id here is
// safe; ImageView imports NO transport, preserving the OFF-bundle guarantee.
const collabAssetUrl = (storageKey: string): string | null => {
  const parts = storageKey.split('/')
  if (parts.length !== 3) return null
  const [pid, cid, aid] = parts
  if (!pid || !cid || !aid) return null
  return (
    `/api/collab/asset?collabProjectId=${encodeURIComponent(pid)}` +
    `&canvasId=${encodeURIComponent(cid)}&assetId=${encodeURIComponent(aid)}`
  )
}

// One image element on the Canvas. Resolves via the per-canvas asset API
// (no asset bytes in the canvas JSON itself). Resize is handled by the
// shared resize-handle infra in InfiniteCanvas — this view just renders
// the box at whatever width/height is on the element.
export const ImageView = memo(({
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
  // Track a failed asset load so we swap the (browser-default) broken-image
  // glyph for a styled placeholder. Reset whenever the source identity changes.
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [element.assetId, element.storageKey, projectPath])

  // The dashed placeholder box, shared by every "no image to show" branch.
  const placeholder = (label: string) => (
    <div
      onPointerDown={onPointerDown}
      style={{ width: w, height: h, opacity }}
      className={[
        'flex items-center justify-center overflow-hidden rounded-[4px] border border-dashed border-line bg-bg-inset text-meta text-ink-faint cursor-grab active:cursor-grabbing',
        ring,
      ].join(' ')}
    >
      {label}
    </div>
  )

  // Resolve which URL backs this image (u14a + u14b):
  //  • OWNER (real projectPath): prefer the fast local file; fall back to the
  //    shared (R2) copy only if there's no local assetId.
  //  • MEMBER (folder-less, empty projectPath): only the shared copy can render
  //    — use it when the owner has uploaded it (storageKey present), else show
  //    the neutral "not synced" placeholder (u14a) instead of a doomed request.
  if (!element.assetId && !element.storageKey) return placeholder(t('canvasEl.image.notFound'))
  let src: string | null = null
  if (projectPath) {
    src = element.assetId
      ? `/api/canvas/asset?path=${encodeURIComponent(projectPath)}` +
        `&canvasId=${encodeURIComponent(canvasId)}` +
        `&assetId=${encodeURIComponent(element.assetId)}`
      : element.storageKey
        ? collabAssetUrl(element.storageKey)
        : null
  } else if (element.storageKey) {
    src = collabAssetUrl(element.storageKey)
  } else {
    return placeholder(t('canvasEl.image.unavailable'))
  }
  if (!src) return placeholder(t('canvasEl.image.notFound'))
  if (failed) return placeholder(t('canvasEl.image.notFound'))
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
        onError={() => setFailed(true)}
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
})
