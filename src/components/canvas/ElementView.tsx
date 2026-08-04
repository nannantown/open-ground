import { memo, useEffect, useMemo, useRef } from 'react'
import { Code2 } from 'lucide-react'
import type { CanvasElement } from '@/lib/types'
import { buildMockSrcdoc, hash32 } from '@/lib/mockSrcdoc'
import { useClientLockdown } from '@/lib/lockdownClient'
import { resolveTextStyle } from '@/lib/canvasTextStyle'
import { textSizingOf, textVAlignOf, textBox } from '@/lib/canvasTextSizing'
import { resolveStickyFill, DEFAULT_STICKY_FILL } from '@/lib/canvasFillStyle'
import { resolveOpacity } from '@/lib/canvasTransform'
import { CommentPin } from './CommentPin'
import { ImageView } from './ImageView'
import { ScreenView, useInspectTweak } from './ScreenView'
import { useT } from '@/i18n/I18nContext'
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
  /** Image elements need these to resolve their per-canvas asset URLs. A
   *  folder-less collab member opens a shared canvas with an empty path, so
   *  ImageView renders a "not synced" placeholder instead of fetching (u14a). */
  projectPath?: string
  canvasId?: string
  /** True while the Comment tool is active. A mock/screen covers its iframe
   *  with a full-bleed overlay div that normally carries its own grab cursor;
   *  that overlay's class out-ranks the wrapper's inherited comment cursor, so
   *  the bubble glyph vanishes over a design. When set, the overlay drops its
   *  grab cursor and inherits the wrapper's comment cursor instead. */
  commentTool?: boolean
  /** Text-only, wired for EVERY non-hidden/locked text by the canvas: report
   *  the rendered box (offset px — integers, pre-transform so the canvas zoom
   *  never feeds in) whenever it changes, so the canvas can persist the text's
   *  real footprint (per its sizing mode — see textMeasurePatch) and re-flow a
   *  layout-frame text's siblings. The reported box is whatever the mode's
   *  render produced; the parent decides which axes the measurement may keep. */
  onMeasure?: (w: number, h: number) => void
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

// Renders one free-form canvas element. A text note has three Figma-parity
// sizing modes (see canvasTextSizing.ts + docs/CANVAS_TEXT_SIZING_PLAN.md):
// auto-width hugs its longest line and grows as you type (no wrap, newlines
// only via Enter); auto-height pins the width and wraps, growing downward;
// fixed pins both axes, wraps, clips overflow, and vertically aligns the
// glyphs. A sticky note is a fixed-size, resizable box. Editing is driven by
// the `editing` prop; the canvas owns double-click.
export const ElementView = memo(({
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
  onMeasure,
}: Props) => {
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing && ta.current) {
      ta.current.focus()
      ta.current.select()
    }
  }, [editing])

  // Measured-text reflow (text case only — the ref is set nowhere else, so
  // this hook is inert for every other type). Observes whichever root the
  // text branch rendered — the idle div or the editing wrapper — and reports
  // offsetWidth/Height: layout px, unaffected by the canvas's scale transform.
  // The callback rides a ref so the parent's per-render closures don't churn
  // the observer; jsdom has no ResizeObserver, so tests stub it (or skip).
  const measureRef = useRef<HTMLDivElement | null>(null)
  const onMeasureRef = useRef(onMeasure)
  onMeasureRef.current = onMeasure
  const measuring = !!onMeasure
  useEffect(() => {
    if (!measuring || typeof ResizeObserver === 'undefined') return
    const node = measureRef.current
    if (!node) return
    // Fires once on observe() with the initial size, then on every change.
    const ro = new ResizeObserver(() => {
      onMeasureRef.current?.(node.offsetWidth, node.offsetHeight)
    })
    ro.observe(node)
    return () => ro.disconnect()
  }, [measuring, editing])

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
        projectPath={projectPath}
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
        projectPath={projectPath}
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
            {element.text || <span className="text-ink/55">Double-click to edit</span>}
          </div>
        )}
        </div>
      </div>
    )
  }

  // ---- text note: three Figma-parity sizing modes ----
  // One resolved style object (size / family / colour / weight / align /
  // line-height) shared by the idle render, the editing textarea, and the
  // invisible sizer so the box stays exact when any typography field changes
  // from the inspector. All six properties must be identical across the three
  // paths or the box mis-sizes (round 1's flagged invariant).
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
  // The mode picks the box's footprint contract (see canvasTextSizing.ts):
  //   auto-width  — hugs content on both axes; no wrap (whitespace: pre).
  //   auto-height — width is authoritative; text wraps; height hugs content.
  //   fixed       — both axes authoritative; text wraps; overflow clipped; the
  //                 glyphs are vertically aligned within the box.
  // `textBox` resolves the authoritative width/height with the legacy 300×44 as
  // the only pre-first-measure fallback (a fresh auto-height text before Track
  // B has seeded its drag width).
  const sizing = textSizingOf(element)
  const { w: boxW, h: boxH } = textBox(element)
  // The wrapping autos / fixed share `pre-wrap`; only auto-width keeps `pre`
  // (one long line, widened by typing). Same token drives the idle render, the
  // sizer, and (via wrap=) the textarea, so the box never jumps on edit enter.
  const wraps = sizing !== 'auto-width'
  const wrapClass = wraps ? 'whitespace-pre-wrap' : 'whitespace-pre'
  // `wrap="soft"` lets the textarea reflow at its own width (the autos / fixed);
  // `wrap="off"` keeps it a single scrolling line (auto-width).
  const taWrap = wraps ? 'soft' : 'off'

  // ---- fixed: authoritative box, clipped, vertically aligned ----
  if (sizing === 'fixed') {
    const vAlign = textVAlignOf(element)
    // The box is a flex column; `justify-content` positions the single child
    // (the text content while idle) along the vertical axis. The padding lives
    // on the box, so the textarea child only needs to fill the content area.
    const justify =
      vAlign === 'middle' ? 'center' : vAlign === 'bottom' ? 'flex-end' : 'flex-start'
    return (
      <div
        ref={measureRef}
        onPointerDown={onPointerDown}
        style={{ ...textStyle, width: boxW, height: boxH, justifyContent: justify, opacity }}
        className={[
          'flex flex-col overflow-hidden rounded-[2px]',
          editing ? 'cursor-text' : 'cursor-grab select-none active:cursor-grabbing',
          wrapClass,
          TEXT_PAD,
          ring,
        ].join(' ')}
      >
        {editing ? (
          // The textarea fills the content area (top-anchored while editing,
          // like Figma's fixed-text editor — the vertical align applies to the
          // idle render). Wrap + metrics match the idle render so nothing jumps.
          <textarea
            ref={ta}
            value={element.text}
            onChange={(e) => onChangeText(e.target.value)}
            onBlur={onEditDone}
            onKeyDown={(e) => editorKeyDown(e, onEditDone)}
            onPointerDown={(e) => e.stopPropagation()}
            wrap={taWrap}
            spellCheck={false}
            style={textStyle}
            className="h-full w-full resize-none overflow-hidden whitespace-pre-wrap bg-transparent focus:outline-none"
          />
        ) : (
          element.text || <span className="text-ink-faint">Text…</span>
        )}
      </div>
    )
  }

  // ---- auto-width / auto-height: the box hugs content (auto-width on both
  // axes, auto-height on height only — its width is authoritative). The editing
  // path uses an invisible sizer to size the box exactly to the content, with
  // the textarea overlaid; idle renders the text directly. The two share the
  // same wrap/width so the box doesn't jump when entering/leaving edit. ----
  // auto-width hugs horizontally (inline-block, no explicit width); auto-height
  // pins the width and wraps within it.
  const boxWidth = sizing === 'auto-height' ? boxW : undefined
  const layoutClass = sizing === 'auto-height' ? 'block' : 'inline-block'

  if (!editing) {
    return (
      <div
        ref={measureRef}
        onPointerDown={onPointerDown}
        style={{ ...textStyle, width: boxWidth, opacity }}
        className={[
          layoutClass,
          'cursor-grab select-none rounded-[2px] active:cursor-grabbing',
          wrapClass,
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
      ref={measureRef}
      onPointerDown={onPointerDown}
      style={{ width: boxWidth, opacity }}
      className={['relative cursor-text rounded-[2px]', layoutClass, ring].join(' ')}
    >
      {/* Invisible sizer: CSS sizes the box to the content (longest line +
          line count for auto-width; the wrapped height at the pinned width for
          auto-height). The trailing space leaves room for the caret. Same font
          metrics + wrap as the textarea below or the box would mis-size. */}
      <div
        aria-hidden
        style={textStyle}
        className={['invisible min-w-[2ch]', wrapClass, TEXT_PAD].join(' ')}
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
        wrap={taWrap}
        spellCheck={false}
        style={textStyle}
        className={[
          'absolute inset-0 resize-none overflow-hidden bg-transparent focus:outline-none',
          TEXT_PAD,
        ].join(' ')}
      />
    </div>
  )
})

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
  projectPath,
}: {
  element: CanvasElement
  selected: boolean
  editing: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onChangeText: (text: string) => void
  onEditDone: () => void
  ring: string
  commentTool?: boolean
  projectPath?: string
}) => {
  const { t } = useT()
  const ta = useRef<HTMLTextAreaElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
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
  // framework, theme — or work mode, which swaps CDN-backed templates for the
  // explicit placeholder — changes.
  const lockdown = useClientLockdown()
  const srcdoc = useMemo(
    () => buildMockSrcdoc(element.text, framework, theme, { lockdown }),
    [element.text, framework, theme, lockdown],
  )

  // Inspect-and-instruct ("tweak") flow — shared with ScreenView, see there.
  const tweak = useInspectTweak({
    iframeRef,
    selected,
    projectPath,
    elementId: element.id,
    source: element.text,
    framework,
    onChangeText,
  })

  const w = element.width ?? MOCK_DEFAULT_W
  const h = element.height ?? MOCK_DEFAULT_H

  return (
    <div
      onPointerDown={onPointerDown}
      style={{ width: w, height: h, opacity: resolveOpacity(element) }}
      className={[
        'group flex flex-col overflow-hidden rounded-[4px] border border-line bg-bg-card shadow-card',
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
              ref={iframeRef}
              onLoad={tweak.onIframeLoad}
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
              >
                {/* Interactivity is real but invisible (select first, then the
                    iframe is live) — say so on hover, or nobody discovers it. */}
                {!commentTool && (
                  <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-bg-card/95 px-2.5 py-1 text-[10px] font-medium text-ink-muted opacity-0 shadow-card transition-opacity duration-150 group-hover:opacity-100">
                    {t('canvasEl.iframe.clickToInteract')}
                  </span>
                )}
              </div>
            )}
            {tweak.badge}
            {tweak.panel}
          </>
        )}
      </div>
    </div>
  )
}
