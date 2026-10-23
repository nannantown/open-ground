import { test, expect } from '@playwright/test'
import { unexpectedBootConsoleErrors, type BootConsoleError } from './fixtures/publicBootConsole'

// Smoke E2E — answers "does the app even boot?" in one shot. It doesn't
// spawn a real claude binary and doesn't touch the canvas pan/zoom
// interactions (those are the e2e candidates for the next pass). The bar
// here is: a fresh prod server returns the home page, the health endpoint
// answers, no obvious console errors.

test.describe('Home page boots', () => {
  test('responds to /api/health with the identity contract', async ({ request }) => {
    const res = await request.get('/api/health')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.app).toBe('openground')
  })

  test('renders the root document and preserves the non-owner assistant refusal', async ({ page, baseURL }) => {
    const consoleErrors: BootConsoleError[] = []
    const runtimeErrors: string[] = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text()
        // Filter out hydration / dev-time noise that doesn't represent a
        // real regression. The list is short on purpose — anything else
        // should fail the test.
        if (text.includes('Warning: ') || text.includes('hydrat')) return
        consoleErrors.push({ text, url: msg.location().url })
      }
    })
    const ownerLogUrl = new URL('/api/phone-link/assistant/log', baseURL).href
    const refusal = page.waitForResponse((response) => response.url() === ownerLogUrl && response.request().method() === 'GET')
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const response = await refusal
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
    // A denied log must not become an empty, usable assistant. The default
    // character name would be visible if the hook accepted this refusal.
    await expect(page.getByRole('button', { name: 'ノノ', exact: true })).toHaveCount(0)
    await expect(page.locator('[data-og-assistant]')).toHaveCount(0)
    // Wait for the root DOM + a generous settle to let async data fetches
    // resolve any render-time errors before we sample the console.
    await expect(page.locator('body')).toBeVisible()
    await page.waitForTimeout(2000)
    expect(runtimeErrors).toEqual([])
    expect(unexpectedBootConsoleErrors(consoleErrors, ownerLogUrl)).toEqual([])
  })

  test('does not return 500 on /api/projects', async ({ request }) => {
    // A fresh install has an empty registry — the endpoint should answer
    // gracefully with an empty projects list, not a crash.
    const res = await request.get('/api/projects')
    expect(res.status()).toBeLessThan(500)
    const body = await res.json()
    expect(Array.isArray(body.projects)).toBe(true)
  })
})
