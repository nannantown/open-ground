import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { getBillingState, billingUrl } from './billing'
const h = vi.hoisted(() => ({
  user: 'a', token: 'a-token', role: 'none', lockdown: false,
}))
vi.mock('./authStore', () => ({ readSession: async () => h.user ? { user: { id: h.user }, accessToken: h.token } : null }))
vi.mock('./supabaseAuth', () => ({ getFreshAccessToken: async () => h.user ? h.token : null }))
vi.mock('./roles', () => ({ getCustomTabRole: async () => h.role }))
vi.mock('./lockdown', () => ({ isLockdownEnabledSync: () => h.lockdown }))
beforeEach(() => {
  h.user = 'a'; h.token = `token-${Math.random()}`; h.role = 'none'; h.lockdown = false
  vi.stubEnv('OPENGROUND_BILLING_URL', 'https://billing.example')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const paid = () => ({ plan: 'pro', status: 'active', currentPeriodEnd: Date.now() + 60_000, cancelAtPeriodEnd: false })

describe('paid entitlement', () => {
  it('defaults Free for missing config, sign-out and lockdown without network', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    vi.stubEnv('OPENGROUND_BILLING_URL', '')
    expect((await getBillingState()).plan).toBe('free')
    vi.stubEnv('OPENGROUND_BILLING_URL', 'https://billing.example'); h.user = ''
    expect((await getBillingState()).plan).toBe('free')
    h.user = 'a'; h.lockdown = true
    expect((await getBillingState()).plan).toBe('free')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('honours active paid periods; rejects expired or delinquent responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(paid())))
    expect((await getBillingState(true)).plan).toBe('pro')
    for (const invalid of [{ ...paid(), currentPeriodEnd: Date.now() - 1 }, { ...paid(), status: 'past_due' }, { ...paid(), currentPeriodEnd: null }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(invalid)))
      expect((await getBillingState(true)).plan).toBe('free')
    }
  })
  it('network failure cannot serve stale paid access', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(paid())))
    expect((await getBillingState(true)).plan).toBe('pro')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect((await getBillingState(true)).plan).toBe('free')
    expect((await getBillingState()).plan).toBe('free')
  })
  it('drops a paid response when the account changed during the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { h.user = 'b'; return Response.json(paid()) }))
    expect((await getBillingState(true)).plan).toBe('free')
  })
  it('preserves Owner access with billing unavailable', async () => {
    h.role = 'owner'; vi.stubEnv('OPENGROUND_BILLING_URL', '')
    expect((await getBillingState()).plan).toBe('owner')
  })
  it('accepts only HTTPS service URLs without embedded credentials', () => {
    for (const url of ['http://billing.example', 'https://user:pass@billing.example', 'https://billing.example?x=1']) {
      vi.stubEnv('OPENGROUND_BILLING_URL', url); expect(billingUrl()).toBeNull()
    }
  })
})
