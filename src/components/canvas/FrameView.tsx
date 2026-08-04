import { memo, useEffect, useRef } from 'react'
import { LayoutGrid } from 'lucide-react'
import type { CanvasElement } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'
import { resolveFrameStyle, resolveStrokeStyle, renderStrokeWidth } from '@/lib/canvasFillStyle'
import {
  resolveFrameCornerRadius,
  clampRadiusToBox,
  resolveOpacity,
} from '@/lib/canvasTransform'
import { shadowsCss } from '@/lib/canvasShadow'

interface Props {
  frame: CanvasElement
  selected: boolean
  editing: boolean
  onHeaderPointerDown: (e: React.PointerEvent) => void
  onChangeLabel: (text: string) => void
  onEditDone: () => void
  /** Tidy the cards sitting inside this frame into a neat grid. Provided only
   *  when the frame actually contains project cards (so empty frames / frames on
   *  surfaces without cards don't show a dead button). */
  onTidy?: () => void
}

// A grouping frame: a labelled rectangle drawn behind the cards. Only its
// header bar is interactive (drag it to move the frame + everything inside);
// the body is click-through so cards on top stay reachable.
export const FrameView = memo(({
  frame,
  selected,
  editing,
  onHeaderPointerDown,
  onChangeLabel,
  onEditDone,
  onTidy,
}: Props) => {
  const { t } = useT()
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
  // The Ground portfolio's grouping frame stays a single uniform radius (its
  // header's top corners track it arithmetically); per-corner radii are a
  // design-canvas feature (DesignFrameView / shapes), not a portfolio one.
  const radius = clampRadiusToBox(resolveFrameCornerRadius(frame), w, h)
  return (
    <div
      style={{
        width: w,
        height: h,
        background: fillStyle.fill,
        // Selected → a SOLID accent outline (Figma's selection ring is always
        // solid); otherwise honour the element's own dashed/dotted style.
        borderStyle: selected ? 'solid' : resolveStrokeStyle(frame),
        // renderStrokeWidth keeps the selection affordance (≥1px) and collapses a
        // no-fill stroke to 0 so a removed border occupies no box space.
        borderWidth: renderStrokeWidth(fillStyle.strokeColor, fillStyle.strokeWidth, selected),
        borderColor: selected ? undefined : fillStyle.strokeColor,
        borderRadius: radius,
        boxShadow: shadowsCss(frame),
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
          <>
            <span className="flex-1 select-none truncate font-display text-[15px] leading-none text-ink">
              {frame.text || <span className="text-ink-faint">Frame</span>}
            </span>
            {onTidy && (
              <button
                type="button"
                title={t('canvasEl.frame.tidyTooltip')}
                aria-label={t('canvasEl.frame.tidyTooltip')}
                // Don't let the press start a frame drag; the click does the tidy.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onTidy()
                }}
                className={[
                  'shrink-0 inline-flex h-6 items-center gap-1 rounded-[3px] px-2',
                  'cursor-pointer text-[11px] font-medium tracking-[0.02em]',
                  'text-ink-muted transition-colors',
                  'hover:bg-plane hover:text-ink',
                  'active:bg-line-soft',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1',
                ].join(' ')}
              >
                <LayoutGrid size={12} strokeWidth={2} className="shrink-0" />
                {t('canvasEl.frame.tidy')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
})
