// FloatingAssistant — the owner's assistant, floating over every screen
// (owner decision 2026-10-03, docs/ASSISTANT_DESIGN.md). One character in a
// corner: click it to talk, click again (or Esc) to close; drag it anywhere
// and it stays there. The talk is the one log on this Mac, shared with the
// iPhone (useAssistant). Renders nothing unless the routes let this machine in
// (owner only) — and is held still and unclickable in work mode.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { useT } from '@/i18n/I18nContext'
import { ArrowUp, ImagePlus, Mic, MessagesSquare, Phone, X } from 'lucide-react'
import { AssistantCall, type CallPhase } from './AssistantCall'
import { AssistantMark, LOOK_COLOR } from './AssistantMark'
import { ASSISTANT_WINDOW_ATTR } from './assistantWindow'
import { PHOTO_MAX_BYTES, PHOTO_TYPES, photoUrl, useAssistant, type AssistantLook } from './useAssistant'
import { useListen, useSpeech } from './useVoice'

const POS_KEY = 'og.assistant.pos'
/** '1' = the window shows the whole talk; otherwise only the input and the current exchange. */
export const EXPANDED_KEY = 'og.assistant.expanded'
const SIZE = 50
const MARGIN = 12
const GAP = 10
const PANEL_W = 340
const PANEL_H = 460
/** What the mic heard, added to what is already typed (Japanese runs on, English gets a space). */
export const joinHeard = (typed: string, heard: string) => (/[^\s\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]$/.test(typed) && /^[A-Za-z0-9]/.test(heard) ? `${typed} ${heard}` : typed + heard)
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

/** On Ground the character sits level with the bottom-left edit (pen) button:
 *  its centre is ~43px up (ToolPalette p-5 + frame), so bottom = 43 - SIZE/2. */
export const GROUND_POS: Pos = { right: 20, bottom: 18 }
/** The default (not yet dragged) spot: level with the pen on Ground, clear of the team bar in a project. */
export const defaultPos = (onGround: boolean): Pos => (onGround ? GROUND_POS : DEFAULT_POS)

/** The owner's dragged spot, or null while they never moved it. */
const readPos = (): Pos | null => {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as Pos | null
    return p && Number.isFinite(p.right) && Number.isFinite(p.bottom) ? p : null
  } catch {
    return null
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

export const FloatingAssistant = ({ disabled, onGround = false }: { disabled: boolean; onGround?: boolean }) => {
  const { t, lang } = useT()
  const [open, setOpen] = useState(false)
  const showPanel = open && !disabled
  const words = useMemo(
    () => ({
      failed: t('misc.assistant.failed'),
      busy: t('misc.assistant.busy'),
      tooLong: t('misc.assistant.tooLong'),
      workMode: t('misc.assistant.workMode'),
      photoType: t('misc.assistant.photoType'),
      photoTooLarge: t('misc.assistant.photoTooLarge'),
    }),
    [t],
  )
  const a = useAssistant(showPanel, words)
  const [expanded, setExpanded] = useState(() => localStorage.getItem(EXPANDED_KEY) === '1')
  /** The exchange made in this opening of the window — all the folded window shows. */
  const [turn, setTurn] = useState<{ said: string; reply: string; photo?: string } | null>(null)
  /** The photo picked for the next line (a data URL), and why one was refused. */
  const [photo, setPhoto] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const pendingRef = useRef(a.pending)
  pendingRef.current = a.pending
  const [pos, setPos] = useState(readPos)
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [text, setText] = useState('')
  // Chat mode's mic only types (owner 2026-10-06): on → what is said goes into
  // the input; off by a second press or by sending. Never sends, never speaks.
  const [dictating, setDictating] = useState(false)
  /** The part of the utterance being heard that typing already took over. */
  // State (not only a ref): typing over the words being heard may leave the
  // typed text unchanged, and the screen must still drop them from the input.
  const [absorbedText, setAbsorbed] = useState('')
  const absorbed = useRef(absorbedText)
  absorbed.current = absorbedText
  // An IME conversion in progress: words heard meanwhile wait (re-setting the
  // input's value mid-conversion would commit or cancel it).
  const [composing, setComposing] = useState(false)
  const heldHeard = useRef('')
  // Call mode: talk by voice, answers come back aloud (iPhone CallView).
  const [inCall, setInCall] = useState(false)
  const [muted, setMuted] = useState(false)
  const [speaker, setSpeaker] = useState(true)
  const [callSince, setCallSince] = useState<number | null>(null)
  /** Retry pressed: 発信中 again until the ears answer. */
  const [redial, setRedial] = useState(false)
  /** The last answer in this call that was not read aloud (speaker off, or other speech playing). */
  const [unspoken, setUnspoken] = useState('')
  /** Why the ears stopped: 'denied' | 'unavailable' | 'failed' ('' = none). */
  const [voiceFail, setVoiceFail] = useState('')
  const live = useRef({ inCall, speaker })
  live.current = { inCall, speaker }
  const drag = useRef<{ x: number; y: number; from: Pos; to: Pos | null } | null>(null)
  const dragged = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const lookRef = useRef<HTMLButtonElement>(null)

  // Only a line SPOKEN in a call is answered aloud (still in the call, speaker on).
  const sendLine = async (line: string, spoken: boolean, pic?: string) => {
    setTurn(null)
    const said = await a.say(
      line,
      (reply) => {
        setTurn({ said: line, reply, photo: pic })
        if (spoken && live.current.inCall) setUnspoken(live.current.speaker && speech.speak(reply) ? '' : reply)
      },
      pic,
    )
    // A refused typed line goes back into the input; a refused spoken one is
    // gone (the call screen says why) — it must not wait in the hidden input.
    if (!said && !spoken) {
      setText((cur) => cur || line)
      if (pic) setPhoto((cur) => cur || pic)
    }
  }
  const pickPhoto = (file: File | undefined) => {
    if (!file) return
    if (!PHOTO_TYPES.includes(file.type)) return setPhotoError(words.photoType)
    if (file.size > PHOTO_MAX_BYTES) return setPhotoError(words.photoTooLarge)
    setPhotoError('')
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' && setPhoto(reader.result)
    reader.onerror = () => setPhotoError(words.failed)
    reader.readAsDataURL(file)
  }
  const speech = useSpeech(inCall && showPanel)
  // One pair of ears, serving whichever mode is on. In a call they close while
  // it answers or speaks (the mic would hear the reply and send it back) and
  // while muted — the mic is on only while it is really used.
  const callHears = inCall && !muted && !voiceFail && a.pending === null && !speech.speaking && !speech.others
  const ears = useListen({
    // a.ready: signed out mid-listen, the window leaves the screen — the mic goes with it.
    on: a.ready && showPanel && (inCall ? callHears : dictating),
    lang: lang === 'en' ? 'en' : 'ja',
    session: inCall ? 'call' : 'chat',
    onFinal: (heard) => {
      if (live.current.inCall) return void sendLine(heard, true)
      // Typing took over the start of this utterance: add only what follows.
      // ponytail: a final that revised those words (kana → kanji) is dropped
      // rather than doubled; the owner is typing anyway.
      const took = absorbed.current
      absorbed.current = '' // a second final in the same tick must not see it
      setAbsorbed('')
      const rest = !took ? heard : heard.startsWith(took) ? heard.slice(took.length) : ''
      if (composingRef.current) heldHeard.current = joinHeard(heldHeard.current, rest)
      else setText((cur) => joinHeard(cur, rest).slice(0, SAY_MAX))
    },
    onError: (reason) => {
      setVoiceFail(reason)
      setDictating(false)
    },
  })
  const composingRef = useRef(composing)
  composingRef.current = composing
  useEffect(() => {
    if (ears.ready && inCall) {
      setCallSince((s) => s ?? Date.now())
      setRedial(false)
    }
  }, [ears.ready, inCall])
  const took = absorbedText
  const partial = !dictating || composing ? '' : !took ? ears.partial : ears.partial.startsWith(took) ? ears.partial.slice(took.length) : ''
  /** The input as shown: what is typed, then what is being heard right now. */
  const shown = (partial ? joinHeard(text, partial) : text).slice(0, SAY_MAX)
  const endCall = () => {
    setInCall(false)
    setVoiceFail('')
    speech.cancel()
  }
  const startCall = () => {
    setDictating(false)
    setAbsorbed('')
    setVoiceFail('')
    setMuted(false)
    setSpeaker(true)
    setCallSince(null)
    setRedial(false)
    setUnspoken('')
    setInCall(true)
  }

  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    if (showPanel) return void inputRef.current?.focus()
    setEditing(false)
    // Closing the window turns the mic off: no call, no typing by voice.
    setDictating(false)
    setInCall(false)
    setVoiceFail('')
    speech.cancel()
    // Closing ends the exchange — unless its answer is still coming (then it
    // waits for the next opening, with the unread mark).
    if (pendingRef.current === null) setTurn(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- speech.cancel is stable
  }, [showPanel])
  // Refused (signed out, no longer the owner): the window leaves the screen —
  // the call and typing by voice end with it and our reading stops, so coming
  // back (signed in again) never finds the mic on by itself.
  useEffect(() => {
    if (a.ready) return
    setInCall(false)
    setDictating(false)
    setVoiceFail('')
    speech.cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- speech.cancel is stable
  }, [a.ready])
  // Focus follows the screen: the call screen (Esc still the window's), then back to the input.
  useEffect(() => {
    if (showPanel) (inCall ? panelRef.current : inputRef.current)?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the call starts or ends
  }, [inCall])
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
  // While the mic types, the end of the input (the newest words) stays in view.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (el && dictating) el.scrollLeft = el.scrollWidth
  }, [shown, dictating])
  // The newest line stays in view.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [a.lines.length, a.pending, a.error, showPanel, expanded, turn])

  if (!a.ready) return null
  const at = clampPos(pos ?? defaultPos(onGround), view.w, view.h)
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
    const line = shown.trim()
    if ((!line && !photo) || a.pending !== null) return
    setDictating(false) // sending ends typing by voice
    setAbsorbed('')
    // A mouse send leaves focus on the send button, which disables — keep it in the window.
    inputRef.current?.focus()
    setText('')
    setPhoto(null)
    setPhotoError('')
    await sendLine(line, false, photo ?? undefined)
  }
  const toggleExpanded = () => {
    localStorage.setItem(EXPANDED_KEY, expanded ? '0' : '1')
    setExpanded(!expanded)
  }
  const voiceError =
    voiceFail &&
    t(voiceFail === 'denied' ? 'misc.assistant.voiceDenied' : voiceFail === 'unavailable' ? 'misc.assistant.voiceUnavailable' : 'misc.assistant.voiceFailed')
  const problem = photoError || (inCall ? '' : voiceError) || a.error
  // 聞いています only while the mic really listens (its ears said ready) — not
  // while other speech keeps it shut or it is reopening after a reply.
  const phase: CallPhase =
    a.pending !== null ? 'thinking' : speech.speaking ? 'speaking' : callSince === null || redial ? 'connecting' : ears.ready ? 'hearing' : 'waiting'
  const toggleDictation = () => {
    if (dictating && partial) setText(shown) // stopping keeps the words heard so far
    setVoiceFail('')
    setAbsorbed('')
    setDictating((d) => !d)
    inputRef.current?.focus()
  }
  /** The input is empty: its right-hand key places a call instead of sending (as on the phone). */
  const callKey = a.voice && !shown.trim() && !photo
  const showTalk = expanded || a.pending !== null || turn !== null || problem !== ''
  const owned = 'max-w-[80%] self-end whitespace-pre-wrap rounded-[12px_12px_4px_12px] bg-plane px-2.5 py-1.5 text-ui leading-relaxed'
  /** The owner's line as the talk shows it: the photo above the words. */
  const ownLine = (key: string, said: string, src?: string) => (
    <div key={key} className="flex max-w-[80%] flex-col items-end gap-1 self-end">
      {src && <img src={src} alt={t('misc.assistant.photo')} className="max-h-40 max-w-full rounded-[10px] border border-line object-contain" />}
      {said && <p className={`${owned} max-w-full`}>{said}</p>}
    </div>
  )
  const answered = 'max-w-[88%] self-start whitespace-pre-wrap text-ui leading-relaxed'
  const iconButton = 'grid size-8 shrink-0 place-items-center rounded-full transition-colors duration-150'
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
          {inCall ? (
            <AssistantCall
              name={label}
              look={a.look}
              phase={phase}
              muted={muted}
              speaker={speaker}
              error={voiceError}
              problem={a.error}
              reply={unspoken}
              since={callSince}
              onSpeaker={() => {
                if (speaker) speech.cancel()
                setSpeaker(!speaker)
              }}
              onMute={() => setMuted(!muted)}
              onEnd={endCall}
              onRetry={() => {
                setVoiceFail('')
                setRedial(true)
              }}
            />
          ) : (
            <>
          {expanded && a.name && <header className="truncate px-1 text-ui font-semibold">{a.name}</header>}
          {showTalk && (
            <div ref={listRef} data-testid="assistant-talk" className="flex min-h-0 flex-auto flex-col gap-2 overflow-y-auto pr-1" aria-live="polite">
              {expanded
                ? a.lines.map((l) =>
                    l.who === 'owner' ? (
                      ownLine(l.id, l.text, l.photo && photoUrl(l.photo))
                    ) : (
                      <p key={l.id} className={answered}>
                        {l.text}
                      </p>
                    ),
                  )
                : a.pending === null &&
                  turn && (
                    <>
                      {ownLine('said', turn.said, turn.photo)}
                      <p className={answered}>{turn.reply}</p>
                    </>
                  )}
              {a.pending !== null && (
                <>
                  {ownLine('pending', a.pending, a.pendingPhoto ?? undefined)}
                  <span className="self-start" data-testid="assistant-thinking">
                    <AssistantMark look={a.look} size={20} mode="think" />
                  </span>
                </>
              )}
              {problem && <p className="self-start text-ui text-accent">{problem}</p>}
            </div>
          )}
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
          {photo && (
            <div className="relative self-start" data-testid="assistant-photo-preview">
              <img src={photo} alt={t('misc.assistant.photo')} className="size-16 rounded-[10px] border border-line object-cover" />
              <button
                type="button"
                onClick={() => {
                  setPhoto(null)
                  inputRef.current?.focus()
                }}
                aria-label={t('misc.assistant.photoRemove')}
                title={t('misc.assistant.photoRemove')}
                className={`absolute -right-2 -top-2 grid size-6 place-items-center rounded-full border border-line bg-bg-card text-ink-subtle shadow-sm transition-colors duration-150 hover:bg-plane hover:text-ink active:bg-line ${focusRing}`}
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            </div>
          )}
          <div className="flex items-center gap-1.5">
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
            <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-1 rounded-full border border-line-strong bg-bg py-1 pl-3 pr-1 transition-colors duration-150 hover:border-ink-subtle focus-within:border-accent">
                <input
                  ref={inputRef}
                  value={shown}
                  maxLength={SAY_MAX}
                  aria-label={t('misc.assistant.message')}
                  // The one hint the window gives.
                  placeholder={t('misc.assistant.placeholder')}
                  onCompositionStart={() => setComposing(true)}
                  onCompositionEnd={() => {
                    setComposing(false)
                    const held = heldHeard.current
                    heldHeard.current = ''
                    if (held) setText((cur) => joinHeard(cur, held).slice(0, SAY_MAX))
                  }}
                  onChange={(e) => {
                    // Typing takes over the words being heard; the rest of that utterance still comes.
                    if (partial) setAbsorbed(took + partial)
                    setText(e.target.value)
                  }}
                  onKeyDown={(e) => {
                    // An IME's confirming Enter is not a send.
                    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault()
                  }}
                  className="min-w-0 flex-1 bg-transparent text-ui text-ink placeholder:text-ink-faint focus:outline-none"
                />
              <input
                ref={fileRef}
                type="file"
                accept={PHOTO_TYPES.join(',')}
                hidden
                data-testid="assistant-photo-input"
                onChange={(e) => {
                  pickPhoto(e.target.files?.[0])
                  e.target.value = '' // the same photo can be picked again after removing it
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={a.pending !== null}
                aria-label={t('misc.assistant.photoAdd')}
                title={t('misc.assistant.photoAdd')}
                className={`${iconButton} text-ink-subtle enabled:hover:bg-plane enabled:hover:text-ink enabled:active:bg-line disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
              >
                <ImagePlus size={16} strokeWidth={2.25} />
              </button>
              {a.voice && (
                <button
                  type="button"
                  onClick={toggleDictation}
                  aria-pressed={dictating}
                  aria-label={dictating ? t('misc.assistant.dictateOff') : t('misc.assistant.dictateOn')}
                  title={dictating ? t('misc.assistant.dictateOff') : t('misc.assistant.dictateOn')}
                  data-hearing={dictating && ears.ready ? '' : undefined}
                  className={`relative ${iconButton} ${
                    dictating ? 'bg-accent-soft text-accent hover:bg-accent-soft/70 active:bg-accent-soft/50' : 'text-ink-subtle hover:bg-plane hover:text-ink active:bg-line'
                  } ${focusRing}`}
                >
                  {dictating && ears.ready && <span aria-hidden className="absolute inset-0 rounded-full ring-2 ring-accent motion-safe:animate-pulse" />}
                  <Mic size={16} strokeWidth={2.25} />
                </button>
              )}
              {callKey ? (
                <button
                  type="button"
                  onClick={startCall}
                  aria-label={t('misc.assistant.call')}
                  title={t('misc.assistant.call')}
                  style={{ background: LOOK_COLOR[a.look] }}
                  className={`grid size-8 shrink-0 place-items-center rounded-full text-bg transition-[filter] duration-150 hover:brightness-90 active:brightness-75 ${focusRing}`}
                >
                  <Phone size={15} strokeWidth={2.25} />
                </button>
              ) : (
              <button
                type="submit"
                disabled={(!shown.trim() && !photo) || a.pending !== null}
                aria-label={t('misc.assistant.send')}
                title={t('misc.assistant.send')}
                style={{ background: LOOK_COLOR[a.look] }}
                className={`grid size-8 shrink-0 place-items-center rounded-full text-bg transition-[filter] duration-150 enabled:hover:brightness-90 enabled:active:brightness-75 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
              )}
            </form>
            <button
              type="button"
              onClick={toggleExpanded}
              aria-pressed={expanded}
              aria-label={expanded ? t('misc.assistant.hideTalk') : t('misc.assistant.showTalk')}
              title={expanded ? t('misc.assistant.hideTalk') : t('misc.assistant.showTalk')}
              className={`${iconButton} text-ink-subtle hover:bg-plane hover:text-ink active:bg-line aria-pressed:bg-accent-soft aria-pressed:text-accent ${focusRing}`}
            >
              <MessagesSquare size={16} strokeWidth={2.25} />
            </button>
          </div>
            </>
          )}
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
