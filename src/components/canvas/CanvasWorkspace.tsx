import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Minus, Plus, Redo2, Sparkles, Undo2, X } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { InfiniteCanvas, type CanvasZoomApi } from './InfiniteCanvas'
import { ToolPalette } from './ToolPalette'
import { SelectionInspector } from './SelectionInspector'
import { LayersPanel } from './LayersPanel'
import { ClaudeTerminalPane } from './ClaudeTerminalPane'
import { CanvasAssetProvider } from './CanvasAssetContext'
import { uploadCanvasAsset } from '@/lib/canvasAssets'
import { newId } from '@/lib/ids'
import { removeElements } from '@/lib/canvasIntegrity'
import {
  withGroupAncestors,
  expandSelectionForElement,
  groupCascadeSets,
} from '@/lib/canvasGroup'
import { applyElementPatch } from '@/lib/canvasTextStyle'
import { reorderLayer, moveLayerOne, type LayerDropPlace } from '@/lib/canvasLayerTree'
import { alignElements, alignElementsToBox, type AlignOp } from '@/lib/canvasAlign'
import { applyAutoLayout, addAutoLayout, insertIntoLayoutAtPoint } from '@/lib/canvasAutoLayout'
import { pickStyle, applyStyle, type CopiedStyle } from '@/lib/canvasStyleClipboard'
import { elementBounds } from '@/lib/canvasBounds'
import type {
  CanvasAiActiveResponse,
  CanvasAiJobState,
  CanvasAiStartResponse,
  CanvasElement,
  CanvasFile,
  GenerateCanvasAiRequest,
  Tool,
} from '@/lib/types'

interface Props {
  projectPath: string
  canvas: CanvasFile
  /** Persist any change to this Canvas. Debounced upstream by ProjectCanvas
   *  so a pan/zoom storm doesn't write on every frame. */
  onChange: (next: CanvasFile) => void
  /** Dock slots in ProjectCanvas's sidebars. The Layers tree and the
   *  inspector need this workspace's selection/element state, so the
   *  workspace portals them into the shell-owned hosts; null (sidebar hidden
   *  via ⌘\, or shell absent) skips the portal. */
  layersHost?: HTMLElement | null
  inspectorHost?: HTMLElement | null
  /** Notify the shell whether the inspector currently has something to edit,
   *  so it can collapse the right dock (widening the canvas) on an empty
   *  selection and auto-restore it on selection — Figma-style. */
  onInspectorOpenChange?: (open: boolean) => void
}

// Clone elements for paste / duplicate: fresh ids and a small offset. Run-
// derived comment state is dropped (a clone is a fresh, unhandled pin with no
// thread), and a comment's anchorId — like a contained element's parentId — is
// remapped to the cloned target when that target was copied in the same batch
// (else dropped, so the copy doesn't claim an element/frame it isn't paired
// with).
const cloneForPaste = (
  els: CanvasElement[],
  dx: number,
  dy: number,
): CanvasElement[] => {
  const idMap = new Map(els.map((el) => [el.id, newId()]))
  return els.map((el) => {
    const { chatId: _chatId, resolved: _resolved, anchorId, parentId, ...rest } = el
    const next: CanvasElement = {
      ...rest,
      id: idMap.get(el.id)!,
      x: el.x + dx,
      y: el.y + dy,
    }
    if (anchorId && idMap.has(anchorId)) next.anchorId = idMap.get(anchorId)!
    // Keep frame membership only when the parent frame was copied too — else
    // the clone would render as a phantom child of the original frame and move
    // with it.
    if (parentId && idMap.has(parentId)) next.parentId = idMap.get(parentId)!
    return next
  })
}

// Owns a single Canvas's runtime: keeps the drawing surface, the chat sidebar,
// and the tool selection in sync, and rebroadcasts any change up to
// ProjectCanvas for persistence to .openground/canvases/<id>.json.
export const CanvasWorkspace = ({
  projectPath,
  canvas,
  onChange,
  layersHost,
  inspectorHost,
  onInspectorOpenChange,
}: Props) => {
  const { t } = useT()
  const [tool, setTool] = useState<Tool>('select')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  // Hover sync between the Layers panel and the canvas (both directions feed
  // the same id; InfiniteCanvas outlines it, the panel highlights its row).
  const [hoveredElementId, setHoveredElementId] = useState<string | null>(null)
  // Imperative zoom handle the canvas registers; drives the zoom pill.
  const zoomApi = useRef<CanvasZoomApi | null>(null)
  // Bumps to re-render undo/redo affordances when the history stacks change.
  const [, setHistVer] = useState(0)

  // Wipe transient editor state when the active Canvas changes — these are
  // canvas-local concerns that don't belong in the persisted file.
  useEffect(() => {
    setSelectedIds([])
    setEditingId(null)
  }, [canvas.id])

  // Mirror `canvas` through a ref so two synchronous patch() calls in the
  // same event handler compose instead of clobbering each other. Without
  // this, the sidebar's "create chat" flow (chats update + activeChatId
  // update) would emit two onChange calls that both spread the stale prop
  // value and the second would erase the first's `chats` change — chat
  // never reaches the list, run fires but has nothing to attach to.
  const canvasRef = useRef(canvas)
  canvasRef.current = canvas

  // Tracks the elements array WE last emitted via patch(), so the external-
  // update effect can tell our own changes apart from an observer re-fetch.
  const lastLocalElementsRef = useRef(canvas.elements)

  const patch = useCallback(
    (changes: Partial<CanvasFile>) => {
      const next = { ...canvasRef.current, ...changes }
      canvasRef.current = next
      lastLocalElementsRef.current = next.elements
      onChange(next)
    },
    [onChange],
  )

  // ── Undo / redo history (element mutations only; pan/zoom is not undoable,
  //    matching Figma-style expectations). Snapshots are coalesced on a short
  //    idle so a drag / resize / typing burst collapses to one undo step. ──
  const undoRef = useRef<CanvasElement[][]>([])
  const redoRef = useRef<CanvasElement[][]>([])
  const baselineRef = useRef<CanvasElement[]>(canvas.elements)
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const HIST_IDLE_MS = 350
  const HIST_MAX = 120

  // Reset history on canvas switch — each Canvas owns its own timeline.
  useEffect(() => {
    undoRef.current = []
    redoRef.current = []
    baselineRef.current = canvasRef.current.elements
    lastLocalElementsRef.current = canvasRef.current.elements
    if (histTimer.current) {
      clearTimeout(histTimer.current)
      histTimer.current = null
    }
    setHistVer((v) => v + 1)
  }, [canvas.id])

  // External element replacements (the observer's CANVAS_ADD / CANVAS_UPDATE
  // re-fetch replaces `canvas` wholesale) arrive as a new prop that is NOT the
  // array we last emitted via patch(). Adopt it as the new baseline AND drop
  // the now-divergent undo/redo stacks — otherwise a later undo (or redo) would
  // restore a pre-Claude snapshot and silently delete Claude's contribution.
  useEffect(() => {
    if (canvas.elements === lastLocalElementsRef.current) return
    if (histTimer.current) {
      clearTimeout(histTimer.current)
      histTimer.current = null
    }
    baselineRef.current = canvas.elements
    lastLocalElementsRef.current = canvas.elements
    undoRef.current = []
    redoRef.current = []
    // In-flight gesture snapshots predate this adoption — bumping the epoch
    // invalidates them so an Esc-cancel can't restore a stale canvas over the
    // adopted state (and then persist + auto-sync the revert).
    adoptionEpochRef.current++
    setHistVer((v) => v + 1)
  }, [canvas.elements])

  // Commit the pending element change: push the last committed baseline onto
  // the undo stack and adopt the current elements as the new baseline.
  const flushHistory = useCallback(() => {
    if (histTimer.current) {
      clearTimeout(histTimer.current)
      histTimer.current = null
    }
    const latest = canvasRef.current.elements
    if (baselineRef.current === latest) return
    undoRef.current.push(baselineRef.current)
    if (undoRef.current.length > HIST_MAX) undoRef.current.shift()
    redoRef.current = []
    baselineRef.current = latest
    setHistVer((v) => v + 1)
  }, [])

  const recordElementsChange = useCallback(() => {
    if (histTimer.current) clearTimeout(histTimer.current)
    histTimer.current = setTimeout(flushHistory, HIST_IDLE_MS)
  }, [flushHistory])

  // Esc-cancel support: the canvas snapshots the undo depth at press time and
  // hands it back when a gesture is cancelled. Rolling back here (instead of
  // letting the restore flow through as a normal change) keeps the cancelled
  // mid-drag state out of ⌘Z — Figma's Esc leaves no history step.
  // historyDepth FLUSHES the pending coalesced edit first: an edit made
  // <350ms before the press would otherwise lose its undo boundary when the
  // cancel re-baselines (⌘Z would then jump two edits at once).
  const historyDepth = useCallback(() => {
    flushHistory()
    return undoRef.current.length
  }, [flushHistory])
  const cancelRestoreToDepth = useCallback((depth: number) => {
    if (histTimer.current) {
      clearTimeout(histTimer.current)
      histTimer.current = null
    }
    // Redo survives a no-op cancel: it only dies when a mid-drag pause really
    // flushed a step (flushHistory cleared it then; the truncation just
    // removes that step again).
    if (undoRef.current.length > depth) undoRef.current.length = depth
    baselineRef.current = canvasRef.current.elements
    setHistVer((v) => v + 1)
  }, [])
  // Bumped whenever an external elements replacement is adopted (effect
  // above); gesture snapshots record it so a stale Esc-restore is refused.
  const adoptionEpochRef = useRef(0)
  const adoptionEpoch = useCallback(() => adoptionEpochRef.current, [])

  // The single entry point for undoable element changes. Every change is
  // normalized through applyAutoLayout so a layout frame's children re-flow on
  // any edit that funnels here (inspector patches, paste, AI insert, delete,
  // align) — gesture-final commits inside InfiniteCanvas run the same pass at
  // pointer-up. No-op (same reference) for canvases without layout frames.
  const mutateElements = useCallback(
    (next: CanvasElement[]) => {
      patch({ elements: applyAutoLayout(next) })
      recordElementsChange()
    },
    [patch, recordElementsChange],
  )

  // Selection Inspector: apply a partial patch to one element by id, routed
  // through mutateElements so the edit undoes/redoes and persists exactly like
  // a drag or a retype. No-op patches (no matching id) skip the write.
  // Typing W/H on a hug-axis layout frame flips that axis to fixed (Figma) —
  // without this the engine snaps the size straight back. Explicit layout
  // writes (the sizing dropdowns) pass `changes.layout` and are left alone.
  // Shared by the single-element AND the multi-select patch paths.
  const withHugReleased = (
    els: CanvasElement[],
    id: string,
    changes: Partial<CanvasElement>,
  ): Partial<CanvasElement> => {
    if ('layout' in changes || (changes.width === undefined && changes.height === undefined))
      return changes
    const el = els.find((e) => e.id === id)
    if (el?.type !== 'frame' || !el.layout) return changes
    const row = el.layout.mode === 'row'
    const dropPrimary =
      el.layout.primarySizing === 'hug' &&
      (row ? changes.width !== undefined : changes.height !== undefined)
    const dropCounter =
      el.layout.counterSizing === 'hug' &&
      (row ? changes.height !== undefined : changes.width !== undefined)
    if (!dropPrimary && !dropCounter) return changes
    const layout = { ...el.layout }
    if (dropPrimary) delete layout.primarySizing
    if (dropCounter) delete layout.counterSizing
    return { ...changes, layout }
  }

  const patchElement = useCallback(
    (id: string, changes: Partial<CanvasElement>) => {
      const effective = withHugReleased(canvasRef.current.elements, id, changes)
      const next = applyElementPatch(canvasRef.current.elements, id, effective)
      if (next !== canvasRef.current.elements) mutateElements(next)
    },
    [mutateElements],
  )

  // Align / distribute the current selection (Figma-parity). Locked elements
  // (directly or via a locked group) and groups (no box of their own) are
  // excluded. Two reference modes, like Figma: ≥2 participants align RELATIVE
  // to each other (alignElements); a SINGLE element that lives inside a frame
  // aligns against that frame's box (alignElementsToBox — "center in frame").
  // One undoable step either way.
  const alignSelection = useCallback(
    (op: AlignOp) => {
      const els = canvasRef.current.elements
      const byId = new Map(els.map((e) => [e.id, e]))
      const { lockedViaGroup } = groupCascadeSets(els)
      const items = []
      for (const id of selectedIds) {
        const el = byId.get(id)
        if (!el || el.locked || lockedViaGroup.has(id)) continue
        const b = elementBounds(el)
        if (b) items.push({ id, x: b.x, y: b.y, w: b.w, h: b.h })
      }
      let moves = alignElements(items, op)
      if (items.length === 1) {
        const parent = byId.get(byId.get(items[0].id)?.parentId ?? '')
        const box = parent?.type === 'frame' ? elementBounds(parent) : null
        if (box) moves = alignElementsToBox(items, box, op)
      }
      if (!moves.length) return
      const moveById = new Map(moves.map((m) => [m.id, m]))
      const next = els.map((e) => {
        const m = moveById.get(e.id)
        return m && (m.x !== e.x || m.y !== e.y) ? { ...e, x: m.x, y: m.y } : e
      })
      if (next.some((e, i) => e !== els[i])) mutateElements(next)
    },
    [selectedIds, mutateElements],
  )

  const undo = useCallback(() => {
    flushHistory()
    if (!undoRef.current.length) return
    const prev = undoRef.current.pop()!
    redoRef.current.push(baselineRef.current)
    baselineRef.current = prev
    patch({ elements: prev })
    setEditingId(null)
    setSelectedIds([])
    setHistVer((v) => v + 1)
  }, [flushHistory, patch])

  const redo = useCallback(() => {
    // Commit any pending coalesced edit first (mirrors undo). flushHistory
    // clears redo when it commits, so a fresh-edit-then-redo correctly becomes
    // a no-op that preserves the edit instead of dropping it.
    flushHistory()
    if (!redoRef.current.length) return
    const next = redoRef.current.pop()!
    undoRef.current.push(baselineRef.current)
    baselineRef.current = next
    patch({ elements: next })
    setEditingId(null)
    setSelectedIds([])
    setHistVer((v) => v + 1)
  }, [flushHistory, patch])

  const handleCanvasChange = (c: { viewport: CanvasFile['viewport']; elements: CanvasElement[] }) => {
    const changedElements = c.elements !== canvasRef.current.elements
    patch({ viewport: c.viewport, elements: c.elements })
    if (changedElements) recordElementsChange()
  }

  // DERIVED element writes (measured text footprints): persisted, but not an
  // undo step of their own — undoing the text edit re-measures and re-derives
  // the size. Folding into the baseline only happens from a CLEAN state; when
  // real edits are pending the write rides the normal coalesced history so
  // their boundary survives.
  const handleImplicitElementsChange = useCallback(
    (next: CanvasElement[]) => {
      const clean =
        baselineRef.current === canvasRef.current.elements && !histTimer.current
      patch({ elements: next })
      if (clean) baselineRef.current = next
      else recordElementsChange()
    },
    [patch, recordElementsChange],
  )

  // ── Copy / paste / duplicate of canvas elements ──────────────────────────
  // In-canvas clipboard, kept in a ref so it survives re-renders. Independent
  // of the OS clipboard (which the image-paste path owns).
  const clipboardRef = useRef<CanvasElement[]>([])
  // Style clipboard for ⌥⌘C / ⌥⌘V — same lifetime rules as clipboardRef.
  const styleClipRef = useRef<CopiedStyle | null>(null)

  const copySelection = useCallback(() => {
    // Pull in any group element owning a selected member so the clone stays
    // grouped (cloneForPaste remaps the group's id + the members' parentId).
    const ids = new Set(withGroupAncestors(canvasRef.current.elements, selectedIds))
    const picked = canvasRef.current.elements.filter((el) => ids.has(el.id))
    if (picked.length) clipboardRef.current = picked.map((el) => ({ ...el }))
  }, [selectedIds])

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current
    if (!clip.length) return
    const copies = cloneForPaste(clip, 24, 24)
    // A LONE pasted element whose landing point sits on a layout frame joins
    // that frame's flow at the slot under it (Figma); comments and off-frame
    // pastes fall through to the plain append inside the helper. Multi-element
    // pastes keep the append — their internal arrangement IS the payload.
    if (copies.length === 1) {
      const el = copies[0]
      const b = elementBounds(el)
      const point = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: el.x, y: el.y }
      mutateElements(insertIntoLayoutAtPoint(canvasRef.current.elements, el, point).elements)
    } else {
      mutateElements([...canvasRef.current.elements, ...copies])
    }
    // Select the pasted members, not the invisible group element(s).
    const groupCopyIds = new Set(copies.filter((c) => c.type === 'group').map((c) => c.id))
    const members = copies.filter((c) => !groupCopyIds.has(c.id))
    setSelectedIds((members.length ? members : copies).map((c) => c.id))
    setEditingId(null)
  }, [mutateElements])

  // Cut = copy the selection into the in-memory clipboard (so a later ⌘V pastes
  // it), then delete it through removeElements — the SAME path Delete uses — so
  // the cut can't leave a dangling comment anchor or frame/design parentId.
  const cutSelection = useCallback(() => {
    const ids = new Set(withGroupAncestors(canvasRef.current.elements, selectedIds))
    const picked = canvasRef.current.elements.filter((el) => ids.has(el.id))
    if (!picked.length) return
    clipboardRef.current = picked.map((el) => ({ ...el }))
    const next = removeElements(canvasRef.current.elements, ids)
    if (next !== canvasRef.current.elements) mutateElements(next)
    setSelectedIds([])
    setEditingId(null)
  }, [selectedIds, mutateElements])

  const duplicateSelection = useCallback(() => {
    const ids = new Set(withGroupAncestors(canvasRef.current.elements, selectedIds))
    const picked = canvasRef.current.elements.filter((el) => ids.has(el.id))
    if (!picked.length) return
    const copies = cloneForPaste(picked, 24, 24)
    mutateElements([...canvasRef.current.elements, ...copies])
    // Re-select only the duplicated MEMBERS (not the invisible group element),
    // matching how a fresh group selection reads on the canvas.
    const copiedGroupIds = new Set(
      copies.filter((c) => c.type === 'group').map((c) => c.id),
    )
    const memberCopies = copies.filter((c) => !copiedGroupIds.has(c.id))
    setSelectedIds((memberCopies.length ? memberCopies : copies).map((c) => c.id))
    setEditingId(null)
  }, [selectedIds, mutateElements])

  // ── Layers panel actions ─────────────────────────────────────────────────
  // Move ONE element a single step in z-order among its SIBLINGS (same parent),
  // carrying its whole subtree across the neighbour's subtree — the pure logic
  // (and the panel's matching disabled state) lives in canvasLayerTree. Routed
  // through mutateElements so it undoes / persists like every other change.
  const moveElementOne = useCallback(
    (id: string, dir: 'up' | 'down') => {
      const next = moveLayerOne(canvasRef.current.elements, id, dir)
      if (next !== canvasRef.current.elements) mutateElements(next)
    },
    [mutateElements],
  )

  // Toggle an element's visibility (Layers eye). Uses the same undoable patch
  // path as the inspector; a hidden element keeps its z-order + can be un-hidden.
  const toggleElementHidden = useCallback(
    (id: string) => {
      const el = canvasRef.current.elements.find((e) => e.id === id)
      if (!el) return
      patchElement(id, { hidden: !el.hidden })
    },
    [patchElement],
  )

  const toggleElementLocked = useCallback(
    (id: string) => {
      const el = canvasRef.current.elements.find((e) => e.id === id)
      if (!el) return
      // Store `undefined` (not false) when unlocking so the field stays clean.
      patchElement(id, { locked: el.locked ? undefined : true })
    },
    [patchElement],
  )

  // Rename a layer (Layers-panel double-click). An empty name clears the custom
  // label so the row falls back to its content-derived name. Same undoable patch
  // path as the inspector.
  const renameElement = useCallback(
    (id: string, name: string) => {
      patchElement(id, { name: name || undefined })
    },
    [patchElement],
  )

  // Drag-reorder a layer (Layers-panel drag). Moves the dragged element + its
  // subtree to land next to the target in z-order — or, with place 'into',
  // INSIDE the target container as its frontmost child — adopting the target's
  // nesting level; see reorderLayer. Routed through mutateElements so it
  // undoes/persists.
  const reorderElement = useCallback(
    (dragId: string, targetId: string, place: LayerDropPlace) => {
      const next = reorderLayer(canvasRef.current.elements, dragId, targetId, place)
      if (next !== canvasRef.current.elements) mutateElements(next)
    },
    [mutateElements],
  )

  // Image paste / drop. Uploads the file to /api/canvas/asset, then drops a
  // fresh ImageElement onto the canvas at the world coordinates the user
  // pointed at. Default size caps the long side at 480px so a 4k screenshot
  // doesn't land as a giant tile — the user can resize from there.
  const handleImagePaste = useCallback(
    async (file: File, worldX: number, worldY: number) => {
      // Best-effort intrinsic-size readout from the browser so we can place
      // the element at its natural aspect ratio. Failure (e.g. exotic format)
      // falls back to the default 480×360 box.
      const objUrl =
        typeof URL !== 'undefined' && 'createObjectURL' in URL
          ? URL.createObjectURL(file)
          : ''
      let naturalW = 0
      let naturalH = 0
      if (objUrl) {
        try {
          await new Promise<void>((resolve) => {
            const img = new window.Image()
            img.onload = () => {
              naturalW = img.naturalWidth
              naturalH = img.naturalHeight
              resolve()
            }
            img.onerror = () => resolve()
            img.src = objUrl
          })
        } finally {
          try { URL.revokeObjectURL(objUrl) } catch {}
        }
      }
      const maxInit = 480
      let w = 480
      let h = 360
      if (naturalW > 0 && naturalH > 0) {
        const scale = Math.min(1, maxInit / Math.max(naturalW, naturalH))
        w = Math.max(40, Math.round(naturalW * scale))
        h = Math.max(40, Math.round(naturalH * scale))
      }

      const uploaded = await uploadCanvasAsset(projectPath, canvas.id, file)
      if (!uploaded) return
      const { assetId, filename } = uploaded
      const el: CanvasElement = {
        id: newId(),
        type: 'image',
        x: Math.round(worldX - w / 2),
        y: Math.round(worldY - h / 2),
        width: w,
        height: h,
        text: '',
        assetId,
        filename,
        ...(naturalW ? { naturalWidth: naturalW } : {}),
        ...(naturalH ? { naturalHeight: naturalH } : {}),
      }
      // Dropped ON a layout frame, the image joins its flow at the slot under
      // the drop point (plain append elsewhere — the helper decides).
      mutateElements(
        insertIntoLayoutAtPoint(canvasRef.current.elements, el, {
          x: worldX,
          y: worldY,
        }).elements,
      )
    },
    [projectPath, canvas.id, mutateElements],
  )

  // ── "Generate with Claude" prompt bar (ToolPalette ✦) ────────────────────
  // POSTs /api/canvas/generate-elements; the returned NATIVE elements (claude
  // authors them relative to (0,0)) are re-id'd via cloneForPaste, offset so
  // their bounding-box centre lands on the current viewport centre, inserted
  // through mutateElements (normal undo history) and selected as a block so
  // the user can immediately move/adjust the placement.
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [genPrompt, setGenPrompt] = useState('')
  const [genPending, setGenPending] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  // Signed-out (503 { claudeLoggedOut }): the run gate refuses to spawn a
  // signed-out claude, so instead of a generic error we surface a "sign in to
  // Claude" CTA that opens the dedicated login terminal (below). claudeMissing
  // keeps its own install-guidance copy.
  const [genLoggedOut, setGenLoggedOut] = useState(false)
  // The running SERVER-SIDE generate job's id (null = none). The whole run lives
  // on the server (src/lib/server/canvasAi.ts), so it SURVIVES this component
  // unmounting (tab / project / Ground switch): we only START it and POLL it —
  // we never hold the request open and we never kill it on unmount. Only an
  // explicit Cancel kills it.
  const [genJobId, setGenJobId] = useState<string | null>(null)
  // Client-clock baseline for the elapsed counter, derived from the job's
  // SERVER-side startedAt (Date.now() - elapsedMs) so a remount that re-attaches
  // to a still-running job shows the TRUE elapsed time, not a reset to zero.
  const genStartedRef = useRef<number | null>(null)
  // Set when the user cancels DURING the start POST (before we hold a jobId): the
  // POST resolves with a jobId we must immediately cancel, so the run the user
  // already dismissed doesn't keep going and insert behind them.
  const genCancelRef = useRef(false)

  // Insert a completed generation's elements. The SERVER already assigned fresh
  // ids, inferred frame parentage, and placed the batch at a non-overlapping
  // position, so we append as-is (no re-id / no viewport offset), select it as a
  // block, and pan — keeping zoom — so the user sees it land.
  const applyGenerated = useCallback(
    (elements: CanvasElement[]) => {
      const generated = elements.filter(
        (el) =>
          Number.isFinite(el.x) &&
          Number.isFinite(el.y) &&
          (el.width === undefined || Number.isFinite(el.width)) &&
          (el.height === undefined || Number.isFinite(el.height)),
      )
      if (generated.length === 0) return
      mutateElements([...canvasRef.current.elements, ...generated])
      const groupIds = new Set(
        generated.filter((c) => c.type === 'group').map((c) => c.id),
      )
      const members = generated.filter((c) => !groupIds.has(c.id))
      setSelectedIds((members.length ? members : generated).map((c) => c.id))
      setEditingId(null)
      // Pan the viewport to centre the new batch's bounding box (zoom kept).
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const el of generated) {
        const b = elementBounds(el)
        if (!b) continue
        minX = Math.min(minX, b.x)
        minY = Math.min(minY, b.y)
        maxX = Math.max(maxX, b.x + b.w)
        maxY = Math.max(maxY, b.y + b.h)
      }
      if (Number.isFinite(minX)) {
        const rect = surfaceRef.current?.getBoundingClientRect()
        const W = rect ? rect.width : 800
        const H = rect ? rect.height : 600
        const zoom = canvasRef.current.viewport.zoom
        const cx = (minX + maxX) / 2
        const cy = (minY + maxY) / 2
        patch({ viewport: { x: W / 2 - cx * zoom, y: H / 2 - cy * zoom, zoom } })
      }
    },
    [mutateElements, patch],
  )

  // Live elapsed-seconds counter while a generation is in flight. A whole claude
  // session can take 30s–3min; a bare spinner reads as "frozen", so the pending
  // bar shows "Generating… Ns" ticking every second. Recomputed from a Date.now()
  // delta against the job's startedAt baseline (not a ++counter) so a
  // backgrounded tab — where setInterval is throttled — still shows the true
  // elapsed time, and a remount re-attach shows the real (not reset) age.
  const [genElapsed, setGenElapsed] = useState(0)
  useEffect(() => {
    if (!genPending) {
      setGenElapsed(0)
      return
    }
    const tick = () => {
      const base = genStartedRef.current ?? Date.now()
      setGenElapsed(Math.max(0, Math.floor((Date.now() - base) / 1000)))
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [genPending])

  // Re-attach to a generate job ALREADY running for this canvas — e.g. the user
  // started one, navigated away (this component unmounted), and came back. The
  // run kept going server-side; restore the progress bar + Cancel so it isn't a
  // mystery, and the poll effect below picks up the result. Runs once per canvas
  // mount (CanvasWorkspace remounts on canvas switch via its key).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/canvas/ai/active')
        if (!res.ok) return
        const data = (await res.json()) as CanvasAiActiveResponse
        if (cancelled) return
        const mine = data.jobs.find(
          (j) => j.kind === 'generate' && j.canvasId === canvasRef.current.id,
        )
        if (!mine) return
        genStartedRef.current = Date.now() - mine.elapsedMs
        setGenJobId(mine.id)
        setGenPending(true)
        setGenOpen(true)
      } catch {
        // offline / server restarting — nothing to re-attach to
      }
    })()
    return () => {
      cancelled = true
    }
  }, [canvas.id])

  // Poll the running job for progress + result. On 'done' insert the elements;
  // on 'error' surface it. Stops watching on unmount WITHOUT cancelling the job
  // (the run must survive navigation) — only an explicit Cancel kills it.
  useEffect(() => {
    if (!genJobId) return
    let cancelled = false
    // Guard against overlapping polls: if a job-state GET runs past the 1.5s
    // interval, the next tick must NOT fire a second request that could read
    // 'done' and apply the SAME elements twice (duplicate ids).
    let inFlight = false
    const finish = () => {
      setGenPending(false)
      setGenJobId(null)
      genStartedRef.current = null
    }
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const res = await fetch(`/api/canvas/ai/job/${encodeURIComponent(genJobId)}`)
        if (cancelled) return
        if (res.status === 404) {
          // Swept / unknown — stop watching (any result is already persisted).
          finish()
          return
        }
        if (!res.ok) return
        const job = (await res.json()) as CanvasAiJobState
        if (cancelled || job.status === 'running') return
        if (job.status === 'done') {
          if (job.elements && job.elements.length) applyGenerated(job.elements)
          setGenOpen(false)
          setGenPrompt('')
        } else {
          setGenError(t('canvas.generate.error'))
        }
        finish()
      } catch {
        // transient (server reloading) — keep polling
      } finally {
        inFlight = false
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [genJobId, applyGenerated, t])

  // Explicit cancel — kills the server-side job (the ONLY thing that does) and
  // closes the bar. Closing the bar without cancelling leaves any run going;
  // this is the one path that stops it.
  const cancelGenerate = useCallback(() => {
    // Mark cancelled so a start-POST still in flight kills the job it creates
    // (cancelGenerate may run before we hold a jobId).
    genCancelRef.current = true
    const jobId = genJobId
    if (jobId) {
      fetch(`/api/canvas/ai/job/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
      }).catch(() => {})
    }
    setGenJobId(null)
    genStartedRef.current = null
    setGenPending(false)
    setGenOpen(false)
    setGenPrompt('')
    setGenError(null)
    setGenLoggedOut(false)
  }, [genJobId])

  // Close the bar when idle (no running job to cancel) — just resets the UI.
  const closeGenerate = useCallback(() => {
    setGenPending(false)
    setGenOpen(false)
    setGenPrompt('')
    setGenError(null)
    setGenLoggedOut(false)
  }, [])

  // ── "Sign in to Claude" terminal (signed-out generate) ───────────────────
  // generate-elements answers 503 { claudeLoggedOut } when the CLI is installed
  // but signed out. Rather than dead-end on a generic error, the CTA opens the
  // SAME single login terminal the Board drawer uses (POST
  // /api/terminal/claude-login → a plain claude PTY that runs its OAuth once).
  // Kept self-contained here so the Canvas needs no new prop from its shell.
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginPty, setLoginPty] = useState<string | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)
  const loginInFlight = useRef(false)
  const openClaudeLogin = useCallback(async () => {
    setLoginOpen(true)
    // Single-flight + single instance: a second click re-focuses the open
    // terminal instead of spawning a twin.
    if (loginPty || loginInFlight.current) return
    loginInFlight.current = true
    setLoginError(null)
    try {
      const r = await fetch('/api/terminal/claude-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: projectPath }),
      })
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string }
        setLoginError(b.error || `HTTP ${r.status}`)
        return
      }
      const info = (await r.json().catch(() => ({}))) as { id?: string }
      if (info.id) setLoginPty(info.id)
      else setLoginError(`HTTP ${r.status}`)
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e))
    } finally {
      loginInFlight.current = false
    }
  }, [projectPath, loginPty])
  const closeClaudeLogin = useCallback(() => {
    setLoginOpen(false)
    setLoginPty((prev) => {
      // Sign-in persists to claude's own credential store, so killing the PTY
      // afterwards is safe. Best-effort.
      if (prev)
        fetch(`/api/terminal/${encodeURIComponent(prev)}`, { method: 'DELETE' }).catch(() => {})
      return null
    })
    setLoginError(null)
    // A completed sign-in clears the run gate — drop the CTA so the user can
    // just press Generate again.
    setGenLoggedOut(false)
  }, [])
  // Kill a still-open login PTY if the workspace unmounts (tab / canvas switch)
  // mid sign-in — it would otherwise linger waiting at its prompt.
  const loginPtyRef = useRef<string | null>(null)
  loginPtyRef.current = loginPty
  useEffect(
    () => () => {
      const id = loginPtyRef.current
      if (id)
        fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    },
    [],
  )

  const submitGenerate = useCallback(async () => {
    const prompt = genPrompt.trim()
    if (!prompt || genPending) return
    setGenPending(true)
    setGenError(null)
    setGenLoggedOut(false)
    genCancelRef.current = false
    // The elapsed counter starts now; the poll effect (keyed on genJobId) takes
    // over once the job id is in hand and corrects the baseline if needed.
    genStartedRef.current = Date.now()
    try {
      const body: GenerateCanvasAiRequest = {
        path: projectPath,
        canvasId: canvasRef.current.id,
        prompt,
      }
      // We do NOT hold this request for the whole run — it returns a jobId fast.
      // The run lives server-side and survives this component unmounting.
      const res = await fetch('/api/canvas/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as Partial<CanvasAiStartResponse> & {
        error?: string
        claudeMissing?: boolean
        claudeLoggedOut?: boolean
      }
      if (json.jobId && genCancelRef.current) {
        // The user cancelled while this POST was in flight — kill the job we
        // just created and bail (the bar is already closed by cancelGenerate).
        fetch(`/api/canvas/ai/job/${encodeURIComponent(json.jobId)}/cancel`, {
          method: 'POST',
        }).catch(() => {})
        return
      }
      if (!res.ok || !json.jobId) {
        // Installed-but-signed-out (503) gets the sign-in CTA instead of a
        // generic error; claudeMissing keeps its install guidance.
        if (json.claudeLoggedOut) {
          setGenLoggedOut(true)
        } else {
          setGenError(
            json.claudeMissing
              ? t('canvas.generate.claudeMissing')
              : json.error || t('canvas.generate.error'),
          )
        }
        setGenPending(false)
        genStartedRef.current = null
        return
      }
      // Hand off to the poll effect — it watches genJobId for progress + result
      // and inserts the elements (applyGenerated) when the job completes.
      setGenJobId(json.jobId)
    } catch {
      setGenError(t('canvas.generate.error'))
      setGenPending(false)
      genStartedRef.current = null
    }
  }, [genPrompt, genPending, projectPath, t])

  // Keyboard map: the workspace owns the ⌘-combos that touch ITS state —
  // undo/redo stacks and the in-canvas clipboards (elements AND style).
  // Everything surface-level (bare tool keys, zoom, ⌘A, Esc, lock/hide)
  // lives in InfiniteCanvas, the single owner for both surfaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return // another surface claimed it (Board ⌘Z…)
      const ae = document.activeElement
      const inField =
        !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
      if (!(e.metaKey || e.ctrlKey)) return
      if (inField) return
      // ⌥⌘C / ⌥⌘V — copy / paste STYLE only (Figma). Matched on e.code:
      // Option remaps e.key ('ç' / '√'). Copy reads the single selected
      // element; paste stamps every selected element through the type-aware
      // field filter in canvasStyleClipboard.
      if (e.altKey) {
        if (e.code === 'KeyC') {
          const els = canvasRef.current.elements
          const sel = selectedIds.length === 1 ? els.find((el) => el.id === selectedIds[0]) : null
          const style = sel ? pickStyle(sel) : null
          if (style) {
            e.preventDefault()
            styleClipRef.current = style
          }
        } else if (e.code === 'KeyV') {
          const style = styleClipRef.current
          if (!style || !selectedIds.length) return
          const selSet = new Set(selectedIds)
          const els = canvasRef.current.elements
          const next = els.map((el) =>
            selSet.has(el.id) && !el.locked ? applyStyle(el, style) : el,
          )
          if (next.some((el, i) => el !== els[i])) {
            e.preventDefault()
            mutateElements(next)
          }
        }
        return
      }
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (k === 'y') {
        e.preventDefault()
        redo()
      } else if (k === 'c') {
        copySelection()
      } else if (k === 'x') {
        cutSelection()
      } else if (k === 'v') {
        pasteClipboard()
      } else if (k === 'd') {
        e.preventDefault()
        duplicateSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [patch, undo, redo, copySelection, cutSelection, pasteClipboard, duplicateSelection, selectedIds, mutateElements])

  // A change made <idle window> ago hasn't been committed to the undo stack
  // yet, so also treat a live divergence from the baseline as undoable.
  const canUndo = undoRef.current.length > 0 || baselineRef.current !== canvas.elements
  const canRedo = redoRef.current.length > 0

  // The Selection Inspector shows for any non-empty selection (multi mode
  // edits the common fields, Figma-style) unless we're mid-text-edit (the
  // editor owns the surface then). Comments live in their own pin popover, so
  // they're excluded from the panel.
  const inspectorElements = editingId
    ? []
    : canvas.elements.filter(
        (e) => selectedIds.includes(e.id) && e.type !== 'comment',
      )
  const inspectorElement = inspectorElements.length === 1 ? inspectorElements[0] : null
  // Layout-child context for the inspector: Figma hides the free-align row for
  // a child managed by auto layout and offers Fixed/Fill sizing instead.
  const inspectorParentLayout = (() => {
    if (!inspectorElement?.parentId) return null
    const parent = canvas.elements.find((e) => e.id === inspectorElement.parentId)
    return parent?.type === 'frame' ? parent.layout ?? null : null
  })()

  // Count of selected ids that still exist as elements — the AlignBar gate uses
  // this (not raw selectedIds.length) so a stale selection left after a delete
  // doesn't strand the toolbar over an empty/changed canvas. (Mirrors how the
  // inspector tolerates a stale id via `.find`.)
  const liveSelectedCount = (() => {
    const ids = new Set(selectedIds)
    let n = 0
    for (const e of canvas.elements) if (ids.has(e.id)) n++
    return n
  })()
  // A single selected element that lives inside a frame can still align — to
  // its parent frame's box (see alignSelection's single-item mode), so the
  // AlignBar shows for it too. Locked elements can't move, so they don't gate
  // the bar open.
  const singleAlignsToFrame = (() => {
    if (liveSelectedCount !== 1) return false
    const el = canvas.elements.find((e) => e.id === selectedIds[0])
    if (!el || el.locked || !el.parentId) return false
    const parent = canvas.elements.find((e) => e.id === el.parentId)
    return parent?.type === 'frame'
  })()

  // Drive the shell's right dock open whenever there's a real (non-comment)
  // selection. This deliberately IGNORES editingId: entering/leaving the inline
  // text editor must not thrash the dock open/closed, since the selection
  // persists across an edit. Mid-edit the panel *content* still falls back to
  // the canvas summary (the portal below keys off inspectorElements), but the
  // dock itself stays put. A boolean gates the effect so it fires only on real
  // open/close transitions, not on every render.
  const hasInspectableSelection = canvas.elements.some(
    (e) => selectedIds.includes(e.id) && e.type !== 'comment',
  )
  useEffect(() => {
    onInspectorOpenChange?.(hasInspectableSelection)
  }, [hasInspectableSelection, onInspectorOpenChange])

  return (
    <CanvasAssetProvider value={{ projectPath, canvasId: canvas.id }}>
    <div className="flex h-full w-full overflow-hidden">
      <div ref={surfaceRef} className="relative min-w-0 flex-1 overflow-hidden">
        <InfiniteCanvas
          projects={[]}
          canvas={{
            positions: {},
            viewport: canvas.viewport,
            elements: canvas.elements,
          }}
          onCanvasChange={(c) => handleCanvasChange({ viewport: c.viewport, elements: c.elements })}
          projectPath={projectPath}
          canvasId={canvas.id}
          onImagePaste={handleImagePaste}
          frameVariant="design"
          selectedIds={selectedIds}
          onSelect={(id, additive) => {
            if (id == null) {
              setSelectedIds([])
              return
            }
            setSelectedIds((prev) =>
              additive
                ? prev.includes(id)
                  ? prev.filter((x) => x !== id)
                  : [...prev, id]
                : [id],
            )
          }}
          onSelectIds={setSelectedIds}
          editingId={editingId}
          onEditingIdChange={setEditingId}
          tool={tool}
          onToolChange={setTool}
          onDuplicate={duplicateSelection}
          historyDepth={historyDepth}
          onCancelRestore={cancelRestoreToDepth}
          adoptionEpoch={adoptionEpoch}
          onImplicitElementsChange={handleImplicitElementsChange}
          highlightedId={hoveredElementId}
          onHoverElement={setHoveredElementId}
          zoomApiRef={zoomApi}
        />
        {/* Zoom pill — top-right of the canvas column (Figma's zoom control).
            The % button fits all content; −/+ step like ⌘−/⌘+. */}
        <div className="absolute right-3 top-3 z-20 flex items-center rounded-[7px] border border-line bg-bg-card/90 p-0.5 shadow-card backdrop-blur">
          <button
            type="button"
            onClick={() => zoomApi.current?.zoomOut()}
            title={t('canvas.zoom.out')}
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <Minus size={12} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => zoomApi.current?.fitAll()}
            title={t('canvas.zoom.fit')}
            className="h-6 min-w-[44px] rounded-[4px] px-1 text-center text-[11px] tabular-nums text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {Math.round(canvas.viewport.zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => zoomApi.current?.zoomIn()}
            title={t('canvas.zoom.in')}
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <Plus size={12} strokeWidth={2} />
          </button>
        </div>
        <ToolPalette
          tool={tool}
          onToolChange={setTool}
          variant="embedded"
          onGenerate={() => {
            setGenOpen(true)
            setGenError(null)
            setGenLoggedOut(false)
          }}
        />
        {/* Generate prompt bar — floats bottom-centre while open, just above
            the ToolPalette pill. Esc / ✕ closes (held shut while a generation
            is in flight so the result isn't orphaned); Enter submits,
            IME-confirm Enters excluded. */}
        {genOpen && (
          <div className="absolute bottom-20 left-1/2 z-30 w-[min(520px,calc(100%-48px))] -translate-x-1/2">
            <div className="flex items-center gap-2 rounded-full border border-line bg-bg-card/95 py-1.5 pl-4 pr-1.5 shadow-card backdrop-blur transition-colors focus-within:border-accent">
              <Sparkles size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
              <input
                autoFocus
                value={genPrompt}
                onChange={(e) => setGenPrompt(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  // IME guard: don't steal the Enter that confirms a conversion.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void submitGenerate()
                  } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                    // Only reachable while idle (the input is disabled once a run
                    // is pending) — just closes the bar. Killing a running job is
                    // the Cancel button's job (closing alone never kills it now).
                    closeGenerate()
                  }
                }}
                disabled={genPending}
                placeholder={t('canvas.generate.placeholder')}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-faint focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
              {genPending ? (
                <>
                  {/* Live "working" status: spinner + label + elapsed seconds,
                      so a 30s–3min claude session never reads as "frozen". */}
                  <span
                    className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-muted"
                    aria-live="polite"
                  >
                    <Loader2 size={12} strokeWidth={2} className="animate-spin" />
                    <span>{t('canvas.generate.generating')}</span>
                    <span className="tabular-nums text-ink-faint" data-testid="canvas-gen-elapsed">
                      {genElapsed}
                      {t('canvas.generate.elapsedUnit')}
                    </span>
                  </span>
                  {/* A clearly-labelled cancel — the ONLY thing that kills the
                      run (navigating away no longer does). Never trap the user
                      in a mode they can't leave. */}
                  <button
                    type="button"
                    onClick={cancelGenerate}
                    className="h-7 shrink-0 rounded-full border border-line px-3 text-[11.5px] font-medium text-ink-muted transition-colors hover:border-ink-faint hover:bg-bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {t('canvas.generate.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void submitGenerate()}
                    disabled={!genPrompt.trim()}
                    className="h-7 shrink-0 rounded-full bg-accent px-3 text-[11.5px] font-medium text-bg-card transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent"
                  >
                    {t('canvas.generate.go')}
                  </button>
                  <button
                    type="button"
                    onClick={closeGenerate}
                    title={t('canvas.generate.close')}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <X size={13} strokeWidth={2} />
                  </button>
                </>
              )}
            </div>
            {genLoggedOut ? (
              <div className="mt-1.5 flex flex-col items-center gap-1.5 px-4 text-center">
                <p className="text-[11px] leading-relaxed text-ink-muted">
                  {t('canvas.generate.claudeLoggedOut')}
                </p>
                <button
                  type="button"
                  onClick={() => void openClaudeLogin()}
                  className="rounded-full border border-line px-3 py-1 text-[11.5px] font-medium text-ink-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  {t('canvas.generate.signIn')}
                </button>
              </div>
            ) : (
              genError && (
                <p className="mt-1.5 truncate px-4 text-center text-[11px] text-accent">
                  {genError}
                </p>
              )
            )}
          </div>
        )}
        {/* Layers tree — docked into the shell's left-sidebar slot, always
            mounted while the slot exists (⌘\ hides the whole sidebar). */}
        {layersHost &&
          createPortal(
            <div className="relative h-full">
              <LayersPanel
                elements={canvas.elements}
                selectedIds={selectedIds}
                onSelect={(id, additive) => {
                  // Clicking a GROUP row selects its members (the group element is
                  // invisible — selecting its bare id would show nothing on canvas
                  // and break copy). A member/leaf row selects just itself, so the
                  // panel can still target individual children.
                  const el = canvas.elements.find((e) => e.id === id)
                  const target =
                    el?.type === 'group' ? expandSelectionForElement(canvas.elements, id) : [id]
                  setSelectedIds((prev) =>
                    additive
                      ? Array.from(new Set([...prev, ...target]))
                      : target,
                  )
                }}
                onSelectIds={(ids) => {
                  // Range / toggle selections arrive as raw row ids — expand any
                  // group rows to their members, same contract as onSelect above.
                  const expanded = ids.flatMap((id) => {
                    const el = canvas.elements.find((e) => e.id === id)
                    return el?.type === 'group'
                      ? expandSelectionForElement(canvas.elements, id)
                      : [id]
                  })
                  setSelectedIds(Array.from(new Set(expanded)))
                }}
                onMove={moveElementOne}
                onToggleHidden={toggleElementHidden}
                onToggleLocked={toggleElementLocked}
                onRename={renameElement}
                onReorder={reorderElement}
                onHoverElement={setHoveredElementId}
                hoveredElementId={hoveredElementId}
              />
            </div>,
            layersHost,
          )}
        {/* Right sidebar — the inspector for any selection (single or multi),
            else a mini canvas summary so the panel never blanks out (Figma's
            Design panel is permanent too). The align row lives at the top of
            the inspector (the old floating AlignBar is absorbed). */}
        {inspectorHost &&
          createPortal(
            inspectorElements.length > 0 ? (
              <div className="relative h-full">
                <SelectionInspector
                  // Re-mount per selection so uncontrolled-feel inputs reset
                  // cleanly when it jumps between elements / selection sets.
                  key={
                    inspectorElement
                      ? inspectorElement.id
                      : `multi:${inspectorElements.map((e) => e.id).join(',')}`
                  }
                  element={inspectorElement ?? inspectorElements[0]}
                  elements={
                    inspectorElements.length > 1 ? inspectorElements : undefined
                  }
                  onPatch={(changes) =>
                    patchElement((inspectorElement ?? inspectorElements[0]).id, changes)
                  }
                  onPatchMany={(ids, changes) => {
                    // One mutateElements call = one undo step for the bulk
                    // edit. Each id gets the same hug→fixed treatment as the
                    // single-element path so W/H edits stick on hug frames.
                    let next = canvasRef.current.elements
                    for (const pid of ids)
                      next = applyElementPatch(next, pid, withHugReleased(next, pid, changes))
                    if (next !== canvasRef.current.elements) mutateElements(next)
                  }}
                  onAlign={alignSelection}
                  alignEnabled={liveSelectedCount >= 2 || singleAlignsToFrame}
                  isLayoutChild={!!inspectorParentLayout}
                  parentLayout={inspectorParentLayout}
                  onAddAutoLayout={() => {
                    // Same path as ⇧A so the direction heuristic applies.
                    const res = addAutoLayout(
                      canvasRef.current.elements,
                      selectedIds,
                      () => crypto.randomUUID(),
                    )
                    if (!res) return
                    mutateElements(res.elements)
                    setSelectedIds([res.selectId])
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1 px-3 py-2.5">
                <div className="truncate text-[12px] text-ink-muted">{canvas.name}</div>
                <div className="text-[11px] text-ink-faint">
                  {t('canvas.side.elementCount', { count: canvas.elements.length })}
                </div>
              </div>
            ),
            inspectorHost,
          )}
        {/* Undo / redo — keeps the ⌘Z history discoverable for mouse users. */}
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-0.5 rounded-[7px] border border-line bg-bg-card/90 p-1 shadow-card backdrop-blur">
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            title={t('canvas.undo')}
            className="flex h-7 w-7 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Undo2 size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            title={t('canvas.redo')}
            className="flex h-7 w-7 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Redo2 size={14} strokeWidth={2} />
          </button>
        </div>
        {/* "Sign in to Claude" terminal — opened from the signed-out CTA above.
            Portaled to <body> so the canvas's transformed / overflow-hidden
            ancestors can't clip or mis-position the fixed overlay. Mirrors the
            Board drawer's login terminal (same /api/terminal/claude-login PTY +
            ClaudeTerminalPane). */}
        {loginOpen &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
              role="dialog"
              aria-modal="true"
              aria-label={t('projectPanel.claudeLogin.title')}
            >
              <div className="flex h-[70vh] max-h-[640px] w-full max-w-[780px] flex-col overflow-hidden rounded-lg border border-line bg-bg-card shadow-2xl">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-ink">
                      {t('projectPanel.claudeLogin.title')}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                      {t('projectPanel.claudeLogin.hint')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closeClaudeLogin}
                    aria-label={t('common.close')}
                    className="shrink-0 rounded-sm p-1 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col bg-bg">
                  {loginPty ? (
                    <ClaudeTerminalPane
                      terminalId={loginPty}
                      chrome={false}
                      onExit={closeClaudeLogin}
                    />
                  ) : (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                      {loginError ? (
                        <>
                          <p className="max-w-[90%] text-[12px] leading-relaxed text-accent">
                            {loginError}
                          </p>
                          <button
                            type="button"
                            onClick={() => void openClaudeLogin()}
                            className="rounded-sm border border-line px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-accent hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            {t('projectPanel.claudeLogin.retry')}
                          </button>
                        </>
                      ) : (
                        <p className="text-[12px] text-ink-faint">
                          {t('projectPanel.claudeLogin.starting')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )}
      </div>
    </div>
    </CanvasAssetProvider>
  )
}
