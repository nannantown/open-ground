import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { RotateCcw } from 'lucide-react'
import { migrateLs } from '@/lib/lsMigrate'
import { api } from '@/lib/api-client'
import { sanitizePaneTitle } from '@/lib/paneTitle'
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
export interface TerminalPaneHandle {
  /** Kill the current PTY and start a fresh shell session. */
  restart: () => void
  /** Write raw bytes to the PTY stdin (caller appends '\r' to run a command). */
  sendText: (text: string) => void
}

interface Props {
  /** Project directory the shell launches in. */
  projectPath: string
  /** Identifier for which terminal "slot" within the project this pane drives,
   *  so multiple terminals on the same project keep their own PTY sessions.
   *  Defaults to 'default' for legacy single-terminal callers; that slot also
   *  migrates the older un-slotted localStorage key on first read. */
  slotKey?: string
  /** Fired whenever the attached session's info changes (shell, size, exit).
   *  ProjectPanel uses this to render `zsh 163×44` inside the Terminal tab. */
  onInfo?: (info: TerminalInfo | null) => void
  /** Fired when the PTY emits an OSC title escape (xterm's onTitleChange) —
   *  Claude Code sets a live topic summary this way. Already sanitized;
   *  empty/whitespace titles are dropped. ProjectPanel shows it in the pane
   *  header. `null` means "drop the shown title" — fired when the session
   *  exits and when a fresh session (re)connects, so a stale title from a
   *  dead session never lingers over a new shell. A live session's title is
   *  restored best-effort by SSE replay (the replay buffer is bounded, so a
   *  title that scrolled far past the cap is lost on reload). */
  onTitle?: (title: string | null) => void
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
}

// localStorage key — survives panel close/re-open within one browser session
// so users can step away from the terminal without losing the session.
const sessionKey = (projectPath: string, slot: string) =>
  `openground.terminal.session.${projectPath}.${slot}`
// Old namespace key. Read on first load to carry users across the
// Hove → OPEN GROUND rename without losing their existing PTY.
const legacyNsSessionKey = (projectPath: string, slot: string) =>
  `hove.terminal.session.${projectPath}.${slot}`
// The pre-slot, single-terminal key. Only the 'default' slot honours it, on
// first load, so users upgrading from the single-terminal era keep their
// PTY. Two forms — current namespace and the older `hove.*` one.
const preSlotSessionKey = (projectPath: string) =>
  `openground.terminal.session.${projectPath}`
const legacyNsPreSlotSessionKey = (projectPath: string) =>
  `hove.terminal.session.${projectPath}`

// Flow-control ACK threshold: once xterm has parsed this many UTF-16 code
// units (the same .length the server counts in trackFlowSent), report the
// progress via POST /api/terminal/:id/ack so the server can pause/resume the
// PTY on the un-acked backlog instead of buffering unboundedly.
const ACK_THRESHOLD = 65536

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
  { projectPath, slotKey = 'default', onInfo, onTitle },
  ref,
) {
  const { t } = useT()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<any>(null)
  const fitRef = useRef<any>(null)
  const esRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [info, setInfo] = useState<TerminalInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState<TerminalInfo | null>(null)
  // SSE output-stream status. The browser auto-reconnects on a transport drop
  // (and the next `init` repaints), but a silent frozen terminal reads as a hang —
  // so a sustained drop surfaces a debounced "Reconnecting…" pill, and a stream
  // closed for good offers a manual Reconnect (which re-attaches to the same PTY
  // via the reloadKey path below). 'connecting' (initial) and 'open' show nothing.
  const [connState, setConnState] = useState<SseConnState>('connecting')
  // Mirror info upward so the surrounding tab can render `zsh 163×44`. Held
  // in a ref so an inline parent callback doesn't re-fire the effect every
  // render.
  const onInfoRef = useRef(onInfo)
  onInfoRef.current = onInfo
  useEffect(() => {
    onInfoRef.current?.(exited ?? info)
  }, [info, exited])
  // Same ref trick for the OSC-title callback.
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle
  // Bumped to force a fresh session (after kill / exit / restart click).
  const [reloadKey, setReloadKey] = useState(0)

  // Create or attach to a terminal session for this project.
  // 1. Try the cached session id — if the server still has it, reattach.
  // 2. Otherwise POST a new one with the current host element size.
  const ensureSession = useCallback(async (): Promise<TerminalInfo | null> => {
    const key = sessionKey(projectPath, slotKey)
    // Walk both legacy paths forward: prior namespace (hove.*) per-slot and
    // both namespaces' pre-slot single-terminal keys. Idempotent — runs on
    // every read but converges once the new key is populated.
    migrateLs(legacyNsSessionKey(projectPath, slotKey), key)
    let cached = localStorage.getItem(key)
    if (!cached && slotKey === 'default') {
      for (const fn of [preSlotSessionKey, legacyNsPreSlotSessionKey]) {
        const legacy = localStorage.getItem(fn(projectPath))
        if (legacy) {
          cached = legacy
          localStorage.setItem(key, legacy)
          localStorage.removeItem(fn(projectPath))
          break
        }
      }
    }
    if (cached) {
      try {
        const r = await api.api.terminal[':id'].$get({ param: { id: cached } })
        if (r.ok) {
          const inf = (await r.json()) as TerminalInfo
          if (!inf.finishedAt) return inf
        }
      } catch {}
      localStorage.removeItem(key)
    }
    const host = hostRef.current
    const cols = host ? Math.max(40, Math.floor(host.clientWidth / 9)) : 100
    const rows = host ? Math.max(10, Math.floor(host.clientHeight / 18)) : 30
    const r = await api.api.terminal.$post({
      json: { cwd: projectPath, cols, rows },
    })
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(e.error ?? r.statusText)
    }
    const inf = (await r.json()) as TerminalInfo
    localStorage.setItem(key, inf.id)
    return inf
  }, [projectPath, slotKey])

  // Mount xterm.js + open SSE. Re-runs only when projectPath or reloadKey changes.
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
        // Match the OPEN GROUND dark sidebar so the terminal feels native, not pasted.
        theme: {
          background: '#1a1a1a',
          foreground: '#e8e8e8',
          cursor: '#ffffff',
          cursorAccent: '#1a1a1a',
          selectionBackground: 'rgba(255,255,255,0.2)',
        },
        allowProposedApi: true,
        scrollback: 5000,
        convertEol: false,
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

      // Fresh terminal for this (re)connect — drop any title left over from a
      // previous session in this slot (restart, exit-then-remount). A live
      // session's own title comes right back via the SSE replay below.
      onTitleRef.current?.(null)

      // OSC title escapes (ESC ]0;...BEL etc.) — xterm parses them; Claude
      // Code emits a live topic summary this way. Disposed with the terminal.
      term.onTitleChange((raw: string) => {
        const title = sanitizePaneTitle(raw)
        if (title) onTitleRef.current?.(title)
      })

      let session: TerminalInfo
      try {
        const result = await ensureSession()
        if (!result) return
        session = result
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'failed to start terminal')
        return
      }
      if (cancelled) return
      sessionIdRef.current = session.id
      setInfo(session)
      setExited(null)
      setError(null)

      // Push initial size to the server so the shell matches the visible area.
      const pushResize = () => {
        if (!fit || !termRef.current || !sessionIdRef.current) return
        try { fit.fit() } catch {}
        const cols = termRef.current.cols
        const rows = termRef.current.rows
        fetch(`/api/terminal/${sessionIdRef.current}/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cols, rows }),
        }).catch(() => {})
      }
      pushResize()

      // Subscribe to output.
      // Flow-control identity for THIS stream: the server's init names the
      // flow (streamId) our ACKs credit. An older server sends none — then we
      // never ACK and it treats the flow as uncontrolled (no back-pressure),
      // exactly the pre-flow-control behavior.
      let streamId: string | null = null
      let ackPending = 0
      es = new EventSource(`/api/terminal/${session.id}/stream`)
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
              fetch(`/api/terminal/${sessionIdRef.current ?? session.id}/ack`, {
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
        // expected) before surfacing the exited strip.
        dispatch({ kind: 'exit' })
        try {
          const inf = JSON.parse(ev.data) as TerminalInfo
          setExited(inf)
        } catch {}
        try { es?.close() } catch {}
        // The session is dead — the header must not keep advertising what WAS
        // running, so drop its title.
        onTitleRef.current?.(null)
        // Wipe the cached id so the next mount opens a fresh shell.
        try { localStorage.removeItem(sessionKey(projectPath, slotKey)) } catch {}
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

      // Forward keystrokes / paste to the PTY.
      term.onData((data: string) => {
        if (!sessionIdRef.current) return
        fetch(`/api/terminal/${sessionIdRef.current}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data }),
        }).catch(() => {})
      })

      // Mac-style clipboard shortcuts. We intercept BEFORE xterm processes the
      // key so Cmd+C never reaches the PTY as a literal character. (Ctrl+C
      // still sends SIGINT — it's untouched.) On non-Mac we use Ctrl+Shift+*,
      // the convention every Linux/Windows terminal emulator follows.
      const isMac =
        typeof navigator !== 'undefined' &&
        /Mac|iPhone|iPad/.test(navigator.platform)
      const isClipboardChord = (e: KeyboardEvent) =>
        isMac
          ? e.metaKey && !e.ctrlKey && !e.altKey
          : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey

      // Pull from the system clipboard and feed it through xterm's paste
      // pipeline. When the clipboard holds an image (a screenshot, a copied
      // image from a browser), save it to ~/.openground/paste/ via the API and
      // paste its absolute path — Claude Code running in the PTY can then
      // Read the file. Falls back to text otherwise.
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
              if (path) {
                term.paste(path)
                return
              }
            }
          }
        } catch {
          // clipboard.read() throws on permission denial or when the page
          // isn't focused. Either way, fall through to the text path.
        }
        try {
          const text = await navigator.clipboard.readText()
          if (text) term.paste(text)
        } catch {}
      }

      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== 'keydown') return true
        // Shift+Enter inserts a newline instead of submitting. We send the
        // ESC+CR sequence Claude Code's readline interprets as "newline
        // without submit" — same convention iTerm2 / Terminal.app pick up
        // after running `/terminal-setup` in Claude Code.
        if (
          e.key === 'Enter' &&
          e.shiftKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          e.preventDefault()
          const id = sessionIdRef.current
          if (id) {
            fetch(`/api/terminal/${id}/input`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ data: '\x1b\r' }),
            }).catch(() => {})
          }
          return false
        }
        if (isClipboardChord(e)) {
          // Copy: only when there's a selection. Without one we let the event
          // through so Cmd+C in an empty terminal does nothing weird and
          // Ctrl+C (different chord) keeps sending SIGINT.
          if (e.code === 'KeyC') {
            const sel = term.getSelection()
            if (sel) {
              e.preventDefault()
              navigator.clipboard.writeText(sel).catch(() => {})
              return false
            }
            return true
          }
          // Paste: feed clipboard content (text or image-saved-to-path)
          // through xterm's paste pipeline, which handles bracketed-paste
          // so the shell can tell typed input apart from pasted input.
          //
          // preventDefault is critical here — without it the browser's native
          // `paste` event still fires on xterm's hidden textarea, xterm's
          // built-in paste handler runs too, and the shell gets the text
          // twice. The doubled-paste symptom for dictation tools (Wispr Flow
          // etc.) that synthesize Cmd+V was exactly this.
          if (e.code === 'KeyV') {
            e.preventDefault()
            performPaste()
            return false
          }
          // Select-all maps to xterm's built-in selectAll. The PTY never sees
          // the chord.
          if (e.code === 'KeyA') {
            e.preventDefault()
            term.selectAll()
            return false
          }
        }
        return true
      })

      // xterm's own click-to-focus only fires on its own DOM. Clicks that
      // land in the host element's padding (or in our outer dark background)
      // miss it, so the user can be looking at the cursor but not actually
      // focused on the textarea — arrow keys then go nowhere. Snap focus
      // back on any pointer event inside the pane.
      const refocus = () => {
        try { term.focus() } catch {}
      }
      hostRef.current?.addEventListener('mousedown', refocus)
      ;(term as any)._ogFocusCleanup = () =>
        hostRef.current?.removeEventListener('mousedown', refocus)

      // Right-click → copy if there's a selection, otherwise paste. Mirrors
      // the long-standing Linux xterm convention and works well as a quick
      // mouse-only alternative to the keyboard chords above.
      const onContextMenu = (e: MouseEvent) => {
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {})
        } else {
          performPaste()
        }
      }
      hostRef.current?.addEventListener('contextmenu', onContextMenu)
      // Cleanup registered via the outer effect's return value — captured here
      // so the listener gets removed if the component unmounts mid-session.
      ;(term as any)._ogContextCleanup = () =>
        hostRef.current?.removeEventListener('contextmenu', onContextMenu)

      // Drop a file on the pane → its absolute path is pasted, iTerm-style
      // (Electron bridge path, or upload fallback in a plain browser).
      if (hostRef.current) {
        ;(term as any)._ogDropCleanup = wireTerminalFileDrop(hostRef.current, term)
      }

      // Refit on container resize (debounced so a drag doesn't spam the PTY).
      if (typeof ResizeObserver !== 'undefined' && hostRef.current) {
        resizeObs = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(pushResize, 80)
        })
        resizeObs.observe(hostRef.current)
      }

      // Focus so the user can type immediately.
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
      // NOTE: we intentionally don't kill the PTY here — the user can re-open
      // the panel and reattach. The PTY only dies if the user clicks Restart,
      // the shell exits on its own, or the server is restarted.
    }
  }, [projectPath, reloadKey, ensureSession])

  const restart = useCallback(async () => {
    const id = sessionIdRef.current
    if (id) {
      try {
        await api.api.terminal[':id'].$delete({ param: { id } })
      } catch {}
    }
    sessionIdRef.current = null
    localStorage.removeItem(sessionKey(projectPath, slotKey))
    setReloadKey(k => k + 1)
  }, [projectPath, slotKey])

  const sendText = useCallback((text: string) => {
    const id = sessionIdRef.current
    if (!id) return
    fetch(`/api/terminal/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: text }),
    }).catch(() => {})
    try { termRef.current?.focus() } catch {}
  }, [])

  useImperativeHandle(ref, () => ({ restart, sendText }), [restart, sendText])

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-[#1a1a1a]">
      {/* Shell info (zsh · cols×rows) has moved into the Terminal tab in the
       *  parent ViewTabs — no need to repeat it here. We keep this slim row
       *  only when there's actionable status (exit / error) or for the
       *  Restart affordance. */}
      {(exited || error) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-4 py-1.5">
          {exited && (
            <span className="font-mono text-[10px] text-accent">
              exited ({exited.exitCode ?? '?'})
            </span>
          )}
          {error && (
            <span className="font-mono text-[10px] text-accent">{error}</span>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          // xterm.js draws inside this div. The padding gives the cursor a bit
          // of breathing room from the panel edges without confusing fit's math
          // (its measurements are relative to this container).
          className="h-full w-full overflow-hidden bg-[#1a1a1a] px-2 py-2"
        />
        {/* SSE reconnect pill — overlays the top of the viewport (no layout shift,
            so xterm isn't resized) when the output stream drops. Suppressed once
            the session has exited or an error strip is shown. */}
        {!exited && !error && (connState === 'reconnecting' || connState === 'lost') && (
          <div className="absolute left-1/2 top-2 z-20 -translate-x-1/2">
            <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/70 px-3 py-1 text-[11px] text-white/80 shadow-lg backdrop-blur-[1px]">
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
                    onClick={() => setReloadKey((k) => k + 1)}
                    className="rounded-full bg-white/10 px-2 py-0.5 font-medium text-white/90 transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                  >
                    {t('misc.terminal.reconnect')}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
})
