// generateProjectDescription — auto-write a project's one-liner description by
// briefly running the user's local `claude` CLI in the project and scraping a
// final `OPENGROUND_DESC:` marker out of the session transcript.
//
// SUBSCRIPTION-ONLY (read claudeTerminal.ts top comment): claude MUST run
// inside a real PTY so it bills the user's Claude subscription pool, NOT the
// programmatic credit pool. We therefore reuse launchClaude() (which runs
// `claude "<prompt>"` interactively in a node-pty, never `claude -p`). Plain
// `claude -p` / execFile('claude', ...) for generation is FORBIDDEN here.
//
// COMPLETION = the marker, NOT PTY exit. Interactive claude does NOT quit after
// answering — it sits at the prompt waiting for the next turn, so the launch
// command's trailing `; exit` never fires on its own (waiting for it just hits
// the timeout). We therefore POLL the session JSONL for the final
// `OPENGROUND_DESC:` line and tear the PTY down the moment we have it. This is
// a one-off side session — it never surfaces in the UI as a terminal.

import { newId } from '@/lib/ids'
import { launchClaude } from './claudeTerminal'
import { killTerminal, subscribeTerminal } from './terminal'
import { readTranscript } from './transcript'

// Language-tagged markers — the description is generated in BOTH languages in
// one run and stored side by side; the UI then shows the one matching the
// user's language setting. The legacy single marker is still parsed as a
// fallback (old transcripts / a model that ignores the dual format).
export const DESC_MARKER = 'OPENGROUND_DESC:'
export const DESC_MARKER_EN = 'OPENGROUND_DESC_EN:'
export const DESC_MARKER_JA = 'OPENGROUND_DESC_JA:'

// Read-only exploration prompt. Strict: no edits, no file writes, never touch
// .openground/, and end with exactly two marker lines (English + Japanese).
// One universal prompt — both languages are always produced regardless of the
// UI language, so switching the setting later needs no regeneration.
export const buildDescribePrompt = async (): Promise<string> =>
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
    `${DESC_MARKER_EN} <1-2 sentences in English, concisely describing what the project is>`,
    `${DESC_MARKER_JA} <日本語で1〜2文、プロジェクトが何かを簡潔に>`,
    '- Put only the description text after each marker; no JSON, no quotes.',
    '- Keep each description short (at most 2 sentences).',
  ].join('\n')

// Strip ANSI escape sequences and stray control chars that can leak into a
// transcript line (the JSONL text is usually clean, but be defensive).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
const stripNoise = (s: string): string =>
  s.replace(ANSI_RE, '').replace(CTRL_RE, '').trim()

const MAX_DESC_LEN = 300

// Marker-only: the LAST `<marker>` line's trailing text, or null. NO fallback —
// used while polling a still-running session so we never grab claude's
// mid-exploration prose before it prints the final marker lines. NOTE the
// language-tagged markers do NOT contain the legacy `OPENGROUND_DESC:` as a
// substring (underscore vs colon), so each lookup is unambiguous.
export const extractMarker = (
  transcript: string,
  marker: string = DESC_MARKER,
): string | null => {
  const lines = transcript.replace(ANSI_RE, '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(marker)
    if (idx >= 0) {
      const after = stripNoise(lines[i].slice(idx + marker.length))
      if (after) return after.slice(0, MAX_DESC_LEN)
    }
  }
  return null
}

/** Both language markers (null where absent). */
export const extractMarkerPair = (
  transcript: string,
): { en: string | null; ja: string | null } => ({
  en: extractMarker(transcript, DESC_MARKER_EN),
  ja: extractMarker(transcript, DESC_MARKER_JA),
})

// Pull the description out of a finished transcript. Marker line wins; falls
// back to the last non-empty assistant line (capped). Returns null when nothing
// usable is present. Exported for unit testing.
export const extractDescription = (transcript: string): string | null => {
  const marker = extractMarker(transcript)
  if (marker) return marker
  // Fallback — last non-empty line, skipping any bare/empty marker token.
  const lines = transcript.replace(ANSI_RE, '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(DESC_MARKER)) continue
    const t = stripNoise(lines[i])
    if (t) return t.slice(0, MAX_DESC_LEN)
  }
  return null
}

const DEFAULT_TIMEOUT_MS = 120_000
const POLL_MS = 1_500

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Read the session transcript text; '' if it isn't readable yet (the JSONL may
// not exist on the first poll, or a partial trailing line fails to parse).
const readTranscriptText = async (cwd: string, sessionId: string): Promise<string> => {
  try {
    const page = await readTranscript(cwd, sessionId, 0, 5000)
    return page.lines
      .map((l) => l.text ?? '')
      .filter((t) => t.length > 0)
      .join('\n')
  } catch {
    return ''
  }
}

export interface GeneratedDescriptions {
  en: string | null
  ja: string | null
}

export const generateProjectDescription = async (
  projectPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<GeneratedDescriptions> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Fresh UUID — the resulting JSONL is named after it so we can read the
  // transcript back deterministically.
  const agentSessionId = newId()

  // bypass (= --dangerously-skip-permissions): no human is at the TTY to approve
  // tool use, and the prompt forbids any mutation, so read-only exploration runs
  // unattended.
  const ref = launchClaude({
    cwd: projectPath,
    agentSessionId,
    initialPrompt: await buildDescribePrompt(),
    permissionMode: 'bypass',
    name: 'describe',
    // Marker-scraped utility session: keep its system prompt pristine so the
    // OPENGROUND_DESC output contract can't drift toward "add a board card".
    appContext: false,
  })

  // Poll the JSONL for the marker. Stop early if the session exits on its own
  // (user /quit or a crash), then do a best-effort fallback extraction.
  let exited = false
  const sub = subscribeTerminal(
    ref.terminalId,
    () => {},
    () => {
      exited = true
    },
  )
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      const pair = extractMarkerPair(await readTranscriptText(projectPath, agentSessionId))
      // Complete only when BOTH languages landed — the two lines arrive
      // together at the very end, so a one-sided read is just mid-stream.
      if (pair.en && pair.ja) return pair
      if (exited || sub?.info.finishedAt) break
    }
    // Timed out, or the session ended early — take whatever DID land: one
    // language alone, the legacy single marker, or the last non-empty line.
    const transcript = await readTranscriptText(projectPath, agentSessionId)
    const pair = extractMarkerPair(transcript)
    if (pair.en || pair.ja) return pair
    const legacy = extractDescription(transcript)
    if (legacy) {
      // Single untagged text — file it under the language it LOOKS like, so a
      // Japanese fallback never becomes the "English" description.
      return /[぀-ヿ一-鿿]/.test(legacy) ? { en: null, ja: legacy } : { en: legacy, ja: null }
    }
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
