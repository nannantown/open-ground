import {
  GitBranch,
  FolderClosed,
} from 'lucide-react'
import type { ClaudeBeaconStatus, ProjectMeta } from '@/lib/types'

interface Props {
  project: ProjectMeta
  onPointerDown?: (e: React.PointerEvent) => void
  selected?: boolean
  active?: boolean
  /** Live claude session in this project: 'working' → azure "Running" edge
   *  bar + stamp, 'waiting' → amber "Waiting" (claude is sitting on you).
   *  Undefined = no claude session (plain shells show nothing). */
  claudeStatus?: ClaudeBeaconStatus
}

const coordFromId = (id: string) => {
  const a = parseInt(id.slice(0, 2), 16) % 26
  const b = parseInt(id.slice(2, 4), 16) % 99
  return `${String.fromCharCode(65 + a)}·${String(b).padStart(2, '0')}`
}

// One project on the Ground: name + description. While a claude session is
// live here the card carries the runner-era surveyor's marking — a coloured
// band along the top edge plus a stamp on the right margin: azure "Running"
// (scanning) while claude works, amber "Waiting" when it sits on the human.
export const ProjectCard = ({
  project,
  onPointerDown,
  selected,
  active,
  claudeStatus,
}: Props) => {
  return (
    <div
      onPointerDown={onPointerDown}
      className={[
        'group relative select-none bg-bg-card transition-all',
        'w-64 cursor-grab active:cursor-grabbing',
        'border rounded-[3px]',
        active
          ? 'border-accent shadow-card-active'
          : selected
            ? 'border-accent shadow-card-hover'
            : claudeStatus
              ? 'border-line-strong shadow-card-hover'
              : 'border-line shadow-card hover:shadow-card-hover hover:border-line-strong',
        project.missing ? 'opacity-50' : '',
      ].join(' ')}
    >
      {/* claude-status edge — a surveyor's marking along the card's top */}
      {claudeStatus && (
        <div
          className={[
            'absolute left-0 right-0 top-0 h-[3px] overflow-hidden rounded-t-[2px]',
            claudeStatus === 'working' ? 'bg-azure' : 'bg-ochre',
          ].join(' ')}
        >
          {claudeStatus === 'working' && (
            <div className="run-scan h-full w-1/3 bg-gradient-to-r from-transparent via-bg-card/85 to-transparent" />
          )}
        </div>
      )}

      {/* coordinate label, like a map index */}
      <div className="coord-label absolute -top-[7px] left-3 bg-bg-card px-1.5 text-ink-subtle">
        {coordFromId(project.id)}
      </div>

      {/* claude-status stamp, mirroring the coord label on the right margin */}
      {claudeStatus === 'working' && (
        // claude is busy — azure, with the dot pulsing while live.
        <div className="absolute -top-[7px] right-3 flex items-center gap-1 bg-bg-card px-1.5 label-cap text-azure">
          <span className="run-pulse h-[5px] w-[5px] rounded-full bg-azure" />
          <span>Running</span>
        </div>
      )}
      {claudeStatus === 'waiting' && (
        // claude is sitting on the human — "your turn". Amber for attention:
        // dot in the ochre token (3:1 graphics contrast is met), label in the
        // darkened amber var (≥4.5:1 on the card — raw ochre is only ~4:1 at
        // this size). Steady, no pulse: pulsing means "activity", and a
        // full-opacity stamp stays visible at a glance.
        <div className="absolute -top-[7px] right-3 flex items-center gap-1 bg-bg-card px-1.5 label-cap text-[var(--beacon-waiting)]">
          <span className="h-[5px] w-[5px] rounded-full bg-ochre" />
          <span>Waiting</span>
        </div>
      )}

      <div className="px-4 pt-4 pb-4">
        <div className="flex items-start gap-2.5">
          <div
            className={[
              'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center',
              'border rounded-[2px]',
              project.hasGit
                ? 'border-accent/40 bg-accent-soft text-accent'
                : 'border-line bg-bg-inset text-ink-subtle',
            ].join(' ')}
          >
            {project.hasGit ? (
              <GitBranch size={12} strokeWidth={2} />
            ) : (
              <FolderClosed size={12} strokeWidth={2} />
            )}
          </div>
          <div
            className="min-w-0 flex-1 truncate font-display text-[16px] leading-tight text-ink"
            style={{ fontVariationSettings: "'opsz' 18, 'SOFT' 30" }}
          >
            {project.name}
          </div>
          {project.openTaskCount > 0 && (
            <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[10px] font-medium tracking-[0.04em] text-accent">
              <span className="h-1 w-1 rounded-full bg-accent" />
              {project.openTaskCount} open
            </span>
          )}
          {project.missing && (
            <span className="mt-0.5 shrink-0 label-cap text-accent">missing</span>
          )}
        </div>

        <div className="mt-2.5">
          <p
            className={[
              'line-clamp-4',
              project.description
                ? 'text-[11.5px] leading-snug text-ink-muted'
                : 'font-mono text-[10px] text-ink-subtle',
            ].join(' ')}
          >
            {project.description || (project.missing ? 'Folder no longer exists — remove it from the Ground.' : project.path)}
          </p>
        </div>
      </div>
    </div>
  )
}
