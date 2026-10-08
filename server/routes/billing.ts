import { Hono } from 'hono'
import { billingRequest, getBillingState } from '@/lib/server/billing'
import { readSession } from '@/lib/server/authStore'

export const billingRoutes = new Hono()
  .get('/api/billing/state', async (c) => c.json(await getBillingState(c.req.query('refresh') === '1')))
  .post('/api/billing/:action', async (c) => {
    const action = c.req.param('action')
    if (action !== 'checkout' && action !== 'portal') return c.json({ error: 'not found' }, 404)
    if (!await readSession()) return c.json({ error: 'sign in required' }, 401)
    if (action === 'checkout' && process.platform !== 'darwin') return c.json({ error: 'Pro checkout is currently available on macOS' }, 503)
    try {
      const res = await billingRequest(`/${action}`, 'POST')
      if (!res) return c.json({ error: 'billing not configured or unavailable' }, 503)
      if (!res.ok) return c.json({ error: res.status === 409 ? 'use billing management for your existing subscription' : 'billing unavailable' }, res.status === 409 ? 409 : 503)
      const body = await res.json() as { url?: string }
      const url = new URL(body.url ?? '')
      if (url.protocol !== 'https:' || !['checkout.stripe.com', 'billing.stripe.com'].includes(url.hostname) || url.username || url.password) throw new Error('invalid billing URL')
      return c.json({ url: url.href })
    } catch { return c.json({ error: 'billing unavailable' }, 503) }
  })
