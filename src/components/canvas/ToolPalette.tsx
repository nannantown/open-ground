import { MousePointer2, Type, StickyNote, Frame, Square, Circle, MessageSquareText, Image as ImageIcon, Sparkles } from 'lucide-react'
import type { Tool } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'

// Tools that only make sense on the per-project Canvas (embedded variant):
// per-project assets, comment pins, and the shape primitives. The top-level
// Ground portal is for project cards / frames, so these are filtered out there.
const EMBEDDED_ONLY: ReadonlySet<Tool> = new Set<Tool>([
  'comment',
  'image',
  'rect',
  'ellipse',
])

interface Props {
  tool: Tool
  onToolChange: (t: Tool) => void
  /** 'page' for the top-level canvas (fixed to the viewport),
   *  'embedded' when sitting inside another scroll container — e.g. the
   *  project-level Canvas tab. Embedded mode positions the palette
   *  absolutely within its nearest positioned ancestor. */
  variant?: 'page' | 'embedded'
  /** Project-Canvas-only: opens the "generate with Claude" prompt bar. A
   *  press action, not a tool — the button never reads as selected. Absent
   *  (e.g. on the Ground portal) the button doesn't render. */
  onGenerate?: () => void
}

const TOOLS: { id: Tool; label: string; icon: React.ReactNode }[] = [
  { id: 'select', label: 'Select / Move (V)', icon: <MousePointer2 size={15} strokeWidth={1.75} /> },
  { id: 'text', label: 'Text (T)', icon: <Type size={15} strokeWidth={1.75} /> },
  { id: 'sticky', label: 'Sticky note (S)', icon: <StickyNote size={15} strokeWidth={1.75} /> },
  { id: 'frame', label: 'Frame — drag to draw (F)', icon: <Frame size={15} strokeWidth={1.75} /> },
  { id: 'rect', label: 'Rectangle — drag to draw (R)', icon: <Square size={15} strokeWidth={1.75} /> },
  { id: 'ellipse', label: 'Ellipse — drag to draw (O)', icon: <Circle size={15} strokeWidth={1.75} /> },
  {
    id: 'comment',
    label: 'Comment — click to drop a pin (C)',
    icon: <MessageSquareText size={15} strokeWidth={1.75} />,
  },
  {
    id: 'image',
    label: 'Image — paste / drop / click to upload (I)',
    icon: <ImageIcon size={15} strokeWidth={1.75} />,
  },
]

export const ToolPalette = ({ tool, onToolChange, variant = 'page', onGenerate }: Props) => {
  const { t: tr } = useT()
  return (
    <div
      className={[
        'pointer-events-none z-20 -translate-y-1/2 p-4',
        variant === 'embedded'
          ? 'absolute left-0 top-1/2'
          : 'fixed left-0 top-1/2',
      ].join(' ')}
    >
      <div className="pointer-events-auto flex flex-col gap-0.5 rounded-[3px] border border-line bg-bg-card/95 p-1 shadow-card backdrop-blur">
        {TOOLS.filter(
          // Project-Canvas-only tools (see EMBEDDED_ONLY) surface only on the
          // embedded variant; the top-level Ground portal is for project cards /
          // frames, not live previews, per-project assets, or shape primitives.
          (t) => !EMBEDDED_ONLY.has(t.id) || variant === 'embedded',
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => onToolChange(t.id)}
            title={t.label}
            className={[
              'flex h-9 w-9 items-center justify-center rounded-[2px] transition-colors',
              tool === t.id
                ? 'bg-accent text-bg-card'
                : 'text-ink-muted hover:bg-bg-inset hover:text-ink',
            ].join(' ')}
          >
            {t.icon}
          </button>
        ))}
        {onGenerate && (
          <>
            <div className="mx-1 my-0.5 border-t border-line" />
            <button
              onClick={onGenerate}
              title={tr('canvas.generate.button')}
              className="flex h-9 w-9 items-center justify-center rounded-[2px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Sparkles size={15} strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
