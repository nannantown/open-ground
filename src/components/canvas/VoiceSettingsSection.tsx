import { useEffect, useState } from 'react'
import { AlertCircle, Check, Download, Loader2 } from 'lucide-react'
import { comboFromEvent, formatComboForDisplay } from '@/lib/voice/keybinding'
import type { VoiceSettings, VoiceStatus } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'

// Voice dictation settings — the body of the "Voice dictation" Section in the
// Settings drawer. Edits a DRAFT VoiceSettings owned by SettingsPanel (seeded
// on open, persisted on Save), same lifecycle as every other field there. The
// one immediate side effect is the model download: it starts right away
// (fire-and-forget server-side) because a multi-hundred-MB fetch shouldn't be
// gated behind the drawer's Save button.

interface Props {
  open: boolean
  value: VoiceSettings
  onChange: (v: VoiceSettings) => void
}

const MODEL_SIZES: Record<NonNullable<VoiceSettings['model']>, string> = {
  base: '142 MB',
  small: '466 MB',
  medium: '1.5 GB',
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export const VoiceSettingsSection = ({ open, value, onChange }: Props) => {
  const { t } = useT()
  const enabled = value.enabled === true
  const combo = value.keybinding ?? 'Alt+Space'
  const keyMode = value.keyMode ?? 'hold'
  const spoken = value.spokenLanguage ?? 'auto'
  const model = value.model ?? 'small'

  const [capturing, setCapturing] = useState(false)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  // Bumped on Download click so the poll effect re-runs immediately.
  const [statusNonce, setStatusNonce] = useState(0)

  const set = (patch: Partial<VoiceSettings>) => onChange({ ...value, ...patch })

  // Engine status: fetch when the section is visible / the draft model
  // changes, and keep polling while a download is in flight so the progress
  // bar moves.
  const downloading = !!status?.download && !status.download.error && status.download.progress < 1
  useEffect(() => {
    if (!open || !enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const res = await fetch(`/api/voice/status?model=${model}`)
        if (!res.ok) return
        const body = (await res.json()) as VoiceStatus
        if (cancelled) return
        setStatus(body)
        const active = !!body.download && !body.download.error && body.download.progress < 1
        if (active) timer = setTimeout(poll, 1000)
      } catch {
        // server unreachable — the section just shows no status
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [open, enabled, model, statusNonce])

  const startDownload = async () => {
    try {
      await fetch('/api/voice/model/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      })
    } catch {
      // the next status poll reports the failure
    }
    setStatusNonce((n) => n + 1)
  }

  return (
    <div className="space-y-4">
      <SwitchRow
        label={t('settings.voice.enable')}
        checked={enabled}
        onToggle={() => set({ enabled: !enabled })}
      />

      {enabled && (
        <>
          {/* Shortcut — click, then press the new combo. */}
          <Field label={t('settings.voice.keybinding')}>
            <button
              type="button"
              data-voice-capture
              onClick={() => setCapturing(true)}
              onBlur={() => setCapturing(false)}
              onKeyDown={(e) => {
                if (!capturing) return
                e.preventDefault()
                e.stopPropagation()
                if (e.key === 'Escape') {
                  setCapturing(false)
                  return
                }
                const next = comboFromEvent(e)
                if (next) {
                  set({ keybinding: next })
                  setCapturing(false)
                }
              }}
              className={[
                'h-8 min-w-[120px] rounded-[2px] border px-3 font-mono text-[12px] transition-colors',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                capturing
                  ? 'border-accent bg-bg-inset text-ink-muted'
                  : 'border-line bg-bg text-ink hover:border-line-strong hover:bg-bg-inset',
              ].join(' ')}
            >
              {capturing
                ? t('settings.voice.keybinding.capture')
                : formatComboForDisplay(combo, isMac ? 'mac' : 'other')}
            </button>
          </Field>

          <Field label={t('settings.voice.keyMode')}>
            <Segmented
              options={[
                ['hold', t('settings.voice.keyMode.hold')],
                ['toggle', t('settings.voice.keyMode.toggle')],
              ]}
              active={keyMode}
              onPick={(v) => set({ keyMode: v as VoiceSettings['keyMode'] })}
            />
          </Field>

          <Field label={t('settings.voice.language')}>
            <Segmented
              options={[
                ['auto', t('settings.voice.language.auto')],
                ['ja', '日本語'],
                ['en', 'English'],
              ]}
              active={spoken}
              onPick={(v) => set({ spokenLanguage: v as VoiceSettings['spokenLanguage'] })}
            />
          </Field>

          <SwitchRow
            label={t('settings.voice.format')}
            hint={t('settings.voice.format.hint')}
            checked={value.formatWithClaude === true}
            onToggle={() => set({ formatWithClaude: !value.formatWithClaude })}
          />

          <Field label={t('settings.voice.model')}>
            <Segmented
              options={(['base', 'small', 'medium'] as const).map((m) => [
                m,
                `${m} · ${MODEL_SIZES[m]}`,
              ])}
              active={model}
              onPick={(v) => set({ model: v as VoiceSettings['model'] })}
            />
          </Field>

          {/* Engine status — whisper binary + selected model file. */}
          {status && (
            <div className="space-y-1.5 rounded-[2px] border border-line bg-bg px-3 py-2.5 text-[11px] leading-relaxed">
              {status.binaryPath ? (
                <p className="flex items-center gap-1.5 text-moss">
                  <Check size={12} strokeWidth={2.5} className="shrink-0" />
                  <span className="min-w-0 truncate">
                    {t('settings.voice.binary.ok')}{' '}
                    <span className="font-mono text-ink-subtle">{status.binaryPath}</span>
                  </span>
                </p>
              ) : (
                <div className="flex items-start gap-1.5 text-accent">
                  <AlertCircle size={12} className="mt-[2px] shrink-0" />
                  <span>
                    {t('settings.voice.binary.missing')}{' '}
                    <code className="rounded-sm bg-bg-inset px-1 font-mono text-ink">
                      brew install whisper-cpp
                    </code>
                  </span>
                </div>
              )}

              {downloading && status.download ? (
                <div className="flex items-center gap-2 text-ink-muted">
                  <Loader2 size={12} className="shrink-0 animate-spin" />
                  <span className="shrink-0">
                    {t('settings.voice.model.downloading', {
                      model: status.download.model,
                      pct: Math.round(status.download.progress * 100),
                    })}
                  </span>
                  <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-inset">
                    <span
                      className="block h-full rounded-full bg-accent transition-[width] duration-300"
                      style={{ width: `${Math.round(status.download.progress * 100)}%` }}
                    />
                  </span>
                </div>
              ) : status.modelPresent ? (
                <p className="flex items-center gap-1.5 text-moss">
                  <Check size={12} strokeWidth={2.5} className="shrink-0" />
                  {t('settings.voice.model.present', { model })}
                </p>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-ink-muted">
                    <AlertCircle size={12} className="shrink-0" />
                    {t('settings.voice.model.missing', { model })}
                  </span>
                  <button
                    type="button"
                    onClick={startDownload}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-[2px] border border-line-strong bg-bg-elevated px-2.5 py-1 label-cap text-ink-muted transition-colors hover:border-ink-subtle hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <Download size={11} />
                    {t('settings.voice.model.download')}
                  </button>
                </div>
              )}
              {status.download?.error && (
                <p className="flex items-start gap-1.5 text-accent">
                  <AlertCircle size={12} className="mt-[2px] shrink-0" />
                  {t('settings.voice.model.downloadError', { error: status.download.error })}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// --- local building blocks ----------------------------------------------------

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-[12px] text-ink">{label}</span>
    {children}
  </div>
)

// Same switch idiom as the Board's review-column toggle (label + 24×14 track).
const SwitchRow = ({
  label,
  hint,
  checked,
  onToggle,
}: {
  label: string
  hint?: string
  checked: boolean
  onToggle: () => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={onToggle}
    className="group flex w-full items-start justify-between gap-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
  >
    <span className="min-w-0">
      <span className="block text-[12px] text-ink">{label}</span>
      {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-subtle">{hint}</span>}
    </span>
    <span
      aria-hidden
      className={[
        'relative mt-[2px] h-[14px] w-[24px] shrink-0 rounded-full border transition-colors',
        checked
          ? 'border-accent bg-accent group-hover:bg-accent-hover'
          : 'border-line bg-bg-inset',
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-[2px] h-[8px] w-[8px] rounded-full transition-[left,background-color]',
          checked ? 'left-[12px] bg-bg-card' : 'left-[2px] bg-ink-faint',
        ].join(' ')}
      />
    </span>
  </button>
)

// Same segmented idiom as the drawer's Language picker.
const Segmented = <V extends string>({
  options,
  active,
  onPick,
}: {
  options: ReadonlyArray<readonly [V, string]>
  active: V
  onPick: (v: V) => void
}) => (
  <div className="inline-flex items-center gap-0 rounded-[3px] border border-line p-0.5">
    {options.map(([v, label]) => (
      <button
        key={v}
        type="button"
        onClick={() => onPick(v)}
        aria-pressed={active === v}
        className={[
          'h-7 rounded-[2px] border px-2.5 text-[11px] font-medium cursor-pointer transition-all duration-150',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          active === v
            ? 'border-accent bg-accent text-bg-card'
            : 'border-transparent bg-transparent text-ink-muted hover:bg-bg-inset hover:text-ink',
        ].join(' ')}
      >
        {label}
      </button>
    ))}
  </div>
)
