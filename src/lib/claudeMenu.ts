// claudeMenu.ts — detect Claude Code's interactive TUI menus from a
// reconstructed terminal SCREEN (rows of plain text). These numbered menus
// (tool-permission prompts, plan approval, etc.) are TUI-only — they never
// appear in the session JSONL — so the chat view reads them off the screen
// (the server feeds it via a headless xterm; see src/lib/server/terminal.ts).
//
// Pure + framework-free so both the server detector and the client type share
// it and it's unit-testable against a captured screen.

import { PROMPT_ROW_RE, RULE_ROW_RE } from './claudeScreen'

export interface MenuOption {
  n: number
  label: string
  /** The ❯ cursor is on this option (claude's current highlight / default). */
  selected?: boolean
  /** "Yes, allow all edits during this session" style option. */
  allowAll?: boolean
}

export interface DetectedMenu {
  /** Stable hash of question+options — lets the server emit only on change. */
  signature: string
  question: string
  options: MenuOption[]
  canCancel: boolean
}

// "❯ 1. Yes" / "  2. Yes, allow all… (shift+tab)" / "3. No". The cursor glyph is
// limited to ❯/▸ (claude's actual selection markers) — NOT ">", a common
// prose/blockquote prefix.
const OPTION_RE = /^\s*([❯▸])?\s*(\d+)\.\s+(.+?)\s*$/

// Detect a numbered menu in the screen text: a ❯/▸ cursor on a numbered
// option, the options 1,2,3,… around it (≥2), and no INPUT BOX below it.
//
// The cursor is the gate, not a footer or a trailing "?" (2026-09-26). A real
// claude chooser ALWAYS highlights an option with ❯; a numbered list claude
// WROTE never does. The old gate ("a menu footer anywhere on screen, or a
// question ending in ?") was met by the idle footer every president desk
// shows — `⏵⏵ bypass permissions on (shift+tab to cycle)` matched `shift+tab` —
// so any answer ending in a numbered list read as an open menu for as long as
// it stayed on screen, and noticeDeliverable held every commander reply behind
// it (Echona, ~55 min, until a restart repainted the desk). This same cursor
// gate was the fix of 2026-06-09 (60252731); the terminal-only purge deleted
// the file and fd28a9c4 restored the older version.
//
// "No input box below the cursor": a chooser REPLACES the input box — measured
// on real claude 2.1.283 for /model and AskUserQuestion
// (scripts/probe-desk-choosers.mts). An owner turn sent as "1. … 2. …" renders
// as `❯ 1. …` / `  2. …` in the history, with the live input box below it;
// that is conversation, not a menu. The input box is a `❯` row directly under
// a rule (`────`) — a bare `❯` row below a chooser (a shell-style status line)
// does not hide it.
//
// The options are gathered FROM the cursor, skipping numbered rows that do not
// continue the count: an option's own description may hold a numbered row
// (`❯ 1. 赤` / `     1. 明るい` / `  2. 青`) and must not split the menu.
// Both rules err toward "menu" — a misread holds a notice, never types one.
//
// The cursor may also sit on a row WITHOUT a number — a multiSelect
// AskUserQuestion's `❯    Submit` (real claude 2.1.283, commander rework 2).
// Such a row counts when numbered options 1,2,… sit above it and a chooser's
// own "Esc to cancel / Esc to exit" hint sits below it. That hint is never in
// the idle bypass footer, so this path cannot bring back the misread above;
// and an owner turn (`❯ text`) always has the input box below it.
const CURSOR_ROW_RE = /^\s*[❯▸]\s*\S/
const CHOOSER_HINT_RE = /\besc to (?:cancel|exit)\b/i

export const detectMenu = (screenText: string): DetectedMenu | null => {
  const rows = screenText.split('\n').map((r) => r.replace(/\s+$/, ''))

  // Collect every numbered-option line with its row index.
  const hits: { row: number; n: number; label: string; selected: boolean }[] = []
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].match(OPTION_RE)
    if (m) hits.push({ row: i, n: Number(m[2]), label: m[3].trim(), selected: !!m[1] })
  }
  if (hits.length < 2) return null

  const inputBoxBelow = (row: number): boolean =>
    rows.some((r, i) => i > row && PROMPT_ROW_RE.test(r) && RULE_ROW_RE.test(rows[i - 1]))
  // Options 1,2,… reached from hits[k]: back to 1, then forward — skipping
  // numbered rows that do not continue the count. Null unless ≥2 from 1.
  const gather = (k: number): typeof hits | null => {
    const opts = [hits[k]]
    for (let j = k - 1; j >= 0 && opts[0].n > 1; j--) if (hits[j].n === opts[0].n - 1) opts.unshift(hits[j])
    if (opts[0].n !== 1) return null
    for (let j = k + 1; j < hits.length; j++) if (hits[j].n === opts[opts.length - 1].n + 1) opts.push(hits[j])
    return opts.length >= 2 ? opts : null
  }
  let best: typeof hits | null = null
  // Cursor rows, bottom-most first.
  for (let row = rows.length - 1; row >= 0 && !best; row--) {
    if (!CURSOR_ROW_RE.test(rows[row]) || inputBoxBelow(row)) continue
    const k = hits.findIndex((h) => h.row === row)
    if (k >= 0) {
      best = gather(k)
      continue
    }
    // Un-numbered cursor row (a Submit row): the options above it + a chooser hint below.
    const above = hits.findLastIndex((h) => h.row < row)
    if (above >= 0 && rows.slice(row + 1).some((r) => CHOOSER_HINT_RE.test(r))) best = gather(above)
  }
  if (!best) return null

  // Question = nearest non-empty, non-option line above the first option.
  let question = ''
  for (let i = best[0].row - 1; i >= 0; i--) {
    const t = rows[i].trim()
    if (!t || OPTION_RE.test(rows[i])) continue
    question = t
    break
  }

  const options: MenuOption[] = best.map((h) => ({
    n: h.n,
    label: h.label,
    selected: h.selected,
    allowAll: /allow all/i.test(h.label),
  }))
  const signature = `${question}||${options.map((o) => `${o.n}:${o.label}`).join('|')}`
  return {
    signature,
    question,
    options,
    canCancel: rows.some((r) => /esc to cancel/i.test(r)),
  }
}
