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

import type { ReactNode } from 'react'
import { SwarmSprite } from '@/components/canvas/SwarmSprite'
import type { SpriteRole, SpriteState } from '@/lib/swarm/sprites'
import { useT } from '@/i18n/I18nContext'

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
  const roleLabel = t(ROLE_LABEL_KEY[role])
  return (
    <div
      className={`flex min-h-[34px] shrink-0 items-center gap-2 border-b border-line-soft px-2.5 py-1.5 ${SEAT_TINT[role]}`}
    >
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
      <span
        className={`label-cap shrink-0 ${waiting ? 'text-[var(--beacon-waiting)]' : 'text-ink-faint'}`}
      >
        {statusLabel}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-meta text-ink-muted"
        title={detailTitle ?? detail}
      >
        {detail}
      </span>
      {children}
    </div>
  )
}
