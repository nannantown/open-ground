import { useCallback, useEffect, useRef, useState } from 'react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import { openInBrowser } from '@/lib/auth/AuthContext'
import type { BillingState } from '@/lib/types'

export function BillingSection({ accountId }: { accountId?: string | null }) {
  const { lang } = useT()
  const ja = lang === 'ja'
  const [result, setResult] = useState<{ accountId?: string | null; state: BillingState } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const state = result?.accountId === accountId ? result?.state : undefined
  const refresh = useCallback(async () => {
    const request = ++seq.current
    try {
      const res = await fetch('/api/billing/state?refresh=1', { cache: 'no-store' })
      if (!res.ok) throw new Error('unavailable')
      const data = await res.json() as BillingState
      if (request !== seq.current) return
      setResult({ accountId, state: data })
      window.dispatchEvent(new Event('openground:billing-changed'))
    } catch {
      if (request === seq.current) setError(ja ? '契約状態を確認できません。再確認してください。' : 'Could not check your plan. Please refresh.')
    }
  }, [accountId, ja])
  useEffect(() => {
    setError('')
    void refresh()
    window.addEventListener('focus', refresh)
    return () => { ++seq.current; window.removeEventListener('focus', refresh) }
  }, [refresh])

  const openBilling = async (action: 'checkout' | 'portal') => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/billing/${action}`, { method: 'POST' })
      if (!res.ok) throw new Error('unavailable')
      const data = await res.json() as { url: string }
      if (!await openInBrowser(data.url)) throw new Error('browser')
    } catch { setError(ja ? '決済画面を開けません。再確認してからお試しください。' : 'Could not open billing. Refresh and try again.') }
    finally { setBusy(false) }
  }
  const plan = state?.plan ?? 'free'
  return (
    <div className="space-y-3" aria-busy={busy || !state}>
      <p className="text-ui text-ink">{plan === 'owner' ? 'Owner' : plan === 'pro' ? 'Pro · ¥2,980 / ' + (ja ? '月' : 'month') : 'Free · ¥0 / ' + (ja ? '月' : 'month')}</p>
      {plan !== 'owner' && <p className="text-ui text-ink-muted">{ja ? 'Pro：AI Worker自動配車・監視・復旧・司令官レビュー' : 'Pro: AI Worker dispatch, monitoring, recovery and commander review'}</p>}
      {state?.currentPeriodEnd && <p className="text-ui text-ink-muted">{state.cancelAtPeriodEnd ? (ja ? '利用期限：' : 'Access until: ') : (ja ? '契約期間終了：' : 'Current period ends: ')}{new Date(state.currentPeriodEnd).toLocaleDateString(ja ? 'ja-JP' : 'en-US')}</p>}
      {!accountId && plan !== 'owner' && <p className="text-ui text-ink-muted">{ja ? 'Proの利用にはサインインが必要です。' : 'Sign in to use Pro.'}</p>}
      {state?.configured === false && <p className="text-ui text-ink-muted">{ja ? 'Proの申し込みは準備中です。Freeは利用できます。' : 'Pro checkout is not available yet. Free is available.'}</p>}
      {state?.configured && !state.checkoutAvailable && plan !== 'owner' && <p className="text-ui text-ink-muted">{ja ? 'Proの新規申し込みは現在macOSのみ対応しています。' : 'Pro checkout is currently available on macOS only.'}</p>}
      <div className="flex flex-wrap gap-2">
        {plan === 'free' && <Btn variant="primary" disabled={busy || !accountId || !state?.checkoutAvailable} onClick={() => void openBilling('checkout')}>{ja ? 'Pro · 月額2,980円' : 'Pro · ¥2,980/month'}</Btn>}
        {accountId && state?.configured && plan !== 'owner' && <Btn disabled={busy} onClick={() => void openBilling('portal')}>{ja ? '支払い・解約' : 'Manage billing / cancel'}</Btn>}
        <Btn disabled={busy} onClick={() => { setError(''); void refresh() }}>{ja ? '再確認' : 'Refresh'}</Btn>
      </div>
      {error && <p role="alert" className="text-ui text-ink">{error}</p>}
    </div>
  )
}
