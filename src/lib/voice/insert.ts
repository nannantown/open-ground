// Insert a finished voice transcript at a previously captured focus target.
//
// Two paths, by target kind:
// - xterm's hidden helper textarea → a synthetic ClipboardEvent('paste').
//   xterm listens for 'paste' on that textarea and routes the text through its
//   bracketed-paste pipeline — the exact same path as Cmd+V — so the PTY (and
//   Claude Code's readline) receives multi-line text correctly. Chrome/Electron
//   support constructing DataTransfer + ClipboardEvent; this app never runs
//   elsewhere.
// - plain INPUT / TEXTAREA / contentEditable → document.execCommand
//   ('insertText'), which inserts at the caret AND fires a real `input` event,
//   so React-controlled fields see the change through their normal onChange.
//
// Browser-only by nature (like recorder.ts) — no unit tests; the pure pieces
// of the voice pipeline live in wav.ts / keybinding.ts.

import { isEditableTarget } from './keybinding'

/** True when `el` is xterm.js's hidden input proxy (its class name is stable
 *  public DOM across xterm 5.x). */
const isXtermTextarea = (el: Element): boolean =>
  el.tagName === 'TEXTAREA' && el.classList.contains('xterm-helper-textarea')

/** Insert `text` into `target` (the element that had focus when recording
 *  stopped). Returns false when the target is gone or not text-editable —
 *  the caller falls back to the clipboard. */
export function insertTranscript(target: Element | null, text: string): boolean {
  if (!target || !target.isConnected) return false
  const el = target as HTMLElement
  if (isXtermTextarea(el)) {
    el.focus()
    const data = new DataTransfer()
    data.setData('text/plain', text)
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    return true
  }
  if (isEditableTarget(el)) {
    el.focus()
    return document.execCommand('insertText', false, text)
  }
  return false
}
