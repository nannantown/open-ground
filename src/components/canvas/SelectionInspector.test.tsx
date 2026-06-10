// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { CanvasElement } from '@/lib/types'

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

const renderInspector = (el: CanvasElement) => {
  const onPatch = vi.fn()
  const r = render(<SelectionInspector element={el} onPatch={onPatch} />)
  return { ...r, onPatch }
}

describe('SelectionInspector — common layer transforms', () => {
  it('renders the localized type header', () => {
    const { getByText } = renderInspector(shape())
    expect(getByText('canvas.insp.rectangle')).toBeTruthy()
  })

  it('rotation field normalises an entered angle to (-180,180] before patching', () => {
    const { getByLabelText, onPatch } = renderInspector(shape())
    fireEvent.change(getByLabelText('canvas.insp.rotation'), { target: { value: '270' } })
    // 270° canonicalises to -90° (shared normalizeRotation).
    expect(onPatch).toHaveBeenCalledWith({ rotation: -90 })
  })

  it('clearing the rotation field stores undefined, never NaN', () => {
    const { getByLabelText, onPatch } = renderInspector(shape({ rotation: 45 }))
    fireEvent.change(getByLabelText('canvas.insp.rotation'), { target: { value: '' } })
    expect(onPatch).toHaveBeenCalledWith({ rotation: undefined })
    // explicitly assert it's not a NaN payload
    const arg = onPatch.mock.calls[0][0]
    expect('rotation' in arg && Number.isNaN(arg.rotation)).toBe(false)
  })

  it('rotation 0 is stored as undefined (clean default)', () => {
    const { getByLabelText, onPatch } = renderInspector(shape({ rotation: 30 }))
    fireEvent.change(getByLabelText('canvas.insp.rotation'), { target: { value: '0' } })
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

  it('the blend select patches the mode, and "normal" clears it', () => {
    const { getByLabelText, onPatch } = renderInspector(shape())
    const sel = getByLabelText('canvas.insp.blend')
    fireEvent.change(sel, { target: { value: 'multiply' } })
    expect(onPatch).toHaveBeenCalledWith({ blendMode: 'multiply' })
    fireEvent.change(sel, { target: { value: 'normal' } })
    expect(onPatch).toHaveBeenCalledWith({ blendMode: undefined })
  })
})
