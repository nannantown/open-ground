import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BringToFront, Copy, Group, SendToBack, Trash2, Ungroup } from 'lucide-react'
import { ProjectCard } from './ProjectCard'
import { ElementView } from './ElementView'
import { FrameView } from './FrameView'
import type {
  CanvasElement,
  CanvasState,
  ClaudeBeaconStatus,
  ProjectMeta,
  Tool,
} from '@/lib/types'
import { newId } from '@/lib/ids'
import { clearDanglingAnchors, removeElements } from '@/lib/canvasIntegrity'
import {
  resolveContainerId,
  CONTAINER_TYPES,
  descendantIds,
  containmentDepth,
  rectInside,
  type Container,
  type Rect,
} from '@/lib/canvasContainment'
import {
  groupElements,
  ungroupElements,
  expandSelectionForElement,
  topGroupId,
  groupLeafIds,
  groupCascadeSets,
  withGroupAncestors,
} from '@/lib/canvasGroup'
import { resizeRotatedBR, rotatedCornerBR, normalizeRotation } from '@/lib/canvasTransform'
import { computeSnap, type SnapBox, type SnapGuide } from '@/lib/canvasSnap'
import { resizeGroup, unionBounds, type GResizeItem } from '@/lib/canvasGroupResize'
import { SHAPE_DEFAULT_W, SHAPE_DEFAULT_H, drawRectFromDrag } from '@/lib/canvasShape'
import { useT } from '@/i18n/I18nContext'

interface Props {
  projects: ProjectMeta[]
  /** Ground-only: ids of projects with at least one live PTY — shows the
   *  pulsing "Terminal" beacon on their cards. The per-project Canvas tab
   *  renders no project cards, so it leaves this undefined. */
  terminalActiveIds?: ReadonlySet<string>
  /** Ground-only: per-project claude beacon refinement ('working'/'waiting').
   *  A project with a live PTY but no entry here only hosts plain shells, so
   *  its card shows the legacy 'Terminal' beacon. */
  claudeStatuses?: ReadonlyMap<string, ClaudeBeaconStatus>
  canvas: CanvasState
  onCanvasChange: (c: CanvasState) => void
  selectedIds: string[]
  onSelect: (id: string | null, additive?: boolean) => void
  onSelectIds: (ids: string[]) => void
  editingId: string | null
  onEditingIdChange: (id: string | null) => void
  tool: Tool
  onToolChange: (t: Tool) => void
  /** Project-Canvas-only: duplicate the current selection (⌘D / context menu).
   *  Owned by CanvasWorkspace so it shares the clipboard + history wiring. */
  onDuplicate?: () => void
  /** Project-Canvas-only: when set, image elements resolve their per-canvas
   *  assets through these values. The top-level Ground canvas leaves them
   *  undefined; the image case in ElementView falls back to a placeholder. */
  projectPath?: string
  canvasId?: string
  /** Project-Canvas-only: handle a paste/drop of an image File at world
   *  coordinates. CanvasWorkspace wires this to the /api/canvas/asset
   *  upload path and inserts a fresh ImageElement on success. */
  onImagePaste?: (file: File, worldX: number, worldY: number) => void
}

const CLICK_THRESHOLD_PX = 5
// Two clicks on the same target within this window count as a double-click.
// Kept in line with the typical OS double-click speed (~500ms) so a
// normal-paced double-click reliably opens the editor.
const DOUBLE_CLICK_MS = 500
const ZOOM_MIN = 0.1
const ZOOM_MAX = 2
// Trackpad pinch fires many wheel events per frame; we multiply this by
// e.deltaY so each event nudges the zoom by a perceptible fraction.
const ZOOM_STEP = 0.01
const FRAME_MIN_W = 160
const FRAME_MIN_H = 110
const FRAME_DEFAULT_W = 380
const FRAME_DEFAULT_H = 260
// A shape drag this small or smaller counts as a "click" and drops a default
// box instead. Lower than the frame floor so a small deliberate shape still
// sizes from the drag (shapes are happily small — e.g. a dot or a chip).
const SHAPE_MIN_DRAG = 12
const RESIZE_MIN_W = 130
const RESIZE_MIN_H = 96
const STICKY_DEFAULT = 208
const MOCK_DEFAULT_W = 420
const MOCK_DEFAULT_H = 320
// Pin geometry — kept in sync with CommentPin so anchor-hit-testing and the
// pin's visual offset agree. The pin's bottom-left corner is the "tip" that
// sits exactly on the click point.
const COMMENT_W = 28
const COMMENT_H = 28
// Approximate card / text footprints, used only for marquee hit-testing.
const CARD_W = 256
const CARD_H = 140
const TEXT_W = 300
const TEXT_H = 44
// Drag snapping: an element's edges/centers snap to other elements' within this
// many SCREEN px (converted to world by dividing by zoom). Hold Alt to bypass.
const SNAP_PX = 6
// Element types that carry a resizable width/height (so group-resize scales
// their box, not just their position).
const SIZABLE_TYPES = new Set<CanvasElement['type']>([
  'sticky',
  'frame',
  'mock',
  'shape',
  'image',
  'screen',
])
// Smallest a group-resize bounding box may shrink to (world px), so a selection
// can't collapse to zero.
const GROUP_RESIZE_MIN = 20
// "整理" (tidy) grid geometry, in world px. HEADER mirrors FrameView's h-9
// header bar; PAD is the inset from the frame edge; GAP separates cells.
const FRAME_HEADER_H = 36
const TIDY_PAD = 24
const TIDY_GAP = 20

// Custom cursor for the Comment tool — a small chat-bubble glyph whose
// bottom-left tail is the cursor hotspot. SVG colours come straight from the
// design tokens (accent fill + paper background ring) so it reads as part of
// OPEN GROUND's palette rather than a stock OS cursor. The hotspot (4, 26) lines up
// with the dropped pin's tip so the click and the pin land in the same spot.
const COMMENT_CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
  '<path d="M4 3 H23 A2 2 0 0 1 25 5 V17 A2 2 0 0 1 23 19 H11 L4 26 V19 A2 2 0 0 1 2 17 V5 A2 2 0 0 1 4 3 Z" ' +
  'fill="#B23A2C" stroke="#FBF7EE" stroke-width="1.6" stroke-linejoin="round"/>' +
  '<line x1="8" y1="9" x2="20" y2="9" stroke="#FBF7EE" stroke-width="1.7" stroke-linecap="round"/>' +
  '<line x1="8" y1="13" x2="17" y2="13" stroke="#FBF7EE" stroke-width="1.7" stroke-linecap="round"/>' +
  '</svg>'
const COMMENT_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(COMMENT_CURSOR_SVG)}") 4 26, crosshair`


interface DragPress {
  id: string
  sx: number
  sy: number
  ox: number
  oy: number
  moved: boolean
  shift: boolean
  /** element-only: child elements (e.g. a design's text annotations) carried
   *  rigidly with this element while it drags, captured at press time with
   *  their own origins. Empty for a plain element with no children. */
  children?: { id: string; ox: number; oy: number }[]
  /** Multi-select drag: when the pressed item is part of a selection of >1,
   *  the FULL set of items to move together (project cards + non-frame elements
   *  + frames), captured with their own origins at press time. Undefined for a
   *  single-item drag. Lets a marquee selection move as one unit instead of
   *  dragging out only the item directly under the cursor. */
  group?: { id: string; isCard: boolean; ox: number; oy: number }[]
}

type Press =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | ({ kind: 'card' } & DragPress)
  | ({ kind: 'element' } & DragPress)
  | {
      kind: 'frame'
      id: string
      sx: number
      sy: number
      moved: boolean
      shift: boolean
      items: { id: string; isCard: boolean; ox: number; oy: number }[]
    }
  // draw: a click-drag that sizes a new frame OR shape. `what` records which —
  // 'frame' keeps the legacy frame path; 'rect' / 'ellipse' drop a shape
  // element of that primitive. Shift (square) / Alt (from-centre) are read LIVE
  // off the event in the move/up handlers, so they're not captured here; only
  // the Space-reposition bookkeeping lives on the press:
  //   - sx/sy   anchor (the mouse-down point), BAKED by `offset` each time
  //             Space is released so sizing resumes from the moved box.
  //   - offset  total world-space translation applied to the box while Space
  //             was held mid-draw (Figma's hold-Space-to-move-while-drawing).
  //   - lastP   the last pointer world position used to SIZE the box (frozen
  //             while Space repositions, so the size doesn't change as the box
  //             slides).
  //   - repos   the last pointer world pos seen while Space is held, used to
  //             accumulate `offset`; null when not currently repositioning.
  | {
      kind: 'draw'
      what: 'frame' | 'rect' | 'ellipse'
      sx: number
      sy: number
      offset: { x: number; y: number }
      lastP: { x: number; y: number }
      repos: { x: number; y: number } | null
    }
  // resize: box is the pre-drag rect, rot its rotation; gx/gy is the grab offset
  // (pointer-world minus the handle corner at press) so the drag doesn't jump.
  // Shift-to-lock reads e.shiftKey live in the move handler.
  | {
      kind: 'resize'
      id: string
      box: { x: number; y: number; w: number; h: number }
      rot: number
      gx: number
      gy: number
    }
  // rotate: cx/cy are the element centre in world space; startAngle is the
  // pointer's angle from that centre at press time, startRot the element's
  // rotation then — so the drag applies a RELATIVE turn (no jump on grab).
  | { kind: 'rotate'; id: string; cx: number; cy: number; startAngle: number; startRot: number }
  // groupresize: scale a whole multi-selection from the bbox top-left anchor.
  // box is the pre-drag union bbox; items are each selected element's pre-drag
  // box + sizable flag; gx/gy is the grab offset from the bottom-right corner.
  | {
      kind: 'groupresize'
      box: { x: number; y: number; w: number; h: number }
      items: import('@/lib/canvasGroupResize').GResizeItem[]
      gx: number
      gy: number
    }
  // marquee: sx/sy are viewport-relative screen coordinates
  | { kind: 'marquee'; sx: number; sy: number; shift: boolean }

// Free-form canvas: project cards, text/sticky annotations and grouping
// frames, all freely positioned. The active tool decides what a press does.
export const InfiniteCanvas = ({
  projects,
  terminalActiveIds,
  claudeStatuses,
  canvas,
  onCanvasChange,
  selectedIds,
  onSelect,
  onSelectIds,
  editingId,
  onEditingIdChange,
  tool,
  onToolChange,
  onDuplicate,
  projectPath,
  canvasId,
  onImagePaste,
}: Props) => {
  const { t } = useT()
  // editingId is owned by the page (so the toolbar / shortcuts can drive it);
  // this alias keeps the rest of the component unchanged.
  const setEditingId = onEditingIdChange
  const viewportRef = useRef<HTMLDivElement>(null)
  // Hidden file picker backing the Image tool's click-to-upload. The world
  // coords of the click are stashed here so the (async) change handler knows
  // where on the canvas to drop the resulting image element.
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imageDropPointRef = useRef<{ x: number; y: number } | null>(null)
  const canvasRef = useRef(canvas)
  canvasRef.current = canvas
  // Wheel events from a trackpad pinch fire faster than React can commit, so a
  // handler that only reads canvasRef would see the same stale viewport across
  // a burst of events and effectively produce one zoom step per frame. We
  // accumulate the in-flight viewport here and resync whenever the canvas
  // prop's viewport object identity changes (i.e. an external update).
  const wheelVpRef = useRef(canvas.viewport)
  if (wheelVpRef.current !== canvas.viewport) wheelVpRef.current = canvas.viewport
  const selectedRef = useRef(selectedIds)
  selectedRef.current = selectedIds

  const [panning, setPanning] = useState(false)
  const [draw, setDraw] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // Alignment guide lines shown while a single element is being snap-dragged.
  // The ref mirrors the state so the pointer-up handler can clear them without a
  // stale-closure read (and skip a needless re-render on a plain click).
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
  const snapGuidesRef = useRef<SnapGuide[]>([])
  const setGuides = (g: SnapGuide[]) => {
    snapGuidesRef.current = g
    setSnapGuides(g)
  }
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  )
  // Right-click context menu position (viewport-relative px), or null when closed.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const spaceDown = useRef(false)
  const press = useRef<Press | null>(null)
  // The pointerId that owns the active press. A second pointer (multi-touch)
  // must not hijack or overwrite an in-progress gesture, so every pointer
  // down/move/up is filtered against this (single-active-pointer rule).
  const activePointerId = useRef<number | null>(null)
  // Last pointer client position + modifier state seen during an active draw —
  // lets a modifier-key press/release (Shift / Alt / Space) re-render the
  // in-progress box even when the mouse hasn't moved (Figma evaluates modifiers
  // continuously, not just on pointer-move).
  const lastDrawClient = useRef<{ clientX: number; clientY: number } | null>(null)
  const prevEditing = useRef<string | null>(null)
  // Last click that landed on a card/element/frame — used to pair double-clicks.
  const lastClick = useRef<{ id: string; t: number } | null>(null)

  const { viewport, positions, elements } = canvas
  // Layers-panel visibility: a `hidden` element is dropped from EVERY render
  // pass (frames / notes / comments / anchor hints) and from hit-testing below,
  // so it neither paints nor catches clicks — but it stays in `elements`, so it
  // keeps its z-order and can be un-hidden from the panel. Omitted = visible.
  // A group is invisible, so hiding/locking a GROUP must cascade to its members.
  // Precompute the affected id sets ONCE (O(n)); the render passes below then do
  // O(1) lookups instead of an O(depth) ancestor walk per element.
  const { hiddenViaGroup, lockedViaGroup } = groupCascadeSets(elements)
  const visible = elements.filter((el) => !el.hidden && !hiddenViaGroup.has(el.id))
  // Frames paint shallowest-first so a CONTAINER frame sits behind the frames it
  // nests (Figma-style): a child frame (deeper) must render after — and so on
  // top of — its parent, otherwise the outer frame would cover the inner one's
  // header. Stable sort preserves insertion order within a depth.
  const frameById = new Map(
    visible.filter((el) => el.type === 'frame').map((el) => [el.id, el]),
  )
  const frames = visible
    .filter((el) => el.type === 'frame')
    .sort(
      (a, b) => containmentDepth(frameById, a.id) - containmentDepth(frameById, b.id),
    )
  // Render order: non-comment notes first, then comments. Comment popups
  // need to layer above sibling stickies / mocks so a pin dropped on a
  // mockup can still open its editor cleanly.
  // A `group` is an invisible container (membership only) — it never paints on
  // the canvas; it's managed entirely from the Layers panel + as a selection
  // unit. So it's dropped from every render pass and from hit-testing below.
  const notes = visible.filter(
    (el) => el.type !== 'frame' && el.type !== 'comment' && el.type !== 'group',
  )
  const comments = visible.filter((el) => el.type === 'comment')

  // Anchor-visibility: while a comment is selected or being edited, outline the
  // element it points at so the user can see WHICH thing the feedback is about
  // — chiefly over a mock, where the pin can sit far from the part it critiques.
  // Unanchored comments contribute nothing (no stray outline); a dangling
  // anchorId resolves to no element below, so deleting the target also clears
  // the highlight for free (same surviving-set rule as clearDanglingAnchors).
  const anchoredHints = comments.filter(
    (c) => c.anchorId && (selectedIds.includes(c.id) || editingId === c.id),
  )

  // Friendly label for a comment's anchor — what shows up in the popup
  // header as "↳ {label}", plus what gets fed to the Run prompt. Picks a
  // human-readable identifier so the user (and Claude) know which element
  // the feedback is about.
  const anchorLabelFor = (anchorId: string | undefined): string | null => {
    if (!anchorId) return null
    const a = elements.find((e) => e.id === anchorId)
    if (!a) return null
    if (a.type === 'mock') {
      return a.name || (a.framework === 'html' ? 'HTML mock' : 'React mock')
    }
    if (a.type === 'frame') return a.text?.trim() ? `Frame: ${a.text.trim()}` : 'Frame'
    if (a.type === 'shape') return a.shapeKind === 'ellipse' ? 'Ellipse' : 'Rectangle'
    if (a.type === 'sticky') {
      const t = a.text.trim().split('\n')[0]?.slice(0, 32) ?? ''
      return t ? `Sticky: ${t}` : 'Sticky'
    }
    if (a.type === 'text') return a.text.trim().slice(0, 32) || 'Text'
    return null
  }

  const toggleCommentResolved = (id: string) => {
    const c = canvasRef.current
    onCanvasChange({
      ...c,
      elements: c.elements.map((el) =>
        el.id === id && el.type === 'comment' ? { ...el, resolved: !el.resolved } : el,
      ),
    })
  }

  // A locked element (directly, or via a locked group ancestor) shows no
  // resize/rotate handles — its body is already pointer-events:none, and the
  // handles are separate overlays that would otherwise defeat the lock.
  const isManipulable = (el: CanvasElement) => !el.locked && !lockedViaGroup.has(el.id)

  // The lone selected sticky/frame/mock gets a corner resize handle. Text
  // elements size themselves from their content; comments are fixed-size
  // pins by design (resizing a pin makes no UX sense).
  const resizeTarget =
    tool === 'select' && selectedIds.length === 1 && !editingId
      ? elements.find(
          (el) =>
            el.id === selectedIds[0] &&
            el.type !== 'text' &&
            el.type !== 'comment' &&
            isManipulable(el),
        ) ?? null
      : null

  // The lone selected element (any visible type but a comment pin or an
  // invisible group) gets a rotation handle above its top edge. Drag it to spin
  // the element about its centre; hold Shift to snap to 15°.
  const rotateTarget =
    tool === 'select' && selectedIds.length === 1 && !editingId
      ? elements.find(
          (el) =>
            el.id === selectedIds[0] &&
            el.type !== 'comment' &&
            el.type !== 'group' &&
            isManipulable(el),
        ) ?? null
      : null

  const worldFromClientXY = (clientX: number, clientY: number) => {
    const rect = viewportRef.current!.getBoundingClientRect()
    const v = canvasRef.current.viewport
    return {
      x: (clientX - rect.left - v.x) / v.zoom,
      y: (clientY - rect.top - v.y) / v.zoom,
    }
  }

  const worldFromEvent = (e: React.PointerEvent) => worldFromClientXY(e.clientX, e.clientY)

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!viewportRef.current) return
      // Close a floating context menu on scroll/zoom (no-op when already closed
      // — React bails on an unchanged null state, so this won't storm renders).
      setMenu(null)
      e.preventDefault()
      const rect = viewportRef.current.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const c = canvasRef.current
      // Compose against the latest in-flight viewport, not the rendered one,
      // so back-to-back trackpad events compound instead of all reading the
      // same stale baseline.
      const v = wheelVpRef.current
      let next
      if (e.ctrlKey || e.metaKey) {
        const delta = -e.deltaY * ZOOM_STEP
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * (1 + delta)))
        const wx = (cx - v.x) / v.zoom
        const wy = (cy - v.y) / v.zoom
        next = { zoom: newZoom, x: cx - wx * newZoom, y: cy - wy * newZoom }
      } else {
        next = { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }
      }
      wheelVpRef.current = next
      onCanvasChange({ ...c, viewport: next })
    },
    [onCanvasChange],
  )

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // Image paste / drop. Active only when the parent wired `onImagePaste`
  // (Canvas tab — the top-level Ground portal doesn't support images yet).
  // Document-scope listeners so the user can drop a screenshot anywhere over
  // the canvas without first focusing a specific element. A chat textarea
  // catches its own paste before the document handler ever fires, so this
  // doesn't fight the chat composer's image-paste-to-instruction flow.
  useEffect(() => {
    if (!onImagePaste) return
    const node = viewportRef.current
    if (!node) return
    const containsTarget = (t: EventTarget | null) =>
      t instanceof Node && (node.contains(t) || t === document.body)
    const worldFromClient = (cx: number, cy: number) => {
      const rect = node.getBoundingClientRect()
      const v = canvasRef.current.viewport
      return {
        x: (cx - rect.left - v.x) / v.zoom,
        y: (cy - rect.top - v.y) / v.zoom,
      }
    }
    const center = () => {
      const rect = node.getBoundingClientRect()
      const v = canvasRef.current.viewport
      return {
        x: (rect.width / 2 - v.x) / v.zoom,
        y: (rect.height / 2 - v.y) / v.zoom,
      }
    }
    const onPaste = (e: ClipboardEvent) => {
      if (!containsTarget(e.target)) return
      const items = e.clipboardData?.items
      if (!items) return
      let consumed = false
      for (const item of Array.from(items)) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (!file) continue
        if (!consumed) {
          e.preventDefault()
          consumed = true
        }
        const c = center()
        onImagePaste(file, c.x, c.y)
      }
    }
    const onDragOver = (e: DragEvent) => {
      if (!containsTarget(e.target)) return
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent) => {
      if (!containsTarget(e.target)) return
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
        f.type.startsWith('image/'),
      )
      if (files.length === 0) return
      e.preventDefault()
      const w = worldFromClient(e.clientX, e.clientY)
      files.forEach((f, i) => onImagePaste(f, w.x + i * 24, w.y + i * 24))
    }
    document.addEventListener('paste', onPaste)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [onImagePaste])

  // Delete key removes selected text/sticky/frame elements (not project
  // cards; deleting a frame leaves its contents in place).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (editingId) return
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      const c = canvasRef.current
      // removeElements scrubs any comment whose anchor — or element whose parent
      // frame — was just deleted (no dangling anchorId / parentId), and returns
      // the same reference when nothing matched. Locked elements are filtered out
      // so Delete can't remove them (matches the pointer/keyboard lock).
      const locked = lockedIds(c.elements)
      const next = removeElements(
        c.elements,
        selectedIds.filter((id) => !locked.has(id)),
      )
      if (next === c.elements) return
      e.preventDefault()
      onCanvasChange({ ...c, elements: next })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editingId, selectedIds, onCanvasChange])

  // ⌘G groups the selection; ⌘⇧G ungroups. Gated on no active editor / field so
  // typing a "g" is never swallowed. groupSelection / ungroupSelection read live
  // refs, so re-subscribe only when the change sinks change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'g' && e.key !== 'G') || !(e.metaKey || e.ctrlKey)) return
      if (editingId) return
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      e.preventDefault()
      if (e.shiftKey) ungroupSelection()
      else groupSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, onCanvasChange, onSelectIds])

  // Dismiss the context menu on Escape or any press outside it. Capture-phase
  // pointerdown so it fires before an element's own handler stopPropagation —
  // otherwise left-clicking a different element would leave the menu floating
  // and its destructive actions would target the newly-selected element.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Arrow keys nudge the selection (Shift = ×10); ] / [ bring it to front /
  // send it to back. Gated on no editor / no field focus so typing is safe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingId || e.metaKey || e.ctrlKey || e.altKey) return
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      if (!selectedRef.current.length) return
      const nudges: Record<string, [number, number]> = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      }
      const n = nudges[e.key]
      if (n) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        nudgeSelection(n[0] * step, n[1] * step)
      } else if (e.key === ']') {
        e.preventDefault()
        reorderSelection(true)
      } else if (e.key === '[') {
        e.preventDefault()
        reorderSelection(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // reorderSelection / nudgeSelection read live refs, so they don't need to
    // be deps; re-subscribe only when the edit gate or change sink changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, onCanvasChange])

  // Holding Space turns any drag into a pan (Figma-style), so an empty-canvas
  // drag stays free for marquee selection.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      e.preventDefault()
      spaceDown.current = true
      setSpaceHeld(true)
      // Mid-draw: start freezing the size / translating the box on the next move
      // — but also reflect the toggle immediately if the mouse is stationary.
      recomputeDraw(e.shiftKey, e.altKey)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      spaceDown.current = false
      setSpaceHeld(false)
      recomputeDraw(e.shiftKey, e.altKey)
    }
    const blur = () => {
      spaceDown.current = false
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
    // recomputeDraw reads only refs (press / lastDrawClient), so it needn't be
    // a dep; the listeners are stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Shift (square) / Alt (from-centre) toggled mid-draw with a stationary mouse
  // still re-render the in-progress box, matching Figma's continuous modifier
  // evaluation. Pointer-move already covers the common (moving) case; this
  // catches the press/release-while-still edge.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' && e.key !== 'Alt') return
      recomputeDraw(e.shiftKey, e.altKey)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Leaving a text element empty makes it an invisible ghost — drop it once
  // editing moves away. Stickies and frames are kept (they are real objects).
  useEffect(() => {
    const prev = prevEditing.current
    prevEditing.current = editingId
    if (!prev || prev === editingId) return
    const c = canvasRef.current
    const el = c.elements.find((e) => e.id === prev)
    if (el && el.type === 'text' && !el.text.trim()) {
      const remaining = c.elements.filter((e) => e.id !== prev)
      onCanvasChange({ ...c, elements: clearDanglingAnchors(remaining) })
    }
  }, [editingId, onCanvasChange])

  const capture = (e: React.PointerEvent) => {
    activePointerId.current = e.pointerId
    try {
      ;(viewportRef.current as HTMLElement | null)?.setPointerCapture(e.pointerId)
    } catch {}
  }

  // True when a press is already active and THIS event belongs to a different
  // pointer — used to ignore a second finger/stylus so it can't overwrite or
  // drive the in-progress gesture.
  const isForeignPointer = (e: React.PointerEvent) =>
    press.current !== null &&
    activePointerId.current !== null &&
    e.pointerId !== activePointerId.current

  // Bounds of an element in world space — used both for anchoring a fresh
  // comment to whatever it was dropped on, and (separately) by marquee
  // selection upstream. Cards are excluded; comments anchor only to
  // user-authored design content (mock / sticky / frame / shape / text).
  const elementBounds = (el: CanvasElement) => {
    if (el.type === 'sticky' || el.type === 'mock') {
      const ew = el.width ?? (el.type === 'mock' ? MOCK_DEFAULT_W : STICKY_DEFAULT)
      const eh = el.height ?? (el.type === 'mock' ? MOCK_DEFAULT_H : STICKY_DEFAULT)
      return { x: el.x, y: el.y, w: ew, h: eh }
    }
    if (el.type === 'shape') {
      return { x: el.x, y: el.y, w: el.width ?? SHAPE_DEFAULT_W, h: el.height ?? SHAPE_DEFAULT_H }
    }
    if (el.type === 'frame') {
      return { x: el.x, y: el.y, w: el.width ?? 0, h: el.height ?? 0 }
    }
    if (el.type === 'text') {
      return { x: el.x, y: el.y, w: TEXT_W, h: TEXT_H }
    }
    return null
  }

  // Find the topmost commentable element under a world-space point. Iterate
  // from the end of the array (later-added items render on top), prefer the
  // smallest bounding box so a sticky inside a frame wins over the frame.
  const anchorAt = (wx: number, wy: number): string | undefined => {
    let best: { id: string; area: number } | null = null
    for (let i = canvasRef.current.elements.length - 1; i >= 0; i--) {
      const el = canvasRef.current.elements[i]
      if (el.type === 'comment' || el.type === 'group' || el.hidden) continue
      const b = elementBounds(el)
      if (!b) continue
      // Rotation-aware hit-test: map the point into the element's LOCAL frame
      // (rotate by -rotation about its centre) before the axis-aligned check, so
      // dropping a comment on a rotated element anchors to what's visually there.
      let px = wx
      let py = wy
      const rot = normalizeRotation(el.rotation ?? 0)
      if (rot) {
        const cx = b.x + b.w / 2
        const cy = b.y + b.h / 2
        const r = (-rot * Math.PI) / 180
        const dx = wx - cx
        const dy = wy - cy
        px = cx + dx * Math.cos(r) - dy * Math.sin(r)
        py = cy + dx * Math.sin(r) + dy * Math.cos(r)
      }
      if (px < b.x || px > b.x + b.w || py < b.y || py > b.y + b.h) continue
      const area = b.w * b.h
      if (!best || area < best.area) best = { id: el.id, area }
    }
    return best?.id
  }

  const createNote = (type: 'text' | 'sticky' | 'comment', e: React.PointerEvent) => {
    const w = worldFromEvent(e)
    let el: CanvasElement
    if (type === 'sticky') {
      el = {
        id: newId(),
        type,
        x: w.x,
        y: w.y,
        width: STICKY_DEFAULT,
        height: STICKY_DEFAULT,
        text: '',
      }
    } else if (type === 'comment') {
      // The pin's bottom-left "tip" should land exactly on the click point,
      // so shift the element up by its full height. Anchor binds to whatever
      // commentable element is under the click — Claude will reference it
      // when the user later hits Run.
      const anchorId = anchorAt(w.x, w.y)
      el = {
        id: newId(),
        type,
        x: w.x,
        y: w.y - COMMENT_H,
        width: COMMENT_W,
        height: COMMENT_H,
        text: '',
        ...(anchorId ? { anchorId } : {}),
      }
    } else {
      el = { id: newId(), type, x: w.x, y: w.y, text: '' }
      // A text dropped on top of a design (mock/screen) — or inside a frame —
      // anchors to it straight away, so "type text on top of a generated design"
      // works without first nudging the label. Same containment rule as a drag.
      if (type === 'text') {
        const parentId = resolveContainerId(
          el.id,
          'text',
          { x: w.x, y: w.y, w: TEXT_W, h: TEXT_H },
          containerList(canvasRef.current.elements),
        )
        if (parentId) el.parentId = parentId
      }
    }
    const c = canvasRef.current
    onCanvasChange({ ...c, elements: [...c.elements, el] })
    setEditingId(el.id)
    onSelect(el.id)
    onToolChange('select')
  }

  // Backs the Image tool's hidden file picker: drop each chosen image at the
  // stashed click point (cascaded slightly so a multi-select doesn't stack
  // pixel-perfect), then return to the select tool — matching createNote's UX.
  const onImageFilesPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    )
    e.target.value = ''
    if (!onImagePaste || files.length === 0) return
    const drop = imageDropPointRef.current
    imageDropPointRef.current = null
    if (!drop) return
    files.forEach((f, i) => onImagePaste(f, drop.x + i * 24, drop.y + i * 24))
    onToolChange('select')
  }

  const startPan = (e: React.PointerEvent) => {
    const v = canvasRef.current.viewport
    press.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y }
    setPanning(true)
    capture(e)
  }

  const onViewportPointerDown = (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (menu) setMenu(null)
    // Space+drag pans, regardless of tool or what is under the cursor.
    if (spaceDown.current) {
      startPan(e)
      return
    }
    if (tool === 'text' || tool === 'sticky' || tool === 'comment') {
      createNote(tool, e)
      return
    }
    // Image tool: a click opens the OS file picker; the chosen image(s) land
    // at the click point via onImagePaste (same upload path as paste/drop).
    // Only meaningful when the parent wired onImagePaste (embedded Canvas) —
    // the top-level Ground portal has no image support, so fall through to
    // marquee select there. Stash the click's world coords for the (async)
    // change handler, then trigger the hidden input.
    if (tool === 'image' && onImagePaste) {
      const w = worldFromEvent(e)
      imageDropPointRef.current = { x: w.x, y: w.y }
      const input = imageInputRef.current
      if (input) {
        // Reset so re-picking the same file still fires `change`.
        input.value = ''
        input.click()
      }
      return
    }
    // Frame + shape tools share one click-drag-to-size gesture (the frame tool
    // is the precedent). `what` carries which the drag will create on pointer-up.
    if (tool === 'frame' || tool === 'rect' || tool === 'ellipse') {
      const w = worldFromEvent(e)
      press.current = {
        kind: 'draw',
        what: tool,
        sx: w.x,
        sy: w.y,
        offset: { x: 0, y: 0 },
        lastP: { x: w.x, y: w.y },
        repos: null,
      }
      setDraw({ x: w.x, y: w.y, w: 0, h: 0 })
      capture(e)
      return
    }
    // Select tool on empty canvas → marquee selection.
    setEditingId(null)
    const rect = viewportRef.current!.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    press.current = { kind: 'marquee', sx, sy, shift: e.shiftKey }
    setMarquee({ x: sx, y: sy, w: 0, h: 0 })
    capture(e)
  }

  // Capture the origins of EVERY currently-selected item (project cards via the
  // positions map, elements/frames via their x/y) so a drag started on any one
  // of them moves the whole selection rigidly. Returns undefined for a single
  // selection so the caller keeps the lighter single-item drag path.
  const buildGroupItems = (
    c: CanvasState,
    pressedId: string,
  ): { id: string; isCard: boolean; ox: number; oy: number }[] | undefined => {
    const sel = selectedRef.current
    if (!sel.includes(pressedId) || sel.length < 2) return undefined
    const projIds = new Set(projects.map((p) => p.id))
    const items: { id: string; isCard: boolean; ox: number; oy: number }[] = []
    for (const id of sel) {
      if (projIds.has(id)) {
        const pos = c.positions[id]
        if (pos) items.push({ id, isCard: true, ox: pos.x, oy: pos.y })
      } else {
        const el = c.elements.find((e) => e.id === id)
        if (el) items.push({ id, isCard: false, ox: el.x, oy: el.y })
      }
    }
    return items.length > 1 ? items : undefined
  }

  // Move-set for a drag started on `pressedId`, group-aware: it expands the
  // active multi-selection (if the pressed item is part of it, else just the
  // pressed item) by the GROUP each id belongs to — clicking any group member
  // moves the whole group — and then by every descendant (frame children /
  // design annotations / nested), so a container carries its contents. Group
  // elements themselves have no position, so they're omitted. Returns undefined
  // for a lone item so the caller keeps the lighter single-item drag path.
  const dragMoveItems = (
    c: CanvasState,
    pressedId: string,
  ): { id: string; isCard: boolean; ox: number; oy: number }[] | undefined => {
    const sel = selectedRef.current
    const base = sel.includes(pressedId) && sel.length > 1 ? sel : [pressedId]
    const ids = new Set<string>()
    for (const id of base) {
      for (const gid of expandSelectionForElement(c.elements, id)) ids.add(gid)
    }
    for (const id of Array.from(ids)) {
      descendantIds(c.elements, id).forEach((d) => ids.add(d))
    }
    const projIds = new Set(projects.map((p) => p.id))
    const items: { id: string; isCard: boolean; ox: number; oy: number }[] = []
    for (const id of Array.from(ids)) {
      if (projIds.has(id)) {
        const pos = c.positions[id]
        if (pos) items.push({ id, isCard: true, ox: pos.x, oy: pos.y })
      } else {
        const el = c.elements.find((e) => e.id === id)
        if (el && el.type !== 'group') items.push({ id, isCard: false, ox: el.x, oy: el.y })
      }
    }
    return items.length > 1 ? items : undefined
  }

  const onCardPointerDown = (project: ProjectMeta) => (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    setEditingId(null)
    const c = canvasRef.current
    const pos = c.positions[project.id]
    if (!pos) return
    const group = buildGroupItems(c, project.id)
    press.current = {
      kind: 'card',
      id: project.id,
      sx: e.clientX,
      sy: e.clientY,
      ox: pos.x,
      oy: pos.y,
      moved: false,
      shift: e.shiftKey,
      ...(group ? { group } : {}),
    }
    setPanning(true)
    capture(e)
  }

  const onElementPointerDown = (el: CanvasElement) => (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    if (editingId === el.id) return
    setEditingId(null)
    // A design (mock/screen) drags its text annotations rigidly with it, so a
    // label placed on top of the rendered design stays put on the design. Frames
    // have their own header-drag path; here we only need design → text children.
    const children =
      el.type === 'mock' || el.type === 'screen'
        ? canvasRef.current.elements
            .filter((c) => c.parentId === el.id)
            .map((c) => ({ id: c.id, ox: c.x, oy: c.y }))
        : undefined
    const group = dragMoveItems(canvasRef.current, el.id)
    press.current = {
      kind: 'element',
      id: el.id,
      sx: e.clientX,
      sy: e.clientY,
      ox: el.x,
      oy: el.y,
      moved: false,
      shift: e.shiftKey,
      ...(children && children.length ? { children } : {}),
      ...(group ? { group } : {}),
    }
    setPanning(true)
    capture(e)
  }

  const onFramePointerDown = (frame: CanvasElement) => (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    if (editingId === frame.id) return
    setEditingId(null)
    const c = canvasRef.current
    // A frame that's been grouped (⌘G) drags as part of its group — the group is
    // the selection unit, so route through the multi-item element drag.
    if (topGroupId(c.elements, frame.id)) {
      const group = dragMoveItems(c, frame.id)
      if (group) {
        press.current = {
          kind: 'element',
          id: frame.id,
          sx: e.clientX,
          sy: e.clientY,
          ox: frame.x,
          oy: frame.y,
          moved: false,
          shift: e.shiftKey,
          group,
        }
        setPanning(true)
        capture(e)
        return
      }
    }
    // Membership is now PERSISTED on each element as `parentId === frame.id`,
    // so moving a frame carries exactly the children it actually contains —
    // independent of where they sit at this instant — and that survives a
    // reload. (The old build captured "items whose centre is inside" at
    // drag-start; that was transient and recomputed every drag.) Project cards
    // have no parentId field (positions are a separate map), so they are not
    // frame children in this slice.
    const items: { id: string; isCard: boolean; ox: number; oy: number }[] = [
      { id: frame.id, isCard: false, ox: frame.x, oy: frame.y },
    ]
    // Every DESCENDANT element rides along, preserving relative positions:
    // direct children, a design's text annotations, AND — now that frames can
    // nest — child frames and everything inside them, recursively. Driven off
    // the persisted `parentId` chain so it always matches true membership.
    const descIds = descendantIds(c.elements, frame.id)
    for (const el of c.elements) {
      if (descIds.has(el.id)) {
        items.push({ id: el.id, isCard: false, ox: el.x, oy: el.y })
      }
    }
    // …plus any PROJECT CARD geometrically sitting on the frame. Cards have no
    // `parentId` (their positions live in a separate map), so frame membership
    // for cards is decided by geometry at drag-start: a card whose centre lies
    // inside the frame's box rides along — including a card inside a nested
    // child frame, which is also inside this frame's box. This is what makes a
    // frame group cards on the Ground canvas — drop cards onto the frame, then
    // drag its header to move the whole cluster.
    for (const id of cardsInFrame(frame)) {
      const pos = c.positions[id]
      if (pos) items.push({ id, isCard: true, ox: pos.x, oy: pos.y })
    }
    press.current = {
      kind: 'frame',
      id: frame.id,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      shift: e.shiftKey,
      items,
    }
    setPanning(true)
    capture(e)
  }

  // Drag the bottom-right handle of the selected sticky/frame to resize it.
  // Captures the full pre-drag box + rotation so a rotated element resizes along
  // its own axes (the corner is rotated about the centre), plus the grab offset
  // so the corner doesn't jump to the pointer on press.
  const onResizePointerDown = (el: CanvasElement) => (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    const b = fullBounds(el)
    const rot = normalizeRotation(el.rotation ?? 0) // NaN-safe (guards bad JSON)
    const corner = rotatedCornerBR(b, rot)
    const w = worldFromEvent(e)
    press.current = {
      kind: 'resize',
      id: el.id,
      box: b,
      rot,
      gx: w.x - corner.x,
      gy: w.y - corner.y,
    }
    setPanning(true)
    capture(e)
  }

  // Drag the bottom-right handle of a MULTI-selection's bounding box to scale the
  // whole selection from its top-left anchor (Shift = proportional).
  const onGroupResizePointerDown =
    (box: { x: number; y: number; w: number; h: number }, items: GResizeItem[]) =>
    (e: React.PointerEvent) => {
      if (press.current) return
      if (tool !== 'select' || spaceDown.current) return
      e.stopPropagation()
      const w = worldFromEvent(e)
      press.current = {
        kind: 'groupresize',
        box,
        items,
        gx: w.x - (box.x + box.w),
        gy: w.y - (box.y + box.h),
      }
      setPanning(true)
      capture(e)
    }

  // Drag the handle above the selected element to rotate it about its centre.
  const onRotatePointerDown = (el: CanvasElement) => (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    const b = fullBounds(el)
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    const w = worldFromEvent(e)
    press.current = {
      kind: 'rotate',
      id: el.id,
      cx,
      cy,
      startAngle: Math.atan2(w.y - cy, w.x - cx),
      startRot: normalizeRotation(el.rotation ?? 0), // NaN-safe (guards bad JSON)
    }
    setPanning(true)
    capture(e)
  }

  // Resolve the in-progress draw box for the current pointer + live modifiers,
  // and fold in the Space-to-reposition bookkeeping. Mutates the press's
  // offset/lastP/repos so the next move/up reads a consistent state:
  //   - While Space is held, the box size freezes (lastP stays put) and the
  //     pointer delta accumulates into `offset`, translating the whole box.
  //   - When Space is released, the accumulated `offset` is BAKED into the
  //     anchor (sx/sy) and zeroed, so resizing resumes from the moved position
  //     (Figma's behaviour) with no jump.
  // Shift (square) and Alt (from-centre) are read live off the event here, so
  // toggling either mid-drag updates the box on the next move — and the up
  // handler runs the same function, keeping the committed element identical to
  // the preview.
  const drawRectForEvent = (
    p: Extract<Press, { kind: 'draw' }>,
    clientX: number,
    clientY: number,
    shift: boolean,
    alt: boolean,
  ) => {
    lastDrawClient.current = { clientX, clientY }
    const w = worldFromClientXY(clientX, clientY)
    if (spaceDown.current) {
      // Entering / continuing a Space-reposition: accumulate the pointer delta
      // into the box's translation while keeping its size frozen.
      if (p.repos) {
        p.offset.x += w.x - p.repos.x
        p.offset.y += w.y - p.repos.y
      }
      p.repos = { x: w.x, y: w.y }
    } else {
      if (p.repos) {
        // Space just released — bake the translation into the anchor so sizing
        // resumes from the moved box with no jump, then resume tracking.
        p.sx += p.offset.x
        p.sy += p.offset.y
        p.offset = { x: 0, y: 0 }
        p.repos = null
      }
      // Not repositioning: this pointer drives the box size.
      p.lastP = { x: w.x, y: w.y }
    }
    return drawRectFromDrag(
      { x: p.sx, y: p.sy },
      p.lastP,
      { shift, alt, offset: p.offset },
    )
  }

  // Re-render the in-progress draw box from a modifier-key press/release while
  // the mouse is stationary. No-op unless a draw press is active with a known
  // last pointer position. Reads the live modifier flags off the key event.
  const recomputeDraw = (shift: boolean, alt: boolean) => {
    const p = press.current
    const last = lastDrawClient.current
    if (!p || p.kind !== 'draw' || !last) return
    setDraw(drawRectForEvent(p, last.clientX, last.clientY, shift, alt))
  }

  const onViewportPointerMove = (e: React.PointerEvent) => {
    if (isForeignPointer(e)) return // a 2nd pointer must not drive the gesture
    const p = press.current
    if (!p) return
    const c = canvasRef.current
    if (p.kind === 'resize') {
      // Map the pointer (minus the grab offset) onto the box's local axes,
      // keeping the opposite corner anchored — correct for a rotated element and
      // identical to the legacy top-left-anchored resize when rot === 0. Shift
      // locks the aspect ratio (read live so it can toggle mid-drag).
      const pw = worldFromEvent(e)
      const next = resizeRotatedBR(
        p.box,
        p.rot,
        { x: pw.x - p.gx, y: pw.y - p.gy },
        { minW: RESIZE_MIN_W, minH: RESIZE_MIN_H, lockAspect: e.shiftKey },
      )
      onCanvasChange({
        ...c,
        elements: c.elements.map((el) =>
          el.id === p.id
            ? { ...el, x: next.x, y: next.y, width: next.w, height: next.h }
            : el,
        ),
      })
      return
    }
    if (p.kind === 'rotate') {
      const w = worldFromEvent(e)
      const angle = Math.atan2(w.y - p.cy, w.x - p.cx)
      let raw = p.startRot + ((angle - p.startAngle) * 180) / Math.PI
      // Shift snaps to 15° increments (Figma). Read live off the event.
      if (e.shiftKey) raw = Math.round(raw / 15) * 15
      // Shared normalizer → (-180,180], matching the inspector field.
      const deg = normalizeRotation(raw)
      onCanvasChange({
        ...c,
        elements: c.elements.map((el) =>
          el.id === p.id ? { ...el, rotation: deg === 0 ? undefined : deg } : el,
        ),
      })
      return
    }
    if (p.kind === 'groupresize') {
      const w = worldFromEvent(e)
      let newW = Math.max(GROUP_RESIZE_MIN, w.x - p.gx - p.box.x)
      let newH = Math.max(GROUP_RESIZE_MIN, w.y - p.gy - p.box.y)
      if (e.shiftKey && p.box.w > 0 && p.box.h > 0) {
        // Proportional: one uniform scale (the dominant axis drives it).
        const s = Math.max(newW / p.box.w, newH / p.box.h)
        newW = Math.max(GROUP_RESIZE_MIN, p.box.w * s)
        newH = Math.max(GROUP_RESIZE_MIN, p.box.h * s)
      }
      const sx = newW / p.box.w
      const sy = newH / p.box.h
      const updates = new Map(
        resizeGroup(p.items, { x: p.box.x, y: p.box.y }, sx, sy).map((u) => [u.id, u]),
      )
      onCanvasChange({
        ...c,
        elements: c.elements.map((el) => {
          const u = updates.get(el.id)
          if (!u) return el
          return u.w !== undefined
            ? { ...el, x: u.x, y: u.y, width: u.w, height: u.h }
            : { ...el, x: u.x, y: u.y }
        }),
      })
      return
    }
    if (p.kind === 'pan') {
      onCanvasChange({
        ...c,
        viewport: { ...c.viewport, x: p.vx + (e.clientX - p.sx), y: p.vy + (e.clientY - p.sy) },
      })
      return
    }
    if (p.kind === 'draw') {
      setDraw(drawRectForEvent(p, e.clientX, e.clientY, e.shiftKey, e.altKey))
      return
    }
    if (p.kind === 'marquee') {
      const rect = viewportRef.current!.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setMarquee({
        x: Math.min(p.sx, cx),
        y: Math.min(p.sy, cy),
        w: Math.abs(cx - p.sx),
        h: Math.abs(cy - p.sy),
      })
      return
    }
    if (!p.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > CLICK_THRESHOLD_PX) {
      p.moved = true
    }
    if (!p.moved) return
    const dx = (e.clientX - p.sx) / c.viewport.zoom
    const dy = (e.clientY - p.sy) / c.viewport.zoom
    // Multi-select drag: move every captured item (cards + elements + frames)
    // by the same delta so the whole selection travels together.
    if ((p.kind === 'card' || p.kind === 'element') && p.group) {
      const nextPositions = { ...c.positions }
      const elMoves = new Map<string, { x: number; y: number }>()
      for (const it of p.group) {
        const np = { x: it.ox + dx, y: it.oy + dy }
        if (it.isCard) nextPositions[it.id] = np
        else elMoves.set(it.id, np)
      }
      onCanvasChange({
        ...c,
        positions: nextPositions,
        elements: c.elements.map((el) =>
          elMoves.has(el.id) ? { ...el, ...elMoves.get(el.id)! } : el,
        ),
      })
      return
    }
    if (p.kind === 'card') {
      onCanvasChange({
        ...c,
        positions: { ...c.positions, [p.id]: { x: p.ox + dx, y: p.oy + dy } },
      })
    } else if (p.kind === 'element') {
      // Snap the dragged element's edges/centers to the other elements (unless
      // Alt is held to bypass), then move it + any carried children by the same
      // (snapped) delta so they ride along rigidly.
      let sdx = dx
      let sdy = dy
      let guides: SnapGuide[] = []
      const moved = c.elements.find((el) => el.id === p.id)
      if (moved && !e.altKey) {
        const movingBox = { ...moved, x: p.ox + dx, y: p.oy + dy }
        const carried = new Set<string>([p.id, ...(p.children?.map((ch) => ch.id) ?? [])])
        const targets: SnapBox[] = []
        for (const el of c.elements) {
          if (carried.has(el.id) || el.hidden || el.type === 'group' || el.type === 'comment')
            continue
          targets.push(fullBounds(el))
        }
        const snap = computeSnap(fullBounds(movingBox), targets, SNAP_PX / c.viewport.zoom)
        sdx = dx + snap.dx
        sdy = dy + snap.dy
        guides = snap.guides
      }
      const childMoves = p.children
        ? new Map(p.children.map((ch) => [ch.id, { x: ch.ox + sdx, y: ch.oy + sdy }]))
        : null
      onCanvasChange({
        ...c,
        elements: c.elements.map((el) => {
          if (el.id === p.id) return { ...el, x: p.ox + sdx, y: p.oy + sdy }
          const m = childMoves?.get(el.id)
          return m ? { ...el, x: m.x, y: m.y } : el
        }),
      })
      setGuides(guides)
    } else {
      // frame: move the frame and everything captured inside it
      const nextPositions = { ...c.positions }
      const elMoves = new Map<string, { x: number; y: number }>()
      for (const it of p.items) {
        const np = { x: it.ox + dx, y: it.oy + dy }
        if (it.isCard) nextPositions[it.id] = np
        else elMoves.set(it.id, np)
      }
      onCanvasChange({
        ...c,
        positions: nextPositions,
        elements: c.elements.map((el) =>
          elMoves.has(el.id) ? { ...el, ...elMoves.get(el.id)! } : el,
        ),
      })
    }
  }

  const onViewportPointerUp = (e: React.PointerEvent) => {
    // Ignore a 2nd pointer lifting; only the owning pointer ends the gesture.
    // (pointercancel routes here too — for that we always clean up.)
    if (e.type !== 'pointercancel' && isForeignPointer(e)) return
    const p = press.current
    if (p) {
      if (p.kind === 'card' || p.kind === 'element' || p.kind === 'frame') {
        if (p.moved) {
          // A drag is not a click — don't let it pair with the next one.
          lastClick.current = null
          // Frame containment: when an element is dropped, recompute its frame
          // membership from where it landed (rect inside a frame → parentId =
          // that frame; outside every frame → cleared). A *frame* drag carries
          // its descendants rigidly, so their membership is unchanged — but the
          // dragged frame ITSELF can now nest into (or out of) another frame, so
          // reparent it too. A lone card has no parentId, so nothing to do.
          if (p.kind === 'card' || p.kind === 'element' || p.kind === 'frame') {
            // Reparent every moved non-card element (a group drag can carry
            // several); a single element/frame drag reparents just itself; a
            // single card drag has nothing to reparent (cards have no parentId).
            const movedIds =
              p.kind === 'frame'
                ? new Set([p.id])
                : p.group
                  ? new Set(p.group.filter((it) => !it.isCard).map((it) => it.id))
                  : p.kind === 'element'
                    ? new Set([p.id])
                    : null
            if (movedIds) {
              const cur = canvasRef.current
              const reparented = reparentMoved(cur.elements, movedIds)
              // Keep design annotations painting on top of their design after a
              // (re)parent — a text just dropped on a mock/screen must sit above
              // the iframe, not behind it.
              const ordered = raiseDesignAnnotations(reparented)
              if (ordered !== cur.elements) {
                onCanvasChange({ ...cur, elements: ordered })
              }
            }
          }
        } else {
          // Group-aware selection: clicking any member of a group selects the
          // whole group (the selection unit), so a follow-up drag moves it all.
          const groupSel = expandSelectionForElement(canvasRef.current.elements, p.id)
          if (groupSel.length > 1) {
            onSelectIds(
              p.shift
                ? Array.from(new Set([...selectedRef.current, ...groupSel]))
                : groupSel,
            )
          } else {
            onSelect(p.id, p.shift)
          }
          // Detect double-clicks here rather than via the DOM dblclick event:
          // the viewport holds pointer capture during a press, which retargets
          // the browser's click/dblclick away from the pressed element.
          const now = Date.now()
          const lc = lastClick.current
          if (lc && lc.id === p.id && now - lc.t < DOUBLE_CLICK_MS) {
            lastClick.current = null
            // Text/sticky notes and frames carry editable text; cards do not.
            if (p.kind === 'element' || p.kind === 'frame') {
              setEditingId(p.id)
            }
          } else {
            lastClick.current = { id: p.id, t: now }
          }
        }
      }
      if (p.kind === 'resize') {
        // A resize changes the RESIZED element's own box, so ITS OWN container
        // membership can change (a sticky resized into a frame joins it; a frame
        // resized so it now nests in another frame reparents) — recompute it for
        // that element, like a drag-drop. (It does not pull stationary elements
        // in.) Rotation leaves x/y/w/h unchanged, so it needs no reparent.
        const cur = canvasRef.current
        const reparented = reparentMoved(cur.elements, new Set([p.id]))
        const ordered = raiseDesignAnnotations(reparented)
        if (ordered !== cur.elements) onCanvasChange({ ...cur, elements: ordered })
      }
      if (p.kind === 'marquee') {
        const rect = viewportRef.current!.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        if (Math.hypot(cx - p.sx, cy - p.sy) <= CLICK_THRESHOLD_PX) {
          // A click on empty canvas — clear the selection.
          if (!p.shift) onSelect(null)
        } else {
          // Convert the screen rect to world space and collect overlaps.
          const c = canvasRef.current
          const v = c.viewport
          const x1 = (Math.min(p.sx, cx) - v.x) / v.zoom
          const y1 = (Math.min(p.sy, cy) - v.y) / v.zoom
          const x2 = (Math.max(p.sx, cx) - v.x) / v.zoom
          const y2 = (Math.max(p.sy, cy) - v.y) / v.zoom
          const overlaps = (ex: number, ey: number, ew: number, eh: number) =>
            ex + ew >= x1 && ex <= x2 && ey + eh >= y1 && ey <= y2
          const hit: string[] = []
          for (const proj of projects) {
            const pos = c.positions[proj.id]
            if (pos && overlaps(pos.x, pos.y, CARD_W, CARD_H)) hit.push(proj.id)
          }
          const lockedForMarquee = lockedIds(c.elements)
          for (const el of c.elements) {
            // Skip frames/groups/hidden AND locked elements — a locked layer
            // shouldn't be marquee-selectable (else keyboard ops could mutate it).
            if (
              el.type === 'frame' ||
              el.type === 'group' ||
              el.hidden ||
              lockedForMarquee.has(el.id)
            )
              continue
            const ew =
              el.type === 'sticky' || el.type === 'mock'
                ? el.width ?? (el.type === 'mock' ? MOCK_DEFAULT_W : STICKY_DEFAULT)
                : el.type === 'shape'
                  ? el.width ?? SHAPE_DEFAULT_W
                  : el.type === 'comment'
                    ? COMMENT_W
                    : TEXT_W
            const eh =
              el.type === 'sticky' || el.type === 'mock'
                ? el.height ?? (el.type === 'mock' ? MOCK_DEFAULT_H : STICKY_DEFAULT)
                : el.type === 'shape'
                  ? el.height ?? SHAPE_DEFAULT_H
                  : el.type === 'comment'
                    ? COMMENT_H
                    : TEXT_H
            if (overlaps(el.x, el.y, ew, eh)) hit.push(el.id)
          }
          // A marquee that grazes any group member pulls in the whole group, so
          // the selection stays a coherent unit (matches click selection).
          const expanded = Array.from(
            new Set(hit.flatMap((id) => expandSelectionForElement(c.elements, id))),
          )
          onSelectIds(
            p.shift
              ? Array.from(new Set([...selectedRef.current, ...expanded]))
              : expanded,
          )
        }
        setMarquee(null)
      }
      if (p.kind === 'draw') {
        // Same modifier + Space-offset math as the live preview, so the
        // committed box is exactly what the user saw under the cursor.
        const box = drawRectForEvent(p, e.clientX, e.clientY, e.shiftKey, e.altKey)
        lastDrawClient.current = null
        // The anchor after baking any Space translation — where a plain click
        // (no meaningful drag) drops its default-sized box.
        const anchorX = p.sx + p.offset.x
        const anchorY = p.sy + p.offset.y
        const id = newId()
        const c = canvasRef.current
        if (p.what === 'frame') {
          // A real drag sizes the frame; a plain click drops a default frame.
          const sized = box.w >= FRAME_MIN_W && box.h >= FRAME_MIN_H
          const fw = sized ? box.w : FRAME_DEFAULT_W
          const fh = sized ? box.h : FRAME_DEFAULT_H
          const x = sized ? box.x : anchorX
          const y = sized ? box.y : anchorY
          const newFrame: CanvasElement = {
            id,
            type: 'frame',
            x,
            y,
            width: fw,
            height: fh,
            text: '',
          }
          const withFrame = [...c.elements, newFrame]
          // Figma-style: a frame drawn around existing content ADOPTS what it
          // fully encloses — including other frames (nesting). reparentMoved
          // picks the innermost frame and excludes a frame's own descendants, so
          // already-nested elements keep their tighter parent and no cycle forms.
          // (Project cards are geometric, not parentId-based, so they need no
          // adoption — they're already "in" any frame whose box covers them.)
          const frameBox = fullBounds(newFrame) as Rect
          const moved = new Set<string>(
            withFrame
              .filter(
                (el) =>
                  el.id !== id && rectInside(fullBounds(el) as Rect, frameBox),
              )
              .map((el) => el.id),
          )
          // Also resolve the NEW frame's own parent: drawn INSIDE an existing
          // frame, it nests into it (parentId = the enclosing frame). Including
          // its id makes reparentMoved set both directions in one pass.
          moved.add(id)
          const adopted = reparentMoved(withFrame, moved)
          onCanvasChange({ ...c, elements: adopted })
          // A fresh frame jumps straight into its label editor.
          setEditingId(id)
        } else {
          // Shape (rect / ellipse): a real drag sizes it; a tiny drag / plain
          // click drops a default box. Shapes have no editable label, so we
          // never enter the editor — just select the new shape.
          const sized = box.w >= SHAPE_MIN_DRAG && box.h >= SHAPE_MIN_DRAG
          const sw = sized ? box.w : SHAPE_DEFAULT_W
          const sh = sized ? box.h : SHAPE_DEFAULT_H
          const x = sized ? box.x : anchorX
          const y = sized ? box.y : anchorY
          onCanvasChange({
            ...c,
            elements: [
              ...c.elements,
              { id, type: 'shape', shapeKind: p.what, x, y, width: sw, height: sh, text: '' },
            ],
          })
        }
        onSelect(id)
        onToolChange('select')
        setDraw(null)
      }
    }
    press.current = null
    activePointerId.current = null
    if (snapGuidesRef.current.length) setGuides([]) // clear alignment guides on release
    setPanning(false)
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {}
  }

  const changeText = (id: string, text: string) => {
    const c = canvasRef.current
    onCanvasChange({
      ...c,
      elements: c.elements.map((el) => (el.id === id ? { ...el, text } : el)),
    })
  }

  const changeColor = (id: string, color: string) => {
    const c = canvasRef.current
    onCanvasChange({
      ...c,
      elements: c.elements.map((el) => (el.id === id ? { ...el, color } : el)),
    })
  }

  // Ids that are locked — directly, or via a locked group ancestor — and so must
  // be immune to EVERY mutation, not just pointer drags: keyboard nudge, z-order,
  // delete, and marquee selection. (The body already has pointer-events:none; a
  // lock that keyboard/marquee could bypass wouldn't be a lock.)
  const lockedIds = (els: CanvasElement[]): Set<string> => {
    const { lockedViaGroup } = groupCascadeSets(els)
    const out = new Set(lockedViaGroup)
    for (const e of els) if (e.locked) out.add(e.id)
    return out
  }

  // Z-order is implicit in array order: front = end of array, back = start.
  // Moves the whole selection while preserving its internal order.
  const reorderSelection = (toFront: boolean) => {
    const c = canvasRef.current
    const locked = lockedIds(c.elements)
    const base = selectedRef.current.filter((id) => !locked.has(id))
    if (!base.length) return
    // Expand to the whole group block — the group element(s) + every descendant —
    // so bringing a grouped element to front/back moves the group as one unit,
    // matching the Layers-panel drag (reorderLayer's contiguous-block model).
    const sel = new Set(withGroupAncestors(c.elements, base))
    for (const id of Array.from(sel)) descendantIds(c.elements, id).forEach((d) => sel.add(d))
    const picked = c.elements.filter((el) => sel.has(el.id))
    const rest = c.elements.filter((el) => !sel.has(el.id))
    onCanvasChange({ ...c, elements: toFront ? [...rest, ...picked] : [...picked, ...rest] })
  }

  const nudgeSelection = (dx: number, dy: number) => {
    const c = canvasRef.current
    const locked = lockedIds(c.elements)
    const sel = new Set(selectedRef.current.filter((id) => !locked.has(id)))
    if (!sel.size) return
    onCanvasChange({
      ...c,
      elements: c.elements.map((el) =>
        sel.has(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el,
      ),
    })
  }

  const deleteSelection = () => {
    const c = canvasRef.current
    const locked = lockedIds(c.elements)
    // removeElements scrubs any comment whose anchor — or element whose parent
    // frame — was just deleted (no dangling anchorId / parentId).
    const next = removeElements(
      c.elements,
      selectedRef.current.filter((id) => !locked.has(id)),
    )
    if (next !== c.elements) onCanvasChange({ ...c, elements: next })
  }

  // Full bounding box for hit-testing any element type (anchorAt/elementBounds
  // intentionally cover only commentable types).
  const fullBounds = (el: CanvasElement) => {
    if (el.type === 'text') return { x: el.x, y: el.y, w: TEXT_W, h: TEXT_H }
    if (el.type === 'comment') return { x: el.x, y: el.y, w: COMMENT_W, h: COMMENT_H }
    // A shape is a plain axis-aligned rect (an ellipse uses its bounding box for
    // hit-testing), so its width/height are its bounds directly.
    const dw =
      el.type === 'mock'
        ? MOCK_DEFAULT_W
        : el.type === 'screen'
          ? 1280
          : el.type === 'shape'
            ? SHAPE_DEFAULT_W
            : STICKY_DEFAULT
    const dh =
      el.type === 'mock'
        ? MOCK_DEFAULT_H
        : el.type === 'screen'
          ? 800
          : el.type === 'shape'
            ? SHAPE_DEFAULT_H
            : STICKY_DEFAULT
    return { x: el.x, y: el.y, w: el.width ?? dw, h: el.height ?? dh }
  }

  const topElementAt = (wx: number, wy: number): string | undefined => {
    for (let i = canvasRef.current.elements.length - 1; i >= 0; i--) {
      const el = canvasRef.current.elements[i]
      if (el.hidden || el.type === 'group') continue
      const b = fullBounds(el)
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return el.id
    }
    return undefined
  }

  // ⌘G — wrap the selected top-level elements in a new (invisible) group. The
  // new selection becomes the group's leaf members so a follow-up drag moves the
  // whole group. No-op for fewer than two groupable elements.
  const groupSelection = () => {
    const c = canvasRef.current
    const res = groupElements(c.elements, selectedRef.current, newId, fullBounds)
    if (!res) return
    onCanvasChange({ ...c, elements: res.elements })
    onSelectIds(groupLeafIds(res.elements, res.groupId))
  }

  // ⌘⇧G — dissolve every group implicated by the selection, freeing its children
  // back to the group's own parent. The freed elements become the new selection.
  const ungroupSelection = () => {
    const c = canvasRef.current
    const res = ungroupElements(c.elements, selectedRef.current)
    if (!res) return
    onCanvasChange({ ...c, elements: res.elements })
    onSelectIds(res.freedIds)
  }

  // Recompute container membership for the moved elements after a drag settles,
  // and return the elements array with each one's `parentId` set / cleared to
  // match where it actually landed (rect containment). Containers are frames AND
  // designs (mock/screen): a frame owns any child (including another frame —
  // Figma-style nesting), a design owns a `text` annotation dropped on top of it
  // (see canContain). A frame's own descendants are excluded as candidates so it
  // can't nest into itself. Returns the same array reference when nothing changed
  // so callers can skip a redundant write.
  // Geometric containers only — a `group` is a semantic (explicit) container, so
  // it's a CONTAINER_TYPE for the panel/dangling logic but has no real box and
  // must be kept OUT of geometric auto-parenting.
  const containerList = (els: CanvasElement[]): Container[] =>
    els
      .filter((el) => CONTAINER_TYPES.has(el.type) && el.type !== 'group')
      .map((el) => ({ id: el.id, type: el.type, rect: fullBounds(el) as Rect }))

  const reparentMoved = (
    els: CanvasElement[],
    movedIds: Set<string>,
  ): CanvasElement[] => {
    const containers = containerList(els)
    const groupIds = new Set(els.filter((e) => e.type === 'group').map((e) => e.id))
    let changed = false
    const next = els.map((el) => {
      if (!movedIds.has(el.id)) return el
      // An element explicitly grouped (parent is a group) keeps that membership —
      // groups aren't geometric, so geometric reparenting must not rip it out.
      if (el.parentId && groupIds.has(el.parentId)) return el
      // A frame may now nest inside another frame — but never inside one of its
      // own descendants (that would be a containment cycle), so drop those from
      // the candidate containers. Non-frames have no descendants to exclude.
      const candidates =
        el.type === 'frame'
          ? (() => {
              const desc = descendantIds(els, el.id)
              return containers.filter((c) => !desc.has(c.id))
            })()
          : containers
      const parentId = resolveContainerId(
        el.id,
        el.type,
        fullBounds(el) as Rect,
        candidates,
      )
      if (parentId === el.parentId) return el
      changed = true
      if (parentId === undefined) {
        const { parentId: _drop, ...rest } = el
        return rest as CanvasElement
      }
      return { ...el, parentId }
    })
    return changed ? next : els
  }

  // A text annotation must paint ABOVE the design it's anchored to (a mock /
  // screen renders an iframe; array order is paint order). Pull every text whose
  // parent is a design to the END of the array so it sits on top of that design.
  // Stable for everything else; returns the same reference when already ordered.
  const raiseDesignAnnotations = (els: CanvasElement[]): CanvasElement[] => {
    const designIds = new Set(
      els.filter((e) => e.type === 'mock' || e.type === 'screen').map((e) => e.id),
    )
    const anchored = (e: CanvasElement) =>
      e.type === 'text' && !!e.parentId && designIds.has(e.parentId)
    const lastDesignIdx = els.reduce(
      (acc, e, i) => (e.type === 'mock' || e.type === 'screen' ? i : acc),
      -1,
    )
    // Already on top if no annotation precedes the last design in the array.
    const needsRaise = els.some((e, i) => anchored(e) && i < lastDesignIdx)
    if (!needsRaise) return els
    const rest = els.filter((e) => !anchored(e))
    const labels = els.filter(anchored)
    return [...rest, ...labels]
  }

  // Project cards whose CENTRE lies inside `frame`'s box, by id. Cards carry no
  // `parentId` (positions are a separate map), so a frame's card membership is
  // purely geometric and recomputed on demand. Shared by the frame drag (carry
  // contents) and the "整理" tidy action.
  //
  // `directOnly` restricts the result to cards whose INNERMOST frame is this one
  // — a card that sits inside a nested child frame belongs to that child, not to
  // this outer frame. The drag uses the full geometric set (everything inside
  // rides along); tidy + the 整理 badge use directOnly so an outer frame doesn't
  // reshuffle a nested frame's cards.
  const cardsInFrame = (
    frame: CanvasElement,
    opts?: { directOnly?: boolean },
  ): string[] => {
    const c = canvasRef.current
    const fb = fullBounds(frame)
    const otherFrames = opts?.directOnly
      ? c.elements
          .filter((e) => e.type === 'frame' && e.id !== frame.id)
          .map((e) => ({ id: e.id, b: fullBounds(e), area: 0 }))
          .map((f) => ({ ...f, area: f.b.w * f.b.h }))
      : null
    const thisArea = fb.w * fb.h
    const ids: string[] = []
    for (const proj of projects) {
      const pos = c.positions[proj.id]
      if (!pos) continue
      const cx = pos.x + CARD_W / 2
      const cy = pos.y + CARD_H / 2
      if (!(cx >= fb.x && cx <= fb.x + fb.w && cy >= fb.y && cy <= fb.y + fb.h))
        continue
      // Skip when a smaller (nested) frame also holds this card's centre — it is
      // that nested frame's card, not ours.
      if (
        otherFrames?.some(
          (f) =>
            f.area < thisArea &&
            cx >= f.b.x &&
            cx <= f.b.x + f.b.w &&
            cy >= f.b.y &&
            cy <= f.b.y + f.b.h,
        )
      )
        continue
      ids.push(proj.id)
    }
    return ids
  }

  // "整理": snap the cards inside a frame into a tidy grid, keeping them in their
  // current reading order (row, then column) so each card barely moves from
  // where it already sits — the closest neat arrangement. The frame grows (never
  // shrinks) to fit the grid, so nothing spills outside it.
  const tidyFrame = (frame: CanvasElement) => {
    const c = canvasRef.current
    const ids = cardsInFrame(frame, { directOnly: true })
    if (ids.length === 0) return
    // Real rendered card heights: offsetHeight is the pre-transform layout size
    // (= world px, the CSS `scale` doesn't change it), so the grid rows can't
    // overlap a tall card. Width is fixed (w-64 = CARD_W).
    const heightById = new Map<string, number>()
    const root = viewportRef.current
    if (root) {
      for (const id of ids) {
        const node = root.querySelector(
          `[data-card-id="${CSS.escape(id)}"]`,
        ) as HTMLElement | null
        if (node) heightById.set(id, node.offsetHeight)
      }
    }
    const cellH = Math.max(CARD_H, ...ids.map((id) => heightById.get(id) ?? 0))
    const rowBand = cellH + TIDY_GAP
    const ordered = ids
      .map((id) => ({ id, pos: c.positions[id]! }))
      .sort((a, b) => {
        const ra = Math.round(a.pos.y / rowBand)
        const rb = Math.round(b.pos.y / rowBand)
        if (ra !== rb) return ra - rb
        return a.pos.x - b.pos.x
      })
    const fb = fullBounds(frame)
    const usableW = Math.max(fb.w, CARD_W + TIDY_PAD * 2)
    const cols = Math.max(
      1,
      Math.floor((usableW - TIDY_PAD * 2 + TIDY_GAP) / (CARD_W + TIDY_GAP)),
    )
    const rows = Math.ceil(ordered.length / cols)
    const nextPositions = { ...c.positions }
    ordered.forEach((item, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      nextPositions[item.id] = {
        x: fb.x + TIDY_PAD + col * (CARD_W + TIDY_GAP),
        y: fb.y + FRAME_HEADER_H + TIDY_PAD + row * (cellH + TIDY_GAP),
      }
    })
    // Grow the frame to contain the grid (never shrink — respect the user's
    // chosen shape; only extend when the grid needs more room).
    const neededW = TIDY_PAD * 2 + cols * CARD_W + (cols - 1) * TIDY_GAP
    const neededH =
      FRAME_HEADER_H + TIDY_PAD * 2 + rows * cellH + (rows - 1) * TIDY_GAP
    const nextW = Math.max(frame.width ?? 0, neededW)
    const nextH = Math.max(frame.height ?? 0, neededH)
    const grew = nextW !== (frame.width ?? 0) || nextH !== (frame.height ?? 0)
    const nextElements = grew
      ? c.elements.map((el) =>
          el.id === frame.id ? { ...el, width: nextW, height: nextH } : el,
        )
      : c.elements
    onCanvasChange({ ...c, positions: nextPositions, elements: nextElements })
  }

  const onContextMenu = (e: React.MouseEvent) => {
    const rect = viewportRef.current!.getBoundingClientRect()
    const v = canvasRef.current.viewport
    const wx = (e.clientX - rect.left - v.x) / v.zoom
    const wy = (e.clientY - rect.top - v.y) / v.zoom
    const id = topElementAt(wx, wy)
    if (!id) {
      setMenu(null)
      return
    }
    e.preventDefault()
    if (!selectedRef.current.includes(id)) onSelect(id)
    setMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  // Context-menu gating for group/ungroup. Groupable = ≥2 selected top-level
  // elements (a child whose parent is also selected doesn't count). Ungroupable
  // = the selection includes a group, or a member of one.
  const selById = new Map(elements.map((e) => [e.id, e]))
  const selSet = new Set(selectedIds)
  const canGroup =
    selectedIds.filter((id) => {
      const el = selById.get(id)
      return !!el && !(el.parentId && selSet.has(el.parentId))
    }).length >= 2
  const canUngroup = selectedIds.some((id) => {
    const el = selById.get(id)
    if (!el) return false
    return el.type === 'group' || (!!el.parentId && selById.get(el.parentId)?.type === 'group')
  })

  // Multi-selection group resize: when 2+ live, manipulable (unlocked, non-group,
  // non-comment) elements are selected, a bounding box + corner handle scales
  // them all from the top-left anchor. (A single selection uses the per-element
  // resize handle instead.) Sizable types scale their box; text repositions only.
  const groupResizeItems: GResizeItem[] =
    tool === 'select' && !editingId && selectedIds.length >= 2
      ? selectedIds.flatMap((id) => {
          const el = selById.get(id)
          if (
            !el ||
            el.type === 'group' ||
            el.type === 'comment' ||
            el.hidden ||
            !isManipulable(el)
          )
            return []
          const b = fullBounds(el)
          return [{ id, x: b.x, y: b.y, w: b.w, h: b.h, sizable: SIZABLE_TYPES.has(el.type) }]
        })
      : []
  const groupBox = groupResizeItems.length >= 2 ? unionBounds(groupResizeItems) : null

  const contentStyle = useMemo<React.CSSProperties>(
    () => ({
      transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      transformOrigin: '0 0',
    }),
    [viewport],
  )

  const gridStyle = useMemo<React.CSSProperties>(() => {
    const fine = 24 * viewport.zoom
    const major = 192 * viewport.zoom
    return {
      backgroundSize: `${fine}px ${fine}px, ${fine}px ${fine}px, ${major}px ${major}px, ${major}px ${major}px`,
      backgroundPosition: `${viewport.x}px ${viewport.y}px`,
    }
  }, [viewport])

  // The Comment tool gets its own cursor — a small chat-bubble glyph whose
  // bottom-left tail points at the click coordinate, matching where the
  // dropped pin actually lands. Every other non-select tool keeps the
  // generic crosshair so we don't proliferate bespoke cursors.
  const commentCursor = tool === 'comment' && !spaceHeld
  const cursor = commentCursor
    ? ''
    : tool !== 'select'
      ? 'cursor-crosshair'
      : spaceHeld
        ? panning
          ? 'cursor-grabbing'
          : 'cursor-grab'
        : 'cursor-default'

  const wrapperStyle = commentCursor
    ? { ...gridStyle, cursor: COMMENT_CURSOR }
    : gridStyle

  return (
    <div
      ref={viewportRef}
      onPointerDown={onViewportPointerDown}
      onPointerMove={onViewportPointerMove}
      onPointerUp={onViewportPointerUp}
      onPointerCancel={onViewportPointerUp}
      // Defensive: if the OS yanks pointer capture without a pointercancel
      // (rare), still run the up-path so a press can't get stuck.
      onLostPointerCapture={onViewportPointerUp}
      onContextMenu={onContextMenu}
      onMouseDown={(e) => {
        // The canvas is not focusable, so a press on it would pull focus to
        // <body> and blur a freshly-opened editor. Suppress that default —
        // editing is driven entirely by the editingId state instead.
        const t = e.target as HTMLElement
        if (t.tagName !== 'TEXTAREA' && t.tagName !== 'INPUT') e.preventDefault()
      }}
      className={[
        'canvas-grid relative h-full w-full overflow-hidden touch-none',
        cursor,
        // Force every descendant to inherit the wrapper's cursor while the
        // Comment tool is active — otherwise hovering a sticky / mock /
        // frame would flip the cursor back to grab via that element's own
        // class, hiding the speech-bubble glyph the user just enabled.
        commentCursor ? 'canvas-comment-cursor' : '',
      ].join(' ')}
      style={wrapperStyle}
    >
      {/* Hidden file picker for the Image tool's click-to-upload. Rendered
          only when the parent supports image upload (embedded Canvas). */}
      {onImagePaste && (
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={onImageFilesPicked}
        />
      )}

      <div className="absolute inset-0 origin-top-left" style={contentStyle}>
        {/* frames sit behind everything */}
        {frames.map((frame) => (
          <div
            key={frame.id}
            className="absolute"
            style={{
              left: frame.x,
              top: frame.y,
              transform: frame.rotation ? `rotate(${frame.rotation}deg)` : undefined,
              transformOrigin: 'center',
              mixBlendMode:
                frame.blendMode && frame.blendMode !== 'normal' ? frame.blendMode : undefined,
              ...(frame.locked || lockedViaGroup.has(frame.id)
                ? { pointerEvents: 'none' as const }
                : {}),
            }}
          >
            <FrameView
              frame={frame}
              selected={selectedIds.includes(frame.id)}
              editing={editingId === frame.id}
              onHeaderPointerDown={onFramePointerDown(frame)}
              onChangeLabel={(t) => changeText(frame.id, t)}
              onEditDone={() => setEditingId(null)}
              onTidy={
                cardsInFrame(frame, { directOnly: true }).length > 0
                  ? () => tidyFrame(frame)
                  : undefined
              }
            />
          </div>
        ))}

        {draw && draw.w > 0 && draw.h > 0 && (
          <div
            className="pointer-events-none absolute rounded-[4px] border-2 border-dashed border-accent"
            style={{
              left: draw.x,
              top: draw.y,
              width: draw.w,
              height: draw.h,
              background: 'rgba(178,58,44,0.06)',
            }}
          />
        )}

        {projects.map((p) => {
          const pos = positions[p.id]
          if (!pos) return null
          return (
            <div
              key={p.id}
              data-card-id={p.id}
              className="absolute"
              style={{ left: pos.x, top: pos.y }}
            >
              <ProjectCard
                project={p}
                onPointerDown={onCardPointerDown(p)}
                selected={selectedIds.includes(p.id)}
                terminalActive={terminalActiveIds?.has(p.id) ?? false}
                claudeStatus={claudeStatuses?.get(p.id)}
              />
            </div>
          )
        })}

        {notes.map((el) => (
          <div
            key={el.id}
            className="absolute"
            style={{
              left: el.x,
              top: el.y,
              // Figma-parity transforms applied at the positioning wrapper so
              // they cover every element type uniformly: rotate() about centre,
              // mix-blend-mode, and pointer-events:none for a locked element
              // (clicks fall through; unlock from the Layers panel).
              transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
              transformOrigin: 'center',
              mixBlendMode:
                el.blendMode && el.blendMode !== 'normal' ? el.blendMode : undefined,
              ...(el.locked || lockedViaGroup.has(el.id)
                ? { pointerEvents: 'none' as const }
                : {}),
            }}
          >
            <ElementView
              element={el}
              selected={selectedIds.includes(el.id)}
              editing={editingId === el.id}
              onPointerDown={onElementPointerDown(el)}
              onChangeText={(t) => changeText(el.id, t)}
              onChangeColor={(color) => changeColor(el.id, color)}
              onEditDone={() => setEditingId(null)}
              projectPath={projectPath}
              canvasId={canvasId}
              commentTool={commentCursor}
            />
          </div>
        ))}

        {/* Anchor-visibility overlay: a thin accent outline around the element
            each *selected* comment points at, plus a dashed connector from the
            pin's tip to the anchor's centre. Drawn after notes (so it sits over
            the anchor's body) but before comments (so pins/popups stay on top).
            Pointer-events off — purely indicative, never steals clicks from the
            element underneath. Strokes use non-scaling vector-effect / 1/zoom
            widths so the hint stays a light 1.5px hairline at any zoom, clearly
            lighter than the 2px+offset selection ring. */}
        {anchoredHints.map((c) => {
          const anchor = elements.find((e) => e.id === c.anchorId)
          if (!anchor || anchor.hidden) return null
          const b = fullBounds(anchor)
          // Pin tip is the badge's bottom-left corner (see createNote): the
          // element sits COMMENT_H above the click point.
          const tipX = c.x
          const tipY = c.y + COMMENT_H
          const cx = b.x + b.w / 2
          const cy = b.y + b.h / 2
          return (
            <div
              key={`anchor-hl-${c.id}`}
              className="pointer-events-none absolute"
              style={{ left: 0, top: 0, zIndex: 9 }}
            >
              <div
                className="absolute rounded-[5px]"
                style={{
                  left: b.x,
                  top: b.y,
                  width: b.w,
                  height: b.h,
                  // Match the anchored element's rotation so the outline hugs it
                  // (the element renders rotated about its centre too).
                  transform: anchor.rotation
                    ? `rotate(${normalizeRotation(anchor.rotation)}deg)`
                    : undefined,
                  transformOrigin: 'center',
                  border: `${1.5 / viewport.zoom}px solid rgba(178,58,44,0.55)`,
                  boxShadow: `inset 0 0 0 ${3 / viewport.zoom}px rgba(178,58,44,0.12)`,
                }}
              />
              <svg
                className="absolute overflow-visible"
                style={{ left: 0, top: 0, width: 0, height: 0 }}
              >
                <line
                  x1={tipX}
                  y1={tipY}
                  x2={cx}
                  y2={cy}
                  stroke="rgba(178,58,44,0.5)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          )
        })}

        {/* Comments render last so their popups layer above sibling notes. */}
        {comments.map((el) => (
          <div
            key={el.id}
            className="absolute"
            style={{
              left: el.x,
              top: el.y,
              // The selected comment sits above its peers so an overlapping
              // pin doesn't catch clicks meant for the open popup.
              zIndex: selectedIds.includes(el.id) || editingId === el.id ? 30 : 10,
            }}
          >
            <ElementView
              element={el}
              selected={selectedIds.includes(el.id)}
              editing={editingId === el.id}
              onPointerDown={onElementPointerDown(el)}
              onChangeText={(t) => changeText(el.id, t)}
              onEditDone={() => setEditingId(null)}
              onToggleCommentResolved={toggleCommentResolved}
              commentAnchorLabel={anchorLabelFor(el.anchorId)}
            />
          </div>
        ))}

        {/* Alignment guides — thin accent lines shown while snap-dragging. */}
        {snapGuides.map((g, i) => (
          <div
            key={`snap-${i}`}
            className="pointer-events-none absolute bg-accent"
            style={
              g.axis === 'x'
                ? { left: g.pos, top: g.from, width: 1 / viewport.zoom, height: g.to - g.from }
                : { left: g.from, top: g.pos, width: g.to - g.from, height: 1 / viewport.zoom }
            }
          />
        ))}

        {/* Multi-selection bounding box + corner handle (group resize). */}
        {groupBox && (
          <>
            <div
              className="pointer-events-none absolute rounded-[2px]"
              style={{
                left: groupBox.x,
                top: groupBox.y,
                width: groupBox.w,
                height: groupBox.h,
                border: `${1 / viewport.zoom}px dashed rgba(178,58,44,0.6)`,
              }}
            />
            <div
              onPointerDown={onGroupResizePointerDown(groupBox, groupResizeItems)}
              className="absolute h-3.5 w-3.5 rounded-[2px] border-2 border-accent bg-bg-card shadow-card"
              style={{ left: groupBox.x + groupBox.w - 7, top: groupBox.y + groupBox.h - 7, cursor: 'nwse-resize' }}
            />
          </>
        )}

        {resizeTarget &&
          (() => {
            // Sit the handle on the element's ROTATED bottom-right corner so it
            // tracks a turned element (matches the rotation handle).
            const corner = rotatedCornerBR(
              fullBounds(resizeTarget),
              normalizeRotation(resizeTarget.rotation ?? 0),
            )
            return (
              <div
                onPointerDown={onResizePointerDown(resizeTarget)}
                className="absolute h-3.5 w-3.5 rounded-[2px] border-2 border-accent bg-bg-card shadow-card"
                style={{
                  left: corner.x - 7,
                  top: corner.y - 7,
                  cursor: 'nwse-resize',
                }}
              />
            )
          })()}

        {/* Rotation handle — a round grip above the element's (visual) top edge.
            Its position is rotated about the centre so it tracks a turned
            element; the drag itself sets el.rotation. */}
        {rotateTarget &&
          (() => {
            const b = fullBounds(rotateTarget)
            const cx = b.x + b.w / 2
            const cy = b.y + b.h / 2
            const rot = (normalizeRotation(rotateTarget.rotation ?? 0) * Math.PI) / 180
            const d = b.h / 2 + 22
            const hx = cx + d * Math.sin(rot)
            const hy = cy - d * Math.cos(rot)
            return (
              <div
                onPointerDown={onRotatePointerDown(rotateTarget)}
                title="Drag to rotate (Shift = 15°)"
                className="absolute h-3.5 w-3.5 rounded-full border-2 border-accent bg-bg-card shadow-card"
                style={{ left: hx - 7, top: hy - 7, cursor: 'grab' }}
              />
            )
          })()}
      </div>

      {/* Marquee rectangle — drawn in screen space, above the content */}
      {marquee && (marquee.w > 1 || marquee.h > 1) && (
        <div
          className="pointer-events-none absolute rounded-[2px] border border-accent"
          style={{
            left: marquee.x,
            top: marquee.y,
            width: marquee.w,
            height: marquee.h,
            background: 'rgba(178,58,44,0.08)',
          }}
        />
      )}

      {/* Right-click context menu for the selected element(s). */}
      {menu && (
        <div
          ref={menuRef}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute z-50 min-w-[168px] overflow-hidden rounded-[6px] border border-line bg-bg-card py-1 shadow-card-hover"
          style={{ left: menu.x, top: menu.y }}
        >
          {onDuplicate && (
            <ContextItem
              icon={<Copy size={13} strokeWidth={2} />}
              label={t('canvasEl.menu.duplicate')}
              hint="⌘D"
              onClick={() => {
                onDuplicate()
                setMenu(null)
              }}
            />
          )}
          <ContextItem
            icon={<BringToFront size={13} strokeWidth={2} />}
            label={t('canvasEl.menu.bringToFront')}
            hint="]"
            onClick={() => {
              reorderSelection(true)
              setMenu(null)
            }}
          />
          <ContextItem
            icon={<SendToBack size={13} strokeWidth={2} />}
            label={t('canvasEl.menu.sendToBack')}
            hint="["
            onClick={() => {
              reorderSelection(false)
              setMenu(null)
            }}
          />
          {(canGroup || canUngroup) && (
            <>
              <div className="my-1 border-t border-line-soft" />
              {canGroup && (
                <ContextItem
                  icon={<Group size={13} strokeWidth={2} />}
                  label={t('canvasEl.menu.group')}
                  hint="⌘G"
                  onClick={() => {
                    groupSelection()
                    setMenu(null)
                  }}
                />
              )}
              {canUngroup && (
                <ContextItem
                  icon={<Ungroup size={13} strokeWidth={2} />}
                  label={t('canvasEl.menu.ungroup')}
                  hint="⌘⇧G"
                  onClick={() => {
                    ungroupSelection()
                    setMenu(null)
                  }}
                />
              )}
            </>
          )}
          <div className="my-1 border-t border-line-soft" />
          <ContextItem
            icon={<Trash2 size={13} strokeWidth={2} />}
            label={t('common.delete')}
            hint="⌫"
            danger
            onClick={() => {
              deleteSelection()
              setMenu(null)
            }}
          />
        </div>
      )}
    </div>
  )
}

// One row in the canvas right-click menu.
const ContextItem = ({
  icon,
  label,
  hint,
  danger,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  danger?: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    onClick={onClick}
    className={[
      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors',
      danger
        ? 'text-accent hover:bg-accent hover:text-bg-card'
        : 'text-ink hover:bg-bg-inset',
    ].join(' ')}
  >
    <span className="shrink-0 text-ink-faint">{icon}</span>
    <span className="flex-1">{label}</span>
    {hint && <span className="font-mono text-[10px] text-ink-faint">{hint}</span>}
  </button>
)
