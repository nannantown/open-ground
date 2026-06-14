import { useState } from 'react'
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  Bold,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Minus,
  ArrowDown,
  ArrowRight,
  Expand,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
} from 'lucide-react'
import type { CanvasElement, FrameLayout } from '@/lib/types'
import type { AlignOp } from '@/lib/canvasAlign'
import { AUTO_LAYOUT_DEFAULTS } from '@/lib/canvasAutoLayout'
import { useT } from '@/i18n/I18nContext'
import {
  FONT_OPTIONS,
  FONT_DISPLAY_STACK,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_SIZE,
  DEFAULT_TEXT_FONT_WEIGHT,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_LINE_HEIGHT,
  BOLD_FONT_WEIGHT,
  TEXT_ALIGN_OPTIONS,
  MIN_TEXT_FONT_SIZE,
  MAX_TEXT_FONT_SIZE,
  MIN_LINE_HEIGHT,
  MAX_LINE_HEIGHT,
  clampFontSize,
  clampLineHeight,
  type TextAlign,
} from '@/lib/canvasTextStyle'
import {
  resolveStickyFill,
  resolveFrameStyle,
  MIN_STROKE_WIDTH,
  MAX_STROKE_WIDTH,
  clampStrokeWidth,
} from '@/lib/canvasFillStyle'
import { resolveShapeStyle, resolveShapeKind } from '@/lib/canvasShape'
import {
  TEXT_SIZING_MODES,
  textSizingOf,
  textVAlignOf,
  textBox,
  convertSizing,
  type TextSizing,
  type TextVAlign,
} from '@/lib/canvasTextSizing'
import {
  resolveOpacity,
  opacityFromPercent,
  resolveFrameCornerRadius,
  MIN_CORNER_RADIUS,
  MAX_CORNER_RADIUS,
  clampCornerRadius,
  clampWidth,
  clampHeight,
  RESIZE_MIN_W,
  RESIZE_MIN_H,
  RESIZE_MAX,
  normalizeRotation,
} from '@/lib/canvasTransform'

// Font-weight catalogue for the weight select. Values are real CSS weights;
// the Bold toggle is a shortcut to 700 / 400 over the same field.
const WEIGHT_OPTIONS: { label: string; value: number }[] = [
  { label: 'Light', value: 300 },
  { label: 'Regular', value: 400 },
  { label: 'Medium', value: 500 },
  { label: 'Semibold', value: 600 },
  { label: 'Bold', value: 700 },
]

const ALIGN_ICON: Record<TextAlign, typeof AlignLeft> = {
  left: AlignLeft,
  center: AlignCenter,
  right: AlignRight,
}

// Vertical-align options for a fixed-size text box (top / middle / bottom). The
// horizontal-bar align icons read as "glyphs pinned to top / middle / bottom".
const VALIGN_OPTIONS: readonly TextVAlign[] = ['top', 'middle', 'bottom']
const VALIGN_ICON: Record<TextVAlign, typeof AlignStartHorizontal> = {
  top: AlignStartHorizontal,
  middle: AlignCenterHorizontal,
  bottom: AlignEndHorizontal,
}

// Type → i18n key for the Position section heading (resolved with t() at render).
const TYPE_LABEL_KEY: Record<CanvasElement['type'], string> = {
  text: 'canvas.insp.text',
  sticky: 'canvas.insp.sticky',
  frame: 'canvas.insp.frame',
  mock: 'canvas.insp.mock',
  comment: 'canvas.insp.comment',
  image: 'canvas.insp.image',
  screen: 'canvas.insp.screen',
  shape: 'canvas.insp.shape',
  group: 'canvas.insp.group',
}

interface Props {
  element: CanvasElement
  /** Apply a partial patch to this element. Wired by the parent to the same
   *  undoable `mutateElements` persistence path every other edit uses, so
   *  inspector edits undo/redo and persist exactly like a drag or a retype. */
  onPatch: (patch: Partial<CanvasElement>) => void
  /** Multi-select: when length > 1 the panel switches to multi mode — only the
   *  fields every selected type shares are shown, value mismatches render as a
   *  "Mixed" placeholder, and edits commit through `onPatchMany`. */
  elements?: CanvasElement[]
  onPatchMany?: (ids: string[], changes: Partial<CanvasElement>) => void
  /** Align / distribute row at the top of the panel (absorbs the old floating
   *  AlignBar). The row renders only when `onAlign` is provided, and never for
   *  a layout child (`isLayoutChild` — the parent frame owns its position). */
  onAlign?: (op: AlignOp) => void
  alignEnabled?: boolean
  isLayoutChild?: boolean
  /** The parent layout frame's layout when the selected element is a layout
   *  child — enables the per-axis Fixed / Fill resizing selects. */
  parentLayout?: FrameLayout | null
  /** Plain frame "+ Auto layout" — falls back to a direct layout patch with
   *  AUTO_LAYOUT_DEFAULTS when not wired. */
  onAddAutoLayout?: () => void
}

// Figma-style Design panel for the current selection. DOCKED: fills its parent
// (the shell's right sidebar) instead of floating over the canvas. Sections in
// Figma's Design-tab order — align row, Position, Auto layout, Layer, then
// Fill / Stroke / Text — separated by hairline dividers.
export const SelectionInspector = ({
  element,
  onPatch,
  elements,
  onPatchMany,
  onAlign,
  alignEnabled,
  isLayoutChild,
  parentLayout,
  onAddAutoLayout,
}: Props) => {
  const multi = (elements?.length ?? 0) > 1
  return (
    <div
      // The panel owns its pointer events so dragging a slider / typing never
      // pans a canvas that may sit underneath.
      onPointerDown={(e) => e.stopPropagation()}
      className="flex h-full w-full flex-col overflow-y-auto"
    >
      {onAlign && !isLayoutChild && (
        <AlignRow
          onAlign={onAlign}
          enabled={alignEnabled ?? true}
          count={elements?.length ?? 1}
        />
      )}
      {multi && elements ? (
        <MultiSelection elements={elements} onPatchMany={onPatchMany} />
      ) : (
        <SingleSelection
          element={element}
          onPatch={onPatch}
          parentLayout={parentLayout ?? null}
          onAddAutoLayout={onAddAutoLayout}
        />
      )}
    </div>
  )
}

// A panel section: hairline divider above (except the panel's first block) and
// an 11px ink-muted heading.
const Section = ({ title, children }: { title?: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-2.5 border-t border-line-soft px-3 py-3 first:border-t-0">
    {title && <div className="text-[11px] font-medium text-ink-muted">{title}</div>}
    {children}
  </div>
)

// ── Align / distribute row — the old floating AlignBar folded into the panel
//    top (Figma puts it there). Same 6 align ops + the 2 distribute ops. ──
const ALIGN_OPS: { op: AlignOp; key: string; Icon: typeof AlignStartVertical }[] = [
  { op: 'left', key: 'canvas.align.left', Icon: AlignStartVertical },
  { op: 'hcenter', key: 'canvas.align.hcenter', Icon: AlignCenterVertical },
  { op: 'right', key: 'canvas.align.right', Icon: AlignEndVertical },
  { op: 'top', key: 'canvas.align.top', Icon: AlignStartHorizontal },
  { op: 'vmiddle', key: 'canvas.align.vmiddle', Icon: AlignCenterHorizontal },
  { op: 'bottom', key: 'canvas.align.bottom', Icon: AlignEndHorizontal },
  { op: 'hdistribute', key: 'canvas.align.hdistribute', Icon: AlignHorizontalDistributeCenter },
  { op: 'vdistribute', key: 'canvas.align.vdistribute', Icon: AlignVerticalDistributeCenter },
]

const AlignRow = ({
  onAlign,
  enabled,
  count,
}: {
  onAlign: (op: AlignOp) => void
  enabled: boolean
  /** Live selection size — distribute needs ≥3 (the old AlignBar's gate). */
  count: number
}) => {
  const { t } = useT()
  return (
    <div className="flex items-stretch gap-0.5 px-3 py-2">
      {ALIGN_OPS.map(({ op, key, Icon }) => (
        <button
          key={op}
          type="button"
          title={t(key)}
          aria-label={t(key)}
          disabled={!enabled || ((op === 'hdistribute' || op === 'vdistribute') && count < 3)}
          onClick={() => onAlign(op)}
          className={[
            'flex h-7 min-w-0 flex-1 items-center justify-center rounded-[4px] text-ink-muted transition-colors',
            'hover:bg-bg-inset hover:text-ink active:bg-bg-elevated',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-muted',
          ].join(' ')}
        >
          <Icon size={14} strokeWidth={1.9} />
        </button>
      ))}
    </div>
  )
}

// ── Single selection — the full type-aware panel. ──
const SingleSelection = ({
  element,
  onPatch,
  parentLayout,
  onAddAutoLayout,
}: {
  element: CanvasElement
  onPatch: (patch: Partial<CanvasElement>) => void
  parentLayout: FrameLayout | null
  onAddAutoLayout?: () => void
}) => {
  const { t } = useT()
  const typeLabel =
    element.type === 'shape'
      ? resolveShapeKind(element) === 'ellipse'
        ? t('canvas.insp.ellipse')
        : t('canvas.insp.rectangle')
      : t(TYPE_LABEL_KEY[element.type])
  return (
    <>
      <Section title={typeLabel}>
        <PositionProperties element={element} onPatch={onPatch} parentLayout={parentLayout} />
      </Section>
      {element.type === 'frame' && (
        <Section title={t('canvas.insp.layout')}>
          <AutoLayoutProperties
            element={element}
            onPatch={onPatch}
            onAddAutoLayout={onAddAutoLayout}
          />
        </Section>
      )}
      <Section title={t('canvas.insp.layer')}>
        <LayerProperties element={element} onPatch={onPatch} />
      </Section>
      {element.type === 'sticky' && (
        <Section title={t('canvas.insp.fill')}>
          <ColorField
            srLabel={t('canvas.insp.fill')}
            value={resolveStickyFill(element)}
            onChange={(color) => onPatch({ color })}
          />
        </Section>
      )}
      {(element.type === 'frame' || element.type === 'shape') && (
        <FillStrokeSections element={element} onPatch={onPatch} />
      )}
      {element.type === 'text' && (
        <Section title={t('canvas.insp.text')}>
          <TextProperties element={element} onPatch={onPatch} />
        </Section>
      )}
    </>
  )
}

// Per-type render defaults, so the W/H inputs show the box's *actual* rendered
// size even for a legacy element that was saved without explicit width/height
// (the views fall back to these same numbers). Kept in sync with the element
// views' own DEFAULT_W / DEFAULT_H constants. Types absent here (text, comment,
// group) carry no W/H fields in the panel.
const SIZE_DEFAULTS: Partial<Record<CanvasElement['type'], { w: number; h: number }>> = {
  sticky: { w: 208, h: 208 },
  frame: { w: 400, h: 280 },
  mock: { w: 420, h: 320 },
  image: { w: 320, h: 240 },
  screen: { w: 1280, h: 800 },
  shape: { w: 160, h: 120 },
}

// Rotation normalizer shared by the single + multi rotation fields →
// (-180,180], NaN-safe (a cleared field becomes 0, never NaN). 0 is stored as
// undefined to keep the field clean.
const normRotation = (n: number) => {
  const d = normalizeRotation(n)
  return d === 0 ? undefined : d
}

// World coordinates are unbounded: round when finite, keep the current value
// for a cleared field (an empty X never teleports the element).
const finiteRound = (n: number, fallback: number) =>
  Number.isFinite(n) ? Math.round(n) : fallback

// ── Position — X / Y / W / H / rotation / corner radius in Figma's two-column
//    grid, plus the per-axis Fixed / Fill resizing selects for a layout child. ──
const PositionProperties = ({
  element,
  onPatch,
  parentLayout,
}: {
  element: CanvasElement
  onPatch: (patch: Partial<CanvasElement>) => void
  parentLayout: FrameLayout | null
}) => {
  const { t } = useT()
  const def = SIZE_DEFAULTS[element.type]
  const w = Math.round(element.width ?? def?.w ?? 0)
  const h = Math.round(element.height ?? def?.h ?? 0)
  const showRadius =
    element.type === 'frame' ||
    (element.type === 'shape' && resolveShapeKind(element) === 'rect')
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Field label="X">
          <NumberInput
            value={Math.round(element.x)}
            onCommit={(n) => onPatch({ x: finiteRound(n, element.x) })}
          />
        </Field>
        <Field label="Y">
          <NumberInput
            value={Math.round(element.y)}
            onCommit={(n) => onPatch({ y: finiteRound(n, element.y) })}
          />
        </Field>
        {def && (
          <>
            <Field label="W">
              <NumberInput
                min={RESIZE_MIN_W}
                max={RESIZE_MAX}
                value={w}
                onCommit={(n) => onPatch({ width: clampWidth(n, w) })}
              />
            </Field>
            <Field label="H">
              <NumberInput
                min={RESIZE_MIN_H}
                max={RESIZE_MAX}
                value={h}
                onCommit={(n) => onPatch({ height: clampHeight(n, h) })}
              />
            </Field>
          </>
        )}
        <Field label={t('canvas.insp.rotation')}>
          <NumberInput
            min={-360}
            max={360}
            value={Math.round(element.rotation ?? 0)}
            onCommit={(n) => onPatch({ rotation: normRotation(n) })}
          />
        </Field>
        {showRadius && (
          <Field label={t('canvas.insp.cornerRadius')}>
            <NumberInput
              min={MIN_CORNER_RADIUS}
              max={MAX_CORNER_RADIUS}
              value={resolveFrameCornerRadius(element)}
              onCommit={(n) => onPatch({ cornerRadius: clampCornerRadius(n) })}
            />
          </Field>
        )}
      </div>
      {/* Fill only for types whose width/height actually drive their render —
          a text element renders at natural width, so a Fill-written size would
          slot siblings around a phantom box (and outlive the toggle). */}
      {parentLayout && def && (
        <FillSizingSelects element={element} onPatch={onPatch} parentLayout={parentLayout} />
      )}
    </>
  )
}

// Layout-child resizing (Figma "Fill container"): per visual axis a Fixed /
// Fill select. The visual axis maps onto fillMain / fillCross through the
// PARENT's mode — a row parent's W is its main axis, a column parent's H is.
const FillSizingSelects = ({
  element,
  onPatch,
  parentLayout,
}: {
  element: CanvasElement
  onPatch: (patch: Partial<CanvasElement>) => void
  parentLayout: FrameLayout
}) => {
  const { t } = useT()
  const row = parentLayout.mode === 'row'
  const wFill = row ? element.fillMain : element.fillCross
  const hFill = row ? element.fillCross : element.fillMain
  const set = (axis: 'w' | 'h', fill: boolean) => {
    const v = fill ? true : undefined
    if ((axis === 'w') === row) onPatch({ fillMain: v })
    else onPatch({ fillCross: v })
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label={t('canvas.insp.fillW')}>
        <Select
          value={wFill ? 'fill' : 'fixed'}
          onChange={(v) => set('w', v === 'fill')}
          options={[
            { value: 'fixed', label: t('canvas.insp.sizingFixed') },
            { value: 'fill', label: t('canvas.insp.sizingFill') },
          ]}
        />
      </Field>
      <Field label={t('canvas.insp.fillH')}>
        <Select
          value={hFill ? 'fill' : 'fixed'}
          onChange={(v) => set('h', v === 'fill')}
          options={[
            { value: 'fixed', label: t('canvas.insp.sizingFixed') },
            { value: 'fill', label: t('canvas.insp.sizingFill') },
          ]}
        />
      </Field>
    </div>
  )
}

const MAX_LAYOUT_PX = 400
const clampLayoutPx = (n: number) =>
  Number.isFinite(n) ? Math.max(0, Math.min(MAX_LAYOUT_PX, Math.round(n))) : 0

const resolveSides = (l: FrameLayout) => ({
  top: l.paddingTop ?? l.padding,
  right: l.paddingRight ?? l.padding,
  bottom: l.paddingBottom ?? l.padding,
  left: l.paddingLeft ?? l.padding,
})

// ── Auto layout (frame only). A plain frame gets the "+ Auto layout" button;
//    a layout frame gets direction segment + 3×3 align grid (justify × align)
//    + gap with px/Auto unit (Auto = space-between) + collapsible per-side
//    padding + per-axis Fixed / Hug sizing. ──
const AutoLayoutProperties = ({
  element,
  onPatch,
  onAddAutoLayout,
}: {
  element: CanvasElement
  onPatch: (patch: Partial<CanvasElement>) => void
  onAddAutoLayout?: () => void
}) => {
  const { t } = useT()
  const layout = element.layout
  // Per-side padding starts expanded when a saved frame already carries
  // unequal sides; the toggle is user-controlled after that.
  const [padOpen, setPadOpen] = useState(() => {
    if (!layout) return false
    const s = resolveSides(layout)
    return !(s.top === s.right && s.right === s.bottom && s.bottom === s.left)
  })

  if (!layout) {
    return (
      <button
        type="button"
        onClick={
          onAddAutoLayout ??
          (() => onPatch({ layout: { mode: 'column', ...AUTO_LAYOUT_DEFAULTS } }))
        }
        className={[
          'flex h-7 w-full items-center justify-center rounded-[4px] border border-line bg-bg text-[12px] text-ink-subtle',
          'transition-colors hover:border-line-strong hover:bg-bg-elevated hover:text-ink active:bg-bg-inset',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
        ].join(' ')}
      >
        {t('canvas.insp.addAutoLayout')}
      </button>
    )
  }

  const spaceBetween = layout.justify === 'space-between'
  const sides = resolveSides(layout)
  const uniformPadding =
    sides.top === sides.right && sides.right === sides.bottom && sides.bottom === sides.left
      ? sides.top
      : null

  const modeBtns: {
    key: string
    active: boolean
    title: string
    icon: typeof Minus
    onClick: () => void
  }[] = [
    {
      key: 'none',
      active: false,
      title: t('canvas.insp.layoutNone'),
      icon: Minus,
      onClick: () => onPatch({ layout: undefined }),
    },
    {
      key: 'column',
      active: layout.mode === 'column',
      title: t('canvas.insp.layoutColumn'),
      icon: ArrowDown,
      onClick: () => onPatch({ layout: { ...layout, mode: 'column' } }),
    },
    {
      key: 'row',
      active: layout.mode === 'row',
      title: t('canvas.insp.layoutRow'),
      icon: ArrowRight,
      onClick: () => onPatch({ layout: { ...layout, mode: 'row' } }),
    },
  ]

  const wSizing = (layout.mode === 'row' ? layout.primarySizing : layout.counterSizing) ?? 'fixed'
  const hSizing = (layout.mode === 'row' ? layout.counterSizing : layout.primarySizing) ?? 'fixed'
  const setSizing = (axis: 'w' | 'h', v: string) => {
    const sizing = v === 'hug' ? ('hug' as const) : undefined
    const primary = (axis === 'w') === (layout.mode === 'row')
    onPatch({
      layout: primary
        ? { ...layout, primarySizing: sizing }
        : { ...layout, counterSizing: sizing },
    })
  }

  return (
    <>
      <div className="flex items-stretch gap-1">
        {modeBtns.map(({ key, active, title, icon: Icon, onClick }) => (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            title={title}
            onClick={onClick}
            className={[
              'flex h-7 flex-1 items-center justify-center rounded-[4px] border',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
              active
                ? 'border-accent bg-accent text-bg-card hover:bg-accent/90'
                : 'border-line bg-bg text-ink-muted hover:border-line-strong hover:bg-bg-elevated hover:text-ink',
            ].join(' ')}
          >
            <Icon size={14} strokeWidth={2.25} />
          </button>
        ))}
      </div>

      <div className="flex items-start gap-2">
        <AlignGrid layout={layout} onPatch={onPatch} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* Gap — number while discrete, a disabled "Auto" box while
              space-between distributes the children. */}
          <div className="flex items-end gap-1">
            <div className="min-w-0 flex-1">
              <Field label={t('canvas.insp.gap')}>
                {spaceBetween ? (
                  <input
                    disabled
                    readOnly
                    value={t('canvas.insp.gapAuto')}
                    className={`${INPUT_CLS} disabled:cursor-not-allowed disabled:opacity-40`}
                  />
                ) : (
                  <NumberInput
                    min={0}
                    max={MAX_LAYOUT_PX}
                    value={layout.gap}
                    onCommit={(n) => onPatch({ layout: { ...layout, gap: clampLayoutPx(n) } })}
                  />
                )}
              </Field>
            </div>
            <select
              aria-label={t('canvas.insp.gapMode')}
              value={spaceBetween ? 'auto' : 'px'}
              onChange={(e) =>
                onPatch({
                  layout: {
                    ...layout,
                    justify: e.target.value === 'auto' ? 'space-between' : undefined,
                  },
                })
              }
              className={`${INPUT_BASE_CLS} w-16 shrink-0 cursor-pointer`}
            >
              <option value="px">{t('canvas.insp.gapPx')}</option>
              <option value="auto">{t('canvas.insp.gapAuto')}</option>
            </select>
          </div>
          {/* Padding — uniform number, expandable to per-side. Committing the
              uniform value clears the per-side overrides. */}
          <div className="flex items-end gap-1">
            <div className="min-w-0 flex-1">
              <Field label={t('canvas.insp.padding')}>
                <NumberInput
                  min={0}
                  max={MAX_LAYOUT_PX}
                  value={uniformPadding}
                  placeholder={uniformPadding === null ? t('canvas.insp.mixed') : undefined}
                  onCommit={(n) =>
                    onPatch({
                      layout: {
                        ...layout,
                        padding: clampLayoutPx(n),
                        paddingTop: undefined,
                        paddingRight: undefined,
                        paddingBottom: undefined,
                        paddingLeft: undefined,
                      },
                    })
                  }
                />
              </Field>
            </div>
            <button
              type="button"
              aria-pressed={padOpen}
              aria-label={t('canvas.insp.paddingPerSide')}
              title={t('canvas.insp.paddingPerSide')}
              onClick={() => setPadOpen((v) => !v)}
              className={[
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] border',
                'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
                padOpen
                  ? 'border-accent bg-accent text-bg-card hover:bg-accent/90'
                  : 'border-line bg-bg text-ink-muted hover:border-line-strong hover:bg-bg-elevated hover:text-ink',
              ].join(' ')}
            >
              <Expand size={12} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>

      {padOpen && (
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['canvas.insp.paddingTop', 'paddingTop', sides.top],
              ['canvas.insp.paddingRight', 'paddingRight', sides.right],
              ['canvas.insp.paddingBottom', 'paddingBottom', sides.bottom],
              ['canvas.insp.paddingLeft', 'paddingLeft', sides.left],
            ] as const
          ).map(([labelKey, prop, value]) => (
            <Field key={prop} label={t(labelKey)}>
              <NumberInput
                min={0}
                max={MAX_LAYOUT_PX}
                value={value}
                onCommit={(n) => {
                  const px = clampLayoutPx(n)
                  const next =
                    prop === 'paddingTop'
                      ? { ...layout, paddingTop: px }
                      : prop === 'paddingRight'
                        ? { ...layout, paddingRight: px }
                        : prop === 'paddingBottom'
                          ? { ...layout, paddingBottom: px }
                          : { ...layout, paddingLeft: px }
                  onPatch({ layout: next })
                }}
              />
            </Field>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('canvas.insp.sizingW')}>
          <Select
            value={wSizing}
            onChange={(v) => setSizing('w', v)}
            options={[
              { value: 'fixed', label: t('canvas.insp.sizingFixed') },
              { value: 'hug', label: t('canvas.insp.sizingHug') },
            ]}
          />
        </Field>
        <Field label={t('canvas.insp.sizingH')}>
          <Select
            value={hSizing}
            onChange={(v) => setSizing('h', v)}
            options={[
              { value: 'fixed', label: t('canvas.insp.sizingFixed') },
              { value: 'hug', label: t('canvas.insp.sizingHug') },
            ]}
          />
        </Field>
      </div>
    </>
  )
}

// ── 3×3 align grid — each cell is a (justify, align) pair laid out spatially:
//    the main axis follows the layout mode (row → columns are justify,
//    column → rows are justify). While space-between distributes the main
//    axis, the active cross line renders as spread bars and clicking any cell
//    overrides justify back to that cell's discrete value (Figma-parity). ──
const GRID_POS = ['start', 'center', 'end'] as const
const CELL_KEYS = [
  ['canvas.insp.cellTopLeft', 'canvas.insp.cellTopCenter', 'canvas.insp.cellTopRight'],
  ['canvas.insp.cellMiddleLeft', 'canvas.insp.cellCenter', 'canvas.insp.cellMiddleRight'],
  ['canvas.insp.cellBottomLeft', 'canvas.insp.cellBottomCenter', 'canvas.insp.cellBottomRight'],
] as const

const AlignGrid = ({
  layout,
  onPatch,
}: {
  layout: FrameLayout
  onPatch: (patch: Partial<CanvasElement>) => void
}) => {
  const { t } = useT()
  const row = layout.mode === 'row'
  const justify = layout.justify ?? 'start'
  const spaceBetween = justify === 'space-between'
  return (
    <div className="grid w-[88px] shrink-0 grid-cols-3 rounded-[4px] border border-line bg-bg p-0.5">
      {[0, 1, 2].flatMap((r) =>
        [0, 1, 2].map((c) => {
          const cellJustify = row ? GRID_POS[c] : GRID_POS[r]
          const cellAlign = row ? GRID_POS[r] : GRID_POS[c]
          const active = spaceBetween
            ? cellAlign === layout.align
            : cellJustify === justify && cellAlign === layout.align
          return (
            <button
              key={`${r}-${c}`}
              type="button"
              aria-pressed={active}
              aria-label={t(CELL_KEYS[r][c])}
              title={t(CELL_KEYS[r][c])}
              onClick={() =>
                // While spacing is Auto, the grid only steers the CROSS axis —
                // exiting space-between is the gap-mode select's job (Figma).
                onPatch({
                  layout: {
                    ...layout,
                    justify: spaceBetween ? 'space-between' : cellJustify,
                    align: cellAlign,
                  },
                })
              }
              className={[
                'flex h-[26px] items-center justify-center rounded-[3px] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
                active
                  ? 'bg-accent text-bg-card hover:bg-accent/90'
                  : 'text-ink-faint hover:bg-bg-inset hover:text-ink',
              ].join(' ')}
            >
              {spaceBetween && active ? (
                <span className={row ? 'h-2 w-0.5 bg-current' : 'h-0.5 w-2 bg-current'} />
              ) : (
                <span className="h-1 w-1 rounded-full bg-current" />
              )}
            </button>
          )
        }),
      )}
    </div>
  )
}

// CSS mix-blend-mode catalogue (Figma's blend list maps 1:1 onto these).
const BLEND_MODES: { value: NonNullable<CanvasElement['blendMode']>; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color dodge' },
  { value: 'color-burn', label: 'Color burn' },
  { value: 'hard-light', label: 'Hard light' },
  { value: 'soft-light', label: 'Soft light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
]

// ── Layer — opacity / blend mode / visibility / lock, common to every type. ──
const LayerProperties = ({
  element,
  onPatch,
}: {
  element: CanvasElement
  onPatch: (patch: Partial<CanvasElement>) => void
}) => {
  const { t } = useT()
  return (
    <>
      <OpacityField
        percent={Math.round(resolveOpacity(element) * 100)}
        onPercent={(n) => onPatch({ opacity: opacityFromPercent(n) })}
      />
      <Field label={t('canvas.insp.blend')}>
        <select
          value={element.blendMode ?? 'normal'}
          onChange={(e) =>
            onPatch({
              blendMode:
                e.target.value === 'normal'
                  ? undefined
                  : (e.target.value as NonNullable<CanvasElement['blendMode']>),
            })
          }
          className={`${INPUT_CLS} cursor-pointer`}
        >
          {BLEND_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('canvas.insp.visibility')}>
          <ToggleButton
            active={!!element.hidden}
            onClick={() => onPatch({ hidden: element.hidden ? undefined : true })}
            icon={element.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
            label={element.hidden ? t('canvas.insp.hidden') : t('canvas.insp.visible')}
          />
        </Field>
        <Field label={t('canvas.insp.lock')}>
          <ToggleButton
            active={!!element.locked}
            onClick={() => onPatch({ locked: element.locked ? undefined : true })}
            icon={element.locked ? <Lock size={12} /> : <Unlock size={12} />}
            label={element.locked ? t('canvas.insp.locked') : t('canvas.insp.unlocked')}
          />
        </Field>
      </div>
    </>
  )
}

// ── Opacity — 0..100% slider + number, mapped to the 0..1 `opacity` field.
//    `percent: null` renders the multi-select Mixed state (slider parks at
//    100, the number field shows the Mixed placeholder). ──
const OpacityField = ({
  percent,
  onPercent,
}: {
  percent: number | null
  onPercent: (n: number) => void
}) => {
  const { t } = useT()
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Field label={t('canvas.insp.opacity')}>
          <input
            type="range"
            min={0}
            max={100}
            value={percent ?? 100}
            onChange={(e) => onPercent(e.target.valueAsNumber)}
            className="h-7 w-full min-w-0 cursor-pointer accent-accent rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          />
        </Field>
      </div>
      <div className="w-14 shrink-0">
        <NumberInput
          min={0}
          max={100}
          value={percent}
          placeholder={percent === null ? t('canvas.insp.mixed') : undefined}
          ariaLabel={t('canvas.insp.opacity')}
          onCommit={onPercent}
        />
      </div>
    </div>
  )
}

// ── Frame / shape fill + stroke. Fill → the optional `fill` field; stroke
//    colour + width → `strokeColor` / `strokeWidth`. All optional + backward-
//    compatible (a legacy frame resolves to the historical defaults). ──
const FillStrokeSections = ({
  element,
  onPatch,
}: {
  element: CanvasElement
  onPatch: (patch: Partial<CanvasElement>) => void
}) => {
  const { t } = useT()
  const { fill, strokeColor, strokeWidth } =
    element.type === 'frame' ? resolveFrameStyle(element) : resolveShapeStyle(element)
  return (
    <>
      <Section title={t('canvas.insp.fill')}>
        <ColorField
          srLabel={t('canvas.insp.fill')}
          value={fill}
          onChange={(color) => onPatch({ fill: color })}
        />
      </Section>
      <Section title={t('canvas.insp.stroke')}>
        <ColorField
          srLabel={t('canvas.insp.stroke')}
          value={strokeColor}
          onChange={(color) => onPatch({ strokeColor: color })}
        />
        <Field label={t('canvas.insp.strokeWidth')}>
          <NumberInput
            min={MIN_STROKE_WIDTH}
            max={MAX_STROKE_WIDTH}
            value={strokeWidth}
            onCommit={(n) => onPatch({ strokeWidth: clampStrokeWidth(n) })}
          />
        </Field>
      </Section>
    </>
  )
}

// ── Text typography controls. Each edit is applied live + persisted through
//    onPatch; numeric fields clamp at commit (blur / Enter). ──
const TextProperties = ({
  element,
  onPatch,
}: {
  element: CanvasElement
  onPatch: (patch: Partial<CanvasElement>) => void
}) => {
  const { t } = useT()
  const fontSize = element.fontSize ?? DEFAULT_TEXT_FONT_SIZE
  const fontFamily = element.fontFamily ?? FONT_DISPLAY_STACK
  const textColor = element.textColor ?? DEFAULT_TEXT_COLOR
  const fontWeight = element.fontWeight ?? DEFAULT_TEXT_FONT_WEIGHT
  const textAlign = element.textAlign ?? DEFAULT_TEXT_ALIGN
  const lineHeight = element.lineHeight ?? DEFAULT_LINE_HEIGHT
  const isBold = fontWeight >= BOLD_FONT_WEIGHT
  const sizing = textSizingOf(element)
  const vAlign = textVAlignOf(element)

  return (
    <>
      {/* Resize mode — Figma's textAutoResize. Switching keeps the box visually
          put (convertSizing seeds width/height from the current rendered box);
          the next ElementView measurement then re-derives the measured axes. */}
      <Field label={t('canvas.insp.textSizing')}>
        <Segmented
          value={sizing}
          options={TEXT_SIZING_MODES.map((m) => ({
            value: m,
            label:
              m === 'auto-width'
                ? t('canvas.insp.sizingAutoW')
                : m === 'auto-height'
                  ? t('canvas.insp.sizingAutoH')
                  : t('canvas.insp.sizingTextFixed'),
          }))}
          onChange={(v) => {
            const to = v as TextSizing
            if (to === sizing) return
            onPatch(convertSizing(element, to, textBox(element)))
          }}
        />
      </Field>

      {/* Vertical alignment — only meaningful for a fixed-height box (the two
          auto modes always hug their content height). */}
      {sizing === 'fixed' && (
        <Field label={t('canvas.insp.verticalAlign')}>
          <div className="flex items-stretch gap-1">
            {VALIGN_OPTIONS.map((a) => {
              const Icon = VALIGN_ICON[a]
              const active = vAlign === a
              const title =
                a === 'top'
                  ? t('canvas.insp.alignTop')
                  : a === 'middle'
                    ? t('canvas.insp.alignMiddle')
                    : t('canvas.insp.alignBottom')
              return (
                <button
                  key={a}
                  type="button"
                  aria-pressed={active}
                  title={title}
                  onClick={() => onPatch({ textVerticalAlign: a })}
                  className={[
                    'flex h-7 flex-1 items-center justify-center rounded-[4px] border',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
                    active
                      ? 'border-accent bg-accent text-bg-card hover:bg-accent/90'
                      : 'border-line bg-bg text-ink-muted hover:border-line-strong hover:bg-bg-elevated hover:text-ink',
                  ].join(' ')}
                >
                  <Icon size={14} strokeWidth={2.25} />
                </button>
              )
            })}
          </div>
        </Field>
      )}

      <Field label={t('canvas.insp.fontSize')}>
        <NumberInput
          min={MIN_TEXT_FONT_SIZE}
          max={MAX_TEXT_FONT_SIZE}
          value={fontSize}
          onCommit={(n) => onPatch({ fontSize: clampFontSize(n) })}
        />
      </Field>

      <Field label={t('canvas.insp.fontFamily')}>
        <select
          value={fontFamily}
          onChange={(e) => onPatch({ fontFamily: e.target.value })}
          className={`${INPUT_CLS} cursor-pointer`}
        >
          {/* If a saved element carries a family that isn't in the catalogue
              (e.g. set by Claude or a future build), surface it so the select
              shows the real value instead of silently snapping to option 0. */}
          {!FONT_OPTIONS.some((o) => o.value === fontFamily) && (
            <option value={fontFamily}>{t('canvas.insp.custom')}</option>
          )}
          {FONT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.labelKey ? t(o.labelKey) : o.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('canvas.insp.weight')}>
        <div className="flex items-center gap-2">
          {/* Bold toggle — a one-tap shortcut to 700 / back to 400, kept in
              sync with the weight select below (both write `fontWeight`). */}
          <button
            type="button"
            aria-pressed={isBold}
            title={t('canvas.insp.bold')}
            onClick={() =>
              onPatch({ fontWeight: isBold ? DEFAULT_TEXT_FONT_WEIGHT : BOLD_FONT_WEIGHT })
            }
            className={[
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] border text-ink',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
              isBold
                ? 'border-accent bg-accent text-bg-card hover:bg-accent/90'
                : 'border-line bg-bg hover:border-line-strong hover:bg-bg-elevated',
            ].join(' ')}
          >
            <Bold size={13} strokeWidth={2.5} />
          </button>
          <select
            value={fontWeight}
            onChange={(e) => onPatch({ fontWeight: Number(e.target.value) })}
            className={`${INPUT_CLS} min-w-0 flex-1 cursor-pointer`}
          >
            {/* Surface an off-catalogue weight (set by Claude / a future build)
                so the select shows the real value instead of snapping. */}
            {!WEIGHT_OPTIONS.some((o) => o.value === fontWeight) && (
              <option value={fontWeight}>{fontWeight}</option>
            )}
            {WEIGHT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </Field>

      <Field label={t('canvas.insp.alignment')}>
        <div className="flex items-stretch gap-1">
          {TEXT_ALIGN_OPTIONS.map((a) => {
            const Icon = ALIGN_ICON[a]
            const active = textAlign === a
            const alignTitle =
              a === 'left'
                ? t('canvas.insp.alignLeft')
                : a === 'center'
                  ? t('canvas.insp.alignCenter')
                  : t('canvas.insp.alignRight')
            return (
              <button
                key={a}
                type="button"
                aria-pressed={active}
                title={alignTitle}
                onClick={() => onPatch({ textAlign: a })}
                className={[
                  'flex h-7 flex-1 items-center justify-center rounded-[4px] border',
                  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
                  active
                    ? 'border-accent bg-accent text-bg-card hover:bg-accent/90'
                    : 'border-line bg-bg text-ink-muted hover:border-line-strong hover:bg-bg-elevated hover:text-ink',
                ].join(' ')}
              >
                <Icon size={14} strokeWidth={2.25} />
              </button>
            )
          })}
        </div>
      </Field>

      <Field label={t('canvas.insp.lineHeight')}>
        <NumberInput
          min={MIN_LINE_HEIGHT}
          max={MAX_LINE_HEIGHT}
          step={0.1}
          value={lineHeight}
          onCommit={(n) => onPatch({ lineHeight: clampLineHeight(n) })}
        />
      </Field>

      <ColorField
        label={t('canvas.insp.textColor')}
        value={textColor}
        onChange={(color) => onPatch({ textColor: color })}
      />
    </>
  )
}

// ── Multi selection — only the fields every member shares (decided by the
//    intersection of the selected types). A value all members agree on shows
//    as-is; a mismatch shows the Mixed placeholder. Edits go through
//    onPatchMany as ONE batch patch. ──
function commonValue<T>(elements: CanvasElement[], get: (e: CanvasElement) => T): T | null {
  const first = get(elements[0])
  return elements.every((e) => Object.is(get(e), first)) ? first : null
}

const MultiSelection = ({
  elements,
  onPatchMany,
}: {
  elements: CanvasElement[]
  onPatchMany?: (ids: string[], changes: Partial<CanvasElement>) => void
}) => {
  const { t } = useT()
  const ids = elements.map((e) => e.id)
  const patchAll = (changes: Partial<CanvasElement>) => onPatchMany?.(ids, changes)
  const mixed = t('canvas.insp.mixed')

  const allSized = elements.every((e) => SIZE_DEFAULTS[e.type] !== undefined)
  const x = commonValue(elements, (e) => Math.round(e.x))
  const y = commonValue(elements, (e) => Math.round(e.y))
  const w = commonValue(elements, (e) => Math.round(e.width ?? SIZE_DEFAULTS[e.type]?.w ?? 0))
  const h = commonValue(elements, (e) => Math.round(e.height ?? SIZE_DEFAULTS[e.type]?.h ?? 0))
  const rotation = commonValue(elements, (e) => Math.round(e.rotation ?? 0))
  const opacityPercent = commonValue(elements, (e) => Math.round(resolveOpacity(e) * 100))

  // Fill is offered only when every member stores its colour in the SAME
  // field: stickies (`color`), boxes (`fill` for frame/shape), or text
  // (`textColor`). A mixed-kind selection drops the section.
  const fillKind = elements.every((e) => e.type === 'sticky')
    ? ('sticky' as const)
    : elements.every((e) => e.type === 'frame' || e.type === 'shape')
      ? ('box' as const)
      : elements.every((e) => e.type === 'text')
        ? ('text' as const)
        : null
  const fillValue =
    fillKind === 'sticky'
      ? commonValue(elements, (e) => resolveStickyFill(e))
      : fillKind === 'box'
        ? commonValue(elements, (e) =>
            e.type === 'frame' ? resolveFrameStyle(e).fill : resolveShapeStyle(e).fill,
          )
        : fillKind === 'text'
          ? commonValue(elements, (e) => e.textColor ?? DEFAULT_TEXT_COLOR)
          : null
  const patchFill = (color: string) => {
    if (fillKind === 'sticky') patchAll({ color })
    else if (fillKind === 'box') patchAll({ fill: color })
    else if (fillKind === 'text') patchAll({ textColor: color })
  }

  return (
    <>
      <Section title={t('canvas.insp.selectedCount', { n: elements.length })}>
        <div className="grid grid-cols-2 gap-2">
          <Field label="X">
            <NumberInput
              value={x}
              placeholder={x === null ? mixed : undefined}
              onCommit={(n) => {
                if (Number.isFinite(n)) patchAll({ x: Math.round(n) })
              }}
            />
          </Field>
          <Field label="Y">
            <NumberInput
              value={y}
              placeholder={y === null ? mixed : undefined}
              onCommit={(n) => {
                if (Number.isFinite(n)) patchAll({ y: Math.round(n) })
              }}
            />
          </Field>
          {allSized && (
            <>
              <Field label="W">
                <NumberInput
                  min={RESIZE_MIN_W}
                  max={RESIZE_MAX}
                  value={w}
                  placeholder={w === null ? mixed : undefined}
                  onCommit={(n) => {
                    if (Number.isFinite(n)) patchAll({ width: clampWidth(n, RESIZE_MIN_W) })
                  }}
                />
              </Field>
              <Field label="H">
                <NumberInput
                  min={RESIZE_MIN_H}
                  max={RESIZE_MAX}
                  value={h}
                  placeholder={h === null ? mixed : undefined}
                  onCommit={(n) => {
                    if (Number.isFinite(n)) patchAll({ height: clampHeight(n, RESIZE_MIN_H) })
                  }}
                />
              </Field>
            </>
          )}
          <Field label={t('canvas.insp.rotation')}>
            <NumberInput
              min={-360}
              max={360}
              value={rotation}
              placeholder={rotation === null ? mixed : undefined}
              onCommit={(n) => {
                if (Number.isFinite(n)) patchAll({ rotation: normRotation(n) })
              }}
            />
          </Field>
        </div>
      </Section>
      <Section title={t('canvas.insp.layer')}>
        <OpacityField
          percent={opacityPercent}
          onPercent={(n) => patchAll({ opacity: opacityFromPercent(n) })}
        />
      </Section>
      {fillKind && (
        <Section
          title={fillKind === 'text' ? t('canvas.insp.textColor') : t('canvas.insp.fill')}
        >
          <ColorField
            srLabel={fillKind === 'text' ? t('canvas.insp.textColor') : t('canvas.insp.fill')}
            value={fillValue}
            placeholder={fillValue === null ? mixed : undefined}
            onChange={patchFill}
          />
        </Section>
      )}
    </>
  )
}

// Shared input/select chrome. INPUT_BASE_CLS carries no width so a caller can
// set its own (w-full and a fixed w-16 are conflicting utilities — Tailwind
// resolves by stylesheet order, not class order, so combining them is a trap).
const INPUT_BASE_CLS = [
  'h-7 rounded-[4px] border border-line bg-bg px-2 text-[12px] text-ink',
  'transition-colors hover:border-line-strong',
  'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
].join(' ')
const INPUT_CLS = `${INPUT_BASE_CLS} w-full`

const Select = ({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className={`${INPUT_CLS} cursor-pointer`}
  >
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
)

// A labelled segmented control — N equal pills, the active one filled accent.
// Matches the typography section's other segmented buttons (alignment, weight):
// 5-state styling (default / hover / selected / selected+hover / focus-visible).
const Segmented = ({
  value,
  options,
  onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) => (
  <div className="flex items-stretch gap-1">
    {options.map((o) => {
      const active = o.value === value
      return (
        <button
          key={o.value}
          type="button"
          aria-pressed={active}
          onClick={() => onChange(o.value)}
          className={[
            'flex h-7 min-w-0 flex-1 items-center justify-center rounded-[4px] border px-1 text-[11px]',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
            active
              ? 'border-accent bg-accent text-bg-card hover:bg-accent/90'
              : 'border-line bg-bg text-ink-muted hover:border-line-strong hover:bg-bg-elevated hover:text-ink',
          ].join(' ')}
        >
          <span className="truncate">{o.label}</span>
        </button>
      )
    })}
  </div>
)

const ToggleButton = ({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) => (
  <button
    type="button"
    onClick={onClick}
    className={[
      'flex h-7 w-full items-center justify-center gap-1.5 rounded-[4px] border text-[12px] transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
      active
        ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
        : 'border-line bg-bg text-ink-subtle hover:border-line-strong hover:text-ink',
    ].join(' ')}
  >
    {icon}
    {label}
  </button>
)

// A bare number input matching the panel's other fields. FREE while typing —
// the draft is parsed and handed to `onCommit` (which clamps) only on blur /
// Enter, so a partial keystroke is never fought by the clamp. Esc reverts the
// draft to the live value; Enter respects an in-flight IME composition.
// ↑/↓ step by 1 (or `step`) and commit immediately; holding Shift steps by 10
// — the Figma habit, mirroring the canvas's Shift-nudge. `value: null` is the
// multi-select Mixed state (empty field + placeholder).
const NumberInput = ({
  min,
  max,
  step,
  value,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  min?: number
  max?: number
  step?: number
  value: number | null
  placeholder?: string
  ariaLabel?: string
  onCommit: (n: number) => void
}) => {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (raw: string) => {
    setDraft(null)
    onCommit(raw.trim() === '' ? NaN : Number(raw))
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? (value === null ? '' : String(value))}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // IME guard: don't steal the Enter that confirms a conversion.
          if (e.nativeEvent.isComposing) return
          e.preventDefault()
          if (draft !== null) commit(draft)
        } else if (e.key === 'Escape') {
          if (draft !== null) {
            e.preventDefault()
            e.stopPropagation()
            setDraft(null)
          }
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const dir = e.key === 'ArrowUp' ? 1 : -1
          const by = e.shiftKey ? 10 : (step ?? 1)
          const base = draft !== null ? Number(draft) : (value ?? 0)
          setDraft(null)
          onCommit((Number.isFinite(base) ? base : 0) + dir * by)
        }
      }}
      className={INPUT_CLS}
    />
  )
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className="label-cap text-ink-faint">{label}</span>
    {children}
  </label>
)

// The native <input type="color"> only accepts a 6-digit hex. A fill can be any
// CSS colour (e.g. the frame default is an rgba() with alpha), so we (a) always
// render the *real* value in the swatch background + the editable hex field,
// and (b) feed the picker a parsed #rrggbb so it opens on a sensible colour
// instead of snapping to black. Picking from the swatch writes a clean hex;
// typing in the text field lets power users keep rgba/named colours.
const HEX6 = /^#[0-9a-fA-F]{6}$/
function toPickerHex(value: string): string {
  if (HEX6.test(value)) return value.toLowerCase()
  // #rgb shorthand → #rrggbb so the picker accepts it.
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(value)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  // rgb()/rgba() → drop alpha, hex the channels (the picker can't show alpha).
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value)
  if (rgb) {
    const h = (n: number) => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0')
    return `#${h(+rgb[1])}${h(+rgb[2])}${h(+rgb[3])}`
  }
  return '#000000'
}

// A swatch + hex field pair, used for every colour control on the panel (fill,
// stroke, and — via the same shape — text colour). Edits flow up through
// `onChange`; the parent funnels them to the undoable patch path. With `label`
// it renders as a labelled Field; without, the bare row (inside a titled
// Section) with `srLabel` keeping the hex input accessible. `value: null` is
// the multi-select Mixed state.
const ColorField = ({
  label,
  srLabel,
  value,
  placeholder,
  onChange,
}: {
  label?: string
  srLabel?: string
  value: string | null
  placeholder?: string
  onChange: (value: string) => void
}) => {
  const { t } = useT()
  const row = (
    <div className="flex items-center gap-2">
      <label
        className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-[4px] border border-line transition-colors hover:border-line-strong focus-within:ring-2 focus-within:ring-accent/40"
        style={{ background: value ?? undefined }}
        title={t('canvas.insp.pickColour')}
      >
        <input
          type="color"
          value={toPickerHex(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <input
        type="text"
        value={value ?? ''}
        placeholder={placeholder}
        aria-label={label ? undefined : srLabel}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={[
          'h-7 min-w-0 flex-1 rounded-[4px] border border-line bg-bg px-2 font-mono text-[11px] text-ink',
          'transition-colors hover:border-line-strong',
          'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
        ].join(' ')}
      />
    </div>
  )
  return label ? <Field label={label}>{row}</Field> : row
}
