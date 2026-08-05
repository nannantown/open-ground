/**
 * Does the focused field want this keystroke for itself?
 *
 * THE BUG THIS EXISTS FOR (owner, 2026-08-04: 「canvasでコマンド+zで戻るの
 * ショートカットが動かない」). The canvas key map asked one question — "is focus
 * in a field?" — and if so gave up every shortcut. That is right for ⌘C / ⌘V /
 * ⌘D, and wrong for undo: the inspector's X / Y / W / H / rotation / radius /
 * opacity boxes are where you ARE while designing (click a shape, nudge a
 * number), and a committed numeric box has nothing of its own to undo. So ⌘Z
 * went nowhere at all — measured: focus the X field, press ⌘Z, the key handler
 * returned before it ever reached the undo branch.
 *
 * A TEXT field is the opposite case and must keep ⌘Z. The browser's own undo is
 * the correct one there, and stealing it would throw away a half-typed word —
 * including a half-composed one, which for Japanese input is worse than losing a
 * shape.
 *
 * So the question is not "am I in a field?" but "does THIS field want THIS key?".
 */

/** Input types that hold text a user could be part-way through typing. */
const TEXTUAL_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
])

export interface FocusedFieldShape {
  /** `document.activeElement.tagName`, or undefined when nothing has focus. */
  tagName?: string
  /** `input.type` — only meaningful for INPUT. */
  type?: string
  /** contentEditable hosts (rich text) count as textual. */
  isContentEditable?: boolean
}

/** Focus is inside something that accepts typing of any kind. */
export const isEditableField = (f: FocusedFieldShape): boolean =>
  f.tagName === 'INPUT' || f.tagName === 'TEXTAREA' || !!f.isContentEditable

/**
 * Focus is inside something that owns the TEXT-editing shortcuts (undo/redo in
 * particular). Anything that is not clearly non-textual counts as textual —
 * an unknown input type keeps the browser's behaviour, which is the safe
 * direction: at worst a shortcut does nothing, never destroys a word.
 */
export const isTextEditingField = (f: FocusedFieldShape): boolean => {
  if (f.isContentEditable) return true
  if (f.tagName === 'TEXTAREA') return true
  if (f.tagName !== 'INPUT') return false
  const t = (f.type || 'text').toLowerCase()
  // Explicitly non-textual: these hold a value, not a sentence.
  if (['number', 'range', 'checkbox', 'radio', 'color', 'button', 'submit'].includes(t))
    return false
  return TEXTUAL_INPUT_TYPES.has(t) || true
}

/**
 * Should the canvas handle this ⌘-shortcut, given where focus is?
 *
 * @param key      lowercased `e.key`
 * @param focused  the focused element's shape
 */
export const canvasShouldHandleShortcut = (key: string, focused: FocusedFieldShape): boolean => {
  if (!isEditableField(focused)) return true
  // The one carve-out: undo / redo reach the canvas from a NON-text field.
  const undoish = key === 'z' || key === 'y'
  return undoish && !isTextEditingField(focused)
}
