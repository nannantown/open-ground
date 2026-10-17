// useVoice — the floating assistant's ears and voice, for free: both are
// macOS's own (speech recognizer and system voice) inside og-listen, behind
// /api/phone-link/assistant/listen (src/lib/server/assistantListen.ts).
//
// Two uses, kept apart (owner 2026-10-06, like the iPhone app):
// - chat: the mic types what is said into the input; nothing is sent or read aloud.
// - call: what is said is sent, the answer comes back aloud (speaker on). The
//   voice is og-listen's own (owner 2026-10-07, "A"): played through the engine
//   that listens, with echo removal on, so the owner can talk over it — the ears
//   stay open the whole call and the server stops the reading when they do.
// FloatingAssistant decides which one the ears serve; this file only opens
// them while `on` and reports what they hear.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantListenEvent as ListenEvent } from '@/lib/types'

const LISTEN = '/api/phone-link/assistant/listen'
const VOICE = '/api/phone-link/assistant/voice'

const synth = (): SpeechSynthesis | null => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis)

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
  /** A call's voice: 'speak' / 'spoke' / 'barge' (useCallVoice.onEvent). */
  onVoice?: (e: ListenEvent) => void
}) => {
  const { on, lang, session } = opts
  /** The session whose ears said ready (a new session is not ready until its own do). */
  const [readyFor, setReadyFor] = useState<string | null>(null)
  const [partial, setPartial] = useState('')
  const cb = useRef(opts)
  cb.current = opts

  useEffect(() => {
    if (!on) return
    const es = new EventSource(`${LISTEN}?lang=${lang}${session === 'call' ? '&call=1' : ''}`)
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
      } else cb.current.onVoice?.(e)
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

/** Someone else reading through speechSynthesis (a Research digest): the call
 *  neither cuts it nor reads over it, and its mic is muted meanwhile — echo
 *  removal does not take out another app's sound, it would be sent as the
 *  owner's words. Polled while `watch`. */
export const useOtherSpeech = (watch: boolean) => {
  const [others, setOthers] = useState(false)
  useEffect(() => {
    if (!watch) return setOthers(false)
    const look = () => {
      const s = synth()
      setOthers(!!s && (s.speaking || s.pending))
    }
    look()
    const id = setInterval(look, 500)
    return () => clearInterval(id)
  }, [watch])
  return others
}

/** The call's voice: og-listen reads (POST …/voice), the listen stream says
 *  when each line is heard ('speak') and done ('spoke'), and when the owner
 *  talked over it ('barge' — the server already stopped it). One line follows
 *  another in order; speak() cuts what is being read first. */
export const useCallVoice = (onBarge: () => void) => {
  const [speaking, setSpeaking] = useState(false)
  /** Lines sent and not yet read to the end: who to tell when each is heard. */
  const lines = useRef(new Map<string, { onStart?: () => void }>())
  const seq = useRef(0)
  const barged = useRef(onBarge)
  barged.current = onBarge

  // Built once: everything it reads is a ref or a state setter.
  const api = useMemo(() => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const settle = () => {
      setSpeaking(lines.current.size > 0)
      // A line whose end never comes (og-listen gone quiet without a word) must
      // not leave the call "speaking" for good. ponytail: a read line is ≤ 160 characters.
      clearTimeout(quietTimer)
      if (lines.current.size)
        quietTimer = setTimeout(() => {
          lines.current.clear()
          setSpeaking(false)
        }, 30_000)
    }
    // One at a time, in order: a stop must never overtake the line before it.
    let queue = Promise.resolve(true)
    const post = (body: object) =>
      (queue = queue.then(() =>
        fetch(VOICE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then((r) => r.ok)
          .catch(() => false),
      ))
    const send = (text: string, cut: boolean, onStart?: () => void, dropped?: (text: string) => void): boolean => {
      if (!text.trim()) return false
      // A reading begins with a stop (nothing of ours is playing, or it cuts what
      // is): the server reads nothing sent before a barge-in it has heard of.
      const fresh = cut || lines.current.size === 0
      if (cut) lines.current.clear()
      const id = `v${++seq.current}`
      lines.current.set(id, { onStart })
      settle()
      void post({ ...(fresh ? { stop: true } : {}), say: text, id }).then((ok) => {
        if (ok || !lines.current.delete(id)) return
        settle()
        dropped?.(text)
      })
      return true
    }
    return {
      speak: (text: string, onStart?: () => void) => send(text, true, onStart),
      /** After what is being read (the wait-line, the sentences before). */
      speakAfter: (text: string, dropped?: (text: string) => void, onStart?: () => void) => send(text, false, onStart, dropped),
      cancel: () => {
        if (!lines.current.size) return
        lines.current.clear()
        settle()
        void post({ stop: true })
      },
      mute: (on: boolean) => void post({ mute: on }),
      onEvent: (e: ListenEvent) => {
        const line = e.id ? lines.current.get(e.id) : undefined
        if (e.type === 'speak') {
          // Once: a line read again from its start (og-listen restarted under it) is not heard twice.
          line?.onStart?.()
          if (line) line.onStart = undefined
        }
        else if (e.type === 'spoke' && e.id && lines.current.delete(e.id)) settle()
        else if (e.type === 'barge') {
          lines.current.clear()
          settle()
          barged.current()
        }
      },
    }
  }, [])
  return { speaking, ...api }
}
