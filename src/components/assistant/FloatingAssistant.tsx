// FloatingAssistant — the owner's assistant, floating over every screen
// (owner decision 2026-10-03, docs/ASSISTANT_DESIGN.md). One character in a
// corner: click it to talk, click again (or Esc) to close; drag it anywhere
// and it stays there. The talk is the one log on this Mac, shared with the
// iPhone (useAssistant). Renders nothing unless the routes let this machine in
// (owner only) — and is held still and unclickable in work mode.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { useT } from '@/i18n/I18nContext'
import { ArrowUp } from 'lucide-react'
import { AssistantMark, LOOK_COLOR } from './AssistantMark'
import { ASSISTANT_WINDOW_ATTR } from './assistantWindow'
import { useAssistant, type AssistantLook } from './useAssistant'

const POS_KEY = 'og.assistant.pos'
const SIZE = 50
const MARGIN = 12
const GAP = 10
const PANEL_W = 340
const PANEL_H = 460
/** A press that moves less than this is a click, not a drag. */
const DRAG_PX = 4
const LOOKS: AssistantLook[] = ['verm', 'moss', 'ochre', 'ink']
/** The server's limit for one line (ASSISTANT_SAY_MAX in phoneAssistant.ts). */
const SAY_MAX = 2000

interface Pos {
  right: number
  bottom: number
}
/** Clear of the agent-team bar folded along a project's bottom edge (~40px). */
const DEFAULT_POS: Pos = { right: 20, bottom: 72 }

const readPos = (): Pos => {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as Pos | null
    return p && Number.isFinite(p.right) && Number.isFinite(p.bottom) ? p : DEFAULT_POS
  } catch {
    return DEFAULT_POS
  }
}
/** Kept on screen however small the window gets. */
export const clampPos = (p: Pos, w: number, h: number): Pos => ({
  right: Math.min(Math.max(p.right, MARGIN), Math.max(MARGIN, w - SIZE - MARGIN)),
  bottom: Math.min(Math.max(p.bottom, MARGIN), Math.max(MARGIN, h - SIZE - MARGIN)),
})

/** Where the talk window opens: on the side of the character with more room. */
export const panelPlacement = (p: Pos, w: number, h: number) => {
  const cx = w - p.right - SIZE / 2
  const cy = h - p.bottom - SIZE / 2
  const below = cy < h / 2
  const room = below ? h - (h - p.bottom + GAP) - MARGIN : h - (p.bottom + SIZE + GAP) - MARGIN
  return {
    width: Math.min(PANEL_W, w - 2 * MARGIN),
    maxHeight: Math.max(160, Math.min(PANEL_H, room)),
    ...(cx >= w / 2 ? { right: Math.max(MARGIN, p.right) } : { left: Math.max(MARGIN, w - p.right - SIZE) }),
    ...(below ? { top: h - p.bottom + GAP } : { bottom: p.bottom + SIZE + GAP }),
  }
}

export const FloatingAssistant = ({ disabled }: { disabled: boolean }) => {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const showPanel = open && !disabled
  const words = useMemo(
    () => ({
      failed: t('misc.assistant.failed'),
      busy: t('misc.assistant.busy'),
      tooLong: t('misc.assistant.tooLong'),
      workMode: t('misc.assistant.workMode'),
    }),
    [t],
  )
  const a = useAssistant(showPanel, words)
  const [pos, setPos] = useState(readPos)
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [text, setText] = useState('')
  const drag = useRef<{ x: number; y: number; from: Pos; to: Pos | null } | null>(null)
  const dragged = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const lookRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    if (showPanel) inputRef.current?.focus()
    else setEditing(false)
  }, [showPanel])
  useEffect(() => setDraftName(a.name), [a.name])
  // Work mode closes the window (it does not pop back up when work mode ends).
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  // Esc inside the window is the window's. This listener subscribes when the
  // window opens, so the app's own CAPTURE-phase Esc handlers (Board drawer,
  // Canvas tool, placement ghost) run BEFORE it — they step aside themselves
  // via isInAssistantWindow (assistantWindow.ts); stopping it here keeps it
  // from App's bubble-phase Esc. Esc outside the window is left to the app. An
  // IME's Esc only cancels the conversion. In the name field it undoes the edit.
  useEffect(() => {
    if (!showPanel) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return
      if (!(e.target instanceof Node) || !panelRef.current?.contains(e.target)) return
      e.stopPropagation()
      e.preventDefault()
      if (e.target === nameRef.current) {
        setDraftName(a.name)
        setEditing(false)
        lookRef.current?.focus() // the field unmounts; focus stays in the window
        return
      }
      setOpen(false)
      buttonRef.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [showPanel, a.name])
  // The newest line stays in view.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [a.lines.length, a.pending, a.error, showPanel])

  if (!a.ready) return null
  const at = clampPos(pos, view.w, view.h)
  const label = a.name || t('misc.assistant.label')

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, from: at, to: null }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.to && Math.hypot(dx, dy) < DRAG_PX) return
    d.to = clampPos({ right: d.from.right - dx, bottom: d.from.bottom - dy }, view.w, view.h)
    setPos(d.to)
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d?.to) return
    dragged.current = true
    localStorage.setItem(POS_KEY, JSON.stringify(d.to))
  }
  const onClick = () => {
    // The click that ends a drag is not a click.
    if (dragged.current) return void (dragged.current = false)
    setOpen((o) => !o)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const line = text.trim()
    if (!line || a.pending !== null) return
    // A mouse send leaves focus on the send button, which disables — keep it in the window.
    inputRef.current?.focus()
    setText('')
    if (!(await a.say(line))) setText((cur) => cur || line)
  }
  const saveName = () => {
    if (editing && draftName.trim() !== a.name) void a.saveLook({ name: draftName })
  }

  const place = panelPlacement(at, view.w, view.h)
  const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

  return (
    <>
      {showPanel && (
        <section
          ref={panelRef}
          role="dialog"
          aria-label={label}
          // Focusable, so a click on the talk keeps focus (and Esc) in the window.
          tabIndex={-1}
          {...{ [ASSISTANT_WINDOW_ATTR]: '' }}
          style={place}
          className="fixed z-overlay-float flex flex-col gap-2 rounded-[14px] border border-line bg-bg-card p-3 text-ink shadow-[0_14px_34px_rgb(var(--og-shadow)/0.2)] focus:outline-none"
        >
          <header className="flex items-center gap-2">
            <button
              ref={lookRef}
              type="button"
              onClick={() => setEditing((v) => !v)}
              aria-pressed={editing}
              title={t('misc.assistant.look')}
              className={`grid size-8 place-items-center rounded-full transition-colors duration-150 hover:bg-plane active:bg-line aria-pressed:bg-accent-soft ${focusRing}`}
            >
              <AssistantMark look={a.look} size={24} mode={a.pending !== null ? 'think' : 'idle'} />
            </button>
            {a.name && <span className="truncate text-ui font-semibold">{a.name}</span>}
          </header>
          {editing && (
            <div className="flex items-center gap-2">
              <input
                ref={nameRef}
                value={draftName}
                maxLength={24}
                aria-label={t('misc.assistant.name')}
                placeholder={t('misc.assistant.name')}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault()
                    saveName()
                  }
                }}
                className={`min-w-0 flex-1 rounded-[8px] border border-line-strong bg-bg px-2 py-1 text-ui text-ink placeholder:text-ink-faint hover:border-ink-subtle focus:border-accent focus:outline-none ${focusRing}`}
              />
              {LOOKS.map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={a.look === l}
                  aria-label={t(`misc.assistant.color.${l}`)}
                  title={t(`misc.assistant.color.${l}`)}
                  onClick={() => void a.saveLook({ look: l })}
                  style={{ background: LOOK_COLOR[l] }}
                  className="size-5 shrink-0 rounded-full ring-offset-2 ring-offset-bg-card transition-transform duration-150 hover:scale-110 active:scale-95 aria-pressed:ring-2 aria-pressed:ring-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                />
              ))}
            </div>
          )}
          <div ref={listRef} className="flex min-h-0 flex-auto flex-col gap-2 overflow-y-auto pr-1" aria-live="polite">
            {a.lines.map((l) =>
              l.who === 'owner' ? (
                <p key={l.id} className="max-w-[80%] self-end whitespace-pre-wrap rounded-[12px_12px_4px_12px] bg-plane px-2.5 py-1.5 text-ui leading-relaxed">
                  {l.text}
                </p>
              ) : (
                <p key={l.id} className="max-w-[88%] self-start whitespace-pre-wrap text-ui leading-relaxed">
                  {l.text}
                </p>
              ),
            )}
            {a.pending !== null && (
              <>
                <p className="max-w-[80%] self-end whitespace-pre-wrap rounded-[12px_12px_4px_12px] bg-plane px-2.5 py-1.5 text-ui leading-relaxed">
                  {a.pending}
                </p>
                <span className="self-start" data-testid="assistant-thinking">
                  <AssistantMark look={a.look} size={20} mode="think" />
                </span>
              </>
            )}
            {a.error && <p className="self-start text-ui text-accent">{a.error}</p>}
          </div>
          <form onSubmit={submit} className="flex items-center gap-1.5 rounded-full border border-line-strong bg-bg py-1 pl-3 pr-1 transition-colors duration-150 hover:border-ink-subtle focus-within:border-accent">
            <input
              ref={inputRef}
              value={text}
              maxLength={SAY_MAX}
              aria-label={t('misc.assistant.message')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // An IME's confirming Enter is not a send.
                if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault()
              }}
              className="min-w-0 flex-1 bg-transparent text-ui text-ink focus:outline-none"
            />
            <button
              type="submit"
              disabled={!text.trim() || a.pending !== null}
              aria-label={t('misc.assistant.send')}
              title={t('misc.assistant.send')}
              style={{ background: LOOK_COLOR[a.look] }}
              className={`grid size-8 shrink-0 place-items-center rounded-full text-bg transition-[filter] duration-150 enabled:hover:brightness-90 enabled:active:brightness-75 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </form>
        </section>
      )}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-expanded={showPanel}
        aria-haspopup="dialog"
        title={disabled ? t('misc.assistant.workMode') : label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onClick={onClick}
        style={{ right: at.right, bottom: at.bottom, width: SIZE, height: SIZE }}
        className={`fixed z-overlay-float grid touch-none select-none place-items-center rounded-full border shadow-[0_6px_18px_rgb(var(--og-shadow)/0.16)] transition-[background-color,border-color,transform] duration-150 ${
          showPanel ? 'border-accent bg-accent-soft' : 'border-line bg-bg-card enabled:hover:border-line-strong enabled:hover:bg-bg-elevated'
        } enabled:hover:scale-105 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
      >
        <AssistantMark look={a.look} mode={disabled ? 'off' : a.pending !== null ? 'think' : 'idle'} />
        {a.unread && !showPanel && (
          <span className="absolute right-0.5 top-0.5 size-2.5 rounded-full bg-accent ring-2 ring-bg-card" data-testid="assistant-unread" />
        )}
      </button>
    </>
  )
}
