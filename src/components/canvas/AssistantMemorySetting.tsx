// AssistantMemorySetting — what the assistant keeps on this Mac
// (src/lib/server/assistantMemory.ts): how many days of talk are kept, how long
// the long-term memo may be, and the talk log + memo themselves — readable and
// deletable (one line, all of it, the memo) — and a line to talk to it from the
// screen (same assistant, same log as the iPhone). Rendered inside PhoneLinkSetting
// (owner-only: the routes answer 403 to anyone else and this renders nothing).
import { useCallback, useEffect, useState } from 'react'
import { Check, Trash2, X } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'

interface Entry {
  id: string
  at: number
  who: 'owner' | 'assistant'
  text: string
}
interface Data {
  entries: Entry[]
  memory: string
  logDays: number
  memoryChars: number
}

const INPUT =
  'rounded-[3px] border border-line bg-bg-card px-2.5 py-1.5 text-ui text-ink ' +
  'hover:border-line-strong focus:border-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40 transition-colors'
const BTN =
  'inline-flex items-center gap-1.5 rounded-[2px] border border-line-strong bg-bg-elevated px-3 py-2 label-cap text-ink-muted ' +
  'hover:text-ink hover:bg-plane hover:border-ink-subtle active:bg-line disabled:opacity-40 disabled:cursor-not-allowed ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors cursor-pointer'
const ICON_BTN =
  'inline-flex items-center justify-center rounded-[2px] p-1 text-ink-subtle hover:text-ink hover:bg-plane active:bg-line ' +
  'disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors cursor-pointer'
const BOX = 'max-h-56 overflow-y-auto rounded-[3px] border border-line bg-bg-card px-2.5 py-2 text-ui leading-relaxed text-ink'

const API = '/api/phone-link/assistant'

export const AssistantMemorySetting = () => {
  const { t } = useT()
  const [data, setData] = useState<Data | null>(null)
  const [draft, setDraft] = useState({ logDays: '', memoryChars: '' })
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  // What last failed, so the words fit it: a save or a delete.
  const [failed, setFailed] = useState<'' | 'save' | 'delete'>('')
  const [say, setSay] = useState('')
  const [sayError, setSayError] = useState('')

  const load = useCallback(async () => {
    const r = await fetch(`${API}/log`).catch(() => null)
    const d = r?.ok ? ((await r.json()) as Data) : null
    if (!d) return
    setData(d)
    setDraft({ logDays: String(d.logDays), memoryChars: String(d.memoryChars) })
  }, [])
  useEffect(() => void load(), [load])

  const act = async (fn: () => Promise<Response>, kind: 'save' | 'delete' = 'delete') => {
    setBusy(true)
    setFailed('')
    try {
      if (!(await fn()).ok) throw new Error('assistant')
      return true
    } catch {
      setFailed(kind)
      return false
    } finally {
      setBusy(false)
      await load()
    }
  }
  const saveConfig = async () => {
    // Lowering either number deletes / cuts at once, without folding first.
    const lower = data && (Number(draft.logDays) < data.logDays || Number(draft.memoryChars) < data.memoryChars)
    if (lower && !window.confirm(t('settings.phoneLink.assistant.confirmLower'))) return
    const ok = await act(
      () =>
        fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ logDays: Number(draft.logDays), memoryChars: Number(draft.memoryChars) }),
        }),
      'save',
    )
    if (ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
  }

  // The answer lands in the log (read back below); a failure says why in plain words.
  const send = async () => {
    const text = say.trim()
    if (!text || busy) return
    setBusy(true)
    setSayError('')
    try {
      const r = await fetch(`${API}/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (r.ok) setSay('')
      else {
        const j = (await r.json().catch(() => ({}))) as { detail?: string }
        setSayError(j.detail || t('settings.phoneLink.assistant.sayFailed'))
      }
    } catch {
      setSayError(t('settings.phoneLink.assistant.sayFailed'))
    } finally {
      setBusy(false)
      await load()
    }
  }

  if (!data) return null
  const changed = draft.logDays !== String(data.logDays) || draft.memoryChars !== String(data.memoryChars)
  const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="assistant-days" className="text-ui text-ink">
          {t('settings.phoneLink.assistant.days')}
        </label>
        <input
          id="assistant-days"
          type="number"
          min={1}
          max={365}
          className={`${INPUT} w-20`}
          disabled={busy}
          value={draft.logDays}
          onChange={(e) => setDraft({ ...draft, logDays: e.target.value })}
        />
        <label htmlFor="assistant-chars" className="text-ui text-ink">
          {t('settings.phoneLink.assistant.chars')}
        </label>
        <input
          id="assistant-chars"
          type="number"
          min={500}
          max={8000}
          step={100}
          className={`${INPUT} w-20`}
          disabled={busy}
          value={draft.memoryChars}
          onChange={(e) => setDraft({ ...draft, memoryChars: e.target.value })}
        />
        <span className="flex-1" />
        {failed && (
          <span className="text-ui text-ink-muted">
            {t(failed === 'save' ? 'settings.phoneLink.assistant.failed' : 'settings.phoneLink.assistant.deleteFailed')}
          </span>
        )}
        {saved && <Check size={14} className="text-status-done" aria-label={t('common.save')} />}
        <button type="button" className={BTN} disabled={busy || !changed} onClick={saveConfig}>
          {t('common.save')}
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-ui text-ink">{t('settings.phoneLink.assistant.memory')}</span>
          <span className="flex-1" />
          <button
            type="button"
            className={ICON_BTN}
            disabled={busy || !data.memory}
            title={t('settings.phoneLink.assistant.deleteMemory')}
            aria-label={t('settings.phoneLink.assistant.deleteMemory')}
            onClick={() => window.confirm(t('settings.phoneLink.assistant.confirmMemory')) && act(() => fetch(`${API}/memory`, { method: 'DELETE' }))}
          >
            <Trash2 size={14} />
          </button>
        </div>
        <div className={`${BOX} whitespace-pre-wrap`}>{data.memory || <span className="text-ink-muted">{t('settings.phoneLink.assistant.empty')}</span>}</div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-ui text-ink">{t('settings.phoneLink.assistant.log')}</span>
          <span className="flex-1" />
          <button
            type="button"
            className={BTN}
            disabled={busy || !data.entries.length}
            onClick={() => window.confirm(t('settings.phoneLink.assistant.confirmAll')) && act(() => fetch(`${API}/log`, { method: 'DELETE' }))}
          >
            {t('settings.phoneLink.assistant.deleteAll')}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            maxLength={2000}
            className={`${INPUT} min-w-0 flex-1`}
            disabled={busy}
            value={say}
            aria-label={t('settings.phoneLink.assistant.sayLabel')}
            title={t('settings.phoneLink.assistant.sayLabel')}
            onChange={(e) => setSay(e.target.value)}
            onKeyDown={(e) => {
              // Never take the Enter that commits an IME composition.
              if (e.nativeEvent.isComposing || e.key !== 'Enter') return
              e.preventDefault()
              void send()
            }}
          />
          <button type="button" className={BTN} disabled={busy || !say.trim()} onClick={() => void send()}>
            {t('settings.phoneLink.assistant.say')}
          </button>
        </div>
        {sayError && <span className="text-ui text-ink-muted">{sayError}</span>}
        <ul className={`${BOX} flex flex-col gap-1`}>
          {!data.entries.length && <li className="text-ink-muted">{t('settings.phoneLink.assistant.empty')}</li>}
          {[...data.entries].reverse().map((e) => (
            <li key={e.id} className="group flex items-start gap-2">
              <span className="shrink-0 tabular-nums text-ink-subtle">{when(e.at)}</span>
              <span className="shrink-0 text-ink-muted">
                {e.who === 'owner' ? t('settings.phoneLink.assistant.you') : t('settings.phoneLink.assistant.name')}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{e.text}</span>
              <button
                type="button"
                className={ICON_BTN}
                disabled={busy}
                title={t('settings.phoneLink.assistant.deleteOne')}
                aria-label={t('settings.phoneLink.assistant.deleteOne')}
                onClick={() => act(() => fetch(`${API}/log/${encodeURIComponent(e.id)}`, { method: 'DELETE' }))}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
