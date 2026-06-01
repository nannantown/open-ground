import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api-client'

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
}

interface Props {
  /** PTY id assigned by the runner when launching `claude` for this run. */
  terminalId: string
  /** Optional label rendered in the header (e.g. "task title — Project A"). */
  label?: string
  /** Fired when the PTY exits, so the surrounding panel can collapse / hide. */
  onExit?: (info: TerminalInfo) => void
}

// Embedded xterm.js bound to an EXISTING PTY (one launched by the runner via
// claudeTerminal.launchClaude). Unlike TerminalPane, this component:
//   - does not create or restart the PTY (the runner owns its lifecycle)
//   - does not persist the session id in localStorage (the run's
//     entry.terminalId is the source of truth)
//   - exposes a "Ctrl-C" affordance for soft-cancelling claude in place
//   - hides itself / signals exit when the PTY closes
export const ClaudeTerminalPane = ({ terminalId, label, onExit }: Props) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<any>(null)
  const fitRef = useRef<any>(null)
  const esRef = useRef<EventSource | null>(null)
  const [info, setInfo] = useState<TerminalInfo | null>(null)
  const [exited, setExited] = useState<TerminalInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

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
    setError(null)
    setExited(null)

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
        theme: {
          background: '#1a1a1a',
          foreground: '#e8e8e8',
          cursor: '#ffffff',
          cursorAccent: '#1a1a1a',
          selectionBackground: 'rgba(255,255,255,0.2)',
        },
        allowProposedApi: true,
        // Claude sessions can produce a lot of output — pad the scrollback
        // accordingly so a long agentic run stays fully visible.
        scrollback: 20000,
        convertEol: false,
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(hostRef.current)
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
      if (!probe) {
        setError(`PTY ${terminalId} not found — the run's terminal may have exited`)
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

      es = new EventSource(`/api/terminal/${terminalId}/stream`)
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
          onExitRef.current?.(inf)
        } catch {}
        try { es?.close() } catch {}
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
      try { resizeObs?.disconnect() } catch {}
      try { es?.close() } catch {}
      try { (term as any)?._ogContextCleanup?.() } catch {}
      try { (term as any)?._ogFocusCleanup?.() } catch {}
      try { term?.dispose() } catch {}
      termRef.current = null
      fitRef.current = null
      esRef.current = null
    }
  }, [terminalId, sendInput])

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-[#1a1a1a]">
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-3 py-1.5">
        <span className="font-mono text-[10px] text-ink-muted">
          claude {info ? `· ${info.cols}×${info.rows}` : ''}
          {label ? ` · ${label}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {exited ? (
            <span className="font-mono text-[10px] text-accent">
              exited{exited.exitCode != null ? ` (${exited.exitCode})` : ''}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => sendInput('')}
              className="font-mono text-[10px] text-ink-muted hover:text-ink"
              title="Send Ctrl-C to interrupt claude (twice within 3s = force-kill)"
            >
              Ctrl-C
            </button>
          )}
          {error && <span className="font-mono text-[10px] text-accent">{error}</span>}
        </div>
      </div>
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden bg-[#1a1a1a] px-2 py-2"
      />
    </div>
  )
}
