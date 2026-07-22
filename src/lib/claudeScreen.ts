// claudeScreen — the ANATOMY of a rendered `claude` TUI frame, in one place.
//
// A screen scrape has to answer "which rows are the CLI's own furniture, and
// which are the conversation?" before it can answer anything else. Three
// consumers need that answer and each used to carry its own idea of it:
//
//   • swarmQuestions   — walks up from the input box to the last utterance
//                        (free-text-question detection);
//   • swarmEscalations — checks whether an injected turn LANDED;
//   • swarmRateLimitText — measures WHERE a quota notice sits (owner-desk arm).
//
// The third one grew a private re-implementation, and it was wrong in the
// expensive direction: it modelled the input box as a `│ … │` bordered box, so
// at real geometry the `❯`-prefixed prompt row and the status footers counted as
// CONVERSATION. A half-typed message or a spinner line then pushed a real notice
// out of position and the sensor went silent on the exact event it exists for
// (found in adversarial review, 2026-07-18 — rendered through a real headless
// xterm at 80/120/200 columns).
//
// So the anatomy lives HERE, once, and the consumers import it. This module is
// deliberately a LEAF: pure string → string/boolean, no imports, no clock, no
// state — swarmRateLimitText exists precisely so the pre-launch tier probe can
// reuse the wording without dragging the 7k-line engine in, and this module must
// not undo that by pulling in the modules that used to own these regexes.
//
// Every shape below is pinned against LIVE `claude` TUI frames captured through
// terminal.ts's headless-xterm scrape (2026-07-06, re-verified 2026-07-18). The
// frame looks like this — note the input box is fenced by RULES with a `❯`
// prompt row, NOT drawn as a bordered box (the `╭──╮` box is the welcome banner
// only):
//
//     ╭────────────────────────────╮
//     │ ✻ Welcome to Claude Code!  │   ← banner (box-drawn)
//     ╰────────────────────────────╯
//      ⚠ 2 MCP servers need authentication · run /mcp
//     ❯ the owner's submitted turn                        ← conversation
//     ⏺ claude's reply                                    ← conversation
//       its wrapped continuation, indented                ← conversation
//     ✻ Brewed for 7s                                     ← chrome
//                    You've used 88% of your Fable 5 limit · resets 3pm
//     ──────────────────────────────────────────────────  ← input box top rule
//     ❯ whatever the owner is typing right now            ← input box
//     ──────────────────────────────────────────────────  ← input box bottom rule
//       ? for shortcuts · ← for agents                    ← footer
//       ⏵⏵ accept edits on · Context left until auto-compact: 12%

/** Strip the ANSI/CSI/OSC escape sequences a `claude` TUI interleaves, leaving the
 *  text a human reads. Enough of the grammar to clear what claude emits — this is
 *  a display scraper, not a terminal emulator (the real emulation is
 *  @xterm/headless, which terminal.ts renders through; this covers the paths that
 *  read a raw buffer instead). Pure. */
export const stripAnsi = (s: string): string =>
  s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')

/** Idle-footer marker: claude's input box is empty and waiting for the human. */
export const IDLE_FOOTER_RE = /\?\s+for shortcuts/i

/** Footer marker claude's TUI shows ONLY while generating — its appearance after
 *  a submitted CR is positive proof the turn LANDED (swarmEscalations' W16
 *  delivery check), and its ABSENCE is what tells a screen-reading sensor that
 *  this session is not currently producing output. */
export const WORKING_FOOTER_RE = /esc to interrupt/i

/** The input-box prompt glyph. Deliberately ONLY the exact `❯` claude renders —
 *  a looser `>` would match quoted shell output; an unrecognised future glyph
 *  makes detection fail closed rather than misfire. */
export const PROMPT_ROW_RE = /^\s*❯(.*)$/

/** A horizontal rule row (the input box's top/bottom separators). */
export const RULE_ROW_RE = /^\s*[─━]{6,}\s*$/

/** The empty input box's occasional suggestion placeholder (`❯ Try "…"`).
 *  Carried over VERBATIM from swarmQuestions (including its duplicated `"`), so
 *  extracting this module changes no behaviour. */
export const PLACEHOLDER_RE = /^try ["'"«]/i

/** Rows that are TUI chrome, not conversation: blank, rules, footers, the usage
 *  meter, MCP warnings, spinner / turn-complete lines ("✻ Brewed for 7s"), tips
 *  and tool-result gutters ("⎿ …"), and the status footer's own segments.
 *
 *  Structural where it can be (a rule is a rule however it is worded) and
 *  textual only where the CLI gives nothing structural to key on. */
export const CHROME_ROW_RES: readonly RegExp[] = [
  /^\s*$/,
  RULE_ROW_RE,
  // The usage meter. Apostrophe-agnostic and tolerant of a space before `%`: the
  // CLI could curl this apostrophe (it is a display string, and swarmRateLimitText
  // already admits `you’ve` elsewhere) and the cost of missing it is not cosmetic —
  // the meter row stops being chrome, merges into the notice's block, and a REAL
  // stop goes silent. One character between a styling change and total silence is
  // too tight a coupling to leave (round 6).
  /you['’]ve used \d+\s*% of/i,
  /^\s*⚠/,
  /^\s*⎿/,
  /^\s*[✻✳✶✽✢·∗*]\s/,
  IDLE_FOOTER_RE,
  WORKING_FOOTER_RE,
  /for agents\s*$/i,
  // Status-footer segments that sit BELOW the input box. They are already
  // dropped by the positional cut in {@link conversationRows}, so these are the
  // belt to that braces — they also occur without a readable input box (a frame
  // scrolled mid-repaint), and a footer counted as conversation is exactly how
  // the owner-desk sensor went silent before this module existed.
  /^\s*⏵⏵/,
  /context left until auto-compact/i,
]

/** Is this row TUI chrome rather than conversation? */
export const isChromeRow = (row: string): boolean => CHROME_ROW_RES.some((re) => re.test(row))

/** A box-drawn banner row (`│ ✻ Welcome to Claude Code! │`) — the welcome frame,
 *  the one place the CLI really does draw a bordered box. Recognised by both
 *  ends being box-drawing glyphs (U+2500–U+257F). */
const BOX_DRAWING = /[─-╿]/
export const isBannerRow = (row: string): boolean => {
  const t = row.trim()
  if (!t) return false
  if (!/[^\s─-╿]/.test(t)) return true // a pure rule of box glyphs
  return BOX_DRAWING.test(t[0]) && BOX_DRAWING.test(t[t.length - 1])
}

/** Index of the LAST input-box prompt row (`❯ …`), or -1. The conversation log
 *  above may contain earlier `❯` rows (submitted user turns) — the input box is
 *  always the last one. */
export const lastPromptRow = (rows: readonly string[]): number => {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (PROMPT_ROW_RE.test(rows[i])) return i
  }
  return -1
}

/** The input box's visible text: the last `❯` row's remainder plus its wrapped
 *  continuation rows (until the closing rule / end of frame), joined. */
export const readInputBoxText = (screen: string): string | null => {
  const rows = screen.split('\n')
  const p = lastPromptRow(rows)
  if (p < 0) return null
  const parts: string[] = [rows[p].replace(PROMPT_ROW_RE, '$1')]
  for (let i = p + 1; i < rows.length; i++) {
    if (RULE_ROW_RE.test(rows[i]) || IDLE_FOOTER_RE.test(rows[i])) break
    parts.push(rows[i])
  }
  return parts.join('\n').trim()
}

/** Where the INPUT BOX begins — the index of the rule fencing the last `❯` row,
 *  or that row itself when no rule precedes it. Everything from here down is the
 *  CLI's furniture plus whatever the OWNER is currently typing; nothing below is
 *  something `claude` said. Returns rows.length when there is no input box on
 *  screen (a frame caught mid-repaint), i.e. "cut nothing".
 *
 *  This positional cut is the load-bearing half of the chrome model: the text
 *  inside the box is the owner's, so a half-written message must not count as
 *  conversation — otherwise it displaces whatever claude last said, which is the
 *  difference between noticing a stopped session and going quiet on it. */
export const inputBoxStart = (rows: readonly string[]): number => {
  const p = lastPromptRow(rows)
  if (p < 0) return rows.length
  // Walk up over the box's own (possibly wrapped) rows to its opening rule.
  let top = p
  while (top > 0 && !RULE_ROW_RE.test(rows[top - 1]) && !isChromeRow(rows[top - 1])) top--
  return top > 0 && RULE_ROW_RE.test(rows[top - 1]) ? top - 1 : top
}

/** The CONVERSATION rows of a rendered frame: everything above the input box,
 *  minus chrome and the welcome banner. What remains is what the owner and
 *  `claude` actually said to each other, in order. Pure. */
export const conversationRows = (screen: string): string[] => {
  const rows = screen.split('\n')
  const out: string[] = []
  // A tool RESULT is chrome for its whole height, not just its first row. Only the
  // opening row carries the `⎿` glyph; everything under it is a plain indented row
  // that would otherwise read as something `claude` said — so `cat`-ing a captured
  // worker screen would put that screen's words into the conversation. Adversarial
  // review (2026-07-18) confirmed a multi-line result doing exactly that. The run
  // ends at the first row that is not an indented continuation.
  let inToolResult = false
  for (const r of rows.slice(0, inputBoxStart(rows))) {
    if (/^\s*⎿/.test(r)) {
      inToolResult = true
      continue
    }
    if (inToolResult) {
      if (/^\s+\S/.test(r)) continue // still inside the result
      inToolResult = false
    }
    if (!isChromeRow(r) && !isBannerRow(r)) out.push(r)
  }
  return out
}

/** Is `claude` currently generating? A pure negative signal: `true` only when the
 *  working footer is on screen. Callers use it to REJECT (this session is busy,
 *  so whatever its screen says it has not stopped) — never to confirm, so an
 *  unrecognised future footer degrades to "not busy" rather than to a wrong
 *  reject.
 *
 *  Scoped to the FOOTER REGION (everything from the input box down), not to the
 *  whole frame. `esc to interrupt` is ordinary text as well as a footer: a desk
 *  that has just read this very file, or printed the docs that quote it, or whose
 *  owner typed the phrase into the input box, would otherwise be judged "busy"
 *  forever and could never report a stop. Adversarial review (2026-07-18) verified
 *  that at 80/120/200 columns — a real notice went unreported because the string
 *  sat in a `⎿` tool result higher up the screen. The first-order victims were the
 *  desks developing this feature, which is the worst possible place for a sensor
 *  to go quiet.
 *
 *  The region is everything BELOW the input box's closing rule — the footer's own
 *  strip. Starting at the box instead would include what the OWNER is typing, and
 *  a desk where they had typed the phrase (asking what it means, say) would read
 *  as busy: the same defect one row lower down. A frame with no rule at all yields
 *  an empty region and so reads "not busy" — the documented safe direction (it
 *  falls through to the caller's other checks rather than silencing them). */
export const isGenerating = (screen: string | null | undefined): boolean => {
  if (!screen) return false
  const rows = screen.split('\n')
  let lastRule = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (RULE_ROW_RE.test(rows[i])) {
      lastRule = i
      break
    }
  }
  if (lastRule < 0) return false
  return rows.slice(lastRule + 1).some((r) => WORKING_FOOTER_RE.test(r))
}

/** Who said an utterance. `❯` opens a turn the OWNER submitted, `⏺` one `claude`
 *  produced; a row that starts in column 0 with neither marker is `unknown` —
 *  which is what a bare notice looks like, so this may only ever be used to
 *  REJECT ('owner'), never to require ('claude').
 *
 *  `orphan` is an INDENTED row with nothing above it to continue — the frame is
 *  scrolled so that whatever introduced it (a `⏺` header, a `⎿` gutter) is off the
 *  top. Its provenance is genuinely unknown: it is equally the tail of something
 *  `claude` said and the tail of a captured screen being read back. Callers that
 *  need to know who spoke must treat it as missing evidence, not as a turn. */
export type Speaker = 'owner' | 'claude' | 'unknown' | 'orphan'

/** One utterance: the words that were said, and who said them. */
export interface UtteranceBlock {
  text: string
  speaker: Speaker
}

/** Split conversation rows into UTTERANCE BLOCKS.
 *
 *  A block starts at a row that begins in column 0 and continues through the
 *  INDENTED rows under it — the TUI's own wrapping convention, verified against
 *  live frames: `⏺ claude's reply` followed by two-space continuations, `❯ the
 *  owner's turn` followed by its wrapped remainder. The leading turn marker is
 *  stripped so a block reads as the words that were said, but it is REMEMBERED as
 *  {@link UtteranceBlock.speaker} — stripping it and forgetting it is how a notice
 *  the owner pasted into the input box and submitted became indistinguishable from
 *  one `claude` printed (found in adversarial review, 2026-07-18).
 *
 *  Why a caller needs blocks rather than lines: "is this wording the whole of
 *  what was last said, or the TAIL of a longer thing that was said?" is not a
 *  question a line can answer. A quota notice QUOTED at the end of a report
 *  ("worker-2 is stuck, here is its screen:" + the notice, indented under it) is
 *  the same last LINE as a real stop and a different last BLOCK.
 *
 *  ⚠ Blank rows are SKIPPED, not treated as separators: the TUI paints them
 *  inside a single message, so a paragraph break must not split an utterance.
 *  A consequence worth knowing when reading a block's length: an indented notice
 *  merges into whatever un-indented row preceded it, however far above it sits. */
export const utteranceBlocks = (rows: readonly string[]): UtteranceBlock[] => {
  const blocks: UtteranceBlock[] = []
  for (const row of rows) {
    if (!row.trim()) continue
    const indented = /^\s/.test(row)
    const trimmed = row.trim()
    const marker = trimmed[0]
    const speaker: Speaker = marker === '❯' ? 'owner' : marker === '⏺' ? 'claude' : 'unknown'
    const text = trimmed.replace(/^[⏺❯]\s*/, '')
    const open = blocks[blocks.length - 1]
    // A row continues the open utterance when it is INDENTED — the TUI's wrapping
    // convention, and the only join this function makes.
    //
    // It deliberately does NOT join consecutive unmarked column-0 rows. Round 4
    // tried that, to be indifferent to whether the CLI hard-wraps a long notice;
    // round 5 measured the cost and it was far larger than the benefit. The chrome
    // list is a closed enumeration, so ANY column-0 row it does not know — an
    // `API Error: 529 Overloaded` (attested, swarmOrchestrator.test.ts), a bare URL,
    // a `Retrying in 30s…`, even `⏺` painted as a different glyph — would fold into
    // the notice below it and push a REAL stop out of position. Joining converted
    // "a row we don't recognise" from harmless into fatal. The hard-wrap case is
    // handled where it belongs instead: by the caller, which retries its judgement
    // over the two blocks joined (see endsInQuotaRefusal), so an unrecognised row
    // above the notice costs nothing.
    if (open && indented) open.text += ` ${text}`
    // An indented row with nothing open is a CONTINUATION whose parent has scrolled
    // off the top of the frame — see the `orphan` speaker.
    else blocks.push({ text, speaker: indented ? 'orphan' : speaker })
  }
  return blocks
}
