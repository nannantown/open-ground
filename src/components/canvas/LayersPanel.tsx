import { Layers, ChevronUp, ChevronDown, Eye, EyeOff, X } from 'lucide-react'
import type { CanvasElement } from '@/lib/types'
import { canvasElementLabel, CanvasElementIcon } from '@/lib/canvasElementLabel'

interface Props {
  elements: CanvasElement[]
  selectedIds: string[]
  /** Replace the selection (panel click → canvas selection). Additive when the
   *  user holds ⌘/Shift, matching the canvas's own multi-select. */
  onSelect: (id: string, additive: boolean) => void
  /** Move ONE element up (toward front) / down (toward back) by a single step
   *  in z-order. The panel lists front-at-top, so "up" = later in the array. */
  onMove: (id: string, dir: 'up' | 'down') => void
  /** Toggle an element's `hidden` flag (eye icon). */
  onToggleHidden: (id: string) => void
  /** Collapse the panel back to its launcher button. */
  onClose: () => void
}

// Figma-style Layers list for the embedded Canvas. Renders front-most at the
// top (the array's z-order is back→front, so we iterate it reversed). Clicking
// a row selects that element on the canvas; the selection highlight is two-way
// (a canvas selection lights up the matching row). Per-row arrows nudge one
// step in z-order; the eye toggles visibility. Mounted top-left by
// CanvasWorkspace, clear of the ToolPalette (center-left) and the
// SelectionInspector (top-right).
export const LayersPanel = ({
  elements,
  selectedIds,
  onSelect,
  onMove,
  onToggleHidden,
  onClose,
}: Props) => {
  // Front-most first: the array is back→front, so reverse for the list.
  const rows = elements.slice().reverse()
  const selected = new Set(selectedIds)

  return (
    <div
      // Own pointer events so clicking a row / arrow doesn't fall through to the
      // canvas (which would start a marquee / clear the selection).
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute left-16 top-3 z-30 flex max-h-[min(60vh,420px)] w-60 flex-col rounded-[7px] border border-line bg-bg-card/95 shadow-card-hover backdrop-blur"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-3 py-2">
        <div className="flex items-center gap-1.5 label-cap text-ink-muted">
          <Layers size={12} strokeWidth={2.25} />
          <span>Layers</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="レイヤーパネルを閉じる"
          className="flex h-6 w-6 items-center justify-center rounded-[4px] text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-ink-faint">
          まだ要素がありません
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {rows.map((el, i) => {
            const isSelected = selected.has(el.id)
            const isHidden = !!el.hidden
            // Array-position guards: the FIRST row (i === 0) is front-most so it
            // can't move up; the LAST row is back-most so it can't move down.
            const atFront = i === 0
            const atBack = i === rows.length - 1
            return (
              <li key={el.id}>
                <div
                  className={[
                    'group flex items-center gap-1.5 px-2 py-1.5 transition-colors',
                    isSelected
                      ? 'bg-accent text-bg-card'
                      : 'text-ink hover:bg-bg-inset',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    onClick={(e) => onSelect(el.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                    title={canvasElementLabel(el)}
                    className={[
                      'flex min-w-0 flex-1 items-center gap-2 text-left text-[12.5px]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-0 rounded-[3px]',
                      isHidden ? 'opacity-45' : '',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'shrink-0',
                        isSelected ? 'text-bg-card/80' : 'text-ink-faint',
                      ].join(' ')}
                    >
                      <CanvasElementIcon element={el} />
                    </span>
                    <span className="truncate">{canvasElementLabel(el)}</span>
                  </button>

                  {/* Row controls. Visible on hover / when this row is selected
                      so the list stays calm but stays one click from reorder. */}
                  <div
                    className={[
                      'flex shrink-0 items-center gap-0.5 transition-opacity',
                      isSelected
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
                    ].join(' ')}
                  >
                    <RowButton
                      selected={isSelected}
                      disabled={atFront}
                      title="前面へ"
                      onClick={() => onMove(el.id, 'up')}
                    >
                      <ChevronUp size={13} strokeWidth={2} />
                    </RowButton>
                    <RowButton
                      selected={isSelected}
                      disabled={atBack}
                      title="背面へ"
                      onClick={() => onMove(el.id, 'down')}
                    >
                      <ChevronDown size={13} strokeWidth={2} />
                    </RowButton>
                    <RowButton
                      selected={isSelected}
                      title={isHidden ? '表示' : '非表示'}
                      // The eye stays visible even when not hovering IF the
                      // element is hidden, so a hidden layer is discoverable.
                      forceVisible={isHidden}
                      onClick={() => onToggleHidden(el.id)}
                    >
                      {isHidden ? (
                        <EyeOff size={13} strokeWidth={2} />
                      ) : (
                        <Eye size={13} strokeWidth={2} />
                      )}
                    </RowButton>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// A compact icon button for the per-row controls. Adapts its colours to whether
// its row is selected (accent background → light glyphs) and follows the five
// interactive states (hover / active / disabled / focus).
const RowButton = ({
  selected,
  disabled,
  title,
  forceVisible,
  onClick,
  children,
}: {
  selected: boolean
  disabled?: boolean
  title: string
  forceVisible?: boolean
  onClick: () => void
  children: React.ReactNode
}) => (
  <button
    type="button"
    disabled={disabled}
    title={title}
    onClick={onClick}
    className={[
      'flex h-6 w-6 items-center justify-center rounded-[4px] transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
      'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
      forceVisible ? 'opacity-100' : '',
      selected
        ? 'text-bg-card/85 hover:bg-bg-card/20 hover:text-bg-card active:bg-bg-card/30'
        : 'text-ink-faint hover:bg-bg-elevated hover:text-ink active:bg-bg-inset',
    ].join(' ')}
  >
    {children}
  </button>
)
