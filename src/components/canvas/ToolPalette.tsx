import { useEffect, useRef, useState } from 'react'
import { MousePointer2, Type, StickyNote, Frame, Square, Circle, MessageSquareText, Image as ImageIcon, Sparkles, Pencil, Check } from 'lucide-react'
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
  /** 'page' for the top-level Ground canvas: a pen button fixed to the
   *  viewport's bottom-left corner whose tool column springs up out of it. 'embedded' for the project-level Canvas tab: a
   *  Figma-UI3-style horizontal pill, absolutely positioned bottom-centre
   *  within its nearest positioned ancestor. */
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
  const horizontal = variant === 'embedded'
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // Keyboard selection must expose the active tool even while collapsed.
  const toolsVisible = horizontal || expanded || tool !== 'select'
  const buttonShape = horizontal ? 'rounded-full' : 'rounded-[2px]'

  // Ground: a press outside folds the tools away again — but only while the
  // select tool is active, so a click that places a sticky / text / frame on
  // the canvas doesn't yank the palette shut mid-use. Capture phase because
  // the canvas stops propagation of its own pointer events.
  const collapsible = !horizontal && expanded && tool === 'select'
  useEffect(() => {
    if (!collapsible) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setExpanded(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [collapsible])

  const toolButtons = TOOLS.filter(
    // Project-Canvas-only tools (see EMBEDDED_ONLY) surface only on the
    // embedded variant; the top-level Ground portal is for project cards /
    // frames, not live previews, per-project assets, or shape primitives.
    (t) => !EMBEDDED_ONLY.has(t.id) || variant === 'embedded',
  ).map((t) => (
    <button
      key={t.id}
      type="button"
      onClick={() => onToolChange(t.id)}
      title={t.label}
      aria-pressed={tool === t.id}
      className={[
        'flex h-9 w-9 items-center justify-center transition-colors',
        buttonShape,
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        tool === t.id
          ? 'bg-accent text-bg-card'
          : 'text-ink-muted hover:bg-plane hover:text-ink active:bg-bg-elevated',
      ].join(' ')}
    >
      {t.icon}
    </button>
  ))

  if (!horizontal) {
    // Ground: the pen sits in the bottom-left corner; its tools spring up out
    // of it. The column stays mounted so it can animate both ways; while shut
    // it is `invisible` (visibility flips after the fade, so it is neither
    // clickable nor focusable) and aria-hidden.
    return (
      <div ref={rootRef} className="pointer-events-none fixed bottom-0 left-0 z-20 p-5">
        <div className="relative">
          <div
            aria-hidden={!toolsVisible}
            className={[
              'absolute bottom-full left-0 mb-1.5 flex origin-bottom flex-col gap-0.5 rounded-[3px] border border-line bg-bg-card/95 p-1 shadow-card backdrop-blur',
              'transition-[opacity,transform,visibility] motion-reduce:transition-none',
              toolsVisible
                ? 'pointer-events-auto visible translate-y-0 scale-100 opacity-100 duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]'
                : 'invisible translate-y-2 scale-90 opacity-0 duration-150 ease-in',
            ].join(' ')}
          >
            {toolButtons}
          </div>
          <div className="pointer-events-auto rounded-[3px] border border-line bg-bg-card/95 p-1 shadow-card backdrop-blur">
            <button
              type="button"
              title={tr(toolsVisible ? 'toolbar.finishLayout' : 'toolbar.editLayout')}
              aria-label={tr(toolsVisible ? 'toolbar.finishLayout' : 'toolbar.editLayout')}
              aria-expanded={toolsVisible}
              onClick={() => {
                setExpanded(!toolsVisible)
                if (toolsVisible) onToolChange('select')
              }}
              className={[
                'flex h-9 w-9 items-center justify-center rounded-[2px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                toolsVisible
                  ? 'bg-plane text-ink hover:bg-bg-inset active:bg-bg-elevated'
                  : 'bg-bg-card text-ink-muted hover:bg-plane hover:text-ink active:bg-bg-inset active:text-ink',
              ].join(' ')}
            >
              {toolsVisible ? <Check size={15} strokeWidth={1.75} /> : <Pencil size={15} strokeWidth={1.75} />}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-4">
      <div className="pointer-events-auto flex flex-row items-center gap-0.5 rounded-full border border-line bg-bg-card/95 p-1 shadow-card backdrop-blur">
        {toolButtons}
        {onGenerate && (
          <>
            <div className="mx-0.5 h-5 w-px self-center bg-line" />
            <button
              onClick={onGenerate}
              title={tr('canvas.generate.button')}
              className={[
                'flex h-9 w-9 items-center justify-center text-ink-muted transition-colors hover:bg-plane hover:text-ink active:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                buttonShape,
              ].join(' ')}
            >
              <Sparkles size={15} strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
