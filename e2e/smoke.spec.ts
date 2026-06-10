import { test, expect } from '@playwright/test'

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

  test('renders the root document', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text()
        // Filter out hydration / dev-time noise that doesn't represent a
        // real regression. The list is short on purpose — anything else
        // should fail the test.
        if (text.includes('Warning: ') || text.includes('hydrat')) return
        consoleErrors.push(text)
      }
    })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // Wait for the root DOM + a generous settle to let async data fetches
    // resolve any render-time errors before we sample the console.
    await expect(page.locator('body')).toBeVisible()
    await page.waitForTimeout(2000)
    expect(consoleErrors).toEqual([])
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
