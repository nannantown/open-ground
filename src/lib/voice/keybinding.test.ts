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

  // macOS mutates e.key while Option is held — the physical chord must still
  // serialize/match canonically via e.code.
  it('recovers the physical key from e.code when macOS Option mutates e.key', () => {
    // Option+Space → key is the no-break space
    expect(comboFromEvent(ev(' ', { altKey: true, code: 'Space' }))).toBe('Alt+Space')
    // Option+V → '√'
    expect(comboFromEvent(ev('√', { altKey: true, code: 'KeyV' }))).toBe('Alt+V')
    // Option+E → dead accent key
    expect(comboFromEvent(ev('Dead', { altKey: true, code: 'KeyE' }))).toBe('Alt+E')
    // Option+5 → '∞'
    expect(comboFromEvent(ev('∞', { altKey: true, code: 'Digit5' }))).toBe('Alt+5')
  })

  it("maps a bare no-break-space key to 'Space' even without code", () => {
    expect(comboFromEvent(ev(' ', { altKey: true }))).toBe('Alt+Space')
  })

  it('leaves layout-dependent codes alone (e.key stays authoritative)', () => {
    // JIS 英数 — code Lang2 is not a "simple" code; the key name is kept.
    expect(comboFromEvent(ev('Eisu', { ctrlKey: true, code: 'Lang2' }))).toBe('Ctrl+Eisu')
    // Punctuation moves between layouts — don't translate via code.
    expect(comboFromEvent(ev(';', { ctrlKey: true, code: 'Semicolon' }))).toBe('Ctrl+;')
  })

  it('without Ctrl/Alt/Meta the typed key wins over code (Shift+A is A)', () => {
    expect(comboFromEvent(ev('A', { shiftKey: true, code: 'KeyA' }))).toBe('Shift+A')
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

  it("the default 'Alt+Space' matches a real macOS Option+Space event", () => {
    expect(matchesCombo(ev(' ', { altKey: true, code: 'Space' }), 'Alt+Space')).toBe(true)
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
