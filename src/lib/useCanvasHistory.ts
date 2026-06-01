import { useCallback, useEffect, useRef } from 'react'
import type { CanvasState } from './types'

interface Snapshot {
  positions: CanvasState['positions']
  elements: CanvasState['elements']
}

const HISTORY_LIMIT = 80
const COMMIT_DELAY = 450

const snap = (c: CanvasState): Snapshot => ({
  positions: c.positions,
  elements: c.elements,
})

// Reference equality is enough: every real edit replaces the positions or the
// elements object, while a pan/zoom keeps both. So pan/zoom never produces a
// history step — undoing a scroll would just be annoying.
const same = (a: Snapshot, b: Snapshot) =>
  a.positions === b.positions && a.elements === b.elements

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
      canvasRef.current = next // keep fresh for back-to-back undo/redo
      committed.current = s
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
