// generateTaskTitle — summarize a Board card's content into a short title by
// briefly running the user's local `claude` CLI (haiku) and scraping a marker
// pair out of the PTY OUTPUT STREAM.
//
// SUBSCRIPTION-ONLY (read claudeTerminal.ts top comment): claude MUST run
// inside a real PTY so it bills the user's Claude subscription pool, NOT the
// programmatic credit pool. `claude -p` / execFile('claude', ...) is FORBIDDEN
// here.
//
// WHY THE PTY STREAM, NOT THE SESSION JSONL: claude ≥2.1.169 no longer writes
// the per-session transcript for these one-off sessions (verified 2026-06-11:
// the marker prints in the terminal but no JSONL ever appears — the same
// regression that forced the terminal-only pivot). So completion = the marker
// PAIR appearing in the raw output: `OPENGROUND_TITLE: <title> ::OG_END::`.
// The end token bounds the title against the TUI spinner/status junk that the
// redraw appends to the same raw line, and candidates containing '<' are
// rejected so the prompt's own echoed instruction (`<the title>`) can never
// match. Tear the PTY down the moment the pair lands.
//
// Card creation can burst (paste, paste, paste) — runs are SERIALIZED through
// a global promise chain so the app never fans out a haiku PTY per keystroke.
// The chain lives on globalThis to survive `tsx watch` reloads in dev.

import { newId } from '@/lib/ids'
import { launchClaude } from './claudeTerminal'
import { killTerminal, subscribeTerminal } from './terminal'

export const TITLE_MARKER = 'OPENGROUND_TITLE:'
export const TITLE_END = '::OG_END::'

// Content beyond this is noise for a title — cap what rides the prompt.
const MAX_CONTENT_CHARS = 2_000
export const MAX_TITLE_LEN = 60
// The scrape buffer keeps only the tail — the marker is always near the end,
// and an unbounded buffer would grow with every TUI repaint.
const MAX_BUFFER = 64_000

const DEFAULT_TIMEOUT_MS = 60_000
const POLL_MS = 500

// Cheap, fast, good enough for a one-line summary — and a deliberate model
// pin: the task itself may run on anything, but titling must stay light.
const TITLE_MODEL = 'haiku'

export const buildTitlePrompt = (content: string): string =>
  [
    'Summarize the following task description into ONE short title.',
    '',
    'Rules:',
    '- Same language as the description (Japanese description → Japanese title).',
    '- At most 40 characters. Concrete and specific — lead with the action/verb where natural.',
    '- No quotes, no trailing period, no markdown, no angle brackets, no issue-number prefixes.',
    '- Do NOT read any files and do NOT run any commands — answer from the text below alone.',
    '- Output exactly one final line and nothing after it:',
    `${TITLE_MARKER} <the title> ${TITLE_END}`,
    '',
    '## Task description',
    content.slice(0, MAX_CONTENT_CHARS),
  ].join('\n')

// Strip ANSI escapes / control chars from the raw PTY stream. The CSI strip
// also covers OSC titles' CSI-ish forms poorly, so OSC (]0;…BEL) is handled
// separately.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** The LAST `OPENGROUND_TITLE: … ::OG_END::` pair in the raw PTY output,
 *  cleaned and capped, or null. Marker-pair-only — no prose fallback (a wrong
 *  title is worse than keeping the first-line provisional one), and any
 *  candidate containing '<' is rejected: that's the prompt's own echoed
 *  placeholder, not a model answer. Exported for unit tests. */
export const extractTitle = (raw: string): string | null => {
  const text = raw.replace(OSC_RE, '').replace(ANSI_RE, '')
  let from = text.length
  for (;;) {
    const start = text.lastIndexOf(TITLE_MARKER, from - 1)
    if (start < 0) return null
    const end = text.indexOf(TITLE_END, start + TITLE_MARKER.length)
    if (end >= 0) {
      const candidate = text
        .slice(start + TITLE_MARKER.length, end)
        .replace(CTRL_RE, ' ')
        // A line wrap at the PTY column boundary can split the title — collapse
        // all whitespace runs (incl. the injected newline) back to one space.
        .replace(/\s+/g, ' ')
        .trim()
        // Strip a model that quoted anyway.
        .replace(/^["'「『]+|["'」』]+$/g, '')
        .trim()
      if (candidate && !candidate.includes('<')) return candidate.slice(0, MAX_TITLE_LEN)
    }
    from = start
    if (from <= 0) return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const runOnce = async (
  projectPath: string,
  content: string,
  timeoutMs: number,
): Promise<string | null> => {
  // bypass: nobody is at the TTY, and the prompt forbids tools — text-only.
  const ref = launchClaude({
    cwd: projectPath,
    agentSessionId: newId(),
    initialPrompt: buildTitlePrompt(content),
    permissionMode: 'bypass',
    model: TITLE_MODEL,
    name: 'title',
    // Marker-scraped utility session — keep the system prompt pristine.
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
      const title = extractTitle(buffer)
      if (title) return title
      if (exited || sub?.info.finishedAt) break
    }
    // One last read — the marker may have landed between the poll and the exit.
    return extractTitle(buffer)
  } finally {
    sub?.unsubscribe()
    try {
      killTerminal(ref.terminalId)
    } catch {
      // best-effort teardown
    }
  }
}

// Global serialization chain (globalThis: survives tsx watch reloads, same
// pattern as the terminal pool). Failures don't break the chain.
const g = globalThis as typeof globalThis & {
  __openground_title_chain?: Promise<unknown>
}

/** Summarize `content` into a short title via a one-off haiku session in
 *  `projectPath`. Resolves null when nothing usable came back (caller keeps
 *  the provisional first-line title). Concurrent calls run one at a time. */
export const generateTaskTitle = (
  projectPath: string,
  content: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> => {
  const prev = g.__openground_title_chain ?? Promise.resolve()
  const run = prev
    .catch(() => {})
    .then(() => runOnce(projectPath, content, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  g.__openground_title_chain = run.catch(() => {})
  return run
}
