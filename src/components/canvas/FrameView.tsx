import { useEffect, useRef } from 'react'
import type { CanvasElement } from '@/lib/types'
import { resolveFrameStyle } from '@/lib/canvasFillStyle'
import {
  resolveFrameCornerRadius,
  clampRadiusToBox,
  resolveOpacity,
} from '@/lib/canvasTransform'

interface Props {
  frame: CanvasElement
  selected: boolean
  editing: boolean
  onHeaderPointerDown: (e: React.PointerEvent) => void
  onChangeLabel: (text: string) => void
  onEditDone: () => void
}

// A grouping frame: a labelled rectangle drawn behind the cards. Only its
// header bar is interactive (drag it to move the frame + everything inside);
// the body is click-through so cards on top stay reachable.
export const FrameView = ({
  frame,
  selected,
  editing,
  onHeaderPointerDown,
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

  // Round 3: fill + stroke come from the element's optional fields, resolving
  // to the exact legacy look (bg-bg/35 body, 1px line-strong border) when
  // unset. Selection still wins the border colour as a selection affordance —
  // the accent ring reads over whatever stroke the user picked — but the
  // resolved width/fill always apply so a custom stroke survives reselection.
  const fillStyle = resolveFrameStyle(frame)
  // Round 4: corner radius from the optional `cornerRadius` field (legacy = 4px,
  // the old `rounded-[4px]`), capped at half the smaller side so it never
  // exceeds a pill. Opacity from the optional `opacity` field (legacy = 1).
  const w = frame.width ?? 400
  const h = frame.height ?? 280
  const radius = clampRadiusToBox(resolveFrameCornerRadius(frame), w, h)
  return (
    <div
      style={{
        width: w,
        height: h,
        background: fillStyle.fill,
        borderStyle: 'solid',
        // When selected, keep the affordance visible even if the user zeroed the
        // stroke (≥1px); otherwise honour the resolved width exactly.
        borderWidth: selected ? Math.max(fillStyle.strokeWidth, 1) : fillStyle.strokeWidth,
        borderColor: selected ? undefined : fillStyle.strokeColor,
        borderRadius: radius,
        opacity: resolveOpacity(frame),
      }}
      className={[
        'pointer-events-none',
        selected ? 'border-accent' : '',
      ].join(' ')}
    >
      <div
        onPointerDown={onHeaderPointerDown}
        // Track the body radius (inset by ~1px for the border) so the header's
        // top corners follow a custom corner radius instead of poking square
        // past the rounded body. Never goes negative.
        style={{
          borderTopLeftRadius: Math.max(0, radius - 1),
          borderTopRightRadius: Math.max(0, radius - 1),
        }}
        className={[
          'pointer-events-auto flex h-9 items-center gap-2 border-b px-3',
          selected ? 'border-accent bg-accent-soft' : 'border-line bg-bg-elevated',
          editing ? 'cursor-text' : 'cursor-grab active:cursor-grabbing',
        ].join(' ')}
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
              // ⌘/Ctrl+Enter or Escape commits; a plain Enter does not.
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
            className="w-full bg-transparent font-display text-[15px] leading-none text-ink focus:outline-none"
          />
        ) : (
          <span className="select-none truncate font-display text-[15px] leading-none text-ink">
            {frame.text || <span className="text-ink-faint">Frame</span>}
          </span>
        )}
      </div>
    </div>
  )
}
