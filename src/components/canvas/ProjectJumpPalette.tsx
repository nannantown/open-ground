import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, FolderOpen, Archive } from 'lucide-react'
import type { ProjectMeta } from '@/lib/types'

interface Props {
  open: boolean
  projects: ProjectMeta[]
  onClose: () => void
  /** Called when a project is picked — page.tsx selects it and centres on its card. */
  onPick: (project: ProjectMeta) => void
}

// Fast, forgiving subsequence match — every char of the query (lowercased)
// must appear in order somewhere in `name`. Adjacent matches and prefix
// matches score higher so "pmm" beats "p-m-m" beats nothing.
const fuzzyScore = (name: string, q: string): number | null => {
  if (!q) return 0
  const hay = name.toLowerCase()
  const needle = q.toLowerCase()
  let hi = 0
  let score = 0
  let lastIdx = -2
  for (let i = 0; i < needle.length; i++) {
    const c = needle[i]
    const found = hay.indexOf(c, hi)
    if (found < 0) return null
    score += found - hi // earlier matches cost less
    if (found === lastIdx + 1) score -= 4 // adjacent bonus
    if (found === 0) score -= 6 // prefix bonus
    lastIdx = found
    hi = found + 1
  }
  return score
}

export const ProjectJumpPalette = ({ open, projects, onClose, onPick }: Props) => {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const matches = useMemo(() => {
    const q = query.trim()
    if (!q) {
      // Empty query: show recents first (projects come in mtime-desc from the scanner).
      return projects.slice(0, 12)
    }
    const scored: { p: ProjectMeta; s: number }[] = []
    for (const p of projects) {
      const s = fuzzyScore(p.name, q)
      if (s !== null) scored.push({ p, s })
    }
    scored.sort((a, b) => a.s - b.s)
    return scored.slice(0, 12).map((x) => x.p)
  }, [projects, query])

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
      e.preventDefault()
      const pick = matches[active]
      if (pick) onPick(pick)
    }
  }

  return (
    <div
      data-esc-overlay
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 backdrop-blur-sm pt-[14vh]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        className="flex flex-col w-[520px] max-w-[92vw] max-h-[68vh] bg-bg-card border border-line shadow-card-hover overflow-hidden rounded-[3px]"
      >
        <div className="shrink-0 flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search size={14} className="text-ink-faint shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to project…"
            className="flex-1 min-w-0 bg-transparent text-[14px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <span className="label-cap text-ink-faint shrink-0">esc</span>
        </div>

        <div ref={listRef} className="overflow-y-auto py-1.5">
          {matches.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-ink-subtle">
              No projects match
            </p>
          ) : (
            matches.map((p, i) => (
              <button
                key={p.id}
                onClick={() => onPick(p)}
                onMouseEnter={() => setActive(i)}
                className={[
                  'group flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors',
                  i === active
                    ? 'bg-bg-inset'
                    : 'hover:bg-bg-inset/60',
                ].join(' ')}
              >
                {p.missing ? (
                  <Archive size={12} className="shrink-0 text-accent" />
                ) : (
                  <FolderOpen size={12} className="shrink-0 text-ink-faint" />
                )}
                <span className="truncate text-[13px] text-ink">{p.name}</span>
                {p.openTaskCount > 0 && (
                  <span className="ml-auto shrink-0 label-cap text-accent">
                    {p.openTaskCount} open
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
