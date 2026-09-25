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
//   manager · workers). The top edge is a drag handle; the height is saved per
//   project and restored next time. Open/closed is saved per project too
//   (owner decision 2026-09-25): leave a project with the bar open and it is
//   open when you come back, even after a restart. A project never opened
//   before starts folded. Opening on entry cannot freeze the window: the seats
//   only get what the page's streams leave (streamBudget.ts, pinned in
//   SwarmModule.streamBudget.test.tsx).

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { ProjectMeta } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'
import { SwarmModule } from '@/components/canvas/modules/SwarmModule'
import { StreamOwnerContext } from '@/lib/streamBudget'

export const SWARM_BAR_DEFAULT_H = 360
export const SWARM_BAR_MIN_H = 180
/** Space always left for the tab above the open bar (px). */
const TOP_RESERVE = 120
const KEY_STEP = 24

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
  const { t } = useT()
  const [open, setOpen] = useState(() => loadSwarmBarOpen(project.id))
  const [height, setHeight] = useState(() => loadSwarmBarHeight(project.id))
  const rootRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; h: number } | null>(null)
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

  // Pointer capture keeps the drag on the handle even when the pointer runs
  // over an iframe / terminal, and releases by itself on up/cancel.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, h: rootRef.current?.offsetHeight || shownH }
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    commit(rootRef.current?.offsetHeight || shownH)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    // The button came up somewhere we never heard about (capture lost to the
    // OS, a window switch): end the drag instead of resizing on hover.
    if (e.buttons === 0) return endDrag(e)
    setHeight(clamp(drag.current.h + (drag.current.y - e.clientY)))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('projectPanel.swarm.bar.resize')}
          aria-valuenow={shownH}
          aria-valuemin={SWARM_BAR_MIN_H}
          aria-valuemax={maxH}
          title={t('projectPanel.swarm.bar.resize')}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => commit(SWARM_BAR_DEFAULT_H)}
          onKeyDown={onKeyDown}
          className={[
            'absolute inset-x-0 top-0 z-10 h-[5px] cursor-row-resize touch-none',
            'transition-colors duration-150 hover:bg-accent/30 active:bg-accent/50',
            'focus-visible:bg-accent/50 focus-visible:outline-none',
          ].join(' ')}
        />
      )}
      {/* Every stream opened inside the bar counts as the BAR's, so the page
          (the open tab) keeps priority — streamBudget.ts. */}
      <StreamOwnerContext.Provider value="swarmBar">
      <SwarmModule
        project={project}
        collapsed={!open}
        onToggleCollapsed={() => {
          if (!open) setHeight((h) => clamp(h))
          setOpen(!open)
          save(project.id, { open: !open })
        }}
      />
      </StreamOwnerContext.Provider>
    </div>
  )
}
