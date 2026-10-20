import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'

// The Canvas left sidebar's two stacked sections — Pages on top, Layers below
// (owner request 2026-10-20). Each folds from its header chevron; while both
// are open the border between them drags up / down to share the height. A
// folded section shrinks to its header and the open one takes the rest.
// Fold state + the split are remembered per project (localStorage, so they
// survive a restart). The split is stored as a FRACTION of the sidebar height
// so a resized window keeps the same proportion.

export const SPLIT_DEFAULT = 0.3
/** Smallest the Pages / Layers section may be dragged to (px). */
export const PAGES_MIN_H = 64
export const LAYERS_MIN_H = 96
const KEY_STEP = 24

export const canvasSidebarKey = (projectPath: string) => `openground.canvasSidebar.${projectPath}`

type Saved = { split: number; pagesOpen: boolean; layersOpen: boolean }

export const loadCanvasSidebar = (projectPath: string): Saved => {
  let raw: Partial<Record<keyof Saved, unknown>> = {}
  try {
    raw = JSON.parse(localStorage.getItem(canvasSidebarKey(projectPath)) ?? '{}') ?? {}
  } catch {
    /* corrupt / disabled storage — defaults */
  }
  const s = raw.split
  return {
    split: typeof s === 'number' && s > 0 && s < 1 ? s : SPLIT_DEFAULT,
    pagesOpen: raw.pagesOpen !== false,
    layersOpen: raw.layersOpen !== false,
  }
}

const save = (projectPath: string, v: Saved) => {
  try {
    localStorage.setItem(canvasSidebarKey(projectPath), JSON.stringify(v))
  } catch {
    /* storage full / disabled — just not remembered */
  }
}

/** The fold toggle of a sidebar section header (chevron + label). Shared by
 *  Pages and Layers so both look and behave the same. */
export const SectionToggle = ({
  label,
  collapsed,
  onToggle,
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
}) => {
  const { t } = useT()
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? t('canvas.expand') : t('canvas.collapse')}
      className="flex min-w-0 items-center gap-1 rounded-[4px] px-1 py-0.5 text-ink-muted transition-colors hover:bg-plane hover:text-ink active:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {collapsed ? (
        <ChevronRight size={12} strokeWidth={2.25} className="shrink-0" />
      ) : (
        <ChevronDown size={12} strokeWidth={2.25} className="shrink-0" />
      )}
      <span className="label-cap">{label}</span>
    </button>
  )
}

type SplitProps = {
  projectPath: string
  /** Renders the Pages section with its fold state. */
  pages: (collapsed: boolean, onToggle: () => void) => ReactNode
  /** The slot CanvasWorkspace portals the Layers tree into. Kept mounted
   *  (just hidden) while Layers is folded so the tree keeps its state. */
  layersHostRef: (el: HTMLDivElement | null) => void
}

// Keyed by project: ProjectCanvas survives a project switch (no key upstream),
// and the saved state is read once on mount — without the key project B would
// open with A's folds / split and the first toggle would write A's state into
// B's slot.
export const CanvasSidebarSplit = (props: SplitProps) => (
  <SidebarSplit key={props.projectPath} {...props} />
)

const SidebarSplit = ({ projectPath, pages, layersHostRef }: SplitProps) => {
  const { t } = useT()
  const [state, setState] = useState(() => loadCanvasSidebar(projectPath))
  const update = (patch: Partial<Saved>) => {
    const next = { ...state, ...patch }
    setState(next)
    save(projectPath, next)
  }
  const rootRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  // `split`: the latest dragged value, saved once when the drag ends.
  const drag = useRef<{ y: number; h: number; split: number } | null>(null)

  const both = state.pagesOpen && state.layersOpen
  // Pixel height → fraction of the sidebar, kept inside both minimums.
  const toSplit = (h: number) => {
    const total = rootRef.current?.clientHeight ?? 0
    if (total <= 0) return state.split
    const max = Math.max(PAGES_MIN_H, total - LAYERS_MIN_H)
    return Math.min(max, Math.max(PAGES_MIN_H, h)) / total
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    drag.current = { y: e.clientY, h: pagesRef.current?.offsetHeight ?? 0, split: state.split }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    if (e.buttons === 0) return endDrag(e)
    d.split = toSplit(d.h + e.clientY - d.y)
    const split = d.split
    setState((s) => ({ ...s, split }))
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    // Folds can't change mid-drag, so `state` carries the current ones.
    save(projectPath, { ...state, split: d.split })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowDown' ? KEY_STEP : e.key === 'ArrowUp' ? -KEY_STEP : 0
    if (!step) return
    e.preventDefault()
    update({ split: toSplit((pagesRef.current?.offsetHeight ?? 0) + step) })
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div
        ref={pagesRef}
        data-testid="canvas-pages-slot"
        className={[
          'flex min-h-0 flex-col',
          both ? '' : state.pagesOpen ? 'flex-1' : 'shrink-0',
        ].join(' ')}
        // Both open: a share of the sidebar that may still shrink (to its
        // minimum) when the window gets shorter, so Layers never gets squeezed.
        style={both ? { flex: `0 1 ${state.split * 100}%`, minHeight: PAGES_MIN_H } : undefined}
      >
        {pages(!state.pagesOpen, () => update({ pagesOpen: !state.pagesOpen }))}
      </div>
      {both ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('canvas.sidebarSplit')}
          aria-valuenow={Math.round(state.split * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          title={t('canvas.sidebarSplit')}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onKeyDown={onKeyDown}
          // 5px to grab, 1px to see — same build as the agent-team seat border
          // (SwarmSeatStrip SeatBorder), turned horizontal.
          className="h-[5px] shrink-0 cursor-row-resize touch-none border-y-2 border-bg-card bg-line transition-colors duration-150 hover:border-accent/20 hover:bg-accent active:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        />
      ) : (
        <div className="h-px shrink-0 bg-line" />
      )}
      <section
        className={[
          'flex flex-col',
          state.layersOpen ? 'flex-1' : 'shrink-0',
        ].join(' ')}
        style={state.layersOpen ? { minHeight: both ? LAYERS_MIN_H : 0 } : undefined}
      >
        <div className="flex shrink-0 items-center py-1.5 pl-1.5 pr-2">
          <SectionToggle
            label={t('canvas.layers')}
            collapsed={!state.layersOpen}
            onToggle={() => update({ layersOpen: !state.layersOpen })}
          />
        </div>
        <div ref={layersHostRef} className={state.layersOpen ? 'min-h-0 flex-1' : 'hidden'} />
      </section>
    </div>
  )
}
