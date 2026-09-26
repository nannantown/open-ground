// SwarmSeatStrip — folding the manager's and each worker's seat (owner decision
// 2026-09-25: "the owner mostly uses the president's seat; fold the others, but
// still show that they are moving").
//
// Second design, same day. The first folded every seat into its own 32px strip
// with the role word written vertically, and the strip stayed beside the seat
// when it opened. The owner saw it and said no: the name showed twice (strip +
// nameplate), vertical text is hard to read, and the strip's lamp read a
// different status than the nameplate. So now:
//   - FOLDED seats leave the row and sit as character icons in ONE narrow
//     column at the right edge (SwarmSeatRail): icon, short horizontal name
//     under it. A working seat's icon moves and its corner lamp glows; any
//     other seat's icon is faded and still. Hover = "name · status".
//   - An OPEN seat is only its own seat (SwarmOpenSeat): no strip beside it, the
//     name once in its nameplate, and the fold button at the nameplate's left
//     end (SwarmSeatHeader reads SeatFoldContext).
//   - The rail's icon, lamp and words come from the SAME functions the
//     nameplates use (commanderSeatLook / workerSeatLook), so they cannot drift.
// A folded seat still mounts NOTHING — no stream, no feed poll (the connection
// budget in streamBudget.ts is unchanged). The president's seat never folds.
//
// Which seats are open is remembered per project in localStorage, the same way
// the bottom bar remembers its own open/height (SwarmBottomBar.tsx).

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { SwarmSprite } from '@/components/canvas/SwarmSprite'
import type { SpriteState } from '@/lib/swarm/sprites'
import { useT } from '@/i18n/I18nContext'

export const swarmSeatsKey = (projectId: string) => `openground.swarmseats.${projectId}`

/** Seat keys that are OPEN ('manager', 'vacant', or a worker's worktree).
 *  Absent ⇒ every seat folded (the default). */
export const loadOpenSeats = (projectId: string): Set<string> => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(swarmSeatsKey(projectId)) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

// ponytail: keys of finished workers stay in the list (a path each); prune
// against the live roster if it ever grows noticeably.
export const saveOpenSeats = (projectId: string, open: ReadonlySet<string>) => {
  try {
    localStorage.setItem(swarmSeatsKey(projectId), JSON.stringify(Array.from(open)))
  } catch {
    /* storage full / disabled — the fold just won't be remembered */
  }
}

/** Set by an open, foldable seat: its nameplate draws the fold button from
 *  `onFold` and, when given, shows `name` (the rail's name, e.g. "Worker 2")
 *  instead of the bare role word. */
export const SeatFoldContext = createContext<{ onFold: () => void; name?: string } | null>(null)

// ── Seat widths (owner 2026-09-26: "drag the border to change the width, and
// click it to open one seat up big — two operations") ──────────────────────
// Every open seat (president included) can be sized. The border in FRONT of a
// seat belongs to the seat on its LEFT: dragging it sets that seat's width,
// pressing it without moving makes that seat the WIDE one (every other seat
// drops to its minimum and the wide seat takes all the rest — a fixed share
// would overflow the row and cut the last seat off) and pressing again puts the row
// back. The nameplate does the same for its own seat (so the last seat, which
// has no border after it, can be widened too). Widths and the wide seat are
// remembered per project, like the fold state above.

export const swarmSeatSizesKey = (projectId: string) => `openground.swarmseatw.${projectId}`
/** A press on a border that moves less than this is a click (px). */
export const SEAT_DRAG_SLOP = 3
const SEAT_KEY_STEP = 24

export interface SeatSizes {
  /** Seat key → dragged width (px). */
  w: Record<string, number>
  /** The seat opened up big, if any. */
  wide?: string
}

export const loadSeatSizes = (projectId: string): SeatSizes => {
  try {
    const raw = JSON.parse(localStorage.getItem(swarmSeatSizesKey(projectId)) ?? 'null') as Partial<SeatSizes> | null
    const w: Record<string, number> = {}
    if (raw && typeof raw.w === 'object' && raw.w) {
      for (const [k, v] of Object.entries(raw.w)) if (typeof v === 'number' && Number.isFinite(v)) w[k] = Math.round(v)
    }
    return { w, wide: typeof raw?.wide === 'string' ? raw.wide : undefined }
  } catch {
    return { w: {} }
  }
}

const saveSeatSizes = (projectId: string, sizes: SeatSizes) => {
  try {
    localStorage.setItem(swarmSeatSizesKey(projectId), JSON.stringify(sizes))
  } catch {
    /* storage full / disabled — the widths just won't be remembered */
  }
}

interface SeatSizeApi {
  sizes: SeatSizes
  /** Live while dragging; `persist` on release. Clears the wide seat. */
  setWidth: (key: string, w: number, persist: boolean) => void
  toggleWide: (key: string) => void
  /** A border is being dragged — the row does not animate meanwhile. */
  dragging: boolean
  setDragging: (on: boolean) => void
}

/** The saved sizes + the open seats as they stand now, left to right. */
export type SeatRow = SeatSizeApi & { order: readonly string[] }
export const SeatSizeContext = createContext<SeatRow | null>(null)
/** The key of the seat a nameplate sits in (SwarmSeatHeader). */
export const SeatKeyContext = createContext<string | null>(null)

export const useSeatSizes = (projectId: string): SeatSizeApi => {
  const [sizes, setSizes] = useState<SeatSizes>(() => loadSeatSizes(projectId))
  const [dragging, setDragging] = useState(false)
  const setWidth = useCallback(
    (key: string, w: number, persist: boolean) =>
      setSizes((prev) => {
        const next = { w: { ...prev.w, [key]: Math.round(w) } }
        if (persist) saveSeatSizes(projectId, next)
        return next
      }),
    [projectId],
  )
  const toggleWide = useCallback(
    (key: string) =>
      setSizes((prev) => {
        const next = { w: prev.w, wide: prev.wide === key ? undefined : key }
        saveSeatSizes(projectId, next)
        return next
      }),
    [projectId],
  )
  return useMemo(() => ({ sizes, setWidth, toggleWide, dragging, setDragging }), [sizes, setWidth, toggleWide, dragging])
}

/** The flex style a seat gets from its base style + the saved sizes, judged
 *  against the row as it stands (`order`). The saved marks outlive the seats
 *  they name — a seat is folded, a worker finishes and leaves the roster — so:
 *  the wide mark counts only while its seat is in the row, and the LAST seat
 *  ignores its saved width and grows (its width is set by the border on its
 *  right, which it no longer has) — otherwise the row ends in a blank gap. */
export const seatSizedStyle = (key: string, base: CSSProperties, row: SeatRow | null): CSSProperties => {
  const min = Number(base.minWidth) || 0
  if (!row) return base
  const { sizes, order } = row
  const wide = sizes.wide && order.includes(sizes.wide) ? sizes.wide : undefined
  if (wide === key) return { ...base, flex: `1 0 ${min}px` }
  if (wide) return { ...base, flex: `0 0 ${min}px` }
  const w = sizes.w[key]
  return w && order[order.length - 1] !== key ? { ...base, flex: `0 0 ${Math.max(min, w)}px` } : base
}

/** The border in front of a seat: sizes the seat on its LEFT (`leftKey`). */
const SeatBorder = ({ leftKey }: { leftKey: string }) => {
  const { t } = useT()
  const api = useContext(SeatSizeContext)
  const drag = useRef<{ x: number; w: number; min: number; max: number; moved: boolean } | null>(null)
  if (!api) return null
  const left = (el: HTMLElement) => el.previousElementSibling as HTMLElement | null
  const fit = (d: { min: number; max: number }, w: number) => Math.min(d.max, Math.max(d.min, w))
  const measure = (el: HTMLElement) => {
    const seat = left(el)
    const min = Number(seat?.style.minWidth.replace('px', '')) || 0
    const row = el.parentElement?.clientWidth || Infinity
    return { w: seat?.offsetWidth || min, min, max: Math.max(min, row) }
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d.moved) {
      if (e.type === 'pointerup') api.toggleWide(leftKey)
      return
    }
    api.setDragging(false)
    api.setWidth(leftKey, fit(d, d.w + (e.clientX - d.x)), true)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? SEAT_KEY_STEP : e.key === 'ArrowLeft' ? -SEAT_KEY_STEP : 0
    if (e.key === 'Enter' || e.key === ' ') api.toggleWide(leftKey)
    else if (step) {
      const m = measure(e.currentTarget)
      api.setWidth(leftKey, fit(m, m.w + step), true)
    } else return
    e.preventDefault()
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('projectPanel.swarm.seat.border')}
      title={t('projectPanel.swarm.seat.border')}
      tabIndex={0}
      data-seat-border={leftKey}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        drag.current = { x: e.clientX, moved: false, ...measure(e.currentTarget) }
        // Capture at once — a 5px border is left by the first quick move.
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        if (e.buttons === 0) return end(e)
        const dx = e.clientX - d.x
        if (!d.moved) {
          if (Math.abs(dx) < SEAT_DRAG_SLOP) return
          d.moved = true
          api.setDragging(true)
        }
        api.setWidth(leftKey, fit(d, d.w + dx), false)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      // 5px to grab, 1px to see: the side borders are the seat background, the
      // middle is the old 1px seat divider — which lights up on hover / drag.
      className="w-[5px] shrink-0 cursor-col-resize touch-none border-x-2 border-bg bg-line-strong transition-colors duration-150 hover:border-accent/20 hover:bg-accent active:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    />
  )
}

/** A seat in the open row, sized by the saved widths. Every seat but the first
 *  gets a border in front of it that sizes the seat before it (`prevKey`). */
export const SizedSeat = ({
  seatKey,
  prevKey,
  style,
  children,
  ...rest
}: {
  seatKey: string
  prevKey?: string
  style: CSSProperties
  children: ReactNode
} & Record<`data-${string}`, string>) => {
  const api = useContext(SeatSizeContext)
  return (
    <>
      {prevKey ? <SeatBorder leftKey={prevKey} /> : null}
      <div
        {...rest}
        data-seat-key={seatKey}
        data-seat-wide={api?.sizes.wide === seatKey || undefined}
        className={`h-full overflow-hidden ${api?.dragging ? '' : 'transition-[flex] duration-200 ease-out motion-reduce:transition-none'}`}
        style={seatSizedStyle(seatKey, style, api)}
      >
        <SeatKeyContext.Provider value={seatKey}>{children}</SeatKeyContext.Provider>
      </div>
    </>
  )
}

/** An open manager / worker seat: just the seat, sized by its own style. */
export const SwarmOpenSeat = ({
  seatKey,
  prevKey,
  name,
  onFold,
  style,
  children,
}: {
  seatKey: string
  prevKey?: string
  name?: string
  onFold: () => void
  style: CSSProperties
  children: ReactNode
}) => (
  <SizedSeat seatKey={seatKey} prevKey={prevKey} style={style} data-seat-open={seatKey}>
    <SeatFoldContext.Provider value={{ onFold, name }}>{children}</SeatFoldContext.Provider>
  </SizedSeat>
)

export interface RailSeat {
  key: string
  role: 'commander' | 'worker'
  /** Short horizontal name under the icon ("Manager", "Worker 2"). */
  name: string
  /** The nameplate's status word, from the same look function. */
  statusLabel: string
  /** A worker's job, added to the hover text. */
  detail?: string
  /** The nameplate's figure; null (nobody there) draws the figure faded. */
  sprite: SpriteState | null
  /** The nameplate says working — the icon moves and the lamp glows. */
  lit: boolean
}

/** The folded seats, as a column of character icons. Nothing folded ⇒ nothing. */
export const SwarmSeatRail = ({ seats, onOpen }: { seats: readonly RailSeat[]; onOpen: (key: string) => void }) => {
  const { t } = useT()
  if (seats.length === 0) return null
  return (
    <div
      role="group"
      aria-label={t('projectPanel.swarm.seat.rail')}
      className="flex w-[72px] shrink-0 flex-col gap-1 overflow-y-auto border-l border-line-soft bg-bg p-1"
      data-seat-rail
    >
      {seats.map((s) => {
        const tip = t('projectPanel.swarm.seat.railTip', { name: s.name, status: s.statusLabel })
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onOpen(s.key)}
            aria-expanded={false}
            aria-label={tip}
            title={s.detail ? `${tip}\n${s.detail}` : tip}
            data-rail-seat={s.key}
            data-lit={s.lit || undefined}
            className="group flex w-full shrink-0 cursor-pointer flex-col items-center gap-0.5 rounded-[3px] px-0.5 pb-1 pt-1.5 text-ink-muted transition-colors duration-150 hover:bg-plane hover:text-ink active:bg-ink/10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <span className="relative inline-flex">
              <span aria-hidden className={`inline-flex transition-opacity duration-150 ${s.lit ? '' : 'opacity-40 group-hover:opacity-70'}`}>
                <SwarmSprite
                  role={s.role}
                  state={s.sprite ?? 'starting'}
                  scale={2}
                  still={!s.lit}
                  label={tip}
                />
              </span>
              {/* The corner lamp — only on a working seat. run-pulse holds
                  still under reduced motion. */}
              {s.lit ? (
                <span
                  aria-hidden
                  className="run-pulse absolute right-0 top-0 h-2 w-2 rounded-full bg-moss ring-2 ring-bg"
                />
              ) : null}
            </span>
            <span className={`w-full truncate text-center text-micro ${s.lit ? 'font-medium text-ink' : ''}`}>
              {s.name}
            </span>
          </button>
        )
      })}
    </div>
  )
}
