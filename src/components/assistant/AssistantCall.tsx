// AssistantCall — the floating window during a voice call with the assistant,
// after the iPhone app's call screen (openground-ios App/CallView.swift): one
// identity, a quiet state line with the call's time, and three round keys —
// speaker, end, mute. No labels under the keys (owner rule: tooltips only).
// While it speaks, the identity itself is the stop key (a press anywhere on it
// quiets the reading and the call listens — docs/research/voice-assistant-2026-10.md
// 「窓を押すかキーを押すと、すぐ黙って聞く側に回ります」); Space does the same.
import { useEffect, useState } from 'react'
import { MicOff, Phone, PhoneOff, Volume2 } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { AssistantMark } from './AssistantMark'
import type { AssistantLook } from './useAssistant'

/** waiting = in the call, but the mic is not listening yet (reopening, or other speech playing). */
export type CallPhase = 'connecting' | 'hearing' | 'waiting' | 'thinking' | 'speaking'

/** m:ss, like the phone's call timer. */
export const callClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const key = 'grid size-12 place-items-center rounded-full transition-colors duration-150 active:scale-95'
/** On = filled ink (as the phone lights a key); off = a plain round key. */
const toggleKey = (on: boolean) =>
  on ? 'bg-ink text-ink-inverse hover:bg-ink-muted' : 'border border-line-strong bg-bg text-ink hover:bg-plane active:bg-line'

export const AssistantCall = (p: {
  name: string
  look: AssistantLook
  phase: CallPhase
  muted: boolean
  speaker: boolean
  /** An already-worded reason the call cannot hear; '' when none. */
  error: string
  /** A line that could not be answered (the assistant's own failure). */
  problem: string
  /** The last answer that was not read aloud — shown instead. */
  reply: string
  /** A proposal waits for its button above the call: the big character and the unread reply step aside for it. */
  compact?: boolean
  since: number | null
  onSpeaker: () => void
  onMute: () => void
  onEnd: () => void
  onRetry: () => void
  /** Quiet the reading now (offered only while speaking). */
  onStop?: () => void
}) => {
  const { t } = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (p.since === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [p.since])
  const state =
    p.error ||
    (p.muted
      ? t('misc.assistant.callMuted')
      : t(
          p.phase === 'connecting'
            ? 'misc.assistant.callConnecting'
            : p.phase === 'thinking'
              ? 'misc.assistant.callThinking'
              : p.phase === 'speaking'
                ? 'misc.assistant.callSpeaking'
                : p.phase === 'waiting'
                  ? 'misc.assistant.callWaiting'
                  : 'misc.assistant.callHearing',
        ))
  const speakerLabel = t('misc.assistant.speaker')
  const muteLabel = t('misc.assistant.mute')
  const stopLabel = t('misc.assistant.callStop')
  const gap = p.compact ? 'gap-2' : 'gap-4'
  const who = (
    <>
      <span className="block max-w-full truncate text-ui font-semibold">{p.name}</span>
      {!p.compact && <AssistantMark look={p.look} size={64} mode={p.error ? 'off' : p.phase === 'thinking' ? 'think' : 'idle'} />}
      <span className="flex flex-col items-center gap-1 text-center">
        <span aria-hidden className={`block text-ui font-medium ${p.error ? 'text-accent' : 'text-ink'}`}>
          {state}
        </span>
        {p.since !== null && !p.error && <span className="block text-ui tabular-nums text-ink-subtle">{callClock(Math.max(now, p.since) - p.since)}</span>}
        {p.problem && !p.error && <span className="block text-ui text-accent">{p.problem}</span>}
        {p.reply && !p.error && !p.compact && <span className="line-clamp-4 block max-w-full whitespace-pre-wrap text-ui text-ink-subtle">{p.reply}</span>}
      </span>
    </>
  )
  const stoppable = p.phase === 'speaking' && !p.error && p.onStop
  return (
    <div data-testid="assistant-call" className={`flex shrink-0 flex-col items-center px-2 pb-1 ${gap} ${p.compact ? 'pt-0' : 'pt-2'}`}>
      {/* Announced from here, outside the stop key (a status inside a button is not read out), and never re-mounted. */}
      <span role="status" className="sr-only">
        {state}
      </span>
      {stoppable ? (
        <button
          type="button"
          onClick={p.onStop}
          aria-label={stopLabel}
          title={stopLabel}
          className={`flex max-w-full flex-col items-center rounded-lg px-3 py-1 transition-colors duration-150 hover:bg-plane active:bg-line ${gap} ${focusRing}`}
        >
          {who}
        </button>
      ) : (
        <div className={`flex max-w-full flex-col items-center px-3 py-1 ${gap}`}>{who}</div>
      )}
      <div className="flex items-center gap-6 pb-1">
        {p.error ? (
          <button type="button" onClick={p.onRetry} aria-label={t('misc.assistant.callRetry')} title={t('misc.assistant.callRetry')} className={`${key} ${toggleKey(false)} ${focusRing}`}>
            <Phone size={20} strokeWidth={2} />
          </button>
        ) : (
          <button type="button" onClick={p.onSpeaker} aria-pressed={p.speaker} aria-label={speakerLabel} title={speakerLabel} className={`${key} ${toggleKey(p.speaker)} ${focusRing}`}>
            <Volume2 size={20} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          onClick={p.onEnd}
          aria-label={t('misc.assistant.callEnd')}
          title={t('misc.assistant.callEnd')}
          className={`${key} bg-accent text-ink-inverse hover:bg-accent-hover ${focusRing}`}
        >
          <PhoneOff size={20} strokeWidth={2} />
        </button>
        {!p.error && (
          <button type="button" onClick={p.onMute} aria-pressed={p.muted} aria-label={muteLabel} title={muteLabel} className={`${key} ${toggleKey(p.muted)} ${focusRing}`}>
            <MicOff size={20} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  )
}
