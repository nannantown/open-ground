import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Lock,
  Search,
  Unlock,
  X,
} from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { CanvasElement } from '@/lib/types'
import { canvasElementLabel, CanvasElementIcon } from '@/lib/canvasElementLabel'
import { canContain, descendantIds } from '@/lib/canvasContainment'
import {
  buildLayerRows,
  filterLayerRows,
  canMoveLayer,
  layerAncestors,
  type LayerDropPlace,
  type LayerRow,
} from '@/lib/canvasLayerTree'

interface Props {
  elements: CanvasElement[]
  selectedIds: string[]
  /** Replace the selection (panel click → canvas selection). Additive when the
   *  user holds a modifier, matching the canvas's own multi-select. */
  onSelect: (id: string, additive: boolean) => void
  /** Replace the WHOLE selection at once — carries ⇧-range and ⌘-toggle
   *  results, which a single (id, additive) call can't express. Optional:
   *  without it those gestures degrade to the legacy additive onSelect. */
  onSelectIds?: (ids: string[]) => void
  /** Move ONE element up (toward front) / down (toward back) by a single step
   *  in z-order within its sibling group (see canMoveLayer / moveLayerOne). */
  onMove: (id: string, dir: 'up' | 'down') => void
  /** Toggle an element's `hidden` flag (eye icon). */
  onToggleHidden: (id: string) => void
  /** Toggle an element's `locked` flag (lock icon). A locked element is
   *  pointer-events:none on the canvas, so the panel is the only way to
   *  re-select + unlock it. */
  onToggleLocked: (id: string) => void
  /** Give an element a custom layer name (panel rename). Empty clears it. */
  onRename: (id: string, name: string) => void
  /** Drag-reorder: move `dragId` so it lands `place` the `targetId` row —
   *  'above'/'below' = next to it, 'into' = inside it as the front-most child. */
  onReorder: (dragId: string, targetId: string, place: LayerDropPlace) => void
  /** Row hover → canvas-side highlight (null on leave). Wired by the shell. */
  onHoverElement?: (id: string | null) => void
  /** Canvas-side hover → row highlight. Wired by the shell. */
  hoveredElementId?: string | null
}

// Pixels a pointer must travel after pressing a row before it counts as a drag
// (below this it's a plain click → select).
const DRAG_THRESHOLD = 4

// Find a row's DOM node by its data-layer-id. Exact attribute comparison
// instead of a selector interpolation so arbitrary ids never need escaping.
const findRowNode = (root: ParentNode | null, id: string): HTMLElement | null => {
  if (!root) return null
  const nodes = root.querySelectorAll<HTMLElement>('[data-layer-row]')
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute('data-layer-row') === id) return nodes[i]
  }
  return null
}

// Figma-style Layers list for the embedded Canvas, DOCKED: it owns no chrome or
// position of its own and simply fills whatever sidebar slot mounts it (search
// field on top, scrolling tree below). Renders front-most at the top (the
// array's z-order is back→front), nests children (parentId) under their
// container with expand/collapse twisties, and supports drag-reorder (above /
// below / INTO a container) + inline rename. Clicking a row selects that
// element on the canvas; the selection highlight is two-way, and a canvas-side
// selection auto-expands its ancestors and scrolls into view (reveal).
//
// Reorder is POINTER-based (not HTML5 drag-and-drop) to match the rest of the
// canvas — one pointer model everywhere, and no stale-state race between
// dragstart/dragover. Press-and-move past a small threshold starts a drag;
// press-and-release in place is a click.
export const LayersPanel = ({
  elements,
  selectedIds,
  onSelect,
  onSelectIds,
  onMove,
  onToggleHidden,
  onToggleLocked,
  onRename,
  onReorder,
  onHoverElement,
  hoveredElementId,
}: Props) => {
  const { t } = useT()
  // Containers default to expanded; we only track the ones the user collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; place: LayerDropPlace } | null>(
    null,
  )
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // ⇧-range anchor + roving-tabindex home: the last plainly clicked/selected row.
  const [anchorId, setAnchorId] = useState<string | null>(null)

  // Live drag bookkeeping kept in a ref so the move/up handlers read the current
  // values synchronously (React state is async — the dropTarget set during a
  // move wouldn't be visible to the up handler in the same gesture).
  const dragRef = useRef<{
    id: string
    x: number
    y: number
    shift: boolean
    metaCtrl: boolean
    dragging: boolean
    // Reordering a filtered VIEW would be ambiguous (hidden rows in between),
    // so dragging is disabled while a search query is active.
    noDrag: boolean
    type: CanvasElement['type']
    subtree: Set<string>
  } | null>(null)
  const dropRef = useRef<{ id: string; place: LayerDropPlace } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // Latest props for effects that must not re-run on every elements mutation.
  const elementsRef = useRef(elements)
  elementsRef.current = elements

  const q = query.trim()
  // While a query is active the tree is searched FULLY EXPANDED (a match inside
  // a collapsed container must surface), then filtered down to matches + their
  // ancestor chains; the user's collapse state is untouched underneath.
  const baseRows = buildLayerRows(elements, q ? () => true : (id) => !collapsed.has(id))
  const filtered = q ? filterLayerRows(baseRows, q, canvasElementLabel) : null
  const rows = filtered ? filtered.rows : baseRows
  const selected = new Set(selectedIds)
  const isRowExpanded = (id: string) =>
    filtered ? filtered.expandedIds.has(id) : !collapsed.has(id)

  // Roving tabindex: exactly one row is in the tab order — the anchor when it's
  // visible, else the first selected visible row, else the first row.
  const activeRowId =
    anchorId && rows.some((r) => r.el.id === anchorId)
      ? anchorId
      : (rows.find((r) => selected.has(r.el.id))?.el.id ?? rows[0]?.el.id)

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Return keyboard focus to a row (by its data-layer-id) after the rename input
  // unmounts or the row moved, so a keyboard user keeps their place instead of
  // dropping to <body>.
  const refocusRow = (id: string | null) => {
    if (!id) return
    requestAnimationFrame(() => {
      findRowNode(document, id)?.focus()
    })
  }

  // ── Reveal (Figma): canvas-side selection → expand ancestors + scroll ─────
  // Suppressed while a press/drag is in flight so the list doesn't jump under
  // the pointer. The scroll itself is deferred to the every-render consumer
  // below because the ancestor expansion may need one more render before the
  // row exists in the DOM.
  const revealRef = useRef<string | null>(null)
  const firstSelectedId = selectedIds[0] ?? null
  useEffect(() => {
    if (!firstSelectedId || dragRef.current) return
    revealRef.current = firstSelectedId
    const ancestors = layerAncestors(elementsRef.current, firstSelectedId)
    if (ancestors.length) {
      setCollapsed((prev) => {
        if (!ancestors.some((a) => prev.has(a))) return prev
        const next = new Set(prev)
        for (const a of ancestors) next.delete(a)
        return next
      })
    }
  }, [firstSelectedId])
  useEffect(() => {
    const id = revealRef.current
    if (!id) return
    const node = findRowNode(listRef.current, id)
    if (node) {
      revealRef.current = null
      node.scrollIntoView({ block: 'nearest' })
    } else if (!elementsRef.current.some((e) => e.id === id)) {
      revealRef.current = null
    }
  })

  const startRename = (el: CanvasElement) => {
    // Re-entry guard: a dblclick INSIDE the rename input (word-select) bubbles
    // back to the row's onDoubleClick — restarting would wipe the typed value.
    if (renamingId === el.id) return
    setRenamingId(el.id)
    setRenameValue(el.name?.trim() ? el.name : '')
  }

  const commitRename = () => {
    const id = renamingId
    if (id) onRename(id, renameValue.trim())
    setRenamingId(null)
    refocusRow(id)
  }

  const selectRow = (id: string) => {
    setAnchorId(id)
    onSelect(id, false)
    refocusRow(id)
  }

  // ⇧-range over the VISIBLE rows from the anchor to `targetId`, delivered
  // whole via onSelectIds. False when that prop is absent (caller falls back
  // to the legacy additive select).
  const rangeSelect = (targetId: string, fallbackAnchor: string): boolean => {
    if (!onSelectIds) return false
    const a = anchorId && rows.some((r) => r.el.id === anchorId) ? anchorId : fallbackAnchor
    const ai = rows.findIndex((r) => r.el.id === a)
    const bi = rows.findIndex((r) => r.el.id === targetId)
    if (ai < 0 || bi < 0) return false
    const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai]
    onSelectIds(rows.slice(lo, hi + 1).map((r) => r.el.id))
    return true
  }

  // Keyboard model for a focused row (role=treeitem): ↑/↓ move the selection
  // (Figma — selection follows focus), ⇧↑/⇧↓ extend the range, ←/→ collapse /
  // expand or step to parent / first child, Enter/Space select, F2 rename,
  // Alt+↑/↓ one-step z-nudge gated by canMoveLayer.
  const onRowKeyDown = (e: React.KeyboardEvent, row: LayerRow, index: number) => {
    const id = row.el.id
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const additive = e.metaKey || e.ctrlKey || e.shiftKey
      if (!additive) setAnchorId(id)
      onSelect(id, additive)
    } else if (e.key === 'F2') {
      e.preventDefault()
      startRename(row.el)
    } else if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault()
      if (canMoveLayer(elements, id, 'up')) {
        onMove(id, 'up')
        refocusRow(id) // keep focus on the row after it moves
      }
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault()
      if (canMoveLayer(elements, id, 'down')) {
        onMove(id, 'down')
        refocusRow(id)
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const next = rows[index + (e.key === 'ArrowDown' ? 1 : -1)]
      if (!next) return
      if (e.shiftKey) {
        if (!rangeSelect(next.el.id, id)) onSelect(next.el.id, true)
        refocusRow(next.el.id)
      } else {
        selectRow(next.el.id)
      }
    } else if (e.key === 'ArrowLeft') {
      if (q) return // tree shape is read-only while filtering
      if (row.hasChildren && !collapsed.has(id)) {
        e.preventDefault()
        toggleCollapse(id)
      } else {
        const parent = layerAncestors(elements, id)[0]
        if (parent && rows.some((r) => r.el.id === parent)) {
          e.preventDefault()
          selectRow(parent)
        }
      }
    } else if (e.key === 'ArrowRight') {
      if (q) return
      if (row.hasChildren && collapsed.has(id)) {
        e.preventDefault()
        toggleCollapse(id)
      } else if (row.hasChildren) {
        const next = rows[index + 1]
        if (next && next.depth === row.depth + 1) {
          e.preventDefault()
          selectRow(next.el.id)
        }
      }
    }
  }

  const setDrop = (next: { id: string; place: LayerDropPlace } | null) => {
    dropRef.current = next
    setDropTarget(next)
  }

  const onRowPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || renamingId === id) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const el = elements.find((x) => x.id === id)
    dragRef.current = {
      id,
      x: e.clientX,
      y: e.clientY,
      shift: e.shiftKey,
      metaCtrl: e.metaKey || e.ctrlKey,
      dragging: false,
      noDrag: q.length > 0,
      type: el?.type ?? 'sticky',
      // Cached once per gesture: rows inside the dragged subtree can never be
      // drop targets (that would nest a container into itself).
      subtree: descendantIds(elements, id),
    }
  }

  const onRowPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.noDrag) return
    if (!d.dragging) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return
      d.dragging = true
      setDragId(d.id)
    }
    // Hit-test the row under the pointer via its data attribute, independent of
    // which row captured the pointer.
    const node = document.elementFromPoint(e.clientX, e.clientY)
    const rowNode = node?.closest('[data-layer-id]') as HTMLElement | null
    const targetId = rowNode?.getAttribute('data-layer-id')
    if (!rowNode || !targetId || targetId === d.id || d.subtree.has(targetId)) {
      setDrop(null)
      return
    }
    // Vertical 25% / 50% / 25% bands: edges insert next to the row, the middle
    // drops INTO it — but only when the row may legally own the dragged type;
    // otherwise the middle falls back to the nearest edge.
    const r = rowNode.getBoundingClientRect()
    const ratio = r.height > 0 ? (e.clientY - r.top) / r.height : 0
    const targetType = elements.find((el) => el.id === targetId)?.type
    let place: LayerDropPlace
    if (ratio < 0.25) place = 'above'
    else if (ratio > 0.75) place = 'below'
    else if (targetType && canContain(targetType, d.type)) place = 'into'
    else place = ratio < 0.5 ? 'above' : 'below'
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
      clickSelect(d.id, d.shift, d.metaCtrl)
    }
    setDragId(null)
    setDrop(null)
  }

  // A gesture that ends WITHOUT a pointerup on the capturing row (OS
  // pointercancel, or the row unmounting mid-drag on an external elements
  // refresh) must still clear the drag state — otherwise the 40%-opacity row,
  // the drop indicator, and the reveal-suppression stick around. Same defence
  // InfiniteCanvas runs on its viewport; no drop is performed.
  const onRowPointerLost = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragId(null)
    setDrop(null)
  }

  // Click model (Figma): plain = replace selection + set the anchor, ⇧ = range
  // from the anchor over visible rows, ⌘/Ctrl = toggle membership. Range and
  // toggle need onSelectIds; without it both degrade to the legacy additive
  // select.
  const clickSelect = (id: string, shift: boolean, metaCtrl: boolean) => {
    if (shift && rangeSelect(id, id)) return
    if (metaCtrl && onSelectIds) {
      setAnchorId(id)
      onSelectIds(
        selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
      )
      return
    }
    if (shift || metaCtrl) {
      onSelect(id, true)
      return
    }
    setAnchorId(id)
    onSelect(id, false)
  }

  return (
    <div
      // Own pointer events so clicking a row / arrow doesn't fall through to
      // whatever sits behind the sidebar slot.
      onPointerDown={(e) => e.stopPropagation()}
      className="flex h-full w-full min-h-0 flex-col"
    >
      {elements.length > 0 && (
        <div className="shrink-0 border-b border-line-soft px-2 py-1.5">
          <div className="flex h-6 items-center gap-1.5 rounded-[5px] bg-bg-inset px-1.5 transition-colors hover:bg-bg-elevated focus-within:ring-2 focus-within:ring-accent/40">
            <Search size={11} strokeWidth={2} className="shrink-0 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Esc clears the query — but not the Esc that CANCELS an IME
                // composition, and an already-empty field lets Esc bubble on
                // (the canvas uses it to clear the selection).
                if (e.key === 'Escape' && !e.nativeEvent.isComposing && query) {
                  e.preventDefault()
                  e.stopPropagation()
                  setQuery('')
                }
              }}
              placeholder={t('canvas.searchLayers')}
              aria-label={t('canvas.searchLayers')}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                title={t('canvas.clearSearch')}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-ink-faint transition-colors hover:bg-bg-elevated hover:text-ink active:bg-bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <X size={11} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      )}

      {elements.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-ink-faint">
          {t('canvas.noElementsYet')}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-ink-faint">
          {t('canvas.noSearchResults')}
        </div>
      ) : (
        <ul
          ref={listRef}
          role="tree"
          aria-label={t('canvas.layers')}
          aria-multiselectable="true"
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {rows.map((row, i) => {
            const el = row.el
            const isSelected = selected.has(el.id)
            const isHidden = !!el.hidden
            const isLocked = !!el.locked
            const isExpanded = isRowExpanded(el.id)
            const isRenaming = renamingId === el.id
            const isCanvasHover = hoveredElementId === el.id
            const isDropAbove = dropTarget?.id === el.id && dropTarget.place === 'above'
            const isDropBelow = dropTarget?.id === el.id && dropTarget.place === 'below'
            const isDropInto = dropTarget?.id === el.id && dropTarget.place === 'into'
            return (
              <li key={el.id} className="relative" data-layer-id={el.id}>
                {/* Drop indicators — a line at the row edge the dragged layer
                    will land against; an inset ring when it lands INSIDE. */}
                {isDropAbove && (
                  <span className="pointer-events-none absolute inset-x-1 top-0 z-10 h-[2px] rounded bg-accent" />
                )}
                {isDropBelow && (
                  <span className="pointer-events-none absolute inset-x-1 bottom-0 z-10 h-[2px] rounded bg-accent" />
                )}
                <div
                  data-layer-row={el.id}
                  role="treeitem"
                  tabIndex={isRenaming ? -1 : el.id === activeRowId ? 0 : -1}
                  aria-selected={isSelected}
                  aria-level={row.depth + 1}
                  aria-expanded={row.hasChildren ? isExpanded : undefined}
                  aria-label={canvasElementLabel(el)}
                  onPointerDown={(e) => onRowPointerDown(e, el.id)}
                  onPointerMove={onRowPointerMove}
                  onPointerUp={onRowPointerUp}
                  onPointerCancel={onRowPointerLost}
                  onLostPointerCapture={onRowPointerLost}
                  onPointerEnter={() => {
                    if (!dragRef.current?.dragging) onHoverElement?.(el.id)
                  }}
                  onPointerLeave={() => onHoverElement?.(null)}
                  onKeyDown={(e) => !isRenaming && onRowKeyDown(e, row, i)}
                  onDoubleClick={() => startRename(el)}
                  className={[
                    'group flex h-6 items-center gap-1 pr-1.5 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60',
                    dragId === el.id ? 'opacity-40' : '',
                    isSelected
                      ? 'bg-accent text-bg-card'
                      : isCanvasHover
                        ? 'bg-bg-inset text-ink'
                        : 'text-ink hover:bg-bg-inset',
                    isDropInto ? 'ring-2 ring-inset ring-accent' : '',
                    isRenaming ? 'cursor-text' : 'cursor-pointer',
                  ].join(' ')}
                  // Indent by depth so nesting reads at a glance.
                  style={{ paddingLeft: 8 + row.depth * 12 }}
                >
                  {/* Expand/collapse twisty — only for containers with children;
                      a fixed-width spacer keeps leaf rows aligned. Hidden while
                      a query filters the tree (the filter owns the expansion). */}
                  {row.hasChildren && !q ? (
                    <button
                      type="button"
                      // The row (treeitem) already exposes aria-expanded + handles
                      // ←/→, so hide the redundant twisty from the a11y tree.
                      aria-hidden="true"
                      tabIndex={-1}
                      onPointerDown={(e) => e.stopPropagation()}
                      // dblclick is its own bubbling event — without this a
                      // quick double-toggle would reach the row and open rename.
                      onDoubleClick={(e) => e.stopPropagation()}
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
                        isHidden ? 'opacity-50' : '',
                      ].join(' ')}
                    >
                      <span
                        className={['shrink-0', isSelected ? 'text-bg-card/80' : 'text-ink-faint'].join(
                          ' ',
                        )}
                      >
                        <LayerIcon element={el} />
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
                      disabled={!canMoveLayer(elements, el.id, 'up')}
                      title={t('canvas.bringForward')}
                      onClick={() => onMove(el.id, 'up')}
                    >
                      <ChevronUp size={12} strokeWidth={2} />
                    </RowButton>
                    <RowButton
                      selected={isSelected}
                      disabled={!canMoveLayer(elements, el.id, 'down')}
                      title={t('canvas.sendBackward')}
                      onClick={() => onMove(el.id, 'down')}
                    >
                      <ChevronDown size={12} strokeWidth={2} />
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
                        <Lock size={12} strokeWidth={2} />
                      ) : (
                        <Unlock size={12} strokeWidth={2} />
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
                        <EyeOff size={12} strokeWidth={2} />
                      ) : (
                        <Eye size={12} strokeWidth={2} />
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

// Type glyph for a row. A frame with auto layout shows its stacking direction
// (Figma's → / ↓) instead of the generic frame icon; everything else uses the
// shared element icon.
const LayerIcon = ({ element }: { element: CanvasElement }) => {
  if (element.type === 'frame' && element.layout) {
    return element.layout.mode === 'row' ? (
      <ArrowRight size={13} strokeWidth={1.75} />
    ) : (
      <ArrowDown size={13} strokeWidth={1.75} />
    )
  }
  return <CanvasElementIcon element={element} />
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
    // dblclick bubbles separately — keep a rapid double-toggle (eye/lock/
    // z-nudge) from reaching the row's rename handler.
    onDoubleClick={(e) => e.stopPropagation()}
    onClick={onClick}
    className={[
      'flex h-5 w-5 items-center justify-center rounded-[4px] transition-colors',
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
