import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { detectMenu } from '@/lib/claudeMenu'
import type { ActiveTerminalsResponse, ClaudeBeaconStatus, TerminalPoolSweepResult } from '@/lib/types'
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
  // The signal number that terminated the PTY's shell, when the shell was killed
  // BY a signal (e.g. 9 = SIGKILL, commonly an OS OOM-kill; 1 = SIGHUP). Captured so
  // a worker that dies unattended (no human watching the pane) leaves a diagnosable
  // trace instead of just "died, cause unknown" (swarm workers are unattended
  // `claude` PTYs; before this field existed there was no way to tell an OOM-kill
  // from a crash from an intentional teardown after the fact).
  //
  // Left UNDEFINED for a voluntary exit. ⚠ node-pty does not do that for us: it
  // reports `signal: 0` — a number, not undefined — on every plain exit (measured
  // on 1.2.0-beta.14). Storing that verbatim would stamp a meaningless `signal=0`
  // on every clean teardown, so the capture below keeps only a REAL signal (> 0).
  // A signal death also always arrives with `exitCode: 0` (WIFEXITED and
  // WIFSIGNALED are mutually exclusive) — hence this field, and not the exit code,
  // is what identifies a kill. See classifyWorkerExit (swarmOrchestrator.ts).
  exitSignal?: number
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
  // True for a headless UTILITY session: a real `claude` PTY spawned only to
  // marker-scrape its output (auto-title / auto-description — see launchClaude's
  // `hidden` opt), with NO user-visible pane. Such a session is EXCLUDED from the
  // Ground beacon surface (listActiveTerminals) so a background titling/describe
  // run never flashes "claude working" on a card; it stays a live cwd for
  // listActiveTerminalCwds (the worktree-cleanup liveness guard). Defaults to
  // false — every user-launched pane (terminal routes, Board 実行, swarm roles).
  hidden?: boolean
  // True for an OWNER'S CONVERSATION DESK: a claude session the owner types INTO
  // and waits on — the Terminal tab's panes, Board 実行, the commander / supply
  // desks. These are the sessions whose silence costs the OWNER time, so they get
  // the "your conversation hit a model limit" watch (ownerDeskLimit.ts).
  //
  // Deliberately OPT-IN, and deliberately NOT the inverse of `hidden`: the swarm's
  // UNATTENDED sessions (workers, review-panel reviewers) are visible panes too,
  // yet nobody is waiting at their keyboard and the engine already rescues them
  // (hold → requeue → tier demotion). Notifying on those would put one toast per
  // worker in front of the owner for a condition the machine is already handling —
  // so the flag marks the desks a HUMAN sits at, not everything with a pane.
  ownerDesk?: boolean
  // For an ownerDesk — what to CALL this desk when telling the owner it stopped
  // ("司令官", "補給官"). An account-wide model exhaustion stops every desk at
  // once, and a notification naming only the project puts identical rows in front
  // of the owner for different conversations. Set only where the role is
  // unambiguous and owner-meaningful; a plain Terminal pane leaves it unset and
  // the message names the project alone rather than inventing a machine label.
  deskLabel?: string
  // The Board card this session is working on — set by the card's 実行 (Run)
  // launch and by paste-task (injecting a card's prompt into a live pane makes
  // that pane the card's pane from then on).
  //
  // This is the ONLY link from a Board card to a live PTY, and the task-boundary
  // context clear (boundaryClear.ts) is why it has to exist: a card landing in
  // `done` must clear the pane THAT CARD ran in and no other. Resolving by cwd
  // instead would sweep every pane in the project — including one the owner has
  // unrelated work sitting in — which is exactly the mis-clear the card's teeth
  // forbid. Unset on a plain Terminal pane, so such a pane is never a target.
  taskId?: string
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
//
// `unwrap` rejoins CONTINUATION rows — the ones xterm created by soft-wrapping a
// long logical line at the terminal edge — into the single line a human reads,
// using the buffer's own `isWrapped` flag rather than guessing from row length.
// Off by default: every historical caller (menu detection, the swarm worker arm's
// screen scrape) is tuned against the row-per-row view and must not shift.
//
// It matters because the rows are joined with '\n', which the downstream
// normalizer collapses to a SPACE — so a soft wrap lands a space in the middle of
// whatever word straddled the edge, and any phrase spanning the wrap stops
// matching. Measured 2026-07-18: at 80 columns the CLI's 95-character limit notice
// wraps mid-word and "switch models with /model" no longer matches, while at 120
// it does. The worker arm absorbs this by design (its three phrases are matched
// independently so a surviving fragment still fires); the owner-desk sensor cannot,
// because it also asks WHERE the match sits, and a broken final phrase moves the
// last match dozens of characters back up the message.
// Exported ONLY so the owner-desk regression suite reads its synthetic frames back
// through this exact function (it renders into a headless terminal with no PTY
// behind it, so it cannot go through getTerminalScreenLogical). It previously kept
// a hand-copy of this loop, which is a fixture that can drift away from the code it
// claims to pin — the failure mode that whole suite exists to catch.
export const readScreen = (term: HeadlessTerminal, unwrap = false): string => {
  const buf = term.buffer.active
  const rows: string[] = []
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.baseY + y)
    const text = line ? line.translateToString(true) : ''
    if (unwrap && line?.isWrapped && rows.length > 0) {
      rows[rows.length - 1] += text // continuation of the row above — no separator
    } else {
      rows.push(text)
    }
  }
  return rows.join('\n')
}

// Refresh the menu verdict from a fresh PTY output chunk. The two directions of
// the verdict carry very different risk, so they're handled asymmetrically:
//
//  - CLEAR is EAGER (synchronous, every chunk). Fresh output means the screen is
//    actively repainting, which means claude is WORKING — a real prompt sits on
//    a STATIC screen and emits nothing while it waits on the human. So the moment
//    output flows we drop any stale menuOpen=true at once. Without this eager
//    clear, a post-approval work burst (chunks arriving faster than
//    MENU_DETECT_DEBOUNCE_MS) keeps resetting the trailing debounce below so it
//    NEVER fires, leaving menuOpen pinned to the pre-approval `true`; claudeStatus
//    short-circuits that to 'waiting', so the beacon stays stuck on "waiting" for
//    the whole burst even though claude is plainly working. The clear is
//    self-correcting: if a menu really is up, the settled-frame detect restores it.
//
//  - SET stays gated on a SETTLED frame (the debounce). We assert a menu EXISTS
//    only after MENU_DETECT_DEBOUNCE_MS of quiet, so the headless screen we scan is
//    a finished repaint, not a half-drawn frame detectMenu could misread.
//
// Exported for unit tests; production wires it through pty.onData (an e2e path).
export const scheduleMenuDetect = (s: PtySession): void => {
  if (!s.headless) return
  s.info.menuOpen = false
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
  // Handle of the server-side sweep loop (startTerminalSweepLoop). On globalThis
  // so a `tsx watch` reload re-arms ONE loop instead of stacking a second.
  // eslint-disable-next-line no-var
  var __openground_terminal_sweep_timer: ReturnType<typeof setInterval> | null | undefined
}

const state: TerminalState =
  globalThis.__openground_terminal ??
  (globalThis.__openground_terminal = { sessions: new Map() })

const { sessions } = state

// How long after a PTY exits sweepTerminalPool will reap its lingering session.
// The happy path is the 30s onExit delete timer; this is strictly LARGER so the
// sweep only ever catches entries whose timer was lost across a server reload
// (the sessions Map lives on globalThis and survives reloads — the pending
// setTimeout does not). Never races a client still draining the buffer.
export const TERMINAL_LINGER_SWEEP_MS = 60_000

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
  // Headless utility session (no user-visible pane) — excluded from the Ground
  // beacon. See TerminalInfo.hidden / launchClaude's `hidden` opt.
  hidden?: boolean
  // The owner types into this session and waits on it — see TerminalInfo.ownerDesk.
  ownerDesk?: boolean
  // What to call this desk in that watch's notification — see TerminalInfo.deskLabel.
  deskLabel?: string
  // The Board card this session runs — see TerminalInfo.taskId.
  taskId?: string
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
    ...(opts.hidden ? { hidden: true } : {}),
    ...(opts.ownerDesk ? { ownerDesk: true } : {}),
    ...(opts.ownerDesk && opts.deskLabel ? { deskLabel: opts.deskLabel } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
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
  proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    info.exitCode = exitCode ?? 0
    // `> 0`, not `!== undefined`: node-pty reports signal 0 for a voluntary exit
    // (measured), so the looser test would set exitSignal on EVERY exit and make
    // the field meaningless. See the exitSignal doc on TerminalInfo.
    if (typeof signal === 'number' && signal > 0) info.exitSignal = signal
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
    // Release the subscriber sets now the PTY is dead: onData can never fire
    // again (the process is gone) and every exitListener has just run, so both
    // sets are pure leak from here. Dropping them here — not only at the 30s
    // delete below — bounds the leak even if that delete timer is lost across a
    // server reload (the sessions Map lives on globalThis and survives reloads;
    // the pending setTimeout does NOT). A client that (re)subscribes during the
    // linger window still gets its exit: the SSE route reads info.finishedAt
    // synchronously after init and emits it, never relying on these listeners.
    session.listeners.clear()
    session.exitListeners.clear()
    // Keep the session around briefly so the client can read the exit and
    // drain the buffer; then drop it. sweepTerminalPool is the safety net for
    // when this timer is lost (reload) — it removes finished sessions past the
    // linger window.
    setTimeout(() => sessions.delete(id), 30_000)
  })

  return info
}

export const getTerminal = (id: string): TerminalInfo | null =>
  sessions.get(id)?.info ?? null

/** The session's CURRENT visible screen as plain text (the headless xterm's
 *  reconstructed frame for a tag:'claude' PTY), or null when the session is
 *  gone / has no headless terminal (a plain shell, or a fake test session).
 *  Read-only — no side effects on the PTY or its buffers.
 *
 *  Why the SCREEN, not the raw replay buffer: claude is a cursor-addressed TUI,
 *  so its raw stdout is interleaved escape sequences (a partial repaint), while
 *  the headless terminal applies them to give the clean text a human sees — the
 *  right surface for spotting a usage/rate-limit message or a permission/trust
 *  prompt (the swarm orchestrator's "why isn't this worker progressing?" probe).
 *  Falls back to the last slice of the raw buffer when there is no headless
 *  terminal, so a caller still gets *something* to inspect (it must tolerate the
 *  embedded escape codes — the orchestrator's classifier strips them). */
export const getTerminalScreen = (id: string): string | null => {
  const s = sessions.get(id)
  if (!s) return null
  if (s.headless) {
    try {
      return readScreen(s.headless)
    } catch {
      /* fall through to the raw buffer */
    }
  }
  return s.buffer ? s.buffer.slice(-4000) : null
}

/** Cwds of EVERY terminal whose PTY is still alive — the LIVENESS primitive.
 *  worktreeCleanup reads it to never reap a worktree with a live PTY in it, so it
 *  deliberately INCLUDES hidden utility sessions (a background titling/describe
 *  run is a real process whose tree must not vanish under it). A session records
 *  `finishedAt` in its onExit handler and then lingers in the map for ~30s so the
 *  client can drain the buffer; those exited-but-lingering sessions are excluded
 *  here. Deduped (a project can hold several panes) and unordered.
 *  NOTE: the user-facing beacon surface (listActiveTerminals) filters hidden
 *  sessions out separately — this primitive must NOT, or the cleanup safety guard
 *  would lose sight of a live hidden session. */
export const listActiveTerminalCwds = (): string[] => {
  const out = new Set<string>()
  sessions.forEach((s) => {
    if (!s.info.finishedAt) out.add(s.info.cwd)
  })
  return Array.from(out)
}

/** Is a LIVE PTY already driving this claude session id?
 *
 *  The resume seam (swarmSessions.ts) asks before handing a PERSISTED session id to
 *  `claude --resume`: two claude processes appending to the SAME session transcript
 *  would interleave-corrupt it, so a session that is still open is NOT resumable —
 *  the caller mints a fresh id instead (fail-open). Deliberately INCLUDES hidden
 *  utility sessions (they are real claude processes holding a real transcript open)
 *  and EXCLUDES exited-but-lingering ones (`finishedAt` set, kept ~30s so the client
 *  can drain the buffer) — that PTY is gone, so its session is free to resume. */
export const isClaudeSessionLive = (agentSessionId: string): boolean =>
  claudeSessionActivity(agentSessionId).live

/** Liveness + ACTIVITY + the PTY to talk to, for a persisted claude session id.
 *  The superset {@link isClaudeSessionLive} is now a thin wrapper over. */
export interface ClaudeSessionActivity {
  /** A live (not exited) PTY is driving this session id. */
  live: boolean
  /** Newest `lastOutputAt` across those PTYs, or null when none has painted yet. */
  lastOutputAt: number | null
  /** The live PTY to address (the newest-painting one), or null when not live. */
  terminalId: string | null
}

/** Is a live PTY driving this session — and if so, when did it last PAINT?
 *
 *  `live` alone answers the RESUME seam's question ("would a second `claude
 *  --resume` interleave-corrupt this transcript?"). The commander monitor needs
 *  one bit more: a live desk that is merely QUIET is not a wedged desk, and
 *  conflating the two is what made the engine declare a working commander dead and
 *  respawn it three times (2026-07-18 — see swarmOrchestrator's manager presence
 *  probe). `lastOutputAt` is that second channel: claude's TUI repaints while it
 *  works (spinner, streaming tokens) and echoes the owner's keystrokes, so recent
 *  output is POSITIVE evidence the desk is engaged rather than merely present.
 *
 *  Exited-but-lingering sessions (`finishedAt` set, kept ~30s so the client can
 *  drain the buffer) are excluded — same rule as isClaudeSessionLive. Hidden
 *  utility sessions are INCLUDED (they are real claude processes). If several live
 *  PTYs somehow share one session id, the newest-painting one wins and its
 *  terminal id is the one returned (the PTY a nudge must be written to). */
export const claudeSessionActivity = (agentSessionId: string): ClaudeSessionActivity => {
  const out: ClaudeSessionActivity = { live: false, lastOutputAt: null, terminalId: null }
  if (!agentSessionId) return out
  sessions.forEach((s) => {
    if (s.info.finishedAt || s.info.agentSessionId !== agentSessionId) return
    out.live = true
    const at = s.info.lastOutputAt
    if (at !== undefined && (out.lastOutputAt === null || at > out.lastOutputAt)) {
      out.lastOutputAt = at
      out.terminalId = s.info.id
    }
    // A live PTY that has never painted is still the desk to address.
    out.terminalId ??= s.info.id
  })
  return out
}

/** A desk's screen with soft-wrapped rows REJOINED into the logical lines a human
 *  reads — the surface the owner-desk model-limit watch reads (ownerDeskLimit.ts).
 *  Identical to {@link getTerminalScreen} except for that rejoin; kept separate so
 *  the historical screen readers (menu detection, the swarm worker arm) keep the
 *  exact row-per-row view they were tuned against. Returns null for a session that
 *  is gone or has no headless terminal. Read-only. */
export const getTerminalScreenLogical = (id: string): string | null => {
  const s = sessions.get(id)
  if (!s?.headless) return null
  try {
    return readScreen(s.headless, true)
  } catch {
    // NO RAW-BUFFER FALLBACK, deliberately. The ring buffer carries the
    // cursor-addressing claude interleaves, so its "rows" are not the rows a human
    // reads — and this function's one caller CLASSIFIES rows (the desk watch walks
    // the frame's anatomy: banner, chrome, prompt, utterance). Handing it that text
    // does not degrade the watch, it BLINDS it: nothing is recognised as chrome, so
    // the notice never reads as standing alone and the sensor goes quiet on exactly
    // the event it exists for — while every layer above still sees a string and
    // believes it looked. Null is the honest answer, and the caller already treats
    // it as missing evidence: it neither notifies nor counts the read toward
    // re-arming a desk it has already reported (review 2026-07-18, round 3).
    return null
  }
}

/** One LIVE owner conversation desk, as the model-limit watch needs to see it. */
export interface OwnerDeskTerminal {
  id: string
  cwd: string
  /** The claude session id this PTY was launched to drive — what the desks'
   *  persisted session store (swarmSessions.ts) records, so a caller holding a
   *  pool entry can RECONCILE the store against the pool rather than trusting
   *  it. Absent for a desk launched without one. */
  agentSessionId?: string
  /** Owner-meaningful name for this desk ("司令官"), when its launcher set one —
   *  see {@link TerminalInfo.deskLabel}. */
  deskLabel?: string
  /** Epoch ms of the last PTY output chunk (absent ⇒ nothing painted yet). */
  lastOutputAt?: number
  /** Epoch ms the PTY was spawned — the floor for the output-quiet window, so a
   *  session that has never painted isn't treated as "quiet since 1970". */
  startedAtMs: number
}

/** Every LIVE claude PTY the owner types into and waits on — the input to the
 *  model-limit watch (ownerDeskLimit.ts). The {@link TerminalInfo.ownerDesk} flag
 *  its launcher set is what selects it, so an unattended swarm session (worker /
 *  reviewer) and a headless utility run are excluded by construction rather than
 *  by guessing from the pane.
 *
 *  The other three conditions are belt-and-braces, asserted here so the watch's
 *  contract holds on the POOL rather than on call-site discipline alone: a live
 *  PTY (`finishedAt` unset — an exited conversation is over, not stopped), a
 *  `claude` session (a plain shell has no model to run out of), and NOT hidden (a
 *  headless utility run has no pane for the owner to go fix, so telling them to
 *  type /model somewhere would be a dead end). A session that is both `ownerDesk`
 *  and `hidden` is a contradiction; if one ever appears, this drops it instead of
 *  notifying about a window that does not exist.
 *
 *  PURE READ — never touches the PTY. */
export const listOwnerDeskTerminals = (): OwnerDeskTerminal[] => {
  const out: OwnerDeskTerminal[] = []
  sessions.forEach((s) => {
    if (s.info.finishedAt || !s.info.ownerDesk) return
    if (s.info.hidden || s.info.tag !== 'claude') return
    const startedAtMs = Date.parse(s.info.startedAt)
    out.push({
      id: s.info.id,
      cwd: s.info.cwd,
      ...(s.info.agentSessionId ? { agentSessionId: s.info.agentSessionId } : {}),
      ...(s.info.deskLabel ? { deskLabel: s.info.deskLabel } : {}),
      ...(s.info.lastOutputAt !== undefined ? { lastOutputAt: s.info.lastOutputAt } : {}),
      startedAtMs: Number.isNaN(startedAtMs) ? 0 : startedAtMs,
    })
  })
  return out
}

/** Every LIVE desk PTY running in `cwd` under `deskLabel` — the POOL's OWN
 *  answer to "does this project already have a commander desk?", newest first.
 *
 *  WHY THIS EXISTS (measured 2026-07-19: eleven commander desks in three hours).
 *  Both the engine's presence probe and the resume seam asked that question of
 *  the persisted session STORE — "is the PTY holding the recorded session id
 *  alive?" — and the store is a single slot that every spawn overwrites
 *  (swarmSessions.recordSwarmSession). So one swallowed write, one transient
 *  store read fault, or one spawn racing another permanently ORPHANS a running
 *  desk: it keeps holding a `claude` process while the engine, asking only about
 *  the id it has on file, reads 'absent' and builds another desk beside it —
 *  then another, every five minutes. The canonical claim that duplicates are
 *  「構造的に起こらない」 (docs/commander/03 §2.3) held only under the unenforced
 *  assumption that the recorded id always names the live desk.
 *
 *  The pool cannot desynchronise from itself, so it is the right authority for
 *  EXISTENCE. `deskLabel` is what makes the question answerable without guessing:
 *  it is set only by a desk launcher (swarmManager / swarmSupply), so the owner's
 *  own hand-started `claude` in the same repo — which carries no label — is never
 *  mistaken for a commander. That distinction is why refusing to spawn is safe
 *  here even though AUTO-KILLING an orphan deliberately is not (03 §2.3).
 *
 *  Paths are compared RESOLVED: the pool stores the cwd its launcher passed, and
 *  a caller may hold the same project through a different spelling.
 *
 *  PURE READ — never touches a PTY. */
export const listLiveDesksIn = (cwd: string, deskLabel: string): OwnerDeskTerminal[] => {
  const want = resolve(cwd)
  return listOwnerDeskTerminals()
    .filter((d) => d.deskLabel === deskLabel && resolve(d.cwd) === want)
    .sort((a, b) => b.startedAtMs - a.startedAtMs)
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

/** A live claude pane bound to a Board card, with everything the task-boundary
 *  clear needs to decide whether it may send `/clear` right now. */
export interface TaskBoundPane {
  id: string
  /** `working` = the spinner is repainting (mid-turn). */
  status: ClaudeBeaconStatus
  /** A TUI menu (permission prompt etc.) is open — keystrokes would answer IT. */
  menuOpen: boolean
}

/** Every LIVE claude pane bound to `taskId`. PURE READ — never touches a PTY.
 *
 *  Hidden utility sessions (auto-title / auto-description) are excluded for the
 *  same reason they are excluded from the beacon: they are machine-owned one-offs
 *  the user never opened a pane for, and clearing one would be a no-op at best.
 *  Panes that have exited are excluded — there is nothing left to clear. */
export const listPanesForTask = (taskId: string, now: number): TaskBoundPane[] => {
  if (!taskId) return []
  const panes: TaskBoundPane[] = []
  sessions.forEach((s) => {
    if (s.info.finishedAt || s.info.hidden) return
    if (s.info.tag !== 'claude' || s.info.taskId !== taskId) return
    panes.push({
      id: s.info.id,
      status: claudeStatus(s.info, now),
      menuOpen: s.info.menuOpen === true,
    })
  })
  return panes
}

/** Bind a LIVE pane to a Board card — the paste-task path: injecting a card's
 *  prompt into an existing session makes that session the card's session from
 *  then on (and un-binds it from whatever card it carried before). Returns false
 *  for an unknown or already-exited pane. */
export const setTerminalTaskId = (id: string, taskId: string): boolean => {
  const s = sessions.get(id)
  if (!s || s.info.finishedAt) return false
  s.info.taskId = taskId
  return true
}

/** Full payload of GET /api/terminal/active: the `cwds` list (any live USER PTY —
 *  shells included) plus every live USER claude pane's id + cwd + verdict. Both
 *  EXCLUDE hidden utility sessions (auto-title / auto-description): they're real
 *  claude PTYs the user never opened a pane for, so surfacing them would flash a
 *  spurious "claude working" beacon on a Ground card. (The worktree-cleanup
 *  liveness guard still sees them via listActiveTerminalCwds.) No dedup on the
 *  claude list — Board cards need their own pane's status by PTY id; the Ground's
 *  per-project beacon aggregates client-side (working wins). The `cwds` list is
 *  deduped. */
export const listActiveTerminals = (): ActiveTerminalsResponse => {
  const now = Date.now()
  const claude: ActiveTerminalsResponse['claude'] = []
  const cwds = new Set<string>()
  sessions.forEach((s) => {
    if (s.info.finishedAt || s.info.hidden) return
    cwds.add(s.info.cwd)
    if (s.info.tag === 'claude') {
      claude.push({ id: s.info.id, cwd: s.info.cwd, status: claudeStatus(s.info, now) })
    }
  })
  return { cwds: Array.from(cwds), claude }
}

/** Minimal per-session rows for the auto-update restart-safety computation —
 *  see liveDesks.updateRestartSafety, which combines this with the SDK pool.
 *  PURE READ, one row per LIVE session (finished ones excluded, hidden ones
 *  included — the computation decides what each kind means, not the pool). */
export interface PtySafetyView {
  cwd: string
  /** Utility session with no pane (titling runs etc.). */
  hidden: boolean
  /** Launched as a named desk (補給官/司令官) — resumes by design. */
  desk: boolean
  /** A claude session actively producing output right now. */
  claudeWorking: boolean
}
export const listPtySafetyViews = (): PtySafetyView[] => {
  const now = Date.now()
  const out: PtySafetyView[] = []
  sessions.forEach((s) => {
    if (s.info.finishedAt) return
    out.push({
      cwd: s.info.cwd,
      hidden: !!s.info.hidden,
      desk: !!s.info.deskLabel,
      claudeWorking: s.info.tag === 'claude' && claudeStatus(s.info, now) === 'working',
    })
  })
  return out
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

/**
 * Kill every PTY in `cwd` and WAIT until the operating system agrees they are
 * gone — the version to use before DELETING that directory.
 *
 * WHY WAITING IS THE WHOLE POINT (2026-07-29). {@link killTerminalsByCwd} only
 * SENDS a signal: node-pty's `kill()` is `process.kill(pid, 'SIGHUP')` and
 * returns immediately, while `finishedAt` is stamped later by the async `onExit`.
 * Callers then ran their destructive step on the next line — `git worktree
 * remove`, `rm -rf` — while `claude` was still very much alive inside that
 * directory. Deleting the cwd out from under a running process is exactly what
 * puts it (or one of the `git` processes claude spawns constantly) into
 * uninterruptible sleep, where neither SIGKILL nor a timeout can ever reach it
 * again — the un-killable orphan class of 07 章 §7, reproduced by our own
 * teardown path.
 *
 * WHY WE WAIT ON THE SHELL'S PID and do not group-kill (measured on this
 * machine, node-pty 1.2.0-beta.14 / darwin):
 *   • The PTY child (`zsh -l`) is a SESSION LEADER (pid == pgid == sid), but
 *     zsh's job control puts each foreground job in its OWN process group. So
 *     `process.kill(-ptyPid, …)` reaches only the shell — never claude. node-pty
 *     exposes no pgid kill either.
 *   • What actually reaches the descendants is the KERNEL: when the session
 *     leader dies, SIGHUP goes to the terminal's foreground process group.
 *     Verified: a grandchild `sleep` under zsh disappeared on `pty.kill()`.
 *   • Therefore the shell's pid leaving the process table IS the evidence that
 *     the kernel delivered that hangup. That is what this waits for.
 *   • Anything that deliberately LEFT the session (`nohup … & disown`, `setsid`)
 *     is unreachable by construction — no signal can find it. The contract is
 *     honestly "the PTY and its foreground descendants", not "everything".
 *
 * Bounded by `timeoutMs` and escalated ONCE to SIGKILL at the halfway mark.
 * Returns `true` only when every matching pid is confirmed gone; `false` means
 * the caller must treat the directory as still occupied and NOT delete it.
 */
export const killTerminalsByCwdAndWait = async (
  cwd: string,
  opts: {
    timeoutMs?: number
    pollMs?: number
    isAlive?: (pid: number) => boolean
    now?: () => number
  } = {},
): Promise<boolean> => {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const pollMs = opts.pollMs ?? 50
  const isAlive = opts.isAlive ?? defaultIsAlive
  const now = opts.now ?? Date.now

  const pids: number[] = []
  sessions.forEach((s) => {
    if (s.info.finishedAt || s.info.cwd !== cwd) return
    const pid = (s.pty as { pid?: unknown } | null)?.pid
    if (typeof pid === 'number' && pid > 0) pids.push(pid)
    try { s.pty.kill() } catch {}
  })
  // Nothing real to wait for (no session, or fixtures without pids) — the
  // signals, if any, are already sent.
  if (!pids.length) return true

  const deadline = now() + timeoutMs
  const escalateAt = now() + Math.floor(timeoutMs / 2)
  let escalated = false
  for (;;) {
    const remaining = pids.filter((p) => isAlive(p))
    if (!remaining.length) return true
    if (now() >= deadline) return false
    if (!escalated && now() >= escalateAt) {
      escalated = true
      // SIGKILL the shell. Its descendants still get the kernel's hangup, because
      // the control process terminating is what triggers it — the signal we use
      // on the leader does not change that.
      for (const p of remaining) {
        try { process.kill(p, 'SIGKILL') } catch { /* already gone */ }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/** Liveness probe for a PTY pid: signal 0 doesn't deliver a signal, it only
 *  checks the process exists. ESRCH ⇒ gone (reap it); EPERM ⇒ exists but not
 *  ours (alive — keep). Anything else (e.g. EINVAL) is treated as alive so we
 *  never reap on an ambiguous error. */
const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

/** Is the PTY behind `terminalId` REALLY still running — asked of the operating
 *  system, not of the pool's bookkeeping?
 *
 *  `finishedAt` is stamped by the asynchronous `onExit` handler, so between
 *  {@link killTerminal} sending the signal and that handler firing, the pool
 *  still reports the session as live (`listOwnerDeskTerminals`/`listLiveDesksIn`
 *  filter only on `finishedAt`). A caller that treats "live" as "usable" inside
 *  that window can hand back a terminal that is already gone — e.g. the
 *  commander's Restart button awaits DELETE then immediately POSTs a respawn,
 *  and the single-desk adoption gate (swarmManager.adoptLiveDesk) can answer
 *  with the very desk the DELETE just killed, handing back a dead pane instead
 *  of spawning a fresh one. In practice the window is one event-loop hop
 *  (node-pty has already reaped the child; only the JS-side onExit callback is
 *  pending) and `startTerminalSweepLoop`'s orphan sweep would self-heal it
 *  within its own poll interval regardless — this closes the narrow immediate
 *  window rather than a lasting outage. Signal 0 closes it because it reflects
 *  the process table rather than our own record of it.
 *
 *  Answers `false` for an unknown id or one already stamped exited. A session
 *  with no real numeric pid (test fixtures) is reported ALIVE — absence of a
 *  pid is missing evidence, not evidence of death, matching the pool's own
 *  sweeper. `isAlive` is injectable for tests. */
export const isTerminalProcessAlive = (
  terminalId: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): boolean => {
  const s = sessions.get(terminalId)
  if (!s || s.info.finishedAt) return false
  const pid = (s.pty as { pid?: unknown } | null)?.pid
  if (typeof pid !== 'number' || pid <= 0) return true
  return isAlive(pid)
}

/** Wait until ONE terminal's process is really gone, after someone has already
 *  signalled it. Bounded; escalates once to SIGKILL at the halfway mark, exactly
 *  like {@link killTerminalsByCwdAndWait} (see that function for why waiting on
 *  the shell's pid is the only reliable evidence that the kernel hung up on its
 *  descendants). Returns false on timeout. An unknown id / a fixture session
 *  without a pid resolves true immediately — absence of a process to wait for is
 *  not a failure. */
export const waitForTerminalGone = async (
  terminalId: string,
  opts: { timeoutMs?: number; pollMs?: number; isAlive?: (pid: number) => boolean; now?: () => number } = {},
): Promise<boolean> => {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const pollMs = opts.pollMs ?? 50
  const isAlive = opts.isAlive ?? defaultIsAlive
  const now = opts.now ?? Date.now
  const s = sessions.get(terminalId)
  const pid = (s?.pty as { pid?: unknown } | null)?.pid
  if (typeof pid !== 'number' || pid <= 0) return true
  const deadline = now() + timeoutMs
  const escalateAt = now() + Math.floor(timeoutMs / 2)
  let escalated = false
  for (;;) {
    if (!isAlive(pid)) return true
    if (now() >= deadline) return false
    if (!escalated && now() >= escalateAt) {
      escalated = true
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/** Tear down ONE pool entry idempotently and drop it from the map. Mirrors the
 *  onExit teardown so it's safe whether or not onExit already ran:
 *   - exited-but-lingering session → fields are already cleared; just delete.
 *   - orphan (process died, onExit never fired) → stamp the exit, notify any
 *     still-attached subscriber (so its SSE closes), then release everything.
 *  Never kills — a confirmed-dead process needs no signal, and reaping a LIVE
 *  PTY is the body-cleaner's job, not the janitor's. */
const reapSession = (id: string, s: PtySession, now: number): void => {
  if (s.menuTimer) { clearTimeout(s.menuTimer); s.menuTimer = null }
  if (s.pauseTimer) { clearTimeout(s.pauseTimer); s.pauseTimer = null }
  if (s.headless) { try { s.headless.dispose() } catch {}; s.headless = null }
  s.flows?.clear()
  if (!s.info.finishedAt) {
    s.info.finishedAt = new Date(now).toISOString()
    if (s.info.exitCode === undefined) s.info.exitCode = -1
    s.info.menuOpen = false
    for (const l of Array.from(s.exitListeners)) {
      try { l(s.info) } catch {}
    }
  }
  s.listeners.clear()
  s.exitListeners.clear()
  sessions.delete(id)
}

export interface SweepTerminalPoolOpts {
  /** Injected clock (epoch ms) — pure-testable, house style. */
  now?: number
  /** Reap an EXITED session once it's lingered at least this long. Default
   *  {@link TERMINAL_LINGER_SWEEP_MS}; tests shrink it. */
  lingerMs?: number
  /** PTY-liveness probe (injected for tests). Default = signal-0 process check. */
  isAlive?: (pid: number) => boolean
}

/** Reap DEAD pool entries — the janitor's terminal-pool sweep. Two classes of
 *  dead entry, neither of which kills anything:
 *   1. EXITED + past the linger window — normally the 30s onExit timer deletes
 *      these; the sweep is the safety net for when that timer was lost on a
 *      server reload (globalThis Map survives; the setTimeout does not).
 *   2. ORPHAN — `finishedAt` unset yet the process is gone (killed out-of-band,
 *      a missed exit event). Reconciled into the map (stamped + dropped) only
 *      when the pid is CONFIRMED dead; sessions without a real numeric pid
 *      (test fixtures) are left untouched.
 *  Live sessions are always kept. Returns {swept ids, kept count}. */
export const sweepTerminalPool = (opts: SweepTerminalPoolOpts = {}): TerminalPoolSweepResult => {
  const now = opts.now ?? Date.now()
  const lingerMs = opts.lingerMs ?? TERMINAL_LINGER_SWEEP_MS
  const isAlive = opts.isAlive ?? defaultIsAlive
  const swept: string[] = []
  let kept = 0
  for (const [id, s] of Array.from(sessions)) {
    let dead = false
    if (s.info.finishedAt) {
      const finAt = Date.parse(s.info.finishedAt)
      if (!Number.isNaN(finAt) && now - finAt >= lingerMs) dead = true
    } else {
      const pid = (s.pty as { pid?: unknown } | null)?.pid
      if (typeof pid === 'number' && pid > 0 && !isAlive(pid)) dead = true
    }
    if (!dead) { kept++; continue }
    reapSession(id, s, now)
    swept.push(id)
  }
  return { swept, kept }
}

// How often the server-side loop runs sweepTerminalPool. Comfortably below the
// human-perceptible "why is this card STILL showing a terminal?" window, and the
// sweep itself is cheap (one Map scan + signal-0 liveness probes), so a tight-ish
// cadence costs almost nothing. Larger than nothing-to-do is fine — the 30s onExit
// delete timer is the happy path; this loop only mops up what a reload lost.
export const TERMINAL_SWEEP_INTERVAL_MS = 30_000

/** Start the UI-INDEPENDENT terminal-pool sweep loop: {@link sweepTerminalPool}
 *  every `intervalMs`, so dead pool entries are reaped even with NO swarm running
 *  and NO UI open (a plain-terminal user gets the same cleanup). It clears two
 *  things the happy-path 30s onExit timer can't:
 *    • a reload-orphaned EXITED entry — the globalThis sessions Map survives a
 *      `tsx watch` reload but the pending 30s `setTimeout` does not, so the entry
 *      would linger forever (a slow memory leak);
 *    • an ORPHAN — a PTY killed out-of-band whose node-pty `onExit` never fired,
 *      so `finishedAt` stays unset and GET /api/terminal/active reports its cwd
 *      forever: a PHANTOM beacon pinned on a Ground card. The sweep's dead-pid
 *      probe reconciles it (stamps the exit, drops it) and the beacon clears.
 *  Wired ONCE at server boot (server/index.ts) — unit tests mount the Hono app,
 *  not the entry, so this never auto-runs there. Idempotent + reload-safe (mirrors
 *  startAutoDrainLoop): the timer lives on globalThis and a re-eval CLEARS the old
 *  one before arming a fresh closure instead of stacking a second loop. `unref`'d
 *  so the loop alone never keeps the process alive (the HTTP listener already
 *  does). `opts` is forwarded to every sweep — production passes none (real
 *  defaults); tests inject an `isAlive` probe. Do NOT pin `opts.now` here: the
 *  loop wants the live clock so each tick re-measures the linger window. */
export const startTerminalSweepLoop = (
  intervalMs: number = TERMINAL_SWEEP_INTERVAL_MS,
  opts: SweepTerminalPoolOpts = {},
): void => {
  if (globalThis.__openground_terminal_sweep_timer) {
    clearInterval(globalThis.__openground_terminal_sweep_timer)
  }
  const timer = setInterval(() => {
    // A sweep must never crash the loop — it only ever reaps, never throws on a
    // well-formed pool, but defend the interval anyway.
    try { sweepTerminalPool(opts) } catch { /* keep the loop alive */ }
  }, intervalMs)
  // Don't let the sweep loop alone hold the process open (the HTTP listener already does).
  ;(timer as { unref?: () => void }).unref?.()
  globalThis.__openground_terminal_sweep_timer = timer
}

/** Stop the terminal-pool sweep loop (shutdown / test cleanup). Idempotent. */
export const stopTerminalSweepLoop = (): void => {
  if (globalThis.__openground_terminal_sweep_timer) {
    clearInterval(globalThis.__openground_terminal_sweep_timer)
    globalThis.__openground_terminal_sweep_timer = null
  }
}

/** Watch ONE PTY's exit without subscribing to its output — returns an
 *  unsubscribe, or null when the session is already gone.
 *
 *  {@link subscribeTerminal} is the wrong tool for a watcher that only cares
 *  THAT a session ended: it also registers a data listener, and a data listener
 *  participates in the ACK flow-control accounting (a subscriber that never ACKs
 *  can pause the PTY). A death-watch must be able to observe a desk without
 *  changing how that desk is scheduled. Exit listeners are fired by both teardown
 *  paths — node-pty's `onExit` and the janitor's {@link reapSession} — so an
 *  orphan whose exit event was lost still reaches the watcher.
 *
 *  The callback runs INSIDE teardown, before the session is dropped from the map,
 *  so {@link getTerminalScreen} still answers for it there. */
export const onTerminalExit = (
  id: string,
  onExit: (info: TerminalInfo) => void,
): (() => void) | null => {
  const s = sessions.get(id)
  if (!s) return null
  s.exitListeners.add(onExit)
  return () => s.exitListeners.delete(onExit)
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
