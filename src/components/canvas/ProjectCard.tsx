import { useEffect, useState } from 'react'
import {
  GitBranch,
  FolderClosed,
  Check,
  AlertCircle,
  Minus,
  FileText,
  Sparkles,
} from 'lucide-react'
import type { ProjectMeta, RunStatusInfo, RunSummaryInfo } from '@/lib/types'
import { fmtElapsed, RUN_KIND } from '@/lib/runStatus'
import { migrateLs } from '@/lib/lsMigrate'

interface Props {
  project: ProjectMeta
  onPointerDown?: (e: React.PointerEvent) => void
  selected?: boolean
  active?: boolean
  run?: RunStatusInfo
  summary?: RunSummaryInfo
}

// Per-card hero preference (run-narrative vs description). Kept in localStorage
// so a flip survives reloads and is project-specific. Absence means "default":
// show the run summary when one exists, otherwise the description.
const HERO_KEY = 'openground.cardHero'
type HeroChoice = 'run' | 'description'

// Walk older namespaces forward to the current one. Cheap to run on every
// read; the helper short-circuits once the new key is populated.
const migrateHeroKey = () => {
  migrateLs('hove.cardHero', HERO_KEY)
  migrateLs('pmmap.cardHero', HERO_KEY)
}

const readHero = (id: string): HeroChoice | undefined => {
  if (typeof window === 'undefined') return undefined
  migrateHeroKey()
  try {
    const raw = window.localStorage.getItem(HERO_KEY)
    if (!raw) return undefined
    const map = JSON.parse(raw) as Record<string, HeroChoice>
    return map[id]
  } catch {
    return undefined
  }
}
const writeHero = (id: string, next: HeroChoice | undefined) => {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(HERO_KEY)
    const map = (raw ? JSON.parse(raw) : {}) as Record<string, HeroChoice>
    if (next === undefined) delete map[id]
    else map[id] = next
    window.localStorage.setItem(HERO_KEY, JSON.stringify(map))
  } catch {
    /* localStorage full or disabled — silent */
  }
}

const fmtAgo = (iso?: string) => {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const coordFromId = (id: string) => {
  const a = parseInt(id.slice(0, 2), 16) % 26
  const b = parseInt(id.slice(2, 4), 16) % 99
  return `${String.fromCharCode(65 + a)}·${String(b).padStart(2, '0')}`
}

type RunStatus = RunStatusInfo['status']

// Each run state gets a top-edge colour and a stamp colour, kept within the
// cartographic palette: accent (burnt red) for live/failed, moss for done.
const RUN_STYLE: Record<RunStatus, { bar: string; text: string; label: string }> = {
  pending: { bar: 'bg-line-strong', text: 'text-ink-subtle', label: 'Queued' },
  running: { bar: 'bg-azure', text: 'text-azure', label: 'Running' },
  done: { bar: 'bg-moss', text: 'text-moss', label: 'Done' },
  error: { bar: 'bg-accent', text: 'text-accent', label: 'Error' },
  cancelled: { bar: 'bg-ink-faint', text: 'text-ink-subtle', label: 'Cancelled' },
}

export const ProjectCard = ({
  project,
  onPointerDown,
  selected,
  active,
  run,
  summary,
}: Props) => {
  const running = run?.status === 'running'
  // Pref defaults to "run" when a summary exists. Explicit choice wins.
  const [heroPref, setHeroPref] = useState<HeroChoice | undefined>(undefined)
  useEffect(() => {
    setHeroPref(readHero(project.id))
  }, [project.id])
  const showRun = summary && (heroPref ?? 'run') === 'run'
  const canToggle = !!summary
  const flipHero = (e: React.MouseEvent) => {
    e.stopPropagation()
    const next: HeroChoice = showRun ? 'description' : 'run'
    setHeroPref(next)
    writeHero(project.id, next)
  }

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
            : running
              ? 'border-line-strong shadow-card-hover'
              : 'border-line shadow-card hover:shadow-card-hover hover:border-line-strong',
        project.archived ? 'opacity-60' : '',
      ].join(' ')}
    >
      {/* run-status edge — a surveyor's marking along the card's top */}
      {run && (
        <div
          className={[
            'absolute left-0 right-0 top-0 h-[3px] overflow-hidden rounded-t-[2px]',
            RUN_STYLE[run.status].bar,
          ].join(' ')}
        >
          {running && (
            <div className="run-scan h-full w-1/3 bg-gradient-to-r from-transparent via-bg-card/85 to-transparent" />
          )}
        </div>
      )}

      {/* coordinate label, like a map index */}
      <div className="coord-label absolute -top-[7px] left-3 bg-bg-card px-1.5 text-ink-subtle">
        {coordFromId(project.id)}
      </div>

      {/* run-status stamp, mirroring the coord label on the right margin */}
      {run && <RunStamp run={run} />}

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
          {project.archived && (
            <span className="mt-0.5 shrink-0 label-cap text-ink-subtle">archived</span>
          )}
        </div>

        <div className="mt-2.5 relative">
          {showRun ? (
            <RunHero summary={summary!} />
          ) : (
            <p
              className={[
                'line-clamp-4',
                project.description
                  ? 'text-[11.5px] leading-snug text-ink-muted'
                  : 'font-mono text-[10px] text-ink-subtle',
              ].join(' ')}
            >
              {project.description || project.relativePath}
            </p>
          )}
          {canToggle && (
            <button
              onClick={flipHero}
              onPointerDown={(e) => e.stopPropagation()}
              title={showRun ? 'Show description' : 'Show last run'}
              className="absolute -bottom-1 -right-1 z-10 rounded-sm p-0.5 text-ink-faint opacity-0 transition-opacity hover:bg-bg-inset hover:text-ink-muted group-hover:opacity-100"
            >
              {showRun ? <FileText size={11} /> : <Sparkles size={11} />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// The "last run" hero: a small status line + truncated summary. Mirrors the
// description's height budget (line-clamp ≈ 4 lines of body text) so toggling
// doesn't reshuffle the card geometry.
const RunHero = ({ summary }: { summary: RunSummaryInfo }) => {
  const k = RUN_KIND[summary.kind]
  const ago = fmtAgo(summary.finishedAt)
  // Question > blockers > summary — a pending question is the most actionable
  // thing the user can see at a glance.
  const body = summary.question || summary.blockers || summary.summary
  const tone = summary.question
    ? 'text-azure'
    : summary.blockers
      ? 'text-ochre'
      : 'text-ink-muted'
  const prefix = summary.question ? '? ' : summary.blockers ? '⚠ ' : ''
  return (
    <div>
      <div className="flex items-baseline gap-1.5 mb-1">
        <span
          className={[
            'label-cap',
            summary.question ? 'text-azure' : k.text,
          ].join(' ')}
        >
          {summary.question ? '返事待ち' : k.label}
        </span>
        {ago && <span className="text-[10px] text-ink-subtle">{ago}</span>}
      </div>
      {body ? (
        <p
          className={[
            'line-clamp-3 text-[11.5px] leading-snug',
            tone,
          ].join(' ')}
        >
          {prefix}
          {body}
        </p>
      ) : (
        <p className="text-[11px] italic text-ink-faint">
          {summary.taskTitle || 'No summary'}
        </p>
      )}
    </div>
  )
}

// A field-survey stamp on the card's right margin: glyph + state + clock.
const RunStamp = ({ run }: { run: RunStatusInfo }) => {
  const running = run.status === 'running'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  const style = RUN_STYLE[run.status]

  let clock = ''
  if (run.startedAt) {
    const start = Date.parse(run.startedAt)
    const end = running ? now : run.finishedAt ? Date.parse(run.finishedAt) : now
    if (end >= start) clock = fmtElapsed(end - start)
  }

  return (
    <div
      className={[
        'absolute -top-[7px] right-3 flex items-center gap-1 bg-bg-card px-1.5 label-cap',
        style.text,
      ].join(' ')}
    >
      <RunGlyph status={run.status} />
      <span>{style.label}</span>
      {clock && (
        <span className="font-mono text-[9px] normal-case tracking-normal opacity-70">
          {clock}
        </span>
      )}
    </div>
  )
}

const RunGlyph = ({ status }: { status: RunStatus }) => {
  if (status === 'running')
    return <span className="run-pulse h-[5px] w-[5px] rounded-full bg-azure" />
  if (status === 'pending')
    return <span className="h-[5px] w-[5px] rounded-full border border-ink-subtle" />
  if (status === 'done') return <Check size={9} strokeWidth={3} />
  if (status === 'error') return <AlertCircle size={9} strokeWidth={2.5} />
  return <Minus size={9} strokeWidth={3} />
}
