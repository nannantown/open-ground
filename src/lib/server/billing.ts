// Paid access is resolved by the hosted service. No payment secret belongs here.
import { readSession } from './authStore'
import { getFreshAccessToken } from './supabaseAuth'
import { getCustomTabRole } from './roles'
import { isLockdownEnabledSync } from './lockdown'

import type { BillingState } from '../types'

export const billingUrl = (): string | null => {
  try {
    const url = new URL(process.env.OPENGROUND_BILLING_URL ?? '')
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url.href.replace(/\/$/, '') : null
  } catch { return null }
}

const free = (): BillingState => ({
  checkoutAvailable: process.platform === 'darwin' && !!billingUrl() && !isLockdownEnabledSync(),
  plan: 'free', configured: !!billingUrl() && !isLockdownEnabledSync(),
  status: 'none', currentPeriodEnd: null, cancelAtPeriodEnd: false,
})
// Cache only successful, validated answers, by account AND token. Never use stale
// paid access on network failure. A bounded 30s refresh also covers cancellation.
let cached: { key: string; at: number; state: BillingState } | null = null
let pending: { key: string; promise: Promise<BillingState> } | null = null

export const billingRequest = async (path: string, method = 'GET'): Promise<Response | null> => {
  const base = billingUrl()
  if (!base || isLockdownEnabledSync()) return null
  const token = await getFreshAccessToken()
  if (!token) return null
  return fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  })
}

export const getBillingState = async (force = false): Promise<BillingState> => {
  if (await getCustomTabRole() === 'owner') return { ...free(), plan: 'owner', status: 'owner' }
  const session = await readSession()
  if (!session || !billingUrl() || isLockdownEnabledSync()) return free()
  const key = `${session.user.id}:${session.accessToken}`
  const now = Date.now()
  if (!force && cached?.key === key && now - cached.at < 30_000) {
    return cached.state.plan === 'pro' && (cached.state.currentPeriodEnd ?? 0) <= now
      ? free() : cached.state
  }
  if (pending?.key === key) return pending.promise
  const promise = (async (): Promise<BillingState> => {
    try {
      const res = await billingRequest('/state')
      if (!res?.ok) throw new Error('billing unavailable')
      const body = await res.json() as Partial<BillingState>
      const end = body.currentPeriodEnd
      const paid = body.plan === 'pro' && body.status === 'active' && typeof end === 'number' && Number.isFinite(end) && end > Date.now()
      const state: BillingState = {
        ...free(), plan: paid ? 'pro' : 'free',
        status: typeof body.status === 'string' ? body.status : 'none',
        currentPeriodEnd: typeof end === 'number' && Number.isFinite(end) ? end : null,
        cancelAtPeriodEnd: body.cancelAtPeriodEnd === true,
      }
      // A sign-out/account change while fetching cannot grant the new account access.
      const current = await readSession()
      if (current?.user.id !== session.user.id) return free()
      cached = { key, at: Date.now(), state }
      return state
    } catch { cached = null; return { ...free(), status: 'unavailable' } }
  })()
  pending = { key, promise }
  try { return await promise } finally { if (pending?.promise === promise) pending = null }
}
