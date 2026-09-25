// SwarmSeatStrip — the manager's and each worker's seat, foldable into a thin
// vertical strip (owner decision 2026-09-25: "the owner mostly uses the
// president's seat; fold the others, but still show that they are moving").
//
// Folded, the strip carries the role word, the job (a worker's task title) and
// ONE lamp that pulses while that seat is working and is gone otherwise. The
// lamp reads the module's existing status (the active-desk poll) — a folded
// seat mounts NOTHING else, so it opens no stream and runs no feed poll (the
// connection budget in streamBudget.ts stays as it was). Clicking the strip
// opens the seat to its right; clicking it again folds it. The president's
// seat never folds and takes the width the strips give up.
//
// Which seats are open is remembered per project in localStorage, the same way
// the bottom bar remembers its own open/height (SwarmBottomBar.tsx).

import type { CSSProperties, ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
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

const STRIP_W = 32
const FOLDED_STYLE: CSSProperties = { flex: `0 0 ${STRIP_W}px`, minWidth: STRIP_W, minHeight: 220 }

const TINT = { manager: 'bg-seat-manager', worker: 'bg-seat-worker' } as const

export const SwarmSeatStrip = ({
  seatKey,
  role,
  detail,
  running,
  open,
  onToggle,
  openStyle,
  children,
}: {
  seatKey: string
  role: 'manager' | 'worker'
  /** A worker's job, written down the strip under the role word. */
  detail?: string
  /** The seat is working right now — the lamp pulses. */
  running: boolean
  open: boolean
  onToggle: () => void
  /** The seat's own flex sizing while open. */
  openStyle: CSSProperties
  children: ReactNode
}) => {
  const { t } = useT()
  const roleLabel = t(role === 'manager' ? 'projectPanel.swarm.manager.tab' : 'projectPanel.swarm.seat.worker')
  const name = detail ? `${roleLabel} — ${detail}` : roleLabel
  return (
    <div
      className="flex h-full overflow-hidden bg-bg"
      style={open ? { ...openStyle, minWidth: Number(openStyle.minWidth ?? 0) + STRIP_W } : FOLDED_STYLE}
      data-seat-strip={seatKey}
      data-running={running || undefined}
    >
      <div className={`flex shrink-0 ${TINT[role]}`} style={{ width: STRIP_W }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={running ? `${name} (${t('projectPanel.swarm.seat.running')})` : name}
          title={`${name}\n${t('projectPanel.swarm.seat.foldHint')}`}
          className="flex w-full min-h-0 cursor-pointer flex-col items-center gap-2 border-r border-line-soft py-2 text-ink-muted transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink active:bg-ink/10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          {open ? <ChevronLeft size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {/* The lamp: pulses while working, gone otherwise (space kept so the
              words don't jump). run-pulse holds still under reduced motion. */}
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full bg-accent ${running ? 'run-pulse' : 'invisible'}`}
          />
          <span className="shrink-0 text-meta font-medium text-ink [writing-mode:vertical-rl]">{roleLabel}</span>
          {detail ? (
            <span className="min-h-0 flex-1 truncate text-start text-micro text-ink-muted [writing-mode:vertical-rl]">
              {detail}
            </span>
          ) : null}
        </button>
      </div>
      {open ? <div className="h-full min-w-0 flex-1 overflow-hidden">{children}</div> : null}
    </div>
  )
}
