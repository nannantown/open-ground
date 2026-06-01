import type { ParsedRunResult } from './types'

// Known keys in the OPENGROUND_RESULT payload. Used as anchors by the
// loose parser to delimit string values without depending on a
// successful JSON.parse.
const KNOWN_KEYS = [
  'completed',
  'skipped',
  'summary',
  'blockers',
  'taskComplete',
  'question',
  'decisions',
  'followups',
  'topic',
] as const

// Forgiving parser for the JSON-like payload that follows OPENGROUND_RESULT.
// Claude regularly forgets to escape inner quotes inside `summary` (e.g.
// writes `5つの "デザイン専門スキル"` verbatim), which breaks JSON.parse and
// used to leave the chat showing "出力がありません" despite a complete answer.
// This parser extracts each known field by anchoring on the surrounding keys
// in the raw JSON-ish string.
export const looseParse = (raw: string): ParsedRunResult | null => {
  const anchor = `(?:,\\s*"(?:${KNOWN_KEYS.join('|')})"\\s*:|}\\s*$)`
  const getString = (key: string): string => {
    const re = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*${anchor}`)
    const m = raw.match(re)
    return m ? m[1] : ''
  }
  const getStringArray = (key: string): string[] => {
    const re = new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]\\s*${anchor}`)
    const m = raw.match(re)
    if (!m) return []
    const body = m[1].trim()
    if (!body) return []
    return body
      .split(/"\s*,\s*"/)
      .map((s, i, arr) => {
        let out = s
        if (i === 0) out = out.replace(/^\s*"/, '')
        if (i === arr.length - 1) out = out.replace(/"\s*$/, '')
        return out
      })
      .filter((s) => s.length > 0)
  }
  const summary = getString('summary')
  const blockers = getString('blockers')
  const question = getString('question')
  const topic = getString('topic')
  const completed = getStringArray('completed')
  const skipped = getStringArray('skipped')
  const decisions = getStringArray('decisions')
  const followups = getStringArray('followups')
  const taskCompleteMatch = raw.match(/"taskComplete"\s*:\s*(true|false)/)
  const taskComplete = taskCompleteMatch
    ? taskCompleteMatch[1] === 'true'
    : undefined
  if (
    !summary &&
    !blockers &&
    !question &&
    !topic &&
    completed.length === 0 &&
    decisions.length === 0
  )
    return null
  return {
    completed,
    skipped,
    summary,
    blockers,
    decisions,
    followups,
    taskComplete,
    question: question.trim() ? question.trim() : undefined,
    topic: topic.trim() ? topic.trim() : undefined,
  }
}

// Extract the brace-balanced `{...}` object starting at/after `from`. String-
// aware (a `}` inside a JSON string value doesn't end the object) and newline-
// agnostic, so a pretty-printed multi-line OPENGROUND_RESULT is captured whole
// — the old single-line `\{.*\}` regex only grabbed the first line and then
// failed JSON.parse. If the braces never balance (truncated output) we return
// the tail from the opening `{` so looseParse can still salvage fields.
const extractBalancedObject = (s: string, from: number): string | null => {
  const start = s.indexOf('{', from)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return s.slice(start)
}

// Parse OPENGROUND_RESULT (or its legacy aliases) out of an entry log.
// Scans for the *last* marker that is followed by a JSON object so a run that
// emits multiple intermediate markers (or echoes the instruction without a
// payload) picks up the final real state. The object may span multiple lines.
// Falls through to the loose parser when JSON.parse fails — Claude's quote-
// escaping is notoriously unreliable on JSON it's hand-rolling inside an
// assistant message.
export const parseResult = (log: string): ParsedRunResult | null => {
  // Earlier runs emitted PMMAP_RESULT or HOVE_RESULT — accept all three so
  // archived sessions still parse. New prompts emit OPENGROUND_RESULT.
  const MARKER = /(?:OPENGROUND_RESULT|HOVE_RESULT|PMMAP_RESULT):/g
  const markerEnds: number[] = []
  let mm: RegExpExecArray | null
  while ((mm = MARKER.exec(log)) !== null) markerEnds.push(mm.index + mm[0].length)
  // Pick the last marker that is actually followed by `{` (skipping whitespace),
  // so an instruction mention with no payload doesn't shadow a real result.
  let chosen = -1
  for (let k = markerEnds.length - 1; k >= 0; k--) {
    if (/^\s*\{/.test(log.slice(markerEnds[k], markerEnds[k] + 64))) {
      chosen = markerEnds[k]
      break
    }
  }
  if (chosen < 0) return null
  const last = extractBalancedObject(log, chosen)
  if (!last) return null
  try {
    const obj = JSON.parse(last)
    return {
      completed: Array.isArray(obj.completed) ? obj.completed.map(String) : [],
      skipped: Array.isArray(obj.skipped) ? obj.skipped.map(String) : [],
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      blockers: typeof obj.blockers === 'string' ? obj.blockers : '',
      decisions: Array.isArray(obj.decisions) ? obj.decisions.map(String) : [],
      followups: Array.isArray(obj.followups) ? obj.followups.map(String) : [],
      taskComplete:
        typeof obj.taskComplete === 'boolean' ? obj.taskComplete : undefined,
      question:
        typeof obj.question === 'string' && obj.question.trim()
          ? obj.question.trim()
          : undefined,
      topic:
        typeof obj.topic === 'string' && obj.topic.trim()
          ? obj.topic.trim()
          : undefined,
    }
  } catch {
    return looseParse(last)
  }
}

// Pull only Claude's narrative — assistant `text` and `thinking` blocks —
// out of one stream-json event. Tool calls, tool results, system lines
// and the final result envelope are deliberately ignored: the live UI
// uses this to surface "what Claude is currently thinking" without the
// surrounding machinery.
export const extractThought = (obj: unknown): string | null => {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as { type?: unknown; message?: { content?: unknown } }
  if (o.type !== 'assistant') return null
  const blocks = o.message?.content
  if (!Array.isArray(blocks)) return null
  const parts: string[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const block = b as { type?: unknown; text?: unknown; thinking?: unknown }
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim())
    } else if (
      block.type === 'thinking' &&
      typeof block.thinking === 'string' &&
      block.thinking.trim()
    ) {
      parts.push(block.thinking.trim())
    }
  }
  if (parts.length === 0) return null
  return parts.join('\n\n')
}
