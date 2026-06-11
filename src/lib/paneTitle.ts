// Pane-header titles from OSC title escapes (ESC ]0;...BEL / ESC ]2;...ST).
// xterm.js parses those and surfaces them via Terminal.onTitleChange; Claude
// Code emits a live topic summary this way, so the pane header can show it
// with zero server-side parsing. These helpers keep the choose/sanitize rules
// pure and unit-testable.

/** Defensive cap — an OSC title is a one-liner, never a paragraph. */
export const MAX_PANE_TITLE_LEN = 200

/** Trim an incoming OSC title; null means "ignore, keep the previous one"
 *  (empty / whitespace-only titles are emitted by shells on reset). */
export function sanitizePaneTitle(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.length <= MAX_PANE_TITLE_LEN) return trimmed
  let capped = trimmed.slice(0, MAX_PANE_TITLE_LEN)
  // The cut is by UTF-16 units — if it landed mid-surrogate-pair (emoji),
  // drop the lone high surrogate so the title never renders a U+FFFD.
  const last = capped.charCodeAt(capped.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) capped = capped.slice(0, -1)
  return capped
}

/** Auto-generated slot labels look like "Terminal 3"; anything else means the
 *  user explicitly renamed the pane. */
export function isDefaultSlotLabel(label: string): boolean {
  return /^Terminal \d+$/.test(label)
}

/** What the pane header shows. A user-renamed label always wins — an explicit
 *  rename must not be shadowed by machine output (shells with a precmd title
 *  hook would otherwise make the rename affordance look broken). For the
 *  auto-generated "Terminal N" labels the live OSC title wins when present. */
export function paneHeaderTitle(
  oscTitle: string | undefined,
  label: string,
): string {
  if (!isDefaultSlotLabel(label)) return label
  return oscTitle && oscTitle.trim() ? oscTitle : label
}

/** Tooltip body: both the live OSC title and the slot label when they differ
 *  (so whichever one the header hides stays one hover away). */
export function paneTooltip(
  oscTitle: string | undefined,
  label: string,
): string {
  return oscTitle && oscTitle !== label ? `${oscTitle}\n${label}` : label
}
