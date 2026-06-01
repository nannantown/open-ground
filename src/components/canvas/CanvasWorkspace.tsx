import { useCallback, useEffect, useRef, useState } from 'react'
import { Layers, Redo2, Undo2 } from 'lucide-react'
import { InfiniteCanvas } from './InfiniteCanvas'
import { ToolPalette } from './ToolPalette'
import { CanvasChatSidebar } from './CanvasChatSidebar'
import { SelectionInspector } from './SelectionInspector'
import { LayersPanel } from './LayersPanel'
import { newId } from '@/lib/ids'
import { removeElements } from '@/lib/canvasIntegrity'
import { applyElementPatch } from '@/lib/canvasTextStyle'
import type {
  CanvasElement,
  CanvasFile,
  ProjectTask,
  RunSession,
  Tool,
} from '@/lib/types'
import type { RunTaskOpts } from '@/lib/useRuns'

interface Props {
  projectPath: string
  canvas: CanvasFile
  /** Persist any change to this Canvas. Debounced upstream by ProjectCanvas
   *  so a pan/zoom storm doesn't write on every frame. */
  onChange: (next: CanvasFile) => void
  taskRuns: Map<string, RunSession>
  allTaskRuns: Map<string, RunSession[]>
  onRunTask: (task: ProjectTask, opts?: RunTaskOpts) => void
  onCancelTask: (taskId: string) => void
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
  taskRuns,
  allTaskRuns,
  onRunTask,
  onCancelTask,
}: Props) => {
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

  // Keep the history baseline aligned after a non-undoable element mutation
  // (e.g. linking a comment to its chat). Callers flushHistory() BEFORE their
  // mutating patch so any pending user edit is committed first; this then
  // adopts the post-mutation array as the baseline so the link itself isn't
  // attributed to a later edit.
  const syncHistoryBaseline = useCallback(() => {
    baselineRef.current = canvasRef.current.elements
    lastLocalElementsRef.current = canvasRef.current.elements
  }, [])

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

  // Build a chat-ready prompt out of a Canvas comment. The pin's text goes
  // first as the user-authored brief; if the comment is anchored to another
  // element (a mock especially), append a contextual footer so Claude knows
  // *which* element the feedback is about — and for mocks include the live
  // source code so the run has everything it needs in one message.
  const buildCommentPrompt = useCallback(
    (comment: CanvasElement): string => {
      const body = comment.text.trim()
      const anchor = comment.anchorId
        ? canvasRef.current.elements.find((e) => e.id === comment.anchorId)
        : null
      const lines: string[] = [body]
      if (anchor) {
        lines.push('')
        if (anchor.type === 'mock') {
          const label =
            anchor.name || (anchor.framework === 'html' ? 'HTML mock' : 'React mock')
          const lang = anchor.framework === 'html' ? 'html' : 'jsx'
          lines.push(
            `（Canvas のモック「${label}」へのコメントです。下記のソースを参照して修正してください。）`,
          )
          lines.push('```' + lang)
          lines.push(anchor.text)
          lines.push('```')
        } else if (anchor.type === 'frame') {
          const label = anchor.text.trim() || 'Frame'
          lines.push(`（Canvas のフレーム「${label}」周りへのコメントです。）`)
        } else if (anchor.type === 'sticky') {
          const head = anchor.text.trim().split('\n')[0]?.slice(0, 60) ?? ''
          lines.push(
            head
              ? `（Canvas のスティッキー「${head}」へのコメントです。）`
              : `（Canvas のスティッキーへのコメントです。）`,
          )
        } else if (anchor.type === 'text') {
          const head = anchor.text.trim().slice(0, 60)
          lines.push(
            head
              ? `（Canvas のテキスト「${head}」へのコメントです。）`
              : `（Canvas のテキストへのコメントです。）`,
          )
        }
      }
      return lines.join('\n')
    },
    [],
  )

  // Fire a comment pin as a brand-new Canvas chat. Opens the sidebar (so the
  // user actually sees the run starting), creates a fresh chat thread whose
  // title is the comment-derived prompt, then kicks the runner. Behaves the
  // same as the sidebar's createChat path so SSE / status tracking just work.
  const runComment = useCallback(
    (comment: CanvasElement) => {
      const prompt = buildCommentPrompt(comment).trim()
      if (!prompt) return
      const task: ProjectTask = {
        id: newId(),
        title: prompt,
        done: false,
        milestoneId: null,
        createdAt: new Date().toISOString(),
      }
      const current = canvasRef.current
      // Commit any pending user edit as its own undo step before the (non-
      // undoable) chat-link write, so a drag done just before Run isn't lost.
      flushHistory()
      // Link the pin to the chat it just spawned (don't auto-resolve — Run
      // asks Claude, Resolve is the user's call after reading the reply). The
      // pin reads this chatId back to show live status + the latest reply.
      patch({
        sidebarOpen: true,
        chats: [task, ...current.chats],
        activeChatId: task.id,
        elements: current.elements.map((el) =>
          el.id === comment.id ? { ...el, chatId: task.id, resolved: false } : el,
        ),
      })
      syncHistoryBaseline()
      // Carry the canvas context so the run prompt documents the CANVAS_ADD /
      // CANVAS_UPDATE marker protocol and the observer routes any markers back
      // — without it an anchored comment could never patch its element.
      onRunTask(task, { canvasContext: { canvasId: current.id } })
    },
    [buildCommentPrompt, flushHistory, onRunTask, patch, syncHistoryBaseline],
  )

  // Reconcile comment→chat links whenever the chat list changes: if a chat a
  // comment pointed at was deleted, drop the dangling chatId so the pin stops
  // claiming a thread that no longer exists.
  const handleChatsChange = useCallback(
    (chats: ProjectTask[]) => {
      const ids = new Set(chats.map((c) => c.id))
      const els = canvasRef.current.elements
      const needsReconcile = els.some(
        (el) => el.type === 'comment' && el.chatId && !ids.has(el.chatId),
      )
      if (!needsReconcile) {
        patch({ chats })
        return
      }
      // Commit any pending user edit before the (non-undoable) chatId cleanup.
      flushHistory()
      patch({
        chats,
        elements: els.map((el) => {
          if (el.type === 'comment' && el.chatId && !ids.has(el.chatId)) {
            const { chatId: _drop, ...rest } = el
            return rest
          }
          return el
        }),
      })
      syncHistoryBaseline()
    },
    [flushHistory, patch, syncHistoryBaseline],
  )

  // Live run status + latest reply for a comment's linked chat, derived from
  // the shared taskRuns map (keyed by chat/task id). null when the comment has
  // no linked chat yet or its run hasn't surfaced.
  const commentRunInfo = useCallback(
    (chatId: string): { status: RunSession['entries'][number]['status']; summary: string } | null => {
      const session = taskRuns.get(chatId) ?? allTaskRuns.get(chatId)?.[0]
      const entry = session?.entries[0]
      if (!entry) return null
      return { status: entry.status, summary: entry.parsedResult?.summary ?? '' }
    },
    [taskRuns, allTaskRuns],
  )

  const openCommentThread = useCallback(
    (chatId: string) => {
      patch({ sidebarOpen: true, activeChatId: chatId })
    },
    [patch],
  )

  // ── Copy / paste / duplicate of canvas elements ──────────────────────────
  // In-canvas clipboard, kept in a ref so it survives re-renders. Independent
  // of the OS clipboard (which the image-paste path owns).
  const clipboardRef = useRef<CanvasElement[]>([])

  const copySelection = useCallback(() => {
    const ids = new Set(selectedIds)
    const picked = canvasRef.current.elements.filter((el) => ids.has(el.id))
    if (picked.length) clipboardRef.current = picked.map((el) => ({ ...el }))
  }, [selectedIds])

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current
    if (!clip.length) return
    const copies = cloneForPaste(clip, 24, 24)
    mutateElements([...canvasRef.current.elements, ...copies])
    setSelectedIds(copies.map((c) => c.id))
    setEditingId(null)
  }, [mutateElements])

  // Cut = copy the selection into the in-memory clipboard (so a later ⌘V pastes
  // it), then delete it through removeElements — the SAME path Delete uses — so
  // the cut can't leave a dangling comment anchor or frame/design parentId.
  const cutSelection = useCallback(() => {
    const ids = new Set(selectedIds)
    const picked = canvasRef.current.elements.filter((el) => ids.has(el.id))
    if (!picked.length) return
    clipboardRef.current = picked.map((el) => ({ ...el }))
    const next = removeElements(canvasRef.current.elements, ids)
    if (next !== canvasRef.current.elements) mutateElements(next)
    setSelectedIds([])
    setEditingId(null)
  }, [selectedIds, mutateElements])

  const duplicateSelection = useCallback(() => {
    const ids = new Set(selectedIds)
    const picked = canvasRef.current.elements.filter((el) => ids.has(el.id))
    if (!picked.length) return
    const copies = cloneForPaste(picked, 24, 24)
    mutateElements([...canvasRef.current.elements, ...copies])
    setSelectedIds(copies.map((c) => c.id))
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

  // Drop a chat message onto the Canvas as a sticky. Place it in the
  // top-left of the currently visible region (offset by a small random nudge
  // so successive pastes don't stack pixel-perfect) — the user can drag it
  // wherever they want after.
  const pasteToCanvas = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const current = canvasRef.current
      const zoom = current.viewport.zoom || 1
      const baseX = -current.viewport.x / zoom + 40
      const baseY = -current.viewport.y / zoom + 60
      const jitterX = Math.random() * 40
      const jitterY = Math.random() * 40
      const sticky: CanvasElement = {
        id:
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `sticky-${Date.now()}`,
        type: 'sticky',
        x: Math.round(baseX + jitterX),
        y: Math.round(baseY + jitterY),
        width: 208,
        height: 208,
        text: trimmed,
      }
      mutateElements([...current.elements, sticky])
    },
    [mutateElements],
  )

  // Keyboard map. ⌘-combos (undo/redo/copy/cut/paste/duplicate/sidebar) are
  // gated when a text field has focus so native editing + the chat composer keep
  // working; the bare tool keys (V/T/S/F/G/O/C/I) are likewise field-gated.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement
      const inField =
        !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
      if (e.metaKey || e.ctrlKey) {
        if (inField || e.altKey) return
        const k = e.key.toLowerCase()
        if (k === '/') {
          e.preventDefault()
          patch({ sidebarOpen: !canvasRef.current.sidebarOpen })
        } else if (k === 'z') {
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

  const sidebarWidth = canvas.sidebarWidth ?? CanvasChatSidebar.DEFAULT_WIDTH
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

  return (
    <div className="flex h-full w-full overflow-hidden">
      <CanvasChatSidebar
        projectPath={projectPath}
        canvasId={canvas.id}
        chats={canvas.chats}
        activeChatId={canvas.activeChatId}
        open={canvas.sidebarOpen}
        width={sidebarWidth}
        onOpenChange={(open) => patch({ sidebarOpen: open })}
        onWidthChange={(w) => patch({ sidebarWidth: w })}
        onChatsChange={handleChatsChange}
        onActiveChatChange={(id) => patch({ activeChatId: id })}
        taskRuns={taskRuns}
        allTaskRuns={allTaskRuns}
        onRunTask={onRunTask}
        onCancelTask={onCancelTask}
        onPasteToCanvas={pasteToCanvas}
      />
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
          onRunComment={runComment}
          commentRunInfo={commentRunInfo}
          onOpenCommentThread={openCommentThread}
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
          title={showLayers ? 'レイヤーを隠す' : 'レイヤーを表示'}
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
            onSelect={(id, additive) =>
              setSelectedIds((prev) =>
                additive
                  ? prev.includes(id)
                    ? prev.filter((x) => x !== id)
                    : [...prev, id]
                  : [id],
              )
            }
            onMove={moveElementOne}
            onToggleHidden={toggleElementHidden}
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
        {/* Undo / redo — keeps the ⌘Z history discoverable for mouse users. */}
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-0.5 rounded-[7px] border border-line bg-bg-card/90 p-1 shadow-card backdrop-blur">
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            title="元に戻す (⌘Z)"
            className="flex h-7 w-7 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Undo2 size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            title="やり直す (⌘⇧Z)"
            className="flex h-7 w-7 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Redo2 size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}
