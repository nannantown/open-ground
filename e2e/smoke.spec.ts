import { test, expect } from '@playwright/test'

// Smoke E2E — answers "does the app even boot?" in one shot. It
// deliberately doesn't exercise Goal/Milestone flows (those need a
// real claude binary + project root) and doesn't touch the canvas
// pan/zoom interactions (those are the e2e candidates for the next
// pass). The bar here is: a fresh dev server returns the home page,
// the /api/run/list endpoint answers, no obvious console errors.

test.describe('Home page boots', () => {
  test('responds to /api/run/list with 200', async ({ request }) => {
    const res = await request.get('/api/run/list')
    expect(res.status()).toBe(200)
    const body = await res.json()
    // Shape check — sessions is always an array (possibly empty).
    expect(Array.isArray(body.sessions)).toBe(true)
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
    // The cockpit keeps long-lived SSE subscriptions open, so we can't use
    // `networkidle` — there's never a 500ms quiet window. Wait for the
    // root DOM + a generous settle to let async data fetches resolve any
    // render-time errors before we sample the console.
    await expect(page.locator('body')).toBeVisible()
    await page.waitForTimeout(2000)
    expect(consoleErrors).toEqual([])
  })

  test('does not return 500 on /api/projects', async ({ request }) => {
    // Even when projectsRoot isn't set, the endpoint should answer
    // gracefully (empty list, not a crash).
    const res = await request.get('/api/projects')
    expect(res.status()).toBeLessThan(500)
  })
})
