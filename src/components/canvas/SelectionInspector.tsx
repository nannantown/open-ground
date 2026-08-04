import { useRef, useState } from 'react'
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
  Pipette,
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
import type { CanvasElement, CanvasShadow, FrameLayout } from '@/lib/types'
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
  NO_FILL,
  isNoFill,
  resolveStrokeStyle,
  STROKE_STYLES,
  type StrokeStyle,
  resolveStrokeAlign,
  STROKE_ALIGNS,
  type StrokeAlign,
} from '@/lib/canvasFillStyle'
import { resolveShapeStyle, resolveShapeKind } from '@/lib/canvasShape'
import { alphaOf, withAlpha, hasParsableColor, parseColor, formatColor } from '@/lib/canvasColor'
import { getRecentColors, pushRecentColor } from '@/lib/recentColors'
import { clampShadow, DEFAULT_SHADOW, MAX_SHADOW_BLUR } from '@/lib/canvasShadow'
import {
  resolveImageFillMode,
  IMAGE_FILL_MODES,
  type ImageFillMode,
} from '@/lib/canvasImageFill'
import { uploadCanvasAsset, canvasAssetUrl } from '@/lib/canvasAssets'
import { useCanvasAsset } from './CanvasAssetContext'
import {
  parseGradient,
  formatGradient,
  defaultGradient,
  type Gradient,
} from '@/lib/canvasGradient'
import {
  TEXT_SIZING_MODES,
  textSizingOf,
  textVAlignOf,
  textBox,
  convertSizing,
  type TextSizing,
  type TextVAlign,
} from '@/lib/canvasTextSizing'
import { capTrackingClass } from '@/lib/labelScript'
import {
  resolveOpacity,
  opacityFromPercent,
  resolveCornerRadii,
  cornerRadiiAreUniform,
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
            'hover:bg-plane hover:text-ink active:bg-bg-elevated',
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
      </div>
      {/* key by element id so the per-corner expand/collapse state is PER element
          — without it the local `expanded` useState leaks onto the next
          selection (a uniform frame would inherit the previous one's open grid). */}
      {showRadius && <CornerRadiusField key={element.id} element={element} onPatch={onPatch} />}
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
          'transition-colors hover:border-line-strong hover:bg-bg-elevated hover:text-ink active:bg-plane',
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
    <div
      role="group"
      aria-label={t('canvas.insp.alignGrid')}
      className="grid w-[88px] shrink-0 grid-cols-3 rounded-[4px] border border-line bg-bg p-0.5"
    >
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
                  : 'text-ink-faint hover:bg-plane hover:text-ink',
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
  // Recent colours (shared across fill + stroke). State so a freshly-remembered
  // colour shows up in the strip without waiting for the next external render.
  const [recents, setRecents] = useState(getRecentColors)
  const remember = (c: string) => setRecents(pushRecentColor(c))
  return (
    <>
      <Section title={t('canvas.insp.fill')}>
        <FillControl
          element={element}
          fill={fill}
          onPatch={onPatch}
          remember={remember}
          recents={recents}
        />
      </Section>
      <Section title={t('canvas.insp.stroke')}>
        <ColorField
          srLabel={t('canvas.insp.stroke')}
          value={strokeColor}
          onChange={(color) => onPatch({ strokeColor: color })}
          allowNoFill
          onCommitColor={remember}
        />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('canvas.insp.strokeWidth')}>
            <NumberInput
              min={MIN_STROKE_WIDTH}
              max={MAX_STROKE_WIDTH}
              value={strokeWidth}
              onCommit={(n) => onPatch({ strokeWidth: clampStrokeWidth(n) })}
            />
          </Field>
          <Field label={t('canvas.insp.strokeStyle')}>
            <StrokeStylePicker
              value={resolveStrokeStyle(element)}
              onChange={(s) => onPatch({ strokeStyle: s })}
            />
          </Field>
        </div>
        <Field label={t('canvas.insp.strokeAlign')}>
          <StrokeAlignPicker
            value={resolveStrokeAlign(element)}
            onChange={(a) => onPatch({ strokeAlign: a })}
          />
        </Field>
      </Section>
      <EffectsSection element={element} onPatch={onPatch} />
    </>
  )
}

// Effects (Figma drop / inner shadow): an editable list of shadow layers. Each
// shadow → X / Y / blur / spread / colour + a drop|inner toggle. Empty = no
// Effects (just an add button), so a legacy element is untouched.
const EffectsSection = ({
  element,
  onPatch,
}: {
  element: CanvasElement
  onPatch: (patch: Partial<CanvasElement>) => void
}) => {
  const { t } = useT()
  const shadows = element.shadows ?? []
  const setShadow = (i: number, patch: Partial<CanvasShadow>) =>
    onPatch({ shadows: shadows.map((s, j) => (j === i ? clampShadow({ ...s, ...patch }) : s)) })
  const addShadow = () => onPatch({ shadows: [...shadows, DEFAULT_SHADOW] })
  const removeShadow = (i: number) => onPatch({ shadows: shadows.filter((_, j) => j !== i) })
  return (
    <Section title={t('canvas.insp.effects')}>
      <div className="flex flex-col gap-2">
        {shadows.map((s, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-[4px] border border-line p-1.5">
            <div className="flex items-center gap-1.5">
              {/* drop / inner toggle */}
              <div className="flex h-6 flex-1 items-stretch overflow-hidden rounded-[4px] border border-line">
                {(['drop', 'inner'] as const).map((ty, k) => {
                  const active = (s.type === 'inner' ? 'inner' : 'drop') === ty
                  return (
                    <button
                      key={ty}
                      type="button"
                      onClick={() => setShadow(i, { type: ty })}
                      aria-pressed={active}
                      className={[
                        'flex-1 text-[10px] font-medium transition-colors',
                        k > 0 ? 'border-l border-line' : '',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                        active ? 'bg-accent/10 text-accent' : 'text-ink-faint hover:bg-bg-elevated hover:text-ink',
                      ].join(' ')}
                    >
                      {t(ty === 'drop' ? 'canvas.insp.shadowDrop' : 'canvas.insp.shadowInner')}
                    </button>
                  )
                })}
              </div>
              <button
                type="button"
                onClick={() => removeShadow(i)}
                title={t('canvas.insp.removeEffect')}
                aria-label={t('canvas.insp.removeEffect')}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-[4px] border border-line text-ink-faint transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <Minus size={13} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Field label={t('canvas.insp.shadowX')}>
                <NumberInput value={s.x} onCommit={(n) => setShadow(i, { x: n })} />
              </Field>
              <Field label={t('canvas.insp.shadowY')}>
                <NumberInput value={s.y} onCommit={(n) => setShadow(i, { y: n })} />
              </Field>
              <Field label={t('canvas.insp.shadowBlur')}>
                <NumberInput min={0} max={MAX_SHADOW_BLUR} value={s.blur} onCommit={(n) => setShadow(i, { blur: n })} />
              </Field>
              <Field label={t('canvas.insp.shadowSpread')}>
                <NumberInput value={s.spread} onCommit={(n) => setShadow(i, { spread: n })} />
              </Field>
            </div>
            <ColorField
              srLabel={t('canvas.insp.shadowColour')}
              value={s.color}
              onChange={(color) => setShadow(i, { color })}
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addShadow}
          className="self-start rounded-[4px] border border-line px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          + {t('canvas.insp.addEffect')}
        </button>
      </div>
    </Section>
  )
}

// Solid / dashed / dotted segmented control — each button previews the line
// style as an SVG so it reads regardless of locale. Mirrors the active-state
// styling used elsewhere on the panel (accent fill when selected).
const STROKE_STYLE_LABEL: Record<StrokeStyle, string> = {
  solid: 'canvas.insp.strokeSolid',
  dashed: 'canvas.insp.strokeDashed',
  dotted: 'canvas.insp.strokeDotted',
}
const StrokeStylePicker = ({
  value,
  onChange,
}: {
  value: StrokeStyle
  onChange: (s: StrokeStyle) => void
}) => {
  const { t } = useT()
  return (
    <div className="flex h-7 items-stretch overflow-hidden rounded-[4px] border border-line">
      {STROKE_STYLES.map((s, i) => {
        const active = value === s
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            title={t(STROKE_STYLE_LABEL[s])}
            aria-label={t(STROKE_STYLE_LABEL[s])}
            aria-pressed={active}
            className={[
              'grid flex-1 place-items-center transition-colors',
              i > 0 ? 'border-l border-line' : '',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              active
                ? 'bg-accent/10 text-accent'
                : 'text-ink-faint hover:bg-bg-elevated hover:text-ink',
            ].join(' ')}
          >
            <svg width="20" height="8" viewBox="0 0 20 8" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              <line
                x1="1"
                y1="4"
                x2="19"
                y2="4"
                strokeLinecap="round"
                strokeDasharray={s === 'dashed' ? '4 3' : s === 'dotted' ? '0.1 3' : undefined}
              />
            </svg>
          </button>
        )
      })}
    </div>
  )
}

// Inside / center / outside segmented control — each button shows where the
// stroke (heavy line) sits relative to the shape edge (thin line).
const STROKE_ALIGN_LABEL: Record<StrokeAlign, string> = {
  inside: 'canvas.insp.strokeInside',
  center: 'canvas.insp.strokeCenter',
  outside: 'canvas.insp.strokeOutside',
}
const StrokeAlignPicker = ({
  value,
  onChange,
}: {
  value: StrokeAlign
  onChange: (a: StrokeAlign) => void
}) => {
  const { t } = useT()
  return (
    <div className="flex h-7 items-stretch overflow-hidden rounded-[4px] border border-line">
      {STROKE_ALIGNS.map((a, i) => {
        const active = value === a
        // Heavy stroke line offset from the edge line by the alignment.
        const edgeY = 6.5 // the shape edge
        const strokeY = a === 'inside' ? 4.5 : a === 'center' ? 6.5 : 8.5
        return (
          <button
            key={a}
            type="button"
            onClick={() => onChange(a)}
            title={t(STROKE_ALIGN_LABEL[a])}
            aria-label={t(STROKE_ALIGN_LABEL[a])}
            aria-pressed={active}
            className={[
              'grid flex-1 place-items-center transition-colors',
              i > 0 ? 'border-l border-line' : '',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              active
                ? 'bg-accent/10 text-accent'
                : 'text-ink-faint hover:bg-bg-elevated hover:text-ink',
            ].join(' ')}
          >
            <svg width="20" height="13" viewBox="0 0 20 13" fill="none" aria-hidden>
              {/* shape edge (thin) + stroke (heavy) at the aligned offset */}
              <line x1="2" y1={edgeY} x2="18" y2={edgeY} stroke="currentColor" strokeWidth="1" opacity="0.45" />
              <line x1="2" y1={strokeY} x2="18" y2={strokeY} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )
      })}
    </div>
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
            allowNoFill={fillKind === 'box'}
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
    <span className={`label-cap ${capTrackingClass(label)} text-ink-faint`}>{label}</span>
    {children}
  </label>
)

// The native <input type="color"> only accepts a 6-digit hex. A fill can be any
// CSS colour (hex incl. #rrggbbaa, rgb()/rgba() in either syntax, …), so we
// render the *real* value in the swatch + the editable hex field, and feed the
// picker a parsed #rrggbb — alpha dropped, the native control can't show it — so
// it opens on a sensible colour instead of snapping to black. parseColor covers
// every form we store, INCLUDING the 8-digit hex the opacity control now writes
// (the old regex only matched #rrggbb, so a partial-opacity fill snapped to
// black on reopen). Unparseable (named / hsl / gradient) → black, as before.
function toPickerHex(value: string): string {
  const c = parseColor(value)
  return c ? formatColor({ ...c, a: 1 }) : '#000000'
}

// The classic "transparent" indicator — a small grey/white checkerboard — shown
// in the swatch when a fill is set to no-fill, so an empty paint reads as
// deliberate rather than broken (Figma does the same).
const CHECKERBOARD: React.CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage:
    'linear-gradient(45deg, #c8c8c8 25%, transparent 25%), linear-gradient(-45deg, #c8c8c8 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #c8c8c8 75%), linear-gradient(-45deg, transparent 75%, #c8c8c8 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
}

// The native EyeDropper API (Chromium → available in the Electron / Chrome shell
// OPEN GROUND runs in; absent in the jsdom test env, so the button self-hides).
const supportsEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window

// A swatch + hex field pair, used for every colour control on the panel (fill,
// stroke, and — via the same shape — text colour). Edits flow up through
// `onChange`; the parent funnels them to the undoable patch path. With `label`
// it renders as a labelled Field; without, the bare row (inside a titled
// Section) with `srLabel` keeping the hex input accessible. `value: null` is
// the multi-select Mixed state.
// `allowNoFill` (frame/shape fill + stroke) adds a Figma-style eye toggle that
// flips the paint between a real colour and `transparent`, and paints the swatch
// as a checkerboard while cleared. Off for text / sticky, where a transparent
// paint would just make content vanish with no visual cue.
const ColorField = ({
  label,
  srLabel,
  value,
  placeholder,
  onChange,
  allowNoFill = false,
  onCommitColor,
  recentColors,
  onPickRecent,
}: {
  label?: string
  srLabel?: string
  value: string | null
  placeholder?: string
  onChange: (value: string) => void
  allowNoFill?: boolean
  /** Called when a colour is DELIBERATELY committed (picker closed, hex blurred,
   *  eyedropper picked) — drives the recent-colours history. Not called on the
   *  live drag stream. */
  onCommitColor?: (value: string) => void
  /** When provided, a row of recent-colour swatches renders under the control;
   *  clicking one calls onPickRecent. */
  recentColors?: string[]
  onPickRecent?: (value: string) => void
}) => {
  const { t } = useT()
  const noFill = allowNoFill && isNoFill(value)
  // Commit the current value to history on a deliberate close/blur (never on the
  // live onChange stream, which would flood recents while dragging the picker).
  const commit = () => {
    if (value) onCommitColor?.(value)
  }
  // Remember the last REAL colour so toggling the fill back on restores it
  // instead of snapping to an arbitrary default. Derived during render (a plain
  // assignment from the current value — idempotent, no effect needed).
  const lastReal = useRef('#FFFFFF')
  if (value && !isNoFill(value)) lastReal.current = value
  // Per-fill opacity (Figma's fill row has a % next to the swatch): the alpha is
  // folded into the colour string as #rrggbbaa. Only shown for fill/stroke
  // (allowNoFill) on a parseable colour that isn't cleared — a named colour /
  // gradient can't carry alpha here, and a cleared fill uses the eye toggle.
  const showOpacity = allowNoFill && !noFill && hasParsableColor(value)
  const opacityPct = showOpacity ? Math.round(alphaOf(value) * 100) : null
  // Eyedropper (Figma's `I`): sample any on-screen pixel, keeping the current
  // alpha — unless the fill was cleared, where a pick re-enables it opaque.
  const pickFromScreen = () => {
    const W = window as unknown as {
      EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> }
    }
    if (!W.EyeDropper) return
    new W.EyeDropper()
      .open()
      .then((r) => {
        const next = noFill ? r.sRGBHex : withAlpha(r.sRGBHex, alphaOf(value))
        onChange(next)
        onCommitColor?.(next)
      })
      .catch(() => {}) // user pressed Esc — ignore
  }
  const row = (
    <div className="flex items-center gap-1.5">
      <label
        className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-[4px] border border-line transition-colors hover:border-line-strong focus-within:ring-2 focus-within:ring-accent/40"
        style={CHECKERBOARD}
        title={t('canvas.insp.pickColour')}
      >
        {/* Colour layer over a checkerboard, so ANY alpha < 1 — a partial fill OR
            a fully-cleared one — reads as transparency, Figma-style. */}
        <span aria-hidden className="absolute inset-0" style={{ background: value ?? undefined }} />
        <input
          type="color"
          value={toPickerHex(noFill ? lastReal.current : (value ?? ''))}
          // Picking a hue keeps the current alpha (Figma); picking while cleared
          // re-enables the fill opaque.
          onChange={(e) =>
            onChange(noFill ? e.target.value : withAlpha(e.target.value, alphaOf(value)))
          }
          onBlur={commit} // picker closed → remember the chosen colour
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <input
        type="text"
        value={value ?? ''}
        placeholder={placeholder}
        aria-label={label ? undefined : srLabel}
        onChange={(e) => onChange(e.target.value)}
        onBlur={commit} // hex edited → remember on blur
        spellCheck={false}
        className={[
          'h-7 min-w-0 flex-1 rounded-[4px] border border-line bg-bg px-2 font-mono text-[11px] text-ink',
          'transition-colors hover:border-line-strong',
          'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
        ].join(' ')}
      />
      {supportsEyeDropper && (
        <button
          type="button"
          onClick={pickFromScreen}
          title={t('canvas.insp.eyedropper')}
          aria-label={t('canvas.insp.eyedropper')}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[4px] border border-line text-ink-faint transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Pipette size={14} />
        </button>
      )}
      {allowNoFill && (
        <button
          type="button"
          onClick={() => onChange(noFill ? lastReal.current : NO_FILL)}
          title={noFill ? t('canvas.insp.addFill') : t('canvas.insp.noFill')}
          aria-label={noFill ? t('canvas.insp.addFill') : t('canvas.insp.noFill')}
          aria-pressed={noFill}
          className={[
            'grid h-7 w-7 shrink-0 place-items-center rounded-[4px] border transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            noFill
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-line text-ink-faint hover:border-line-strong hover:text-ink',
          ].join(' ')}
        >
          {noFill ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      )}
    </div>
  )
  // Per-fill opacity on its OWN labelled row: Figma keeps it inline, but at this
  // panel width that squeezes the hex field to ~6 chars — and a labelled row also
  // tells the FILL opacity apart from the LAYER opacity in the section above.
  const content = (
    <div className="flex flex-col gap-1.5">
      {row}
      {showOpacity && (
        <div className="flex items-center gap-2">
          <span className="label-cap shrink-0 text-ink-faint">{t('canvas.insp.opacity')}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={opacityPct ?? 100}
            aria-label={t('canvas.insp.fillOpacity')}
            onChange={(e) => onChange(withAlpha(value, e.target.valueAsNumber / 100))}
            className="h-7 min-w-0 flex-1 cursor-pointer rounded accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          />
          <div className="w-12 shrink-0">
            <NumberInput
              min={0}
              max={100}
              value={opacityPct}
              ariaLabel={t('canvas.insp.fillOpacity')}
              onCommit={(n) => {
                if (Number.isFinite(n)) onChange(withAlpha(value, Math.min(100, Math.max(0, n)) / 100))
              }}
            />
          </div>
        </div>
      )}
      {recentColors && recentColors.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('canvas.insp.recentColors')}>
          {recentColors.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onPickRecent?.(c)}
              title={c}
              aria-label={c}
              className="relative h-4 w-4 shrink-0 overflow-hidden rounded-[3px] border border-line transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              style={CHECKERBOARD}
            >
              <span aria-hidden className="absolute inset-0" style={{ background: c }} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
  return label ? <Field label={label}>{content}</Field> : content
}

// The frame/shape FILL control: a Solid / Linear / Radial type switch above the
// editor. Solid → the rich ColorField (opacity / eyedropper / no-fill / recents).
// Linear / Radial → the gradient editor. The `fill` field holds either a solid
// CSS colour or a gradient string; the views render both via `background`.
type FillMode = 'solid' | 'linear' | 'radial' | 'image'
const FILL_MODE_LABEL: Record<FillMode, string> = {
  solid: 'canvas.insp.fillSolid',
  linear: 'canvas.insp.fillLinear',
  radial: 'canvas.insp.fillRadial',
  image: 'canvas.insp.fillImage',
}
const FillControl = ({
  element,
  fill,
  onPatch,
  remember,
  recents,
}: {
  element: CanvasElement
  fill: string
  onPatch: (patch: Partial<CanvasElement>) => void
  remember: (c: string) => void
  recents: string[]
}) => {
  const { t } = useT()
  const asset = useCanvasAsset()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const onChange = (f: string) => onPatch({ fill: f })
  const grad = parseGradient(fill)
  const hasImage = !!element.fillImageId
  const mode: FillMode = hasImage ? 'image' : grad ? grad.type : 'solid'
  // Image mode requires the canvas asset context (upload target). Hide it on
  // surfaces without one rather than offering an upload that can't work.
  const modes: FillMode[] = asset ? ['solid', 'linear', 'radial', 'image'] : ['solid', 'linear', 'radial']

  const pickImage = () => fileRef.current?.click()
  const onFile = async (file: File | undefined) => {
    if (!file || !asset) return
    setUploading(true)
    const up = await uploadCanvasAsset(asset.projectPath, asset.canvasId, file)
    setUploading(false)
    if (up) onPatch({ fillImageId: up.assetId })
  }
  // Switching mode. Leaving image clears `fillImageId`; entering it opens the
  // file picker (the fill only becomes an image once a file uploads). solid ↔
  // gradient converts losslessly, seeding from the current colour.
  const switchMode = (next: FillMode) => {
    if (next === mode) return
    if (next === 'image') {
      pickImage()
      return
    }
    const patch: Partial<CanvasElement> = hasImage ? { fillImageId: undefined } : {}
    if (next === 'solid') patch.fill = grad ? grad.stops[0].color : fill
    else if (grad) patch.fill = formatGradient({ ...grad, type: next })
    else patch.fill = formatGradient(defaultGradient(isNoFill(fill) ? '#cccccc' : fill, next))
    onPatch(patch)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0])
          e.target.value = '' // allow re-picking the same file
        }}
      />
      <div className="flex h-7 items-stretch overflow-hidden rounded-[4px] border border-line">
        {modes.map((m, i) => {
          const active = mode === m
          return (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              aria-pressed={active}
              className={[
                'flex-1 text-[10px] font-medium uppercase tracking-wide transition-colors',
                i > 0 ? 'border-l border-line' : '',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                active ? 'bg-accent/10 text-accent' : 'text-ink-faint hover:bg-bg-elevated hover:text-ink',
              ].join(' ')}
            >
              {t(FILL_MODE_LABEL[m])}
            </button>
          )
        })}
      </div>
      {mode === 'image' && asset ? (
        <ImageFillField
          element={element}
          assetUrl={
            element.fillImageId
              ? canvasAssetUrl(asset.projectPath, asset.canvasId, element.fillImageId)
              : ''
          }
          uploading={uploading}
          onReplace={pickImage}
          onSetMode={(m) => onPatch({ fillImageMode: m })}
        />
      ) : grad ? (
        <GradientField gradient={grad} onChange={(g) => onChange(formatGradient(g))} remember={remember} />
      ) : (
        <ColorField
          srLabel={t('canvas.insp.fill')}
          value={fill}
          onChange={onChange}
          allowNoFill
          onCommitColor={remember}
          recentColors={recents}
          onPickRecent={(c) => {
            onChange(c)
            remember(c)
          }}
        />
      )}
    </div>
  )
}

// The image-fill editor: a preview, a size-mode select (cover/contain/fill/tile),
// and a replace button. (Remove = switch back to Solid via the mode bar.)
const ImageFillField = ({
  element,
  assetUrl,
  uploading,
  onReplace,
  onSetMode,
}: {
  element: CanvasElement
  assetUrl: string
  uploading: boolean
  onReplace: () => void
  onSetMode: (m: ImageFillMode) => void
}) => {
  const { t } = useT()
  const mode = resolveImageFillMode(element)
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="h-16 w-full rounded-[4px] border border-line bg-bg-inset"
        style={
          assetUrl
            ? { backgroundImage: `url("${assetUrl.replace(/["\\]/g, '\\$&')}")`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' }
            : undefined
        }
        aria-label={t('canvas.insp.fillImage')}
      />
      <div className="flex items-center gap-1.5">
        <select
          value={mode}
          aria-label={t('canvas.insp.imageFit')}
          onChange={(e) => onSetMode(e.target.value as ImageFillMode)}
          className="h-7 min-w-0 flex-1 rounded-[4px] border border-line bg-bg px-2 text-[11px] text-ink transition-colors hover:border-line-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        >
          {IMAGE_FILL_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`canvas.insp.imageFit.${m}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onReplace}
          disabled={uploading}
          className="shrink-0 rounded-[4px] border border-line px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {uploading ? t('canvas.insp.imageUploading') : t('canvas.insp.imageReplace')}
        </button>
      </div>
    </div>
  )
}

// One gradient colour stop row. The hex text field BUFFERS its edit in a local
// draft and only commits a PARSEABLE colour (on blur / Enter) — a partial hex
// mid-keystroke (e.g. "#0000f") must never round-trip into the `fill` string,
// or it would momentarily not parse as a gradient and collapse the whole editor
// to solid mode. The swatch picker + position commit complete values already.
const GradientStopRow = ({
  stop,
  canRemove,
  onChange,
  onRemove,
  remember,
}: {
  stop: { color: string; pos: number }
  canRemove: boolean
  onChange: (patch: Partial<{ color: string; pos: number }>) => void
  onRemove: () => void
  remember: (c: string) => void
}) => {
  const { t } = useT()
  const [draft, setDraft] = useState<string | null>(null)
  const commitHex = () => {
    if (draft === null) return
    if (hasParsableColor(draft)) {
      onChange({ color: draft })
      remember(draft)
    }
    setDraft(null) // either way, drop the draft → field re-syncs to the real value
  }
  return (
    <div className="flex items-center gap-1.5">
      <label
        className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-[4px] border border-line"
        style={CHECKERBOARD}
        title={t('canvas.insp.pickColour')}
      >
        <span aria-hidden className="absolute inset-0" style={{ background: stop.color }} />
        <input
          type="color"
          value={toPickerHex(stop.color)}
          onChange={(e) => onChange({ color: withAlpha(e.target.value, alphaOf(stop.color)) })}
          onBlur={() => remember(stop.color)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <input
        type="text"
        value={draft ?? stop.color}
        aria-label={t('canvas.insp.stopColour')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitHex}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          else if (e.key === 'Escape') setDraft(null)
        }}
        spellCheck={false}
        className="h-6 min-w-0 flex-1 rounded-[4px] border border-line bg-bg px-2 font-mono text-[11px] text-ink transition-colors hover:border-line-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      />
      <div className="w-11 shrink-0">
        <NumberInput
          min={0}
          max={100}
          value={Math.round(stop.pos * 100)}
          ariaLabel={t('canvas.insp.stopPosition')}
          onCommit={(n) => {
            if (Number.isFinite(n)) onChange({ pos: Math.min(100, Math.max(0, n)) / 100 })
          }}
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        title={t('canvas.insp.removeStop')}
        aria-label={t('canvas.insp.removeStop')}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-[4px] border border-line text-ink-faint transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Minus size={13} />
      </button>
    </div>
  )
}

// The gradient editor: a live preview bar, an angle field (linear only), and an
// editable colour-stop list (swatch + position, add / remove, min 2 stops).
const GradientField = ({
  gradient,
  onChange,
  remember,
}: {
  gradient: Gradient
  onChange: (g: Gradient) => void
  remember: (c: string) => void
}) => {
  const { t } = useT()
  const stops = gradient.stops
  const setStop = (i: number, patch: Partial<{ color: string; pos: number }>) => {
    const next = stops.map((s, j) => (j === i ? { ...s, ...patch } : s))
    onChange({ ...gradient, stops: next })
  }
  const addStop = () => {
    // Insert a stop at the midpoint of the widest gap, colour = that midpoint.
    const sorted = [...stops].sort((a, b) => a.pos - b.pos)
    let gapStart = sorted[0]
    let gapEnd = sorted[sorted.length - 1]
    let widest = -1
    for (let i = 0; i < sorted.length - 1; i++) {
      const g = sorted[i + 1].pos - sorted[i].pos
      if (g > widest) {
        widest = g
        gapStart = sorted[i]
        gapEnd = sorted[i + 1]
      }
    }
    const pos = sorted.length < 2 ? 1 : (gapStart.pos + gapEnd.pos) / 2
    onChange({ ...gradient, stops: [...stops, { color: gapStart.color, pos }] })
  }
  const removeStop = (i: number) => {
    if (stops.length <= 2) return // a gradient needs ≥2 stops
    onChange({ ...gradient, stops: stops.filter((_, j) => j !== i) })
  }
  return (
    <div className="flex flex-col gap-1.5">
      {/* live preview */}
      <div
        className="h-6 w-full rounded-[4px] border border-line"
        style={{ background: formatGradient(gradient) }}
        aria-hidden
      />
      {gradient.type === 'linear' && (
        <Field label={t('canvas.insp.gradientAngle')}>
          <NumberInput
            min={0}
            max={360}
            value={Math.round(gradient.angle)}
            onCommit={(n) => {
              if (Number.isFinite(n)) onChange({ ...gradient, angle: ((Math.round(n) % 360) + 360) % 360 })
            }}
          />
        </Field>
      )}
      <div className="flex flex-col gap-1">
        {stops.map((s, i) => (
          <GradientStopRow
            key={i}
            stop={s}
            canRemove={stops.length > 2}
            onChange={(patch) => setStop(i, patch)}
            onRemove={() => removeStop(i)}
            remember={remember}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={addStop}
        className="self-start rounded-[4px] border border-line px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        + {t('canvas.insp.addStop')}
      </button>
    </div>
  )
}

// Corner radius: one uniform field + a toggle that reveals the 2×2 per-corner
// grid (Figma's "independent corners"). A non-uniform element auto-expands;
// toggling OFF unifies back to a single value. Frame + rect only.
const CornerRadiusField = ({
  element,
  onPatch,
}: {
  element: CanvasElement
  onPatch: (patch: Partial<CanvasElement>) => void
}) => {
  const { t } = useT()
  const radii = resolveCornerRadii(element)
  const uniform = cornerRadiiAreUniform(radii)
  const [expanded, setExpanded] = useState(false)
  const showCorners = expanded || !uniform
  // Unify: write one radius and clear all per-corner overrides in a single patch.
  const unify = (n: number) =>
    onPatch({
      cornerRadius: clampCornerRadius(n),
      cornerRadiusTopLeft: undefined,
      cornerRadiusTopRight: undefined,
      cornerRadiusBottomRight: undefined,
      cornerRadiusBottomLeft: undefined,
    })
  const cornerField = (
    aria: string,
    v: number,
    key: 'cornerRadiusTopLeft' | 'cornerRadiusTopRight' | 'cornerRadiusBottomLeft' | 'cornerRadiusBottomRight',
  ) => (
    <NumberInput
      min={MIN_CORNER_RADIUS}
      max={MAX_CORNER_RADIUS}
      value={v}
      ariaLabel={aria}
      onCommit={(n) => onPatch({ [key]: clampCornerRadius(n) })}
    />
  )
  return (
    <Field label={t('canvas.insp.cornerRadius')}>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <NumberInput
            min={MIN_CORNER_RADIUS}
            max={MAX_CORNER_RADIUS}
            value={uniform ? radii.tl : null}
            placeholder={uniform ? undefined : t('canvas.insp.mixed')}
            ariaLabel={t('canvas.insp.cornerRadius')}
            onCommit={(n) => {
              if (Number.isFinite(n)) unify(n)
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            if (showCorners) {
              unify(radii.tl) // collapse → unify to one value (Figma)
              setExpanded(false)
            } else setExpanded(true)
          }}
          title={t('canvas.insp.independentCorners')}
          aria-label={t('canvas.insp.independentCorners')}
          aria-pressed={showCorners}
          className={[
            'grid h-7 w-7 shrink-0 place-items-center rounded-[4px] border transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            showCorners
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-line text-ink-faint hover:border-line-strong hover:text-ink',
          ].join(' ')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <path d="M2 12V6a4 4 0 0 1 4-4h6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {showCorners && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          {cornerField(t('canvas.insp.cornerTopLeft'), radii.tl, 'cornerRadiusTopLeft')}
          {cornerField(t('canvas.insp.cornerTopRight'), radii.tr, 'cornerRadiusTopRight')}
          {cornerField(t('canvas.insp.cornerBottomLeft'), radii.bl, 'cornerRadiusBottomLeft')}
          {cornerField(t('canvas.insp.cornerBottomRight'), radii.br, 'cornerRadiusBottomRight')}
        </div>
      )}
    </Field>
  )
}
