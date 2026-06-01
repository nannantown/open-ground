import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Sparkles } from 'lucide-react'
import type { SkillInfo } from '@/lib/types'

interface Props {
  /** Project root — feeds the API so project-scope skills (`<root>/.claude/skills/`)
   *  surface alongside the user's global ones. Pass `undefined` to list user-scope only. */
  projectPath?: string
  /** Currently selected skill name (null = no skill / "なし"). */
  value: string | null
  onChange: (next: string | null) => void
}

interface ApiResponse { skills: SkillInfo[] }

interface PopoverPos {
  top: number
  left: number
  width: number
  maxHeight: number
  direction: 'up' | 'down'
}

// Dropdown-style picker for the Canvas chat composer. A slim trigger button
// shows the current selection; clicking it opens a portal-rendered popover
// of cards (each with the skill's raw name as the title and a one-line
// description below). Portal + fixed positioning escape any ancestor
// `overflow: hidden` so the popover never gets clipped by the sidebar.
//
// The popover prefers to open upward (the picker sits at the bottom of a
// sidebar) but auto-flips downward if there isn't enough room.
export const SkillPicker = ({ projectPath, value, onChange }: Props) => {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PopoverPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const url = projectPath
      ? `/api/skills?projectPath=${encodeURIComponent(projectPath)}`
      : '/api/skills'
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ApiResponse) => {
        setSkills(Array.isArray(d.skills) ? d.skills : [])
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [projectPath])

  // Compute popover placement: prefer "open upward" (composer sits at the
  // bottom of the sidebar) and flip to downward only when the upward room
  // is unworkably small. maxHeight is clamped to viewport so the popover
  // always fully fits without scrolling the page.
  const computePos = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return null
    const margin = 8
    const spaceAbove = rect.top - margin
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const direction: 'up' | 'down' = spaceAbove >= 220 || spaceAbove >= spaceBelow ? 'up' : 'down'
    const maxHeight = Math.min(direction === 'up' ? spaceAbove : spaceBelow, 520)
    const minWidth = 320
    const width = Math.max(rect.width, minWidth)
    // Clamp left so a narrow sidebar at the left edge doesn't push the
    // popover off-screen on the right.
    const left = Math.min(rect.left, window.innerWidth - width - margin)
    return {
      top: direction === 'up' ? rect.top - 6 : rect.bottom + 6,
      left: Math.max(margin, left),
      width,
      maxHeight,
      direction,
    }
  }

  useLayoutEffect(() => {
    if (!open) return
    const update = () => setPos(computePos())
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  // Dismiss on outside click or Escape — standard popover hygiene so the
  // user never feels trapped if they opened it by mistake.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (popoverRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = useMemo(
    () => skills.find((s) => s.name === value) ?? null,
    [skills, value],
  )

  const pick = (name: string | null) => {
    onChange(name)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          'group flex w-full items-center gap-1.5 rounded-[4px] border px-2.5 py-1.5 text-left text-[12px] transition-colors',
          open
            ? 'border-line-strong bg-bg text-ink'
            : 'border-line bg-transparent text-ink-muted hover:border-line-strong hover:text-ink',
        ].join(' ')}
      >
        <Sparkles size={11} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
        <span className="text-ink-faint">スキル</span>
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          {selected ? selected.name : 'なし'}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={['shrink-0 text-ink-faint transition-transform', open ? 'rotate-180' : ''].join(' ')}
        />
      </button>

      {open && pos && typeof window !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            role="listbox"
            aria-label="デザインスキルを選ぶ"
            style={{
              position: 'fixed',
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              ...(pos.direction === 'up'
                ? { bottom: window.innerHeight - pos.top }
                : { top: pos.top }),
            }}
            className="z-50 overflow-y-auto rounded-[8px] border border-line-strong bg-bg-card shadow-[0_16px_48px_rgba(0,0,0,0.22)]"
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line-soft bg-bg-card px-3 py-2 label-cap text-ink-faint">
              <span>デザインスキル</span>
              <span className="text-[10px] normal-case tracking-normal text-ink-faint">
                {skills.length > 0 ? `${skills.length} スタイル` : ''}
              </span>
            </div>
            <ul className="py-1">
              <Item
                active={value === null}
                title="なし"
                blurb="スキルを使わずに送信"
                onClick={() => pick(null)}
              />
              {!loaded && (
                <li className="px-3 py-3 text-[11.5px] text-ink-faint">読み込み中…</li>
              )}
              {loaded && skills.length === 0 && (
                <li className="px-3 py-3 text-[11.5px] text-ink-faint">
                  デザインスキルが見つかりません
                </li>
              )}
              {skills.map((s) => (
                <Item
                  key={s.name}
                  active={value === s.name}
                  title={s.name}
                  blurb={s.description}
                  onClick={() => pick(s.name)}
                />
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </>
  )
}

const Item = ({
  active,
  title,
  blurb,
  onClick,
}: {
  active: boolean
  title: string
  blurb?: string
  onClick: () => void
}) => (
  <li>
    <button
      type="button"
      onClick={onClick}
      role="option"
      aria-selected={active}
      className={[
        'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors',
        active ? 'bg-bg' : 'hover:bg-bg',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={[
          'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
          active ? 'border-ink bg-ink text-bg' : 'border-line bg-transparent',
        ].join(' ')}
      >
        {active && <Check size={9} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={[
            'block truncate text-[13px]',
            active ? 'font-semibold text-ink' : 'font-medium text-ink',
          ].join(' ')}
        >
          {title}
        </span>
        {blurb && (
          <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">{blurb}</span>
        )}
      </span>
    </button>
  </li>
)
