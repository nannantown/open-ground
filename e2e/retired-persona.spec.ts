import { test, expect } from '@playwright/test'

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Persona stays absent from Ground and Settings at ${viewport.width}px`, async ({ page, request }, info) => {
    await page.setViewportSize(viewport)
    await page.addInitScript(() => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.removeItem('openground.view')
    })
    // A stale client response must not resurrect the removed surface.
    await page.route('**/api/experiments', route => route.fulfill({ json: {
      eligible: true, flags: { swarm: true, sandbox: true, persona: true },
      personaOptIn: { available: true, enabled: true },
    } }))
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const settings = page.getByRole('button', { name: 'Settings', exact: true })
    await expect(settings).toBeVisible()
    await expect(page.getByRole('button', { name: 'Persona', exact: true })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`ground-${viewport.width}.png`), fullPage: true })
    await settings.click()
    await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect.poll(async () => {
      const bounds = await dialog.boundingBox()
      return bounds ? Math.round(bounds.x + bounds.width) : null
    }).toBe(viewport.width)
    await expect(page.getByText('Persona', { exact: false })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`settings-${viewport.width}.png`), fullPage: true, animations: 'disabled' })
    expect((await request.get('/api/persona/courses')).status()).toBe(404)
    expect((await request.get('/api/you-corpus/raw')).status()).toBe(404)
  })
}
