import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { migrateLs } from '@/lib/lsMigrate'
import { api } from '@/lib/api-client'
import { wireTerminalFileDrop } from '@/lib/terminalFileDrop'
export interface TerminalPaneHandle {
  /** Kill the current PTY and start a fresh shell session. */
  restart: () => void
  /** Write raw bytes to the PTY stdin (caller appends '\r' to run a command).
   *  Used by the onboarding install guide to drive the shell step-by-step. */
  sendText: (text: string) => void
}

interface Props {
  /** Project directory the shell launches in (ignored when mode='setup'). */
  projectPath: string
  /** 'project' (default) opens a shell in projectPath via /api/terminal.
   *  'setup' opens a login shell in the user's HOME via /api/setup-terminal —
   *  for first-run onboarding, where no project exists yet. */
  mode?: 'project' | 'setup'
  /** Identifier for which terminal "slot" within the project this pane drives,
   *  so multiple terminals on the same project keep their own PTY sessions.
   *  Defaults to 'default' for legacy single-terminal callers; that slot also
   *  migrates the older un-slotted localStorage key on first read. */
  slotKey?: string
  /** Fired whenever the attached session's info changes (shell, size, exit).
   *  ProjectPanel uses this to render `zsh 163×44` inside the Terminal tab. */
  onInfo?: (info: TerminalInfo | null) => void
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

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
  { projectPath, slotKey = 'default', onInfo, mode = 'project' },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<any>(null)
  const fitRef = useRef<any>(null)
  const esRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [info, setInfo] = useState<TerminalInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState<TerminalInfo | null>(null)
  // Mirror info upward so the surrounding tab can render `zsh 163×44`. Held
  // in a ref so an inline parent callback doesn't re-fire the effect every
  // render.
  const onInfoRef = useRef(onInfo)
  onInfoRef.current = onInfo
  useEffect(() => {
    onInfoRef.current?.(exited ?? info)
  }, [info, exited])
  // Bumped to force a fresh session (after kill / exit / restart click).
  const [reloadKey, setReloadKey] = useState(0)

  // Create or attach to a terminal session for this project.
  // 1. Try the cached session id — if the server still has it, reattach.
  // 2. Otherwise POST a new one with the current host element size.
  const ensureSession = useCallback(async (): Promise<TerminalInfo | null> => {
    // Setup mode: a HOME-cwd shell for first-run onboarding. Reattach to a
    // cached session if the server still has it, else POST /api/setup-terminal
    // (no cwd / no project gate). Kept separate from the project path below.
    if (mode === 'setup') {
      const setupKey = 'openground.terminal.session.__setup__'
      const host = hostRef.current
      const cols = host ? Math.max(40, Math.floor(host.clientWidth / 9)) : 100
      const rows = host ? Math.max(10, Math.floor(host.clientHeight / 18)) : 30
      const cachedSetup = localStorage.getItem(setupKey)
      if (cachedSetup) {
        try {
          const r = await api.api.terminal[':id'].$get({ param: { id: cachedSetup } })
          if (r.ok) {
            const inf = (await r.json()) as TerminalInfo
            if (!inf.finishedAt) return inf
          }
        } catch {}
        localStorage.removeItem(setupKey)
      }
      const r = await fetch('/api/setup-terminal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      })
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error ?? r.statusText)
      }
      const inf = (await r.json()) as TerminalInfo
      localStorage.setItem(setupKey, inf.id)
      return inf
    }
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
  }, [projectPath, slotKey, mode])

  // Mount xterm.js + open SSE. Re-runs only when projectPath or reloadKey changes.
  useEffect(() => {
    let cancelled = false
    let term: any = null
    let fit: any = null
    let resizeObs: ResizeObserver | null = null
    let es: EventSource | null = null
    let resizeTimer: ReturnType<typeof setTimeout> | null = null

    ;(async () => {
      // Dynamic import so server-side bundling never reaches into xterm.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
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
      try { fit.fit() } catch {}
      termRef.current = term
      fitRef.current = fit

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
      es = new EventSource(`/api/terminal/${session.id}/stream`)
      esRef.current = es
      es.addEventListener('init', (ev: MessageEvent) => {
        try {
          const { replay } = JSON.parse(ev.data)
          if (replay) term.write(replay)
        } catch {}
      })
      es.addEventListener('data', (ev: MessageEvent) => {
        try {
          const { chunk } = JSON.parse(ev.data)
          if (chunk) term.write(chunk)
        } catch {}
      })
      es.addEventListener('exit', (ev: MessageEvent) => {
        try {
          const inf = JSON.parse(ev.data) as TerminalInfo
          setExited(inf)
        } catch {}
        try { es?.close() } catch {}
        // Wipe the cached id so the next mount opens a fresh shell.
        try { localStorage.removeItem(sessionKey(projectPath, slotKey)) } catch {}
      })
      es.addEventListener('error', () => {
        // Fires on transport errors too; keep quiet, browser auto-retries.
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
      <div
        ref={hostRef}
        // xterm.js draws inside this div. The padding gives the cursor a bit
        // of breathing room from the panel edges without confusing fit's math
        // (its measurements are relative to this container).
        className="min-h-0 flex-1 overflow-hidden bg-[#1a1a1a] px-2 py-2"
      />
    </div>
  )
})
