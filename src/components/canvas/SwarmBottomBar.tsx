// SwarmBottomBar — the Swarm surface as ONE strip along the bottom of every
// project tab (owner decision 2026-09-24). It replaced two things at once: the
// Swarm tab (switching Board ⇄ Swarm back and forth was the complaint) and the
// Board's president drawer (BoardSupplyDock — the president's seat now exists
// in exactly one place: the seats row inside this bar).
//
// - Folded by default: a single header row — the team's name ("Agent Team" /
//   エージェントチーム on screen), questions waiting on the owner and cards
//   awaiting integration (only when there are some), and the on/off switch.
//   Clicking anywhere on that row opens / folds the bar (SwarmModule).
//   Folded mounts no seat, so it opens no EventSource.
// - Open: grows UPWARD to a saved height and shows the seats (president ·
//   manager · workers). The whole header row is the drag handle (owner
//   2026-09-26): drag it up / down to resize (a folded row dragged up opens,
//   an open bar dragged low folds), press it without moving to open / fold.
//   The height is saved per project and restored next time. Open/closed is
//   saved per project too
//   (owner decision 2026-09-25): leave a project with the bar open and it is
//   open when you come back, even after a restart. A project never opened
//   before starts folded. Opening on entry cannot freeze the window: the seats
//   only get what the page's streams leave (streamBudget.ts, pinned in
//   SwarmModule.streamBudget.test.tsx).

import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from 'react'
import type { ProjectMeta } from '@/lib/types'
import { useGroundLook } from '@/lib/useGroundLook'
import { SwarmModule } from '@/components/canvas/modules/SwarmModule'
import { StreamOwnerContext } from '@/lib/streamBudget'

export const SWARM_BAR_DEFAULT_H = 360
export const SWARM_BAR_MIN_H = 180
/** Space always left for the tab above the open bar (px). */
const TOP_RESERVE = 120
const KEY_STEP = 24
/** A press that moves less than this is a click (open / fold), not a drag (px). */
export const SWARM_BAR_DRAG_SLOP = 4
/** A drag released below this height folds the bar. */
const FOLD_BELOW = SWARM_BAR_MIN_H / 2
/** Presses on these stay theirs — no open / fold, no drag. The bar's own named
 *  toggle button IS part of the handle. */
const NOT_A_HANDLE =
  'button:not([data-testid="swarm-bar-toggle"]), a, input, select, textarea, [role="switch"], [role="menu"]'

/** The handlers that make SwarmModule's header row the bar's handle. */
export type SwarmBarHandle = Pick<
  HTMLAttributes<HTMLElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture' | 'onKeyDown'
>

export const swarmBarKey = (projectId: string) => `openground.swarmbar.${projectId}`

type SavedBar = { h?: unknown; open?: unknown }

const readSaved = (projectId: string): SavedBar => {
  try {
    const raw = JSON.parse(localStorage.getItem(swarmBarKey(projectId)) ?? 'null') as SavedBar | null
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export const loadSwarmBarHeight = (projectId: string): number => {
  const h = readSaved(projectId).h
  return typeof h === 'number' && Number.isFinite(h) ? Math.max(SWARM_BAR_MIN_H, Math.round(h)) : SWARM_BAR_DEFAULT_H
}

export const loadSwarmBarOpen = (projectId: string): boolean => readSaved(projectId).open === true

const save = (projectId: string, patch: { h?: number; open?: boolean }) => {
  try {
    localStorage.setItem(swarmBarKey(projectId), JSON.stringify({ ...readSaved(projectId), ...patch }))
  } catch {
    /* storage full / disabled — the bar just won't be remembered */
  }
}

export const SwarmBottomBar = ({ project }: { project: ProjectMeta }) => {
  const [open, setOpen] = useState(() => loadSwarmBarOpen(project.id))
  const [height, setHeight] = useState(() => loadSwarmBarHeight(project.id))
  const rootRef = useRef<HTMLDivElement>(null)
  // Height of the column the bar lives in (0 = not measured). The SHOWN
  // height is the saved one fitted into it, so a window that shrank since
  // the height was saved never pushes the tab above out of view.
  const [parentH, setParentH] = useState(0)
  useEffect(() => {
    const parent = rootRef.current?.parentElement
    if (!open || !parent) return
    setParentH(parent.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setParentH(parent.clientHeight))
    ro.observe(parent)
    return () => ro.disconnect()
  }, [open])
  // "The owner has looked at the president's seat" — clears the Ground card's
  // president hand / eye (groundLamp.ts, 2026-09-26). The eye alone is also
  // cleared by merely opening the project (ProjectPanel's 'opened' look).
  useGroundLook(project.path, 'seen', open)
  const maxH = parentH > 0 ? Math.max(SWARM_BAR_MIN_H, parentH - TOP_RESERVE) : undefined
  const shownH = maxH === undefined ? height : Math.min(height, maxH)

  // Clamp against the column the bar lives in, so the tab above always keeps
  // TOP_RESERVE px (a later window shrink is handled by `shownH`).
  const clamp = (h: number) => {
    const parentH = rootRef.current?.parentElement?.clientHeight ?? 0
    const max = parentH > 0 ? Math.max(SWARM_BAR_MIN_H, parentH - TOP_RESERVE) : Infinity
    return Math.round(Math.min(max, Math.max(SWARM_BAR_MIN_H, h)))
  }
  const commit = (h: number) => {
    const v = clamp(h)
    setHeight(v)
    save(project.id, { h: v })
  }

  // The drag. A press that moves less than SWARM_BAR_DRAG_SLOP stays a click;
  // past it the press is a drag and the click that follows is swallowed.
  // Pointer capture — taken only once it IS a drag, so a plain click is left
  // alone — keeps the drag alive over an iframe / terminal.
  // `kept`: the saved height, put back when the drag ends in a fold.
  const drag = useRef<{ y: number; h: number; moved: boolean; raw: number; kept: number } | null>(null)
  const swallowClick = useRef(false)
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest(NOT_A_HANDLE)) return
    const h = rootRef.current?.offsetHeight || (open ? shownH : 0)
    drag.current = { y: e.clientY, h, moved: false, raw: h, kept: height }
    // Capture at once: a quick flick leaves the 38px row before its first
    // move is heard (measured in the real app). The click after a still press
    // then lands on the row itself, whose onClick opens / folds.
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const endDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    drag.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d?.moved) return
    swallowClick.current = true
    setTimeout(() => (swallowClick.current = false), 0)
    if (d.raw < FOLD_BELOW) {
      setHeight(d.kept)
      setOpen(false)
      save(project.id, { open: false })
    } else {
      const v = clamp(d.raw)
      setOpen(true)
      setHeight(v)
      save(project.id, { h: v, open: true })
    }
  }
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    // The button came up somewhere we never heard about (capture lost to the
    // OS, a window switch): end the drag instead of resizing on hover.
    if (e.buttons === 0) return endDrag(e)
    const dy = d.y - e.clientY
    if (!d.moved) {
      if (Math.abs(dy) < SWARM_BAR_DRAG_SLOP) return
      d.moved = true
    }
    d.raw = d.h + dy
    if (d.raw < FOLD_BELOW) setOpen(false)
    else {
      setOpen(true)
      setHeight(clamp(d.raw))
    }
  }
  // Keyboard path: the arrow keys on the bar's named toggle button.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!open || !(e.target as Element).closest('[data-testid="swarm-bar-toggle"]')) return
    if (e.key === 'ArrowUp') commit(shownH + KEY_STEP)
    else if (e.key === 'ArrowDown') commit(shownH - KEY_STEP)
    else return
    e.preventDefault()
  }

  return (
    <div
      ref={rootRef}
      data-testid="swarm-bottom-bar"
      className={[
        'relative flex min-w-0 shrink-0 flex-col border-t border-line bg-bg',
        open ? 'min-h-0' : '',
      ].join(' ')}
      style={open ? { height: shownH } : undefined}
    >
      {/* Every stream opened inside the bar counts as the BAR's, so the page
          (the open tab) keeps priority — streamBudget.ts. */}
      <StreamOwnerContext.Provider value="swarmBar">
      <SwarmModule
        project={project}
        collapsed={!open}
        barHandle={{
          onPointerDown,
          onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onLostPointerCapture: endDrag,
          onKeyDown,
        }}
        onToggleCollapsed={() => {
          if (swallowClick.current) return
          if (!open) setHeight((h) => clamp(h))
          setOpen(!open)
          save(project.id, { open: !open })
        }}
      />
      </StreamOwnerContext.Provider>
    </div>
  )
}
