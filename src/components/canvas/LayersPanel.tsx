import { useRef, useState } from 'react'
import {
  Layers,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  X,
} from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { CanvasElement } from '@/lib/types'
import { canvasElementLabel, CanvasElementIcon } from '@/lib/canvasElementLabel'
import { buildLayerRows } from '@/lib/canvasLayerTree'

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
  /** Toggle an element's `locked` flag (lock icon). A locked element is
   *  pointer-events:none on the canvas, so the panel is the only way to
   *  re-select + unlock it. */
  onToggleLocked: (id: string) => void
  /** Give an element a custom layer name (panel rename). Empty clears it. */
  onRename: (id: string, name: string) => void
  /** Drag-reorder: move `dragId` so it lands `place` ('above' = more toward
   *  front) the `targetId` row, adopting that row's nesting level. */
  onReorder: (dragId: string, targetId: string, place: 'above' | 'below') => void
  /** Collapse the panel back to its launcher button. */
  onClose: () => void
}

// Pixels a pointer must travel after pressing a row before it counts as a drag
// (below this it's a plain click → select).
const DRAG_THRESHOLD = 4

// Figma-style Layers list for the embedded Canvas. Renders front-most at the
// top (the array's z-order is back→front), nests children (parentId) under their
// container with expand/collapse twisties, and supports drag-reorder + inline
// rename. Clicking a row selects that element on the canvas; the selection
// highlight is two-way. Mounted top-left by CanvasWorkspace, clear of the
// ToolPalette (center-left) and the SelectionInspector (top-right).
//
// Reorder is POINTER-based (not HTML5 drag-and-drop) to match the rest of the
// canvas — one pointer model everywhere, and no stale-state race between
// dragstart/dragover. Press-and-move past a small threshold starts a drag;
// press-and-release in place is a click.
export const LayersPanel = ({
  elements,
  selectedIds,
  onSelect,
  onMove,
  onToggleHidden,
  onToggleLocked,
  onRename,
  onReorder,
  onClose,
}: Props) => {
  const { t } = useT()
  // Containers default to expanded; we only track the ones the user collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; place: 'above' | 'below' } | null>(
    null,
  )
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Live drag bookkeeping kept in a ref so the move/up handlers read the current
  // values synchronously (React state is async — the dropTarget set during a
  // move wouldn't be visible to the up handler in the same gesture).
  const dragRef = useRef<{
    id: string
    x: number
    y: number
    additive: boolean
    dragging: boolean
  } | null>(null)
  const dropRef = useRef<{ id: string; place: 'above' | 'below' } | null>(null)

  const rows = buildLayerRows(elements, (id) => !collapsed.has(id))
  const selected = new Set(selectedIds)

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Return keyboard focus to a row (by its data-layer-id) after the rename input
  // unmounts, so a keyboard user keeps their place instead of dropping to <body>.
  const refocusRow = (id: string | null) => {
    if (!id) return
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-layer-row="${CSS.escape(id)}"]`)?.focus()
    })
  }

  const commitRename = () => {
    const id = renamingId
    if (id) onRename(id, renameValue.trim())
    setRenamingId(null)
    refocusRow(id)
  }

  // Keyboard model for a focused row (role=treeitem): Enter/Space select, F2
  // rename, ←/→ collapse/expand a container, Alt+↑/↓ reorder one step in z-order.
  const onRowKeyDown = (
    e: React.KeyboardEvent,
    id: string,
    hasChildren: boolean,
    atFront: boolean,
    atBack: boolean,
  ) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(id, e.metaKey || e.ctrlKey || e.shiftKey)
    } else if (e.key === 'F2') {
      e.preventDefault()
      const el = elements.find((x) => x.id === id)
      setRenamingId(id)
      setRenameValue(el?.name?.trim() ? el.name : '')
    } else if (e.key === 'ArrowRight' && hasChildren && collapsed.has(id)) {
      e.preventDefault()
      toggleCollapse(id)
    } else if (e.key === 'ArrowLeft' && hasChildren && !collapsed.has(id)) {
      e.preventDefault()
      toggleCollapse(id)
    } else if (e.altKey && e.key === 'ArrowUp' && !atFront) {
      // Mirror the up/down buttons' boundary guards (front-most can't go up).
      e.preventDefault()
      onMove(id, 'up')
      refocusRow(id) // keep focus on the row after it moves
    } else if (e.altKey && e.key === 'ArrowDown' && !atBack) {
      e.preventDefault()
      onMove(id, 'down')
      refocusRow(id)
    }
  }

  const setDrop = (next: { id: string; place: 'above' | 'below' } | null) => {
    dropRef.current = next
    setDropTarget(next)
  }

  const onRowPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || renamingId === id) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      id,
      x: e.clientX,
      y: e.clientY,
      additive: e.metaKey || e.ctrlKey || e.shiftKey,
      dragging: false,
    }
  }

  const onRowPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    if (!d.dragging) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return
      d.dragging = true
      setDragId(d.id)
    }
    // Hit-test the row under the pointer via its data attribute, independent of
    // which row captured the pointer.
    const node = document.elementFromPoint(e.clientX, e.clientY)
    const row = node?.closest('[data-layer-id]') as HTMLElement | null
    const targetId = row?.getAttribute('data-layer-id')
    if (!targetId || targetId === d.id) {
      setDrop(null)
      return
    }
    const r = row!.getBoundingClientRect()
    const place: 'above' | 'below' = e.clientY < r.top + r.height / 2 ? 'above' : 'below'
    if (dropRef.current?.id !== targetId || dropRef.current.place !== place) {
      setDrop({ id: targetId, place })
    }
  }

  const onRowPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be gone */
    }
    if (!d) return
    if (d.dragging) {
      const drop = dropRef.current
      if (drop && drop.id !== d.id) onReorder(d.id, drop.id, drop.place)
    } else {
      // A press without travel is a click → select.
      onSelect(d.id, d.additive)
    }
    setDragId(null)
    setDrop(null)
  }

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
          <span>{t('canvas.layers')}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('canvas.closeLayersPanel')}
          className="flex h-6 w-6 items-center justify-center rounded-[4px] text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-ink-faint">
          {t('canvas.noElementsYet')}
        </div>
      ) : (
        <ul role="tree" aria-label={t('canvas.layers')} className="min-h-0 flex-1 overflow-y-auto py-1">
          {rows.map((row, i) => {
            const el = row.el
            const isSelected = selected.has(el.id)
            const isHidden = !!el.hidden
            const isLocked = !!el.locked
            const isExpanded = !collapsed.has(el.id)
            const isRenaming = renamingId === el.id
            // Array-position guards for the one-step z-order nudge.
            const atFront = i === 0
            const atBack = i === rows.length - 1
            const isDropAbove = dropTarget?.id === el.id && dropTarget.place === 'above'
            const isDropBelow = dropTarget?.id === el.id && dropTarget.place === 'below'
            return (
              <li key={el.id} className="relative" data-layer-id={el.id}>
                {/* Drop indicators — a line at the row edge the dragged layer
                    will land against. */}
                {isDropAbove && (
                  <span className="pointer-events-none absolute inset-x-1 top-0 z-10 h-[2px] rounded bg-accent" />
                )}
                {isDropBelow && (
                  <span className="pointer-events-none absolute inset-x-1 bottom-0 z-10 h-[2px] rounded bg-accent" />
                )}
                <div
                  data-layer-row={el.id}
                  role="treeitem"
                  tabIndex={isRenaming ? -1 : 0}
                  aria-selected={isSelected}
                  aria-level={row.depth + 1}
                  aria-expanded={row.hasChildren ? isExpanded : undefined}
                  aria-label={canvasElementLabel(el)}
                  onPointerDown={(e) => onRowPointerDown(e, el.id)}
                  onPointerMove={onRowPointerMove}
                  onPointerUp={onRowPointerUp}
                  onKeyDown={(e) =>
                    !isRenaming && onRowKeyDown(e, el.id, row.hasChildren, atFront, atBack)
                  }
                  onDoubleClick={() => {
                    setRenamingId(el.id)
                    setRenameValue(el.name?.trim() ? el.name : '')
                  }}
                  className={[
                    'group flex items-center gap-1 py-1.5 pr-2 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60',
                    dragId === el.id ? 'opacity-40' : '',
                    isSelected ? 'bg-accent text-bg-card' : 'text-ink hover:bg-bg-inset',
                    isRenaming ? 'cursor-text' : 'cursor-pointer',
                  ].join(' ')}
                  // Indent by depth so nesting reads at a glance.
                  style={{ paddingLeft: 8 + row.depth * 14 }}
                >
                  {/* Expand/collapse twisty — only for containers with children;
                      a fixed-width spacer keeps leaf rows aligned. */}
                  {row.hasChildren ? (
                    <button
                      type="button"
                      // The row (treeitem) already exposes aria-expanded + handles
                      // ←/→, so hide the redundant twisty from the a11y tree.
                      aria-hidden="true"
                      tabIndex={-1}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => toggleCollapse(el.id)}
                      title={isExpanded ? t('canvas.collapse') : t('canvas.expand')}
                      className={[
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                        isSelected
                          ? 'text-bg-card/80 hover:bg-bg-card/20'
                          : 'text-ink-faint hover:bg-bg-elevated hover:text-ink',
                      ].join(' ')}
                    >
                      {isExpanded ? (
                        <ChevronDown size={12} strokeWidth={2.25} />
                      ) : (
                        <ChevronRight size={12} strokeWidth={2.25} />
                      )}
                    </button>
                  ) : (
                    <span className="h-4 w-4 shrink-0" />
                  )}

                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        // Don't steal the Enter that CONFIRMS an IME conversion
                        // (Japanese/Chinese input) — committing then would cut the
                        // composition off. Only commit on a real Enter.
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          commitRename()
                        } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          const id = renamingId
                          setRenamingId(null)
                          refocusRow(id)
                        }
                        e.stopPropagation()
                      }}
                      className="min-w-0 flex-1 rounded-[3px] border border-accent/50 bg-bg-card px-1 py-0.5 text-[12.5px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    />
                  ) : (
                    <span
                      title={canvasElementLabel(el)}
                      className={[
                        'flex min-w-0 flex-1 items-center gap-2 text-left text-[12.5px]',
                        isHidden ? 'opacity-45' : '',
                      ].join(' ')}
                    >
                      <span
                        className={['shrink-0', isSelected ? 'text-bg-card/80' : 'text-ink-faint'].join(
                          ' ',
                        )}
                      >
                        <CanvasElementIcon element={el} />
                      </span>
                      <span className="truncate">{canvasElementLabel(el)}</span>
                    </span>
                  )}

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
                      title={t('canvas.bringForward')}
                      onClick={() => onMove(el.id, 'up')}
                    >
                      <ChevronUp size={13} strokeWidth={2} />
                    </RowButton>
                    <RowButton
                      selected={isSelected}
                      disabled={atBack}
                      title={t('canvas.sendBackward')}
                      onClick={() => onMove(el.id, 'down')}
                    >
                      <ChevronDown size={13} strokeWidth={2} />
                    </RowButton>
                    <RowButton
                      selected={isSelected}
                      title={isLocked ? t('canvas.unlock') : t('canvas.lock')}
                      // The lock stays visible when the element is locked, so a
                      // locked layer is discoverable (and unlockable from here).
                      forceVisible={isLocked}
                      onClick={() => onToggleLocked(el.id)}
                    >
                      {isLocked ? (
                        <Lock size={13} strokeWidth={2} />
                      ) : (
                        <Unlock size={13} strokeWidth={2} />
                      )}
                    </RowButton>
                    <RowButton
                      selected={isSelected}
                      title={isHidden ? t('canvas.show') : t('canvas.hide')}
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
// interactive states (hover / active / disabled / focus). Stops pointer-down so
// it never starts a row drag.
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
    onPointerDown={(e) => e.stopPropagation()}
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
