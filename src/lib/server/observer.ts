import {
  statSync,
  openSync,
  readSync,
  closeSync,
  watch,
} from 'fs'
import type { FSWatcher } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type { CanvasContext, CanvasElement, RunEntry, RunSession } from '../types'
import {
  appendAction,
  appendLog,
  appendThought,
  emit,
  extractActions,
  extractThought,
  formatEvent,
  parseResult,
} from './runner'
import { appendCanvasElement, updateCanvasElement } from './canvasData'
import { extractMarkerObjects } from './canvasMarkers'
import { claudeDirName } from './claudeProjectDir'

// ---------------------------------------------------------------------------
// Phase 0 facts (verified 2026-05-27):
//   - Top-level interactive sessions write to
//     ~/.claude/projects/<canonical-cwd-with-/.-space-as-dash>/<session-id>.jsonl
//   - macOS `/tmp` → `/private/tmp`: must realpath cwd before hyphenating.
//   - Spaces in cwd are also hyphenated, in addition to `/` and `.`.
//   - Subagent JSONLs live under <session-id>/subagents/agent-<id>.jsonl —
//     ignore those, they're written by Claude's Task tool, not the top-level
//     session we're observing.
//   - Stop hook stdin contains transcript_path (absolute), session_id, cwd,
//     last_assistant_message. Future: use the hook's last_assistant_message
//     to short-circuit OPENGROUND_RESULT detection without re-parsing JSONL.
//   - Interactive JSONL does NOT emit `result` events — only `assistant`,
//     `user`, `system`, `mode`, `permission-mode`, `file-history-snapshot`,
//     `ai-title`, `last-prompt`, `attachment`.
// ---------------------------------------------------------------------------

// Mirror of the (canonical) directory naming Claude Code uses when persisting
// session JSONLs. Lives in claudeProjectDir.ts (shared with runner.ts) so the
// POSIX/Windows hyphenation scheme is defined in exactly one place. Re-exported
// here under the original name to preserve this module's import surface.
export const toDirName = claudeDirName

const claudeProjectsRoot = () => join(homedir(), '.claude', 'projects')
export const sessionDir = (cwd: string): string =>
  join(claudeProjectsRoot(), toDirName(cwd))
export const sessionJsonlPath = (cwd: string, sessionId: string): string =>
  join(sessionDir(cwd), `${sessionId}.jsonl`)

// ---------------------------------------------------------------------------
// Phase 4 — past-transcript reader.
//
// Read a finished session's Claude JSONL back from disk and page it into
// human-readable lines for the "過去ログを見る" view. This is the read-only
// counterpart to the live observer above: instead of tailing a growing file
// and emitting SSE, it slurps the whole file once, slices [offset, offset+
// limit) NON-BLANK JSONL events, and renders each through the SAME
// `formatEvent` the live path uses — so a re-opened transcript reads exactly
// like the chat did while it ran (no raw JSONL leaking to the UI).
//
// Paging is by *event* (one JSONL line = one event), not byte. `total` is the
// count of non-blank lines so the client can tell when it's reached the end.
// ---------------------------------------------------------------------------

export interface TranscriptLine {
  /** 0-based index of this event in the full (non-blank) line sequence. */
  index: number
  /** The JSONL event's `type` (assistant / user / system / …), or 'unknown'. */
  type: string
  /** `formatEvent`-rendered human-readable text, or null when the event has
   *  nothing to show (matching the live observer, which skips such events). */
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

// Thrown when the JSONL file isn't on disk (worktree pruned, never ran, etc.).
// The route maps this to a 404 instead of a 500.
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

  // Same line model as the live drain: split on \n, drop blanks. Each
  // surviving line is one event.
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
      // Mirror handleLine: a non-JSON line is surfaced verbatim as raw log.
      lines.push({ index: i, type: 'raw', text: trimmed, raw: true })
      continue
    }
    lines.push({
      index: i,
      type: typeof obj?.type === 'string' ? obj.type : 'unknown',
      // formatEvent returns a newline-terminated string or null; trim the
      // trailing newline so the client controls layout.
      text: formatEvent(obj)?.replace(/\n+$/, '') ?? null,
    })
  }

  return { sessionId, total, offset: start, limit, lines }
}

export interface AttachOpts {
  agentSessionId: string
  session: RunSession
  entry: RunEntry
  // The cwd where claude was launched. For worktree runs this is the
  // worktree path (which is the path Claude hyphenates and persists under).
  effectiveCwd: string
  // Fires once when OPENGROUND_RESULT.taskComplete=true is observed in the
  // entry's log. Phase 4 wires this to the worktree mergeOnComplete pipeline.
  onComplete?: (entry: RunEntry) => void
  // Conflict-resolve runs use this to short-circuit the "fresh task" merge
  // path and re-attempt the parent run's merge instead. Phase 6 reads it.
  mode?: 'fresh' | 'conflict-resolve'
  // When set (Canvas chat runs only), the observer scans Claude's output
  // for `CANVAS_ADD:` marker lines and writes each one as a new element
  // into the given Canvas. Absent for Chats-tab runs — the marker, if it
  // somehow appears, is ignored.
  canvasContext?: CanvasContext
  // Project root path — needed alongside canvasContext to locate the
  // canvas file (.openground/canvases/<id>.json lives under the project).
  projectPath?: string
}

interface ObserverEntry {
  agentSessionId: string
  session: RunSession
  entry: RunEntry
  effectiveCwd: string
  jsonlPath: string
  dirKey: string
  // Tail state
  fd: number | null
  fileOffset: number
  partialLine: string
  // Has onComplete already fired? Latches so we don't re-trigger after
  // continuing turns that contain another OPENGROUND_RESULT.
  completed: boolean
  onComplete?: (entry: RunEntry) => void
  mode: 'fresh' | 'conflict-resolve'
  canvasContext?: CanvasContext
  projectPath?: string
  // De-dup for CANVAS_ADD / CANVAS_UPDATE markers — Claude may emit the same
  // line across assistant turns (especially on resume). Stamp signatures so we
  // apply each marker at most once per session.
  canvasAddSeen: Set<string>
}

interface ObserverState {
  byAgentId: Map<string, ObserverEntry>
  dirWatchers: Map<string, { watcher: FSWatcher; refs: number }>
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_observer: ObserverState | undefined
}

const state: ObserverState =
  globalThis.__openground_observer ??
  (globalThis.__openground_observer = {
    byAgentId: new Map(),
    dirWatchers: new Map(),
  })

const { byAgentId, dirWatchers } = state

// Belt-and-suspenders periodic drain. drain(oe) is normally triggered by
// the directory fs.watch event, the Stop hook's nudge POST, or PTY exit.
// All three can fail in concert: macOS FSEvents coalesces bursts and can
// silently drop the final write of a session; the hook's nudge can be
// dropped (500ms timeout / stale port file / server busy); PTY exit only
// fires after onComplete, which itself depends on a successful drain. The
// triple-failure ends with a chat stuck on "RUNNING" forever despite the
// JSONL containing OPENGROUND_RESULT. A 2s active-entry sweep guarantees
// the final write surfaces within ~2s even when every event channel drops
// it. drain is cheap (statSync + delta readSync) and no-ops when the file
// hasn't grown.
declare global {
  // eslint-disable-next-line no-var
  var __openground_observer_poll: ReturnType<typeof setInterval> | undefined
}
const OBSERVER_POLL_INTERVAL_MS = 2_000
const pollAllEntries = (): void => {
  for (const oe of Array.from(byAgentId.values())) {
    try { drain(oe) } catch {}
  }
}
if (globalThis.__openground_observer_poll) {
  clearInterval(globalThis.__openground_observer_poll)
}
globalThis.__openground_observer_poll = setInterval(
  () => { try { pollAllEntries() } catch {} },
  OBSERVER_POLL_INTERVAL_MS,
)

// Try to open and watch a directory. Silently no-ops if the dir doesn't
// exist yet — the caller re-attempts on the next nudge / poll, by which time
// claude has usually finished creating it.
const acquireDirWatcher = (dir: string, onEvent: () => void): void => {
  const existing = dirWatchers.get(dir)
  if (existing) {
    existing.refs += 1
    return
  }
  try {
    const watcher = watch(dir, { persistent: false }, () => onEvent())
    dirWatchers.set(dir, { watcher, refs: 1 })
  } catch {
    // Dir not present — observer will fall back to nudge / poll-on-stat.
  }
}

const releaseDirWatcher = (dir: string): void => {
  const w = dirWatchers.get(dir)
  if (!w) return
  w.refs -= 1
  if (w.refs <= 0) {
    try { w.watcher.close() } catch {}
    dirWatchers.delete(dir)
  }
}

const handleLine = (oe: ObserverEntry, line: string): void => {
  const trimmed = line.trim()
  if (!trimmed) return
  let obj: any
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // Non-JSON line — surface it as raw log so the user can see CLI banners
    // and any stray text that snuck in.
    appendLog(oe.session, oe.entry, trimmed + '\n')
    return
  }
  const thought = extractThought(obj)
  if (thought) appendThought(oe.session, oe.entry, thought)
  for (const action of extractActions(obj)) {
    appendAction(oe.session, oe.entry, action)
  }
  const formatted = formatEvent(obj)
  if (formatted) appendLog(oe.session, oe.entry, formatted)

  // Gate the OPENGROUND_RESULT scan on the chunk we just appended: parseResult
  // scans the full log (split + regex), so calling it per JSONL line is
  // O(n²) over the run AND fires emit('entry') on every assistant text /
  // tool_use after the first result line (the result stays in the log and
  // parseResult keeps returning it). We only need to re-parse when this
  // chunk could change the answer.
  if (!oe.completed && formatted && /OPENGROUND_RESULT:/.test(formatted)) {
    const parsed = parseResult(oe.entry.log)
    if (parsed) {
      oe.entry.parsedResult = parsed
      emit(oe.session.id, { type: 'entry', entry: oe.entry })
      if (parsed.taskComplete === true) {
        oe.completed = true
        try { oe.onComplete?.(oe.entry) } catch {}
      }
    }
  }

  // Canvas chat side-channel: Claude can ask OPEN GROUND to add an
  // element to the current Canvas by emitting a `CANVAS_ADD: {...}`
  // line. Only fires when this run carries canvasContext (i.e. it was
  // started from a Canvas chat); regular Chats-tab runs ignore the
  // marker entirely. The actual write goes through canvasData so the
  // CLAUDE.md "don't touch .openground/" rule stays intact — Claude
  // never writes the file, OPEN GROUND does on its behalf.
  if (oe.canvasContext && oe.projectPath && formatted) {
    if (/CANVAS_ADD:/.test(formatted)) handleCanvasAdd(oe, formatted)
    if (/CANVAS_UPDATE:/.test(formatted)) handleCanvasUpdate(oe, formatted)
  }
}

// Compact, label-scoped dedup signature for a marker body. Keying on a hash
// (not the multi-KB raw body) bounds memory for screen-source markers, and
// prefixing the label keeps a byte-identical ADD and UPDATE distinct.
const markerSig = (label: string, raw: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return `${label}:${(h >>> 0).toString(16)}`
}

// Surface a Canvas-marker failure to the user: log it into the run AND emit a
// transient toast event so it doesn't die silently in the log.
const canvasError = (oe: ObserverEntry, message: string): void => {
  appendLog(oe.session, oe.entry, `[canvas] ${message}\n`)
  emit(oe.session.id, {
    type: 'canvas-error',
    projectPath: oe.projectPath!,
    canvasId: oe.canvasContext!.canvasId,
    message,
  })
}

// Cap on a single element's text/source so a runaway (or prompt-injected)
// CANVAS_ADD can't bloat canvases/<id>.json unboundedly. Generous enough for
// real mock/screen source (a 256KB component is already enormous).
const MAX_ELEMENT_TEXT = 256 * 1024

// One CANVAS_ADD marker line → one element appended to the active Canvas.
// Errors are best-effort logged into the entry's log so the user can see
// why a request didn't land (bad JSON, missing fields, etc.).
const handleCanvasAdd = (oe: ObserverEntry, chunk: string): void => {
  // A single chunk can contain multiple markers; each JSON object is brace-
  // balanced so it may span multiple lines.
  for (const raw of extractMarkerObjects(chunk, 'CANVAS_ADD:')) {
    const sig = markerSig('add', raw)
    if (oe.canvasAddSeen.has(sig)) continue
    oe.canvasAddSeen.add(sig)
    let parsed: any
    try { parsed = JSON.parse(raw) } catch {
      canvasError(oe, 'CANVAS_ADD: invalid JSON — skipped')
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    if (!['text', 'sticky', 'frame', 'mock', 'comment', 'image', 'screen', 'shape'].includes(parsed.type)) {
      canvasError(oe, `CANVAS_ADD: unsupported type "${parsed.type}" — skipped`)
      continue
    }
    // Image elements via CANVAS_ADD require an already-uploaded assetId —
    // Claude can't upload bytes through this channel, so it can only
    // reference assets that already live in <canvasId>-assets/. Skip silently
    // (with a log line) if Claude tries to add an image with no/invalid asset.
    if (parsed.type === 'image') {
      if (typeof parsed.assetId !== 'string' || !parsed.assetId) {
        canvasError(oe, 'CANVAS_ADD: image without assetId — skipped')
        continue
      }
    }
    // Screen elements now render their `text` source live in a sandboxed
    // iframe (no on-disk module), so a screen just needs source — exactly like
    // a mock. `moduleId` is legacy/optional; if Claude does send one, keep the
    // kebab-case guard so a stray value can't leak into the (legacy) path.
    if (parsed.type === 'screen') {
      if (
        parsed.moduleId != null &&
        (typeof parsed.moduleId !== 'string' ||
          !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.moduleId))
      ) {
        canvasError(oe, 'CANVAS_ADD: screen moduleId must be kebab-case — skipped')
        continue
      }
    }
    // Clamp oversized text/source rather than persisting it whole.
    let text = typeof parsed.text === 'string' ? parsed.text : ''
    if (text.length > MAX_ELEMENT_TEXT) {
      canvasError(
        oe,
        `CANVAS_ADD: text truncated (${text.length} > ${MAX_ELEMENT_TEXT} chars)`,
      )
      text = text.slice(0, MAX_ELEMENT_TEXT)
    }
    const element: CanvasElement = {
      id: typeof parsed.id === 'string' && parsed.id ? parsed.id : `add-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: parsed.type,
      x: Number.isFinite(parsed.x) ? parsed.x : 80,
      y: Number.isFinite(parsed.y) ? parsed.y : 80,
      text,
      ...(Number.isFinite(parsed.width) ? { width: parsed.width } : {}),
      ...(Number.isFinite(parsed.height) ? { height: parsed.height } : {}),
      ...(typeof parsed.color === 'string' ? { color: parsed.color } : {}),
      ...(parsed.type === 'shape' &&
      (parsed.shapeKind === 'rect' || parsed.shapeKind === 'ellipse')
        ? { shapeKind: parsed.shapeKind }
        : {}),
      ...((parsed.type === 'mock' || parsed.type === 'screen') &&
      (parsed.framework === 'react' || parsed.framework === 'html')
        ? { framework: parsed.framework }
        : {}),
      ...((parsed.type === 'mock' || parsed.type === 'screen') &&
      ['light', 'dark', 'auto'].includes(parsed.theme)
        ? { theme: parsed.theme }
        : {}),
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.anchorId === 'string' ? { anchorId: parsed.anchorId } : {}),
      ...(parsed.type === 'image' && typeof parsed.assetId === 'string'
        ? { assetId: parsed.assetId }
        : {}),
      ...(parsed.type === 'image' && typeof parsed.filename === 'string'
        ? { filename: parsed.filename }
        : {}),
      ...(parsed.type === 'image' && typeof parsed.alt === 'string'
        ? { alt: parsed.alt }
        : {}),
      ...(parsed.type === 'image' && Number.isFinite(parsed.naturalWidth)
        ? { naturalWidth: parsed.naturalWidth }
        : {}),
      ...(parsed.type === 'image' && Number.isFinite(parsed.naturalHeight)
        ? { naturalHeight: parsed.naturalHeight }
        : {}),
      ...(parsed.type === 'screen' && typeof parsed.moduleId === 'string'
        ? { moduleId: parsed.moduleId }
        : {}),
      ...(parsed.type === 'screen' && typeof parsed.label === 'string'
        ? { label: parsed.label }
        : {}),
      ...(parsed.type === 'screen' &&
      ['none', 'browser', 'phone'].includes(parsed.chrome)
        ? { chrome: parsed.chrome }
        : {}),
      ...(parsed.type === 'screen' && parsed.scrollable === true
        ? { scrollable: true }
        : {}),
      ...(parsed.type === 'screen' &&
      parsed.props &&
      typeof parsed.props === 'object' &&
      !Array.isArray(parsed.props)
        ? { props: parsed.props as Record<string, unknown> }
        : {}),
    }
    // Fire-and-forget write; we don't want to block JSONL drain on disk IO.
    appendCanvasElement(oe.projectPath!, oe.canvasContext!.canvasId, element)
      .then((after) => {
        if (after) {
          appendLog(
            oe.session,
            oe.entry,
            `[canvas] +1 ${element.type}${element.name ? ` "${element.name}"` : ''}\n`,
          )
          // Tell the client the canvas file just grew so it can re-fetch.
          // Without this the new element only shows up after a manual reload
          // — the client never sees the disk write otherwise.
          emit(oe.session.id, {
            type: 'canvas-add',
            projectPath: oe.projectPath!,
            canvasId: oe.canvasContext!.canvasId,
          })
        } else {
          appendLog(oe.session, oe.entry, `[canvas] CANVAS_ADD: canvas ${oe.canvasContext!.canvasId} not found — skipped\n`)
        }
      })
      .catch((e) => {
        canvasError(oe, `CANVAS_ADD write failed: ${e?.message ?? e}`)
      })
  }
}

// `CANVAS_UPDATE: {"id":"…", …}` → patch an existing element in place. Lets
// Claude iterate on an element it (or the user) already created — e.g. rewrite
// a screen's source — instead of stacking a duplicate.
const handleCanvasUpdate = (oe: ObserverEntry, chunk: string): void => {
  for (const raw of extractMarkerObjects(chunk, 'CANVAS_UPDATE:')) {
    const sig = markerSig('update', raw)
    if (oe.canvasAddSeen.has(sig)) continue
    oe.canvasAddSeen.add(sig)
    let parsed: any
    try { parsed = JSON.parse(raw) } catch {
      canvasError(oe, 'CANVAS_UPDATE: invalid JSON — skipped')
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    if (typeof parsed.id !== 'string' || !parsed.id) {
      canvasError(oe, 'CANVAS_UPDATE: missing element id — skipped')
      continue
    }
    // Whitelist the patchable fields (id / type are immutable, enforced in
    // updateCanvasElement). Only the keys present in the marker are changed.
    const patch: Partial<CanvasElement> = {
      ...(typeof parsed.text === 'string' ? { text: parsed.text } : {}),
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.label === 'string' ? { label: parsed.label } : {}),
      ...(typeof parsed.color === 'string' ? { color: parsed.color } : {}),
      ...(Number.isFinite(parsed.x) ? { x: parsed.x } : {}),
      ...(Number.isFinite(parsed.y) ? { y: parsed.y } : {}),
      ...(Number.isFinite(parsed.width) ? { width: parsed.width } : {}),
      ...(Number.isFinite(parsed.height) ? { height: parsed.height } : {}),
      ...(parsed.shapeKind === 'rect' || parsed.shapeKind === 'ellipse'
        ? { shapeKind: parsed.shapeKind }
        : {}),
      ...(parsed.framework === 'react' || parsed.framework === 'html'
        ? { framework: parsed.framework }
        : {}),
      ...(['light', 'dark', 'auto'].includes(parsed.theme) ? { theme: parsed.theme } : {}),
      ...(['none', 'browser', 'phone'].includes(parsed.chrome) ? { chrome: parsed.chrome } : {}),
      ...(typeof parsed.scrollable === 'boolean' ? { scrollable: parsed.scrollable } : {}),
      ...(typeof parsed.resolved === 'boolean' ? { resolved: parsed.resolved } : {}),
      ...(parsed.props && typeof parsed.props === 'object' && !Array.isArray(parsed.props)
        ? { props: parsed.props as Record<string, unknown> }
        : {}),
    }
    if (Object.keys(patch).length === 0) {
      canvasError(oe, `CANVAS_UPDATE: ${parsed.id} had no updatable fields — skipped`)
      continue
    }
    updateCanvasElement(oe.projectPath!, oe.canvasContext!.canvasId, parsed.id, patch)
      .then((after) => {
        if (after) {
          appendLog(oe.session, oe.entry, `[canvas] ~1 ${parsed.id}\n`)
          emit(oe.session.id, {
            type: 'canvas-add',
            projectPath: oe.projectPath!,
            canvasId: oe.canvasContext!.canvasId,
          })
        } else {
          canvasError(oe, `CANVAS_UPDATE: element ${parsed.id} not found — skipped`)
        }
      })
      .catch((e) => {
        canvasError(oe, `CANVAS_UPDATE write failed: ${e?.message ?? e}`)
      })
  }
}

const drain = (oe: ObserverEntry): void => {
  try {
    const st = statSync(oe.jsonlPath)
    if (st.size <= oe.fileOffset) return
    if (oe.fd === null) {
      oe.fd = openSync(oe.jsonlPath, 'r')
    }
    const len = st.size - oe.fileOffset
    const buf = Buffer.alloc(len)
    readSync(oe.fd, buf, 0, len, oe.fileOffset)
    oe.fileOffset = st.size
    oe.partialLine += buf.toString('utf8')
    const lines = oe.partialLine.split('\n')
    oe.partialLine = lines.pop() ?? ''
    for (const line of lines) handleLine(oe, line)
  } catch {
    // File doesn't exist yet, or a transient read error. The watcher will
    // re-fire on the next directory event.
  }
}

const drainDir = (dir: string): void => {
  for (const oe of Array.from(byAgentId.values())) {
    if (oe.dirKey !== dir) continue
    drain(oe)
  }
}

export const attach = (opts: AttachOpts): (() => void) => {
  const dir = sessionDir(opts.effectiveCwd)
  const jsonlPath = sessionJsonlPath(opts.effectiveCwd, opts.agentSessionId)

  // Skip past any existing JSONL content on attach. For a fresh run the
  // file doesn't exist yet (offset stays 0). For a resume (claude --resume
  // appends to the same JSONL), the file already holds the prior turns'
  // events INCLUDING the previous OPENGROUND_RESULT — re-processing those
  // would fire `onComplete` immediately, racing the new prompt's auto-/quit
  // against claude's actual work. Starting from the end means we only
  // observe the events written by this run.
  let initialOffset = 0
  try {
    initialOffset = statSync(jsonlPath).size
  } catch {}

  const oe: ObserverEntry = {
    agentSessionId: opts.agentSessionId,
    session: opts.session,
    entry: opts.entry,
    effectiveCwd: opts.effectiveCwd,
    jsonlPath,
    dirKey: dir,
    fd: null,
    fileOffset: initialOffset,
    partialLine: '',
    completed: false,
    onComplete: opts.onComplete,
    mode: opts.mode ?? 'fresh',
    canvasContext: opts.canvasContext,
    projectPath: opts.projectPath,
    canvasAddSeen: new Set<string>(),
  }
  byAgentId.set(opts.agentSessionId, oe)
  acquireDirWatcher(dir, () => drainDir(dir))
  // Immediate drain in case anything was written between our statSync and
  // the watcher being registered (tiny but non-zero window).
  drain(oe)
  return () => detach(opts.agentSessionId)
}

export const detach = (agentSessionId: string): void => {
  const oe = byAgentId.get(agentSessionId)
  if (!oe) return
  byAgentId.delete(agentSessionId)
  if (oe.fd !== null) {
    try { closeSync(oe.fd) } catch {}
    oe.fd = null
  }
  releaseDirWatcher(oe.dirKey)
}

// Stop-hook fast path: a Stop hook can POST to an internal endpoint that
// calls nudge() with the freshly-completed session_id, telling the observer
// to drain the JSONL right now (don't wait for the macOS fs.watch coalesced
// event). Safe to call when no observer entry exists — no-ops.
export const nudge = (agentSessionId: string): void => {
  const oe = byAgentId.get(agentSessionId)
  if (!oe) return
  drain(oe)
}

// Diagnostics / tests.
export const getAttached = (agentSessionId: string): boolean =>
  byAgentId.has(agentSessionId)
