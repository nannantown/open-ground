import { describe, it, expect } from 'vitest'
import { pickStyle, applyStyle } from './canvasStyleClipboard'
import type { CanvasElement } from './types'

const el = (over: Partial<CanvasElement> & { id: string }): CanvasElement => ({
  type: 'sticky',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

describe('pickStyle (⌥⌘C)', () => {
  it('lifts only explicitly-set style fields', () => {
    const s = pickStyle(
      el({ id: 'a', type: 'shape', fill: '#f00', strokeWidth: 2, width: 50 }),
    )
    expect(s).toEqual({ fill: '#f00', strokeWidth: 2 }) // width is geometry, not style
  })
  it('returns null when the element carries no style', () => {
    expect(pickStyle(el({ id: 'a', type: 'text' }))).toBeNull()
  })
})

describe('applyStyle (⌥⌘V)', () => {
  const copied = {
    fill: '#f00',
    strokeColor: '#000',
    textColor: '#333',
    fontSize: 24,
    opacity: 0.5,
  }

  it('stamps only the fields valid for the target type', () => {
    const frame = applyStyle(el({ id: 'f', type: 'frame' }), copied)
    expect(frame.fill).toBe('#f00')
    expect(frame.strokeColor).toBe('#000')
    expect(frame.opacity).toBe(0.5)
    expect(frame.textColor).toBeUndefined()

    const text = applyStyle(el({ id: 't', type: 'text' }), copied)
    expect(text.textColor).toBe('#333')
    expect(text.fontSize).toBe(24)
    expect(text.fill).toBeUndefined()

    const mock = applyStyle(el({ id: 'm', type: 'mock' }), copied)
    expect(mock.opacity).toBe(0.5)
    expect(mock.fill).toBeUndefined()
  })

  it('returns the same reference when nothing applies (cheap no-op detect)', () => {
    const pin = el({ id: 'c', type: 'comment' })
    expect(applyStyle(pin, copied)).toBe(pin)
    const same = el({ id: 's', type: 'shape', fill: '#f00', strokeColor: '#000', opacity: 0.5 })
    expect(applyStyle(same, { fill: '#f00', strokeColor: '#000', opacity: 0.5 })).toBe(same)
  })
})
