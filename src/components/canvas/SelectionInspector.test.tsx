// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { CanvasElement, FrameLayout } from '@/lib/types'

// i18n mocked to identity (t(key) → key) so labels/headers are the raw keys.
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { SelectionInspector } from './SelectionInspector'

const shape = (over: Partial<CanvasElement> = {}): CanvasElement =>
  ({
    id: 's1',
    type: 'shape',
    shapeKind: 'rect',
    x: 0,
    y: 0,
    width: 160,
    height: 120,
    text: '',
    ...over,
  }) as CanvasElement

const BASE_LAYOUT: FrameLayout = { mode: 'column', gap: 20, padding: 24, align: 'start' }

const frame = (
  layout?: Partial<FrameLayout>,
  over: Partial<CanvasElement> = {},
): CanvasElement =>
  ({
    id: 'f1',
    type: 'frame',
    x: 0,
    y: 0,
    width: 400,
    height: 280,
    text: '',
    ...(layout ? { layout: { ...BASE_LAYOUT, ...layout } } : {}),
    ...over,
  }) as CanvasElement

type Extra = Partial<ComponentProps<typeof SelectionInspector>>

// Queries are re-scoped to the render's own container so two renders inside
// one test never see each other's fields.
const renderInspector = (el: CanvasElement, extra: Extra = {}) => {
  const onPatch = vi.fn()
  const r = render(<SelectionInspector element={el} onPatch={onPatch} {...extra} />)
  return { ...r, ...within(r.container), onPatch }
}

const renderMulti = (els: CanvasElement[], extra: Extra = {}) => {
  const onPatch = vi.fn()
  const onPatchMany = vi.fn()
  const r = render(
    <SelectionInspector
      element={els[0]}
      onPatch={onPatch}
      elements={els}
      onPatchMany={onPatchMany}
      {...extra}
    />,
  )
  return { ...r, ...within(r.container), onPatch, onPatchMany }
}

// Type-then-blur — the commit gesture every numeric field uses.
const commitChange = (input: Element, value: string) => {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

describe('SelectionInspector — header & sections', () => {
  it('renders the localized type header', () => {
    const { getByText } = renderInspector(shape())
    expect(getByText('canvas.insp.rectangle')).toBeTruthy()
  })

  it('multi mode renders the selected-count header instead of a type', () => {
    const { getByText, queryByText } = renderMulti([shape(), shape({ id: 's2', x: 40 })])
    expect(getByText('canvas.insp.selectedCount')).toBeTruthy()
    expect(queryByText('canvas.insp.rectangle')).toBeNull()
  })
})

describe('SelectionInspector — NumberInput commit model', () => {
  it('typing is free (no patch, no clamp) until commit', () => {
    const { getByLabelText, onPatch } = renderInspector(shape())
    const w = getByLabelText('W') as HTMLInputElement
    fireEvent.change(w, { target: { value: '5' } })
    expect(onPatch).not.toHaveBeenCalled()
    expect(w.value).toBe('5') // below RESIZE_MIN_W but NOT clamped mid-typing
  })

  it('blur commits and clamps (W floor 130)', () => {
    const { getByLabelText, onPatch } = renderInspector(shape())
    commitChange(getByLabelText('W'), '5')
    expect(onPatch).toHaveBeenCalledWith({ width: 130 })
  })

  it('Enter commits; an IME-composing Enter does not', () => {
    const { getByLabelText, onPatch } = renderInspector(shape())
    const w = getByLabelText('W') as HTMLInputElement
    fireEvent.change(w, { target: { value: '300' } })
    fireEvent.keyDown(w, { key: 'Enter', isComposing: true })
    expect(onPatch).not.toHaveBeenCalled()
    fireEvent.keyDown(w, { key: 'Enter' })
    expect(onPatch).toHaveBeenCalledWith({ width: 300 })
  })

  it('Esc reverts the draft to the live value without committing', () => {
    const { getByLabelText, onPatch } = renderInspector(shape())
    const w = getByLabelText('W') as HTMLInputElement
    fireEvent.change(w, { target: { value: '999' } })
    fireEvent.keyDown(w, { key: 'Escape' })
    expect(w.value).toBe('160')
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('a cleared W falls back to the current size at commit (never collapses)', () => {
    const { getByLabelText, onPatch } = renderInspector(shape())
    commitChange(getByLabelText('W'), '')
    expect(onPatch).toHaveBeenCalledWith({ width: 160 })
  })
})

describe('SelectionInspector — Position X/Y', () => {
  it('X and Y write through onPatch as whole px', () => {
    const { getByLabelText, onPatch } = renderInspector(shape({ x: 10, y: 20 }))
    commitChange(getByLabelText('X'), '50.6')
    expect(onPatch).toHaveBeenCalledWith({ x: 51 })
    commitChange(getByLabelText('Y'), '-12')
    expect(onPatch).toHaveBeenCalledWith({ y: -12 })
  })

  it('a cleared X keeps the current position', () => {
    const { getByLabelText, onPatch } = renderInspector(shape({ x: 10 }))
    commitChange(getByLabelText('X'), '')
    expect(onPatch).toHaveBeenCalledWith({ x: 10 })
  })
})

describe('SelectionInspector — common layer transforms', () => {
  it('rotation field normalises an entered angle to (-180,180] before patching', () => {
    const { getByLabelText, onPatch } = renderInspector(shape())
    commitChange(getByLabelText('canvas.insp.rotation'), '270')
    // 270° canonicalises to -90° (shared normalizeRotation).
    expect(onPatch).toHaveBeenCalledWith({ rotation: -90 })
  })

  it('clearing the rotation field stores undefined, never NaN', () => {
    const { getByLabelText, onPatch } = renderInspector(shape({ rotation: 45 }))
    commitChange(getByLabelText('canvas.insp.rotation'), '')
    expect(onPatch).toHaveBeenCalledWith({ rotation: undefined })
    // explicitly assert it's not a NaN payload
    const arg = onPatch.mock.calls[0][0]
    expect('rotation' in arg && Number.isNaN(arg.rotation)).toBe(false)
  })

  it('rotation 0 is stored as undefined (clean default)', () => {
    const { getByLabelText, onPatch } = renderInspector(shape({ rotation: 30 }))
    commitChange(getByLabelText('canvas.insp.rotation'), '0')
    expect(onPatch).toHaveBeenCalledWith({ rotation: undefined })
  })

  it('the lock toggle sets locked, and unlocks a locked element', () => {
    const a = renderInspector(shape())
    fireEvent.click(a.getByText('canvas.insp.unlocked'))
    expect(a.onPatch).toHaveBeenCalledWith({ locked: true })

    const b = renderInspector(shape({ locked: true }))
    fireEvent.click(b.getByText('canvas.insp.locked'))
    expect(b.onPatch).toHaveBeenCalledWith({ locked: undefined })
  })

  it('the visibility toggle hides, and re-shows a hidden element', () => {
    const a = renderInspector(shape())
    fireEvent.click(a.getByText('canvas.insp.visible'))
    expect(a.onPatch).toHaveBeenCalledWith({ hidden: true })

    const b = renderInspector(shape({ hidden: true }))
    fireEvent.click(b.getByText('canvas.insp.hidden'))
    expect(b.onPatch).toHaveBeenCalledWith({ hidden: undefined })
  })

  it('the blend select patches the mode, and "normal" clears it', () => {
    const { getByLabelText, onPatch } = renderInspector(shape())
    const sel = getByLabelText('canvas.insp.blend')
    fireEvent.change(sel, { target: { value: 'multiply' } })
    expect(onPatch).toHaveBeenCalledWith({ blendMode: 'multiply' })
    fireEvent.change(sel, { target: { value: 'normal' } })
    expect(onPatch).toHaveBeenCalledWith({ blendMode: undefined })
  })
})

describe('SelectionInspector — align row', () => {
  it('renders only when onAlign is wired, and forwards the op', () => {
    const noRow = renderInspector(shape())
    expect(noRow.queryByLabelText('canvas.align.left')).toBeNull()

    const onAlign = vi.fn()
    const { getByLabelText } = renderInspector(shape(), { onAlign })
    fireEvent.click(getByLabelText('canvas.align.left'))
    expect(onAlign).toHaveBeenCalledWith('left')
    // Distribute needs ≥3 selected (the old AlignBar's gate) — disabled and
    // inert for a single selection.
    const dist = getByLabelText('canvas.align.vdistribute') as HTMLButtonElement
    expect(dist.disabled).toBe(true)
    fireEvent.click(dist)
    expect(onAlign).not.toHaveBeenCalledWith('vdistribute')
  })

  it('distribute enables with a 3-element selection and forwards the op', () => {
    const onAlign = vi.fn()
    const els = [shape(), { ...shape(), id: 's2' }, { ...shape(), id: 's3' }]
    const { getByLabelText } = renderInspector(els[0], {
      onAlign,
      elements: els,
      onPatchMany: vi.fn(),
    })
    const dist = getByLabelText('canvas.align.vdistribute') as HTMLButtonElement
    expect(dist.disabled).toBe(false)
    fireEvent.click(dist)
    expect(onAlign).toHaveBeenCalledWith('vdistribute')
  })

  it('is hidden for a layout child (the parent frame owns its position)', () => {
    const onAlign = vi.fn()
    const { queryByLabelText } = renderInspector(shape(), { onAlign, isLayoutChild: true })
    expect(queryByLabelText('canvas.align.left')).toBeNull()
  })

  it('alignEnabled=false disables every button', () => {
    const onAlign = vi.fn()
    const { getByLabelText } = renderInspector(shape(), { onAlign, alignEnabled: false })
    const btn = getByLabelText('canvas.align.left') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})

describe('SelectionInspector — auto layout 3×3 grid', () => {
  it('a cell click writes justify × align (column: rows = justify)', () => {
    const { getByLabelText, onPatch } = renderInspector(frame({}))
    fireEvent.click(getByLabelText('canvas.insp.cellBottomCenter'))
    expect(onPatch).toHaveBeenCalledWith({
      layout: { ...BASE_LAYOUT, justify: 'end', align: 'center' },
    })
  })

  it('row mode maps columns to justify and rows to align', () => {
    const { getByLabelText, onPatch } = renderInspector(frame({ mode: 'row' }))
    fireEvent.click(getByLabelText('canvas.insp.cellMiddleLeft'))
    expect(onPatch).toHaveBeenCalledWith({
      layout: { ...BASE_LAYOUT, mode: 'row', justify: 'start', align: 'center' },
    })
  })

  it('during space-between a cell click steers only the cross axis (Auto stays)', () => {
    const { getByLabelText, onPatch } = renderInspector(frame({ justify: 'space-between' }))
    fireEvent.click(getByLabelText('canvas.insp.cellTopCenter'))
    expect(onPatch).toHaveBeenCalledWith({
      layout: { ...BASE_LAYOUT, justify: 'space-between', align: 'center' },
    })
  })
})

describe('SelectionInspector — gap Auto ⇄ space-between', () => {
  it('selecting Auto writes justify: space-between', () => {
    const { getByLabelText, onPatch } = renderInspector(frame({}))
    fireEvent.change(getByLabelText('canvas.insp.gapMode'), { target: { value: 'auto' } })
    expect(onPatch).toHaveBeenCalledWith({
      layout: { ...BASE_LAYOUT, justify: 'space-between' },
    })
  })

  it('space-between shows a disabled "Auto" gap box and reflects in the select', () => {
    const { getByLabelText } = renderInspector(frame({ justify: 'space-between' }))
    const gap = getByLabelText('canvas.insp.gap') as HTMLInputElement
    expect(gap.disabled).toBe(true)
    expect(gap.value).toBe('canvas.insp.gapAuto')
    expect((getByLabelText('canvas.insp.gapMode') as HTMLSelectElement).value).toBe('auto')
  })

  it('selecting px drops space-between (justify cleared)', () => {
    const { getByLabelText, onPatch } = renderInspector(frame({ justify: 'space-between' }))
    fireEvent.change(getByLabelText('canvas.insp.gapMode'), { target: { value: 'px' } })
    expect(onPatch).toHaveBeenCalledWith({ layout: { ...BASE_LAYOUT } })
  })

  it('gap commits clamped through the layout patch', () => {
    const { getByLabelText, onPatch } = renderInspector(frame({}))
    commitChange(getByLabelText('canvas.insp.gap'), '12')
    expect(onPatch).toHaveBeenCalledWith({ layout: { ...BASE_LAYOUT, gap: 12 } })
  })
})

describe('SelectionInspector — auto layout padding', () => {
  it('uniform padding starts collapsed; expanding reveals per-side inputs', () => {
    const { getByLabelText, queryByLabelText, onPatch } = renderInspector(frame({}))
    expect(queryByLabelText('canvas.insp.paddingTop')).toBeNull()
    expect((getByLabelText('canvas.insp.padding') as HTMLInputElement).value).toBe('24')

    fireEvent.click(getByLabelText('canvas.insp.paddingPerSide'))
    commitChange(getByLabelText('canvas.insp.paddingTop'), '10')
    expect(onPatch).toHaveBeenCalledWith({ layout: { ...BASE_LAYOUT, paddingTop: 10 } })
  })

  it('unequal sides start expanded, resolve against the legacy padding, and show Mixed in the uniform box', () => {
    const { getByLabelText } = renderInspector(frame({ paddingTop: 8 }))
    expect((getByLabelText('canvas.insp.paddingTop') as HTMLInputElement).value).toBe('8')
    expect((getByLabelText('canvas.insp.paddingRight') as HTMLInputElement).value).toBe('24')
    const uniform = getByLabelText('canvas.insp.padding') as HTMLInputElement
    expect(uniform.value).toBe('')
    expect(uniform.placeholder).toBe('canvas.insp.mixed')
  })

  it('committing the uniform box unifies all sides (per-side overrides cleared)', () => {
    const { getByLabelText, onPatch } = renderInspector(frame({ paddingTop: 8 }))
    commitChange(getByLabelText('canvas.insp.padding'), '16')
    expect(onPatch).toHaveBeenCalledWith({ layout: { ...BASE_LAYOUT, padding: 16 } })
  })
})

describe('SelectionInspector — frame sizing (Fixed / Hug)', () => {
  it('row frame: W is the primary axis, H the counter axis', () => {
    const { getByLabelText, onPatch } = renderInspector(frame({ mode: 'row' }))
    fireEvent.change(getByLabelText('canvas.insp.sizingW'), { target: { value: 'hug' } })
    expect(onPatch).toHaveBeenCalledWith({
      layout: { ...BASE_LAYOUT, mode: 'row', primarySizing: 'hug' },
    })
    fireEvent.change(getByLabelText('canvas.insp.sizingH'), { target: { value: 'hug' } })
    expect(onPatch).toHaveBeenCalledWith({
      layout: { ...BASE_LAYOUT, mode: 'row', counterSizing: 'hug' },
    })
  })

  it('column frame: W maps to counterSizing, and Fixed clears back to undefined', () => {
    const a = renderInspector(frame({}))
    fireEvent.change(a.getByLabelText('canvas.insp.sizingW'), { target: { value: 'hug' } })
    expect(a.onPatch).toHaveBeenCalledWith({
      layout: { ...BASE_LAYOUT, counterSizing: 'hug' },
    })

    const b = renderInspector(frame({ primarySizing: 'hug' }))
    fireEvent.change(b.getByLabelText('canvas.insp.sizingH'), { target: { value: 'fixed' } })
    expect(b.onPatch).toHaveBeenCalledWith({ layout: { ...BASE_LAYOUT } })
  })
})

describe('SelectionInspector — plain frame "+ Auto layout"', () => {
  it('writes AUTO_LAYOUT_DEFAULTS + mode column when unwired', () => {
    const { getByText, onPatch } = renderInspector(frame())
    fireEvent.click(getByText('canvas.insp.addAutoLayout'))
    expect(onPatch).toHaveBeenCalledWith({
      layout: { mode: 'column', gap: 20, padding: 24, align: 'start' },
    })
  })

  it('prefers the wired onAddAutoLayout callback', () => {
    const onAddAutoLayout = vi.fn()
    const { getByText, onPatch } = renderInspector(frame(), { onAddAutoLayout })
    fireEvent.click(getByText('canvas.insp.addAutoLayout'))
    expect(onAddAutoLayout).toHaveBeenCalled()
    expect(onPatch).not.toHaveBeenCalled()
  })
})

describe('SelectionInspector — layout child Fixed / Fill', () => {
  const rowParent: FrameLayout = { ...BASE_LAYOUT, mode: 'row' }

  it('row parent: W select writes fillMain, H select writes fillCross', () => {
    const { getByLabelText, onPatch } = renderInspector(shape(), { parentLayout: rowParent })
    fireEvent.change(getByLabelText('canvas.insp.fillW'), { target: { value: 'fill' } })
    expect(onPatch).toHaveBeenCalledWith({ fillMain: true })
    fireEvent.change(getByLabelText('canvas.insp.fillH'), { target: { value: 'fill' } })
    expect(onPatch).toHaveBeenCalledWith({ fillCross: true })
  })

  it('column parent: the axis mapping flips (W → fillCross)', () => {
    const { getByLabelText, onPatch } = renderInspector(shape(), { parentLayout: BASE_LAYOUT })
    fireEvent.change(getByLabelText('canvas.insp.fillW'), { target: { value: 'fill' } })
    expect(onPatch).toHaveBeenCalledWith({ fillCross: true })
  })

  it('switching back to Fixed clears the flag to undefined', () => {
    const { getByLabelText, onPatch } = renderInspector(shape({ fillMain: true }), {
      parentLayout: rowParent,
    })
    fireEvent.change(getByLabelText('canvas.insp.fillW'), { target: { value: 'fixed' } })
    expect(onPatch).toHaveBeenCalledWith({ fillMain: undefined })
  })

  it('no selects without a parentLayout', () => {
    const { queryByLabelText } = renderInspector(shape())
    expect(queryByLabelText('canvas.insp.fillW')).toBeNull()
  })
})

describe('SelectionInspector — multi selection', () => {
  it('mismatched values show as an empty Mixed field; commit patches every id', () => {
    const { getByLabelText, onPatchMany } = renderMulti([shape(), shape({ id: 's2', x: 40 })])
    const x = getByLabelText('X') as HTMLInputElement
    expect(x.value).toBe('')
    expect(x.placeholder).toBe('canvas.insp.mixed')
    commitChange(x, '100')
    expect(onPatchMany).toHaveBeenCalledWith(['s1', 's2'], { x: 100 })
  })

  it('a value all members share is shown as-is', () => {
    const { getByLabelText } = renderMulti([shape({ x: 30 }), shape({ id: 's2', x: 30 })])
    expect((getByLabelText('X') as HTMLInputElement).value).toBe('30')
  })

  it('W/H appear only when every selected type carries a size', () => {
    const sizedPair = renderMulti([shape(), shape({ id: 's2' })])
    expect(sizedPair.queryByLabelText('W')).toBeTruthy()

    const textEl = { id: 't1', type: 'text', x: 0, y: 0, text: 'hi' } as CanvasElement
    const mixedTypes = renderMulti([shape(), textEl])
    expect(mixedTypes.queryByLabelText('W')).toBeNull()
    expect(mixedTypes.queryByLabelText('X')).toBeTruthy()
  })

  it('rotation commits normalised through onPatchMany', () => {
    const { getByLabelText, onPatchMany } = renderMulti([shape(), shape({ id: 's2' })])
    commitChange(getByLabelText('canvas.insp.rotation'), '270')
    expect(onPatchMany).toHaveBeenCalledWith(['s1', 's2'], { rotation: -90 })
  })

  it('a homogeneous sticky selection edits fill via the shared color field', () => {
    const sticky = (id: string, color?: string): CanvasElement =>
      ({ id, type: 'sticky', x: 0, y: 0, text: '', ...(color ? { color } : {}) }) as CanvasElement
    const { getByLabelText, onPatchMany } = renderMulti([
      sticky('a', '#111111'),
      sticky('b', '#222222'),
    ])
    const hex = getByLabelText('canvas.insp.fill') as HTMLInputElement
    expect(hex.value).toBe('')
    expect(hex.placeholder).toBe('canvas.insp.mixed')
    fireEvent.change(hex, { target: { value: '#ff0000' } })
    expect(onPatchMany).toHaveBeenCalledWith(['a', 'b'], { color: '#ff0000' })
  })

  it('a mixed-kind selection drops the fill section', () => {
    const textEl = { id: 't1', type: 'text', x: 0, y: 0, text: 'hi' } as CanvasElement
    const { queryByLabelText } = renderMulti([shape(), textEl])
    expect(queryByLabelText('canvas.insp.fill')).toBeNull()
  })
})
