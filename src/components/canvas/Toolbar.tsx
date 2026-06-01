import {
  RefreshCw,
  Settings,
  Compass,
  FolderPlus,
  MessageSquare,
  CircleUser,
} from 'lucide-react'

interface Props {
  onRefresh: () => void
  onNewProject: () => void
  onOpenSettings: () => void
  /** Provided only when in-app feedback is configured (env-gated server-side);
   *  when undefined the feedback entry is hidden, so the public build is clean. */
  onFeedback?: () => void
  /** Provided only when the optional app login is configured (env-gated
   *  server-side, same Supabase env as feedback); undefined hides the account
   *  entry so the public build (no env) shows nothing. */
  onAccount?: () => void
  projectsRoot: string | null
  projectCount: number
  archivedCount: number
  showArchived: boolean
  onToggleArchived: () => void
  refreshing?: boolean
}

export const Toolbar = ({
  onRefresh,
  onNewProject,
  onOpenSettings,
  onFeedback,
  onAccount,
  projectsRoot,
  projectCount,
  archivedCount,
  showArchived,
  onToggleArchived,
  refreshing,
}: Props) => {
  return (
    <>
      {/* Top-left wordmark */}
      <div className="pointer-events-none absolute top-0 left-0 right-0 z-10 flex items-start justify-between gap-3 p-5">
        <div className="pointer-events-auto flex items-center gap-3.5 bg-bg-card/95 backdrop-blur border border-line rounded-[3px] pl-3 pr-4 py-2 shadow-card">
          <Compass size={15} strokeWidth={1.5} className="text-accent shrink-0" />
          <div className="flex items-baseline gap-2">
            <span
              className="font-display text-[18px] leading-none text-ink tracking-tight"
              style={{ fontVariationSettings: "'opsz' 20, 'SOFT' 50" }}
            >
              OPEN GROUND
            </span>
            <span className="label-cap text-ink-subtle">the shore for your work</span>
          </div>
          {projectsRoot && (
            <>
              <span className="text-line-strong text-[14px] leading-none">·</span>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-ink-muted">{shortenPath(projectsRoot)}</span>
                <span className="text-ink-faint">·</span>
                <span className="text-ink-subtle tracking-[0.04em] tabular-nums">
                  {projectCount} {projectCount === 1 ? 'project' : 'projects'}
                </span>
                {archivedCount > 0 && (
                  <>
                    <span className="text-ink-faint">·</span>
                    <button
                      onClick={onToggleArchived}
                      title={
                        showArchived
                          ? 'Hide archived projects'
                          : 'Show archived projects'
                      }
                      className={[
                        '-mx-1 rounded-[2px] px-1 tracking-[0.04em] tabular-nums transition-colors',
                        showArchived
                          ? 'text-accent'
                          : 'text-ink-faint hover:text-ink-muted',
                      ].join(' ')}
                    >
                      {archivedCount} archived
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          <div className="flex items-center gap-0 bg-bg-card/95 backdrop-blur border border-line rounded-[3px] p-0.5 shadow-card">
            <IconButton
              onClick={onNewProject}
              title="新規プロジェクト"
              disabled={!projectsRoot}
            >
              <FolderPlus size={13} strokeWidth={1.75} />
            </IconButton>
            <span className="h-4 w-px bg-line-soft" />
            <IconButton onClick={onRefresh} title="再読み込み" spin={refreshing}>
              <RefreshCw size={13} strokeWidth={1.75} />
            </IconButton>
            {onFeedback && (
              <>
                <span className="h-4 w-px bg-line-soft" />
                <IconButton onClick={onFeedback} title="フィードバックを送る">
                  <MessageSquare size={13} strokeWidth={1.75} />
                </IconButton>
              </>
            )}
            {onAccount && (
              <>
                <span className="h-4 w-px bg-line-soft" />
                <IconButton onClick={onAccount} title="アカウント">
                  <CircleUser size={13} strokeWidth={1.75} />
                </IconButton>
              </>
            )}
            <span className="h-4 w-px bg-line-soft" />
            <IconButton onClick={onOpenSettings} title="設定">
              <Settings size={13} strokeWidth={1.75} />
            </IconButton>
          </div>
        </div>
      </div>

    </>
  )
}

const IconButton = ({
  children,
  onClick,
  title,
  spin,
  active,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  spin?: boolean
  active?: boolean
  disabled?: boolean
}) => (
  <button
    onClick={onClick}
    title={title}
    aria-label={title}
    aria-pressed={active}
    disabled={disabled}
    className={[
      'flex h-7 w-7 items-center justify-center rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
      active
        ? 'bg-accent-soft text-accent'
        : 'text-ink-muted hover:text-ink hover:bg-bg-inset',
    ].join(' ')}
  >
    <span className={spin ? 'animate-spin inline-flex' : 'inline-flex'}>{children}</span>
  </button>
)

const shortenPath = (path: string) => {
  const home = '/Users/'
  if (path.length <= 36) return path
  if (path.startsWith(home)) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length > 3) return `~/${parts.slice(2).slice(-2).join('/')}`
  }
  return `…${path.slice(-32)}`
}
