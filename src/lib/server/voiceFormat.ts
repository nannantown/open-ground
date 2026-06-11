// voiceFormat — clean up a raw voice-input transcription (fix recognition
// errors, punctuation, line breaks — nothing else) by briefly running the
// user's local `claude` CLI (haiku) and scraping a marker pair out of the PTY
// OUTPUT STREAM. Same pattern as generateTaskTitle.ts — read its top comment.
//
// SUBSCRIPTION-ONLY (read claudeTerminal.ts top comment): claude MUST run
// inside a real PTY so it bills the user's Claude subscription pool, NOT the
// programmatic credit pool. `claude -p` / execFile('claude', ...) is FORBIDDEN
// here.
//
// WHY THE PTY STREAM, NOT THE SESSION JSONL: claude ≥2.1.169 no longer writes
// the per-session transcript for these one-off sessions, so completion = the
// marker PAIR appearing in the raw output:
// `OPENGROUND_VOICE: <text…> ::OG_VOICE_END::`. Unlike the one-line title,
// the formatted text may span MULTIPLE lines — newlines between the markers
// are content, not column-wrap noise, so they are preserved (each line
// trimmed). Candidates containing '<' are rejected so the prompt's own echoed
// placeholder can never match.
//
// FALLBACK CONTRACT: formatting is best-effort polish on top of a working
// transcription — on any failure/timeout the caller gets the raw text back
// ({ formatted: false }) so voice input is NEVER blocked by this step.
//
// Dictation can burst — runs are SERIALIZED through a global promise chain
// (globalThis: survives `tsx watch` reloads) so the app never fans out a
// haiku PTY per utterance.

import { newId } from '@/lib/ids'
import { launchClaude } from './claudeTerminal'
import { killTerminal, subscribeTerminal } from './terminal'

export const VOICE_MARKER = 'OPENGROUND_VOICE:'
export const VOICE_END = '::OG_VOICE_END::'

// A single dictation chunk is short — anything beyond this is runaway input.
const MAX_RAW_CHARS = 8_000
// The scrape buffer keeps only the tail — the marker pair is always near the
// end, and an unbounded buffer would grow with every TUI repaint. Sized for a
// multi-line answer (≤ MAX_RAW_CHARS) plus a few repaints of it.
const MAX_BUFFER = 128_000

const DEFAULT_TIMEOUT_MS = 30_000
const POLL_MS = 500

// Cheap, fast, good enough for transcript cleanup — a deliberate model pin
// (same rationale as TITLE_MODEL): formatting must stay light.
const VOICE_MODEL = 'haiku'

export interface VoicePromptOpts {
  language: 'en' | 'ja'
  projectName?: string
}

export const buildVoicePrompt = (raw: string, opts: VoicePromptOpts): string => {
  const lang = opts.language === 'ja' ? 'Japanese' : 'English'
  return [
    'Clean up the following raw voice-input transcription.',
    '',
    'Rules:',
    '- ONLY fix obvious speech-recognition errors and add punctuation / line breaks.',
    '- Do NOT add meaning, do NOT summarize, do NOT answer or respond to the content.',
    `- Output in the same language as the input (${lang}).`,
    ...(opts.projectName
      ? [
          `- The utterance was spoken while working on the "${opts.projectName}" project — interpret proper nouns in that context.`,
        ]
      : []),
    '- Do NOT read any files and do NOT run any commands — answer from the text below alone.',
    '- Output format — first line starts with the marker, then the cleaned text (multiple lines allowed), closed by the end token right after it:',
    VOICE_MARKER,
    '<the cleaned text>',
    VOICE_END,
    '',
    '## Raw transcription',
    raw.slice(0, MAX_RAW_CHARS),
  ].join('\n')
}

// Strip ANSI escapes / control chars from the raw PTY stream (same regexes as
// generateTaskTitle). OSC titles (]0;…BEL) are handled separately from CSI.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// Control chars EXCEPT \n (0x0a) — between the markers, newlines are content.
// eslint-disable-next-line no-control-regex
const CTRL_KEEP_LF_RE = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g

/** The LAST `OPENGROUND_VOICE: … ::OG_VOICE_END::` pair in the raw PTY
 *  output, cleaned, or null. Marker-pair-only — no prose fallback (the caller
 *  falls back to the raw transcription instead), and any candidate containing
 *  '<' is rejected: that's the prompt's own echoed placeholder, not a model
 *  answer. Newlines between the markers are PRESERVED (multi-line text); each
 *  line is trimmed, blank edge lines drop with the outer trim. Exported for
 *  unit tests. */
export const extractVoiceFormatted = (raw: string): string | null => {
  const text = raw.replace(OSC_RE, '').replace(ANSI_RE, '')
  let from = text.length
  for (;;) {
    const start = text.lastIndexOf(VOICE_MARKER, from - 1)
    if (start < 0) return null
    const end = text.indexOf(VOICE_END, start + VOICE_MARKER.length)
    if (end >= 0) {
      const candidate = text
        .slice(start + VOICE_MARKER.length, end)
        .replace(/\r/g, '')
        .replace(CTRL_KEEP_LF_RE, ' ')
        .split('\n')
        // Collapse horizontal whitespace runs (incl. spaces injected for
        // stripped control chars) within each line, keep the line structure.
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .trim()
      if (candidate && !candidate.includes('<')) return candidate
    }
    from = start
    if (from <= 0) return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface VoiceFormatOpts extends VoicePromptOpts {
  // Validated project path the one-off claude PTY runs in.
  cwd: string
  timeoutMs?: number
}

const runOnce = async (raw: string, opts: VoiceFormatOpts): Promise<string | null> => {
  // bypass: nobody is at the TTY, and the prompt forbids tools — text-only.
  const ref = launchClaude({
    cwd: opts.cwd,
    agentSessionId: newId(),
    initialPrompt: buildVoicePrompt(raw, opts),
    permissionMode: 'bypass',
    model: VOICE_MODEL,
    name: 'voice',
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
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      const formatted = extractVoiceFormatted(buffer)
      if (formatted) return formatted
      if (exited || sub?.info.finishedAt) break
    }
    // One last read — the marker may have landed between the poll and the exit.
    return extractVoiceFormatted(buffer)
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
  __openground_voice_format_chain?: Promise<unknown>
}

/** Clean up a raw voice transcription via a one-off haiku session in
 *  `opts.cwd`. NEVER throws and never blocks voice input: any failure or
 *  timeout resolves `{ text: raw, formatted: false }`. Concurrent calls run
 *  one at a time. */
export const formatTranscript = (
  raw: string,
  opts: VoiceFormatOpts,
): Promise<{ text: string; formatted: boolean }> => {
  const prev = g.__openground_voice_format_chain ?? Promise.resolve()
  const run = prev
    .catch(() => {})
    .then(() => runOnce(raw, opts))
    .then(
      (text) => (text ? { text, formatted: true } : { text: raw, formatted: false }),
      () => ({ text: raw, formatted: false }),
    )
  g.__openground_voice_format_chain = run.catch(() => {})
  return run
}
