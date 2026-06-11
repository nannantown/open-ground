// Voice-dictation key combo (de)serialization — see VoiceSettings.keybinding
// in src/lib/types.ts for the contract: modifiers (Ctrl/Alt/Shift/Meta, in
// that order) + KeyboardEvent.key (single chars upper-cased, ' ' → 'Space'),
// joined by '+'. Pure functions (no DOM) so they unit-test in isolation; the
// VoiceController component wires them to real keyboard events.

/** The subset of KeyboardEvent these helpers read (duck-typed so tests can
 *  pass plain objects without a DOM). */
export interface ComboKeyEvent {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** KeyboardEvent.key values that ARE modifiers — a combo needs a main key,
 *  so pressing one of these alone never produces a combo. */
const MODIFIER_KEY_VALUES = new Set(['Control', 'Alt', 'Shift', 'Meta'])

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

const MAC_SYMBOLS: Record<string, string> = {
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Meta: '⌘',
}

/** Canonicalize a KeyboardEvent.key for serialization: single characters are
 *  upper-cased and the space character becomes the word 'Space'. */
function normalizeKey(key: string): string {
  if (key === ' ') return 'Space'
  return key.length === 1 ? key.toUpperCase() : key
}

/** Serialize a key event to the canonical combo string ('Alt+Space',
 *  'Ctrl+Shift+V', 'F9', …). Returns null for a modifier-only press. */
export function comboFromEvent(e: ComboKeyEvent): string | null {
  if (MODIFIER_KEY_VALUES.has(e.key)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(normalizeKey(e.key))
  return parts.join('+')
}

/** Split a serialized combo into its modifier set + main key. The main key is
 *  the last '+'-segment; an empty last segment means the key itself is '+'
 *  (e.g. 'Ctrl++'). */
function parseCombo(combo: string): { mods: Set<string>; key: string } {
  const segs = combo.split('+')
  let key = segs.pop() ?? ''
  if (key === '') {
    key = '+'
    segs.pop()
  }
  return { mods: new Set(segs), key: normalizeKey(key) }
}

/** Rebuild a combo in canonical form (fixed modifier order, normalized key)
 *  so stored combos match regardless of how they were spelled. */
function normalizeCombo(combo: string): string {
  const { mods, key } = parseCombo(combo)
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+')
}

/** True when the event is exactly `combo` — a missing OR extra modifier is a
 *  mismatch, and a modifier-only press never matches. */
export function matchesCombo(e: ComboKeyEvent, combo: string): boolean {
  const fromEvent = comboFromEvent(e)
  return fromEvent !== null && fromEvent === normalizeCombo(combo)
}

/** Human-readable combo: mac uses the standard ⌃⌥⇧⌘ glyphs (no separators),
 *  everything else keeps the 'Ctrl+Alt+…' serialization as-is. */
export function formatComboForDisplay(combo: string, platform: 'mac' | 'other'): string {
  if (platform !== 'mac') return combo
  const { mods, key } = parseCombo(combo)
  return MODIFIER_ORDER.filter((m) => mods.has(m))
    .map((m) => MAC_SYMBOLS[m])
    .join('') + key
}

/** True when `el` is a text-entry target (INPUT / TEXTAREA / contentEditable)
 *  — the VoiceController must not steal keystrokes from these. */
export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  return (el as HTMLElement).isContentEditable === true
}
