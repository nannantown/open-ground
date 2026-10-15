// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { BillingSection } from './BillingSection'
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ lang: 'en' }) }))
const open = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/auth/AuthContext', () => ({ openInBrowser: open }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); open.mockClear() })
it('shows an unverified plan without suggesting that an existing subscription was cancelled', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ plan: 'free', status: 'unavailable', configured: true, checkoutAvailable: true })))
  render(<BillingSection accountId="a" />)
  expect(await screen.findByText('Plan not verified')).toBeInTheDocument()
  expect(await screen.findByText(/does not cancel a subscription/)).toBeInTheDocument()
  expect(screen.queryByText('Free · ¥0 / month')).toBeNull()
  expect(screen.getByRole('button', { name: 'Pro · ¥2,980/month' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Manage billing / cancel' })).toBeEnabled()
})
it('keeps billing management discoverable while work mode blocks it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ plan: 'free', status: 'lockdown', configured: true, checkoutAvailable: false })))
  render(<BillingSection accountId="a" />)
  expect(await screen.findByText(/Turn work mode off to manage billing/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Manage billing / cancel' })).toBeDisabled()
  expect(screen.queryByText(/not available yet/)).toBeNull()
})
it('Pro opens the existing external-browser helper for cancellation and surfaces upstream failures', async () => {
  let available = true
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/state')) return Response.json({ plan: 'pro', configured: true, checkoutAvailable: true, cancelAtPeriodEnd: true, currentPeriodEnd: Date.now() + 3600000 })
    return available ? Response.json({ url: 'https://billing.stripe.com/p/test' }) : new Response(null, { status: 503 })
  }))
  render(<BillingSection accountId="a" />)
  const button = await screen.findByRole('button', { name: 'Manage billing / cancel' })
  expect(await screen.findByText(/Access until:/)).toBeInTheDocument()
  fireEvent.click(button)
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://billing.stripe.com/p/test'))
  available = false
  await vi.waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not open billing')
})
it('changing accounts discards a late paid-state response', async () => {
  let finish: (r: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const view = render(<BillingSection accountId="a" />)
  const old = finish
  view.rerender(<BillingSection accountId="b" />)
  old(Response.json({ plan: 'pro', configured: true, checkoutAvailable: true }))
  expect(screen.getByRole('button', { name: 'Pro · ¥2,980/month' })).toBeDisabled()
  expect(screen.queryByText('Pro · ¥2,980 / month')).not.toBeInTheDocument()
})

it('changing accounts cannot open the previous account billing URL', async () => {
  let finish: (r: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/state')
    ? Promise.resolve(Response.json({ plan: 'pro', configured: true, checkoutAvailable: true }))
    : new Promise<Response>(resolve => { finish = resolve })))
  const view = render(<BillingSection accountId="a" />)
  const button = await screen.findByRole('button', { name: 'Manage billing / cancel' })
  fireEvent.click(button)
  view.rerender(<BillingSection accountId="b" />)
  finish(Response.json({ url: 'https://billing.stripe.com/p/account-a' }))
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Manage billing / cancel' })).not.toBeDisabled())
  expect(open).not.toHaveBeenCalled()
})
