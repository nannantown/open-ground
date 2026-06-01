import { useEffect, useMemo, useRef } from 'react'
import { MonitorSmartphone } from 'lucide-react'
import type { CanvasElement } from '@/lib/types'
import { buildScreenSrcdoc, hash32 } from '@/lib/screenSrcdoc'
import { resolveOpacity } from '@/lib/canvasTransform'

interface Props {
  element: CanvasElement
  selected: boolean
  editing: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onChangeText: (text: string) => void
  onEditDone: () => void
  ring: string
  /** True while the Comment tool is active — the overlay drops its grab cursor
   *  so the canvas wrapper's comment-bubble cursor shows over the screen. */
  commentTool?: boolean
}

const DEFAULT_W = 1280
const DEFAULT_H = 800

// ⌘/Ctrl+Enter or Escape finishes editing; a plain Enter is a newline. Every
// key stays inside the editor so canvas shortcuts hold off.
function editorKeyDown(e: React.KeyboardEvent, done: () => void) {
  e.stopPropagation()
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault()
    done()
  }
}

// Mock chrome strips. `browser` is a mac-style traffic-light + URL bar,
// `phone` is an iPhone-style notch bar. `none` leaves the iframe bare so a
// design fills the whole canvas tile.
const ChromeStrip = ({
  variant,
  label,
}: {
  variant: 'browser' | 'phone'
  label: string
}) => {
  if (variant === 'browser') {
    return (
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-bg-elevated px-3 py-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 truncate font-mono text-[10px] tracking-tight text-ink-muted">
          {label}
        </span>
      </div>
    )
  }
  return (
    <div className="flex shrink-0 items-center justify-center border-b border-line bg-black/95 py-1">
      <span className="h-1 w-12 rounded-full bg-white/40" />
    </div>
  )
}

// Per-Canvas Screen renderer. A screen's source code (`element.text`) is
// transpiled in-browser and mounted inside a sandboxed iframe via
// `buildScreenSrcdoc` — the same runtime model as a Mock, but with the
// project's full design system (Tailwind tokens, fonts, lucide) injected so a
// Claude-authored, token-using component renders faithfully with no rebuild.
// (The old build-time `import.meta.glob(src/designs/**)` path rendered blank in
// the shipped app; this replaces it.)
export const ScreenView = ({
  element,
  selected,
  editing,
  onPointerDown,
  onChangeText,
  onEditDone,
  ring,
  commentTool,
}: Props) => {
  const ta = useRef<HTMLTextAreaElement>(null)
  const chrome = element.chrome ?? 'none'
  const framework = element.framework ?? 'react'
  const theme = element.theme ?? 'light'
  const label = element.label || element.moduleId || 'Screen'
  const w = element.width ?? DEFAULT_W
  const h = element.height ?? DEFAULT_H

  useEffect(() => {
    if (editing && ta.current) ta.current.focus()
  }, [editing])

  const source = element.text ?? ''
  const srcdoc = useMemo(
    () => buildScreenSrcdoc(source, framework, theme, element.props),
    [source, framework, theme, element.props],
  )

  return (
    <div
      onPointerDown={onPointerDown}
      style={{ width: w, height: h, opacity: resolveOpacity(element) }}
      className={[
        'relative flex flex-col overflow-hidden rounded-[4px] border border-line bg-bg-card shadow-card',
        editing ? 'cursor-text' : 'cursor-grab active:cursor-grabbing',
        ring,
      ].join(' ')}
    >
      {chrome !== 'none' && <ChromeStrip variant={chrome} label={label} />}
      <div className="relative min-h-0 flex-1 bg-white">
        {editing ? (
          <textarea
            ref={ta}
            value={source}
            onChange={(e) => onChangeText(e.target.value)}
            onBlur={onEditDone}
            onKeyDown={(e) => editorKeyDown(e, onEditDone)}
            onPointerDown={(e) => e.stopPropagation()}
            spellCheck={false}
            wrap="off"
            placeholder={'export default function Screen() {\n  return <div className="p-10">…</div>\n}'}
            className="block h-full w-full resize-none bg-bg px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-ink focus:outline-none"
          />
        ) : source.trim() ? (
          <>
            <iframe
              key={hash32(srcdoc)}
              title={label}
              srcDoc={srcdoc}
              sandbox="allow-scripts"
              className={[
                'block h-full w-full border-0 bg-white',
                element.scrollable ? '' : 'overflow-hidden',
              ].join(' ')}
            />
            {/* While dragging (or unfocused), the iframe swallows pointer
                events. Cover it so the canvas owns drags — only the chrome
                strip or a selected screen passes clicks through. */}
            {!selected && (
              <div
                onPointerDown={onPointerDown}
                className={[
                  'absolute inset-0',
                  // Comment tool: let the wrapper's bubble cursor show through
                  // instead of this overlay's own grab cursor (see ElementView).
                  commentTool ? 'cursor-[inherit]' : 'cursor-grab active:cursor-grabbing',
                ].join(' ')}
              />
            )}
          </>
        ) : (
          // Empty screen (or a legacy moduleId-only screen pre-migration):
          // an explicit affordance, never a silent blank tile.
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation()
            }}
            className="flex h-full w-full flex-col items-center justify-center gap-2 bg-bg-card p-6 text-center"
          >
            <MonitorSmartphone size={22} strokeWidth={1.5} className="text-ink-faint" />
            <span className="text-[13px] font-medium text-ink">
              {element.moduleId ? '旧形式の Screen です' : '空の Screen'}
            </span>
            <span className="max-w-[36ch] text-[11.5px] leading-snug text-ink-muted">
              ダブルクリックでソースを書くか、Canvas チャットで Claude に
              「この画面を作って」と頼んでください。
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
