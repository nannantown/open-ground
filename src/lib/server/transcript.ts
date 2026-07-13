import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { claudeDirName } from './claudeProjectDir'

// ---------------------------------------------------------------------------
// Past-transcript reader (the surviving slice of the old observer engine).
//
// Read a finished claude session's JSONL back from disk and page it into
// human-readable lines. The live observer (which tailed a growing JSONL and
// emitted SSE) is gone with the batch runner; this read-only counterpart stays
// because generateDescription.ts polls a side session's transcript for its
// `OPENGROUND_DESC:` marker.
//
// Facts about claude's session storage (verified 2026-05-27):
//   - Top-level interactive sessions write to
//     ~/.claude/projects/<canonical-cwd-with-/-.-space-as-dash>/<session-id>.jsonl
//   - macOS `/tmp` → `/private/tmp`: must realpath cwd before hyphenating.
//   - Subagent JSONLs live under <session-id>/subagents/ — ignored here.
// ---------------------------------------------------------------------------

const claudeProjectsRoot = () => join(homedir(), '.claude', 'projects')
const sessionDir = (cwd: string): string =>
  join(claudeProjectsRoot(), claudeDirName(cwd))
/** Where claude keeps THIS session's transcript — the one place that knowledge
 *  lives. Exported because swarmSessions.ts probes the same file to decide whether
 *  a persisted desk session is still `--resume`-able (a second derivation of the
 *  path would be free to drift from claude's actual storage layout). */
export const sessionJsonlPath = (cwd: string, sessionId: string): string =>
  join(sessionDir(cwd), `${sessionId}.jsonl`)

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

// Condense a tool_use input into one readable detail string.
const summarizeInput = (name: string, input: any): string => {
  if (!input || typeof input !== 'object') return ''
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return input.file_path
        ? String(input.file_path).split(/[/\\]/).slice(-2).join('/')
        : ''
    case 'Bash':
      return input.description
        ? String(input.description)
        : truncate(String(input.command ?? '').replace(/\s+/g, ' ').trim(), 80)
    case 'Glob':
    case 'Grep':
      return String(input.pattern ?? '')
    case 'Task':
      return String(input.description ?? '')
    default:
      return ''
  }
}

// Turn one session JSONL event into a human-readable line (newline-terminated),
// or null if it has nothing to show.
export const formatEvent = (obj: any): string | null => {
  switch (obj?.type) {
    case 'system':
      return obj.subtype === 'init'
        ? `▶ session started${obj.model ? ` · ${obj.model}` : ''}\n`
        : null
    case 'assistant': {
      const blocks = obj.message?.content
      if (!Array.isArray(blocks)) return null
      let out = ''
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out += b.text.replace(/\s+$/, '') + '\n'
        } else if (b?.type === 'tool_use') {
          const detail = summarizeInput(b.name, b.input)
          out += `🔧 ${b.name}${detail ? ` ${detail}` : ''}\n`
        }
      }
      return out || null
    }
    case 'user': {
      const blocks = obj.message?.content
      if (!Array.isArray(blocks)) return null
      let out = ''
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue
        let content: any = b.content
        if (Array.isArray(content)) {
          content = content
            .filter((c: any) => c?.type === 'text')
            .map((c: any) => c.text)
            .join(' ')
        }
        const text = truncate(String(content ?? '').replace(/\s+/g, ' ').trim(), 120)
        out += `   ↳ ${b.is_error ? 'error' : 'ok'}${text ? `: ${text}` : ''}\n`
      }
      return out || null
    }
    default:
      return null
  }
}

export interface TranscriptLine {
  /** 0-based index of this event in the full (non-blank) line sequence. */
  index: number
  /** The JSONL event's `type` (assistant / user / system / …), or 'unknown'. */
  type: string
  /** `formatEvent`-rendered human-readable text, or null when the event has
   *  nothing to show. */
  text: string | null
  /** True when JSON.parse failed — `text` then holds the raw line so callers
   *  can still surface CLI banners / stray output. */
  raw?: boolean
}

export interface TranscriptPage {
  sessionId: string
  /** Total non-blank JSONL events in the file (for end-of-list detection). */
  total: number
  offset: number
  limit: number
  lines: TranscriptLine[]
}

// Thrown when the JSONL file isn't on disk (never ran, pruned, etc.).
export class TranscriptNotFound extends Error {
  constructor(public readonly path: string) {
    super('transcript not found')
    this.name = 'TranscriptNotFound'
  }
}

export const readTranscript = async (
  cwd: string,
  sessionId: string,
  offset = 0,
  limit = 500,
): Promise<TranscriptPage> => {
  const path = sessionJsonlPath(cwd, sessionId)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    throw new TranscriptNotFound(path)
  }

  // Split on \n, drop blanks. Each surviving line is one event.
  const events = content.split('\n').filter((l) => l.trim().length > 0)
  const total = events.length

  const start = Math.max(0, offset)
  const end = Math.min(total, start + Math.max(0, limit))
  const lines: TranscriptLine[] = []
  for (let i = start; i < end; i++) {
    const trimmed = events[i].trim()
    let obj: any
    try {
      obj = JSON.parse(trimmed)
    } catch {
      // A non-JSON line is surfaced verbatim as raw log.
      lines.push({ index: i, type: 'raw', text: trimmed, raw: true })
      continue
    }
    lines.push({
      index: i,
      type: typeof obj?.type === 'string' ? obj.type : 'unknown',
      // formatEvent returns a newline-terminated string or null; trim the
      // trailing newline so the caller controls layout.
      text: formatEvent(obj)?.replace(/\n+$/, '') ?? null,
    })
  }

  return { sessionId, total, offset: start, limit, lines }
}
