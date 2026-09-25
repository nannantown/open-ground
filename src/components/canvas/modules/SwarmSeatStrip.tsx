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

import { createContext, type CSSProperties, type ReactNode } from 'react'
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

/** An open manager / worker seat: just the seat, sized by its own style. */
export const SwarmOpenSeat = ({
  seatKey,
  name,
  onFold,
  style,
  children,
}: {
  seatKey: string
  name?: string
  onFold: () => void
  style: CSSProperties
  children: ReactNode
}) => (
  <div className="h-full overflow-hidden" style={style} data-seat-open={seatKey}>
    <SeatFoldContext.Provider value={{ onFold, name }}>{children}</SeatFoldContext.Provider>
  </div>
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
