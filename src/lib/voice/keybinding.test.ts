import { describe, it, expect } from 'vitest'
import {
  comboFromEvent,
  matchesCombo,
  formatComboForDisplay,
  isEditableTarget,
  type ComboKeyEvent,
} from './keybinding'

const ev = (key: string, mods: Partial<Omit<ComboKeyEvent, 'key'>> = {}): ComboKeyEvent => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
})

describe('comboFromEvent', () => {
  it('serializes modifiers in Ctrl/Alt/Shift/Meta order + the key', () => {
    expect(comboFromEvent(ev('v', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+V')
    expect(
      comboFromEvent(ev('x', { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true })),
    ).toBe('Ctrl+Alt+Shift+Meta+X')
  })

  it("maps ' ' to 'Space' and upper-cases single-char keys", () => {
    expect(comboFromEvent(ev(' ', { altKey: true }))).toBe('Alt+Space')
    expect(comboFromEvent(ev('a'))).toBe('A')
  })

  it('keeps multi-char keys verbatim (bare F9 is a valid combo)', () => {
    expect(comboFromEvent(ev('F9'))).toBe('F9')
    expect(comboFromEvent(ev('Escape', { ctrlKey: true }))).toBe('Ctrl+Escape')
  })

  it('returns null for a modifier-only press', () => {
    for (const key of ['Control', 'Alt', 'Shift', 'Meta']) {
      expect(comboFromEvent(ev(key, { ctrlKey: key === 'Control' }))).toBeNull()
    }
  })
})

describe('matchesCombo', () => {
  it('round-trips: an event matches its own serialization', () => {
    const e = ev(' ', { altKey: true })
    expect(matchesCombo(e, comboFromEvent(e)!)).toBe(true)
  })

  it('a missing modifier is a mismatch', () => {
    expect(matchesCombo(ev('v', { ctrlKey: true }), 'Ctrl+Shift+V')).toBe(false)
  })

  it('an EXTRA modifier is also a mismatch', () => {
    expect(matchesCombo(ev('v', { ctrlKey: true, altKey: true }), 'Ctrl+V')).toBe(false)
    expect(matchesCombo(ev('F9', { shiftKey: true }), 'F9')).toBe(false)
  })

  it('a different key is a mismatch', () => {
    expect(matchesCombo(ev('b', { ctrlKey: true }), 'Ctrl+V')).toBe(false)
  })

  it('normalizes a non-canonical stored combo (order + case)', () => {
    const e = ev('V', { ctrlKey: true, shiftKey: true })
    expect(matchesCombo(e, 'Shift+Ctrl+v')).toBe(true)
  })

  it('a modifier-only press never matches anything', () => {
    expect(matchesCombo(ev('Control', { ctrlKey: true }), 'Ctrl+V')).toBe(false)
  })
})

describe('formatComboForDisplay', () => {
  it('mac renders ⌃⌥⇧⌘ glyphs with no separators', () => {
    expect(formatComboForDisplay('Ctrl+Alt+Shift+Meta+V', 'mac')).toBe('⌃⌥⇧⌘V')
    expect(formatComboForDisplay('Alt+Space', 'mac')).toBe('⌥Space')
    expect(formatComboForDisplay('F9', 'mac')).toBe('F9')
  })

  it('other platforms keep the serialized form as-is', () => {
    expect(formatComboForDisplay('Ctrl+Shift+V', 'other')).toBe('Ctrl+Shift+V')
    expect(formatComboForDisplay('Alt+Space', 'other')).toBe('Alt+Space')
  })
})

describe('isEditableTarget', () => {
  // Duck-typed fakes — the function only reads tagName / isContentEditable,
  // so node-environment tests don't need a DOM.
  const fake = (tagName: string, isContentEditable = false) =>
    ({ tagName, isContentEditable }) as unknown as Element

  it('null is not editable', () => {
    expect(isEditableTarget(null)).toBe(false)
  })

  it('INPUT and TEXTAREA are editable', () => {
    expect(isEditableTarget(fake('INPUT'))).toBe(true)
    expect(isEditableTarget(fake('TEXTAREA'))).toBe(true)
  })

  it('contentEditable elements are editable', () => {
    expect(isEditableTarget(fake('DIV', true))).toBe(true)
  })

  it('plain elements are not', () => {
    expect(isEditableTarget(fake('DIV'))).toBe(false)
    expect(isEditableTarget(fake('BUTTON'))).toBe(false)
  })
})
