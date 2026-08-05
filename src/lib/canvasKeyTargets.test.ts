import { describe, it, expect } from 'vitest'
import {
  canvasShouldHandleShortcut,
  isEditableField,
  isTextEditingField,
} from './canvasKeyTargets'

// ─── 「canvasでコマンド+zで戻るのショートカットが動かない」(owner, 2026-08-04) ──
//
// Reproduced, then measured end to end in the running app. The canvas key map
// asked "is focus in a field?" and, if so, dropped EVERY ⌘-shortcut. Focus lands
// in the inspector's X / Y / W / H boxes constantly — click a shape, nudge a
// number — so ⌘Z was reaching a `return` before it ever got to the undo branch.
// Instrumented in the browser: `willReturn: true` with focus in the X field,
// undo never called, nothing on screen changed.
//
// After the fix, the same probe reads `willReturn: false`, `undoDepth 1 → 0`,
// `redoDepth 0 → 1`, and the shape visibly returns to where it was.
//
// ⚠ THE OTHER DIRECTION IS THE DANGEROUS ONE. A text field must KEEP ⌘Z — the
// browser's own undo is the right one there, and taking it would discard a
// half-typed word, including a half-composed Japanese one. So every case below
// states which side it is guarding, and the unknown-input-type case fails toward
// "leave it alone".

describe('isEditableField — anything that accepts typing', () => {
  it.each([
    [{ tagName: 'INPUT' }, true],
    [{ tagName: 'TEXTAREA' }, true],
    [{ tagName: 'DIV', isContentEditable: true }, true],
    [{ tagName: 'DIV' }, false],
    [{ tagName: 'BUTTON' }, false],
    [{}, false],
  ] as const)('%o → %s', (focused, expected) => {
    expect(isEditableField(focused)).toBe(expected)
  })
})

describe('isTextEditingField — who owns ⌘Z', () => {
  it('a numeric / value box does NOT own it', () => {
    // These are the inspector fields the owner was sitting in.
    for (const type of ['number', 'range', 'checkbox', 'radio', 'color'])
      expect(isTextEditingField({ tagName: 'INPUT', type }), type).toBe(false)
  })

  it('anything that holds a sentence DOES own it', () => {
    for (const type of ['text', 'search', 'url', 'email', 'tel', 'password'])
      expect(isTextEditingField({ tagName: 'INPUT', type }), type).toBe(true)
    expect(isTextEditingField({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextEditingField({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('an input with no type stated is text — that is the HTML default', () => {
    expect(isTextEditingField({ tagName: 'INPUT' })).toBe(true)
  })

  it('an UNKNOWN input type is treated as text — fail toward leaving it alone', () => {
    // A future input type we have not classified must not silently lose the
    // browser's undo. Losing a word is worse than a shortcut doing nothing.
    expect(isTextEditingField({ tagName: 'INPUT', type: 'date' })).toBe(true)
    expect(isTextEditingField({ tagName: 'INPUT', type: 'something-new' })).toBe(true)
  })
})

describe('canvasShouldHandleShortcut', () => {
  const numberBox = { tagName: 'INPUT', type: 'number' }
  const textBox = { tagName: 'INPUT', type: 'text' }
  const nothing = { tagName: 'BODY' }

  it('THE BUG: undo reaches the canvas from a numeric inspector box', () => {
    expect(canvasShouldHandleShortcut('z', numberBox)).toBe(true)
    expect(canvasShouldHandleShortcut('y', numberBox)).toBe(true)
  })

  it('THE OTHER SIDE: a text box keeps undo for the browser', () => {
    expect(canvasShouldHandleShortcut('z', textBox)).toBe(false)
    expect(canvasShouldHandleShortcut('y', textBox)).toBe(false)
    expect(canvasShouldHandleShortcut('z', { tagName: 'TEXTAREA' })).toBe(false)
    expect(canvasShouldHandleShortcut('z', { tagName: 'DIV', isContentEditable: true })).toBe(
      false,
    )
  })

  it('the carve-out is undo ONLY — copy/paste/duplicate keep the old rule', () => {
    // Widening this to every shortcut would break ⌘C inside a field, which is
    // exactly the thing the original blanket rule was protecting.
    for (const k of ['c', 'v', 'x', 'd', 'a'])
      expect(canvasShouldHandleShortcut(k, numberBox), k).toBe(false)
  })

  it('with nothing focused the canvas handles everything, as before', () => {
    for (const k of ['z', 'y', 'c', 'v', 'x', 'd'])
      expect(canvasShouldHandleShortcut(k, nothing), k).toBe(true)
  })
})
