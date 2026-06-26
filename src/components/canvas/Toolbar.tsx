import { useEffect, useRef, useState } from 'react'
import {
  Settings,
  FolderPlus,
  FolderInput,
  MessageSquare,
  Plus,
  LogOut,
  CircleUser,
  HelpCircle,
  Sparkles,
  Users,
} from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { useAuth } from '@/lib/auth/AuthContext'
import { OpenGroundMark } from '@/components/canvas/OpenGroundMark'

interface Props {
  onNewProject: () => void
  onImport: () => void
  onOpenSettings: () => void
  /** Opens the full-screen in-app manual (the "?" entry). Always available. */
  onOpenManual: () => void
  /** Opens the global skills panel (the user's own ~/.claude/skills — view +
   *  create). Always available. */
  onOpenSkills: () => void
  /** Opens the "Shared with me" join dialog (paste an invite code or link →
   *  join a collaborator's project). Provided ONLY when realtime collab is
   *  enabled — undefined hides the entry, so the default build shows nothing.
   *  This is the member's entry to the INITIAL join (already-joined projects also
   *  surface as Ground cards, but the first join needs this dialog). */
  onOpenShared?: () => void
  /** Provided only when in-app feedback is configured (env-gated server-side);
   *  surfaces a "Feedback" item inside the account menu. */
  onFeedback?: () => void
  /** Provided only when the optional app login is configured (env-gated
   *  server-side); undefined hides the account control so the public build
   *  (no env) shows nothing. */
  onAccount?: () => void
  projectCount: number
  /** Count of feedback submissions not yet seen (owner build only). >0 shows a
   *  small dot on the settings gear; the inbox lives inside Settings. */
  unreadFeedback?: number
  /** Slim usage strip rendered to the LEFT of the control pill, inside the same
   *  flex row, so the two never overlap. */
  usage?: React.ReactNode
}

// Ground top bar. Kept deliberately minimal: a single "+" (new / import), the
// account control (avatar + menu when signed in), and Settings. Language lives
// in Settings now (auto-detected from the OS otherwise), and refresh is ⌘R /
// auto-on-focus — so neither needs a permanent button here.
export const Toolbar = ({
  onNewProject,
  onImport,
  onOpenSettings,
  onOpenManual,
  onOpenSkills,
  onOpenShared,
  onFeedback,
  onAccount,
  projectCount,
  unreadFeedback = 0,
  usage,
}: Props) => {
  const { t } = useT()
  return (
    <div className="pointer-events-none absolute top-0 left-0 right-0 z-10 flex items-start justify-between gap-3 p-5">
      {/* Top-left wordmark */}
      <div className="pointer-events-auto flex min-w-0 items-center gap-3.5 overflow-hidden bg-bg-card/95 backdrop-blur border border-line rounded-[3px] pl-3 pr-4 py-2 shadow-card">
        {/* Mark + wordmark are their own items-center group with a tighter gap so
            they read as one lockup; the tagline keeps its baseline relationship
            to the wordmark inside a nested leading-none group (its line-box would
            otherwise inflate the wrapper and push the wordmark off the mark's
            centre). The outer gap-3.5 still spaces the · / project count. */}
        <div className="flex min-w-0 items-center gap-2">
          <OpenGroundMark size={18} className="shrink-0 select-none" />
          <img
            src="/brand/openground-wordmark.svg"
            alt="OPEN GROUND"
            className="h-[15px] w-auto shrink-0 select-none"
            draggable={false}
          />
          {/* Beta tag — OPEN GROUND is still beta; breaking changes may land. */}
          <span
            // inline-flex + a 1px-top-heavy pad optically centres the all-caps
            // glyphs (a tight uppercase line-box leaves empty descender space at
            // the bottom, which otherwise makes the text sit high).
            className="inline-flex shrink-0 select-none items-center rounded-[3px] border border-accent/40 bg-accent/10 px-1.5 pt-[3px] pb-[2px] text-[9px] font-semibold uppercase leading-none tracking-wide text-accent"
            title={t('toolbar.betaTooltip')}
          >
            Beta
          </span>
          <span className="hidden xl:inline truncate label-cap leading-none text-ink-subtle">the shore for your work</span>
        </div>
        {projectCount > 0 && (
          <>
            <span className="text-line-strong text-[14px] leading-none">·</span>
            <span className="text-[11px] text-ink-subtle tracking-[0.04em] tabular-nums">
              {projectCount} {projectCount === 1 ? 'project' : 'projects'}
            </span>
          </>
        )}
      </div>

      <div className="pointer-events-auto flex shrink-0 items-center gap-3">
        {usage && <div className="hidden md:flex items-center">{usage}</div>}
        {/* Standalone, always-visible feedback button. The app is in beta and we
            want feedback actively, so it's surfaced as its own labelled pill
            rather than buried in the account menu. */}
        {onFeedback && (
          <button
            type="button"
            onClick={onFeedback}
            title={t('toolbar.feedback')}
            className="flex items-center gap-1.5 bg-bg-card/95 backdrop-blur border border-line rounded-[3px] px-3 py-2 shadow-card text-[12px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <MessageSquare size={13} strokeWidth={1.75} />
            <span>{t('toolbar.feedback')}</span>
          </button>
        )}
        <div className="flex items-center gap-0 bg-bg-card/95 backdrop-blur border border-line rounded-[3px] p-0.5 shadow-card">
          <AddMenu onNewProject={onNewProject} onImport={onImport} />
          {onAccount && (
            <>
              <span className="h-4 w-px bg-line-soft" />
              <AccountControl onAccount={onAccount} />
            </>
          )}
          {onOpenShared && (
            <>
              <span className="h-4 w-px bg-line-soft" />
              <IconButton onClick={onOpenShared} title={t('toolbar.sharedWithMe')}>
                <Users size={13} strokeWidth={1.75} />
              </IconButton>
            </>
          )}
          <span className="h-4 w-px bg-line-soft" />
          <IconButton onClick={onOpenSkills} title={t('toolbar.skills')}>
            <Sparkles size={13} strokeWidth={1.75} />
          </IconButton>
          <span className="h-4 w-px bg-line-soft" />
          <IconButton onClick={onOpenManual} title={t('toolbar.manual')}>
            <HelpCircle size={14} strokeWidth={1.75} />
          </IconButton>
          <span className="h-4 w-px bg-line-soft" />
          <IconButton
            onClick={onOpenSettings}
            title={
              unreadFeedback > 0
                ? t('toolbar.settingsWithUnread', { count: unreadFeedback })
                : t('toolbar.settings')
            }
            dot={unreadFeedback > 0}
          >
            <Settings size={13} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

// "+" → a small popover offering New project / Import folder. Collapses the two
// former toolbar buttons into one entry so the bar stays uncluttered.
const AddMenu = ({
  onNewProject,
  onImport,
}: {
  onNewProject: () => void
  onImport: () => void
}) => {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <IconButton onClick={() => setOpen((o) => !o)} title={t('toolbar.add')} active={open}>
        <Plus size={14} strokeWidth={2} />
      </IconButton>
      {open && (
        <Menu>
          <MenuItem
            icon={<FolderPlus size={13} strokeWidth={1.75} />}
            label={t('toolbar.newProject')}
            onClick={() => {
              setOpen(false)
              onNewProject()
            }}
          />
          <MenuItem
            icon={<FolderInput size={13} strokeWidth={1.75} />}
            label={t('toolbar.importFolder')}
            onClick={() => {
              setOpen(false)
              onImport()
            }}
          />
        </Menu>
      )}
    </div>
  )
}

// Always-present account entry. Signed out → an icon that opens the sign-in
// modal. Signed in → the user's avatar, opening a menu with sign out.
const AccountControl = ({
  onAccount,
}: {
  onAccount: () => void
}) => {
  const { t } = useT()
  const { user, status, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (status !== 'signed-in' || !user) {
    return (
      <IconButton onClick={onAccount} title={t('toolbar.signIn')}>
        <CircleUser size={13} strokeWidth={1.75} />
      </IconButton>
    )
  }

  const initials = (user.name || user.email || '?').trim().charAt(0).toUpperCase()
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t('toolbar.account')}
        aria-label={t('toolbar.account')}
        aria-pressed={open}
        className="flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="h-5 w-5 rounded-full object-cover ring-1 ring-line"
          />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent text-[10px] font-medium leading-none">
            {initials}
          </span>
        )}
      </button>
      {open && (
        <Menu>
          <div className="mb-1 border-b border-line-soft px-3 pb-2 pt-1">
            {user.name && (
              <div className="truncate text-[12px] font-medium leading-tight text-ink">
                {user.name}
              </div>
            )}
            {user.email && (
              <div className="truncate text-[11px] leading-tight text-ink-subtle">
                {user.email}
              </div>
            )}
          </div>
          <MenuItem
            icon={<LogOut size={13} strokeWidth={1.75} />}
            label={t('toolbar.signOut')}
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
          />
        </Menu>
      )}
    </div>
  )
}

const Menu = ({ children }: { children: React.ReactNode }) => (
  <div className="absolute right-0 top-full z-20 mt-1.5 min-w-[190px] rounded-[3px] border border-line bg-bg-card py-1 shadow-card-hover">
    {children}
  </div>
)

const MenuItem = ({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
  >
    <span className="text-ink-faint">{icon}</span>
    {label}
  </button>
)

const IconButton = ({
  children,
  onClick,
  title,
  active,
  disabled,
  dot,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  active?: boolean
  disabled?: boolean
  /** Small accent dot in the top-right corner — an unread/attention marker. */
  dot?: boolean
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    aria-pressed={active}
    disabled={disabled}
    className={[
      'relative flex h-7 w-7 items-center justify-center rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      active
        ? 'bg-accent-soft text-accent'
        : 'text-ink-muted hover:text-ink hover:bg-bg-inset',
    ].join(' ')}
  >
    {children}
    {dot && (
      <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-bg-card" />
    )}
  </button>
)
