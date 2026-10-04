// useVoice — talking to the floating assistant by voice, both ways, for free:
// the ears are macOS's own speech recognizer behind
// /api/phone-link/assistant/listen (src/lib/server/assistantListen.ts), the
// voice is the system's speechSynthesis. Off by default; on = listening, one
// utterance after another, each handed to onHeard as a finished line.
//
// While the assistant is answering or speaking, the ears are closed (the
// stream is shut, the helper stops): otherwise the mic would hear the reply
// read aloud and send it straight back. They reopen once the voice ends.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantListenEvent as ListenEvent } from '@/lib/types'

const LISTEN = '/api/phone-link/assistant/listen'

export interface VoiceState {
  on: boolean
  /** The mic is open right now (on, and not waiting for or reading out an answer). */
  hearing: boolean
  /** What has been heard of the current utterance, so far. */
  partial: string
  /** Why voice turned itself off: 'denied' | 'unavailable' | 'failed'; '' when none. */
  error: string
  toggle: () => void
  /** Reads a reply aloud — only while voice is on. */
  speak: (text: string) => void
}

const synth = (): SpeechSynthesis | null => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis)
/** Japanese script anywhere ⇒ a Japanese voice; otherwise English. */
export const speechLang = (text: string) => (/[぀-ヿ㐀-鿿]/.test(text) ? 'ja-JP' : 'en-US')

/**
 * @param active  false (window closed, work mode) turns voice off.
 * @param busy    a line is being answered: keep the ears closed.
 */
export const useVoice = (opts: { active: boolean; busy: boolean; lang: 'ja' | 'en'; onHeard: (line: string) => void }): VoiceState => {
  const { active, busy, lang } = opts
  const [on, setOn] = useState(false)
  const [ready, setReady] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [partial, setPartial] = useState('')
  const [error, setError] = useState('')
  const onRef = useRef(on)
  onRef.current = on
  const heardRef = useRef(opts.onHeard)
  heardRef.current = opts.onHeard
  // Held so the engine cannot drop the utterance (and its onend) mid-sentence.
  const utterance = useRef<SpeechSynthesisUtterance | null>(null)
  const watchdog = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const quiet = useCallback(() => {
    clearInterval(watchdog.current)
    utterance.current = null
    setSpeaking(false)
  }, [])
  const off = useCallback(
    (why = '') => {
      setOn(false)
      setError(why)
      // Only our own reading: speechSynthesis is one queue for the whole app
      // (a Research digest being read must not stop because this window closed).
      if (utterance.current) synth()?.cancel()
      quiet()
    },
    [quiet],
  )
  useEffect(() => () => clearInterval(watchdog.current), [])

  useEffect(() => {
    if (!active) off()
  }, [active, off])

  const listening = on && !busy && !speaking
  useEffect(() => {
    if (!listening) return
    const es = new EventSource(`${LISTEN}?lang=${lang}`)
    es.onmessage = (m: MessageEvent<string>) => {
      let e: ListenEvent
      try {
        e = JSON.parse(m.data) as ListenEvent
      } catch {
        return
      }
      if (e.type === 'ready') setReady(true)
      else if (e.type === 'partial') setPartial(e.text ?? '')
      else if (e.type === 'final') {
        setPartial('')
        if (e.text) heardRef.current(e.text)
      } else if (e.type === 'error') {
        es.close()
        off(e.reason ?? 'failed')
      }
    }
    // A dropped or refused stream must not reconnect by itself (it would start
    // the ears again and again): voice goes off and says so.
    es.onerror = () => {
      es.close()
      off('failed')
    }
    return () => {
      es.close()
      setReady(false)
      setPartial('')
    }
  }, [listening, lang, off])

  const toggle = useCallback(() => {
    if (onRef.current) return off()
    setError('')
    setOn(true)
  }, [off])

  const speak = useCallback((text: string) => {
    const s = synth()
    if (!s || !onRef.current || !text.trim()) return
    // Only an earlier reply of ours is cut short — never someone else's speech.
    if (utterance.current) s.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = speechLang(text)
    u.onend = u.onerror = () => {
      if (utterance.current === u) quiet()
    }
    utterance.current = u
    setSpeaking(true)
    s.speak(u)
    // onend is known to go missing in Chromium; without it the ears would stay
    // shut for good. The engine idle (nothing speaking, nothing queued) = done.
    clearInterval(watchdog.current)
    watchdog.current = setInterval(() => {
      if (utterance.current === u && !s.speaking && !s.pending) quiet()
    }, 1000)
  }, [quiet])

  return { on, hearing: listening && ready, partial: listening ? partial : '', error, toggle, speak }
}
