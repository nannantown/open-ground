import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { VoiceRecorder } from '@/lib/voice/recorder'
import {
  formatComboForDisplay,
  isEditableTarget,
  matchesCombo,
} from '@/lib/voice/keybinding'
import { insertTranscript } from '@/lib/voice/insert'
import type { VoiceSettings, VoiceTranscribeResponse } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'

// Voice dictation driver — the app-wide glue between the pure voice pieces:
// the configured key combo (keybinding.ts) starts/stops a mic capture
// (recorder.ts), the WAV goes to POST /api/voice/transcribe, and the result is
// inserted at the focus that was live when recording STOPPED (insert.ts) — so
// the seconds whisper spends transcribing can't misdirect the text if the user
// clicks elsewhere meanwhile. Renders nothing while idle; a small status pill
// (recording / transcribing / notice) floats bottom-center otherwise.
//
// Key stealing policy: an explicit user-chosen combo is always honoured EXCEPT
// a bare printable key (no Ctrl/Alt/Meta) while focus is in a text field —
// that's the user typing, not a shortcut (see isEditableTarget's contract).

interface Props {
  voice: VoiceSettings | undefined
  /** Path of the currently open project, if any — gives the transcribe route a
   *  validated cwd for the optional claude formatting pass. */
  projectPath: string | null
}

type Phase = 'idle' | 'recording' | 'transcribing'

// Anything shorter is a stray tap (hold mode) or an accidental double-press
// (toggle mode) — whisper on ~nothing yields garbage, so cancel silently.
const MIN_CAPTURE_MS = 300
const NOTICE_MS = 5_000

export const VoiceController = ({ voice, projectPath }: Props) => {
  const { t } = useT()
  const enabled = voice?.enabled === true
  const combo = voice?.keybinding ?? 'Alt+Space'
  const keyMode = voice?.keyMode ?? 'hold'

  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)

  // Listener-visible mirrors — the window listeners are bound once per
  // (enabled, combo, keyMode) and must read the LIVE phase/project, not the
  // values captured when the effect ran.
  const phaseRef = useRef<Phase>('idle')
  const recorderRef = useRef<VoiceRecorder | null>(null)
  // When the current recording began — guards keydown-while-recording below.
  const startedAtRef = useRef(0)
  const projectPathRef = useRef(projectPath)
  projectPathRef.current = projectPath
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toPhase = (p: Phase) => {
    phaseRef.current = p
    setPhase(p)
  }

  const showNotice = (kind: 'info' | 'error', text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice({ kind, text })
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
  }

  useEffect(() => {
    if (!enabled) return

    const begin = async () => {
      if (phaseRef.current !== 'idle') return
      const rec = new VoiceRecorder()
      recorderRef.current = rec
      startedAtRef.current = Date.now()
      toPhase('recording')
      setNotice(null)
      try {
        await rec.start()
      } catch {
        recorderRef.current = null
        toPhase('idle')
        showNotice('error', t('voice.error.micDenied'))
      }
    }

    const cancel = async () => {
      const rec = recorderRef.current
      recorderRef.current = null
      toPhase('idle')
      await rec?.cancel()
    }

    const finish = async () => {
      if (phaseRef.current !== 'recording') return
      const rec = recorderRef.current
      recorderRef.current = null
      if (!rec || !rec.recording) {
        // start() hasn't resolved yet (instant tap) — drop the capture.
        toPhase('idle')
        await rec?.cancel()
        return
      }
      // Upper bound guards the permission-dialog race: until getUserMedia
      // resolves, startedAt is 0 and durationMs is nonsense-huge.
      if (rec.durationMs < MIN_CAPTURE_MS || rec.durationMs > 600_000) {
        toPhase('idle')
        await rec.cancel()
        return
      }
      // The element the transcript belongs to — captured NOW, restored at
      // insert time, immune to focus drifting during transcription.
      const target = document.activeElement
      toPhase('transcribing')
      try {
        const wav = await rec.stop()
        const qs = new URLSearchParams()
        const path = projectPathRef.current
        if (path) qs.set('projectPath', path)
        const res = await fetch(`/api/voice/transcribe${path ? `?${qs}` : ''}`, {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body: wav,
        })
        if (res.status === 422) {
          const { error } = (await res.json()) as { error?: string }
          showNotice(
            'error',
            error === 'whisper-binary-missing'
              ? t('voice.error.binaryMissing')
              : t('voice.error.modelMissing'),
          )
          return
        }
        if (!res.ok) throw new Error(res.statusText)
        const { text } = (await res.json()) as VoiceTranscribeResponse
        if (!text.trim()) {
          showNotice('info', t('voice.noSpeech'))
          return
        }
        if (!insertTranscript(target, text)) {
          await navigator.clipboard.writeText(text).catch(() => {})
          showNotice('info', t('voice.copied'))
        }
      } catch {
        showNotice('error', t('voice.error.failed'))
      } finally {
        toPhase('idle')
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (phaseRef.current === 'recording' && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        void cancel()
        return
      }
      if (!matchesCombo(e, combo)) return
      // A bare printable key in a text field is typing, not the shortcut.
      if (
        !e.ctrlKey && !e.altKey && !e.metaKey &&
        e.key.length === 1 &&
        isEditableTarget(document.activeElement)
      ) {
        return
      }
      // The Settings keybinding-capture field is recording a NEW combo —
      // pressing the current one there must not start dictation.
      if ((document.activeElement as HTMLElement | null)?.closest('[data-voice-capture]')) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      if (phaseRef.current === 'idle') {
        void begin()
        return
      }
      // A matching keydown DURING a recording stops it — in toggle mode
      // that's the contract; in hold mode it recovers a recording whose
      // keyup got lost (window blur, the macOS permission prompt stealing
      // focus). The age guard filters the phantom second keydown JIS
      // Lang keys (英数/かな) fire per physical press on macOS — without it
      // toggle mode would stop the recording it just started.
      if (
        phaseRef.current === 'recording' &&
        Date.now() - startedAtRef.current > 500
      ) {
        void finish()
      }
    }

    // Hold mode = push-to-talk: releasing ANY key of the held combo ends the
    // capture (the user can let go of the modifier or the main key first).
    const onKeyUp = () => {
      if (keyMode !== 'hold') return
      if (phaseRef.current !== 'recording') return
      void finish()
    }

    // Push-to-talk across a focus loss is meaningless — the keyup will land
    // somewhere else (app switch, the permission prompt). Close the capture
    // with whatever was said; finish() itself discards sub-300ms takes.
    const onBlur = () => {
      if (keyMode !== 'hold') return
      if (phaseRef.current !== 'recording') return
      void finish()
    }

    // Capture phase so the chord never leaks into xterm (which would type a
    // literal character into the PTY) or other app-level key handlers.
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      // Settings flipped mid-capture (disable / combo change): drop the take.
      const rec = recorderRef.current
      recorderRef.current = null
      if (phaseRef.current === 'recording') {
        phaseRef.current = 'idle'
        setPhase('idle')
        void rec?.cancel()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, combo, keyMode, t])

  // Elapsed ticker while recording (drives the m:ss readout in the pill).
  useEffect(() => {
    if (phase !== 'recording') {
      setElapsedMs(0)
      return
    }
    const id = setInterval(() => setElapsedMs(recorderRef.current?.durationMs ?? 0), 200)
    return () => clearInterval(id)
  }, [phase])

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  if (!enabled) return null
  if (phase === 'idle' && !notice) return null

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const comboLabel = formatComboForDisplay(combo, isMac ? 'mac' : 'other')
  const secs = Math.floor(elapsedMs / 1000)
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 flex items-center gap-2.5 rounded-[3px] border border-line bg-bg-card px-4 py-2.5 shadow-card-hover"
    >
      {phase === 'recording' && (
        <>
          <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
          <span className="text-[12px] text-ink">{t('voice.recording')}</span>
          <span className="font-mono text-[11px] text-ink-muted tabular-nums">{clock}</span>
          <span className="text-[11px] text-ink-subtle">
            {keyMode === 'hold'
              ? t('voice.hint.release')
              : t('voice.hint.toggle', { combo: comboLabel })}
            {' · '}
            {t('voice.hint.esc')}
          </span>
        </>
      )}
      {phase === 'transcribing' && (
        <>
          <Loader2 size={13} className="shrink-0 animate-spin text-ink-muted" />
          <span className="text-[12px] text-ink">{t('voice.transcribing')}</span>
        </>
      )}
      {phase === 'idle' && notice && (
        <span
          className={
            'text-[12px] ' + (notice.kind === 'error' ? 'text-accent' : 'text-ink-muted')
          }
        >
          {notice.text}
        </span>
      )}
    </div>
  )
}
