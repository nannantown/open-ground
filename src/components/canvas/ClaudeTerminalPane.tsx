import { useCallback, useEffect, useRef, useState } from 'react'
import { Power, RotateCcw } from 'lucide-react'
import { api } from '@/lib/api-client'
import { wireTerminalFileDrop } from '@/lib/terminalFileDrop'
import {
  initialSseState,
  sseReducer,
  RECONNECT_PILL_DELAY_MS,
  RECONNECT_GIVEUP_MS,
  type SseConnState,
  type SseInput,
} from '@/lib/sseReconnect'
import { useT } from '@/i18n/I18nContext'

export interface TerminalInfo {
  id: string
  cwd: string
  shell: string
  cols: number
  rows: number
  startedAt: string
  finishedAt?: string
  exitCode?: number
  tag?: 'shell' | 'claude'
  agentSessionId?: string
}

interface Props {
  /** PTY id assigned by the runner when launching `claude` for this run. */
  terminalId: string
  /** Optional label rendered in the header (e.g. "task title — Project A"). */
  label?: string
  /** Fired when the PTY exits, so the surrounding panel can collapse / hide. */
  onExit?: (info: TerminalInfo) => void
  /** Show the built-in header bar (claude · cols×rows · Ctrl-C). Default true.
   *  Set false when embedded under the split-pane's own header — Ctrl-C still
   *  works by typing it into the terminal, so no affordance is lost. */
  chrome?: boolean
  /** Re-launch this PTY after it exits. When provided, an exited/dead-probe PTY
   *  shows a centred "session ended · Restart" OVERLAY (instead of leaving a dead
   *  black screen with only a raw error). Clicking Restart calls this — the parent
   *  spawns the role-specific PTY (/api/swarm/{supply,manager,worker}) and swaps in
   *  the new terminalId, which re-keys this pane's effect and clears the exited
   *  state. The promise it returns drives the button's in-flight state so a second
   *  click can't double-launch (paired with the parent's own busy guard; and the
   *  parent best-effort kills the old id before spawning, so even a transient
   *  mount-probe false positive can't orphan a live session or race a second one).
   *  Omitted (the default — TaskTerminal / EmbeddedClaudeTerminal / a manager's
   *  read-only worker screen) = NO overlay; the pre-existing thin exit strip stays,
   *  so those callers are byte-for-byte unchanged. */
  onRestart?: () => void | Promise<void>
}

// Flow-control ACK threshold: once xterm has parsed this many UTF-16 code
// units (the same .length the server counts in trackFlowSent), report the
// progress via POST /api/terminal/:id/ack so the server can pause/resume the
// PTY on the un-acked backlog instead of buffering unboundedly.
const ACK_THRESHOLD = 65536

// Embedded xterm.js bound to an EXISTING PTY (one launched by the runner via
// claudeTerminal.launchClaude). Unlike TerminalPane, this component:
//   - does not create or restart the PTY (the runner owns its lifecycle)
//   - does not persist the session id in localStorage (the run's
//     entry.terminalId is the source of truth)
//   - exposes a "Ctrl-C" affordance for soft-cancelling claude in place
//   - hides itself / signals exit when the PTY closes
export const ClaudeTerminalPane = ({ terminalId, label, onExit, onRestart, chrome = true }: Props) => {
  const { t } = useT()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<any>(null)
  const fitRef = useRef<any>(null)
  const esRef = useRef<EventSource | null>(null)
  const [info, setInfo] = useState<TerminalInfo | null>(null)
  const [exited, setExited] = useState<TerminalInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A relaunch via onRestart is in flight — drives the overlay button's disabled
  // state so a second click can't fire a second spawn.
  const [restarting, setRestarting] = useState(false)
  // SSE output-stream status. The browser auto-reconnects on a transport drop
  // (and the next `init` repaints the screen), but a silent frozen terminal reads
  // as a hang — so a sustained drop surfaces a debounced "Reconnecting…" pill, and
  // a stream closed for good (readyState CLOSED, or a server 'not found') offers a
  // manual Reconnect. 'connecting' (initial) and 'open' show nothing.
  const [connState, setConnState] = useState<SseConnState>('connecting')
  // Bumped by the manual Reconnect button to re-key the spawn effect (re-probe +
  // re-open the stream) after the EventSource gave up.
  const [reconnectKey, setReconnectKey] = useState(0)

  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  // Latest onRestart without re-keying the spawn effect (mirrors onExitRef).
  const onRestartRef = useRef(onRestart)
  onRestartRef.current = onRestart

  // Restart the exited PTY: call the parent's role-specific relaunch, which swaps
  // in a new terminalId (re-keying the effect below, clearing exited/error). The
  // in-flight flag resets in finally so a failed relaunch (the parent surfaces the
  // error) leaves the button usable again. The overlay normally shows only on a
  // dead PTY; the parent's restart ALSO best-effort kills the old id before
  // spawning, so even a transient mount-probe false positive can't orphan a live
  // session or race a second one (the no-double-launch guarantee).
  const handleRestart = useCallback(async () => {
    const fn = onRestartRef.current
    if (!fn) return
    setRestarting(true)
    try {
      await fn()
    } catch {
      /* parent surfaces the failure; keep the overlay so the user can retry */
    } finally {
      setRestarting(false)
    }
  }, [])

  // Send a literal byte sequence to the PTY (used by Ctrl-C button and
  // keyboard input). No-op on null id.
  const sendInput = useCallback(async (data: string) => {
    if (!terminalId) return
    try {
      await fetch(`/api/terminal/${terminalId}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      })
    } catch {}
  }, [terminalId])

  useEffect(() => {
    let cancelled = false
    let term: any = null
    let fit: any = null
    let resizeObs: ResizeObserver | null = null
    let es: EventSource | null = null
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    // SSE connection state machine (pure logic in sseReconnect.ts). The pane owns
    // the side effects the reducer asks for: the two timers, es.close(), and
    // mirroring conn → React state. dispatch re-enters itself when a timer fires.
    let machine = initialSseState()
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let escalateTimer: ReturnType<typeof setTimeout> | null = null
    const dispatch = (input: SseInput) => {
      const { state, effects } = sseReducer(machine, input, EventSource.CLOSED)
      machine = state
      setConnState(state.conn)
      for (const eff of effects) {
        if (eff === 'arm-debounce') {
          if (!debounceTimer)
            debounceTimer = setTimeout(() => {
              debounceTimer = null
              dispatch({ kind: 'debounce' })
            }, RECONNECT_PILL_DELAY_MS)
        } else if (eff === 'arm-escalate') {
          if (!escalateTimer)
            escalateTimer = setTimeout(() => {
              escalateTimer = null
              dispatch({ kind: 'escalate' })
            }, RECONNECT_GIVEUP_MS)
        } else if (eff === 'clear-debounce') {
          if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
        } else if (eff === 'clear-escalate') {
          if (escalateTimer) { clearTimeout(escalateTimer); escalateTimer = null }
        } else if (eff === 'close-stream') {
          try { es?.close() } catch {}
        }
      }
    }
    setError(null)
    setExited(null)
    setConnState('connecting')

    ;(async () => {
      // Dynamic import so server-side bundling never reaches into xterm.
      const [{ Terminal }, { FitAddon }, webglMod] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        // The WebGL addon is an optional accelerator — keep it optional at
        // load time too: a failed chunk fetch (stale SPA after a redeploy)
        // must not take the whole terminal down with it.
        import('@xterm/addon-webgl').catch(() => null),
      ])
      if (cancelled || !hostRef.current) return

      term = new Terminal({
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 13,
        theme: {
          background: '#1a1a1a',
          foreground: '#e8e8e8',
          cursor: '#ffffff',
          cursorAccent: '#1a1a1a',
          selectionBackground: 'rgba(255,255,255,0.2)',
        },
        allowProposedApi: true,
        // Claude sessions produce a lot of output — keep enough scrollback to
        // revisit a long agentic run, but bounded: the buffer costs tens of MB
        // per terminal and that stacks up across simultaneous panes.
        scrollback: 10000,
        convertEol: false,
        // See TerminalPane.tsx — xterm snaps the viewport per wheel tick with
        // no interpolation by default; this animates it instead so trackpad
        // scrolling reads as smooth rather than choppy.
        smoothScrollDuration: 125,
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(hostRef.current)
      try {
        if (webglMod) {
          const webgl = new webglMod.WebglAddon()
          // Dispose on context loss so xterm falls back to the DOM renderer
          // instead of rendering into a dead canvas.
          webgl.onContextLoss(() => { try { webgl.dispose() } catch {} })
          term.loadAddon(webgl)
        }
      } catch {
        // WebGL2 unavailable (old GPU, software rendering, jsdom) — DOM renderer remains.
      }
      try { fit.fit() } catch {}
      termRef.current = term
      fitRef.current = fit

      // Probe the PTY metadata first. If the runner-assigned PTY has already
      // exited (server restart, race) we surface that rather than connecting
      // to a phantom stream.
      let probe: TerminalInfo | null = null
      try {
        const r = await api.api.terminal[':id'].$get({ param: { id: terminalId } })
        if (r.ok) probe = (await r.json()) as TerminalInfo
      } catch {}
      // Unmounted while the probe was in flight? Bail before touching state or
      // opening the stream. The cleanup already ran (es was still null then, so
      // its es?.close() was a no-op), so an EventSource created past this point
      // would leak — an open SSE + a server-side terminal listener that nothing
      // closes — and write into a disposed term. Mirrors the cancelled check
      // after the dynamic import above (and TerminalPane's guard before its es).
      if (cancelled) return
      if (!probe) {
        setError(`PTY ${terminalId} not found — the run's terminal may have exited`)
        // Signal exit so the embedding split-pane can offer a relaunch instead
        // of leaving a dead "not found" tile with no recovery.
        onExitRef.current?.({ id: terminalId } as TerminalInfo)
        return
      }
      setInfo(probe)
      if (probe.finishedAt) {
        setExited(probe)
        onExitRef.current?.(probe)
        return
      }

      const pushResize = () => {
        if (!fit || !termRef.current) return
        try { fit.fit() } catch {}
        const cols = termRef.current.cols
        const rows = termRef.current.rows
        fetch(`/api/terminal/${terminalId}/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cols, rows }),
        }).catch(() => {})
      }
      pushResize()

      // Flow-control identity for THIS stream: the server's init names the
      // flow (streamId) our ACKs credit. An older server sends none — then we
      // never ACK and it treats the flow as uncontrolled (no back-pressure),
      // exactly the pre-flow-control behavior.
      let streamId: string | null = null
      let ackPending = 0
      es = new EventSource(`/api/terminal/${terminalId}/stream`)
      esRef.current = es
      es.addEventListener('init', (ev: MessageEvent) => {
        // The stream is (re)connected — clear any pending reconnect notice/timers.
        dispatch({ kind: 'init' })
        try {
          const { replay, streamId: sid } = JSON.parse(ev.data)
          streamId = typeof sid === 'string' ? sid : null
          // Fresh flow, fresh accounting: parse progress still pending from a
          // previous connection belongs to the dead flow, never this one.
          ackPending = 0
          // Init is a FULL repaint, never an append (the server-side contract
          // in sse.ts): a reconnect — flow-control stall drop or EventSource
          // auto-retry — re-delivers the whole ring buffer, so writing it
          // onto the existing screen would double-paint everything. The reset
          // must ride the DATA path: ESC c (RIS) is the same full reset as
          // term.reset() (InputHandler.fullReset → core reset) but parses in
          // WriteBuffer order, AFTER any chunks of the previous connection
          // still queued unparsed — a stall drop guarantees such a queue —
          // whereas term.reset() applies immediately and would let those
          // stale chunks repaint on top of the fresh replay.
          term.write('\x1bc')
          if (replay) term.write(replay)
        } catch {}
      })
      es.addEventListener('data', (ev: MessageEvent) => {
        try {
          const { chunk } = JSON.parse(ev.data)
          if (chunk) {
            // Pin the chunk to the flow it arrived on: xterm's write callback
            // can run AFTER a reconnect swapped streamId (the chunk sat in
            // the WriteBuffer across a stall drop), and crediting the new
            // flow with the old flow's progress would bank phantom credit —
            // the server would under-count the new backlog and pause late.
            const sid = streamId
            // ACK from xterm's write callback — progress is reported only
            // once the chunk is actually parsed, so a renderer that falls
            // behind slows its ACKs and the server pauses the PTY for it.
            term.write(chunk, () => {
              if (!sid || sid !== streamId) return
              ackPending += chunk.length
              if (ackPending < ACK_THRESHOLD) return
              const bytes = ackPending
              ackPending = 0
              fetch(`/api/terminal/${terminalId}/ack`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ streamId: sid, bytes }),
              }).catch(() => {})
            })
          }
        } catch {}
      })
      es.addEventListener('exit', (ev: MessageEvent) => {
        // A clean PTY exit: stop the reconnect machine (the close that follows is
        // expected) before surfacing the exited overlay/strip.
        dispatch({ kind: 'exit' })
        try {
          const inf = JSON.parse(ev.data) as TerminalInfo
          setExited(inf)
          onExitRef.current?.(inf)
        } catch {}
        try { es?.close() } catch {}
      })
      es.addEventListener('error', (ev: Event) => {
        // A server NAMED error carries data (terminal: the PTY is gone); a plain
        // transport error has none. The reducer decides ignore/lost/retry and
        // closes the stream / arms the pill+escalation as needed.
        const data = (ev as MessageEvent).data
        dispatch({
          kind: 'error',
          hasData: typeof data === 'string' && !!data,
          readyState: es?.readyState ?? EventSource.CLOSED,
        })
      })

      // Forward keystrokes / paste to the PTY (claude TUI reads them as if
      // the user were typing directly in their terminal).
      term.onData((data: string) => { sendInput(data) })

      // Clipboard chords — same convention as TerminalPane. Cmd+C copies a
      // selection, Cmd+V pastes (image clipboard → file path), Cmd+A selects.
      const isMac =
        typeof navigator !== 'undefined' &&
        /Mac|iPhone|iPad/.test(navigator.platform)
      const isClipboardChord = (e: KeyboardEvent) =>
        isMac
          ? e.metaKey && !e.ctrlKey && !e.altKey
          : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey

      const performPaste = async () => {
        try {
          if (typeof (navigator.clipboard as any).read === 'function') {
            const items = await (navigator.clipboard as any).read()
            for (const item of items) {
              const imageType: string | undefined = item.types.find(
                (t: string) => t.startsWith('image/'),
              )
              if (!imageType) continue
              const blob: Blob = await item.getType(imageType)
              const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve(reader.result as string)
                reader.onerror = () => reject(reader.error)
                reader.readAsDataURL(blob)
              })
              const b64 = dataUrl.split(',')[1] ?? ''
              const r = await api.api['paste-image'].$post({
                json: { mime: imageType, dataBase64: b64 },
              })
              if (!r.ok) continue
              const { path } = (await r.json()) as { path?: string }
              if (path) { term.paste(path); return }
            }
          }
        } catch {}
        try {
          const text = await navigator.clipboard.readText()
          if (text) term.paste(text)
        } catch {}
      }

      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== 'keydown') return true
        // Shift+Enter inserts a newline rather than submit in claude's TUI.
        if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          sendInput('\x1b\r')
          return false
        }
        if (isClipboardChord(e)) {
          if (e.code === 'KeyC') {
            const sel = term.getSelection()
            if (sel) {
              e.preventDefault()
              navigator.clipboard.writeText(sel).catch(() => {})
              return false
            }
            return true
          }
          if (e.code === 'KeyV') {
            e.preventDefault()
            performPaste()
            return false
          }
          if (e.code === 'KeyA') {
            e.preventDefault()
            term.selectAll()
            return false
          }
        }
        return true
      })

      const refocus = () => { try { term.focus() } catch {} }
      hostRef.current?.addEventListener('mousedown', refocus)
      ;(term as any)._ogFocusCleanup = () =>
        hostRef.current?.removeEventListener('mousedown', refocus)

      const onContextMenu = (e: MouseEvent) => {
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) navigator.clipboard.writeText(sel).catch(() => {})
        else performPaste()
      }
      hostRef.current?.addEventListener('contextmenu', onContextMenu)
      ;(term as any)._ogContextCleanup = () =>
        hostRef.current?.removeEventListener('contextmenu', onContextMenu)

      // Drop a file on the pane → its absolute path is pasted, iTerm-style
      // (Electron bridge path, or upload fallback in a plain browser).
      if (hostRef.current) {
        ;(term as any)._ogDropCleanup = wireTerminalFileDrop(hostRef.current, term)
      }

      if (typeof ResizeObserver !== 'undefined' && hostRef.current) {
        resizeObs = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(pushResize, 80)
        })
        resizeObs.observe(hostRef.current)
      }

      setTimeout(() => term?.focus(), 0)
    })()

    return () => {
      cancelled = true
      if (resizeTimer) clearTimeout(resizeTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      if (escalateTimer) clearTimeout(escalateTimer)
      try { resizeObs?.disconnect() } catch {}
      try { es?.close() } catch {}
      try { (term as any)?._ogDropCleanup?.() } catch {}
      try { (term as any)?._ogContextCleanup?.() } catch {}
      try { (term as any)?._ogFocusCleanup?.() } catch {}
      try { term?.dispose() } catch {}
      termRef.current = null
      fitRef.current = null
      esRef.current = null
    }
  }, [terminalId, sendInput, reconnectKey])

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-[#1a1a1a]">
      {chrome ? (
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-3 py-1.5">
        <span className="font-mono text-micro text-ink-muted">
          claude {info ? `· ${info.cols}×${info.rows}` : ''}
          {label ? ` · ${label}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {exited ? (
            <span className="font-mono text-micro text-accent">
              exited{exited.exitCode != null ? ` (${exited.exitCode})` : ''}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => sendInput('\x03')}
              className="font-mono text-micro text-ink-muted hover:text-ink"
              title="Send Ctrl-C to interrupt claude (twice within 3s = force-kill)"
            >
              Ctrl-C
            </button>
          )}
          {error && <span className="font-mono text-micro text-accent">{error}</span>}
        </div>
      </div>
      ) : (
        // Embedded: no header bar. With NO onRestart, surface the pre-existing
        // thin exit/error strip (unchanged for TaskTerminal / EmbeddedClaude /
        // the manager's read-only worker screen). With onRestart wired, the
        // centred overlay below owns the exit affordance, so this strip is
        // suppressed to avoid a duplicate notice.
        (exited || error) && !onRestart && (
          <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-3 py-1">
            {exited && (
              <span className="font-mono text-micro text-accent">
                exited{exited.exitCode != null ? ` (${exited.exitCode})` : ''}
              </span>
            )}
            {error && <span className="font-mono text-micro text-accent">{error}</span>}
          </div>
        )
      )}
      {/* Terminal viewport + (when a relaunch is wired) the exit overlay. The
          wrapper is `relative` so the overlay covers ONLY the terminal area, not
          the header/strip above — the last screen of output stays dimly visible
          behind it rather than collapsing to a black void with a raw error. */}
      {/* The padding lives on THIS wrapper, not on hostRef — see TerminalPane.tsx
          for why: @xterm/addon-fit reads padding off terminal.element (never
          padded) instead of hostRef (term.element's actual parent), so padding
          placed directly on hostRef is silently dropped from FitAddon's row
          math, overshooting the computed row count and clipping the bottom of
          the pane under hostRef's overflow-hidden. */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#1a1a1a] px-2 py-2">
        <div
          ref={hostRef}
          className="h-full w-full overflow-hidden"
        />
        {/* SSE reconnect pill — overlays the top of the viewport (no layout shift,
            so xterm isn't resized) when the output stream drops. Suppressed once
            the PTY has exited or a probe error is shown (those own the affordance). */}
        {!exited && !error && (connState === 'reconnecting' || connState === 'lost') && (
          <div className="absolute left-1/2 top-2 z-20 -translate-x-1/2">
            <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/70 px-3 py-1 text-meta text-white/80 shadow-lg backdrop-blur-[1px]">
              {connState === 'reconnecting' ? (
                <>
                  <RotateCcw size={11} strokeWidth={2.25} className="animate-spin" aria-hidden />
                  <span>{t('misc.terminal.reconnecting')}</span>
                </>
              ) : (
                <>
                  <span className="text-accent">{t('misc.terminal.connectionLost')}</span>
                  <button
                    type="button"
                    onClick={() => setReconnectKey((k) => k + 1)}
                    className="rounded-full bg-white/10 px-2 py-0.5 font-medium text-white/90 transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                  >
                    {t('misc.terminal.reconnect')}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {onRestart && (exited || error) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[1px]">
            <div className="flex max-w-[260px] flex-col items-center gap-3 rounded-[6px] border border-white/15 bg-[#222222] px-5 py-4 text-center shadow-lg">
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-white/70"
                aria-hidden
              >
                <Power size={17} strokeWidth={1.75} />
              </span>
              <div>
                <p className="text-ui font-medium text-white/90">
                  {t('projectPanel.swarm.sessionEnded')}
                </p>
                {exited?.exitCode != null && (
                  <p className="mt-1 font-mono text-micro text-white/40">
                    {t('projectPanel.swarm.sessionExitCode', { code: String(exited.exitCode) })}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleRestart()}
                disabled={restarting}
                className="inline-flex items-center gap-1.5 rounded-[4px] bg-white px-3.5 py-1.5 text-ui font-medium text-black transition-colors hover:bg-white/90 active:bg-white/80 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <RotateCcw
                  size={13}
                  strokeWidth={2.25}
                  className={restarting ? 'animate-spin' : undefined}
                  aria-hidden
                />
                {restarting ? t('projectPanel.swarm.restarting') : t('projectPanel.swarm.restart')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
