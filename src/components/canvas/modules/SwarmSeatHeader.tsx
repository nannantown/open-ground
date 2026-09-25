// SwarmSeatHeader — the nameplate every seat on the one-screen Swarm tab wears
// (2026-09-23, owner: "one screen, president / commander / workers side by
// side, a slightly different background per role, the pixel characters on
// every seat"). The sub-tab strip that used to carry each role's name is gone,
// so the plate says WHO (role word + figure + role tint), WHAT STATE (status
// word, the figure's motion) and, for a worker, WHAT JOB (the task title).
// Nothing else — owner-irrelevant chrome (runtime badges, engine chips) stays
// off it.
//
// The tint is a theme token per role (`--og-seat-*` in globals.css, both
// palettes, text contrast pinned by themePalette.test.ts).

import { useContext, type ReactNode } from 'react'
import { ChevronsRight } from 'lucide-react'
import { SwarmSprite } from '@/components/canvas/SwarmSprite'
import type { SpriteRole, SpriteState } from '@/lib/swarm/sprites'
import { useT } from '@/i18n/I18nContext'
import { SeatFoldContext } from './SwarmSeatStrip'

const SEAT_TINT: Record<SpriteRole, string> = {
  supply: 'bg-seat-supply',
  commander: 'bg-seat-manager',
  worker: 'bg-seat-worker',
}

const ROLE_LABEL_KEY: Record<SpriteRole, string> = {
  supply: 'projectPanel.swarm.supply.tab',
  commander: 'projectPanel.swarm.manager.tab',
  worker: 'projectPanel.swarm.seat.worker',
}

export const SwarmSeatHeader = ({
  role,
  sprite,
  statusLabel,
  waiting = false,
  detail,
  detailTitle,
  children,
}: {
  role: SpriteRole
  /** The figure's state; `null` = nobody is there (exited / off) — the plate
   *  then shows a plain grey dot instead of a dimmed animal (sprites.ts). */
  sprite: SpriteState | null
  statusLabel: string
  /** Colour the status word as the waiting lamp (needs the owner / parked). */
  waiting?: boolean
  /** What this seat is doing — a worker's task title. */
  detail?: string
  detailTitle?: string
  /** Seat controls (start / stop …), right-aligned. */
  children?: ReactNode
}) => {
  const { t } = useT()
  // Set only inside a foldable open seat (SwarmOpenSeat) — the president's
  // seat never folds, so it gets no button.
  const fold = useContext(SeatFoldContext)
  const onFold = fold?.onFold
  const roleLabel = fold?.name ?? t(ROLE_LABEL_KEY[role])
  return (
    <div
      className={`flex min-h-[34px] shrink-0 items-center gap-2 border-b border-line-soft px-2.5 py-1.5 ${SEAT_TINT[role]}`}
    >
      {onFold ? (
        <button
          type="button"
          onClick={onFold}
          aria-expanded
          aria-label={t('projectPanel.swarm.seat.fold')}
          title={t('projectPanel.swarm.seat.fold')}
          data-seat-fold
          className="-ml-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] text-ink-muted transition-colors duration-150 hover:bg-plane hover:text-ink active:bg-ink/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <ChevronsRight size={13} strokeWidth={2} aria-hidden />
        </button>
      ) : null}
      {/* The figure is decoration for a screen reader: the role and status
          words right after it already say the same thing in text. */}
      {sprite ? (
        <span aria-hidden className="inline-flex shrink-0">
          <SwarmSprite role={role} state={sprite} label={`${roleLabel} ${statusLabel}`} />
        </span>
      ) : (
        <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full bg-ink-faint" />
      )}
      <span className="shrink-0 text-meta font-medium text-ink">{roleLabel}</span>
      {/* With a detail line the status word keeps its size and the detail
          truncates; without one the status word takes the free space (and
          truncates last) so the controls stay flush right. No empty detail
          span: it cost two gaps, which is what clipped the manager's only
          button in its narrow seat. */}
      <span
        className={`label-cap min-w-0 truncate ${detail ? 'shrink-0' : 'flex-1'} ${waiting ? 'text-[var(--beacon-waiting)]' : 'text-ink-faint'}`}
        title={detail ? undefined : detailTitle}
      >
        {statusLabel}
      </span>
      {detail ? (
        <span
          className="min-w-0 flex-1 truncate text-meta text-ink-muted"
          title={detailTitle ?? detail}
        >
          {detail}
        </span>
      ) : null}
      {children}
    </div>
  )
}
