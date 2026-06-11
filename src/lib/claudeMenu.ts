// claudeMenu.ts — detect Claude Code's interactive TUI menus from a
// reconstructed terminal SCREEN (rows of plain text). These numbered menus
// (tool-permission prompts, plan approval, etc.) are TUI-only — they never
// appear in the session JSONL — so the chat view reads them off the screen
// (the server feeds it via a headless xterm; see src/lib/server/terminal.ts).
//
// Pure + framework-free so both the server detector and the client type share
// it and it's unit-testable against a captured screen.

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

// "❯ 1. Yes" / "  2. Yes, allow all… (shift+tab)" / "3. No"
const OPTION_RE = /^\s*([❯>▸])?\s*(\d+)\.\s+(.+?)\s*$/
// Menu footers claude shows under a numbered prompt.
const FOOTER_RE = /esc to cancel|to amend|shift\+tab|↑↓ to select|enter to (confirm|select)/i

// Detect a numbered menu in the screen text. Returns null unless we find a
// CONSECUTIVE run of options starting at 1 (≥2 of them) gated by a menu footer
// or a trailing-"?" question — so ordinary numbered prose doesn't false-positive.
export const detectMenu = (screenText: string): DetectedMenu | null => {
  const rows = screenText.split('\n').map((r) => r.replace(/\s+$/, ''))

  // Collect every numbered-option line with its row index.
  const hits: { row: number; n: number; label: string; selected: boolean }[] = []
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].match(OPTION_RE)
    if (m) {
      hits.push({
        row: i,
        n: Number(m[2]),
        label: m[3].trim(),
        selected: !!m[1],
      })
    }
  }
  if (hits.length < 2) return null

  // Find the longest run that is consecutive 1,2,3,… (a real menu).
  let best: typeof hits = []
  let run: typeof hits = []
  let expect = 1
  for (const h of hits) {
    if (h.n === expect) {
      run.push(h)
      expect++
    } else if (h.n === 1) {
      run = [h]
      expect = 2
    } else {
      run = []
      expect = 1
    }
    if (run.length > best.length) best = run.slice()
  }
  if (best.length < 2) return null

  const firstRow = best[0].row
  const hasFooter = rows.some((r) => FOOTER_RE.test(r))

  // Question = nearest non-empty, non-option line above the first option.
  let question = ''
  for (let i = firstRow - 1; i >= 0; i--) {
    const t = rows[i].trim()
    if (!t || OPTION_RE.test(rows[i])) continue
    question = t
    break
  }

  // Gate: must look like an interactive prompt, not stray numbered text.
  if (!hasFooter && !question.endsWith('?')) return null

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
