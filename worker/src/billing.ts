// Dedicated hosted billing Worker. Never bundle these secrets into Electron.
import { verifySupabaseJwt, type JwtEnv } from './jwt'

export interface BillingEnv extends JwtEnv {
  SUPABASE_SERVICE_ROLE_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_PRO_PRICE_ID?: string
  BILLING_RETURN_URL?: string
}
interface Row {
  user_id: string
  customer_id: string
  status: string
  current_period_end: string | null
  cancel_at_period_end: boolean
}
interface Subscription {
  id: string
  status: string
  cancel_at_period_end?: boolean
  pause_collection?: unknown
  items: { data: Array<{ current_period_end?: number; quantity?: number; price: { id: string } }> }
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const configured = (env: BillingEnv): boolean => {
  try {
    return !!(env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRO_PRICE_ID) &&
      new URL(env.SUPABASE_URL ?? '').protocol === 'https:' && new URL(env.BILLING_RETURN_URL ?? '').protocol === 'https:'
  } catch { return false }
}

const stripe = async <T>(env: BillingEnv, path: string, data?: Record<string, string>, key?: string): Promise<T> => {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: data ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2025-06-30.basil',
      ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: data ? new URLSearchParams(data) : undefined,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error('Stripe request failed')
  return res.json() as Promise<T>
}
const db = async <T>(env: BillingEnv, path: string, method = 'GET', body?: unknown): Promise<T> => {
  const res = await fetch(`${env.SUPABASE_URL?.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error('Billing storage unavailable')
  return (res.status === 204 ? undefined : await res.json()) as T
}
const rows = (env: BillingEnv, field: 'user_id' | 'customer_id', value: string): Promise<Row[]> =>
  db(env, `og_billing?${field}=eq.${encodeURIComponent(value)}&select=*`)

export const subscriptionSnapshot = (subs: Subscription[], priceId: string, now = Date.now()) => {
  const matching = subs.filter(s => s.items?.data?.some(i => i.price.id === priceId))
  const entitled = matching.filter(s => s.status === 'active' && !s.pause_collection && s.items.data.some(i =>
    i.price.id === priceId && i.quantity === 1 && (i.current_period_end ?? 0) * 1000 > now))
  const sub = entitled[0] ?? matching[0]
  const end = sub?.items.data.find(i => i.price.id === priceId)?.current_period_end
  return {
    status: entitled.length ? 'active' : sub?.status === 'active' ? 'expired' : sub?.status ?? 'none',
    end: typeof end === 'number' && Number.isFinite(end) ? new Date(end * 1000).toISOString() : null,
    cancel: sub?.cancel_at_period_end === true,
  }
}

const syncCustomer = async (env: BillingEnv, customer: string): Promise<Row | null> => {
  const row = (await rows(env, 'customer_id', customer))[0]
  if (!row) return null // Never trust webhook metadata to create an account mapping.
  const checked = new Date().toISOString()
  const all: Subscription[] = []
  let after = ''
  for (;;) {
    const page = await stripe<{ data: Subscription[]; has_more: boolean }>(env,
      `/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`)
    all.push(...page.data)
    if (!page.has_more) break
    if (!page.data.length) throw new Error('Invalid Stripe pagination')
    after = page.data[page.data.length - 1].id
  }
  const s = subscriptionSnapshot(all, env.STRIPE_PRO_PRICE_ID!)
  await db(env, 'rpc/og_apply_billing_snapshot', 'POST', {
    p_customer_id: customer, p_status: s.status, p_end: s.end,
    p_cancel: s.cancel, p_checked_at: checked,
  })
  return (await rows(env, 'customer_id', customer))[0] ?? null
}
const stateOf = (row: Row | null) => {
  const end = row?.current_period_end ? Date.parse(row.current_period_end) : null
  return {
    plan: row?.status === 'active' && end !== null && end > Date.now() ? 'pro' : 'free',
    configured: true, status: row?.status ?? 'none', currentPeriodEnd: end,
    cancelAtPeriodEnd: row?.cancel_at_period_end === true,
  }
}

// Stripe signs the RAW body with timestamp + HMAC-SHA256. Web Crypto performs
// constant-time signature verification; 5-minute tolerance blocks old replays.
export const verifyStripeSignature = async (raw: string, header: string, secret: string, now = Date.now()): Promise<boolean> => {
  const fields = header.split(',').map(x => x.trim().split('='))
  const ts = fields.find(([k]) => k === 't')?.[1]
  if (!ts || !/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 300) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  for (const [name, hex] of fields) {
    if (name !== 'v1' || !/^[a-f0-9]{64}$/.test(hex ?? '')) continue
    const sig = Uint8Array.from(hex.match(/../g)!, h => parseInt(h, 16))
    if (await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${ts}.${raw}`))) return true
  }
  return false
}

export default {
  async fetch(request: Request, env: BillingEnv): Promise<Response> {
    const path = new URL(request.url).pathname
    if (!['/state', '/checkout', '/portal', '/webhook'].includes(path)) return json({ error: 'not found' }, 404)
    if (!configured(env)) return json({ error: 'billing not configured' }, 503)
    try {
      if (path === '/webhook') {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
        if (Number(request.headers.get('content-length') ?? 0) > 262144) return json({ error: 'too large' }, 413)
        const reader = request.body?.getReader()
        const decoder = new TextDecoder()
        let raw = '', bytes = 0
        if (reader) for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 262144) { await reader.cancel(); return json({ error: 'too large' }, 413) }
          raw += decoder.decode(chunk.value, { stream: true })
        }
        raw += decoder.decode()
        if (!await verifyStripeSignature(raw, request.headers.get('stripe-signature') ?? '', env.STRIPE_WEBHOOK_SECRET!)) return json({ error: 'invalid signature' }, 400)
        const event = JSON.parse(raw) as { type?: string; data?: { object?: { customer?: string } } }
        const customer = event.data?.object?.customer
        if ((event.type?.startsWith('customer.subscription.') || ['invoice.paid', 'invoice.payment_failed', 'checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type ?? '')) && typeof customer === 'string') {
          // Re-read Stripe, rather than applying an event's possibly stale snapshot.
          // Repeated deliveries have the same outcome; errors return 503 for retry.
          await syncCustomer(env, customer)
        }
        return json({ received: true })
      }
      if (request.method !== (path === '/state' ? 'GET' : 'POST')) return json({ error: 'method not allowed' }, 405)
      const auth = await verifySupabaseJwt(request.headers.get('authorization')?.replace(/^Bearer /, ''), env)
      if (!auth || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(auth.sub)) return json({ error: 'sign in required' }, 401)
      let row: Row | null = (await rows(env, 'user_id', auth.sub))[0] ?? null
      if (path === '/state') return json(stateOf(row ? await syncCustomer(env, row.customer_id) : null))
      if (path === '/portal') {
        if (!row) return json({ error: 'no billing account' }, 409)
        const session = await stripe<{ url: string }>(env, '/billing_portal/sessions', { customer: row.customer_id, return_url: env.BILLING_RETURN_URL! })
        return json({ url: session.url })
      }
      // Refuse a mispriced, yearly or archived product before taking payment.
      const price = await stripe<{ active: boolean; currency: string; unit_amount: number; recurring?: { interval: string; interval_count: number } }>(env, `/prices/${encodeURIComponent(env.STRIPE_PRO_PRICE_ID!)}`)
      if (!price.active || price.currency !== 'jpy' || price.unit_amount !== 2980 || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) return json({ error: 'Pro price misconfigured' }, 503)
      if (!row) {
        const customer = await stripe<{ id: string }>(env, '/customers', { 'metadata[user_id]': auth.sub }, `og-customer-${auth.sub}`)
        await db(env, 'og_billing', 'POST', { user_id: auth.sub, customer_id: customer.id })
        row = (await rows(env, 'user_id', auth.sub))[0]
        if (!row) throw new Error('Billing account not persisted')
      }
      const existing = await stripe<{ data: Subscription[]; has_more: boolean }>(env, `/subscriptions?customer=${encodeURIComponent(row.customer_id)}&status=all&limit=100`)
      if (existing.has_more || existing.data.some(s => !['canceled', 'incomplete_expired'].includes(s.status))) return json({ error: 'use billing management' }, 409)
      // Reuse an open Checkout across concurrent requests/devices. Stripe handles
      // its single completion; a new hourly key alone would allow two charges.
      const recent = await stripe<{ data: Array<{ id: string; url: string; status: string }> }>(env, `/checkout/sessions?customer=${encodeURIComponent(row.customer_id)}&limit=1`)
      const previous = recent.data[0]
      if (previous?.status === 'open') return json({ url: previous.url })
      // Checkout may have completed AFTER the first subscription read. Re-check
      // before using the completed session as the next idempotency generation.
      if (previous?.status === 'complete') {
        const latest = await stripe<{ data: Subscription[]; has_more: boolean }>(env, `/subscriptions?customer=${encodeURIComponent(row.customer_id)}&status=all&limit=100`)
        if (latest.has_more || latest.data.some(s => !['canceled', 'incomplete_expired'].includes(s.status))) return json({ error: 'use billing management' }, 409)
      }
      const session = await stripe<{ url: string; status: string }>(env, '/checkout/sessions', {
        mode: 'subscription', customer: row.customer_id,
        'line_items[0][price]': env.STRIPE_PRO_PRICE_ID!, 'line_items[0][quantity]': '1',
        'payment_method_types[0]': 'card',
        success_url: `${env.BILLING_RETURN_URL!}?billing=success`, cancel_url: `${env.BILLING_RETURN_URL!}?billing=cancel`,
        'subscription_data[metadata][user_id]': auth.sub,
      }, `og-checkout-${auth.sub}-${previous?.id ?? 'first'}`)
      if (session.status !== 'open' || !session.url) return json({ error: 'checkout already completed; refresh account' }, 409)
      return json({ url: session.url })
    } catch { return json({ error: 'billing unavailable' }, 503) }
  },
}
