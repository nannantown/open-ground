import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BringToFront, Copy, Group, SendToBack, Trash2, Ungroup } from 'lucide-react'
import { ProjectCard } from './ProjectCard'
import { ElementView } from './ElementView'
import { FrameView } from './FrameView'
import { DesignFrameView } from './DesignFrameView'
import {
  applyAutoLayout,
  applyAutoLayoutDuringResize,
  addAutoLayout,
  removeAutoLayout,
  layoutInsertionIndex,
  layoutFrameAt,
  layoutDropSlot,
  layoutDropPreview,
  insertIntoLayoutAtPoint,
  type LayoutDropPreview,
} from '@/lib/canvasAutoLayout'
import {
  textBox,
  textMeasurePatch,
  textSizingOf,
  convertSizing,
  resizeOutcome,
  type TextSizing,
} from '@/lib/canvasTextSizing'
import { resolveTextStyle } from '@/lib/canvasTextStyle'
import { siblingId, firstChildId, parentId as navParentId } from '@/lib/canvasSelectionNav'
import { cloneSubset } from '@/lib/canvasClone'
import { initialDrawnFrameFill } from '@/lib/canvasFillStyle'
import type {
  CanvasElement,
  CanvasState,
  ClaudeBeaconStatus,
  CollabProjectListItem,
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
  isNestedFrame,
  frameIdContaining,
  type Container,
  type Rect,
} from '@/lib/canvasContainment'
import {
  groupElements,
  ungroupElements,
  dissolveFrames,
  expandSelectionForElement,
  topGroupId,
  groupLeafIds,
  groupCascadeSets,
  withGroupAncestors,
} from '@/lib/canvasGroup'
import {
  normalizeRotation,
  handlePoints,
  hitHandle,
  hitRotateZone,
  pointInRotatedBox,
  resizeFromHandle,
  resizeAnchor,
  cursorForHandle,
  CORNER_HANDLES,
  RESIZE_HANDLES,
  type ResizeHandle,
} from '@/lib/canvasTransform'
import { rotateCursor } from '@/lib/canvasCursors'
import { computeSnap, type SnapBox, type SnapGuide } from '@/lib/canvasSnap'
import { resizeGroup, unionBounds, type GResizeItem } from '@/lib/canvasGroupResize'
import { SHAPE_DEFAULT_W, SHAPE_DEFAULT_H, drawRectFromDrag } from '@/lib/canvasShape'
import { useT } from '@/i18n/I18nContext'

/** Imperative zoom handle the shell's zoom pill drives — same code paths as
 *  the ⌘± / ⇧0 / ⇧1 keyboard zooms. */
export interface CanvasZoomApi {
  zoomIn: () => void
  zoomOut: () => void
  zoomTo: (zoom: number) => void
  fitAll: () => void
}

interface Props {
  projects: ProjectMeta[]
  /** Ground-only: per-project claude beacon ('working'/'waiting'). A project
   *  with no entry shows no beacon (plain shells don't count). The per-project
   *  Canvas tab renders no project cards, so it leaves this undefined. */
  claudeStatuses?: ReadonlyMap<string, ClaudeBeaconStatus>
  /** Ground member flow (collab enabled only): projects shared WITH the user
   *  (owned:false), rendered as read-only "Shared" cards intermixed with the
   *  owned cards. Positioned by collabProjectId in `canvas.positions` (same map
   *  as owned cards), draggable, but click-to-OPEN (onOpenShared) rather than
   *  selectable. Undefined/empty (the default, collab-off build) → no shared
   *  cards and every owned-card path stays byte-for-byte unchanged. */
  sharedProjects?: CollabProjectListItem[]
  /** Open a shared card (folder-less) — wired to the host's member-mode
   *  ProjectPanel flow. Called on a click (no-drag) release of a shared card. */
  onOpenShared?: (collabProjectId: string) => void
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
  /** Project-Canvas-only: host undo-history hooks for Esc-cancel. A gesture
   *  snapshot records historyDepth() at press; cancelling restores the
   *  elements AND calls onCancelRestore(depth) so the host can roll its undo
   *  stack back — without these a pause mid-drag leaves the cancelled state
   *  reachable via ⌘Z. The Ground canvas leaves them undefined. */
  historyDepth?: () => number
  onCancelRestore?: (depth: number) => void
  /** Monotonic counter the host bumps whenever it adopts an EXTERNAL elements
   *  replacement (git-shared auto-sync, observer re-fetch). Gesture snapshots
   *  record it; Esc-cancel refuses to restore across an epoch change. */
  adoptionEpoch?: () => number
  /** DERIVED element writes (measured text footprints) — persisted without
   *  minting their own undo step. Falls back to onCanvasChange when absent. */
  onImplicitElementsChange?: (elements: CanvasElement[]) => void
  /** Hover sync with the Layers panel: `highlightedId` paints a light accent
   *  outline on that element (skipped while it's selected); `onHoverElement`
   *  reports the element under the idle pointer (null on leave / gesture
   *  start). Both optional — the Ground canvas leaves them undefined. */
  highlightedId?: string | null
  onHoverElement?: (id: string | null) => void
  /** The shell's zoom pill registers through this imperative handle — the
   *  same code paths as the ⌘± / ⇧0 / ⇧1 keyboard zooms. */
  zoomApiRef?: React.MutableRefObject<CanvasZoomApi | null>
  /** Project-Canvas-only: when set, image elements resolve their per-canvas
   *  assets through these values. The top-level Ground canvas leaves them
   *  undefined; the image case in ElementView falls back to a placeholder. */
  projectPath?: string
  canvasId?: string
  /** Project-Canvas-only: handle a paste/drop of an image File at world
   *  coordinates. CanvasWorkspace wires this to the /api/canvas/asset
   *  upload path and inserts a fresh ImageElement on success. */
  onImagePaste?: (file: File, worldX: number, worldY: number) => void
  /** How frames render. 'ground' (default) is the grouping box with an
   *  in-body header bar — the Ground's project-clustering frame. 'design'
   *  is the Figma-style design frame (project Canvas): the rect is pure
   *  content and the name floats outside, above the top-left corner. */
  frameVariant?: 'ground' | 'design'
  /** True while this canvas sits INERT beneath another surface (the Ground
   *  under an open project panel). Every window-level keyboard handler in
   *  here goes quiet — otherwise a V/F/Delete typed into the panel's canvas
   *  would ALSO drive the invisible Ground beneath it. */
  suspendKeys?: boolean
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
// Text resizes to a far smaller floor than the box types above (a one-word
// label is happily narrow): width never below TEXT_MIN_DRAG, height never below
// a single line (computed per element from its font metrics, see textResizeMin).
const TEXT_MIN_DRAG = 24
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

// The rotate annulus may claim only the bare canvas (no element owns it).
const EMPTY_IDS: ReadonlySet<string> = new Set()

// Which resize handles a TEXT element shows, per sizing mode (Figma parity):
//   auto-width  → side L/R only (the iconic two-handle auto-width text);
//   auto-height → side L/R + the 4 corners (re-width, or grab a corner → fixed);
//   fixed       → all 8 (corners + edges), a plain resizable box.
// The renderer draws a square at each of these, and the press/cursor hit-tests
// filter `hitHandle`'s result to this set so a hidden handle never grabs.
// Exported so the creation/resize wiring can be unit-tested without the React
// component (the heavy mode math itself lives in canvasTextSizing).
export const TEXT_HANDLES: Record<TextSizing, ReadonlySet<ResizeHandle>> = {
  'auto-width': new Set<ResizeHandle>(['l', 'r']),
  'auto-height': new Set<ResizeHandle>(['l', 'r', 'tl', 'tr', 'br', 'bl']),
  fixed: new Set<ResizeHandle>(['l', 'r', 't', 'b', 'tl', 'tr', 'br', 'bl']),
}

// A resize handle maps to the mode-transition class `resizeOutcome` consumes:
// a side L/R drag is horizontal (re-width), top/bottom is vertical, anything
// diagonal is a corner. Both vertical and corner promote a text to `fixed`.
export const handleKind = (h: ResizeHandle): 'horizontal' | 'vertical' | 'corner' =>
  h === 'l' || h === 'r'
    ? 'horizontal'
    : h === 't' || h === 'b'
      ? 'vertical'
      : 'corner'

// The smallest box a text resize may produce: width floors at TEXT_MIN_DRAG, and
// height at one rendered line (so a fixed box can't clip its own first line).
// Reads the element's resolved font metrics so the floor scales with font size.
export const textResizeMin = (el: CanvasElement): { w: number; h: number } => {
  const { fontSize, lineHeight } = resolveTextStyle(el)
  return { w: TEXT_MIN_DRAG, h: Math.max(TEXT_MIN_DRAG, Math.ceil(fontSize * lineHeight)) }
}

// Collapse a text one step toward auto on a resize-handle double-click (Figma):
// fixed → auto-height (keep the authoritative width, height re-measures);
// auto-height → auto-width (both axes re-measure). auto-width has nowhere left
// to go, so it returns null (no-op).
export const collapseSizingTarget = (mode: TextSizing): TextSizing | null =>
  mode === 'fixed' ? 'auto-height' : mode === 'auto-height' ? 'auto-width' : null

// The text-tool creation gesture's shaping decision: a box-drag ≥ TEXT_MIN_DRAG
// wide creates an auto-height text that wide (width authoritative, clamped to
// the floor and rounded); a smaller drag / plain click (`dragWidth === null`)
// creates an auto-width text that hugs its content (no explicit width, sizing
// left undefined = auto-width). The component applies this to the new element.
export const textCreateSpec = (
  dragWidth: number | null,
): { textSizing?: TextSizing; width?: number } =>
  dragWidth !== null && dragWidth >= TEXT_MIN_DRAG
    ? { textSizing: 'auto-height', width: Math.max(TEXT_MIN_DRAG, Math.round(dragWidth)) }
    : {}

// Snapshot taken when a cancellable gesture starts: Esc mid-drag restores
// exactly this (the canvas refs are immutable-update objects, so holding the
// references is free). Captured BEFORE any ⌥-drag clone commit, so Esc also
// removes the clones a cancelled duplicate-drag left behind.
interface PressRestore {
  positions: CanvasState['positions']
  elements: CanvasElement[]
  selection: string[]
  /** Host undo depth at press time — Esc-cancel rolls the history back to it
   *  so the cancelled mid-drag state can't surface as a ⌘Z step. */
  histDepth?: number
  /** Host adoption epoch at press time — when an external elements
   *  replacement was adopted mid-gesture (epoch moved), this snapshot is
   *  STALE and must not be restored over the adopted state. */
  epoch?: number
}

interface DragPress {
  id: string
  sx: number
  sy: number
  ox: number
  oy: number
  moved: boolean
  shift: boolean
  restore: PressRestore
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
  /** Ground member flow: this 'card' press is on a SHARED card (a project shared
   *  WITH the user, not in the registry). It drags via the same positions[id]
   *  path, but a click (no-move) release opens it through onOpenShared instead
   *  of selecting it — shared cards are read-only overlays, never selectable. */
  shared?: boolean
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
      restore: PressRestore
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
      what: 'frame' | 'rect' | 'ellipse' | 'text'
      sx: number
      sy: number
      offset: { x: number; y: number }
      lastP: { x: number; y: number }
      repos: { x: number; y: number } | null
    }
  // resize: box is the pre-drag rect, rot its rotation, handle which of the 8
  // grips was grabbed; gx/gy is the grab offset (pointer-world minus the handle
  // point at press) so the drag doesn't jump. Shift (aspect) / Alt (from
  // centre) read live off the event in the move handler.
  | {
      kind: 'resize'
      id: string
      box: { x: number; y: number; w: number; h: number }
      rot: number
      handle: ResizeHandle
      gx: number
      gy: number
      restore: PressRestore
    }
  // rotate: cx/cy are the element centre in world space; startAngle is the
  // pointer's angle from that centre at press time, startRot the element's
  // rotation then — so the drag applies a RELATIVE turn (no jump on grab).
  | {
      kind: 'rotate'
      id: string
      cx: number
      cy: number
      startAngle: number
      startRot: number
      restore: PressRestore
    }
  // groupresize: scale a whole multi-selection from the bbox side/corner
  // OPPOSITE the grabbed handle. box is the pre-drag union bbox; items are
  // each selected element's pre-drag box + sizable flag; gx/gy is the grab
  // offset from the grabbed handle's point.
  | {
      kind: 'groupresize'
      box: { x: number; y: number; w: number; h: number }
      items: import('@/lib/canvasGroupResize').GResizeItem[]
      handle: ResizeHandle
      gx: number
      gy: number
      restore: PressRestore
    }
  // marquee: sx/sy are viewport-relative screen coordinates
  | { kind: 'marquee'; sx: number; sy: number; shift: boolean }

// Stable per-leaf callback bundles handed to the memoised ProjectCard /
// ElementView / FrameView so a viewport-only render (pan/zoom) doesn't re-render
// every card/element. Built once per id and cached (see *CbCache below).
interface ElementLeafCb {
  onPointerDown: (e: React.PointerEvent) => void
  onChangeText: (t: string) => void
  onChangeColor: (c: string) => void
  onEditDone: () => void
  onMeasure: (w: number, h: number) => void
}
interface FrameLeafCb {
  onPointerDown: (e: React.PointerEvent) => void
  onChangeLabel: (t: string) => void
  onEditDone: () => void
  onTidy: () => void
}

// Free-form canvas: project cards, text/sticky annotations and grouping
// frames, all freely positioned. The active tool decides what a press does.
export const InfiniteCanvas = ({
  projects,
  claudeStatuses,
  sharedProjects,
  onOpenShared,
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
  historyDepth,
  onCancelRestore,
  adoptionEpoch,
  onImplicitElementsChange,
  highlightedId,
  onHoverElement,
  zoomApiRef,
  projectPath,
  canvasId,
  onImagePaste,
  frameVariant = 'ground',
  suspendKeys = false,
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
  // Live mirror of suspendKeys for the window-level key handlers — they gate
  // per keypress off the ref, so the listeners don't re-subscribe (and can't
  // race) when the panel above opens/closes.
  const suspendKeysRef = useRef(suspendKeys)
  suspendKeysRef.current = suspendKeys
  const canvasRef = useRef(canvas)
  canvasRef.current = canvas
  // Wheel events from a trackpad pinch fire faster than React can commit, so a
  // handler that only reads canvasRef would see the same stale viewport across
  // a burst of events and effectively produce one zoom step per frame. We
  // accumulate the in-flight viewport here and resync whenever the canvas
  // prop's viewport object identity changes (i.e. an external update).
  const wheelVpRef = useRef(canvas.viewport)
  // Pending rAF handle for the coalesced wheel commit (declared here so the
  // resync just below can tell "my own deferred commit is still in flight" from
  // a genuine EXTERNAL viewport change).
  const wheelRafRef = useRef<number | null>(null)
  // Adopt an EXTERNAL viewport change (zoom pill / fit / programmatic) into the
  // in-flight ref — but NOT while a wheel commit is still pending, or we'd
  // discard the wheel deltas that arrived after the last flush.
  if (wheelRafRef.current == null && wheelVpRef.current !== canvas.viewport)
    wheelVpRef.current = canvas.viewport
  const selectedRef = useRef(selectedIds)
  selectedRef.current = selectedIds
  // Live mirror of onCanvasChange so the rAF-coalesced wheel commit below always
  // calls the latest handler without re-subscribing.
  const onCanvasChangeRef = useRef(onCanvasChange)
  onCanvasChangeRef.current = onCanvasChange

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
  // Live auto-layout drop preview while a SINGLE element drags over a layout
  // frame: the accent insertion bar + the siblings' dodge translations.
  // Purely visual — element data stays untouched until the existing release
  // path commits. The ref mirrors the state so the pointer-move handler can
  // compare the current slot without a stale-closure read.
  const [dropPreview, setDropPreview] = useState<LayoutDropPreview | null>(null)
  const dropPreviewRef = useRef<LayoutDropPreview | null>(null)
  const setDropPreviewBoth = (p: LayoutDropPreview | null) => {
    dropPreviewRef.current = p
    setDropPreview(p)
  }
  // ⌥-hover measure (Figma): while Alt is held with a selection, hovering
  // ANOTHER element shows the gap between the selection's bbox (a) and the
  // hovered element's (b) as accent distance lines. Cleared on Alt-up, on
  // press, and when the hover leaves every measurable target.
  const [measure, setMeasure] = useState<{ a: Rect; b: Rect } | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  )
  // Live selection-chrome drag, for the badge overlays: 'resize' shows the
  // W × H pill under the box, 'rotate' the N° pill near the pointer (x/y are
  // the pointer's world position, refreshed per move).
  const [chromeDrag, setChromeDrag] = useState<
    { kind: 'resize' } | { kind: 'rotate'; x: number; y: number } | null
  >(null)
  // Cursor for the hovered selection chrome ('' = none) — folded into the
  // wrapper's style declaratively (an imperative style.cursor write would
  // fight React's own style prop, e.g. the Comment tool's bubble cursor).
  // setState bails on the unchanged string, so hover moves stay cheap.
  const [chromeCursor, setChromeCursor] = useState('')
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
  // Last press that landed on a TEXT element's resize handle — pairs a
  // double-click on the same handle, which collapses the text one step toward
  // auto (fixed → auto-height → auto-width) via convertSizing.
  const lastHandleClick = useRef<{ id: string; handle: ResizeHandle; t: number } | null>(null)
  // Last hover id reported to onHoverElement — report only on change.
  const lastHoverRef = useRef<string | null>(null)

  const { viewport, positions, elements } = canvas
  // A Set for O(1) `selected` lookups in the render maps + derivations below.
  // `selectedIds.includes(id)` is O(n) and was called once per element (O(n²)
  // under ⌘A — selectedIds holds all ids). Memoised so its identity is stable
  // across non-selection renders (pan/zoom/beacon), which is also what lets the
  // memoised leaves below skip re-rendering when only the viewport changed.
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  // Layers-panel visibility: a `hidden` element is dropped from EVERY render
  // pass (frames / notes / comments / anchor hints) and from hit-testing below,
  // so it neither paints nor catches clicks — but it stays in `elements`, so it
  // keeps its z-order and can be un-hidden from the panel. Omitted = visible.
  // A group is invisible, so hiding/locking a GROUP must cascade to its members.
  // Precompute the affected id sets ONCE (O(n)); the render passes below then do
  // O(1) lookups instead of an O(depth) ancestor walk per element.
  const { hiddenViaGroup, lockedViaGroup } = useMemo(() => groupCascadeSets(elements), [elements])
  const visible = useMemo(
    () => elements.filter((el) => !el.hidden && !hiddenViaGroup.has(el.id)),
    [elements, hiddenViaGroup],
  )
  // Frames paint shallowest-first so a CONTAINER frame sits behind the frames it
  // nests (Figma-style): a child frame (deeper) must render after — and so on
  // top of — its parent, otherwise the outer frame would cover the inner one's
  // header. Stable sort preserves insertion order within a depth.
  const frameById = useMemo(
    () => new Map(visible.filter((el) => el.type === 'frame').map((el) => [el.id, el])),
    [visible],
  )
  const frames = useMemo(
    () =>
      visible
        .filter((el) => el.type === 'frame')
        .sort((a, b) => containmentDepth(frameById, a.id) - containmentDepth(frameById, b.id)),
    [visible, frameById],
  )
  // Figma parity (design variant only): NESTED frames hide their floating name
  // label — only top-level frames are titled, so an AI-generated design (one
  // nested frame per card) doesn't read as a wall of "Frame" tags. Two escape
  // hatches keep nested frames reachable from the canvas (the label is a
  // frame's only interactive surface): a SELECTED/EDITING nested frame shows
  // its label (DesignFrameView), and — like Figma — so does every nested frame
  // whose PARENT frame is currently selected, so selecting the outer frame
  // reveals the handles of the frames inside it. Containment is checked
  // against VISIBLE elements only (a hidden parent must not eat its visible
  // child's label). Frames are few, so recomputing per render is fine.
  const nestedFrameIds = useMemo(() => {
    if (frameVariant !== 'design') return new Set<string>()
    const sel = selectedSet
    // Defaults mirror isNestedFrame / DesignFrameView (400×280) so the
    // geometric parent resolved here is the same one that hid the label.
    const frameRects = frames.map((f) => ({
      id: f.id,
      rect: { x: f.x, y: f.y, w: f.width ?? 400, h: f.height ?? 280 },
    }))
    const out = new Set<string>()
    for (const f of frames) {
      if (!isNestedFrame(f, visible)) continue
      const parentId =
        (f.parentId && frameById.has(f.parentId) ? f.parentId : undefined) ??
        frameIdContaining(
          { x: f.x, y: f.y, w: f.width ?? 400, h: f.height ?? 280 },
          frameRects.filter((r) => r.id !== f.id),
        )
      if (parentId && sel.has(parentId)) continue
      out.add(f.id)
    }
    return out
  }, [frames, frameById, visible, selectedSet, frameVariant])
  // Render order: non-comment notes first, then comments. Comment popups
  // need to layer above sibling stickies / mocks so a pin dropped on a
  // mockup can still open its editor cleanly.
  // A `group` is an invisible container (membership only) — it never paints on
  // the canvas; it's managed entirely from the Layers panel + as a selection
  // unit. So it's dropped from every render pass and from hit-testing below.
  const notes = useMemo(
    () => visible.filter((el) => el.type !== 'frame' && el.type !== 'comment' && el.type !== 'group'),
    [visible],
  )
  const comments = useMemo(() => visible.filter((el) => el.type === 'comment'), [visible])

  // Anchor-visibility: while a comment is selected or being edited, outline the
  // element it points at so the user can see WHICH thing the feedback is about
  // — chiefly over a mock, where the pin can sit far from the part it critiques.
  // Unanchored comments contribute nothing (no stray outline); a dangling
  // anchorId resolves to no element below, so deleting the target also clears
  // the highlight for free (same surviving-set rule as clearDanglingAnchors).
  const anchoredHints = useMemo(
    () => comments.filter((c) => c.anchorId && (selectedSet.has(c.id) || editingId === c.id)),
    [comments, selectedSet, editingId],
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
  const isManipulable = useCallback(
    (el: CanvasElement) => !el.locked && !lockedViaGroup.has(el.id),
    [lockedViaGroup],
  )

  // The lone selected sticky/frame/mock/text gets resize handles. Text shows a
  // per-mode subset (see TEXT_HANDLES) — dragging promotes its sizing mode the
  // Figma way; comments are fixed-size pins by design (resizing a pin makes no
  // UX sense), so they stay excluded.
  const resizeTarget =
    tool === 'select' && selectedIds.length === 1 && !editingId
      ? elements.find(
          (el) =>
            el.id === selectedIds[0] &&
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

  // ── Keyboard zoom (Figma-style) ────────────────────────────────────────────
  // Set an absolute zoom, keeping the viewport-centre point fixed (the wheel
  // handler does the same math around the cursor instead).
  const setViewportZoom = (zoom: number) => {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return
    const c = canvasRef.current
    const v = c.viewport
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
    if (z === v.zoom) return
    const px = rect.width / 2
    const py = rect.height / 2
    const wx = (px - v.x) / v.zoom
    const wy = (py - v.y) / v.zoom
    onCanvasChange({ ...c, viewport: { zoom: z, x: px - wx * z, y: py - wy * z } })
  }

  // Fit a set of world boxes into the viewport (Shift+1 fit-all / Shift+2 fit-
  // selection), padded so the content doesn't kiss the edges; zoom clamps to
  // the canvas range so a single sticky can't blow up past ZOOM_MAX.
  const fitViewportTo = (boxes: { x: number; y: number; w: number; h: number }[]) => {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect || !boxes.length) return
    const x1 = Math.min(...boxes.map((b) => b.x))
    const y1 = Math.min(...boxes.map((b) => b.y))
    const x2 = Math.max(...boxes.map((b) => b.x + b.w))
    const y2 = Math.max(...boxes.map((b) => b.y + b.h))
    const w = Math.max(x2 - x1, 1)
    const h = Math.max(y2 - y1, 1)
    const PAD = 64
    const z = Math.min(
      ZOOM_MAX,
      Math.max(ZOOM_MIN, Math.min((rect.width - PAD * 2) / w, (rect.height - PAD * 2) / h)),
    )
    const c = canvasRef.current
    onCanvasChange({
      ...c,
      viewport: {
        zoom: z,
        x: rect.width / 2 - (x1 + w / 2) * z,
        y: rect.height / 2 - (y1 + h / 2) * z,
      },
    })
  }

  // Everything visible — cards (Ground) + non-group elements — framed with the
  // standard padding. Shared by the ⇧1 shortcut and the shell's zoom pill.
  const fitAllContent = () => {
    const c = canvasRef.current
    fitViewportTo([
      ...projects
        .map((proj) => c.positions[proj.id])
        .filter((pos): pos is { x: number; y: number } => !!pos)
        .map((pos) => ({ x: pos.x, y: pos.y, w: CARD_W, h: CARD_H })),
      ...c.elements
        .filter((el) => !el.hidden && el.type !== 'group')
        .map(fullBounds),
    ])
  }

  // Register the imperative zoom handle every render so closures stay fresh.
  if (zoomApiRef) {
    zoomApiRef.current = {
      zoomIn: () => setViewportZoom(canvasRef.current.viewport.zoom * 1.25),
      zoomOut: () => setViewportZoom(canvasRef.current.viewport.zoom / 1.25),
      zoomTo: (z: number) => setViewportZoom(z),
      fitAll: fitAllContent,
    }
  }

  // rAF-coalesced viewport commit. A trackpad / precision mouse emits wheel
  // events faster than the frame rate, and each one used to fire a full
  // onCanvasChange → re-render (re-reconciling every card/element). We now
  // accumulate the live viewport in wheelVpRef and commit at most ONCE per
  // animation frame, so a burst of N wheel events costs ~1 render per frame
  // instead of N. The committed viewport feeds contentStyle the same frame, so
  // the pan/zoom stays visually current. (Only pan/zoom defers here; pointer
  // drags still commit per move.)
  const flushWheelViewport = useCallback(() => {
    wheelRafRef.current = null
    onCanvasChangeRef.current({ ...canvasRef.current, viewport: wheelVpRef.current })
  }, [])
  const scheduleWheelViewport = useCallback(() => {
    if (wheelRafRef.current != null) return
    wheelRafRef.current = requestAnimationFrame(flushWheelViewport)
  }, [flushWheelViewport])
  useEffect(
    () => () => {
      if (wheelRafRef.current != null) cancelAnimationFrame(wheelRafRef.current)
    },
    [],
  )

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
      scheduleWheelViewport()
    },
    [scheduleWheelViewport],
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
      if (suspendKeysRef.current) return
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
      // Deleting a layout-frame child re-packs its siblings (no hole left).
      onCanvasChange({ ...c, elements: applyAutoLayout(next) })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editingId, selectedIds, onCanvasChange])

  // ⌘G groups the selection; ⌘⇧G ungroups. Gated on no active editor / field so
  // typing a "g" is never swallowed. groupSelection / ungroupSelection read live
  // refs, so re-subscribe only when the change sinks change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (suspendKeysRef.current) return
      if ((e.key !== 'g' && e.key !== 'G') || !(e.metaKey || e.ctrlKey)) return
      if (editingId) return
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      e.preventDefault()
      if (e.shiftKey) {
        // ⌘⇧G dissolves SELECTED FRAMES too (Figma — also how an auto-layout
        // wrapper is unwrapped). Frames win the press when both kinds are in
        // the selection: both paths commit through onCanvasChange, and the
        // second would read a canvasRef the first already made stale — so run
        // exactly one per press; press again for the other kind.
        const c = canvasRef.current
        const locked = lockedIds(c.elements)
        const res = dissolveFrames(
          c.elements,
          selectedRef.current.filter((id) => !locked.has(id)),
        )
        if (res) {
          // Children released into an outer layout frame re-pack right away.
          onCanvasChange({ ...c, elements: applyAutoLayout(res.elements) })
          onSelectIds(res.freedIds)
          return
        }
        ungroupSelection()
      } else groupSelection()
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
      if (suspendKeysRef.current) return
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

  // Figma-parity keyboard shortcuts, three families:
  //  - tools: V/T/S/F/O — plus R (Figma) or G (legacy tooltip) for rectangle,
  //    and C/I on the project Canvas (the keys the ToolPalette tooltips
  //    advertise). Plain letters only, so Shift/Alt combos stay free.
  //  - zoom: ⌘+ / ⌘- / ⌘0 (overriding the browser's page zoom), plus Figma's
  //    plain +/-, ⇧0 = 100%, ⇧1 = fit everything, ⇧2 = fit the selection.
  //    Digits read e.code (Digit0…) because Shift turns e.key into layout-
  //    specific symbols (')', '!', '"'…).
  //  - selection: ⌘A select all (marquee eligibility: no frames / groups /
  //    hidden / locked — unlike Figma, a frame here drags its children, so
  //    select-all including frames would double-move), Esc → back to the
  //    Select tool, then clear the selection; ⌘⇧L lock / ⌘⇧H hide toggles;
  //    ⇧A auto layout (enable on a plain frame / wrap anything else) and
  //    ⌥⇧A to strip it — design variant only.
  // All gated off while an editor / form field owns the keyboard and during
  // IME composition, so Japanese input can never flip a tool mid-conversion.
  // CAPTURE phase: the embedded canvas mounts AFTER App, so as a bubble
  // listener it would run after App's global handler — whose Escape clears
  // the Ground selection and thereby CLOSES the project panel before the
  // canvas could consume that Escape for its own tool/selection. Capture
  // runs first regardless of mount order; consumed keys preventDefault and
  // every later handler (App's, the workspace's) honours defaultPrevented.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (suspendKeysRef.current) return
      // Another surface already claimed this key (the Board drawer's capture
      // Esc, a modal…) — house rule, same as App's global handler.
      if (e.isComposing || e.defaultPrevented) return
      if (editingId || menu) return
      // Esc DURING a move/resize/rotate drag cancels it — checked BEFORE the
      // form-field gate (an in-flight pointer gesture means the user is
      // manifestly on the canvas, even if a sidebar input still holds focus)
      // and BEFORE the modifier dispatch (the cancel must also fire while ⇧
      // aspect / ⌥ centre is held mid-resize). Restores the canvas (and
      // selection) snapshotted at press time and ends the gesture: the
      // pointer keeps capture until release, but with the press cleared the
      // remaining moves/up are inert. The Esc tool/selection layering further
      // down applies only when no such drag is in flight.
      if (e.key === 'Escape') {
        const p = press.current
        if (
          p &&
          (p.kind === 'card' ||
            p.kind === 'element' ||
            p.kind === 'frame' ||
            p.kind === 'resize' ||
            p.kind === 'rotate' ||
            p.kind === 'groupresize')
        ) {
          e.preventDefault()
          // A press-time snapshot is only valid for the elements lineage it
          // was taken from. When an EXTERNAL replacement was adopted mid-drag
          // (git-shared auto-sync / observer re-fetch), restoring it would
          // silently revert — and then persist over — the adopted edits, so
          // the cancel degrades to just ending the gesture in place.
          const stale =
            p.restore.epoch !== undefined && adoptionEpoch?.() !== p.restore.epoch
          if (!stale) {
            const c = canvasRef.current
            onCanvasChange({ ...c, positions: p.restore.positions, elements: p.restore.elements })
            onSelectIds(p.restore.selection)
            // Roll the host's undo history back to its press-time depth — a
            // pause mid-drag may have flushed the pre-drag snapshot as a step,
            // and the restore above must not become a redoable change either.
            if (p.restore.histDepth !== undefined) onCancelRestore?.(p.restore.histDepth)
          }
          press.current = null
          activePointerId.current = null
          lastClick.current = null
          setChromeDrag(null)
          setGuides([])
          setDropPreviewBoth(null)
          setPanning(false)
          return
        }
      }
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()

      if (mod) {
        if (e.altKey) return
        if (key === 'a' && !e.shiftKey) {
          e.preventDefault()
          const c = canvasRef.current
          const { hiddenViaGroup, lockedViaGroup } = groupCascadeSets(c.elements)
          const ids: string[] = []
          for (const proj of projects) if (c.positions[proj.id]) ids.push(proj.id)
          for (const el of c.elements) {
            if (el.type === 'frame' || el.type === 'group') continue
            if (el.hidden || hiddenViaGroup.has(el.id)) continue
            if (el.locked || lockedViaGroup.has(el.id)) continue
            ids.push(el.id)
          }
          if (ids.length) onSelectIds(ids)
          return
        }
        if (e.shiftKey && (key === 'l' || key === 'h')) {
          const sel = new Set(selectedRef.current)
          if (!sel.size) return
          e.preventDefault()
          const c = canvasRef.current
          const targets = c.elements.filter((el) => sel.has(el.id))
          if (!targets.length) return
          // Toggle as a set, Figma-style: if ANY member is still unlocked /
          // visible, the press locks / hides them all; only a uniformly
          // locked / hidden selection unlocks / reveals. `undefined` (not
          // false) clears the flag so it drops from the persisted JSON.
          if (key === 'l') {
            const lock = targets.some((el) => !el.locked) || undefined
            onCanvasChange({
              ...c,
              elements: c.elements.map((el) =>
                sel.has(el.id) ? { ...el, locked: lock } : el,
              ),
            })
          } else {
            const hide = targets.some((el) => !el.hidden) || undefined
            onCanvasChange({
              ...c,
              elements: c.elements.map((el) =>
                sel.has(el.id) ? { ...el, hidden: hide } : el,
              ),
            })
          }
          return
        }
        if (e.shiftKey) return
        if (key === '=' || key === '+') {
          e.preventDefault()
          setViewportZoom(canvasRef.current.viewport.zoom * 1.25)
        } else if (key === '-') {
          e.preventDefault()
          setViewportZoom(canvasRef.current.viewport.zoom / 1.25)
        } else if (e.code === 'Digit0') {
          e.preventDefault()
          setViewportZoom(1)
        }
        return
      }

      // Enter / ⇧Enter / Tab / ⇧Tab — selection navigation (Figma): drill into
      // the first child / step out to the parent / cycle siblings. Enter on a
      // childless element falls back to editing its text (Figma's Enter-on-a-
      // leaf). Single-selection only — navigation has no meaning for a multi.
      // (Sits BEFORE the Shift handling below so ⇧Tab / ⇧Enter reach it.)
      if (e.key === 'Enter' || e.key === 'Tab') {
        const cur = selectedRef.current
        if (cur.length !== 1) return
        const els = canvasRef.current.elements
        if (!els.some((el) => el.id === cur[0])) return // a card, not an element
        e.preventDefault()
        if (e.key === 'Tab') {
          const next = siblingId(els, cur[0], e.shiftKey ? -1 : 1)
          if (next) onSelect(next)
          return
        }
        if (e.shiftKey) {
          const parent = navParentId(els, cur[0])
          if (parent) onSelect(parent)
          return
        }
        const child = firstChildId(els, cur[0])
        if (child) {
          onSelect(child)
          return
        }
        const el = els.find((x) => x.id === cur[0])!
        // Leaf: Enter opens the text editor for the types that carry text.
        if ((el.type === 'text' || el.type === 'sticky' || el.type === 'frame') && !el.locked)
          setEditingId(el.id)
        return
      }

      if (e.shiftKey && !e.altKey) {
        if (e.code === 'KeyA' && frameVariant === 'design') {
          // ⇧A — Figma's auto layout: a single plain frame gains layout in
          // place; any other selection wraps in a fresh auto-layout frame.
          // addAutoLayout decides which; applyAutoLayout does the stacking.
          const c = canvasRef.current
          const locked = lockedIds(c.elements)
          const ids = selectedRef.current.filter((id) => !locked.has(id))
          const res = ids.length ? addAutoLayout(c.elements, ids, newId) : null
          if (res) {
            e.preventDefault()
            onCanvasChange({ ...c, elements: applyAutoLayout(res.elements) })
            onSelect(res.selectId)
          }
          return
        }
        if (e.code === 'Digit0') {
          e.preventDefault()
          setViewportZoom(1)
        } else if (e.code === 'Digit1') {
          e.preventDefault()
          fitAllContent()
        } else if (e.code === 'Digit2') {
          e.preventDefault()
          const c = canvasRef.current
          const sel = new Set(selectedRef.current)
          fitViewportTo([
            ...projects
              .filter((proj) => sel.has(proj.id))
              .map((proj) => c.positions[proj.id])
              .filter((pos): pos is { x: number; y: number } => !!pos)
              .map((pos) => ({ x: pos.x, y: pos.y, w: CARD_W, h: CARD_H })),
            ...c.elements
              .filter((el) => sel.has(el.id) && el.type !== 'group')
              .map(fullBounds),
          ])
        }
        return
      }
      // ⌥⇧A strips auto layout from the selected frames (children keep their
      // laid-out spots). Matched on e.code — Option turns e.key into 'Å'.
      if (e.shiftKey && e.altKey && e.code === 'KeyA' && frameVariant === 'design') {
        const c = canvasRef.current
        const locked = lockedIds(c.elements)
        const ids = selectedRef.current.filter((id) => !locked.has(id))
        const res = ids.length ? removeAutoLayout(c.elements, ids) : null
        if (res) {
          e.preventDefault()
          onCanvasChange({ ...c, elements: res })
        }
        return
      }
      if (e.shiftKey || e.altKey) return

      if (key === '=' || key === '+') {
        e.preventDefault()
        setViewportZoom(canvasRef.current.viewport.zoom * 1.25)
        return
      }
      if (key === '-') {
        e.preventDefault()
        setViewportZoom(canvasRef.current.viewport.zoom / 1.25)
        return
      }
      if (e.key === 'Escape') {
        // Layered escape, Figma-style: 1st Esc leaves the active tool, 2nd
        // clears the selection — each consumed press preventDefaults so App's
        // global Esc (which clears the GROUND selection = closes the project
        // panel) only fires once there's nothing left to escape here. (A drag
        // cancel was already handled above, before the modifier dispatch.)
        if (tool !== 'select') {
          e.preventDefault()
          onToolChange('select')
        } else if (selectedRef.current.length) {
          e.preventDefault()
          onSelect(null)
        }
        return
      }

      // 1–9 / 0 set the selection's opacity to 10–90% / 100% (Figma). Cards in
      // a mixed selection are untouched (they have no opacity).
      if (/^[0-9]$/.test(key) && selectedRef.current.length) {
        const c = canvasRef.current
        const sel = new Set(selectedRef.current)
        const op = key === '0' ? 1 : Number(key) / 10
        let hit = false
        const nextEls = c.elements.map((el) => {
          if (!sel.has(el.id) || el.locked) return el
          hit = true
          // 100% drops the field entirely — resolveOpacity treats absent as 1
          // and the persisted JSON stays clean.
          return { ...el, opacity: op === 1 ? undefined : op }
        })
        if (hit) {
          e.preventDefault()
          onCanvasChange({ ...c, elements: nextEls })
        }
        return
      }

      const TOOL_KEYS: Record<string, Tool> = {
        v: 'select',
        t: 'text',
        s: 'sticky',
        f: 'frame',
        r: 'rect',
        g: 'rect',
        o: 'ellipse',
        c: 'comment',
        i: 'image',
      }
      const next = TOOL_KEYS[key]
      if (!next) return
      // Project-Canvas-only tools (mirrors ToolPalette's EMBEDDED_ONLY): the
      // Ground portal has no shapes / comments / images to draw.
      if (
        (next === 'rect' || next === 'ellipse' || next === 'comment') &&
        frameVariant !== 'design'
      )
        return
      if (next === 'image' && !onImagePaste) return
      e.preventDefault()
      onToolChange(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // setViewportZoom / fitViewportTo / fullBounds read live refs; re-subscribe
    // only when the gates or the stable callbacks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editingId,
    menu,
    tool,
    projects,
    frameVariant,
    onImagePaste,
    onToolChange,
    onSelect,
    onSelectIds,
    onCanvasChange,
  ])

  // Holding Space turns any drag into a pan (Figma-style), so an empty-canvas
  // drag stays free for marquee selection.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (suspendKeysRef.current) return
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
      // Releasing Alt also dismisses the ⌥-hover measure guides.
      if (e.type === 'keyup' && e.key === 'Alt') setMeasure(null)
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
      // applyAutoLayout: an empty text auto-deleted out of a layout frame
      // re-packs its siblings, same as an explicit delete.
      onCanvasChange({ ...c, elements: applyAutoLayout(clearDanglingAnchors(remaining)) })
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
      const { w, h } = textBox(el)
      return { x: el.x, y: el.y, w, h }
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

  // Insert a freshly-built note/text element, settle auto layout, then select +
  // edit it and drop back to the Select tool — the shared tail of createNote /
  // createText. `point` is where the flow-slot membership is resolved (the
  // click / box top-left). `edit` skips the editor for elements with no inline
  // text (none today — both callers edit).
  const placeNewElement = (el: CanvasElement, point: { x: number; y: number }) => {
    const c = canvasRef.current
    // A note created ON a layout frame joins its flow at the slot under the
    // point (insertIntoLayoutAtPoint parents + splices; comments are excluded
    // inside the helper). Elsewhere it's a plain append — with any container
    // parentId already resolved on `el` — and applyAutoLayout settles the stack.
    const ins = insertIntoLayoutAtPoint(c.elements, el, point)
    onCanvasChange({ ...c, elements: applyAutoLayout(ins.elements) })
    setEditingId(el.id)
    onSelect(el.id)
    onToolChange('select')
  }

  const createNote = (type: 'sticky' | 'comment', e: React.PointerEvent) => {
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
    } else {
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
    }
    placeNewElement(el, { x: w.x, y: w.y })
  }

  // Text-tool creation (gesture in onViewportPointerUp's draw branch):
  //   - `dragWidth === null` (a click) → an auto-width text at `point` that
  //     hugs its content as the user types (textSizing left undefined);
  //   - `dragWidth` set (a box-drag) → an auto-height text `dragWidth` wide at
  //     the box's top-left, which wraps and grows downward (Figma's drag-create).
  // Both anchor into a design/frame under the point and open the editor.
  const createText = (point: { x: number; y: number }, dragWidth: number | null) => {
    const id = newId()
    // textCreateSpec turns the drag width into the sizing fields: a wide-enough
    // drag → auto-height + authoritative width; a click / tiny drag → auto-width
    // (no width, sizing undefined). Position is decided by the caller (box
    // top-left for a drag, the click anchor otherwise).
    const el: CanvasElement = {
      id,
      type: 'text',
      x: point.x,
      y: point.y,
      text: '',
      ...textCreateSpec(dragWidth),
    }
    // A text dropped on top of a design (mock/screen) — or inside a frame —
    // anchors to it straight away, so "type text on top of a generated design"
    // works without first nudging the label. Probe with the box it will occupy:
    // the drag width when sized, else the legacy pre-measure default.
    const parentId = resolveContainerId(
      id,
      'text',
      { x: point.x, y: point.y, w: dragWidth ?? TEXT_W, h: TEXT_H },
      containerList(canvasRef.current.elements),
    )
    if (parentId) el.parentId = parentId
    placeNewElement(el, point)
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
    if (e.button !== 0) return // non-primary (right/middle) → context menu only, no gesture
    if (menu) setMenu(null)
    // A starting gesture ends the hover-sync highlight until the next idle move.
    if (lastHoverRef.current !== null) {
      lastHoverRef.current = null
      onHoverElement?.(null)
    }
    // Space+drag pans, regardless of tool or what is under the cursor.
    if (spaceDown.current) {
      startPan(e)
      return
    }
    // Sticky / comment drop on click. Text instead starts a click-drag gesture
    // (handled by the draw branch below): a plain click → auto-width text, a
    // box-drag → auto-height text the drag's width wide. Figma's text tool.
    if (tool === 'sticky' || tool === 'comment') {
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
    // Frame + shape + text tools share one click-drag-to-size gesture (the
    // frame tool is the precedent). `what` carries which the drag will create
    // on pointer-up; for text a too-small drag collapses to a click (auto-width).
    if (tool === 'frame' || tool === 'rect' || tool === 'ellipse' || tool === 'text') {
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
    // Select tool: a press that reached the bare viewport (no card / element /
    // control caught it) may still be ON a frame — the frame body is
    // pointer-events:none so children + cards on top win, but an empty interior
    // or the thin border line falls through to here. Geometrically hit-test
    // frames (same bounds test as the hover highlight) and select the top-most
    // one, routing through the frame press path so the click ALSO arms a
    // move-drag — exactly like grabbing the frame by its name label. Without
    // this a frame is selectable only by its label. Design variant only: the
    // Ground portfolio's frames are grouping boxes with their own header drag,
    // and a body-click there would steal marquee starts over a frame.
    if (tool === 'select' && frameVariant === 'design') {
      const wf = worldFromEvent(e)
      const fid = topFrameAt(wf.x, wf.y)
      if (fid) {
        const frame = canvasRef.current.elements.find((el) => el.id === fid)
        if (frame) {
          onFramePointerDown(frame)(e)
          return
        }
      }
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

  // Esc-cancel snapshot for a gesture about to start — call BEFORE any press
  // side-effect (notably the ⌥-drag clone commit) so cancel rolls all of it back.
  const snapshotForRestore = (): PressRestore => {
    const c = canvasRef.current
    return {
      positions: c.positions,
      elements: c.elements,
      selection: selectedRef.current,
      histDepth: historyDepth?.(),
      epoch: adoptionEpoch?.(),
    }
  }

  const onCardPointerDown = (project: ProjectMeta) => (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (e.button !== 0) return // non-primary (right/middle) → context menu only, no gesture
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
      restore: snapshotForRestore(),
      ...(group ? { group } : {}),
    }
    setPanning(true)
    capture(e)
  }

  // Shared card (Ground member flow) — drags through the very same card path
  // (live move commits positions[id]; the host persists it under collabProjectId),
  // but the press is flagged `shared` so a click (no-move) release opens it via
  // onOpenShared instead of selecting it. No group/restore-group: a shared card
  // is never in `projects` or `selectedIds`, so it can't join a multi-select,
  // frame, or marquee — it's a standalone read-only overlay.
  const onSharedCardPointerDown = (id: string) => (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (e.button !== 0) return // non-primary (right/middle) → context menu only, no gesture
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    setEditingId(null)
    const c = canvasRef.current
    const pos = c.positions[id]
    if (!pos) return
    press.current = {
      kind: 'card',
      id,
      sx: e.clientX,
      sy: e.clientY,
      ox: pos.x,
      oy: pos.y,
      moved: false,
      shift: e.shiftKey,
      restore: snapshotForRestore(),
      shared: true,
    }
    setPanning(true)
    capture(e)
  }

  // ⌥-drag duplicate: clone `ids` in place (z-top, like paste) and return the
  // id remap so the caller rebuilds its press/selection against the CLONES —
  // the originals stay put and the drag moves the copies (Figma).
  const cloneForAltDrag = (ids: string[]): Map<string, string> | null => {
    const c = canvasRef.current
    const res = cloneSubset(c.elements, new Set(ids), newId)
    if (!res) return null
    onCanvasChange({ ...c, elements: [...c.elements, ...res.clones] })
    return res.idMap
  }

  const onElementPointerDown = (el: CanvasElement) => (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (e.button !== 0) return // non-primary (right/middle) → context menu only, no gesture
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    if (editingId === el.id) return
    setEditingId(null)
    const restore = snapshotForRestore()
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
    // ⌥-drag duplicates the whole would-be-dragged set. A multi-drag that
    // includes a project card stays a plain move — cards aren't duplicable.
    let pressId = el.id
    let pressChildren = children
    let pressGroup = group
    if (e.altKey && !group?.some((it) => it.isCard)) {
      const ids = group
        ? group.map((it) => it.id)
        : [el.id, ...(children?.map((ch) => ch.id) ?? [])]
      const map = cloneForAltDrag(ids)
      if (map) {
        pressId = map.get(el.id)!
        pressChildren = children?.map((ch) => ({ ...ch, id: map.get(ch.id)! }))
        pressGroup = group?.map((it) => ({ ...it, id: map.get(it.id)! }))
        if (pressGroup) onSelectIds(pressGroup.map((it) => it.id))
        else onSelect(pressId)
      }
    }
    // Figma selects on pointer-DOWN: pressing an unselected element selects it
    // (whole group) right away, so the drag that may follow moves a SELECTED
    // element and arrow keys work immediately after. Shift keeps its
    // pointer-up toggle; pressing into an existing multi-selection leaves it
    // intact for the multi-drag. (⌥-drag clones above already re-selected.)
    if (!e.altKey && !e.shiftKey && !selectedRef.current.includes(el.id)) {
      const groupSel = expandSelectionForElement(canvasRef.current.elements, el.id)
      if (groupSel.length > 1) onSelectIds(groupSel)
      else onSelect(el.id, false)
    }
    press.current = {
      kind: 'element',
      id: pressId,
      sx: e.clientX,
      sy: e.clientY,
      ox: el.x,
      oy: el.y,
      moved: false,
      shift: e.shiftKey,
      restore,
      ...(pressChildren && pressChildren.length ? { children: pressChildren } : {}),
      ...(pressGroup ? { group: pressGroup } : {}),
    }
    setPanning(true)
    capture(e)
  }

  const onFramePointerDown = (frame: CanvasElement) => (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (e.button !== 0) return // non-primary (right/middle) → context menu only, no gesture
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    if (editingId === frame.id) return
    setEditingId(null)
    const c = canvasRef.current
    const restore = snapshotForRestore()
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
          restore,
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
    // ⌥-drag duplicates the frame + its whole subtree (clones dragged, the
    // original cluster stays). Skipped when geometric CARDS ride along —
    // cards aren't duplicable, and splitting the cluster would be worse.
    let pressId = frame.id
    let pressItems = items
    if (e.altKey && !items.some((it) => it.isCard)) {
      const map = cloneForAltDrag(items.map((it) => it.id))
      if (map) {
        pressId = map.get(frame.id)!
        pressItems = items.map((it) => ({ ...it, id: map.get(it.id)! }))
        onSelect(pressId)
      }
    }
    // Figma selects on pointer-DOWN (see onElementPointerDown) — same rule for
    // a frame grabbed by its label.
    if (!e.altKey && !e.shiftKey && !selectedRef.current.includes(frame.id)) {
      onSelect(frame.id, false)
    }
    press.current = {
      kind: 'frame',
      id: pressId,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      shift: e.shiftKey,
      items: pressItems,
      restore,
    }
    setPanning(true)
    capture(e)
  }

  // The chrome's invisible hit zones must not steal presses from interactive
  // surfaces: a card, ANOTHER element's body, or a control (the frame header's
  // 整理 button, an editor field). The SELECTED element's own surface may be
  // claimed only INSIDE its rect — the design frame's floating name label
  // hangs OUTSIDE the rect (it is that frame's only drag surface) and must
  // keep winning its press. The painted corner squares and the bare canvas
  // carry no element wrapper, so they always pass — and so does a press whose
  // target is an element WRAPPER itself: a frame's body is pointer-events-none
  // (only its header/label is interactive), so such a press is falling through
  // inert space and the chrome may have it.
  const chromeAllowsTarget = (
    e: React.PointerEvent,
    box: { x: number; y: number; w: number; h: number },
    rot: number,
    ownIds: ReadonlySet<string>,
    point: { x: number; y: number },
  ): boolean => {
    const t = e.target
    if (!(t instanceof Element)) return true
    if (t.closest('button, input, textarea, select')) return false
    if (t.closest('[data-card-id]')) return false
    const wrapper = t.closest('[data-element-id]')
    if (!wrapper || wrapper === t) return true
    const id = wrapper.getAttribute('data-element-id')
    if (!id || !ownIds.has(id)) return false
    return pointInRotatedBox(box, rot, point)
  }

  // Selection-chrome pointer-down, run in the CAPTURE phase on the viewport so
  // it wins over an element's own pointerdown wherever the chrome overlaps a
  // body (the 8 resize handles straddle the border). All hit-testing is the
  // pure geometry in canvasTransform — the rendered corner squares are visuals
  // only, the edge bands and rotate annuli render nothing at all. A hit stops
  // propagation, so the bubble handlers (element drag / marquee) never see the
  // press; a miss falls through untouched — a body press still moves the
  // element.
  const onChromePointerDown = (e: React.PointerEvent) => {
    if (press.current) return // a gesture is already active (ignore 2nd pointer)
    if (tool !== 'select' || spaceDown.current || editingId || menu) return
    if (e.button !== 0) return // right-click → context menu path
    const zoom = canvasRef.current.viewport.zoom
    const w = worldFromEvent(e)
    // Multi-selection bbox handles (axis-aligned, rotation 0) take the press
    // first; a multi-selection has no single-element chrome.
    if (groupBox) {
      const gb = { x: groupBox.x, y: groupBox.y, w: groupBox.w, h: groupBox.h }
      const handle = hitHandle(gb, 0, w, zoom)
      if (!handle) return
      const ownIds = new Set(groupResizeItems.map((it) => it.id))
      if (!chromeAllowsTarget(e, gb, 0, ownIds, w)) return
      const hp = handlePoints(gb, 0)[handle]
      press.current = {
        kind: 'groupresize',
        box: gb,
        items: groupResizeItems,
        handle,
        gx: w.x - hp.x,
        gy: w.y - hp.y,
        restore: snapshotForRestore(),
      }
      e.stopPropagation()
      setPanning(true)
      capture(e)
      return
    }
    const target = resizeTarget ?? rotateTarget
    if (!target) return
    const b = fullBounds(target)
    const rot = normalizeRotation(target.rotation ?? 0) // NaN-safe (guards bad JSON)
    if (resizeTarget) {
      let handle = hitHandle(b, rot, w, zoom)
      // Text shows only its mode's handle subset (TEXT_HANDLES) — a grab on any
      // other handle position is ignored so a hidden grip can't resize.
      if (handle && resizeTarget.type === 'text') {
        if (!TEXT_HANDLES[textSizingOf(resizeTarget)].has(handle)) handle = null
      }
      if (handle && chromeAllowsTarget(e, b, rot, new Set([resizeTarget.id]), w)) {
        // Double-click on a text resize handle collapses the sizing one step
        // toward auto (fixed → auto-height → auto-width), keeping the box put
        // via convertSizing — Figma's "double-click to hug". Consumes the press
        // (no resize starts).
        if (resizeTarget.type === 'text') {
          const now = Date.now()
          const lh = lastHandleClick.current
          if (lh && lh.id === resizeTarget.id && lh.handle === handle && now - lh.t < DOUBLE_CLICK_MS) {
            lastHandleClick.current = null
            const to = collapseSizingTarget(textSizingOf(resizeTarget))
            if (to) {
              e.stopPropagation()
              const c = canvasRef.current
              const patch = convertSizing(resizeTarget, to, textBox(resizeTarget))
              onCanvasChange({
                ...c,
                elements: c.elements.map((el) =>
                  el.id === resizeTarget.id ? { ...el, ...patch } : el,
                ),
              })
              return
            }
          }
          lastHandleClick.current = { id: resizeTarget.id, handle, t: now }
        }
        const hp = handlePoints(b, rot)[handle]
        press.current = {
          kind: 'resize',
          id: resizeTarget.id,
          box: b,
          rot,
          handle,
          gx: w.x - hp.x,
          gy: w.y - hp.y,
          restore: snapshotForRestore(),
        }
        e.stopPropagation()
        setChromeDrag({ kind: 'resize' })
        setPanning(true)
        capture(e)
        return
      }
    }
    if (rotateTarget) {
      // The rotate annulus lives fully outside the rect, so it may claim only
      // the bare canvas — anything interactive out there (another element, the
      // frame label) keeps its own press.
      const zone = hitRotateZone(b, rot, w, zoom)
      if (zone && chromeAllowsTarget(e, b, rot, EMPTY_IDS, w)) {
        const cx = b.x + b.w / 2
        const cy = b.y + b.h / 2
        press.current = {
          kind: 'rotate',
          id: rotateTarget.id,
          cx,
          cy,
          startAngle: Math.atan2(w.y - cy, w.x - cx),
          startRot: rot,
          restore: snapshotForRestore(),
        }
        e.stopPropagation()
        setChromeDrag({ kind: 'rotate', x: w.x, y: w.y })
        setPanning(true)
        capture(e)
      }
    }
  }

  // No-gesture hover: drive the cursor for the same chrome geometry — resize
  // handles get the rotation-aware double arrow, the outside-corner annulus the
  // curved rotate arrow — into chromeCursor ('' hands the cursor back to the
  // tool/pan classes everywhere else).
  const updateChromeCursor = (e: React.PointerEvent) => {
    let next = ''
    if (tool === 'select' && !spaceDown.current && !editingId && !menu) {
      const zoom = canvasRef.current.viewport.zoom
      const w = worldFromEvent(e)
      if (groupBox) {
        const gb = { x: groupBox.x, y: groupBox.y, w: groupBox.w, h: groupBox.h }
        const handle = hitHandle(gb, 0, w, zoom)
        if (
          handle &&
          chromeAllowsTarget(e, gb, 0, new Set(groupResizeItems.map((it) => it.id)), w)
        )
          next = cursorForHandle(handle, 0)
      } else {
        const target = resizeTarget ?? rotateTarget
        if (target) {
          const b = fullBounds(target)
          const rot = normalizeRotation(target.rotation ?? 0)
          let handle = resizeTarget ? hitHandle(b, rot, w, zoom) : null
          // Text only exposes its mode's handle subset — keep the cursor in
          // sync so a hidden grip position shows no resize arrow.
          if (handle && resizeTarget?.type === 'text') {
            if (!TEXT_HANDLES[textSizingOf(resizeTarget)].has(handle)) handle = null
          }
          if (handle && chromeAllowsTarget(e, b, rot, new Set([target.id]), w)) {
            next = cursorForHandle(handle, rot)
          } else if (rotateTarget) {
            const zone = hitRotateZone(b, rot, w, zoom)
            if (zone && chromeAllowsTarget(e, b, rot, EMPTY_IDS, w)) {
              // Heading = centre → corner direction; the rotated corner point
              // already folds the element rotation in.
              const pt = handlePoints(b, rot)[zone]
              const cx = b.x + b.w / 2
              const cy = b.y + b.h / 2
              next = rotateCursor((Math.atan2(pt.y - cy, pt.x - cx) * 180) / Math.PI)
            }
          }
        }
      }
    }
    setChromeCursor(next)
  }

  // Drop the chrome cursor the moment the chrome itself goes away (selection
  // change, tool switch, edit start) — the next mousemove would fix it, but a
  // stationary pointer must not keep a stale resize arrow.
  useEffect(() => {
    setChromeCursor('')
  }, [selectedIds, tool, editingId])

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
    if (!p) {
      // Selection-chrome hover cursor (resize arrows / rotate arrow) first —
      // it owns the viewport's inline cursor while over the chrome.
      updateChromeCursor(e)
      // Hover sync with the Layers panel — report only on change so an idle
      // sweep doesn't storm the parent with renders.
      if (onHoverElement && tool === 'select') {
        const w = worldFromEvent(e)
        const hit = topElementAt(w.x, w.y) ?? null
        if (hit !== lastHoverRef.current) {
          lastHoverRef.current = hit
          onHoverElement(hit)
        }
      }
      // ⌥-hover measure: no gesture running — with Alt + a selection, hovering
      // a non-selected element measures selection-bbox ↔ hovered-bbox.
      if (e.altKey && tool === 'select' && selectedRef.current.length) {
        const w = worldFromEvent(e)
        const hit = topElementAt(w.x, w.y)
        const selSet = new Set(selectedRef.current)
        if (hit && !selSet.has(hit)) {
          const c = canvasRef.current
          let x1 = Infinity
          let y1 = Infinity
          let x2 = -Infinity
          let y2 = -Infinity
          for (const el of c.elements) {
            if (!selSet.has(el.id) || el.type === 'group') continue
            const b = fullBounds(el)
            x1 = Math.min(x1, b.x)
            y1 = Math.min(y1, b.y)
            x2 = Math.max(x2, b.x + b.w)
            y2 = Math.max(y2, b.y + b.h)
          }
          const target = c.elements.find((el) => el.id === hit)
          setMeasure(
            x1 < Infinity && target
              ? { a: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, b: fullBounds(target) }
              : null,
          )
        } else setMeasure(null)
      } else if (measure) setMeasure(null)
      return
    }
    if (measure) setMeasure(null) // a gesture started — drop the hover guides
    const c = canvasRef.current
    if (p.kind === 'resize') {
      // Map the pointer (minus the grab offset) onto the box's local axes,
      // keeping the side/corner opposite the grabbed handle anchored — correct
      // for a rotated element on any of the 8 handles. Shift (aspect lock) and
      // Alt (scale about the centre) read live so they can toggle mid-drag.
      const pw = worldFromEvent(e)
      // Text resizes to a much smaller floor than the box types (a one-word
      // label is happily narrow); everything else uses the shared box floors.
      const resizing = c.elements.find((el) => el.id === p.id)
      const mins =
        resizing?.type === 'text'
          ? textResizeMin(resizing)
          : { w: RESIZE_MIN_W, h: RESIZE_MIN_H }
      const next = resizeFromHandle(p.box, p.rot, p.handle, pw, {
        minW: mins.w,
        minH: mins.h,
        aspect: e.shiftKey,
        fromCenter: e.altKey,
        grabOffset: { x: p.gx, y: p.gy },
      })
      const resized = c.elements.map((el) =>
        el.id === p.id
          ? { ...el, x: next.x, y: next.y, width: next.width, height: next.height }
          : el,
      )
      // Auto layout re-packs LIVE while the box moves (Figma: shrink an
      // align-center frame and its children follow every frame) — a reference
      // no-op for non-layout targets. Hug flags are virtually released for
      // the engine input only; the release path still owns the real flip.
      onCanvasChange({
        ...c,
        elements: applyAutoLayoutDuringResize(resized, p.id, p.box),
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
      // Keep the N° badge riding next to the pointer.
      setChromeDrag({ kind: 'rotate', x: w.x, y: w.y })
      return
    }
    if (p.kind === 'groupresize') {
      // Same pure resize math as the single element (rotation 0): the new bbox
      // gives the per-axis scale, resizeGroup spreads it across the items about
      // the anchor resizeFromHandle kept fixed (opposite side / centre with ⌥).
      const w = worldFromEvent(e)
      const res = resizeFromHandle(p.box, 0, p.handle, w, {
        minW: GROUP_RESIZE_MIN,
        minH: GROUP_RESIZE_MIN,
        aspect: e.shiftKey,
        fromCenter: e.altKey,
        grabOffset: { x: p.gx, y: p.gy },
      })
      const sx = res.width / p.box.w
      const sy = res.height / p.box.h
      const anchor = resizeAnchor(p.box, p.handle, e.altKey)
      const updates = new Map(resizeGroup(p.items, anchor, sx, sy).map((u) => [u.id, u]))
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
    let dx = (e.clientX - p.sx) / c.viewport.zoom
    let dy = (e.clientY - p.sy) / c.viewport.zoom
    // Shift constrains the move to the dominant axis (Figma's horizontal /
    // vertical lock). Read live so it can engage / release mid-drag; applies
    // to every move kind below (single, multi-group, card, frame).
    if (e.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0
      else dx = 0
    }
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
      // Live drop preview — insertion bar + dodging siblings while the
      // pointer rides over a layout frame; cleared the moment it leaves
      // (drag-out preview). Slot detection runs every move (cheap, pure);
      // the engine-pass preview rebuilds only when the slot actually moves.
      // Siblings keep their committed positions mid-drag, so the slot math
      // reads the same data the release path will.
      if (!moved || moved.type === 'comment' || moved.locked) {
        // The dragged element can vanish mid-drag (external adoption removed
        // it) — a frozen bar/dodge must not outlive it.
        if (dropPreviewRef.current) setDropPreviewBoth(null)
      } else {
        const wpt = worldFromEvent(e)
        const at = layoutDropSlot(c.elements, p.id, wpt)
        const prev = dropPreviewRef.current
        if (!at) {
          // ⇧ axis-lock can take the POINTER outside the frame while the
          // element stays put inside it — the release keeps membership then
          // (full-rect containment), so the preview must keep saying "still
          // in the flow" instead of pretending a drag-out.
          const frame = moved.parentId
            ? c.elements.find(
                (f) => f.id === moved.parentId && f.type === 'frame' && f.layout,
              )
            : undefined
          const fb = frame && elementBounds(frame)
          const mb = elementBounds(moved)
          if (frame && fb && mb && rectInside(fb, mb)) {
            const own = layoutDropSlot(c.elements, p.id, {
              x: mb.x + mb.w / 2,
              y: mb.y + mb.h / 2,
            })
            if (own && (!prev || prev.frameId !== own.frameId || prev.slot !== own.slot)) {
              setDropPreviewBoth(
                layoutDropPreview(c.elements, p.id, { x: mb.x + mb.w / 2, y: mb.y + mb.h / 2 }),
              )
            } else if (!own && prev) {
              setDropPreviewBoth(null)
            }
          } else if (prev) {
            setDropPreviewBoth(null)
          }
        } else if (!prev || prev.frameId !== at.frameId || prev.slot !== at.slot) {
          setDropPreviewBoth(layoutDropPreview(c.elements, p.id, wpt))
        }
      }
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
              // Single-element drags get Figma's pointer-based layout-frame
              // membership: over a layout frame → (re)join it at the slot
              // under the pointer, even if the rect overhangs the frame;
              // outside every layout frame → the geometric full-containment
              // rule decides as before (drag-out / plain-frame nesting).
              const draggedId = movedIds.size === 1 ? Array.from(movedIds)[0] : null
              const dragged = draggedId
                ? cur.elements.find((el) => el.id === draggedId)
                : null
              const wpt = worldFromEvent(e)
              const target =
                dragged && dragged.type !== 'comment' && !dragged.locked
                  ? layoutFrameAt(cur.elements, wpt, dragged.id, dragged.type)
                  : null
              let reparented: CanvasElement[]
              if (dragged && target) {
                reparented =
                  dragged.parentId === target.id
                    ? cur.elements
                    : cur.elements.map((el) =>
                        el.id === dragged.id ? { ...el, parentId: target.id } : el,
                      )
              } else {
                reparented = reparentMoved(cur.elements, movedIds)
              }
              // Keep design annotations painting on top of their design after a
              // (re)parent — a text just dropped on a mock/screen must sit above
              // the iframe, not behind it.
              const ordered = raiseDesignAnnotations(reparented)
              // Auto layout settles on RELEASE, never mid-drag (the live drag
              // commits free-form positions so a child moves smoothly). Flow
              // order is ARRAY order (engine v2), so a single dragged child is
              // spliced to the slot under the pointer — that is the
              // drag-to-reorder gesture; multi-drags keep their relative order.
              // No-op (same reference) when no layout frame is involved.
              const arranged = draggedId
                ? reorderLayoutChild(ordered, draggedId, wpt)
                : ordered
              const laid = applyAutoLayout(arranged)
              if (laid !== cur.elements) {
                onCanvasChange({ ...cur, elements: laid })
              }
            }
          }
        } else if (p.kind === 'card' && p.shared) {
          // Shared card click (no drag): open the folder-less member-mode ProjectPanel
          // via the host. A shared card never selects (it isn't a registry
          // project) and never pairs into a double-click-to-edit (cards carry no
          // inline text), so we stop here without touching the selection.
          lastClick.current = null
          onOpenShared?.(p.id)
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
        // Manually resizing a hug axis flips that axis to fixed (Figma) —
        // otherwise the engine snaps the frame straight back to its hug size.
        // Sizes round to whole px on commit (the live drag is fractional).
        const released = cur.elements.map((el) => {
          if (el.id !== p.id) return el
          let next = el
          if (!Number.isInteger(next.x) || !Number.isInteger(next.y))
            next = { ...next, x: Math.round(next.x), y: Math.round(next.y) }
          if (next.width !== undefined && !Number.isInteger(next.width))
            next = { ...next, width: Math.round(next.width) }
          if (next.height !== undefined && !Number.isInteger(next.height))
            next = { ...next, height: Math.round(next.height) }
          // Text: the drag promotes the sizing mode the Figma way — a side
          // (horizontal) drag makes the width authoritative (→ auto-height), a
          // vertical / corner drag fixes both axes (→ fixed). resizeOutcome owns
          // that mapping; apply it only when the box actually moved (a pure
          // click on a handle must not silently flip the mode). The next
          // ResizeObserver pass corrects whichever axes the new mode measures.
          if (next.type === 'text') {
            const w = next.width ?? p.box.w
            const h = next.height ?? p.box.h
            if (w !== p.box.w || h !== p.box.h) {
              const out = resizeOutcome(textSizingOf(next), handleKind(p.handle), w, h)
              next = {
                ...next,
                textSizing: out.textSizing,
                width: out.width,
                ...(out.height !== undefined ? { height: out.height } : {}),
              }
            }
            return next
          }
          if (next.type !== 'frame' || !next.layout) return next
          const row = next.layout.mode === 'row'
          const wChanged = (next.width ?? p.box.w) !== p.box.w
          const hChanged = (next.height ?? p.box.h) !== p.box.h
          const dropPrimary =
            next.layout.primarySizing === 'hug' && (row ? wChanged : hChanged)
          const dropCounter =
            next.layout.counterSizing === 'hug' && (row ? hChanged : wChanged)
          if (!dropPrimary && !dropCounter) return next
          const layout = { ...next.layout }
          if (dropPrimary) delete layout.primarySizing
          if (dropCounter) delete layout.counterSizing
          return { ...next, layout }
        })
        // A LAYOUT child never leaves its frame by being resized — the frame
        // re-flows around the new size instead (Figma; only a drag-out
        // reparents). Geometric reparenting still applies everywhere else.
        const resized = released.find((el) => el.id === p.id)
        const parentIsLayoutFrame =
          !!resized?.parentId &&
          released.some(
            (f) => f.id === resized.parentId && f.type === 'frame' && f.layout,
          )
        const reparented = parentIsLayoutFrame
          ? released
          : reparentMoved(released, new Set([p.id]))
        const ordered = raiseDesignAnnotations(reparented)
        // A resized child (or layout frame) re-flows its auto layout on release
        // — same settle point as a drag-drop above.
        const laid = applyAutoLayout(ordered)
        if (laid !== cur.elements) onCanvasChange({ ...cur, elements: laid })
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
            // Text reads its persisted measured/authoritative box (textBox);
            // every other type falls back to its per-type default size.
            const tb = el.type === 'text' ? textBox(el) : null
            const ew =
              el.type === 'sticky' || el.type === 'mock'
                ? el.width ?? (el.type === 'mock' ? MOCK_DEFAULT_W : STICKY_DEFAULT)
                : el.type === 'shape'
                  ? el.width ?? SHAPE_DEFAULT_W
                  : el.type === 'comment'
                    ? COMMENT_W
                    : tb?.w ?? TEXT_W
            const eh =
              el.type === 'sticky' || el.type === 'mock'
                ? el.height ?? (el.type === 'mock' ? MOCK_DEFAULT_H : STICKY_DEFAULT)
                : el.type === 'shape'
                  ? el.height ?? SHAPE_DEFAULT_H
                  : el.type === 'comment'
                    ? COMMENT_H
                    : tb?.h ?? TEXT_H
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
        if (p.what === 'text') {
          // Text: a real box-drag (≥ TEXT_MIN_DRAG wide) creates an auto-height
          // text the drag's width wide at the box's top-left; a tiny drag /
          // plain click collapses to an auto-width text at the anchor. createText
          // owns the selection + editor + tool reset (the trailing onSelect /
          // onToolChange below is skipped for text — its id is `id` above but the
          // real element id is minted inside createText).
          if (box.w >= TEXT_MIN_DRAG) createText({ x: box.x, y: box.y }, box.w)
          else createText({ x: anchorX, y: anchorY }, null)
        } else if (p.what === 'frame') {
          // A real drag sizes the frame; a plain click drops a default frame.
          const sized = box.w >= FRAME_MIN_W && box.h >= FRAME_MIN_H
          const fw = sized ? box.w : FRAME_DEFAULT_W
          const fh = sized ? box.h : FRAME_DEFAULT_H
          const x = sized ? box.x : anchorX
          const y = sized ? box.y : anchorY
          // A drawn frame's initial fill depends on the canvas variant (see
          // initialDrawnFrameFill): a DESIGN artboard ships an explicit white
          // fill so it reads against the paper canvas; a GROUND grouping box
          // leaves `fill` UNSET (helper returns undefined) so resolveFrameStyle
          // falls back to DEFAULT_FRAME_FILL — the paper wash lets the
          // background grid show through and the new frame matches legacy Ground
          // frames (card 587cc625). A wrap-in-auto-layout frame is separately
          // transparent — see addAutoLayout in canvasAutoLayout.ts.
          const drawnFill = initialDrawnFrameFill(frameVariant)
          const newFrame: CanvasElement = {
            id,
            type: 'frame',
            x,
            y,
            width: fw,
            height: fh,
            text: '',
            ...(drawnFill !== undefined ? { fill: drawnFill } : {}),
          }
          // Drawn ON a layout frame (and not wrapping it — the helper's
          // contains-guard) → the fresh frame nests into that flow at the
          // slot under the box centre, Figma-style. The enclosure adoption
          // below stays the free-form drawing rule.
          const ins = insertIntoLayoutAtPoint(c.elements, newFrame, {
            x: x + fw / 2,
            y: y + fh / 2,
          })
          if (ins.frameId) {
            onCanvasChange({ ...c, elements: applyAutoLayout(ins.elements) })
          } else {
            const withFrame = ins.elements
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
            // A frame drawn inside a layout frame (or adopting children into its
            // own fresh layout — none yet, but parents may re-pack) settles here.
            onCanvasChange({ ...c, elements: applyAutoLayout(adopted) })
          }
          // A fresh frame jumps straight into its label editor.
          setEditingId(id)
        } else {
          // Shape (rect / ellipse): a real drag sizes it; a tiny drag / plain
          // click drops a default box. Shapes have no editable label, so we
          // never enter the editor — just select the new shape. Drawn ON a
          // layout frame, the shape joins its flow at the slot under the box
          // centre (same rule as createNote / paste).
          const sized = box.w >= SHAPE_MIN_DRAG && box.h >= SHAPE_MIN_DRAG
          const sw = sized ? box.w : SHAPE_DEFAULT_W
          const sh = sized ? box.h : SHAPE_DEFAULT_H
          const x = sized ? box.x : anchorX
          const y = sized ? box.y : anchorY
          const ins = insertIntoLayoutAtPoint(
            c.elements,
            { id, type: 'shape', shapeKind: p.what, x, y, width: sw, height: sh, text: '' },
            { x: x + sw / 2, y: y + sh / 2 },
          )
          onCanvasChange({ ...c, elements: applyAutoLayout(ins.elements) })
        }
        // Frame / shape select the box they just created and drop back to
        // Select; text already did both inside createText (its `id` differs).
        if (p.what !== 'text') {
          onSelect(id)
          onToolChange('select')
        }
        setDraw(null)
      }
    }
    press.current = null
    activePointerId.current = null
    if (snapGuidesRef.current.length) setGuides([]) // clear alignment guides on release
    if (dropPreviewRef.current) setDropPreviewBoth(null) // bar + dodge end with the drag
    setChromeDrag(null) // drop the W × H / N° badge (no-op re-render when already null)
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
    // Flow order = array order (engine v2): a lone layout child nudged along
    // its frame's MAIN axis swaps with the adjacent sibling instead of moving
    // by pixels (Figma's arrow-key reorder — a positional nudge would just
    // snap back into its slot). Cross-axis / multi-select nudges stay
    // positional and settle through applyAutoLayout below.
    if (sel.size === 1) {
      const id = Array.from(sel)[0]
      const el = c.elements.find((e) => e.id === id)
      const frame = el?.parentId
        ? c.elements.find((e) => e.id === el.parentId)
        : undefined
      if (
        el &&
        !el.hidden &&
        el.type !== 'comment' &&
        frame?.type === 'frame' &&
        frame.layout
      ) {
        const row = frame.layout.mode === 'row'
        const main = row ? dx : dy
        if (main !== 0) {
          const visible = c.elements.filter(
            (e) => e.parentId === frame.id && !e.hidden && e.type !== 'comment',
          )
          const at = visible.findIndex((e) => e.id === id)
          const to = at + (main > 0 ? 1 : -1)
          if (to < 0 || to >= visible.length) return // already at the edge
          const a = c.elements.indexOf(visible[at])
          const b = c.elements.indexOf(visible[to])
          const swapped = [...c.elements]
          ;[swapped[a], swapped[b]] = [swapped[b], swapped[a]]
          onCanvasChange({ ...c, elements: applyAutoLayout(swapped) })
          return
        }
      }
    }
    // applyAutoLayout: a nudged layout-frame child snaps back into its stack
    // (an arrow-key nudge is a committed edit, not a live drag) — same
    // normalization as the pointer-up / delete paths.
    onCanvasChange({
      ...c,
      elements: applyAutoLayout(
        c.elements.map((el) =>
          sel.has(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el,
        ),
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
    // applyAutoLayout mirrors the keyboard Delete path: removing a layout-frame
    // child re-packs its siblings.
    if (next !== c.elements) onCanvasChange({ ...c, elements: applyAutoLayout(next) })
  }

  // Full bounding box for hit-testing any element type (anchorAt/elementBounds
  // intentionally cover only commentable types).
  const fullBounds = (el: CanvasElement) => {
    if (el.type === 'text') {
      const { w, h } = textBox(el)
      return { x: el.x, y: el.y, w, h }
    }
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

  // The geometric fall-back the Select tool uses to pick a frame the user
  // clicked inside (or on the border line of). A frame's body renders
  // pointer-events:none so children + cards layered on top win their own press;
  // a press that reaches the bare viewport therefore has nothing interactive on
  // top, and here we hit-test frame bounds. We walk the SAME depth-sorted,
  // visibility-filtered `frames` list the canvas paints (shallowest-first) but
  // DEEPEST-first, so a click resolves to the top-most PAINTED frame under the
  // cursor — deterministic and matching what the user sees, not raw array order.
  // `frames` already excludes hidden / group-hidden frames; we additionally skip
  // locked (and group-locked) frames so a body-click can't grab — or drag — a
  // frame the lock contract says is immovable (hover highlight may still show it,
  // but selection must not).
  const topFrameAt = (wx: number, wy: number): string | undefined => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]
      if (f.locked || lockedViaGroup.has(f.id)) continue
      const b = fullBounds(f)
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return f.id
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

  // Flow order = ARRAY order (engine v2): a single element dropped in / moved
  // within a layout frame is spliced to the slot under the POINTER — the
  // drag-to-reorder gesture. The slot comes from layoutInsertionIndex over the
  // frame's OTHER visible children; index n (past the last midpoint) appends at
  // the array end, which is equivalent for flow and keeps the element frontmost.
  const reorderLayoutChild = (
    els: CanvasElement[],
    id: string,
    point: { x: number; y: number },
  ): CanvasElement[] => {
    const el = els.find((e) => e.id === id)
    if (!el || !el.parentId || el.hidden || el.type === 'comment') return els
    const frame = els.find((e) => e.id === el.parentId)
    if (!frame || frame.type !== 'frame' || !frame.layout) return els
    const without = els.filter((e) => e.id !== id)
    const slot = layoutInsertionIndex(without, frame.id, point)
    const visible = without.filter(
      (e) => e.parentId === frame.id && !e.hidden && e.type !== 'comment',
    )
    const next = [...without]
    const anchor = slot < visible.length ? next.indexOf(visible[slot]) : -1
    if (anchor === -1) next.push(el)
    else next.splice(anchor, 0, el)
    // Same slot as before → identical array → keep the input reference so the
    // release path's no-op detection still works.
    return next.every((e, i) => e === els[i]) ? els : next
  }

  // Layout-frame membership is decided by the POINTER, like Figma: while the
  // pointer is over a layout frame the dragged element belongs to it (and
  // reorders by slot) even if its rect overhangs; it leaves only when the
  // pointer exits. Full-rect containment (resolveContainerId) stays the rule
  // for plain frames. The shared hit-test lives in canvasAutoLayout
  // (layoutFrameAt) so the release path, the live drop preview, and the
  // create/paste insertion all agree on the target frame.

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
  const selById = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements])
  const selSet = selectedSet
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
  const groupResizeItems: GResizeItem[] = useMemo(
    () =>
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
        : [],
    [tool, editingId, selectedIds, selById, isManipulable],
  )
  const groupBox = groupResizeItems.length >= 2 ? unionBounds(groupResizeItems) : null

  // Drop-preview dodge: compose the transient translation (siblings making
  // room for the dragged element) with the element's own rotation — translate
  // first, so the rotation still spins about the element's centre. Element
  // data is untouched; the translation lives only in this style.
  const wrapperTransform = (el: CanvasElement): string | undefined => {
    const s = dropPreview?.shifts.get(el.id)
    const parts: string[] = []
    if (s) parts.push(`translate(${s.dx}px, ${s.dy}px)`)
    if (el.rotation) parts.push(`rotate(${el.rotation}deg)`)
    return parts.length ? parts.join(' ') : undefined
  }

  // EVERY text persists its measured footprint (the ResizeObserver in
  // ElementView → onTextMeasured below), so the bounds consumers (textBox)
  // read the real glyph box instead of the 300×44 default — a selection hugs
  // the text, and a growing layout-frame text pushes its flow siblings.
  // `textMeasurePatch` writes only the axes the element's mode MEASURES
  // (auto-width: both; auto-height: height; fixed: none), so a measurement can
  // never clobber a user-set width/height.
  const onMeasureEligible = (el: CanvasElement): boolean =>
    el.type === 'text' && !el.hidden && !el.locked

  // Persist a text's measured box. textMeasurePatch quantises to 2px and writes
  // only on a real change (never a 0-size readout), so the observer can't
  // ping-pong with the engine. The browser delivers ALL ResizeObserver
  // callbacks of a rendering step back-to-back while canvasRef only refreshes
  // on render — so a burst (several texts measured on mount) is collected and
  // flushed as ONE onCanvasChange, or the later write would clobber the
  // earlier one. The host's coalescing history then absorbs it as one step.
  const pendingMeasuresRef = useRef<Map<string, { w: number; h: number }> | null>(null)
  const onTextMeasured = (id: string, w: number, h: number) => {
    let pending = pendingMeasuresRef.current
    if (!pending) {
      pending = new Map()
      pendingMeasuresRef.current = pending
      const batch = pending
      queueMicrotask(() => {
        pendingMeasuresRef.current = null
        const c = canvasRef.current
        // A resize drag in flight OWNS the box it's dragging: an auto-width
        // text whose side handle is being widened keeps reporting its content
        // width to the observer, which would otherwise fight the drag by
        // writing the width straight back. Skip the dragged id until release —
        // the mode flip on release then re-admits the measured axes.
        const p = press.current
        const draggingId = p && p.kind === 'resize' ? p.id : null
        let next = c.elements
        batch.forEach((m, tid) => {
          if (tid === draggingId) return
          const el = next.find((x) => x.id === tid)
          // Re-check at flush: the observation can race a delete / lock / type
          // change. textMeasurePatch returns only the mode's measured axes.
          if (!el || el.type !== 'text' || el.hidden || el.locked) return
          const patch = textMeasurePatch(el, m.w, m.h)
          if (!patch) return
          next = next.map((x) => (x.id === tid ? { ...x, ...patch } : x))
        })
        if (next !== c.elements) {
          const laid = applyAutoLayout(next)
          // Derived write — no undo step of its own (host folds it into the
          // baseline from a clean state).
          if (onImplicitElementsChange) onImplicitElementsChange(laid)
          else onCanvasChange({ ...c, elements: laid })
        }
      })
    }
    pending.set(id, { w, h })
  }

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

  // ⌥-hover measure lines: per axis, the gap between the two boxes' nearest
  // edges (only when they don't overlap on that axis). The line sits at the
  // midpoint of the boxes' shared span on the other axis when they overlap
  // there, else at the selection bbox's centre — close to where Figma draws.
  const measureLines = (() => {
    if (!measure) return []
    const { a, b } = measure
    const out: { x: number; y: number; w: number; h: number; label: number }[] = []
    const hx1 = a.x + a.w <= b.x ? a.x + a.w : b.x + b.w <= a.x ? b.x + b.w : null
    const hx2 = a.x + a.w <= b.x ? b.x : b.x + b.w <= a.x ? a.x : null
    if (hx1 !== null && hx2 !== null && hx2 - hx1 >= 1) {
      const oy1 = Math.max(a.y, b.y)
      const oy2 = Math.min(a.y + a.h, b.y + b.h)
      const y = oy2 > oy1 ? (oy1 + oy2) / 2 : a.y + a.h / 2
      out.push({ x: hx1, y, w: hx2 - hx1, h: 0, label: Math.round(hx2 - hx1) })
    }
    const vy1 = a.y + a.h <= b.y ? a.y + a.h : b.y + b.h <= a.y ? b.y + b.h : null
    const vy2 = a.y + a.h <= b.y ? b.y : b.y + b.h <= a.y ? a.y : null
    if (vy1 !== null && vy2 !== null && vy2 - vy1 >= 1) {
      const ox1 = Math.max(a.x, b.x)
      const ox2 = Math.min(a.x + a.w, b.x + b.w)
      const x = ox2 > ox1 ? (ox1 + ox2) / 2 : a.x + a.w / 2
      out.push({ x, y: vy1, w: 0, h: vy2 - vy1, label: Math.round(vy2 - vy1) })
    }
    return out
  })()

  // Cursor precedence on the wrapper: the Comment tool's bubble glyph, then a
  // hovered selection-chrome cursor, then the plain grid (the tool/pan cursor
  // classes apply). chromeCursor is only ever set in the select tool, so the
  // two style cursors never actually compete.
  const wrapperStyle = commentCursor
    ? { ...gridStyle, cursor: COMMENT_CURSOR }
    : chromeCursor
      ? { ...gridStyle, cursor: chromeCursor }
      : gridStyle

  // ── Stable per-leaf callbacks (memoisation backbone) ──────────────────────
  // Each leaf (300 elements / 50 cards / frames) used to receive FRESH callback
  // props every render, so React.memo could never skip it — a pan that changes
  // only the viewport still re-rendered all of them. We hand each leaf STABLE
  // callbacks (built once per id, cached) that route through refs to the LATEST
  // handler, so the memoised leaf skips when nothing about IT changed. Same
  // ref-mirror trick already used for canvasRef / selectedRef above.
  const onCardPointerDownRef = useRef(onCardPointerDown)
  onCardPointerDownRef.current = onCardPointerDown
  const onSharedCardPointerDownRef = useRef(onSharedCardPointerDown)
  onSharedCardPointerDownRef.current = onSharedCardPointerDown
  const onElementPointerDownRef = useRef(onElementPointerDown)
  onElementPointerDownRef.current = onElementPointerDown
  const onFramePointerDownRef = useRef(onFramePointerDown)
  onFramePointerDownRef.current = onFramePointerDown
  const changeTextRef = useRef(changeText)
  changeTextRef.current = changeText
  const changeColorRef = useRef(changeColor)
  changeColorRef.current = changeColor
  const onTextMeasuredRef = useRef(onTextMeasured)
  onTextMeasuredRef.current = onTextMeasured
  const tidyFrameRef = useRef(tidyFrame)
  tidyFrameRef.current = tidyFrame
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const setEditingIdRef = useRef(setEditingId)
  setEditingIdRef.current = setEditingId

  const cardCbCache = useRef(new Map<string, (e: React.PointerEvent) => void>())
  const cardPointerDown = (id: string): ((e: React.PointerEvent) => void) => {
    let cb = cardCbCache.current.get(id)
    if (!cb) {
      cb = (e) => {
        const proj = projectsRef.current.find((p) => p.id === id)
        if (proj) onCardPointerDownRef.current(proj)(e)
      }
      cardCbCache.current.set(id, cb)
    }
    return cb
  }
  const sharedCardCbCache = useRef(new Map<string, (e: React.PointerEvent) => void>())
  const sharedCardPointerDown = (id: string): ((e: React.PointerEvent) => void) => {
    let cb = sharedCardCbCache.current.get(id)
    if (!cb) {
      cb = (e) => onSharedCardPointerDownRef.current(id)(e)
      sharedCardCbCache.current.set(id, cb)
    }
    return cb
  }
  const elCbCache = useRef(new Map<string, ElementLeafCb>())
  const elCallbacks = (id: string): ElementLeafCb => {
    let cb = elCbCache.current.get(id)
    if (!cb) {
      cb = {
        onPointerDown: (e) => {
          const el = canvasRef.current.elements.find((x) => x.id === id)
          if (el) onElementPointerDownRef.current(el)(e)
        },
        onChangeText: (t) => changeTextRef.current(id, t),
        onChangeColor: (c) => changeColorRef.current(id, c),
        onEditDone: () => setEditingIdRef.current(null),
        onMeasure: (w, h) => onTextMeasuredRef.current(id, w, h),
      }
      elCbCache.current.set(id, cb)
    }
    return cb
  }
  const frameCbCache = useRef(new Map<string, FrameLeafCb>())
  const frameCallbacks = (id: string): FrameLeafCb => {
    let cb = frameCbCache.current.get(id)
    if (!cb) {
      cb = {
        onPointerDown: (e) => {
          const fr = canvasRef.current.elements.find((x) => x.id === id)
          if (fr) onFramePointerDownRef.current(fr)(e)
        },
        onChangeLabel: (t) => changeTextRef.current(id, t),
        onEditDone: () => setEditingIdRef.current(null),
        onTidy: () => {
          const fr = canvasRef.current.elements.find((x) => x.id === id)
          if (fr) tidyFrameRef.current(fr)
        },
      }
      frameCbCache.current.set(id, cb)
    }
    return cb
  }

  // ── Viewport culling (virtualisation) ─────────────────────────────────────
  // At scale (> CULL_THRESHOLD elements) render only elements whose world-bounds
  // intersect the viewport plus a half-screen overscan, so a 300-element canvas
  // reconciles ~the on-screen subset each render instead of all 300 — the
  // dominant pan/zoom cost is re-diffing every wrapper div per frame. Selected /
  // editing elements ALWAYS render: their DOM is addressed by id for the
  // selection chrome + scroll-into-view and must survive a pan that pushes them
  // off-screen. Hit-testing / marquee / measurement all read element DATA
  // (canvasRef + fullBounds), never the rendered DOM, so culling the render is
  // safe. Small canvases (≤ threshold) and the very first paint (no measured
  // container yet) render in full — byte-identical to the pre-culling behaviour.
  const CULL_THRESHOLD = 80
  const cullRect: { x0: number; y0: number; x1: number; y1: number } | null = (() => {
    const node = viewportRef.current
    if (!node || elements.length <= CULL_THRESHOLD) return null
    const cw = node.clientWidth
    const ch = node.clientHeight
    if (!cw || !ch) return null
    const mx = cw * 0.5
    const my = ch * 0.5
    return {
      x0: (-viewport.x - mx) / viewport.zoom,
      y0: (-viewport.y - my) / viewport.zoom,
      x1: (cw - viewport.x + mx) / viewport.zoom,
      y1: (ch - viewport.y + my) / viewport.zoom,
    }
  })()
  const inView = (el: CanvasElement): boolean => {
    if (!cullRect) return true
    if (selectedSet.has(el.id) || editingId === el.id) return true
    const b = fullBounds(el)
    return (
      b.x <= cullRect.x1 &&
      b.x + b.w >= cullRect.x0 &&
      b.y <= cullRect.y1 &&
      b.y + b.h >= cullRect.y0
    )
  }

  return (
    <div
      ref={viewportRef}
      onPointerDownCapture={onChromePointerDown}
      onPointerDown={onViewportPointerDown}
      onPointerMove={onViewportPointerMove}
      onPointerUp={onViewportPointerUp}
      onPointerCancel={onViewportPointerUp}
      // Defensive: if the OS yanks pointer capture without a pointercancel
      // (rare), still run the up-path so a press can't get stuck.
      onLostPointerCapture={onViewportPointerUp}
      onPointerLeave={() => {
        if (lastHoverRef.current !== null) {
          lastHoverRef.current = null
          onHoverElement?.(null)
        }
      }}
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
        // Same trick while a selection-chrome cursor (resize / rotate zone) is
        // showing: the inner half of an edge band and the rotate annulus often
        // sit over an element whose own cursor-grab class would win otherwise.
        !commentCursor && chromeCursor ? 'canvas-chrome-cursor' : '',
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
        {frames.filter(inView).map((frame) => {
          const fcb = frameCallbacks(frame.id)
          return (
          <div
            key={frame.id}
            data-element-id={frame.id}
            className="absolute"
            style={{
              left: frame.x,
              top: frame.y,
              transform: wrapperTransform(frame),
              transformOrigin: 'center',
              mixBlendMode:
                frame.blendMode && frame.blendMode !== 'normal' ? frame.blendMode : undefined,
              ...(frame.locked || lockedViaGroup.has(frame.id)
                ? { pointerEvents: 'none' as const }
                : {}),
            }}
          >
            {frameVariant === 'design' ? (
              <DesignFrameView
                frame={frame}
                selected={selectedSet.has(frame.id)}
                editing={editingId === frame.id}
                zoom={viewport.zoom}
                labelHidden={nestedFrameIds.has(frame.id)}
                onLabelPointerDown={fcb.onPointerDown}
                onChangeLabel={fcb.onChangeLabel}
                onEditDone={fcb.onEditDone}
              />
            ) : (
              <FrameView
                frame={frame}
                selected={selectedSet.has(frame.id)}
                editing={editingId === frame.id}
                onHeaderPointerDown={fcb.onPointerDown}
                onChangeLabel={fcb.onChangeLabel}
                onEditDone={fcb.onEditDone}
                onTidy={
                  cardsInFrame(frame, { directOnly: true }).length > 0
                    ? fcb.onTidy
                    : undefined
                }
              />
            )}
          </div>
          )
        })}

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
                onPointerDown={cardPointerDown(p.id)}
                selected={selectedSet.has(p.id)}
                claudeStatus={claudeStatuses?.get(p.id)}
              />
            </div>
          )
        })}

        {/* Ground member flow: projects shared WITH the user (collab enabled
            only). Positioned by collabProjectId in the SAME positions map as
            owned cards, draggable via onSharedCardPointerDown, click-to-open.
            The synthetic ProjectMeta carries id + name (the label) + a shared
            caption in the description slot; `shared` gives the card the invite
            accent (left band + tinted ring + Users icon + "Shared" badge) so it
            reads at a glance as shared, distinct from the user's own cards.
            hasGit:false + openTaskCount:0 hide the git/task stamps.
            Empty/undefined → nothing renders, so the collab-off Ground stays
            byte-for-byte unchanged. */}
        {(sharedProjects ?? []).map((s) => {
          const pos = positions[s.id]
          if (!pos) return null
          return (
            <div
              key={s.id}
              data-card-id={s.id}
              className="absolute"
              style={{ left: pos.x, top: pos.y }}
            >
              <ProjectCard
                project={{
                  id: s.id,
                  name: s.label || t('projectPanel.collabSharedDialogUntitled'),
                  path: '',
                  // Folder-less: no real git/tasks. The shared caption rides in
                  // the description slot; `shared` below paints the invite accent
                  // so the card reads at a glance as shared (vs. owned cards).
                  description: t('projectPanel.groundSharedTitle'),
                  lastModified: '',
                  hasGit: false,
                  openTaskCount: 0,
                  totalTaskCount: 0,
                }}
                onPointerDown={sharedCardPointerDown(s.id)}
                selected={false}
                shared
              />
            </div>
          )
        })}

        {notes.filter(inView).map((el) => {
          const ecb = elCallbacks(el.id)
          return (
          <div
            key={el.id}
            data-element-id={el.id}
            className="absolute"
            style={{
              left: el.x,
              top: el.y,
              // Figma-parity transforms applied at the positioning wrapper so
              // they cover every element type uniformly: rotate() about centre,
              // mix-blend-mode, and pointer-events:none for a locked element
              // (clicks fall through; unlock from the Layers panel). The
              // drop-preview dodge translation composes in front of the rotate.
              transform: wrapperTransform(el),
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
              selected={selectedSet.has(el.id)}
              editing={editingId === el.id}
              onPointerDown={ecb.onPointerDown}
              onChangeText={ecb.onChangeText}
              onChangeColor={ecb.onChangeColor}
              onEditDone={ecb.onEditDone}
              projectPath={projectPath}
              canvasId={canvasId}
              commentTool={commentCursor}
              onMeasure={onMeasureEligible(el) ? ecb.onMeasure : undefined}
            />
          </div>
          )
        })}

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
            data-element-id={el.id}
            className="absolute"
            style={{
              left: el.x,
              top: el.y,
              // A pin riding a dodging subtree (its parent making room for a
              // drop) translates with it — comments never take a slot
              // themselves, but they travel with their frame.
              transform: wrapperTransform(el),
              // The selected comment sits above its peers so an overlapping
              // pin doesn't catch clicks meant for the open popup.
              zIndex: selectedSet.has(el.id) || editingId === el.id ? 30 : 10,
            }}
          >
            <ElementView
              element={el}
              selected={selectedSet.has(el.id)}
              editing={editingId === el.id}
              onPointerDown={onElementPointerDown(el)}
              onChangeText={(t) => changeText(el.id, t)}
              onEditDone={() => setEditingId(null)}
              onToggleCommentResolved={toggleCommentResolved}
              commentAnchorLabel={anchorLabelFor(el.anchorId)}
            />
          </div>
        ))}

        {/* ⌥-hover measure — gap lines + px labels between the selection and
            the hovered element (Figma's red measurements). Lines stay 1px and
            labels constant-size on screen via the 1/zoom counter-scale. */}
        {measureLines.map((m, i) => (
          <div key={`measure-${i}`} className="pointer-events-none absolute" style={{ left: m.x, top: m.y }}>
            <div
              className="absolute bg-accent"
              style={
                m.w > 0
                  ? { width: m.w, height: Math.max(1, 1.5 / viewport.zoom) }
                  : { width: Math.max(1, 1.5 / viewport.zoom), height: m.h }
              }
            />
            <div
              className="absolute rounded-[3px] bg-accent px-1 py-0.5 text-[10px] font-semibold leading-none text-bg-card"
              style={{
                left: m.w / 2,
                top: m.h / 2,
                transform: `translate(-50%, ${m.w > 0 ? '4px' : '-50%'}) scale(${1 / viewport.zoom})`,
                transformOrigin: m.w > 0 ? 'top center' : 'center left',
              }}
            >
              {m.label}
            </div>
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

        {/* Auto-layout drop preview — the accent insertion bar marking the
            slot the release will splice into (the dodging siblings translate
            via their wrappers above). 2 screen-px thick, centred on the slot,
            spanning the frame's padded interior on the cross axis. */}
        {dropPreview &&
          (() => {
            const { bar, frameBox } = dropPreview
            const th = 2 / viewport.zoom
            return (
              <>
                {/* When the drop grows the frame (hug axis absorbing the
                    newcomer), a dashed outline previews the grown box — so a
                    bar past the CURRENT edge reads as "the frame grows here",
                    not as an insertion into empty canvas. */}
                {frameBox && (
                  <div
                    className="pointer-events-none absolute rounded-[2px]"
                    style={{
                      left: frameBox.x,
                      top: frameBox.y,
                      width: frameBox.w,
                      height: frameBox.h,
                      border: `${1 / viewport.zoom}px dashed rgba(178,58,44,0.5)`,
                    }}
                  />
                )}
                <div
                  className="pointer-events-none absolute rounded-full bg-accent"
                  style={
                    bar.axis === 'x'
                      ? {
                          left: bar.pos - th / 2,
                          top: bar.from,
                          width: th,
                          height: Math.max(0, bar.to - bar.from),
                        }
                      : {
                          left: bar.from,
                          top: bar.pos - th / 2,
                          width: Math.max(0, bar.to - bar.from),
                          height: th,
                        }
                  }
                />
              </>
            )
          })()}

        {/* Hover-sync highlight (Layers panel ⇄ canvas): a light accent
            outline on the hovered element — skipped while it's selected (the
            selection ring already marks it). */}
        {highlightedId &&
          !selectedIds.includes(highlightedId) &&
          (() => {
            const el = canvas.elements.find(
              (x) => x.id === highlightedId && !x.hidden && x.type !== 'group',
            )
            if (!el) return null
            const b = fullBounds(el)
            return (
              <div
                className="pointer-events-none absolute rounded-[2px]"
                style={{
                  left: b.x,
                  top: b.y,
                  width: b.w,
                  height: b.h,
                  border: `${1.5 / viewport.zoom}px solid rgba(178,58,44,0.55)`,
                  transform: el.rotation
                    ? `rotate(${normalizeRotation(el.rotation)}deg)`
                    : undefined,
                }}
              />
            )
          })()}

        {/* Multi-selection bounding box (group resize gets the same 4-corner
            chrome below; the dashed outline marks the bbox itself). */}
        {groupBox && (
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
        )}

        {/* Selection chrome — corner squares (8px screen-fixed) on the lone
            selection's rotated box, or on the multi-selection bbox. A lone TEXT
            additionally shows its mode's SIDE handles (TEXT_HANDLES) so the
            iconic two-handle auto-width grip / wrapping handles are visible.
            Visuals only: presses route through onChromePointerDown (capture) and
            the hover cursor through updateChromeCursor, both against the same
            pure geometry — non-rendered handle positions still resize where the
            mode allows. */}
        {(() => {
          const chrome = groupBox
            ? { box: groupBox, rot: 0 }
            : resizeTarget
              ? {
                  box: fullBounds(resizeTarget),
                  rot: normalizeRotation(resizeTarget.rotation ?? 0),
                }
              : null
          if (!chrome) return null
          const pts = handlePoints(
            { x: chrome.box.x, y: chrome.box.y, w: chrome.box.w, h: chrome.box.h },
            chrome.rot,
          )
          const size = 8 / viewport.zoom
          // Text draws exactly the handles its mode exposes; everything else
          // keeps the 4-corner chrome (edges resize but render no square).
          const handles =
            !groupBox && resizeTarget?.type === 'text'
              ? RESIZE_HANDLES.filter((h) => TEXT_HANDLES[textSizingOf(resizeTarget)].has(h))
              : CORNER_HANDLES
          return handles.map((h) => (
            <div
              key={`chrome-${h}`}
              data-handle={h}
              className="absolute border-accent bg-bg-card"
              style={{
                left: pts[h].x - size / 2,
                top: pts[h].y - size / 2,
                width: size,
                height: size,
                borderWidth: 1 / viewport.zoom,
                // The square stays axis-aligned with the ELEMENT, not the screen.
                transform: chrome.rot ? `rotate(${chrome.rot}deg)` : undefined,
                cursor: cursorForHandle(h, chrome.rot),
              }}
            />
          ))
        })()}

        {/* W × H badge — live size pill under the box's (rotated) bottom edge
            while a single-element resize drags. Constant screen size via the
            1/zoom counter-scale (same pattern as the measure labels). */}
        {chromeDrag?.kind === 'resize' &&
          resizeTarget &&
          (() => {
            const b = fullBounds(resizeTarget)
            const rot = normalizeRotation(resizeTarget.rotation ?? 0)
            const mid = handlePoints(b, rot).b
            const r = (rot * Math.PI) / 180
            const off = 14 / viewport.zoom
            return (
              <div
                className="pointer-events-none absolute whitespace-nowrap rounded-[4px] border border-line bg-bg-card px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink"
                style={{
                  left: mid.x - Math.sin(r) * off,
                  top: mid.y + Math.cos(r) * off,
                  transform: `translate(-50%, 0) scale(${1 / viewport.zoom})`,
                  transformOrigin: 'top center',
                }}
              >
                {Math.round(b.w)} × {Math.round(b.h)}
              </div>
            )
          })()}

        {/* N° badge — the element's current angle, riding near the pointer
            while a rotate drags. */}
        {chromeDrag?.kind === 'rotate' && rotateTarget && (
          <div
            className="pointer-events-none absolute whitespace-nowrap rounded-[4px] border border-line bg-bg-card px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink"
            style={{
              left: chromeDrag.x + 16 / viewport.zoom,
              top: chromeDrag.y + 16 / viewport.zoom,
              transform: `scale(${1 / viewport.zoom})`,
              transformOrigin: 'top left',
            }}
          >
            {normalizeRotation(rotateTarget.rotation ?? 0)}°
          </div>
        )}
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
