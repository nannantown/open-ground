// useVoice — the floating assistant's ears and voice, for free: the ears are
// macOS's own speech recognizer behind /api/phone-link/assistant/listen
// (src/lib/server/assistantListen.ts), the voice is the system's speechSynthesis.
//
// Two uses, kept apart (owner 2026-10-06, like the iPhone app):
// - chat: the mic types what is said into the input; nothing is sent or read aloud.
// - call: what is said is sent, the answer comes back aloud (speaker on).
// FloatingAssistant decides which one the ears serve; this file only opens
// them while `on` and reports what they hear.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantListenEvent as ListenEvent } from '@/lib/types'

const LISTEN = '/api/phone-link/assistant/listen'

const synth = (): SpeechSynthesis | null => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis)
/** Japanese script anywhere ⇒ a Japanese voice; otherwise English. */
export const speechLang = (text: string) => (/[぀-ヿ㐀-鿿]/.test(text) ? 'ja-JP' : 'en-US')

/**
 * The mic is on exactly while `on` (the stream open = the helper running).
 * A dropped or refused stream never reconnects by itself (it would start the
 * mic again and again): onError gets 'denied' | 'unavailable' | 'failed', and
 * the caller turns `on` off.
 */
export const useListen = (opts: {
  on: boolean
  lang: 'ja' | 'en'
  /** A new value opens fresh ears even if `on` stays true (chat → call). */
  session: string
  onFinal: (text: string) => void
  onError: (reason: string) => void
}) => {
  const { on, lang, session } = opts
  /** The session whose ears said ready (a new session is not ready until its own do). */
  const [readyFor, setReadyFor] = useState<string | null>(null)
  const [partial, setPartial] = useState('')
  const cb = useRef(opts)
  cb.current = opts

  useEffect(() => {
    if (!on) return
    const es = new EventSource(`${LISTEN}?lang=${lang}`)
    es.onmessage = (m: MessageEvent<string>) => {
      let e: ListenEvent
      try {
        e = JSON.parse(m.data) as ListenEvent
      } catch {
        return
      }
      if (e.type === 'ready') setReadyFor(session)
      else if (e.type === 'partial') setPartial(e.text ?? '')
      else if (e.type === 'final') {
        setPartial('')
        if (e.text) cb.current.onFinal(e.text)
      } else if (e.type === 'error') {
        es.close()
        cb.current.onError(e.reason ?? 'failed')
      }
    }
    es.onerror = () => {
      es.close()
      cb.current.onError('failed')
    }
    return () => {
      es.close()
      setReadyFor(null)
      setPartial('')
    }
  }, [on, lang, session])

  return { ready: on && readyFor === session, partial: on ? partial : '' }
}

/** Reading answers aloud. speechSynthesis is one queue for the whole app (a
 *  Research digest reads through it too), so someone else's speech is never
 *  cut and never queued behind: speak() refuses while it plays, and cancel()
 *  only empties the queue once OUR utterance is the one speaking.
 *  `watchOthers` polls for that other speech (the call keeps its mic shut
 *  while it plays — it would hear the narration and send it as the owner's words). */
export const useSpeech = (watchOthers = false) => {
  const [speaking, setSpeaking] = useState(false)
  const [others, setOthers] = useState(false)
  // Held so the engine cannot drop the utterance (and its onend) mid-sentence.
  const utterance = useRef<{ u: SpeechSynthesisUtterance; started: boolean; dropped: boolean } | null>(null)
  const watchdog = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const quiet = useCallback(() => {
    clearInterval(watchdog.current)
    utterance.current = null
    setSpeaking(false)
  }, [])
  const cancel = useCallback(() => {
    const cur = utterance.current
    if (!cur) return
    if (cur.started) synth()?.cancel()
    else cur.dropped = true // still queued: cut it the moment it starts
    quiet()
  }, [quiet])
  // Gone (signed out: the assistant is re-mounted) — our reading goes with it.
  useEffect(
    () => () => {
      clearInterval(watchdog.current)
      const cur = utterance.current
      if (cur?.started) synth()?.cancel()
      else if (cur) cur.dropped = true
    },
    [],
  )

  useEffect(() => {
    if (!watchOthers) return setOthers(false)
    const look = () => {
      const s = synth()
      setOthers(!!s && !utterance.current && (s.speaking || s.pending))
    }
    look()
    const id = setInterval(look, 500)
    return () => clearInterval(id)
  }, [watchOthers])

  /** false = not read (nothing to read, no voice, or someone else is speaking). */
  const speak = useCallback(
    (text: string): boolean => {
      const s = synth()
      if (!s || !text.trim()) return false
      if (utterance.current) cancel()
      else if (s.speaking || s.pending) return false
      const u = new SpeechSynthesisUtterance(text)
      const cur = { u, started: false, dropped: false }
      u.lang = speechLang(text)
      u.onstart = () => {
        if (cur.dropped) s.cancel()
        else cur.started = true
      }
      u.onend = u.onerror = () => {
        if (utterance.current === cur) quiet()
      }
      utterance.current = cur
      setSpeaking(true)
      s.speak(u)
      // onend is known to go missing in Chromium; without it the ears would stay
      // shut for good. The engine idle (nothing speaking, nothing queued) = done.
      clearInterval(watchdog.current)
      watchdog.current = setInterval(() => {
        if (utterance.current === cur && !s.speaking && !s.pending) quiet()
      }, 1000)
      return true
    },
    [cancel, quiet],
  )

  return { speaking, others, speak, cancel }
}
