// PhoneLinkSetting — pair the owner's iPhone with the president desks
// (src/lib/server/phoneLink.ts, docs/PHONE_LINK.md). Owner-only: the route
// answers 403 to anyone else and then nothing — not even `frame` — renders.
// Pairing copies a code to the clipboard; the iPhone app pastes it (Universal
// Clipboard). Unpairing erases the relay room and the old code stops working.
// Once paired, the owner's APNs key (.p8 + Key ID + Team ID) can be entered so
// the Mac wakes the phone with a Push to Talk push (docs/PHONE_LINK.md "Waking
// the phone"). The key goes to this Mac's server only and is never shown again.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { BellRing, Check, Copy, Smartphone } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { AssistantMemorySetting } from './AssistantMemorySetting'

interface Status {
  paired: boolean
  online: boolean
  /** false = a plaintext pairing from before encryption: pair again. */
  sealed: boolean
  pushKeyId: string | null
  pushPhone: boolean
  pushRefused: string | null
  pushRefusedBy: 'key' | 'app' | null
}

const INPUT =
  'w-28 rounded-[3px] border border-line bg-bg-card px-2.5 py-1.5 text-ui text-ink placeholder:text-ink-faint ' +
  'hover:border-line-strong focus:border-accent focus:outline-none disabled:opacity-40 transition-colors'

const BTN =
  'inline-flex items-center gap-1.5 rounded-[2px] border border-line-strong bg-bg-elevated px-3 py-2 label-cap text-ink-muted ' +
  'hover:text-ink hover:bg-plane hover:border-ink-subtle active:bg-line disabled:opacity-40 disabled:cursor-not-allowed ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors cursor-pointer'

export const PhoneLinkSetting = ({ frame }: { frame: (body: ReactNode) => ReactNode }) => {
  const { t } = useT()
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const [keyForm, setKeyForm] = useState<{ p8: string; keyId: string; teamId: string } | null>(null)
  const [keyBad, setKeyBad] = useState(false)
  // How the assistant talks: what the server has, and the owner's edit of it.
  const [style, setStyle] = useState<{ saved: string; draft: string } | null>(null)
  const [styleSaved, setStyleSaved] = useState(false)
  const [styleFailed, setStyleFailed] = useState(false)

  useEffect(() => {
    fetch('/api/phone-link/assistant-style')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => typeof s?.style === 'string' && setStyle({ saved: s.style, draft: s.style }))
      .catch(() => {})
  }, [])

  const saveStyle = async () => {
    if (!style) return
    setBusy(true)
    setStyleFailed(false)
    try {
      const r = await fetch('/api/phone-link/assistant-style', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ style: style.draft }),
      })
      if (!r.ok) throw new Error('style')
      const s = await r.json()
      setStyle({ saved: s.style, draft: s.style })
      setStyleSaved(true)
      setTimeout(() => setStyleSaved(false), 1500)
    } catch {
      setStyleFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const load = useCallback(() => {
    fetch('/api/phone-link')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) =>
        setStatus(
          s
            ? {
                paired: s.paired === true,
                online: s.online === true,
                sealed: s.sealed === true,
                pushKeyId: typeof s.pushKeyId === 'string' ? s.pushKeyId : null,
                pushPhone: s.pushPhone === true,
                pushRefused: typeof s.pushRefused === 'string' ? s.pushRefused : null,
                pushRefusedBy: s.pushRefusedBy === 'app' || s.pushRefusedBy === 'key' ? s.pushRefusedBy : null,
              }
            : null,
        ),
      )
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [load])

  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setFailed(false)
    try {
      await fn()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
      load()
    }
  }

  const pair = () =>
    run(async () => {
      const r = await fetch('/api/phone-link/pair', { method: 'POST' })
      if (!r.ok) throw new Error('pair')
      const { code } = await r.json()
      if (code) await copy(code)
    })
  const copyAgain = () =>
    run(async () => {
      const { code } = await (await fetch('/api/phone-link/code', { method: 'POST' })).json()
      if (code) await copy(code)
    })
  const unpair = () =>
    run(async () => {
      // Refused when the relay cannot be reached: the old phone is NOT cut off yet.
      if (!(await fetch('/api/phone-link/unpair', { method: 'POST' })).ok) throw new Error('unpair')
    })

  const saveKey = async () => {
    if (!keyForm) return
    setBusy(true)
    setKeyBad(false)
    try {
      const r = await fetch('/api/phone-link/push-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(keyForm),
      })
      if (r.ok) setKeyForm(null)
      else setKeyBad(true)
    } catch {
      setKeyBad(true)
    } finally {
      setBusy(false)
      load()
    }
  }

  if (!status) return null
  return frame(
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-ui text-ink">
        <Smartphone size={14} className={status.online ? 'text-status-done' : 'text-ink-subtle'} />
        {!status.paired
          ? t('settings.phoneLink.unpaired')
          : status.online
            ? t('settings.phoneLink.online')
            : t('settings.phoneLink.offline')}
        {status.paired && !status.sealed && ` · ${t('settings.phoneLink.unsealed')}`}
      </span>
      {failed && <span className="text-ui text-ink-muted">{t('settings.phoneLink.failed')}</span>}
      <span className="flex-1" />
      {!status.paired ? (
        <button type="button" className={BTN} disabled={busy} onClick={pair}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t('common.copied') : t('settings.phoneLink.pair')}
        </button>
      ) : (
        <>
          <button type="button" className={BTN} disabled={busy} onClick={copyAgain}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t('common.copied') : t('settings.phoneLink.copy')}
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={unpair}>
            {t('settings.phoneLink.unpair')}
          </button>
        </>
      )}
      {status.paired && (
        <div className="flex w-full flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-ui text-ink">
            <BellRing
              size={14}
              className={status.pushKeyId && status.pushPhone && !status.pushRefused ? 'text-status-done' : 'text-ink-subtle'}
            />
            {!status.pushKeyId
              ? t('settings.phoneLink.push.off')
              : status.pushRefused
                ? t(status.pushRefusedBy === 'app' ? 'settings.phoneLink.push.refusedApp' : 'settings.phoneLink.push.refused')
                : status.pushPhone
                ? t('settings.phoneLink.push.on')
                : t('settings.phoneLink.push.waiting')}
          </span>
          {keyBad && <span className="text-ui text-ink-muted">{t('settings.phoneLink.push.bad')}</span>}
          <span className="flex-1" />
          {!keyForm ? (
            <button
              type="button"
              className={BTN}
              disabled={busy}
              onClick={() => (setKeyBad(false), setKeyForm({ p8: '', keyId: '', teamId: '' }))}
            >
              {status.pushKeyId ? t('settings.phoneLink.push.replace') : t('settings.phoneLink.push.add')}
            </button>
          ) : (
            <>
              <input
                type="file"
                accept=".p8"
                aria-label={t('settings.phoneLink.push.file')}
                disabled={busy}
                className="max-w-48 text-ui text-ink-muted file:mr-2 file:cursor-pointer file:rounded-[2px] file:border file:border-line-strong file:bg-bg-elevated file:px-2 file:py-1 file:text-ink-muted hover:file:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  const p8 = f ? await f.text() : ''
                  setKeyForm((k) => (k ? { ...k, p8 } : k))
                }}
              />
              <input
                type="text"
                placeholder="Key ID"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                className={INPUT}
                value={keyForm.keyId}
                onChange={(e) => setKeyForm({ ...keyForm, keyId: e.target.value })}
              />
              <input
                type="text"
                placeholder="Team ID"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                className={INPUT}
                value={keyForm.teamId}
                onChange={(e) => setKeyForm({ ...keyForm, teamId: e.target.value })}
              />
              <button
                type="button"
                className={BTN}
                disabled={busy || !keyForm.p8 || !keyForm.keyId.trim() || !keyForm.teamId.trim()}
                onClick={saveKey}
              >
                {t('common.save')}
              </button>
              <button type="button" className={BTN} disabled={busy} onClick={() => (setKeyForm(null), setKeyBad(false))}>
                {t('common.cancel')}
              </button>
            </>
          )}
        </div>
      )}
      {style && (
        <div className="flex w-full flex-col gap-2">
          <label htmlFor="assistant-style" className="text-ui text-ink">
            {t('settings.phoneLink.assistant.style')}
          </label>
          <textarea
            id="assistant-style"
            value={style.draft}
            onChange={(e) => setStyle({ ...style, draft: e.target.value })}
            disabled={busy}
            rows={4}
            maxLength={4000}
            className="w-full resize-y rounded-[3px] border border-line bg-bg-card px-2.5 py-2 text-ui leading-relaxed text-ink placeholder:text-ink-faint hover:border-line-strong focus:outline-none focus-visible:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
          />
          <div className="flex items-center justify-end gap-2">
            {styleFailed && <span className="text-ui text-ink-muted">{t('settings.phoneLink.assistant.failed')}</span>}
            {styleSaved && <Check size={14} className="text-status-done" aria-label={t('common.save')} />}
            <button type="button" className={BTN} disabled={busy || style.draft === style.saved} onClick={saveStyle}>
              {t('common.save')}
            </button>
          </div>
        </div>
      )}
      {style && <AssistantMemorySetting />}
    </div>
  )
}
