import { useEffect, useState, type RefObject } from 'react'
import { useT } from '@/i18n/I18nContext'

// Ground card box (InfiniteCanvas CARD_W × CARD_H) — the ghost is drawn at the
// card's real on-screen size so what you see is where it lands.
export const GHOST_W = 256
export const GHOST_H = 140

interface Props {
  name: string
  zoom: number
  /** Wrapper around the Ground InfiniteCanvas — only presses inside it place. */
  groundRef: RefObject<HTMLElement | null>
  onPlace: (clientX: number, clientY: number) => void
  onCancel: () => void
}

// Click-to-place for a freshly created / imported project: a translucent card
// rides the cursor until a primary press on the Ground drops it there; Esc
// backs out (the caller then auto-places it). Listeners sit on window in the
// CAPTURE phase so the press never reaches the canvas (no marquee / card
// select) while wheel pan/zoom and toolbar clicks pass through untouched.
export function PlacementGhost({ name, zoom, groundRef, onPlace, onCancel }: Props) {
  const { t } = useT()
  const [pt, setPt] = useState(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))

  useEffect(() => {
    // Space held = the canvas's Space+drag pan (InfiniteCanvas spaceDown):
    // let that press through untouched so the user can pan mid-placement.
    // Observed only — the canvas keeps its own Space tracking.
    let space = false
    const inGround = (e: Event) => {
      const g = groundRef.current
      return !!g && e.target instanceof Node && g.contains(e.target)
    }
    const onMove = (e: PointerEvent) => setPt({ x: e.clientX, y: e.clientY })
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || space || !inGround(e)) return
      e.preventDefault()
      e.stopPropagation()
      onPlace(e.clientX, e.clientY)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') space = true
      if (e.key !== 'Escape' || e.isComposing) return
      // Leave Esc to a field being typed in, or to an overlay (dialog / ⌘K
      // palette — the shared [data-esc-overlay] contract) opened mid-placement.
      const el = e.target instanceof HTMLElement ? e.target : null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (document.querySelector('[data-esc-overlay]')) return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') space = false
    }
    const onBlur = () => {
      space = false
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [groundRef, onPlace, onCancel])

  const w = GHOST_W * zoom
  const h = GHOST_H * zoom
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed z-40 flex items-start overflow-hidden rounded-xl border-2 border-accent bg-bg-card p-3 opacity-60 shadow-card-active"
        style={{ left: pt.x - w / 2, top: pt.y - h / 2, width: w, height: h }}
      >
        <span className="truncate text-sm font-semibold text-ink">{name}</span>
      </div>
      <div
        role="status"
        className="pointer-events-none fixed bottom-8 left-1/2 z-40 -translate-x-1/2 rounded-full border border-line bg-bg-card/95 px-4 py-2 text-meta font-medium text-ink shadow-card backdrop-blur"
      >
        {t('misc.ground.placeHint', { name })}
      </div>
    </>
  )
}
