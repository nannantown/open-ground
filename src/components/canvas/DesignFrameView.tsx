import { memo, useEffect, useRef } from 'react'
import type { CanvasElement } from '@/lib/types'
import { resolveFrameStyle } from '@/lib/canvasFillStyle'
import { cornerRadiusCss, resolveOpacity } from '@/lib/canvasTransform'
import { shadowsCss } from '@/lib/canvasShadow'
import { imageFillStyle } from '@/lib/canvasImageFill'
import { canvasAssetUrl } from '@/lib/canvasAssets'
import { bodyBorder, StrokeOverlay } from './StrokeOverlay'
import { useCanvasAsset } from './CanvasAssetContext'

interface Props {
  frame: CanvasElement
  selected: boolean
  editing: boolean
  /** Current viewport zoom — the label counter-scales by 1/zoom so it stays a
   *  constant screen size, like Figma's frame names. */
  zoom: number
  /** Figma parity: a NESTED frame (one living inside another frame) hides its
   *  floating name — only top-level frames are titled, so an AI-generated
   *  design full of nested card-frames doesn't read as a wall of "Frame"
   *  labels. Selecting or renaming the frame still shows the label (the user
   *  needs a handle to grab / a field to type into — Figma highlights the name
   *  on selection too). */
  labelHidden?: boolean
  onLabelPointerDown: (e: React.PointerEvent) => void
  onChangeLabel: (text: string) => void
  onEditDone: () => void
}

// The project-Canvas frame: a Figma-style design frame. Unlike the Ground's
// FrameView (a grouping box with an in-body header bar), the design frame's
// rect is ALL content — the name floats OUTSIDE, above the top-left corner,
// in screen space, so it never reads as part of the design itself. The label
// is the frame's only interactive surface (drag to move, double-click to
// rename); the body stays click-through so elements inside stay reachable.
export const DesignFrameView = memo(({
  frame,
  selected,
  editing,
  zoom,
  labelHidden,
  onLabelPointerDown,
  onChangeLabel,
  onEditDone,
}: Props) => {
  const inp = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing && inp.current) {
      inp.current.focus()
      inp.current.select()
    }
  }, [editing])

  const fillStyle = resolveFrameStyle(frame)
  const w = frame.width ?? 400
  const h = frame.height ?? 280
  const radius = cornerRadiusCss(frame, w, h)
  const sb = bodyBorder(frame, fillStyle.strokeColor, fillStyle.strokeWidth, selected)
  // Image fill (Figma image paint) wins over the colour/gradient fill when set.
  const asset = useCanvasAsset()
  const imgFill =
    frame.fillImageId && asset
      ? imageFillStyle(frame, canvasAssetUrl(asset.projectPath, asset.canvasId, frame.fillImageId))
      : null
  return (
    <div
      style={{
        // position:relative so a center/outside StrokeOverlay's negative offsets
        // grow the stroke outward relative to this body (the label, also
        // absolute over an equal-size box, is unaffected).
        position: 'relative',
        width: w,
        height: h,
        background: fillStyle.fill,
        ...(imgFill ?? {}),
        borderStyle: sb.borderStyle,
        borderWidth: sb.borderWidth,
        borderColor: sb.borderColor,
        borderRadius: radius,
        boxShadow: shadowsCss(frame),
        opacity: resolveOpacity(frame),
      }}
      className={['pointer-events-none', selected ? 'border-accent' : ''].join(' ')}
    >
      <StrokeOverlay
        element={frame}
        w={w}
        h={h}
        strokeColor={fillStyle.strokeColor}
        strokeWidth={fillStyle.strokeWidth}
      />
      {/* Floating name, Figma-style: anchored to the frame's top-left, sitting
          fully above the rect, counter-scaled to a constant screen size. The
          1/zoom scale (origin bottom-left) keeps the anchor point glued to the
          frame corner at any zoom.
          A nested frame (labelHidden) draws no label at all — UNLESS it is
          selected or being renamed, where the name is the only grab/rename
          handle and must reappear. */}
      {labelHidden && !selected && !editing ? null : (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            transform: `scale(${1 / zoom})`,
            transformOrigin: 'bottom left',
            paddingBottom: 4,
          }}
          className="pointer-events-auto"
        >
          {editing ? (
            <input
              ref={inp}
              type="text"
              value={frame.text}
              onChange={(e) => onChangeLabel(e.target.value)}
              onBlur={onEditDone}
              onKeyDown={(e) => {
                e.stopPropagation() // editing owns the keyboard
                // ⌘/Ctrl+Enter or Escape commits; a plain Enter does not (it
                // must stay free for IME conversion-confirm).
                if (
                  e.key === 'Escape' ||
                  (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                ) {
                  e.preventDefault()
                  onEditDone()
                }
              }}
              onPointerDown={(e) => e.stopPropagation()}
              placeholder="Frame name"
              className="w-44 bg-bg-elevated px-1 py-0.5 text-meta font-medium leading-none text-ink outline outline-1 outline-accent"
            />
          ) : (
            <span
              onPointerDown={onLabelPointerDown}
              className={[
                'block max-w-[280px] cursor-grab select-none truncate whitespace-nowrap px-1 py-0.5',
                'text-meta font-medium leading-none active:cursor-grabbing',
                selected ? 'text-accent' : 'text-ink-muted hover:text-ink',
              ].join(' ')}
            >
              {frame.text || <span className="text-ink-faint">Frame</span>}
            </span>
          )}
        </div>
      )}
    </div>
  )
})
