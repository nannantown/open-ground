import { randomUUID } from 'crypto'
// node-pty is a native module — require it lazily so a missing/broken build
// doesn't crash the whole route layer on import (it'll surface on first use).
type IPty = any
let ptyMod: any = null
const loadPty = () => {
  if (!ptyMod) ptyMod = require('node-pty')
  return ptyMod
}

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
  }
  const session: PtySession = {
    info,
    pty: proc,
    buffer: '',
    listeners: new Set(),
    exitListeners: new Set(),
  }
  sessions.set(id, session)

  proc.onData((chunk: string) => {
    appendBuffer(session, chunk)
    for (const l of Array.from(session.listeners)) {
      try { l(chunk) } catch {}
    }
  })
  proc.onExit(({ exitCode }: { exitCode: number }) => {
    info.exitCode = exitCode ?? 0
    info.finishedAt = new Date().toISOString()
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
