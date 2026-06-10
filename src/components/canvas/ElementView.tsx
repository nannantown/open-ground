import { useEffect, useMemo, useRef } from 'react'
import { Code2 } from 'lucide-react'
import type { CanvasElement } from '@/lib/types'
import { buildMockSrcdoc, hash32 } from '@/lib/mockSrcdoc'
import { resolveTextStyle } from '@/lib/canvasTextStyle'
import { resolveStickyFill, DEFAULT_STICKY_FILL } from '@/lib/canvasFillStyle'
import { resolveOpacity } from '@/lib/canvasTransform'
import { CommentPin } from './CommentPin'
import { ImageView } from './ImageView'
import { ScreenView } from './ScreenView'
import { ShapeView } from './ShapeView'

interface Props {
  element: CanvasElement
  selected: boolean
  editing: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onChangeText: (text: string) => void
  onEditDone: () => void
  /** Sticky-only: set the note colour from the selected-sticky swatch row. */
  onChangeColor?: (color: string) => void
  /** Comment-only: toggle the resolved flag. */
  onToggleCommentResolved?: (id: string) => void
  /** Comment-only: short label of the element this comment was anchored to. */
  commentAnchorLabel?: string | null
  /** Image elements need these to resolve their per-canvas asset URLs. Absent
   *  on the top-level Ground canvas (which doesn't support image elements
   *  yet); the image case falls back to a placeholder there. */
  projectPath?: string
  canvasId?: string
  /** True while the Comment tool is active. A mock/screen covers its iframe
   *  with a full-bleed overlay div that normally carries its own grab cursor;
   *  that overlay's class out-ranks the wrapper's inherited comment cursor, so
   *  the bubble glyph vanishes over a design. When set, the overlay drops its
   *  grab cursor and inherits the wrapper's comment cursor instead. */
  commentTool?: boolean
}

const STICKY = 208
const MOCK_DEFAULT_W = 420
const MOCK_DEFAULT_H = 320
// Single source of truth for the sticky default, shared with the inspector +
// the resolve helper so the swatch row, the inspector Fill control, and the
// idle render never drift apart.
const DEFAULT_STICKY_COLOR = DEFAULT_STICKY_FILL
// Sticky swatches — paper-warm tones that read against the canvas grain.
const STICKY_COLORS = ['#ECD79A', '#F4B8A8', '#CDE0B8', '#B8D4E0', '#E0C7E8', '#F8F4E8']
// Padding only; font-family / size / colour / weight / align / line-height now
// all come from the element's typography fields via inline `style` (see
// resolveTextStyle), so the idle render, the editing textarea, and the
// invisible auto-width sizer share one computed style object and stay
// metrically identical. (line-height moved off the old `leading-snug` class so
// the inspector can drive it; its default mirrors that class exactly.)
const TEXT_PAD = 'px-1.5 py-0.5'

// ⌘/Ctrl+Enter or Escape finishes editing; a plain Enter is a newline. Every
// key stays inside the editor (stopPropagation) so canvas shortcuts hold off.
function editorKeyDown(e: React.KeyboardEvent, done: () => void) {
  e.stopPropagation()
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault()
    done()
  }
}

// Renders one free-form canvas element. A text note is auto-width (Figma
// style): the box hugs its longest line and grows as you type — no wrapping,
// new lines only via Enter. A sticky note is a fixed-size, resizable box.
// Editing is driven by the `editing` prop; the canvas owns double-click.
export const ElementView = ({
  element,
  selected,
  editing,
  onPointerDown,
  onChangeText,
  onEditDone,
  onChangeColor,
  onToggleCommentResolved,
  commentAnchorLabel,
  projectPath,
  canvasId,
  commentTool,
}: Props) => {
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing && ta.current) {
      ta.current.focus()
      ta.current.select()
    }
  }, [editing])

  const ring = selected ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg' : ''

  // ---- comment: a Figma-style pin with an inline popup ----
  if (element.type === 'comment') {
    return (
      <CommentPin
        element={element}
        selected={selected}
        editing={editing}
        onPointerDown={onPointerDown}
        onChangeText={onChangeText}
        onEditDone={onEditDone}
        onToggleResolved={
          onToggleCommentResolved ? () => onToggleCommentResolved(element.id) : undefined
        }
        anchorLabel={commentAnchorLabel}
      />
    )
  }

  // ---- mock: a live React/HTML preview inside a sandboxed iframe ----
  if (element.type === 'mock') {
    return (
      <MockView
        element={element}
        selected={selected}
        editing={editing}
        onPointerDown={onPointerDown}
        onChangeText={onChangeText}
        onEditDone={onEditDone}
        ring={ring}
        commentTool={commentTool}
      />
    )
  }

  // ---- image: a per-canvas asset rendered from /api/canvas/asset ----
  if (element.type === 'image') {
    return (
      <ImageView
        element={element}
        selected={selected}
        onPointerDown={onPointerDown}
        projectPath={projectPath ?? ''}
        canvasId={canvasId ?? ''}
      />
    )
  }

  // ---- shape: a plain rectangle or ellipse (fill / stroke / radius / opacity)
  if (element.type === 'shape') {
    return (
      <ShapeView
        element={element}
        selected={selected}
        onPointerDown={onPointerDown}
      />
    )
  }

  // ---- screen: live source transpiled + mounted in a sandboxed iframe ----
  if (element.type === 'screen') {
    return (
      <ScreenView
        element={element}
        selected={selected}
        editing={editing}
        onPointerDown={onPointerDown}
        onChangeText={onChangeText}
        onEditDone={onEditDone}
        ring={ring}
        commentTool={commentTool}
      />
    )
  }

  // ---- sticky note: a fixed-size, resizable box ----
  if (element.type === 'sticky') {
    return (
      <div className="relative">
        {selected && !editing && onChangeColor && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            // To the LEFT of the note: the top-centre is owned by the rotation
            // handle and the bottom-right by the resize handle, so the swatch row
            // sits to the side, clear of both regardless of the note's size.
            className="absolute right-full top-1 mr-2 z-10 flex items-center gap-1 rounded-[5px] border border-line bg-bg-card px-1.5 py-1 shadow-card"
          >
            {STICKY_COLORS.map((c) => {
              const active = (element.color ?? DEFAULT_STICKY_COLOR) === c
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onChangeColor(c)}
                  title={c}
                  style={{ background: c }}
                  className={[
                    'h-4 w-4 rounded-full border transition-transform hover:scale-110',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    active ? 'border-ink ring-1 ring-ink' : 'border-black/15',
                  ].join(' ')}
                />
              )
            })}
          </div>
        )}
        <div
          onPointerDown={onPointerDown}
          style={{
            width: element.width ?? STICKY,
            height: element.height ?? STICKY,
            background: resolveStickyFill(element),
            opacity: resolveOpacity(element),
          }}
          className={[
            'rounded-[2px] border border-black/10 p-3.5 shadow-card',
            editing ? 'cursor-text' : 'cursor-grab active:cursor-grabbing',
            ring,
          ].join(' ')}
        >
        {editing ? (
          <textarea
            ref={ta}
            value={element.text}
            onChange={(e) => onChangeText(e.target.value)}
            onBlur={onEditDone}
            onKeyDown={(e) => editorKeyDown(e, onEditDone)}
            onPointerDown={(e) => e.stopPropagation()}
            className="block h-full w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink focus:outline-none"
          />
        ) : (
          <div className="h-full w-full select-none overflow-hidden whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
            {element.text || <span className="text-ink/35">Double-click to edit</span>}
          </div>
        )}
        </div>
      </div>
    )
  }

  // ---- text note: auto-width, hugs the longest line ----
  // One resolved style object (size / family / colour / weight / align /
  // line-height) shared by the idle render, the editing textarea, and the
  // invisible sizer so the auto-width box stays exact when any typography field
  // changes from the inspector. All six properties must be identical across the
  // three paths or the box mis-sizes (round 1's flagged invariant).
  const typo = resolveTextStyle(element)
  const textStyle: React.CSSProperties = {
    fontSize: typo.fontSize,
    fontFamily: typo.fontFamily,
    color: typo.color,
    fontWeight: typo.fontWeight,
    textAlign: typo.textAlign,
    lineHeight: typo.lineHeight,
  }
  const opacity = resolveOpacity(element)

  if (!editing) {
    return (
      <div
        onPointerDown={onPointerDown}
        style={{ ...textStyle, opacity }}
        className={[
          'inline-block cursor-grab select-none whitespace-pre rounded-[2px] active:cursor-grabbing',
          TEXT_PAD,
          ring,
        ].join(' ')}
      >
        {element.text || <span className="text-ink-faint">Text…</span>}
      </div>
    )
  }

  return (
    <div
      onPointerDown={onPointerDown}
      style={{ opacity }}
      className={['relative inline-block cursor-text rounded-[2px]', ring].join(' ')}
    >
      {/* Invisible sizer: CSS sizes the box to the longest line + line count.
          The trailing space leaves room for the caret. Same font metrics as the
          textarea below (textStyle) or the box would mis-size. */}
      <div
        aria-hidden
        style={textStyle}
        className={['invisible min-w-[2ch] whitespace-pre', TEXT_PAD].join(' ')}
      >
        {element.text + ' '}
      </div>
      <textarea
        ref={ta}
        value={element.text}
        onChange={(e) => onChangeText(e.target.value)}
        onBlur={onEditDone}
        onKeyDown={(e) => editorKeyDown(e, onEditDone)}
        onPointerDown={(e) => e.stopPropagation()}
        wrap="off"
        spellCheck={false}
        style={textStyle}
        className={[
          'absolute inset-0 resize-none overflow-hidden bg-transparent focus:outline-none',
          TEXT_PAD,
        ].join(' ')}
      />
    </div>
  )
}

// Renders a `mock` element: a chrome strip with a label + framework badge on
// top of a sandboxed iframe (idle preview) or a code textarea (editing). The
// iframe's srcdoc embeds React + Babel from a CDN — works offline only after
// the first online load (browser cache), which is fine for v1.
const MockView = ({
  element,
  selected,
  editing,
  onPointerDown,
  onChangeText,
  onEditDone,
  ring,
  commentTool,
}: {
  element: CanvasElement
  selected: boolean
  editing: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onChangeText: (text: string) => void
  onEditDone: () => void
  ring: string
  commentTool?: boolean
}) => {
  const ta = useRef<HTMLTextAreaElement>(null)
  const framework = element.framework ?? 'react'
  const theme = element.theme ?? 'light'

  useEffect(() => {
    if (editing && ta.current) {
      ta.current.focus()
      // Don't auto-select all — when editing code, users almost always want
      // to keep what's there and tweak. Different from sticky/text where the
      // first edit is often a full overwrite.
    }
  }, [editing])

  // Memoised so we don't reload the iframe on unrelated parent re-renders
  // (e.g. someone else's selection change). Rebuilds only when the code,
  // framework, or theme changes.
  const srcdoc = useMemo(
    () => buildMockSrcdoc(element.text, framework, theme),
    [element.text, framework, theme],
  )

  const w = element.width ?? MOCK_DEFAULT_W
  const h = element.height ?? MOCK_DEFAULT_H

  return (
    <div
      onPointerDown={onPointerDown}
      style={{ width: w, height: h, opacity: resolveOpacity(element) }}
      className={[
        'flex flex-col overflow-hidden rounded-[4px] border border-line bg-bg-card shadow-card',
        editing ? 'cursor-text' : 'cursor-grab active:cursor-grabbing',
        ring,
      ].join(' ')}
    >
      <div
        // Chrome strip is also the drag handle when an iframe is below it —
        // an iframe swallows pointer events so the user can't grab the body.
        className="flex shrink-0 items-center gap-1.5 border-b border-line bg-bg-elevated px-2 py-1 label-cap text-ink-muted"
      >
        <Code2 size={10} strokeWidth={2.25} />
        <span className="truncate">{element.name || (framework === 'html' ? 'HTML mock' : 'React mock')}</span>
        <span className="ml-auto font-mono normal-case tracking-normal text-[9px] text-ink-faint">
          {framework}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {editing ? (
          <textarea
            ref={ta}
            value={element.text}
            onChange={(e) => onChangeText(e.target.value)}
            onBlur={onEditDone}
            onKeyDown={(e) => editorKeyDown(e, onEditDone)}
            onPointerDown={(e) => e.stopPropagation()}
            spellCheck={false}
            wrap="off"
            className="block h-full w-full resize-none bg-bg px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-ink focus:outline-none"
          />
        ) : (
          <>
            <iframe
              key={hash32(srcdoc)}
              title={element.name || 'mock'}
              srcDoc={srcdoc}
              sandbox="allow-scripts"
              className="h-full w-full border-0 bg-white"
            />
            {/* While the user is dragging (or hasn't focused this mock), the
                iframe swallows pointer events. Cover it so the canvas can own
                drags — only the chrome strip and the body once selected can
                pass clicks through to the iframe. */}
            {!selected && (
              <div
                onPointerDown={onPointerDown}
                className={[
                  'absolute inset-0',
                  // The Comment tool wants the bubble cursor everywhere; this
                  // overlay's own grab cursor would otherwise out-rank the
                  // wrapper's inherited one over a mock. Inherit instead.
                  commentTool ? 'cursor-[inherit]' : 'cursor-grab active:cursor-grabbing',
                ].join(' ')}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
