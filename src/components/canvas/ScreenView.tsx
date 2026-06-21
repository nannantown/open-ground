import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, MonitorSmartphone, Sparkles, X } from 'lucide-react'
import type { CanvasElement, TweakScreenRequest, TweakScreenResponse } from '@/lib/types'
import { buildScreenSrcdoc, hash32 } from '@/lib/screenSrcdoc'
import type { InspectPick } from '@/lib/canvasInspect'
import { resolveOpacity } from '@/lib/canvasTransform'
import { useT } from '@/i18n/I18nContext'
import { ClaudeTerminalPane } from './ClaudeTerminalPane'

interface Props {
  element: CanvasElement
  selected: boolean
  editing: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onChangeText: (text: string) => void
  onEditDone: () => void
  ring: string
  /** True while the Comment tool is active — the overlay drops its grab cursor
   *  so the canvas wrapper's comment-bubble cursor shows over the screen. */
  commentTool?: boolean
  /** Project path for /api/canvas/tweak-screen — absent on surfaces that
   *  don't carry one (the tweak button simply hides then). */
  projectPath?: string
}

// ── Tweak (inspect-and-instruct) — shared by ScreenView and MockView ─────────
//
// Owns the in-tile "tweak" flow: a toggle next to the Interactive badge flips
// the iframe's inspect bridge on (see src/lib/canvasInspect.ts); clicking an
// element inside the design reports a pick; a bottom panel takes a natural-
// language instruction and POSTs /api/canvas/tweak-screen; the rewritten
// source flows out through the SAME onChangeText path a manual edit uses, so
// persistence + undo behave identically and the iframe re-renders itself.
//
// Returned pieces: `badge` (the Interactive pill + tweak toggle cluster, only
// while selected), `panel` (the picked-element instruction panel), and
// `onIframeLoad` (re-arms the bridge after the iframe remounts on a new
// srcdoc — e.g. right after a tweak applies).
export function useInspectTweak({
  iframeRef,
  selected,
  projectPath,
  source,
  framework,
  onChangeText,
}: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  selected: boolean
  projectPath?: string
  source: string
  framework: 'react' | 'html'
  onChangeText: (text: string) => void
}) {
  const { t } = useT()
  const [inspecting, setInspecting] = useState(false)
  const [picked, setPicked] = useState<InspectPick | null>(null)
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // Signed-out (503 { claudeLoggedOut }): the run gate refuses to spawn a
  // signed-out claude, so instead of a generic error we surface a "sign in to
  // Claude" CTA that opens the dedicated login terminal (below). claudeMissing
  // keeps its own install-guidance copy.
  const [loggedOut, setLoggedOut] = useState(false)
  // "Sign in to Claude" terminal — the SAME single login PTY the Board drawer
  // and the Canvas generate bar use (POST /api/terminal/claude-login → a plain
  // claude PTY that runs its OAuth once). Self-contained in the hook so both
  // ScreenView and MockView get the flow with no new prop from their shells.
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginPty, setLoginPty] = useState<string | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)
  const loginInFlight = useRef(false)

  const sendInspect = useCallback(
    (on: boolean) => {
      iframeRef.current?.contentWindow?.postMessage({ og: 'inspect', on }, '*')
    },
    [iframeRef],
  )

  // Push the mode into the iframe whenever it flips.
  useEffect(() => {
    sendInspect(inspecting)
  }, [inspecting, sendInspect])

  // Deselecting the tile exits tweak mode entirely (panel included).
  useEffect(() => {
    if (selected) return
    setInspecting(false)
    setPicked(null)
    setInstruction('')
    setNotice(null)
    setLoggedOut(false)
  }, [selected])

  // Receive picks — only from OUR iframe (e.source identifies the tile even
  // though the sandboxed window is cross-origin-opaque).
  useEffect(() => {
    if (!inspecting) return
    const onMsg = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return
      const d = e.data as { og?: string; payload?: InspectPick } | null
      if (!d || d.og !== 'pick' || !d.payload) return
      // Re-clamp here: the sandboxed content fully controls its own window,
      // so the bridge's own truncation is a courtesy, not a boundary.
      const raw = d.payload as Partial<InspectPick>
      const clamp = (v: unknown, max: number) =>
        typeof v === 'string' ? v.slice(0, max) : ''
      setPicked({
        tag: clamp(raw.tag, 100) || 'div',
        classes: clamp(raw.classes, 1000),
        text: clamp(raw.text, 200),
        html: clamp(raw.html, 2000),
        rect: raw.rect && typeof raw.rect === 'object' ? raw.rect : undefined,
      } as InspectPick)
      setNotice(null)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [inspecting, iframeRef])

  // In-flight tweak — abortable: closing the panel cancels the request and
  // the abort kills the server-side claude session. Without this, ✕ during
  // pending closed the panel but the response landed later and silently
  // rewrote the design behind the user's back.
  const abortRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  const close = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setInspecting(false)
    setPicked(null)
    setInstruction('')
    setNotice(null)
    setLoggedOut(false)
  }, [])

  const submit = useCallback(async () => {
    if (pending || !picked || !projectPath || !instruction.trim()) return
    setPending(true)
    setNotice(null)
    setLoggedOut(false)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const body: TweakScreenRequest = {
        path: projectPath,
        source,
        framework,
        instruction: instruction.trim(),
        element: {
          tag: picked.tag,
          classes: picked.classes,
          text: picked.text,
          html: picked.html,
        },
      }
      const res = await fetch('/api/canvas/tweak-screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      const json = (await res.json().catch(() => ({}))) as Partial<TweakScreenResponse> & {
        error?: string
        claudeMissing?: boolean
        claudeLoggedOut?: boolean
      }
      if (!res.ok || typeof json.source !== 'string') {
        // Installed-but-signed-out (503) gets the sign-in CTA instead of a
        // generic error; claudeMissing keeps its install guidance.
        if (json.claudeLoggedOut) {
          setLoggedOut(true)
        } else {
          setNotice({
            kind: 'err',
            text: json.claudeMissing
              ? t('canvasEl.tweak.claudeMissing')
              : json.error || t('canvasEl.tweak.error'),
          })
        }
      } else if (json.unchanged) {
        // claude judged the instruction already satisfied — informational.
        setNotice({ kind: 'ok', text: t('canvasEl.tweak.unchanged') })
      } else {
        // Same persistence path as a manual code edit — undo/redo included.
        onChangeText(json.source)
        setInstruction('')
        // The pick snapshot describes the PRE-rewrite DOM; against the new
        // source it would mislead the next tweak. Ask for a fresh pick (the
        // bridge re-arms on iframe load, so it's one click).
        setPicked(null)
        setNotice({ kind: 'ok', text: t('canvasEl.tweak.applied') })
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setNotice({ kind: 'err', text: t('canvasEl.tweak.error') })
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setPending(false)
    }
  }, [pending, picked, projectPath, instruction, source, framework, onChangeText, t])

  // ── "Sign in to Claude" terminal (signed-out tweak) ──────────────────────
  // tweak-screen answers 503 { claudeLoggedOut } when the CLI is installed but
  // signed out. Rather than dead-end on a generic error, the CTA opens the SAME
  // single login terminal the Board drawer + Canvas generate bar use (POST
  // /api/terminal/claude-login → a plain claude PTY that runs its OAuth once).
  const openClaudeLogin = useCallback(async () => {
    setLoginOpen(true)
    // Single-flight + single instance: a second click re-focuses the open
    // terminal instead of spawning a twin.
    if (loginPty || loginInFlight.current) return
    loginInFlight.current = true
    setLoginError(null)
    try {
      const r = await fetch('/api/terminal/claude-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: projectPath }),
      })
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string }
        setLoginError(b.error || `HTTP ${r.status}`)
        return
      }
      const info = (await r.json().catch(() => ({}))) as { id?: string }
      if (info.id) setLoginPty(info.id)
      else setLoginError(`HTTP ${r.status}`)
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e))
    } finally {
      loginInFlight.current = false
    }
  }, [projectPath, loginPty])

  const closeClaudeLogin = useCallback(() => {
    setLoginOpen(false)
    setLoginPty((prev) => {
      // Sign-in persists to claude's own credential store, so killing the PTY
      // afterwards is safe. Best-effort.
      if (prev)
        fetch(`/api/terminal/${encodeURIComponent(prev)}`, { method: 'DELETE' }).catch(() => {})
      return null
    })
    setLoginError(null)
    // A completed sign-in clears the run gate — drop the CTA so the user can
    // pick an element and Send again.
    setLoggedOut(false)
  }, [])

  // Kill a still-open login PTY if the tile unmounts (canvas / tab switch) mid
  // sign-in — it would otherwise linger waiting at its prompt.
  const loginPtyRef = useRef<string | null>(null)
  loginPtyRef.current = loginPty
  useEffect(
    () => () => {
      const id = loginPtyRef.current
      if (id)
        fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    },
    [],
  )

  // A tweak (or any edit) swaps the srcdoc and remounts the iframe — re-arm
  // the bridge on load so the next pick works without re-toggling.
  const onIframeLoad = useCallback(() => {
    if (inspecting) sendInspect(true)
  }, [inspecting, sendInspect])

  const badge = selected ? (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
      {/* The mode flip (selected = live) needs a visible signal — the moss
          dot mirrors the Ground card's Working beacon register. */}
      <span className="pointer-events-none flex items-center gap-1.5 rounded-full border border-line bg-bg-card/95 px-2.5 py-1 text-[10px] font-medium text-moss shadow-card">
        <span className="h-[5px] w-[5px] rounded-full bg-moss" />
        {t('canvasEl.iframe.interactive')}
      </span>
      {projectPath && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setInspecting((v) => !v)}
          aria-pressed={inspecting}
          title={t('canvasEl.tweak.title')}
          className={[
            'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-medium shadow-card transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            inspecting
              ? 'border-accent bg-accent text-bg-card hover:bg-accent-hover'
              : 'border-line bg-bg-card/95 text-ink-muted hover:bg-bg-inset hover:text-ink',
          ].join(' ')}
        >
          <Sparkles size={10} strokeWidth={2} />
          {t('canvasEl.tweak.enter')}
        </button>
      )}
    </div>
  ) : null

  // The "Sign in to Claude" modal — portaled to <body> so the canvas's
  // transformed / overflow-hidden ancestors can't clip the fixed overlay.
  // Lives inside `panel` (below) so BOTH ScreenView and MockView render it
  // without a new return field; it persists while the tile is mounted.
  const loginModal =
    loginOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="dialog"
            aria-modal="true"
            aria-label={t('projectPanel.claudeLogin.title')}
          >
            <div className="flex h-[70vh] max-h-[640px] w-full max-w-[780px] flex-col overflow-hidden rounded-lg border border-line bg-bg-card shadow-2xl">
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-ink">
                    {t('projectPanel.claudeLogin.title')}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                    {t('projectPanel.claudeLogin.hint')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeClaudeLogin}
                  aria-label={t('common.close')}
                  className="shrink-0 rounded-sm p-1 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col bg-bg">
                {loginPty ? (
                  <ClaudeTerminalPane terminalId={loginPty} chrome={false} onExit={closeClaudeLogin} />
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                    {loginError ? (
                      <>
                        <p className="max-w-[90%] text-[12px] leading-relaxed text-accent">
                          {loginError}
                        </p>
                        <button
                          type="button"
                          onClick={() => void openClaudeLogin()}
                          className="rounded-sm border border-line px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-accent hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {t('projectPanel.claudeLogin.retry')}
                        </button>
                      </>
                    ) : (
                      <p className="text-[12px] text-ink-faint">
                        {t('projectPanel.claudeLogin.starting')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  const panel = (
    <>
      {selected && (picked || (inspecting && notice) || inspecting || loggedOut) ? (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute inset-x-0 bottom-0 z-10 border-t border-line bg-bg-card p-2"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">
              {picked
                ? `<${picked.tag}>` +
                  (picked.classes.trim()
                    ? ' .' + picked.classes.trim().split(/\s+/).join(' .')
                    : '')
                : t('canvasEl.tweak.pickHint')}
            </span>
            <button
              type="button"
              onClick={close}
              title={t('canvasEl.tweak.close')}
              className="flex h-5 w-5 items-center justify-center rounded-[3px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
          {picked && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  // IME guard: never steal the Enter that confirms a conversion.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void submit()
                  } else if (e.key === 'Escape' && !e.nativeEvent.isComposing && !pending) {
                    close()
                  }
                }}
                disabled={pending}
                autoFocus
                placeholder={t('canvasEl.tweak.placeholder')}
                className="h-7 min-w-0 flex-1 rounded-[3px] border border-line bg-bg px-2 text-[12px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void submit()}
                disabled={pending || !instruction.trim()}
                className="flex h-7 shrink-0 items-center gap-1 rounded-[3px] bg-accent px-2.5 text-[11px] font-medium text-bg-card transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent"
              >
                {pending ? (
                  <Loader2 size={12} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Sparkles size={11} strokeWidth={2} />
                )}
                {t('canvasEl.tweak.send')}
              </button>
            </div>
          )}
          {loggedOut ? (
            // Signed-out: a sign-in CTA, not a generic error. Clicking it opens
            // the login terminal (loginModal below). claudeMissing keeps its
            // own install copy via the notice branch.
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="min-w-0 flex-1 text-[10.5px] leading-snug text-ink-muted">
                {t('canvasEl.tweak.claudeLoggedOut')}
              </p>
              <button
                type="button"
                onClick={() => void openClaudeLogin()}
                className="shrink-0 rounded-[3px] border border-line px-2 py-0.5 text-[10.5px] font-medium text-ink-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {t('canvas.generate.signIn')}
              </button>
            </div>
          ) : (
            notice && (
              <p
                className={[
                  'mt-1 truncate text-[10.5px]',
                  notice.kind === 'ok' ? 'text-moss' : 'text-accent',
                ].join(' ')}
              >
                {notice.text}
              </p>
            )
          )}
        </div>
      ) : null}
      {loginModal}
    </>
  )

  return { badge, panel, onIframeLoad }
}

const DEFAULT_W = 1280
const DEFAULT_H = 800

// ⌘/Ctrl+Enter or Escape finishes editing; a plain Enter is a newline. Every
// key stays inside the editor so canvas shortcuts hold off.
function editorKeyDown(e: React.KeyboardEvent, done: () => void) {
  e.stopPropagation()
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault()
    done()
  }
}

// Mock chrome strips. `browser` is a mac-style traffic-light + URL bar,
// `phone` is an iPhone-style notch bar. `none` leaves the iframe bare so a
// design fills the whole canvas tile.
const ChromeStrip = ({
  variant,
  label,
}: {
  variant: 'browser' | 'phone'
  label: string
}) => {
  if (variant === 'browser') {
    return (
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-bg-elevated px-3 py-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 truncate font-mono text-[10px] tracking-tight text-ink-muted">
          {label}
        </span>
      </div>
    )
  }
  return (
    <div className="flex shrink-0 items-center justify-center border-b border-line bg-black/95 py-1">
      <span className="h-1 w-12 rounded-full bg-white/40" />
    </div>
  )
}

// Per-Canvas Screen renderer. A screen's source code (`element.text`) is
// transpiled in-browser and mounted inside a sandboxed iframe via
// `buildScreenSrcdoc` — the same runtime model as a Mock, but with the
// project's full design system (Tailwind tokens, fonts, lucide) injected so a
// Claude-authored, token-using component renders faithfully with no rebuild.
// (The old build-time `import.meta.glob(src/designs/**)` path rendered blank in
// the shipped app; this replaces it.)
export const ScreenView = ({
  element,
  selected,
  editing,
  onPointerDown,
  onChangeText,
  onEditDone,
  ring,
  commentTool,
  projectPath,
}: Props) => {
  const { t } = useT()
  const ta = useRef<HTMLTextAreaElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const chrome = element.chrome ?? 'none'
  const framework = element.framework ?? 'react'
  const theme = element.theme ?? 'light'
  const label = element.label || element.moduleId || 'Screen'
  const w = element.width ?? DEFAULT_W
  const h = element.height ?? DEFAULT_H

  useEffect(() => {
    if (editing && ta.current) ta.current.focus()
  }, [editing])

  const source = element.text ?? ''
  const srcdoc = useMemo(
    () => buildScreenSrcdoc(source, framework, theme, element.props),
    [source, framework, theme, element.props],
  )

  const tweak = useInspectTweak({
    iframeRef,
    selected,
    projectPath,
    source,
    framework,
    onChangeText,
  })

  return (
    <div
      onPointerDown={onPointerDown}
      style={{ width: w, height: h, opacity: resolveOpacity(element) }}
      className={[
        'group relative flex flex-col overflow-hidden rounded-[4px] border border-line bg-bg-card shadow-card',
        editing ? 'cursor-text' : 'cursor-grab active:cursor-grabbing',
        ring,
      ].join(' ')}
    >
      {chrome !== 'none' && <ChromeStrip variant={chrome} label={label} />}
      <div className="relative min-h-0 flex-1 bg-white">
        {editing ? (
          <textarea
            ref={ta}
            value={source}
            onChange={(e) => onChangeText(e.target.value)}
            onBlur={onEditDone}
            onKeyDown={(e) => editorKeyDown(e, onEditDone)}
            onPointerDown={(e) => e.stopPropagation()}
            spellCheck={false}
            wrap="off"
            placeholder={'export default function Screen() {\n  return <div className="p-10">…</div>\n}'}
            className="block h-full w-full resize-none bg-bg px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-ink focus:outline-none"
          />
        ) : source.trim() ? (
          <>
            <iframe
              key={hash32(srcdoc)}
              ref={iframeRef}
              onLoad={tweak.onIframeLoad}
              title={label}
              srcDoc={srcdoc}
              sandbox="allow-scripts"
              className={[
                'block h-full w-full border-0 bg-white',
                element.scrollable ? '' : 'overflow-hidden',
              ].join(' ')}
            />
            {/* While dragging (or unfocused), the iframe swallows pointer
                events. Cover it so the canvas owns drags — only the chrome
                strip or a selected screen passes clicks through. */}
            {!selected && (
              <div
                onPointerDown={onPointerDown}
                className={[
                  'absolute inset-0',
                  // Comment tool: let the wrapper's bubble cursor show through
                  // instead of this overlay's own grab cursor (see ElementView).
                  commentTool ? 'cursor-[inherit]' : 'cursor-grab active:cursor-grabbing',
                ].join(' ')}
              >
                {/* Interactivity is real but invisible (select first, then the
                    iframe is live) — say so on hover, or nobody discovers it. */}
                {!commentTool && (
                  <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-bg-card/95 px-2.5 py-1 text-[10px] font-medium text-ink-muted opacity-0 shadow-card transition-opacity duration-150 group-hover:opacity-100">
                    {t('canvasEl.iframe.clickToInteract')}
                  </span>
                )}
              </div>
            )}
            {tweak.badge}
            {tweak.panel}
          </>
        ) : (
          // Empty screen (or a legacy moduleId-only screen pre-migration):
          // an explicit affordance, never a silent blank tile.
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation()
            }}
            className="flex h-full w-full flex-col items-center justify-center gap-2 bg-bg-card p-6 text-center"
          >
            <MonitorSmartphone size={22} strokeWidth={1.5} className="text-ink-faint" />
            <span className="text-[13px] font-medium text-ink">
              {element.moduleId
                ? t('canvasEl.screen.legacyTitle')
                : t('canvasEl.screen.emptyTitle')}
            </span>
            <span className="max-w-[36ch] text-[11.5px] leading-snug text-ink-muted">
              {t('canvasEl.screen.emptyHint')}
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
