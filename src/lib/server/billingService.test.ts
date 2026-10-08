import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { handleTicketRequest } from '../../../worker/src/issueTicket'
import { createHmac } from 'node:crypto'
import billing, { verifyStripeSignature, subscriptionSnapshot, type BillingEnv } from '../../../worker/src/billing'
const h = { user: '11111111-2222-4333-8444-555555555555' }
let keys: CryptoKeyPair
let publicJwk: JsonWebKey
beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
})
const jwt = async (sub: string) => {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'billing-test' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ sub, aud: 'authenticated', iss: 'https://auth.example/auth/v1', exp: Date.now() / 1000 + 3600 })).toString('base64url')
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`
}
const env: BillingEnv = {
  SUPABASE_URL: 'https://auth.example', SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'private',
  STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRO_PRICE_ID: 'price_pro',
  BILLING_RETURN_URL: 'https://open-ground.app/billing',
}
const sub = (status = 'active', seconds = Date.now() / 1000 + 3600) => ({ id: 'sub_1', status, cancel_at_period_end: false, items: { data: [{ current_period_end: seconds, quantity: 1, price: { id: 'price_pro' } }] } })
let row: { user_id: string; customer_id: string; status: string; current_period_end: string | null; cancel_at_period_end: boolean } | null = null
let appOwner = false
let subscriptions: ReturnType<typeof sub>[] = []
let price = 2980
let checkoutCreates = 0
let failStorage = false
beforeEach(() => {
  appOwner = false
  row = null; subscriptions = []; price = 2980; checkoutCreates = 0; failStorage = false
  h.user = '11111111-2222-4333-8444-555555555555'
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [{ ...publicJwk, kid: 'billing-test' }] })
    if (url.pathname.endsWith('/og_roles')) return Response.json([{ role: appOwner ? 'owner' : 'tester' }])
    if (url.pathname.endsWith('/og_project_members')) return Response.json([{ user_id: h.user, role: 'owner', status: 'accepted' }])
    if (url.hostname === 'auth.example') {
      if (failStorage) return new Response('', { status: 503 })
      if (url.pathname.endsWith('/rpc/og_apply_billing_snapshot')) {
        const body = JSON.parse(init?.body as string)
        if (row && row.customer_id === body.p_customer_id) Object.assign(row, { status: body.p_status, current_period_end: body.p_end, cancel_at_period_end: body.p_cancel })
        return new Response(null, { status: 204 })
      }
      if (init?.method === 'POST') row ??= { ...JSON.parse(init.body as string), status: 'none', current_period_end: null, cancel_at_period_end: false }
      const filter = url.searchParams.get('user_id')
      return Response.json(row && (!filter || filter === `eq.${row.user_id}`) ? [row] : [])
    }
    if (url.hostname !== 'api.stripe.com') throw new Error('unexpected egress')
    if (url.pathname.startsWith('/v1/prices/')) return Response.json({ active: true, currency: 'jpy', unit_amount: price, recurring: { interval: 'month', interval_count: 1 } })
    if (url.pathname === '/v1/customers') return Response.json({ id: 'cus_1' })
    if (url.pathname === '/v1/subscriptions') return Response.json({ data: subscriptions, has_more: false })
    if (url.pathname === '/v1/billing_portal/sessions') return Response.json({ url: 'https://billing.stripe.com/p/session' })
    if (url.pathname === '/v1/checkout/sessions' && init?.method === 'POST') { checkoutCreates++; return Response.json({ status: 'open', url: 'https://checkout.stripe.com/c/session' }) }
    if (url.pathname === '/v1/checkout/sessions') return Response.json({ data: [], has_more: false })
    throw new Error('unexpected Stripe endpoint')
  }))
})
afterEach(() => vi.unstubAllGlobals())
const call = async (path: string, method = 'GET', token = 'valid') => billing.fetch(new Request(`https://billing.example${path}`, { method, headers: { authorization: `Bearer ${token === 'valid' ? await jwt(h.user) : token}` } }), env)
const event = async (type = 'customer.subscription.updated') => {
  const raw = JSON.stringify({ type, data: { object: { customer: 'cus_1' } } })
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET!).update(`${ts}.${raw}`).digest('hex')
  return billing.fetch(new Request('https://billing.example/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}` }, body: raw }), env)
}

describe('hosted billing lifecycle', () => {
  it('missing secrets fail closed, and forged identities never reach Stripe or DB', async () => {
    expect((await billing.fetch(new Request('https://billing.example/state'), {})).status).toBe(503)
    expect((await call('/checkout', 'POST', 'forged')).status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('checkout persists a server-owned account mapping before creating the payment session', async () => {
    expect((await (await call('/checkout', 'POST')).json()).url).toContain('checkout.stripe.com')
    expect(row?.user_id).toBe(h.user)
    expect(row?.customer_id).toBe('cus_1')
    expect(checkoutCreates).toBe(1)
    expect((await (await call('/state')).json()).plan).toBe('free')
  })
  it('rejects the wrong price or unavailable storage without checkout', async () => {
    price = 3000; expect((await call('/checkout', 'POST')).status).toBe(503)
    price = 2980; failStorage = true; expect((await call('/checkout', 'POST')).status).toBe(503)
    expect(checkoutCreates).toBe(0)
  })
  it('updates paid access, cancellation, failed renewal, recovery and expiry from canonical Stripe state', async () => {
    await call('/checkout', 'POST')
    subscriptions = [sub()]
    expect((await event()).status).toBe(200)
    expect((await (await call('/state')).json()).plan).toBe('pro')
    subscriptions[0].cancel_at_period_end = true
    await event(); expect((await (await call('/state')).json()).cancelAtPeriodEnd).toBe(true)
    subscriptions = [sub('past_due')]; await event('invoice.payment_failed')
    expect((await (await call('/state')).json()).plan).toBe('free')
    subscriptions = [sub()]; await event('invoice.paid')
    expect((await (await call('/state')).json()).plan).toBe('pro')
    subscriptions = [sub('active', Date.now() / 1000 - 1)]; await event()
    expect((await (await call('/state')).json()).plan).toBe('free')
    subscriptions = [sub('canceled')]; await event('customer.subscription.deleted')
    expect((await (await call('/state')).json()).status).toBe('canceled')
  })
  it('does not grant another account access or create a duplicate active subscription', async () => {
    await call('/checkout', 'POST'); subscriptions = [sub()]
    expect((await call('/checkout', 'POST')).status).toBe(409)
    expect(checkoutCreates).toBe(1)
    h.user = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    expect((await (await call('/state')).json()).plan).toBe('free')
  })
  it('replayed/out-of-order events re-read Stripe; storage faults request webhook retry', async () => {
    await call('/checkout', 'POST'); subscriptions = [sub('canceled')]
    await event('customer.subscription.created'); await event('customer.subscription.created')
    expect(row?.status).toBe('canceled')
    failStorage = true; expect((await event()).status).toBe(503)
  })
  it('portal allows cancellation without buying again', async () => {
    await call('/checkout', 'POST')
    expect((await (await call('/portal', 'POST')).json()).url).toContain('billing.stripe.com')
  })
  it('rejects invalid, tampered and expired webhook signatures', async () => {
    const raw = '{}', ts = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', 'secret').update(`${ts}.${raw}`).digest('hex')
    expect(await verifyStripeSignature(raw, `t=${ts},v1=${sig}`, 'secret')).toBe(true)
    expect(await verifyStripeSignature('changed', `t=${ts},v1=${sig}`, 'secret')).toBe(false)
    expect(await verifyStripeSignature(raw, `t=${ts},v1=${sig}`, 'secret', (ts + 301) * 1000)).toBe(false)
    expect(await verifyStripeSignature(raw, 'garbage', 'secret')).toBe(false)
  })
  it('caps unsigned webhook bodies even without Content-Length', async () => {
    const res = await billing.fetch(new Request('https://billing.example/webhook', { method: 'POST', body: 'x'.repeat(262145) }), env)
    expect(res.status).toBe(413)
  })
  it('other products, trials and paused collection cannot grant Pro', () => {
    expect(subscriptionSnapshot([sub('trialing')], 'price_pro').status).toBe('trialing')
    expect(subscriptionSnapshot([sub()], 'another_price').status).toBe('none')
    expect(subscriptionSnapshot([{ ...sub(), pause_collection: {} }], 'price_pro').status).toBe('expired')
  })
})

it('shared Canvas tickets require App Owner as well as project membership', async () => {
  const request = async (scope: string) => {
    const req = new Request('https://collab.example/ticket', { method: 'POST', headers: { authorization: `Bearer ${await jwt(h.user)}` }, body: JSON.stringify({ pid: h.user, scope }) })
    return handleTicketRequest(req, { ...env, OPENGROUND_COLLAB_TICKET_SECRET: 'test-secret' }, new URL(req.url))
  }
  expect((await request('board'))?.status).toBe(200)
  expect((await request('canvas:one'))?.status).toBe(403)
  appOwner = true
  expect((await request('canvas:one'))?.status).toBe(200)
})

it('Checkout completion during subscription reads cannot create a second subscription', async () => {
  await call('/checkout', 'POST')
  const original = fetch
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/subscriptions') return Response.json({ data: ++reads === 1 ? [] : [sub()], has_more: false })
    if (url.pathname === '/v1/checkout/sessions' && init?.method !== 'POST') return Response.json({ data: [{ id: 'cs_finished', status: 'complete' }] })
    return original(input, init)
  }))
  expect((await call('/checkout', 'POST')).status).toBe(409)
  expect(checkoutCreates).toBe(1)
})
