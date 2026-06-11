// generateProjectDescription — auto-write a project's one-liner description
// (English + Japanese, one run) by briefly running the user's local `claude`
// CLI (haiku) in the project and scraping language-tagged marker pairs out of
// the PTY OUTPUT STREAM. Same pattern as generateTaskTitle.ts — read its top
// comment for the full rationale.
//
// SUBSCRIPTION-ONLY (read claudeTerminal.ts top comment): claude MUST run
// inside a real PTY so it bills the user's Claude subscription pool, NOT the
// programmatic credit pool. `claude -p` / execFile('claude', ...) is FORBIDDEN
// here.
//
// WHY THE PTY STREAM, NOT THE SESSION JSONL: claude ≥2.1.169 no longer writes
// the per-session transcript for these one-off sessions — the old JSONL-polling
// version of this module always timed out with "could not extract". Completion
// = BOTH marker pairs appearing in the raw output:
//   `OPENGROUND_DESC_EN: <text> ::OG_DESC_END::`
//   `OPENGROUND_DESC_JA: <text> ::OG_DESC_END::`
// The end token bounds each description against TUI repaint junk AND lets a
// PTY line-wrap inside the text be collapsed back to spaces. Candidates
// containing '<' are rejected so the prompt's own echoed placeholder can never
// match. The PTY is torn down the moment both pairs land.
//
// Model is pinned to haiku: description-writing is light summarization over a
// quick read-only skim — the cheap model returns in seconds where the default
// took the better part of a minute.

import { newId } from '@/lib/ids'
import { launchClaude } from './claudeTerminal'
import { killTerminal, subscribeTerminal } from './terminal'

export const DESC_MARKER_EN = 'OPENGROUND_DESC_EN:'
export const DESC_MARKER_JA = 'OPENGROUND_DESC_JA:'
export const DESC_END = '::OG_DESC_END::'

// One short sentence by contract (the UI shows it on a single truncating
// line) — anything longer is a model that ignored the limit; cap it.
export const MAX_DESC_LEN = 200

// The scrape buffer keeps only the tail — the markers are always near the
// end, and an unbounded buffer would grow with every TUI repaint.
const MAX_BUFFER = 64_000

const DEFAULT_TIMEOUT_MS = 120_000
const POLL_MS = 500

// Cheap + fast for a one-line summary (same deliberate pin as TITLE_MODEL).
const DESCRIBE_MODEL = 'haiku'

// Read-only exploration prompt. Strict: no edits, no file writes, never touch
// .openground/, and end with exactly two marker lines (English + Japanese).
// One universal prompt — both languages are always produced regardless of the
// UI language, so switching the setting later needs no regeneration.
export const buildDescribePrompt = (): string =>
  [
    'Generate a one-line description of what this project is, in BOTH English and Japanese.',
    '',
    'Steps:',
    '- Briefly read the README, directory layout, package.json, etc. to grasp the purpose of the project (read-only).',
    '- Do not create, edit, or delete any files. Do not mutate anything via commands either.',
    '- Never touch the `.openground/` directory (both reading and writing are forbidden).',
    '',
    'Output:',
    '- At the very end, output exactly these two lines (in this order), and nothing after them:',
    `${DESC_MARKER_EN} <ONE short sentence in English — what the project is> ${DESC_END}`,
    `${DESC_MARKER_JA} <日本語で短い1文 — プロジェクトが何か> ${DESC_END}`,
    '- Put only the description text between the marker and the end token; no JSON, no quotes.',
    '- HARD LIMIT: one sentence, max ~80 characters English / 40字 Japanese. It is',
    '  shown on a single truncating UI line — front-load the essence.',
  ].join('\n')

// Strip ANSI escapes / control chars from the raw PTY stream. The TUI doesn't
// just style text — it POSITIONS it: word gaps frequently arrive as cursor
// moves (CSI n C, CUP, …) instead of literal spaces, so deleting every CSI
// fuses words ("ClaudeCodemissioncontrol", observed live). Split the strip:
// SGR (style, CSI…m) deletes silently — it can sit mid-word — while every
// OTHER CSI is a positioning/erase op and becomes a space (the later \s+
// collapse de-dupes). OSC titles (]0;…BEL) are handled separately.
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;]*m/g
// eslint-disable-next-line no-control-regex
const CSI_OTHER_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** The LAST `<marker> … ::OG_DESC_END::` pair in the raw PTY output, cleaned
 *  and capped, or null. Marker-pair-only — no prose fallback (a wrong
 *  description is worse than none), and any candidate containing '<' is
 *  rejected: that's the prompt's own echoed placeholder, not a model answer.
 *  Exported for unit tests. */
export const extractDescMarker = (raw: string, marker: string): string | null => {
  const text = raw.replace(OSC_RE, '').replace(SGR_RE, '').replace(CSI_OTHER_RE, ' ')
  let from = text.length
  for (;;) {
    const start = text.lastIndexOf(marker, from - 1)
    if (start < 0) return null
    const end = text.indexOf(DESC_END, start + marker.length)
    if (end >= 0) {
      const candidate = text
        .slice(start + marker.length, end)
        .replace(CTRL_RE, ' ')
        // A PTY line wrap can split the sentence — collapse all whitespace
        // runs (incl. the injected newline) back to one space.
        .replace(/\s+/g, ' ')
        .trim()
      if (candidate && !candidate.includes('<')) return candidate.slice(0, MAX_DESC_LEN)
    }
    from = start
    if (from <= 0) return null
  }
}

export interface GeneratedDescriptions {
  en: string | null
  ja: string | null
}

/** Both language markers out of the raw PTY buffer (null where absent). */
export const extractMarkerPair = (raw: string): GeneratedDescriptions => ({
  en: extractDescMarker(raw, DESC_MARKER_EN),
  ja: extractDescMarker(raw, DESC_MARKER_JA),
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const generateProjectDescription = async (
  projectPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<GeneratedDescriptions> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // bypass (= --dangerously-skip-permissions): no human is at the TTY to
  // approve tool use, and the prompt forbids any mutation, so the read-only
  // exploration runs unattended.
  const ref = launchClaude({
    cwd: projectPath,
    agentSessionId: newId(),
    initialPrompt: buildDescribePrompt(),
    permissionMode: 'bypass',
    model: DESCRIBE_MODEL,
    name: 'describe',
    // Marker-scraped utility session: keep its system prompt pristine so the
    // OPENGROUND_DESC output contract can't drift toward "add a board card".
    appContext: false,
  })

  let buffer = ''
  let exited = false
  const sub = subscribeTerminal(
    ref.terminalId,
    (chunk) => {
      buffer = (buffer + chunk).slice(-MAX_BUFFER)
    },
    () => {
      exited = true
    },
  )
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      const pair = extractMarkerPair(buffer)
      // Complete only when BOTH languages landed — the two lines arrive
      // together at the very end, so a one-sided read is just mid-stream.
      if (pair.en && pair.ja) return pair
      if (exited || sub?.info.finishedAt) break
    }
    // Timed out, or the session ended early — take whatever DID land (one
    // language alone is still better than nothing).
    const pair = extractMarkerPair(buffer)
    if (pair.en || pair.ja) return pair
    throw new Error('could not extract a description from the claude session')
  } finally {
    sub?.unsubscribe()
    try {
      killTerminal(ref.terminalId)
    } catch {
      // best-effort teardown
    }
  }
}
