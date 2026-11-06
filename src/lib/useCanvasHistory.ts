import { useCallback, useEffect, useRef } from 'react'
import type { CanvasState } from './types'

interface Snapshot {
  positions: CanvasState['positions']
  elements: CanvasState['elements']
  automation?: Omit<NonNullable<CanvasState['automation']>, 'revision'>
}

const HISTORY_LIMIT = 80
const COMMIT_DELAY = 450

const snap = (c: CanvasState): Snapshot => ({
  positions: c.positions,
  elements: c.elements,
  ...(c.automation ? { automation: { version: c.automation.version, enabled: c.automation.enabled, frameId: c.automation.frameId } } : {}),
})

// Position/element references identify drawing edits. Policy configuration
// travels with its frame; server revision acknowledgements are not user edits.
const same = (a: Snapshot, b: Snapshot) =>
  a.positions === b.positions && a.elements === b.elements &&
  a.automation?.version === b.automation?.version &&
  a.automation?.enabled === b.automation?.enabled &&
  a.automation?.frameId === b.automation?.frameId

// Undo/redo for the canvas document — card positions and free-form elements;
// the viewport is deliberately excluded. A burst of edits (a drag, a resize)
// collapses into a single step via a short debounce.
export function useCanvasHistory(
  canvas: CanvasState | null,
  applyCanvas: (c: CanvasState) => void,
) {
  const past = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])
  const committed = useRef<Snapshot | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canvasRef = useRef(canvas)
  canvasRef.current = canvas

  // Seed the baseline from the first loaded canvas.
  useEffect(() => {
    if (canvas && !committed.current) committed.current = snap(canvas)
  }, [canvas])

  // Once edits settle, fold them into one history step.
  useEffect(() => {
    if (!canvas) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const base = committed.current
      if (!base || !canvasRef.current) return
      const cur = snap(canvasRef.current)
      if (!same(cur, base)) {
        past.current.push(base)
        if (past.current.length > HISTORY_LIMIT) past.current.shift()
        committed.current = cur
        future.current = []
      }
    }, COMMIT_DELAY)
  }, [canvas])

  const applySnapshot = useCallback(
    (s: Snapshot) => {
      const c = canvasRef.current
      if (!c) return
      const next: CanvasState = { ...c, positions: s.positions, elements: s.elements }
      // Undo owns configuration, never the server's current CAS revision.
      // Returning to a pre-opt-in snapshot pauses all automatic admission;
      // it must not silently restore legacy operation after deleting the frame.
      if (s.automation) next.automation = { ...s.automation, revision: c.automation?.revision ?? 0 }
      else if (c.automation) next.automation = { version: 1, enabled: true, frameId: null, revision: c.automation.revision }
      else delete next.automation
      canvasRef.current = next // keep fresh for back-to-back undo/redo
      committed.current = snap(next)
      applyCanvas(next)
    },
    [applyCanvas],
  )

  // Fold any not-yet-debounced edit into its own step before navigating.
  const flush = () => {
    const base = committed.current
    if (!base || !canvasRef.current) return
    const cur = snap(canvasRef.current)
    if (!same(cur, base)) {
      past.current.push(base)
      if (past.current.length > HISTORY_LIMIT) past.current.shift()
      committed.current = cur
      future.current = []
    }
  }

  const undo = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    flush()
    if (!past.current.length || !committed.current) return
    future.current.push(committed.current)
    applySnapshot(past.current.pop()!)
  }, [applySnapshot])

  const redo = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    flush()
    if (!future.current.length || !committed.current) return
    past.current.push(committed.current)
    applySnapshot(future.current.pop()!)
  }, [applySnapshot])

  return { undo, redo }
}
