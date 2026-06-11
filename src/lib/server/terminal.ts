import { randomUUID } from 'crypto'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { detectMenu } from '@/lib/claudeMenu'
import type { ActiveTerminalsResponse, ClaudeBeaconStatus } from '@/lib/types'
// node-pty is a native module — require it lazily so a missing/broken build
// doesn't crash the whole route layer on import (it'll surface on first use).
type IPty = any
let ptyMod: any = null
const loadPty = () => {
  if (!ptyMod) ptyMod = require('node-pty')
  return ptyMod
}

// Debounce (ms) after the last PTY write before we read the headless screen for
// a menu — long enough that we test a SETTLED frame (claude repaints constantly
// while working, but the screen is stable while waiting on a prompt).
const MENU_DETECT_DEBOUNCE_MS = 350

// A claude PTY that hasn't emitted output for this long is considered to be
// waiting on the human (its TUI spinner repaints continuously while working).
export const WORKING_SILENCE_MS = 3000

export interface TerminalInfo {
  id: string
  cwd: string
  shell: string
  cols: number
  rows: number
  startedAt: string
  finishedAt?: string
  exitCode?: number
  // Marks PTYs that host a `claude` interactive session (vs. a free user
  // shell) so callers can route observer wiring, UI affordances, and buffer
  // sizing differently. Defaults to 'shell'.
  tag?: 'shell' | 'claude'
  // For tag:'claude' PTYs — the `--session-id` UUID claude was launched with,
  // so the client can locate the session JSONL (~/.claude/projects/<cwd>/<uuid>.jsonl)
  // and render its transcript. Persisted on the PTY so a page reload can
  // reattach both the raw and the rendered view to the same session.
  agentSessionId?: string
  // Epoch ms of the last PTY output chunk — feeds the working/waiting beacon
  // (claude repaints continuously while thinking/editing, goes silent when
  // waiting on the human).
  lastOutputAt?: number
  // For tag:'claude' PTYs — true while an interactive TUI menu (permission
  // prompt etc.) is detected on the settled headless screen. A menu means
  // claude is blocked on the human even if it just painted output.
  menuOpen?: boolean
}

type Listener = (chunk: string) => void

interface PtySession {
  info: TerminalInfo
  pty: IPty
  // Ring-buffer of recent output so a fresh subscriber (page reload, panel
  // re-mount) can repaint the screen instead of seeing a blank terminal.
  buffer: string
  listeners: Set<Listener>
  exitListeners: Set<(info: TerminalInfo) => void>
  // For tag:'claude' sessions: a headless xterm that reconstructs the screen so
  // we can detect interactive TUI menus (permission prompts etc.) the output
  // stream alone can't reveal (it's cursor-addressed repaints). null for plain
  // shells. Absent (undefined) on fake test sessions — treat as null.
  headless?: HeadlessTerminal | null
  menuTimer?: ReturnType<typeof setTimeout> | null
}

// Read the headless terminal's visible screen as plain text rows.
const readScreen = (term: HeadlessTerminal): string => {
  const buf = term.buffer.active
  const rows: string[] = []
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.baseY + y)
    rows.push(line ? line.translateToString(true) : '')
  }
  return rows.join('\n')
}

// Debounced menu detection: runs MENU_DETECT_DEBOUNCE_MS after the last write,
// so we read a settled frame, and stamps the result on info.menuOpen.
const scheduleMenuDetect = (s: PtySession): void => {
  if (!s.headless) return
  if (s.menuTimer) clearTimeout(s.menuTimer)
  s.menuTimer = setTimeout(() => {
    s.menuTimer = null
    try {
      s.info.menuOpen = detectMenu(readScreen(s.headless!)) !== null
    } catch {}
  }, MENU_DETECT_DEBOUNCE_MS)
}

interface TerminalState {
  sessions: Map<string, PtySession>
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_terminal: TerminalState | undefined
}

const state: TerminalState =
  globalThis.__openground_terminal ??
  (globalThis.__openground_terminal = { sessions: new Map() })

const { sessions } = state

// Keep the replay buffer bounded so a long-running shell can't blow up memory.
// Claude sessions can be hours long and emit a lot more output than a typical
// shell — give them 10x the headroom.
const MAX_BUFFER_BYTES_SHELL = 200_000
const MAX_BUFFER_BYTES_CLAUDE = 2_000_000

const appendBuffer = (s: PtySession, chunk: string) => {
  s.buffer += chunk
  const limit = s.info.tag === 'claude' ? MAX_BUFFER_BYTES_CLAUDE : MAX_BUFFER_BYTES_SHELL
  if (s.buffer.length > limit) {
    s.buffer = s.buffer.slice(s.buffer.length - limit)
  }
}

const pickShell = (): string => {
  return (
    process.env.OPENGROUND_TERMINAL_SHELL ||
    process.env.SHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
  )
}

export const createTerminal = (opts: {
  cwd: string
  cols?: number
  rows?: number
  shell?: string
  tag?: 'shell' | 'claude'
  agentSessionId?: string
}): TerminalInfo => {
  const pty = loadPty()
  const id = randomUUID()
  const shell = opts.shell ?? pickShell()
  const cols = Math.max(20, Math.min(500, opts.cols ?? 100))
  const rows = Math.max(5, Math.min(200, opts.rows ?? 30))
  // -l so PATH (nvm, ~/.local/bin etc.) is set up the same way the user's
  // login shell would set it — matters because OPEN GROUND may have been
  // launched from Finder where the shell otherwise wouldn't run the login profile.
  const args = process.platform === 'win32' ? [] : ['-l']
  const proc = pty.spawn(shell, args, {
    cwd: opts.cwd,
    cols,
    rows,
    name: 'xterm-256color',
    env: { ...process.env, TERM: 'xterm-256color' },
  })

  const info: TerminalInfo = {
    id,
    cwd: opts.cwd,
    shell,
    cols,
    rows,
    startedAt: new Date().toISOString(),
    tag: opts.tag ?? 'shell',
    ...(opts.agentSessionId ? { agentSessionId: opts.agentSessionId } : {}),
  }

  // Claude panes get a headless screen model for menu detection; plain shells
  // don't need it. Never let a headless-init failure break the PTY.
  let headless: HeadlessTerminal | null = null
  if ((opts.tag ?? 'shell') === 'claude') {
    try {
      headless = new HeadlessTerminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
    } catch {
      headless = null
    }
  }

  const session: PtySession = {
    info,
    pty: proc,
    buffer: '',
    listeners: new Set(),
    exitListeners: new Set(),
    headless,
    menuTimer: null,
  }
  sessions.set(id, session)

  proc.onData((chunk: string) => {
    appendBuffer(session, chunk)
    info.lastOutputAt = Date.now()
    if (session.headless) {
      try { session.headless.write(chunk) } catch {}
      scheduleMenuDetect(session)
    }
    for (const l of Array.from(session.listeners)) {
      try { l(chunk) } catch {}
    }
  })
  proc.onExit(({ exitCode }: { exitCode: number }) => {
    info.exitCode = exitCode ?? 0
    info.finishedAt = new Date().toISOString()
    if (session.menuTimer) { clearTimeout(session.menuTimer); session.menuTimer = null }
    info.menuOpen = false
    if (session.headless) {
      try { session.headless.dispose() } catch {}
      session.headless = null
    }
    for (const l of Array.from(session.exitListeners)) {
      try { l(info) } catch {}
    }
    // Keep the session around briefly so the client can read the exit and
    // drain the buffer; then drop it.
    setTimeout(() => sessions.delete(id), 30_000)
  })

  return info
}

export const getTerminal = (id: string): TerminalInfo | null =>
  sessions.get(id)?.info ?? null

/** Cwds of terminals whose PTY is still alive — feeds the Ground's
 *  "terminal active" card indicator. A session records `finishedAt` in its
 *  onExit handler and then lingers in the map for ~30s so the client can
 *  drain the buffer; those exited-but-lingering sessions are excluded here.
 *  Deduped (a project can hold several panes) and unordered. */
export const listActiveTerminalCwds = (): string[] => {
  const out = new Set<string>()
  sessions.forEach((s) => {
    if (!s.info.finishedAt) out.add(s.info.cwd)
  })
  return Array.from(out)
}

/** Working/waiting judgement for a claude PTY. Pure — `now` is injected so
 *  tests don't need fake timers (house style; see shareAutoSync.test.ts).
 *  - An open TUI menu (permission prompt etc.) means claude is blocked on the
 *    human, regardless of how recently it painted — `waiting`.
 *  - Otherwise recent output (< WORKING_SILENCE_MS) means its spinner is
 *    repainting — `working`.
 *  - Silence (or no output yet) — `waiting`. */
export const claudeStatus = (info: TerminalInfo, now: number): ClaudeBeaconStatus => {
  if (info.menuOpen) return 'waiting'
  if (info.lastOutputAt !== undefined && now - info.lastOutputAt < WORKING_SILENCE_MS) {
    return 'working'
  }
  return 'waiting'
}

/** Full payload of GET /api/terminal/active: the legacy `cwds` list (any live
 *  PTY — shells included) plus per-cwd claude activity, deduped so that when a
 *  project holds several claude panes `working` wins over `waiting`. */
export const listActiveTerminals = (): ActiveTerminalsResponse => {
  const now = Date.now()
  const byCwd = new Map<string, ClaudeBeaconStatus>()
  sessions.forEach((s) => {
    if (s.info.finishedAt || s.info.tag !== 'claude') return
    const status = claudeStatus(s.info, now)
    if (status === 'working' || !byCwd.has(s.info.cwd)) byCwd.set(s.info.cwd, status)
  })
  return {
    cwds: listActiveTerminalCwds(),
    claude: Array.from(byCwd, ([cwd, status]) => ({ cwd, status })),
  }
}

export const writeInput = (id: string, data: string): boolean => {
  const s = sessions.get(id)
  if (!s || s.info.finishedAt) return false
  s.pty.write(data)
  return true
}

export const resizeTerminal = (id: string, cols: number, rows: number): boolean => {
  const s = sessions.get(id)
  if (!s || s.info.finishedAt) return false
  const c = Math.max(20, Math.min(500, cols))
  const r = Math.max(5, Math.min(200, rows))
  try {
    s.pty.resize(c, r)
    s.info.cols = c
    s.info.rows = r
    // Keep the headless screen model the same size or the bottom-row menu scan
    // misreads (wrapping shifts).
    try { s.headless?.resize(c, r) } catch {}
    return true
  } catch {
    return false
  }
}

export const killTerminal = (id: string): boolean => {
  const s = sessions.get(id)
  if (!s) return false
  try { s.pty.kill() } catch {}
  return true
}

export const subscribeTerminal = (
  id: string,
  onData: Listener,
  onExit: (info: TerminalInfo) => void,
): { unsubscribe: () => void; replay: string; info: TerminalInfo } | null => {
  const s = sessions.get(id)
  if (!s) return null
  s.listeners.add(onData)
  s.exitListeners.add(onExit)
  return {
    info: s.info,
    replay: s.buffer,
    unsubscribe: () => {
      s.listeners.delete(onData)
      s.exitListeners.delete(onExit)
    },
  }
}
