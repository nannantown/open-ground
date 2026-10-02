// PhoneLinkSetting — pair the owner's iPhone with the president desks
// (src/lib/server/phoneLink.ts, docs/PHONE_LINK.md). Owner-only: the route
// answers 403 to anyone else and then nothing — not even `frame` — renders.
// Pairing copies a code to the clipboard; the iPhone app pastes it (Universal
// Clipboard). Unpairing erases the relay room and the old code stops working.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, Smartphone } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'

interface Status {
  paired: boolean
  online: boolean
}

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

  const load = useCallback(() => {
    fetch('/api/phone-link')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setStatus(s ? { paired: s.paired === true, online: s.online === true } : null))
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
    </div>
  )
}
