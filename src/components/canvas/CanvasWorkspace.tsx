import { useCallback, useEffect, useRef, useState } from 'react'
import { Layers, Redo2, Undo2 } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { InfiniteCanvas } from './InfiniteCanvas'
import { ToolPalette } from './ToolPalette'
import { SelectionInspector } from './SelectionInspector'
import { LayersPanel } from './LayersPanel'
import { AlignBar } from './AlignBar'
import { newId } from '@/lib/ids'
import { removeElements } from '@/lib/canvasIntegrity'
import {
  withGroupAncestors,
  expandSelectionForElement,
  groupCascadeSets,
} from '@/lib/canvasGroup'
import { applyElementPatch } from '@/lib/canvasTextStyle'
import { reorderLayer } from '@/lib/canvasLayerTree'
import { alignElements, type AlignOp } from '@/lib/canvasAlign'
import { elementBounds } from '@/lib/canvasBounds'
import type {
  CanvasElement,
  CanvasFile,
  Tool,
} from '@/lib/types'

interface Props {
  projectPath: string
  canvas: CanvasFile
  /** Persist any change to this Canvas. Debounced upstream by ProjectCanvas
   *  so a pan/zoom storm doesn't write on every frame. */
  onChange: (next: CanvasFile) => void
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
}: Props) => {
  const { t } = useT()
  const [tool, setTool] = useState<Tool>('select')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showLayers, setShowLayers] = useState(false)
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

  // The single entry point for undoable element changes.
  const mutateElements = useCallback(
    (next: CanvasElement[]) => {
      patch({ elements: next })
      recordElementsChange()
    },
    [patch, recordElementsChange],
  )

  // Selection Inspector: apply a partial patch to one element by id, routed
  // through mutateElements so the edit undoes/redoes and persists exactly like
  // a drag or a retype. No-op patches (no matching id) skip the write.
  const patchElement = useCallback(
    (id: string, changes: Partial<CanvasElement>) => {
      const next = applyElementPatch(canvasRef.current.elements, id, changes)
      if (next !== canvasRef.current.elements) mutateElements(next)
    },
    [mutateElements],
  )

  // Align / distribute the current multi-selection (Figma-parity). Locked
  // elements (directly or via a locked group) and groups (no box of their own)
  // are excluded; align needs ≥2 participants, distribute ≥3. One undoable step.
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
      const moves = alignElements(items, op)
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

  // ── Copy / paste / duplicate of canvas elements ──────────────────────────
  // In-canvas clipboard, kept in a ref so it survives re-renders. Independent
  // of the OS clipboard (which the image-paste path owns).
  const clipboardRef = useRef<CanvasElement[]>([])

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
    mutateElements([...canvasRef.current.elements, ...copies])
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
  // Move ONE element a single step in z-order. Array order IS z-order (front =
  // end), so "up" (toward front) swaps with the next element and "down" swaps
  // with the previous. Routed through mutateElements so it undoes / persists
  // like every other element change. No-op at the array edge.
  const moveElementOne = useCallback(
    (id: string, dir: 'up' | 'down') => {
      const els = canvasRef.current.elements
      const idx = els.findIndex((el) => el.id === id)
      if (idx < 0) return
      const swapWith = dir === 'up' ? idx + 1 : idx - 1
      if (swapWith < 0 || swapWith >= els.length) return
      const next = els.slice()
      ;[next[idx], next[swapWith]] = [next[swapWith], next[idx]]
      mutateElements(next)
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
  // subtree to land next to the target in z-order, adopting the target's nesting
  // level — see reorderLayer. Routed through mutateElements so it undoes/persists.
  const reorderElement = useCallback(
    (dragId: string, targetId: string, place: 'above' | 'below') => {
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

      const form = new FormData()
      form.append('file', file)
      let res: Response
      try {
        res = await fetch(
          `/api/canvas/asset?path=${encodeURIComponent(projectPath)}` +
            `&canvasId=${encodeURIComponent(canvas.id)}`,
          { method: 'POST', body: form },
        )
      } catch {
        return
      }
      if (!res.ok) return
      const { assetId, filename } = (await res.json()) as {
        assetId: string
        filename: string
      }
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
      mutateElements([...canvasRef.current.elements, el])
    },
    [projectPath, canvas.id, mutateElements],
  )

  // Keyboard map. ⌘-combos (undo/redo/copy/cut/paste/duplicate) are gated when a
  // text field has focus so native editing keeps working; the bare tool keys
  // (V/T/S/F/G/O/C/I) are likewise field-gated.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement
      const inField =
        !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
      if (e.metaKey || e.ctrlKey) {
        if (inField || e.altKey) return
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
        return
      }
      if (e.altKey || inField) return
      const k = e.key.toLowerCase()
      if (k === 'v') setTool('select')
      else if (k === 't') setTool('text')
      else if (k === 's') setTool('sticky')
      else if (k === 'f') setTool('frame')
      else if (k === 'g') setTool('rect')
      else if (k === 'o') setTool('ellipse')
      else if (k === 'c') setTool('comment')
      else if (k === 'i') setTool('image')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [patch, undo, redo, copySelection, cutSelection, pasteClipboard, duplicateSelection])

  // A change made <idle window> ago hasn't been committed to the undo stack
  // yet, so also treat a live divergence from the baseline as undoable.
  const canUndo = undoRef.current.length > 0 || baselineRef.current !== canvas.elements
  const canRedo = redoRef.current.length > 0

  // The Selection Inspector shows only when exactly one element is selected and
  // we're not mid-text-edit (the editor owns the surface then). Comments live in
  // their own pin popover, so they're excluded from the panel.
  const selectedElement =
    selectedIds.length === 1 && !editingId
      ? canvas.elements.find((e) => e.id === selectedIds[0]) ?? null
      : null
  const inspectorElement =
    selectedElement && selectedElement.type !== 'comment' ? selectedElement : null

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

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="relative min-w-0 flex-1 overflow-hidden">
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
        />
        <ToolPalette tool={tool} onToolChange={setTool} variant="embedded" />
        {/* Layers launcher — top-left, clear of the centre-left ToolPalette and
            the top-right SelectionInspector. Toggles the panel; reflects open
            state so it reads as a pressed control while the list is showing. */}
        <button
          type="button"
          onClick={() => setShowLayers((v) => !v)}
          aria-pressed={showLayers}
          title={showLayers ? t('canvas.hideLayers') : t('canvas.showLayers')}
          className={[
            'absolute left-3 top-3 z-30 flex h-8 w-8 items-center justify-center rounded-[6px] border shadow-card backdrop-blur transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            showLayers
              ? 'border-accent bg-accent text-bg-card hover:bg-accent/90'
              : 'border-line bg-bg-card/90 text-ink-muted hover:bg-bg-inset hover:text-ink',
          ].join(' ')}
        >
          <Layers size={15} strokeWidth={1.75} />
        </button>
        {showLayers && (
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
            onMove={moveElementOne}
            onToggleHidden={toggleElementHidden}
            onToggleLocked={toggleElementLocked}
            onRename={renameElement}
            onReorder={reorderElement}
            onClose={() => setShowLayers(false)}
          />
        )}
        {inspectorElement && (
          <SelectionInspector
            // Re-mount per element so uncontrolled-feel inputs reset cleanly
            // when the selection jumps from one element to another.
            key={inspectorElement.id}
            element={inspectorElement}
            onPatch={(changes) => patchElement(inspectorElement.id, changes)}
          />
        )}
        {/* Align / distribute toolbar — only with a live multi-selection. */}
        {liveSelectedCount >= 2 && (
          <AlignBar count={liveSelectedCount} onAlign={alignSelection} />
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
      </div>
    </div>
  )
}
