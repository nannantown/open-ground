import {
  GitBranch,
  FolderClosed,
} from 'lucide-react'
import type { ProjectMeta } from '@/lib/types'

interface Props {
  project: ProjectMeta
  onPointerDown?: (e: React.PointerEvent) => void
  selected?: boolean
  active?: boolean
  /** True while the project has at least one live PTY (plain shell or claude
   *  session) — shows the pulsing "Terminal" beacon in the card header. */
  terminalActive?: boolean
}

const coordFromId = (id: string) => {
  const a = parseInt(id.slice(0, 2), 16) % 26
  const b = parseInt(id.slice(2, 4), 16) % 99
  return `${String.fromCharCode(65 + a)}·${String(b).padStart(2, '0')}`
}

// One project on the Ground: name + description, plus a small pulsing
// "Terminal" beacon while the project has a live PTY (the only "something is
// happening here" signal since the batch runner's edge bar was purged).
export const ProjectCard = ({
  project,
  onPointerDown,
  selected,
  active,
  terminalActive,
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
            : 'border-line shadow-card hover:shadow-card-hover hover:border-line-strong',
        project.missing ? 'opacity-50' : '',
      ].join(' ')}
    >
      {/* coordinate label, like a map index */}
      <div className="coord-label absolute -top-[7px] left-3 bg-bg-card px-1.5 text-ink-subtle">
        {coordFromId(project.id)}
      </div>

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
          {terminalActive && (
            // Non-interactive status beacon — moss (the theme's green) keeps
            // the label ≥4.5:1 on the paper card; the dot pulses while live.
            <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[10px] font-medium tracking-[0.04em] text-moss">
              <span className="term-pulse h-[5px] w-[5px] rounded-full bg-moss" />
              Terminal
            </span>
          )}
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
