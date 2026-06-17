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

  // ── full-replace semantics (Figma "Paste properties"): a field the copy
  //    doesn't carry is CLEARED on the target, so no residue survives. ──
  it('clears a stray per-corner radius the copy did not carry (uniform source)', () => {
    // Source has a uniform radius (no per-corner fields); pasting it must reset
    // the target's lone per-corner override, not leave one corner wrong.
    const target = el({ id: 't', type: 'frame', cornerRadiusTopLeft: 50, cornerRadius: 8 })
    const out = applyStyle(target, { cornerRadius: 20 })
    expect(out.cornerRadius).toBe(20)
    expect(out.cornerRadiusTopLeft).toBeUndefined()
  })
  it('resets a dashed target to solid when the copy has no strokeStyle', () => {
    const target = el({ id: 't', type: 'shape', strokeStyle: 'dashed', strokeColor: '#000' })
    const out = applyStyle(target, { strokeColor: '#000' })
    expect(out.strokeStyle).toBeUndefined() // → resolves to 'solid'
  })
  it('carries every new structural field onto a frame and drops the rest', () => {
    const out = applyStyle(el({ id: 'f', type: 'frame', strokeStyle: 'dotted' }), {
      fill: '#abcdef',
      strokeStyle: 'dashed',
      cornerRadiusTopLeft: 12,
      fontSize: 99, // not valid on a frame → ignored
    })
    expect(out.fill).toBe('#abcdef')
    expect(out.strokeStyle).toBe('dashed')
    expect(out.cornerRadiusTopLeft).toBe(12)
    expect(out.fontSize).toBeUndefined()
  })
  it('clones array style fields per target (no shared shadows reference)', () => {
    const shadows = [{ type: 'drop', x: 0, y: 4, blur: 8, spread: 0, color: '#000' }]
    const a = applyStyle(el({ id: 'a', type: 'frame' }), { shadows } as never)
    const b = applyStyle(el({ id: 'b', type: 'frame' }), { shadows } as never)
    expect(a.shadows).toEqual(shadows)
    expect(a.shadows).not.toBe(shadows) // cloned, not the copy's reference
    expect(a.shadows).not.toBe(b.shadows) // each target its own array
    expect(a.shadows![0]).not.toBe(shadows[0]) // and its own shadow objects
  })
  it('does not touch fields invalid for the target type when clearing', () => {
    // a text keeps its own non-style fields; only type-valid style fields move
    const out = applyStyle(el({ id: 't', type: 'text', textColor: '#111', fontSize: 14 }), {
      textColor: '#999',
    })
    expect(out.textColor).toBe('#999')
    expect(out.fontSize).toBeUndefined() // copy lacked it → cleared (valid for text)
  })
})
