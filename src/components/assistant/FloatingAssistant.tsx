// FloatingAssistant — the owner's assistant, floating over every screen
// (owner decision 2026-10-03, docs/ASSISTANT_DESIGN.md). One character in a
// corner: click it to talk, click again (or Esc) to close; drag it anywhere
// and it stays there. The talk is the one log on this Mac, shared with the
// iPhone (useAssistant). Renders nothing unless the routes let this machine in
// (owner only) — and is held still and unclickable in work mode.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { useT } from '@/i18n/I18nContext'
import { ArrowUp, ImagePlus, Mic, MessagesSquare, Phone, X } from 'lucide-react'
import { AssistantCall, type CallPhase } from './AssistantCall'
import { AssistantMark, LOOK_COLOR } from './AssistantMark'
import { ASSISTANT_RESERVE_VAR, ASSISTANT_RESERVE_Y_VAR, ASSISTANT_WINDOW_ATTR } from './assistantWindow'
import { PHOTO_MAX_BYTES, PHOTO_TYPES, photoUrl, useAssistant, type AssistantLook } from './useAssistant'
import { ProposalFrames } from './ProposalFrames'
import { useListen, useSpeech } from './useVoice'

const POS_KEY = 'og.assistant.pos'
/** '1' = the window shows the whole talk; otherwise only the input and the current exchange. */
export const EXPANDED_KEY = 'og.assistant.expanded'
const SIZE = 50
const MARGIN = 12
const GAP = 10
const PANEL_W = 340
const PANEL_H = 460
/** While frames are shown the talk keeps at least this (its newest line and
 *  answer stay seen, rework 3) — unless only that would keep an open frame from
 *  fitting whole in a short window: then the frame comes first, a frame that
 *  cannot be pressed being a dead end. */
const TALK_MIN = 88
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
/** The default (not yet dragged) spot, the SAME on every screen (owner
 *  2026-10-06: it must not jump when a project opens): level with Ground's
 *  bottom-left edit (pen) button, whose centre is ~43px up (ToolPalette p-5 +
 *  frame), so bottom = 43 - SIZE/2. In a project the screen makes room for it
 *  (the two reserves below) — the character does not move for the screen. */
export const DEFAULT_POS: Pos = { right: 20, bottom: 18 }
/** While the character sits at DEFAULT_POS: the width the agent-team bar keeps
 *  free at its right end, and the floor a project keeps free under its tab
 *  content — the character's extent from the window edge + an 8px gap. */
export const ASSISTANT_RESERVE_PX = DEFAULT_POS.right + SIZE + 8
export const ASSISTANT_RESERVE_Y_PX = DEFAULT_POS.bottom + SIZE + 8

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

export const FloatingAssistant = ({ disabled }: { disabled: boolean }) => {
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
      proposalGone: t('misc.assistant.proposalGone'),
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
  // Room is kept only while it is shown at the default spot: once the owner has
  // DROPPED it elsewhere, the screen takes its full size back. Decided by the
  // saved spot, not the live one, so the screen does not reflow mid-drag.
  const [placed, setPlaced] = useState(() => readPos() !== null)
  const reserve = a.ready && !placed
  useEffect(() => {
    if (!reserve) return
    const s = document.documentElement.style
    s.setProperty(ASSISTANT_RESERVE_VAR, `${ASSISTANT_RESERVE_PX}px`)
    s.setProperty(ASSISTANT_RESERVE_Y_VAR, `${ASSISTANT_RESERVE_Y_PX}px`)
    return () => {
      s.removeProperty(ASSISTANT_RESERVE_VAR)
      s.removeProperty(ASSISTANT_RESERVE_Y_VAR)
    }
  }, [reserve])
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
  /** The line last spoken in this call: its reading stopped by the owner, the
   *  read-aloud part of its answer they heard, whether its answer is in. */
  const callTurn = useRef<{ stopped: boolean; heard: string; done: boolean; answered: boolean } | null>(null)
  /** The owner stopped the reading of the line still being answered: the ears open meanwhile. */
  const [hushed, setHushed] = useState(false)
  /** What they said after that stop, while the stopped line is still answered — sent once it is. */
  const held = useRef('')
  const drag = useRef<{ x: number; y: number; from: Pos; to: Pos | null } | null>(null)
  const dragged = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  /** The height the proposals' frames get: the window's max height less everything
   *  else in it but the talk (measured, never a guess). The frames' box never
   *  shrinks below its content within that, the talk gives way instead (rework 2:
   *  sharing the shrink by size cut a 182 px card by 1–2 px behind a long talk). */
  const [framesRoom, setFramesRoom] = useState(0)
  // Reads only refs: the observer below may keep the first copy.
  const measureRoom = () => {
    const panel = panelRef.current
    const box = panel?.querySelector<HTMLElement>('[data-testid="assistant-proposals"]')
    if (!panel || !box) return
    const cs = getComputedStyle(panel)
    const n = (v: string) => parseFloat(v) || 0
    const kids = Array.from(panel.children) as HTMLElement[]
    const others = kids.filter((k) => k !== box && k !== listRef.current).reduce((h, k) => h + k.offsetHeight, 0)
    const all = n(panel.style.maxHeight) - n(cs.paddingTop) - n(cs.paddingBottom) - n(cs.borderTopWidth) - n(cs.borderBottomWidth) - n(cs.rowGap) * (kids.length - 1) - others
    // The frames' box takes only its content's height, so the talk already gets
    // everything the frames leave; the reserve only caps how far the frames may
    // grow into the talk. Given up (down to what is left) when it alone would keep
    // the FIRST open frame from fitting whole; kept when nothing makes it fit anyway.
    // Only that frame counts (review E): the faded closed line and the frames stacked
    // behind it sit later in the clipped box and are simply cut first.
    const list = listRef.current
    const first = box.querySelector<HTMLElement>('[data-state="open"]')
    const need = first ? first.getBoundingClientRect().bottom - box.getBoundingClientRect().top : 0
    const free = all - need
    const talkKeeps = list ? Math.min(list.scrollHeight, free >= 0 ? Math.min(TALK_MIN, free) : TALK_MIN) : 0
    const room = Math.max(0, all - talkKeeps)
    setFramesRoom((cur) => (Math.abs(cur - room) > 0.5 ? room : cur))
  }
  // Again whenever a part of the window changes size on its own (a photo loading, the call screen).
  const sizes = useRef<ResizeObserver | null>(null)
  useLayoutEffect(() => {
    measureRoom()
    const panel = panelRef.current
    if (!panel || typeof ResizeObserver === 'undefined') return
    const ro = (sizes.current ??= new ResizeObserver(() => measureRoom()))
    ro.disconnect()
    for (const k of Array.from(panel.children)) ro.observe(k)
  })
  useEffect(() => () => sizes.current?.disconnect(), [])
  const nameRef = useRef<HTMLInputElement>(null)
  const lookRef = useRef<HTMLButtonElement>(null)

  // Only a line SPOKEN in a call is answered aloud (still in the call, speaker on) —
  // its short spoken part; the whole answer stays in the talk as text. A "let me
  // look" said before a look-up is read the moment it comes.
  // A line without look-ups is read a sentence at a time as it is written
  // (`{say}` pieces, then the answer is marked `said`); the stop key cuts the
  // reading, and the server is told what of the answer was heard.
  const sendLine = async (line: string, spoken: boolean, pic?: string) => {
    setTurn(null)
    const cur = { stopped: false, heard: '', done: false, answered: false }
    if (spoken) {
      callTurn.current = cur
      setHushed(false)
    }
    const aloud = () => spoken && live.current.inCall && live.current.speaker && !cur.stopped
    const heard = (piece: string) => () => void (cur.heard += piece)
    const said = await a.say(
      line,
      (reply, speak, streamed) => {
        setTurn({ said: line, reply, photo: pic })
        cur.answered = true
        if (!spoken || !live.current.inCall) return
        if (cur.stopped) setUnspoken('')
        else if (streamed) setUnspoken(aloud() ? '' : speak)
        else setUnspoken(aloud() && speech.speakAfter(speak, setUnspoken, heard(speak)) ? '' : speak)
      },
      pic,
      (interim) => void (aloud() && speech.speak(interim)),
      {
        say: (piece) => void (aloud() && speech.speakAfter(piece, undefined, heard(piece))),
        // A look-up began: those pieces were not the answer (what was heard of them neither).
        hush: () => {
          cur.heard = ''
          if (aloud()) speech.cancel()
        },
      },
    )
    cur.done = true
    // Told first, so the note rides on the very next line (the held one, if any).
    // A line that got no answer has nothing to cut: the note would land on an older one.
    if (cur.stopped && cur.answered) await a.hush(cur.heard)
    const next = held.current
    held.current = ''
    if (next && callTurn.current === cur && live.current.inCall) void sendLine(next, true)
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
  const callHears = inCall && !muted && !voiceFail && (a.pending === null || hushed) && !speech.speaking && !speech.others
  const ears = useListen({
    // a.ready: signed out mid-listen, the window leaves the screen — the mic goes with it.
    on: a.ready && showPanel && (inCall ? callHears : dictating),
    lang: lang === 'en' ? 'en' : 'ja',
    session: inCall ? 'call' : 'chat',
    onFinal: (heard) => {
      if (live.current.inCall) {
        // Said after a stop while the stopped line is still answered: it goes next.
        const cur = callTurn.current
        if (cur?.stopped && !cur.done) return void (held.current = joinHeard(held.current, heard))
        return void sendLine(heard, true)
      }
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
    held.current = ''
  }
  /** The call's stop key (or Space): quiet at once, and listen. */
  const stopReading = () => {
    speech.cancel()
    setUnspoken('')
    const cur = callTurn.current
    if (!cur || cur.stopped) return
    cur.stopped = true
    setHushed(true)
    if (cur.done && cur.answered) void a.hush(cur.heard)
    // The stop key leaves the screen: focus stays in the call (Space works next time too).
    panelRef.current?.focus()
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
    setHushed(false)
    setInCall(true)
  }
  // Space quiets the reading too: the call screen holds the focus (a focused
  // key or field keeps its own Space).
  useEffect(() => {
    if (!inCall || !speech.speaking) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== ' ' || e.isComposing || e.repeat) return
      if (!(e.target instanceof Element) || !panelRef.current?.contains(e.target)) return
      if (e.target.closest('button, input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      stopReading()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stopReading reads refs and stable callbacks
  }, [inCall, speech.speaking])

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
    // (also once a proposal's frame has taken its height from the talk)
  }, [a.lines.length, a.pending, a.error, showPanel, expanded, turn, framesRoom, a.proposals.length])

  if (!a.ready) return null
  const at = clampPos(pos ?? DEFAULT_POS, view.w, view.h)
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
    setPlaced(true)
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
    speech.speaking ? 'speaking' : a.pending !== null && !hushed ? 'thinking' : callSince === null || redial ? 'connecting' : ears.ready ? 'hearing' : 'waiting'
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
  const photoLoaded = () => {
    measureRoom()
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  const ownLine = (key: string, said: string, src?: string) => (
    <div key={key} className="flex max-w-[80%] flex-col items-end gap-1 self-end">
      {/* A photo takes its height only once loaded: the talk's room and its scroll follow. */}
      {src && <img src={src} alt={t('misc.assistant.photo')} onLoad={photoLoaded} className="max-h-40 max-w-full rounded-[10px] border border-line object-contain" />}
      {said && <p className={`${owned} max-w-full`}>{said}</p>}
    </div>
  )
  const answered = 'max-w-[88%] self-start whitespace-pre-wrap text-ui leading-relaxed'
  const iconButton = 'grid size-8 shrink-0 place-items-center rounded-full transition-colors duration-150'
  const saveName = () => {
    if (editing && draftName.trim() !== a.name) void a.saveLook({ name: draftName })
  }

  const place = panelPlacement(at, view.w, view.h)
  // The proposals' frames: outside the talk, right above the input (or above the
  // call). They get whatever height the window really has left — the talk gives
  // way first — and a frame that still does not fit whole cannot be pressed.
  const frames = <ProposalFrames proposals={a.proposals} room={framesRoom} busy={a.pressing} onApprove={a.approve} onDrop={(id) => void a.drop(id)} />
  // While one waits for its button, the call screen leaves out its big character and the unread reply.
  const proposalOpen = a.proposals.some((p) => p.state === 'open' && p.expiresAt > Date.now())
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
            <>
            {frames}
            <AssistantCall
              compact={proposalOpen}
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
              onStop={stopReading}
              onRetry={() => {
                setVoiceFail('')
                setRedial(true)
              }}
            />
            </>
          ) : (
            <>
          {expanded && a.name && <header className="shrink-0 truncate px-1 text-ui font-semibold">{a.name}</header>}
          {showTalk && (
            <div ref={listRef} data-testid="assistant-talk" className="flex min-h-0 flex-auto flex-col gap-2 overflow-y-auto pr-1" aria-live="polite">
              {expanded
                ? a.lines.map((l) =>
                    l.who === 'owner' ? (
                      ownLine(l.id, l.text, l.photo && photoUrl(l.photo))
                    ) : (
                      <Fragment key={l.id}>{l.text && <p className={answered}>{l.text}</p>}</Fragment>
                    ),
                  )
                : a.pending === null &&
                  turn && (
                    <>
                      {ownLine('said', turn.said, turn.photo)}
                      {turn.reply && <p className={answered}>{turn.reply}</p>}
                    </>
                  )}
              {a.pending !== null && (
                <>
                  {ownLine('pending', a.pending, a.pendingPhoto ?? undefined)}
                  <span className="self-start flex items-center gap-2" data-testid="assistant-thinking">
                    <AssistantMark look={a.look} size={20} mode="think" />
                    {a.interim && <span className="text-ui text-ink-muted">{a.interim}</span>}
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
          {frames}
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
