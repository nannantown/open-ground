import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, FolderOpen, Archive } from 'lucide-react'
import { Overlay, DialogCard } from '@/components/ui/overlay'
import type { ProjectMeta } from '@/lib/types'
import type { GroundLamp } from '@/lib/groundLamp'
import { matchProjects, readRecentProjects } from '@/lib/groundJump'
import { useT } from '@/i18n/I18nContext'

interface Props {
  open: boolean
  projects: ProjectMeta[]
  onClose: () => void
  /** Called when a project is picked — App flies the Ground to its card. */
  onPick: (project: ProjectMeta) => void
  /** Same lamps the Ground cards draw — shown per row so "running / your turn"
   *  is visible while searching. */
  lamps?: ReadonlyMap<string, GroundLamp>
}

// The Ground's project search (⌘K, or the toolbar's search pill). Matching
// lives in lib/groundJump.ts: name (fuzzy) or description (substring); an
// empty query lists recently opened projects first.
export const ProjectJumpPalette = ({ open, projects, onClose, onPick, lamps }: Props) => {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      setRecent(readRecentProjects())
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const matches = useMemo(
    () => matchProjects(projects, query, recent),
    [projects, query, recent],
  )

  // Clamp the selection to the new list length whenever matches change.
  useEffect(() => {
    setActive((i) => (matches.length ? Math.min(i, matches.length - 1) : 0))
  }, [matches])

  // Keep the active row scrolled into view when navigating with arrows.
  useEffect(() => {
    const el = listRef.current?.children.item(active) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, Math.max(0, matches.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      // IME: the Enter that confirms a Japanese conversion must not pick.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      const pick = matches[active]
      if (pick) onPick(pick)
    }
  }

  return (
    <Overlay
      placement="top"
      onClose={onClose}
      closeOnEsc={false}
      aria-label={t('toolbar.search')}
    >
      <DialogCard
        className="w-[560px] max-w-[92vw] max-h-[68vh]"
        onKeyDown={onKey}
        ariaLabel={t('toolbar.search')}
      >
        <div className="shrink-0 flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search size={14} className="text-ink-faint shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('toolbar.searchPlaceholder')}
            className="flex-1 min-w-0 bg-transparent text-read text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <span className="label-cap label-cap-latin text-ink-faint shrink-0">esc</span>
        </div>

        <div ref={listRef} className="overflow-y-auto py-1.5">
          {matches.length === 0 ? (
            <p className="px-4 py-6 text-center text-ui text-ink-subtle">
              {t('toolbar.searchNoMatch')}
            </p>
          ) : (
            matches.map((p, i) => {
              const lamp = lamps?.get(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPick(p)}
                  onMouseEnter={() => setActive(i)}
                  className={[
                    'group flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                    i === active ? 'bg-bg-inset' : 'hover:bg-plane/60',
                  ].join(' ')}
                >
                  {p.missing ? (
                    <Archive size={12} className="shrink-0 text-accent" />
                  ) : (
                    <FolderOpen size={12} className="shrink-0 text-ink-faint" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui text-ink">{p.name}</span>
                    {p.description && (
                      <span className="block truncate text-meta text-ink-subtle">{p.description}</span>
                    )}
                  </span>
                  {lamp === 'working' && (
                    <span className="flex shrink-0 items-center gap-1 label-cap text-moss-text">
                      <span className="run-pulse h-[5px] w-[5px] rounded-full bg-moss" />
                      {t('toolbar.searchLampWorking')}
                    </span>
                  )}
                  {lamp === 'waiting' && (
                    <span className="flex shrink-0 items-center gap-1 label-cap text-[var(--beacon-waiting)]">
                      <span className="h-[5px] w-[5px] rounded-full bg-ochre" />
                      {t('toolbar.searchLampWaiting')}
                    </span>
                  )}
                  {p.openTaskCount > 0 && (
                    <span className="shrink-0 label-cap label-cap-latin text-accent">
                      {p.openTaskCount} open
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
        <div className="shrink-0 border-t border-line-soft px-4 py-2 text-meta text-ink-faint">
          {t('toolbar.searchHint')}
        </div>
      </DialogCard>
    </Overlay>
  )
}
