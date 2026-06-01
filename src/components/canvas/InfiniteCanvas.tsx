import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BringToFront, Copy, SendToBack, Trash2 } from 'lucide-react'
import { ProjectCard } from './ProjectCard'
import { ElementView } from './ElementView'
import { FrameView } from './FrameView'
import type {
  CanvasElement,
  CanvasState,
  ProjectMeta,
  RunEntry,
  RunStatusInfo,
  RunSummaryInfo,
  Tool,
} from '@/lib/types'
import { newId } from '@/lib/ids'
import { clearDanglingAnchors, removeElements } from '@/lib/canvasIntegrity'
import {
  resolveContainerId,
  CONTAINER_TYPES,
  type Container,
  type Rect,
} from '@/lib/canvasContainment'
import { lockAspectRatio } from '@/lib/canvasTransform'
import { SHAPE_DEFAULT_W, SHAPE_DEFAULT_H, drawRectFromDrag } from '@/lib/canvasShape'

interface Props {
  projects: ProjectMeta[]
  canvas: CanvasState
  onCanvasChange: (c: CanvasState) => void
  selectedIds: string[]
  onSelect: (id: string | null, additive?: boolean) => void
  onSelectIds: (ids: string[]) => void
  editingId: string | null
  onEditingIdChange: (id: string | null) => void
  tool: Tool
  onToolChange: (t: Tool) => void
  runStatuses?: Map<string, RunStatusInfo>
  runSummaries?: Map<string, RunSummaryInfo>
  /** Project-Canvas-only: fire a comment element's text as a Canvas chat. */
  onRunComment?: (comment: CanvasElement) => void
  /** Project-Canvas-only: live run status + reply for a comment's linked chat,
   *  so the pin can show queued/running/done and the latest summary. */
  commentRunInfo?: (
    chatId: string,
  ) => { status: RunEntry['status']; summary: string } | null
  /** Project-Canvas-only: focus a comment's linked chat thread in the sidebar. */
  onOpenCommentThread?: (chatId: string) => void
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
  // resize: ow/oh are the pre-drag dimensions; Shift-to-lock reads e.shiftKey
  // live in the move handler, so no `shift` field is captured at press time.
  | { kind: 'resize'; id: string; sx: number; sy: number; ow: number; oh: number }
  // marquee: sx/sy are viewport-relative screen coordinates
  | { kind: 'marquee'; sx: number; sy: number; shift: boolean }

// Free-form canvas: project cards, text/sticky annotations and grouping
// frames, all freely positioned. The active tool decides what a press does.
export const InfiniteCanvas = ({
  projects,
  canvas,
  onCanvasChange,
  selectedIds,
  onSelect,
  onSelectIds,
  editingId,
  onEditingIdChange,
  tool,
  onToolChange,
  runStatuses,
  runSummaries,
  onRunComment,
  commentRunInfo,
  onOpenCommentThread,
  onDuplicate,
  projectPath,
  canvasId,
  onImagePaste,
}: Props) => {
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
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  )
  // Right-click context menu position (viewport-relative px), or null when closed.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const spaceDown = useRef(false)
  const press = useRef<Press | null>(null)
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
  const visible = elements.filter((el) => !el.hidden)
  const frames = visible.filter((el) => el.type === 'frame')
  // Render order: non-comment notes first, then comments. Comment popups
  // need to layer above sibling stickies / mocks so a pin dropped on a
  // mockup can still open its editor cleanly.
  const notes = visible.filter((el) => el.type !== 'frame' && el.type !== 'comment')
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

  // The lone selected sticky/frame/mock gets a corner resize handle. Text
  // elements size themselves from their content; comments are fixed-size
  // pins by design (resizing a pin makes no UX sense).
  const resizeTarget =
    tool === 'select' && selectedIds.length === 1 && !editingId
      ? elements.find(
          (el) => el.id === selectedIds[0] && el.type !== 'text' && el.type !== 'comment',
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
      // the same reference when nothing matched.
      const next = removeElements(c.elements, selectedIds)
      if (next === c.elements) return
      e.preventDefault()
      onCanvasChange({ ...c, elements: next })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editingId, selectedIds, onCanvasChange])

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
    try {
      ;(viewportRef.current as HTMLElement | null)?.setPointerCapture(e.pointerId)
    } catch {}
  }

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
      if (el.type === 'comment' || el.hidden) continue
      const b = elementBounds(el)
      if (!b) continue
      if (wx < b.x || wx > b.x + b.w || wy < b.y || wy > b.y + b.h) continue
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

  const onCardPointerDown = (project: ProjectMeta) => (e: React.PointerEvent) => {
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    setEditingId(null)
    const pos = canvasRef.current.positions[project.id]
    if (!pos) return
    press.current = {
      kind: 'card',
      id: project.id,
      sx: e.clientX,
      sy: e.clientY,
      ox: pos.x,
      oy: pos.y,
      moved: false,
      shift: e.shiftKey,
    }
    setPanning(true)
    capture(e)
  }

  const onElementPointerDown = (el: CanvasElement) => (e: React.PointerEvent) => {
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
    }
    setPanning(true)
    capture(e)
  }

  const onFramePointerDown = (frame: CanvasElement) => (e: React.PointerEvent) => {
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    if (editingId === frame.id) return
    setEditingId(null)
    const c = canvasRef.current
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
    // Direct children of the frame…
    const directChildIds = new Set<string>()
    for (const el of c.elements) {
      if (el.id === frame.id || el.type === 'frame') continue
      if (el.parentId === frame.id) {
        directChildIds.add(el.id)
        items.push({ id: el.id, isCard: false, ox: el.x, oy: el.y })
      }
    }
    // …plus a design's text annotations (grandchildren): a text parented to a
    // mock/screen that itself sits in this frame must ride along too, else
    // dragging the frame would strand the label off its design.
    for (const el of c.elements) {
      if (el.type === 'text' && el.parentId && directChildIds.has(el.parentId)) {
        items.push({ id: el.id, isCard: false, ox: el.x, oy: el.y })
      }
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
  const onResizePointerDown = (el: CanvasElement) => (e: React.PointerEvent) => {
    if (tool !== 'select' || spaceDown.current) return // Space → bubble up to pan
    e.stopPropagation()
    press.current = {
      kind: 'resize',
      id: el.id,
      sx: e.clientX,
      sy: e.clientY,
      ow: el.width ?? STICKY_DEFAULT,
      oh: el.height ?? STICKY_DEFAULT,
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
    const p = press.current
    if (!p) return
    const c = canvasRef.current
    if (p.kind === 'resize') {
      let w = Math.max(RESIZE_MIN_W, p.ow + (e.clientX - p.sx) / c.viewport.zoom)
      let h = Math.max(RESIZE_MIN_H, p.oh + (e.clientY - p.sy) / c.viewport.zoom)
      // Hold Shift to lock the aspect ratio (Figma-style proportional resize).
      // Read live from the event so the user can toggle Shift mid-drag. Lock
      // off the *original* (pre-drag) dimensions, then re-apply the per-axis
      // floor so a proportional shrink can't drive either side below its min.
      if (e.shiftKey) {
        const locked = lockAspectRatio(w, h, p.ow, p.oh)
        w = Math.max(RESIZE_MIN_W, locked.width)
        h = Math.max(RESIZE_MIN_H, locked.height)
      }
      onCanvasChange({
        ...c,
        elements: c.elements.map((el) =>
          el.id === p.id ? { ...el, width: w, height: h } : el,
        ),
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
    if (p.kind === 'card') {
      onCanvasChange({
        ...c,
        positions: { ...c.positions, [p.id]: { x: p.ox + dx, y: p.oy + dy } },
      })
    } else if (p.kind === 'element') {
      // Move the element, plus any carried children (a design's annotations) by
      // the same delta so they ride along rigidly.
      const childMoves = p.children
        ? new Map(p.children.map((ch) => [ch.id, { x: ch.ox + dx, y: ch.oy + dy }]))
        : null
      onCanvasChange({
        ...c,
        elements: c.elements.map((el) => {
          if (el.id === p.id) return { ...el, x: p.ox + dx, y: p.oy + dy }
          const m = childMoves?.get(el.id)
          return m ? { ...el, x: m.x, y: m.y } : el
        }),
      })
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
    const p = press.current
    if (p) {
      if (p.kind === 'card' || p.kind === 'element' || p.kind === 'frame') {
        if (p.moved) {
          // A drag is not a click — don't let it pair with the next one.
          lastClick.current = null
          // Frame containment: when a non-frame element is dropped, recompute
          // its frame membership from where it actually landed (rect inside a
          // frame → parentId = that frame; outside every frame → cleared). This
          // persists through the normal save path. A *frame* drag carries its
          // children rigidly, so their membership is unchanged — only an
          // element drag can change containment in this single-level slice.
          if (p.kind === 'element') {
            const cur = canvasRef.current
            const reparented = reparentMoved(cur.elements, new Set([p.id]))
            // Keep design annotations painting on top of their design after a
            // (re)parent — a text just dropped on a mock/screen must sit above
            // the iframe, not behind it.
            const ordered = raiseDesignAnnotations(reparented)
            if (ordered !== cur.elements) {
              onCanvasChange({ ...cur, elements: ordered })
            }
          }
        } else {
          onSelect(p.id, p.shift)
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
          for (const el of c.elements) {
            if (el.type === 'frame' || el.hidden) continue
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
          onSelectIds(
            p.shift ? Array.from(new Set([...selectedRef.current, ...hit])) : hit,
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
          onCanvasChange({
            ...c,
            elements: [
              ...c.elements,
              { id, type: 'frame', x, y, width: fw, height: fh, text: '' },
            ],
          })
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

  // Z-order is implicit in array order: front = end of array, back = start.
  // Moves the whole selection while preserving its internal order.
  const reorderSelection = (toFront: boolean) => {
    const c = canvasRef.current
    const sel = new Set(selectedRef.current)
    if (!sel.size) return
    const picked = c.elements.filter((el) => sel.has(el.id))
    const rest = c.elements.filter((el) => !sel.has(el.id))
    onCanvasChange({ ...c, elements: toFront ? [...rest, ...picked] : [...picked, ...rest] })
  }

  const nudgeSelection = (dx: number, dy: number) => {
    const c = canvasRef.current
    const sel = new Set(selectedRef.current)
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
    // removeElements scrubs any comment whose anchor — or element whose parent
    // frame — was just deleted (no dangling anchorId / parentId).
    const next = removeElements(c.elements, selectedRef.current)
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
      if (el.hidden) continue
      const b = fullBounds(el)
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return el.id
    }
    return undefined
  }

  // Recompute container membership for the moved elements after a drag settles,
  // and return the elements array with each one's `parentId` set / cleared to
  // match where it actually landed (rect containment). Containers are frames AND
  // designs (mock/screen): a frame owns any non-frame child, a design owns a
  // `text` annotation dropped on top of it (see canContain). Frames never get a
  // parentId in this slice (no nested-frame parenting yet) so they're skipped as
  // movers but still serve as containers. Returns the same array reference when
  // nothing changed so callers can skip a redundant write.
  const containerList = (els: CanvasElement[]): Container[] =>
    els
      .filter((el) => CONTAINER_TYPES.has(el.type))
      .map((el) => ({ id: el.id, type: el.type, rect: fullBounds(el) as Rect }))

  const reparentMoved = (
    els: CanvasElement[],
    movedIds: Set<string>,
  ): CanvasElement[] => {
    const containers = containerList(els)
    let changed = false
    const next = els.map((el) => {
      if (!movedIds.has(el.id) || el.type === 'frame') return el
      const parentId = resolveContainerId(
        el.id,
        el.type,
        fullBounds(el) as Rect,
        containers,
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
          <div key={frame.id} className="absolute" style={{ left: frame.x, top: frame.y }}>
            <FrameView
              frame={frame}
              selected={selectedIds.includes(frame.id)}
              editing={editingId === frame.id}
              onHeaderPointerDown={onFramePointerDown(frame)}
              onChangeLabel={(t) => changeText(frame.id, t)}
              onEditDone={() => setEditingId(null)}
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
            <div key={p.id} className="absolute" style={{ left: pos.x, top: pos.y }}>
              <ProjectCard
                project={p}
                onPointerDown={onCardPointerDown(p)}
                selected={selectedIds.includes(p.id)}
                run={runStatuses?.get(p.id)}
                summary={runSummaries?.get(p.id)}
              />
            </div>
          )
        })}

        {notes.map((el) => (
          <div key={el.id} className="absolute" style={{ left: el.x, top: el.y }}>
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
              onRunComment={onRunComment}
              onToggleCommentResolved={toggleCommentResolved}
              commentAnchorLabel={anchorLabelFor(el.anchorId)}
              commentRun={el.chatId && commentRunInfo ? commentRunInfo(el.chatId) : null}
              onOpenCommentThread={
                el.chatId && onOpenCommentThread
                  ? () => onOpenCommentThread(el.chatId!)
                  : undefined
              }
            />
          </div>
        ))}

        {resizeTarget && (
          <div
            onPointerDown={onResizePointerDown(resizeTarget)}
            className="absolute h-3.5 w-3.5 rounded-[2px] border-2 border-accent bg-bg-card shadow-card"
            style={{
              left: resizeTarget.x + (resizeTarget.width ?? STICKY_DEFAULT) - 7,
              top: resizeTarget.y + (resizeTarget.height ?? STICKY_DEFAULT) - 7,
              cursor: 'nwse-resize',
            }}
          />
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
              label="複製"
              hint="⌘D"
              onClick={() => {
                onDuplicate()
                setMenu(null)
              }}
            />
          )}
          <ContextItem
            icon={<BringToFront size={13} strokeWidth={2} />}
            label="最前面へ"
            hint="]"
            onClick={() => {
              reorderSelection(true)
              setMenu(null)
            }}
          />
          <ContextItem
            icon={<SendToBack size={13} strokeWidth={2} />}
            label="最背面へ"
            hint="["
            onClick={() => {
              reorderSelection(false)
              setMenu(null)
            }}
          />
          <div className="my-1 border-t border-line-soft" />
          <ContextItem
            icon={<Trash2 size={13} strokeWidth={2} />}
            label="削除"
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
