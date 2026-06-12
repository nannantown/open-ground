import {
  Type,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Bold,
  Lock,
  Unlock,
  Minus,
  ArrowDown,
  ArrowRight,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
} from 'lucide-react'
import type { CanvasElement, FrameLayout } from '@/lib/types'
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

// Type → i18n key for the panel header (resolved with t() at render).
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
}

// Figma-style right-side properties inspector for the single selected element.
// Type-aware: round 1 fully wires the TEXT controls (font size / family /
// colour); every other type shows the common position/size readout so the
// panel exists for all selections. Mounted by CanvasWorkspace, absolutely
// positioned over the canvas, only when exactly one element is selected.
export const SelectionInspector = ({ element, onPatch }: Props) => {
  const { t } = useT()
  return (
    <div
      // Sits above the toolbar/undo affordances; its own pointer events are
      // captured so dragging a slider/typing doesn't pan the canvas underneath.
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute right-3 top-3 z-30 flex w-60 flex-col gap-3 rounded-[7px] border border-line bg-bg-card/95 p-3 shadow-card-hover backdrop-blur"
    >
      <div className="flex items-center gap-1.5 label-cap text-ink-muted">
        <Type size={12} strokeWidth={2.25} />
        <span>
          {element.type === 'shape'
            ? resolveShapeKind(element) === 'ellipse'
              ? t('canvas.insp.ellipse')
              : t('canvas.insp.rectangle')
            : t(TYPE_LABEL_KEY[element.type])}
        </span>
      </div>

      {element.type === 'text' ? (
        <TextProperties element={element} onPatch={onPatch} />
      ) : element.type === 'sticky' ? (
        <StickyProperties element={element} onPatch={onPatch} />
      ) : element.type === 'frame' ? (
        <FrameProperties element={element} onPatch={onPatch} />
      ) : element.type === 'shape' ? (
        <ShapeProperties element={element} onPatch={onPatch} />
      ) : (
        // mock / image / screen — resizable, but with no type-specific look
        // controls yet. Still get per-object W/H + opacity.
        <TransformOnlyProperties element={element} onPatch={onPatch} />
      )}

      {/* Shared layer transforms — rotation / blend mode / lock — shown for
          every element type (Figma-parity). */}
      <LayerCommonProperties element={element} onPatch={onPatch} />
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

// ── Rotation (deg) + Blend mode + Lock — common to every element. Rotation
//    normalises to 0..359 and stores `undefined` for 0 (clean default). Lock is
//    a toggle; a locked element is also un-lockable from the Layers panel (it
//    becomes pointer-events:none on the canvas, so the panel is the way back). ──
const LayerCommonProperties = ({ element, onPatch }: Props) => {
  const { t } = useT()
  // Shared normalizer → (-180,180], NaN-safe (a cleared field becomes 0, never
  // NaN). 0 is stored as undefined to keep the field clean.
  const norm = (n: number) => {
    const d = normalizeRotation(n)
    return d === 0 ? undefined : d
  }
  return (
    <div className="flex flex-col gap-2.5 border-t border-line-soft pt-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('canvas.insp.rotation')}>
          <NumberInput
            min={-360}
            max={360}
            value={Math.round(element.rotation ?? 0)}
            onChange={(n) => onPatch({ rotation: norm(n) })}
          />
        </Field>
        <Field label={t('canvas.insp.lock')}>
          <button
            type="button"
            onClick={() => onPatch({ locked: element.locked ? undefined : true })}
            className={[
              'flex h-7 w-full items-center justify-center gap-1.5 rounded-[4px] border text-[12px] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
              element.locked
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-line bg-bg text-ink-subtle hover:border-line-strong hover:text-ink',
            ].join(' ')}
          >
            {element.locked ? <Lock size={12} /> : <Unlock size={12} />}
            {element.locked ? t('canvas.insp.locked') : t('canvas.insp.unlocked')}
          </button>
        </Field>
      </div>
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
          className={[
            'h-7 w-full rounded-[4px] border border-line bg-bg px-2 text-[12px] text-ink',
            'transition-colors hover:border-line-strong',
            'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
          ].join(' ')}
        >
          {BLEND_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

// Per-type render defaults, so the W/H inputs show the box's *actual* rendered
// size even for a legacy element that was saved without explicit width/height
// (the views fall back to these same numbers). Kept in sync with the element
// views' own DEFAULT_W / DEFAULT_H constants.
const SIZE_DEFAULTS: Partial<Record<CanvasElement['type'], { w: number; h: number }>> = {
  sticky: { w: 208, h: 208 },
  frame: { w: 400, h: 280 },
  mock: { w: 420, h: 320 },
  image: { w: 320, h: 240 },
  screen: { w: 1280, h: 800 },
  shape: { w: 160, h: 120 },
}

// ── Size (per-object resize) — W/H number inputs that resize the selected
//    element live + persisted, the inspector twin of the on-canvas drag handle.
//    Shown for every resizable type (anything that carries width/height). ──
const SizeProperties = ({ element, onPatch }: Props) => {
  const def = SIZE_DEFAULTS[element.type] ?? { w: 0, h: 0 }
  const w = Math.round(element.width ?? def.w)
  const h = Math.round(element.height ?? def.h)
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="W">
        <NumberInput
          min={RESIZE_MIN_W}
          max={RESIZE_MAX}
          value={w}
          onChange={(n) => onPatch({ width: clampWidth(n, w) })}
        />
      </Field>
      <Field label="H">
        <NumberInput
          min={RESIZE_MIN_H}
          max={RESIZE_MAX}
          value={h}
          onChange={(n) => onPatch({ height: clampHeight(n, h) })}
        />
      </Field>
    </div>
  )
}

// ── Opacity — 0..100% slider + number, mapped to the 0..1 `opacity` field and
//    applied to the element's rendered container. Shown for every element. ──
const OpacityField = ({ element, onPatch }: Props) => {
  const { t } = useT()
  const percent = Math.round(resolveOpacity(element) * 100)
  return (
    <Field label={t('canvas.insp.opacity')}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={100}
          value={percent}
          onChange={(e) => onPatch({ opacity: opacityFromPercent(e.target.valueAsNumber) })}
          className="h-7 min-w-0 flex-1 cursor-pointer accent-accent rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        />
        <input
          type="number"
          min={0}
          max={100}
          value={percent}
          onChange={(e) => onPatch({ opacity: opacityFromPercent(e.target.valueAsNumber) })}
          className={[
            'h-7 w-14 shrink-0 rounded-[4px] border border-line bg-bg px-2 text-[12px] text-ink',
            'transition-colors hover:border-line-strong',
            'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
          ].join(' ')}
        />
      </div>
    </Field>
  )
}

// Transform-only section: size + opacity, for resizable types that have no
// other type-specific controls yet (mock / image / screen).
const TransformOnlyProperties = ({ element, onPatch }: Props) => (
  <div className="flex flex-col gap-2.5">
    <SizeProperties element={element} onPatch={onPatch} />
    <OpacityField element={element} onPatch={onPatch} />
  </div>
)

// ── Sticky fill — the user's "color for non-text elements" ask. The sticky
//    background reuses the existing `color` field (NOT a new field), so this
//    control and the on-canvas swatch row drive the same value. ──
const StickyProperties = ({ element, onPatch }: Props) => {
  const { t } = useT()
  const fill = resolveStickyFill(element)
  return (
    <div className="flex flex-col gap-2.5">
      <SizeProperties element={element} onPatch={onPatch} />
      <ColorField
        label={t('canvas.insp.fill')}
        value={fill}
        onChange={(color) => onPatch({ color })}
      />
      <OpacityField element={element} onPatch={onPatch} />
    </div>
  )
}

// ── Frame fill + stroke. Fill → the new optional `fill` field; stroke colour +
//    width → `strokeColor` / `strokeWidth`. All optional + backward-compatible
//    (a legacy frame resolves to the historical bg-bg/35 body + 1px border). ──
const FrameProperties = ({ element, onPatch }: Props) => {
  const { t } = useT()
  const { fill, strokeColor, strokeWidth } = resolveFrameStyle(element)
  const cornerRadius = resolveFrameCornerRadius(element)
  return (
    <div className="flex flex-col gap-2.5">
      <SizeProperties element={element} onPatch={onPatch} />
      <ColorField
        label={t('canvas.insp.fill')}
        value={fill}
        onChange={(color) => onPatch({ fill: color })}
      />
      <ColorField
        label={t('canvas.insp.stroke')}
        value={strokeColor}
        onChange={(color) => onPatch({ strokeColor: color })}
      />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('canvas.insp.strokeWidth')}>
          <NumberInput
            min={MIN_STROKE_WIDTH}
            max={MAX_STROKE_WIDTH}
            value={strokeWidth}
            onChange={(n) => onPatch({ strokeWidth: clampStrokeWidth(n) })}
          />
        </Field>
        <Field label={t('canvas.insp.cornerRadius')}>
          <NumberInput
            min={MIN_CORNER_RADIUS}
            max={MAX_CORNER_RADIUS}
            value={cornerRadius}
            onChange={(n) => onPatch({ cornerRadius: clampCornerRadius(n) })}
          />
        </Field>
      </div>
      <LayoutProperties element={element} onPatch={onPatch} />
      <OpacityField element={element} onPatch={onPatch} />
    </div>
  )
}

const MAX_LAYOUT_PX = 400
const clampLayoutPx = (n: number) =>
  Number.isFinite(n) ? Math.max(0, Math.min(MAX_LAYOUT_PX, Math.round(n))) : 0

// Frame auto layout (Figma-style): none / vertical stack / horizontal stack,
// plus gap / padding / cross-axis align once enabled. Patches the frame's
// `layout` field; the actual re-flow runs through applyAutoLayout on every
// mutateElements (see CanvasWorkspace), so children snap as soon as a value
// changes. Cross-axis icons follow the mode: a row aligns its children
// top/middle/bottom, a column left/center/right.
const LayoutProperties = ({ element, onPatch }: Props) => {
  const { t } = useT()
  const layout = element.layout
  const setMode = (mode: FrameLayout['mode'] | null) => {
    if (!mode) {
      onPatch({ layout: undefined })
      return
    }
    onPatch({
      layout: {
        mode,
        gap: layout?.gap ?? AUTO_LAYOUT_DEFAULTS.gap,
        padding: layout?.padding ?? AUTO_LAYOUT_DEFAULTS.padding,
        align: layout?.align ?? AUTO_LAYOUT_DEFAULTS.align,
      },
    })
  }
  const modeBtns: {
    key: string
    active: boolean
    title: string
    icon: typeof Minus
    onClick: () => void
  }[] = [
    {
      key: 'none',
      active: !layout,
      title: t('canvas.insp.layoutNone'),
      icon: Minus,
      onClick: () => setMode(null),
    },
    {
      key: 'column',
      active: layout?.mode === 'column',
      title: t('canvas.insp.layoutColumn'),
      icon: ArrowDown,
      onClick: () => setMode('column'),
    },
    {
      key: 'row',
      active: layout?.mode === 'row',
      title: t('canvas.insp.layoutRow'),
      icon: ArrowRight,
      onClick: () => setMode('row'),
    },
  ]
  const alignIcons =
    layout?.mode === 'row'
      ? ([AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal] as const)
      : ([AlignStartVertical, AlignCenterVertical, AlignEndVertical] as const)
  const alignOpts = [
    { value: 'start', title: t('canvas.insp.layoutAlignStart'), Icon: alignIcons[0] },
    { value: 'center', title: t('canvas.insp.layoutAlignCenter'), Icon: alignIcons[1] },
    { value: 'end', title: t('canvas.insp.layoutAlignEnd'), Icon: alignIcons[2] },
  ] as const
  return (
    <>
      <Field label={t('canvas.insp.layout')}>
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
      </Field>
      {layout && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('canvas.insp.gap')}>
              <NumberInput
                min={0}
                max={MAX_LAYOUT_PX}
                value={layout.gap}
                onChange={(n) => onPatch({ layout: { ...layout, gap: clampLayoutPx(n) } })}
              />
            </Field>
            <Field label={t('canvas.insp.padding')}>
              <NumberInput
                min={0}
                max={MAX_LAYOUT_PX}
                value={layout.padding}
                onChange={(n) =>
                  onPatch({ layout: { ...layout, padding: clampLayoutPx(n) } })
                }
              />
            </Field>
          </div>
          <Field label={t('canvas.insp.layoutAlign')}>
            <div className="flex items-stretch gap-1">
              {alignOpts.map(({ value, title, Icon }) => {
                const active = layout.align === value
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    title={title}
                    onClick={() => onPatch({ layout: { ...layout, align: value } })}
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
        </>
      )}
    </>
  )
}

// ── Shape fill + stroke (+ corner radius for a rectangle). A shape consumes the
//    same optional fill / strokeColor / strokeWidth / cornerRadius / opacity
//    fields as a frame, routed through the shape's own defaults. An ellipse is a
//    pill at any radius, so the Corner-radius control is shown only for a rect. ──
const ShapeProperties = ({ element, onPatch }: Props) => {
  const { t } = useT()
  const { fill, strokeColor, strokeWidth } = resolveShapeStyle(element)
  const kind = resolveShapeKind(element)
  const cornerRadius = resolveFrameCornerRadius(element)
  return (
    <div className="flex flex-col gap-2.5">
      <SizeProperties element={element} onPatch={onPatch} />
      <ColorField
        label={t('canvas.insp.fill')}
        value={fill}
        onChange={(color) => onPatch({ fill: color })}
      />
      <ColorField
        label={t('canvas.insp.stroke')}
        value={strokeColor}
        onChange={(color) => onPatch({ strokeColor: color })}
      />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('canvas.insp.strokeWidth')}>
          <NumberInput
            min={MIN_STROKE_WIDTH}
            max={MAX_STROKE_WIDTH}
            value={strokeWidth}
            onChange={(n) => onPatch({ strokeWidth: clampStrokeWidth(n) })}
          />
        </Field>
        {/* Corner radius is meaningless for an ellipse (always a pill), so it
            only appears for a rectangle. */}
        {kind === 'rect' && (
          <Field label={t('canvas.insp.cornerRadius')}>
            <NumberInput
              min={MIN_CORNER_RADIUS}
              max={MAX_CORNER_RADIUS}
              value={cornerRadius}
              onChange={(n) => onPatch({ cornerRadius: clampCornerRadius(n) })}
            />
          </Field>
        )}
      </div>
      <OpacityField element={element} onPatch={onPatch} />
    </div>
  )
}

// ── Text typography controls — the user's named round-1 gaps. Each edit is
//    applied live + persisted through onPatch. ──
const TextProperties = ({ element, onPatch }: Props) => {
  const { t } = useT()
  const fontSize = element.fontSize ?? DEFAULT_TEXT_FONT_SIZE
  const fontFamily = element.fontFamily ?? FONT_DISPLAY_STACK
  const textColor = element.textColor ?? DEFAULT_TEXT_COLOR
  const fontWeight = element.fontWeight ?? DEFAULT_TEXT_FONT_WEIGHT
  const textAlign = element.textAlign ?? DEFAULT_TEXT_ALIGN
  const lineHeight = element.lineHeight ?? DEFAULT_LINE_HEIGHT
  const isBold = fontWeight >= BOLD_FONT_WEIGHT

  return (
    <div className="flex flex-col gap-2.5">
      <Field label={t('canvas.insp.fontSize')}>
        <input
          type="number"
          min={MIN_TEXT_FONT_SIZE}
          max={MAX_TEXT_FONT_SIZE}
          value={fontSize}
          onChange={(e) => onPatch({ fontSize: clampFontSize(e.target.valueAsNumber) })}
          className={[
            'h-7 w-full rounded-[4px] border border-line bg-bg px-2 text-[12px] text-ink',
            'transition-colors hover:border-line-strong',
            'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
          ].join(' ')}
        />
      </Field>

      <Field label={t('canvas.insp.fontFamily')}>
        <select
          value={fontFamily}
          onChange={(e) => onPatch({ fontFamily: e.target.value })}
          className={[
            'h-7 w-full rounded-[4px] border border-line bg-bg px-2 text-[12px] text-ink',
            'cursor-pointer transition-colors hover:border-line-strong',
            'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
          ].join(' ')}
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
            className={[
              'h-7 min-w-0 flex-1 rounded-[4px] border border-line bg-bg px-2 text-[12px] text-ink',
              'cursor-pointer transition-colors hover:border-line-strong',
              'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
            ].join(' ')}
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
        <input
          type="number"
          min={MIN_LINE_HEIGHT}
          max={MAX_LINE_HEIGHT}
          step={0.1}
          value={lineHeight}
          onChange={(e) => onPatch({ lineHeight: clampLineHeight(e.target.valueAsNumber) })}
          className={[
            'h-7 w-full rounded-[4px] border border-line bg-bg px-2 text-[12px] text-ink',
            'transition-colors hover:border-line-strong',
            'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
          ].join(' ')}
        />
      </Field>

      <ColorField
        label={t('canvas.insp.textColor')}
        value={textColor}
        onChange={(color) => onPatch({ textColor: color })}
      />

      <OpacityField element={element} onPatch={onPatch} />
    </div>
  )
}

// A bare number input matching the panel's other fields. Reports the parsed
// value (NaN when cleared) up to `onChange`, which clamps before patching.
// ↑/↓ step by 1 (or the field's `step`); holding Shift steps by 10 — the
// Figma habit, mirroring the canvas's Shift-nudge. Handled here (with
// preventDefault) so the native spinner can't double-step.
const NumberInput = ({
  min,
  max,
  step,
  value,
  onChange,
}: {
  min?: number
  max?: number
  step?: number
  value: number
  onChange: (n: number) => void
}) => (
  <input
    type="number"
    min={min}
    max={max}
    step={step}
    value={value}
    onChange={(e) => onChange(e.target.valueAsNumber)}
    onKeyDown={(e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const dir = e.key === 'ArrowUp' ? 1 : -1
      const by = e.shiftKey ? 10 : (step ?? 1)
      onChange((Number.isFinite(value) ? value : 0) + dir * by)
    }}
    className={[
      'h-7 w-full rounded-[4px] border border-line bg-bg px-2 text-[12px] text-ink',
      'transition-colors hover:border-line-strong',
      'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
    ].join(' ')}
  />
)

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
// `onChange`; the parent funnels them to the undoable patch path.
const ColorField = ({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) => {
  const { t } = useT()
  return (
  <Field label={label}>
    <div className="flex items-center gap-2">
      <label
        className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-[4px] border border-line transition-colors hover:border-line-strong focus-within:ring-2 focus-within:ring-accent/40"
        style={{ background: value }}
        title={t('canvas.insp.pickColour')}
      >
        <input
          type="color"
          value={toPickerHex(value)}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={[
          'h-7 min-w-0 flex-1 rounded-[4px] border border-line bg-bg px-2 font-mono text-[11px] text-ink',
          'transition-colors hover:border-line-strong',
          'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
        ].join(' ')}
      />
    </div>
  </Field>
  )
}
