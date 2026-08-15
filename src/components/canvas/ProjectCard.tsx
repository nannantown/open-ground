import {
  GitBranch,
  FolderClosed,
  Users,
} from 'lucide-react'
import { memo } from 'react'
import type { ProjectMeta } from '@/lib/types'
import type { GroundLamp } from '@/lib/groundLamp'
import { useT } from '@/i18n/I18nContext'
import { PlaybackEq } from '@/components/canvas/PlaybackEq'

interface Props {
  project: ProjectMeta
  onPointerDown?: (e: React.PointerEvent) => void
  selected?: boolean
  active?: boolean
  /** What this project's WORK is doing: 'working' → moss "Running" edge bar +
   *  stamp, 'waiting' → amber "Waiting" (it needs you, or it stalled).
   *  null/undefined → NOTHING AT ALL, which is the answer for a project whose
   *  cards are all done or merely queued — 「作業が終わってて何も出さない時に user は
   *  見にいくんですよ」.
   *
   *  ⚠ THE TYPE IS THE FIX, not just a rename. This used to be a
   *  ClaudeBeaconStatus, which carries a third value ('idle' — a live session
   *  parked at its prompt). The stamps below tested for 'working' and 'waiting'
   *  explicitly and so ignored it, but the top EDGE BAR tested for truthiness
   *  and painted 'idle' amber — an "it needs you" band over a project that
   *  needed nothing. GroundLamp has no third value to get wrong. */
  lamp?: GroundLamp
  /** Audio from this project is playing somewhere in the app (the Songs
   *  custom tab's embedded player) → a "Playing" EQ stamp on the bottom
   *  margin; `title` names the track in the tooltip. Undefined = silent. */
  playback?: { title: string | null }
  /** This card is a project shared WITH the user (collab member flow, folder-
   *  less). Marks it with the dedicated `invite` accent — a left band, a tinted
   *  ring, a Users icon and a "Shared" badge — so it reads at a glance as
   *  shared, distinct from the user's own (local) cards. Local cards pass this
   *  falsy and are rendered byte-for-byte as before. */
  shared?: boolean
}

const coordFromId = (id: string) => {
  const a = parseInt(id.slice(0, 2), 16) % 26
  const b = parseInt(id.slice(2, 4), 16) % 99
  return `${String.fromCharCode(65 + a)}·${String(b).padStart(2, '0')}`
}

// One project on the Ground: name + description. While a claude session is
// live here the card carries the runner-era surveyor's marking — a coloured
// band along the top edge plus a stamp on the right margin: moss "Running"
// (scanning) while claude works, amber "Waiting" when it sits on the human.
//
// A folder-less collab project shared WITH the user (shared=true) renders
// through this SAME path but wears the dedicated `invite` accent so it reads at
// a glance as shared, not lost among the user's own cards: a left band, an
// invite-tinted ring, a Users icon and a "Shared" badge — all from the single
// `invite` design token. Local cards pass shared falsy and are unchanged. The
// synthetic meta's empty git/task fields still hide the git icon and open-task
// stamp; the shared caption rides in the description slot.
export const ProjectCard = memo(({
  project,
  onPointerDown,
  selected,
  active,
  lamp,
  playback,
  shared,
}: Props) => {
  const { t } = useT()
  return (
    <div
      onPointerDown={onPointerDown}
      title={shared ? t('projectPanel.groundSharedTitle') : undefined}
      className={[
        'group relative select-none bg-bg-card transition-all',
        'w-64 cursor-grab active:cursor-grabbing',
        'border rounded-[3px]',
        // Shared (invite) cards are read-only overlays, never selectable, so they
        // only ever sit in default / hover — plus the dormant focus-visible state
        // (the canvas is pointer-driven, so the div isn't tab-focusable today,
        // but the rule is defined and ready) and the missing→opacity disabled
        // state below. All composed in the invite token, kept lighter than the
        // accent ring an *active* owned card gets so the hierarchy stays clear.
        shared
          ? [
              'border-invite/45 shadow-card',
              'hover:border-invite/70 hover:shadow-card-hover',
              'outline-none focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-invite',
            ].join(' ')
          : active
            ? 'border-accent shadow-card-active'
            : selected
              ? 'border-accent shadow-card-hover'
              : lamp
                ? 'border-line-strong shadow-card-hover'
                : 'border-line shadow-card hover:shadow-card-hover hover:border-line-strong',
        project.missing ? 'opacity-50' : '',
      ].join(' ')}
    >
      {/* lamp edge — a surveyor's marking along the card's top. Drawn ONLY for
          the two states that are about the work; 'unknown' gets the stamp below
          and no band, because a coloured band reads as an alarm and "we could
          not read your board" is not one. */}
      {(lamp === 'working' || lamp === 'waiting') && (
        <div
          className={[
            'absolute left-0 right-0 top-0 h-[3px] overflow-hidden rounded-t-[2px]',
            lamp === 'working' ? 'bg-moss' : 'bg-ochre',
          ].join(' ')}
        >
          {lamp === 'working' && (
            <div className="run-scan h-full w-1/3 bg-gradient-to-r from-transparent via-bg-card/85 to-transparent" />
          )}
        </div>
      )}

      {/* shared (invite) marker — a solid band down the left edge, the at-a-
          glance "this is shared with you" signal that survives any zoom. On a
          different axis from the claude top band so the two never collide. */}
      {shared && (
        <div className="absolute bottom-0 left-0 top-0 w-[3px] rounded-l-[2px] bg-invite" />
      )}

      {/* coordinate label, like a map index */}
      <div className="coord-label label-cap-latin absolute -top-[7px] left-3 bg-bg-card px-1.5 text-ink-subtle">
        {coordFromId(project.id)}
      </div>

      {/* claude-status stamp, mirroring the coord label on the right margin */}
      {lamp === 'working' && (
        // claude is busy — moss, with the dot pulsing while live.
        <div className="absolute -top-[7px] right-3 flex items-center gap-1 bg-bg-card px-1.5 label-cap label-cap-latin text-moss-text">
          <span className="run-pulse h-[5px] w-[5px] rounded-full bg-moss" />
          <span>Running</span>
        </div>
      )}
      {lamp === 'unknown' && (
        // ⚠ NOT A BLANK CARD. The board behind this project could not be read,
        // and a blank card is how a FINISHED one looks — so staying silent here
        // would tell the owner their work is done using a file nobody opened.
        // Deliberately the quietest stamp on the card: it is a fact about this
        // app, not about their project, and it must not compete with Waiting.
        <div
          title="This project's board could not be read"
          className="absolute -top-[7px] right-3 flex items-center gap-1 bg-bg-card px-1.5 label-cap label-cap-latin text-ink-subtle"
        >
          <span className="h-[5px] w-[5px] rounded-full bg-ink-faint" />
          <span>No data</span>
        </div>
      )}
      {lamp === 'waiting' && (
        // claude is sitting on the human — "your turn". Amber for attention:
        // dot in the ochre token (3:1 graphics contrast is met), label in the
        // darkened amber var (≥4.5:1 on the card — raw ochre is only ~4:1 at
        // this size). Steady, no pulse: pulsing means "activity", and a
        // full-opacity stamp stays visible at a glance.
        <div className="absolute -top-[7px] right-3 flex items-center gap-1 bg-bg-card px-1.5 label-cap label-cap-latin text-[var(--beacon-waiting)]">
          <span className="h-[5px] w-[5px] rounded-full bg-ochre" />
          <span>Waiting</span>
        </div>
      )}

      {/* audio-playing stamp — same surveyor's-marking grammar as the claude
          stamps, but on the BOTTOM margin so it never collides with them (a
          project can be Running and Playing at once). EQ bars animate while
          the app's Songs player is audible; the tooltip names the track. */}
      {playback && (
        <div
          title={playback.title ?? undefined}
          className="absolute -bottom-[7px] right-3 flex items-center gap-1.5 bg-bg-card px-1.5 label-cap label-cap-latin text-accent"
        >
          <PlaybackEq size={8} />
          <span>Playing</span>
        </div>
      )}

      <div className="px-4 pt-4 pb-4">
        <div className="flex items-start gap-2.5">
          <div
            className={[
              'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center',
              'border rounded-[2px]',
              shared
                ? 'border-invite/40 bg-invite-soft text-invite'
                : project.hasGit
                  ? 'border-accent/40 bg-accent-soft text-accent'
                  : 'border-line bg-bg-inset text-ink-subtle',
            ].join(' ')}
          >
            {shared ? (
              <Users size={12} strokeWidth={2} />
            ) : project.hasGit ? (
              <GitBranch size={12} strokeWidth={2} />
            ) : (
              <FolderClosed size={12} strokeWidth={2} />
            )}
          </div>
          <div
            className="min-w-0 flex-1 truncate font-display text-read leading-tight text-ink"
            style={{ fontVariationSettings: "'opsz' 18, 'SOFT' 30" }}
          >
            {project.name}
          </div>
          {shared && (
            // Text-diet 2026-08-03: a shared card carried FOUR marks at once
            // (band, ring, this badge, the icon chip). The text label was the
            // least dense of the four — the glyph keeps the meaning, the
            // tooltip keeps the word.
            <span
              title={t('projectPanel.groundSharedBadge')}
              className="mt-0.5 flex shrink-0 items-center rounded-[3px] bg-invite-soft p-1 text-invite"
            >
              <Users size={10} strokeWidth={2.25} aria-label={t('projectPanel.groundSharedBadge')} />
            </span>
          )}
          {project.openTaskCount > 0 && (
            <span className="mt-0.5 flex shrink-0 items-center gap-1 text-micro font-medium tracking-[0.04em] text-accent">
              <span className="h-1 w-1 rounded-full bg-accent" />
              {project.openTaskCount} open
            </span>
          )}
          {project.missing && (
            <span className="mt-0.5 shrink-0 label-cap label-cap-latin text-accent">missing</span>
          )}
        </div>

        <div className="mt-2.5">
          <p
            className={[
              'line-clamp-4',
              project.description
                ? 'text-meta leading-snug text-ink-muted'
                : // A filesystem path has no spaces, so it offers the line
                  // breaker nothing to work with: at 10px it happened to fit
                  // the card, and at 12px it simply ran out the side (measured
                  // 2026-08-04 — 30 of 44 cards overflowed by 3–156px).
                  // `break-all` is the honest fix: paths are reference data, so
                  // breaking mid-segment costs nothing, and `line-clamp-4` still
                  // bounds the height. Shrinking the type back would have been
                  // the other option, and it is the one that made this unreadable
                  // in the first place.
                  'font-mono text-micro text-ink-subtle [overflow-wrap:anywhere]',
            ].join(' ')}
          >
            {project.description || (project.missing ? 'Folder no longer exists — remove it from the Ground.' : project.path)}
          </p>
        </div>
      </div>
    </div>
  )
})
