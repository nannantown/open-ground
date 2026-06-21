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

// Per-SSE-subscriber flow accounting. `controlled` flips true on the first
// ACK — only flows whose subscriber actually ACKs participate in pause
// decisions (see evaluateFlow for why). `onStall` is the stream owner's
// drop-this-connection hook, fired when the flow has held the PTY paused past
// FLOW_PAUSE_CAP_MS (see firePauseCap).
interface FlowState {
  sent: number
  acked: number
  controlled: boolean
  onStall?: () => void
}

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
  // streamId → flow counters for ACK-based back-pressure on the PTY → SSE
  // path. Optional (like headless) because tests inject bare session objects
  // through the globalThis seam — every reader must tolerate undefined.
  flows?: Map<string, FlowState>
  // True while the PTY is pause()d because a controlled flow backed up past
  // FLOW_HIGH_WATERMARK.
  paused?: boolean
  // Armed when the pause starts, cleared on resume/exit: if it fires, the
  // flows still jamming the PTY are dropped (firePauseCap) so a stalled
  // renderer can never hold claude blocked indefinitely.
  pauseTimer?: ReturnType<typeof setTimeout> | null
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

// ACK-based flow control for the PTY → SSE → xterm path. Without it, a client
// whose rendering can't keep up lets xterm's write buffer grow without bound
// (the exact configuration xterm's flow-control guide warns about). The unit
// is UTF-16 code units (string.length): the server counts the chunk strings it
// emits and the client ACKs the same strings' .length after writing them to
// xterm, so both sides measure identically with no byte-encoding math. Above
// HIGH the PTY is pause()d; once the un-acked backlog drains below LOW it
// resume()s (the gap gives hysteresis so we don't flap per chunk). With
// several watchers on one PTY the LEAST backed-up controlled flow governs the
// pause — see evaluateFlow.
export const FLOW_HIGH_WATERMARK = 1_000_000
export const FLOW_LOW_WATERMARK = 256_000

// Cap on how long a jammed flow may keep the PTY pause()d. A paused PTY stops
// being read, the ~64KB kernel buffer fills, and claude's stdout writes (a
// TTY — blocking in node) hard-block the whole process. ACKs can legitimately
// stop for MINUTES through no fault of the session: a minimized Electron
// window or hidden browser tab gets Chromium timer throttling, which clamps
// the chained-setTimeout drain loop inside xterm's WriteBuffer — the very
// callbacks the client ACKs from. Letting the renderer hold claude hostage
// would break the product's core promise (multiplexed sessions keep working
// while you look elsewhere), so once a pause has lasted this long the jammed
// streams are dropped instead: onStall ends the SSE connection, EventSource
// auto-reconnects, and the client repaints from the replay ring buffer. 10s
// is orders of magnitude above a healthy drain (a renderer that keeps up
// clears the whole HIGH→LOW span well under a second), so only genuinely
// stalled subscribers are ever dropped.
export const FLOW_PAUSE_CAP_MS = 10_000

const appendBuffer = (s: PtySession, chunk: string) => {
  s.buffer += chunk
  const limit = s.info.tag === 'claude' ? MAX_BUFFER_BYTES_CLAUDE : MAX_BUFFER_BYTES_SHELL
  if (s.buffer.length > limit) {
    s.buffer = s.buffer.slice(s.buffer.length - limit)
  }
}

// Pick the PTY's host shell. `platform` / `env` are injectable so both branches
// unit-test on one host; production uses the real values (the defaults).
//   - An explicit OPENGROUND_TERMINAL_SHELL always wins.
//   - Windows: ALWAYS PowerShell. The claude launch-command framing
//     (claudeTerminal.buildLaunchCommand) is PowerShell-specific (`$env:` +
//     call operator + `$(Get-Content -Raw …)`), so a stray POSIX `SHELL`
//     (inherited from a Git Bash / MSYS launch) must NOT select a shell that
//     framing can't drive.
//   - POSIX: honour `SHELL` (so the login PATH — nvm/volta — matches the user's
//     real shell), falling back to /bin/zsh.
export const pickShell = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (env.OPENGROUND_TERMINAL_SHELL) return env.OPENGROUND_TERMINAL_SHELL
  if (platform === 'win32') return 'powershell.exe'
  return env.SHELL || '/bin/zsh'
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
    flows: new Map(),
    paused: false,
    pauseTimer: null,
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
    // Drop flow accounting with the PTY — evaluateFlow guards on finishedAt,
    // so a late ACK/unregister never fires resume() at a dead process. The
    // pause-cap timer goes with it (nothing left to resume or drop).
    if (session.pauseTimer) { clearTimeout(session.pauseTimer); session.pauseTimer = null }
    session.flows?.clear()
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
 *  tests don't need fake timers (house style).
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
 *  PTY — shells included) plus every live claude pane's id + cwd + verdict.
 *  No dedup here — Board cards need their own pane's status by PTY id; the
 *  Ground's per-project beacon aggregates client-side (working wins). */
export const listActiveTerminals = (): ActiveTerminalsResponse => {
  const now = Date.now()
  const claude: ActiveTerminalsResponse['claude'] = []
  sessions.forEach((s) => {
    if (s.info.finishedAt || s.info.tag !== 'claude') return
    claude.push({ id: s.info.id, cwd: s.info.cwd, status: claudeStatus(s.info, now) })
  })
  return { cwds: listActiveTerminalCwds(), claude }
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

/** Kill every live PTY whose cwd is exactly `cwd`. Used when the directory
 *  itself is about to be removed (custom-module delete rm -rf's the module
 *  dir): a session left running there would outlive every UI surface that
 *  could reach it — the tab is gone — yet keep showing in
 *  GET /api/terminal/active until app quit. Returns the number killed. */
export const killTerminalsByCwd = (cwd: string): number => {
  let killed = 0
  sessions.forEach((s) => {
    if (s.info.finishedAt || s.info.cwd !== cwd) return
    try { s.pty.kill() } catch {}
    killed++
  })
  return killed
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

// The pause cap fired: the PTY has now been paused for FLOW_PAUSE_CAP_MS
// straight (any ACK/unregister that left some flow below LOW in the meantime
// would have resumed and cleared the timer). Holding on would block claude's
// writes, so drop every controlled flow still at or above LOW: resume needs
// SOME flow under LOW (evaluateFlow's minimum rule) and none of these reached
// it within the cap — keeping one would pin the pause with no timer left
// armed. Each drop fires the stream's onStall (the SSE route ends that
// connection; the client reconnects and repaints from the replay buffer) and
// the final re-evaluate resumes the PTY for everybody else.
const firePauseCap = (s: PtySession): void => {
  s.pauseTimer = null
  if (!s.paused || s.info.finishedAt || !s.flows) return
  const stalled: FlowState[] = []
  for (const [streamId, f] of Array.from(s.flows)) {
    if (f.controlled && f.sent - f.acked >= FLOW_LOW_WATERMARK) {
      // Delete BEFORE onStall: the stream's teardown calls unregisterFlowStream
      // → evaluateFlow, which must already see the jam gone.
      s.flows.delete(streamId)
      stalled.push(f)
    }
  }
  for (const f of stalled) {
    try { f.onStall?.() } catch {}
  }
  evaluateFlow(s)
}

// Pause/resume the PTY on the un-acked backlog of CONTROLLED flows — and only
// when EVERY one of them is jammed: the MINIMUM backlog drives the decision,
// because pausing on the worst flow would let one stalled subscriber (a
// background-throttled browser tab whose ACKs stopped) freeze live output for
// a healthy sibling watching the same PTY — Electron window + leftover
// browser tab is a routine dev setup. A flow that jams past HIGH while a
// healthy controlled sibling (backlog < LOW) exists is instead stall-dropped
// HERE, immediately, via its onStall — the same drop → reconnect → repaint
// recovery firePauseCap runs, minus the collective freeze. With no healthy
// sibling (the single-viewer case included) the pause + cap path below is
// unchanged. Uncontrolled flows (subscribers that never ACKed — e.g. a
// pre-update SPA tab still open across a dev server reload) are excluded from
// all of it: their `sent` grows forever by definition, and letting it count
// would freeze claude permanently the moment one legacy client connects. They
// simply get no back-pressure, which is exactly the pre-flow-control
// behavior. With no controlled flows at all (nobody watching) the backlog is
// 0, so an unwatched claude keeps running and only fills the ring buffer —
// same as before. Every pause arms the cap timer (firePauseCap) so a stalled
// subscriber bounds how long claude can be held.
const evaluateFlow = (s: PtySession): void => {
  if (s.info.finishedAt) return
  let minBacklog = Infinity
  let healthy = false
  const jammed: Array<[string, FlowState]> = []
  s.flows?.forEach((f, streamId) => {
    if (!f.controlled) return
    const b = f.sent - f.acked
    minBacklog = Math.min(minBacklog, b)
    if (b < FLOW_LOW_WATERMARK) healthy = true
    if (b > FLOW_HIGH_WATERMARK) jammed.push([streamId, f])
  })
  if (healthy && jammed.length > 0) {
    // Delete BEFORE onStall — same discipline as firePauseCap: the stream's
    // teardown calls unregisterFlowStream → evaluateFlow, which must already
    // see the jam gone.
    for (const [streamId] of jammed) s.flows?.delete(streamId)
    for (const [, f] of jammed) {
      try { f.onStall?.() } catch {}
    }
    // Re-survey the survivors (mirrors firePauseCap's closing re-evaluate) so
    // the pause/resume decision below runs on the post-drop set — e.g. a
    // post-pause drain that turned one flow healthy must now resume the PTY,
    // not leave it paused on the dropped sibling's stale backlog. Bounded:
    // the recursive pass can't find another jammed flow.
    evaluateFlow(s)
    return
  }
  const backlog = minBacklog === Infinity ? 0 : minBacklog
  if (backlog > FLOW_HIGH_WATERMARK && !s.paused) {
    try { s.pty.pause() } catch {}
    s.paused = true
    if (s.pauseTimer) clearTimeout(s.pauseTimer)
    s.pauseTimer = setTimeout(() => firePauseCap(s), FLOW_PAUSE_CAP_MS)
  } else if (backlog < FLOW_LOW_WATERMARK && s.paused) {
    try { s.pty.resume() } catch {}
    s.paused = false
    if (s.pauseTimer) { clearTimeout(s.pauseTimer); s.pauseTimer = null }
  }
}

export const registerFlowStream = (
  termId: string,
  streamId: string,
  // Invoked (at most once) when this flow is stall-dropped: it jammed past
  // HIGH while a healthy sibling was watching the same PTY (evaluateFlow), or
  // it held the PTY paused past FLOW_PAUSE_CAP_MS (firePauseCap). The owner
  // must end its SSE connection so the client reconnects and repaints from
  // the replay buffer. The flow is already unregistered when it fires, so the
  // teardown's own unregisterFlowStream is a harmless no-op.
  onStall?: () => void,
): void => {
  const s = sessions.get(termId)
  if (!s) return
  // ??= keeps this safe on sessions created before flows existed (and on the
  // bare objects tests inject through the globalThis seam).
  ;(s.flows ??= new Map()).set(streamId, { sent: 0, acked: 0, controlled: false, onStall })
}

export const trackFlowSent = (termId: string, streamId: string, count: number): void => {
  const s = sessions.get(termId)
  const f = s?.flows?.get(streamId)
  if (!s || !f) return
  f.sent += count
  evaluateFlow(s)
}

export const ackFlowStream = (termId: string, streamId: string, count: number): void => {
  const s = sessions.get(termId)
  const f = s?.flows?.get(streamId)
  if (!s || !f) return
  // Clamp to `sent`: a duplicate/over-ACK must not drive the backlog negative,
  // which would bank credit and effectively disable flow control for this stream.
  f.acked = Math.min(f.acked + count, f.sent)
  f.controlled = true
  evaluateFlow(s)
}

export const unregisterFlowStream = (termId: string, streamId: string): void => {
  const s = sessions.get(termId)
  if (!s) return
  // Dropping the flow re-evaluates: if the closed stream was the jammed one,
  // the PTY resumes for everybody else.
  s.flows?.delete(streamId)
  evaluateFlow(s)
}
