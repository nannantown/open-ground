import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

for (const width of [1280, 390]) {
  test(`Free plan and safe unconfigured checkout at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => localStorage.setItem('openground:onboarded', '1'))
    const project = await createAndImportProject(request, 'free-plan')
    const state = await (await request.get('/api/billing/state')).json()
    expect(state).toMatchObject({ plan: 'free', configured: false })
    expect((await request.post('/api/billing/checkout')).status()).toBe(401)
    expect((await request.post('/api/swarm/worker', { data: { projectPath: project.path } })).status()).toBe(403)
    expect((await request.get(`/api/project/canvases?path=${encodeURIComponent(project.path)}`)).status()).toBe(403)
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog.getByText('Free · ¥0 / month', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Pro · ¥2,980/month', exact: true })).toBeDisabled()
    await expect(dialog.getByText('Pro checkout is not available yet. Free is available.')).toBeVisible()
    await expect(dialog.getByRole('group', { name: 'Enable Swarm on this Mac' })).toHaveCount(0)
    await expect(dialog).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    const bounds = await dialog.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
    await page.screenshot({ path: info.outputPath(`free-plan-${width}.png`), fullPage: true })
    await dialog.getByRole('button', { name: 'Close' }).click()
    await page.getByText(project.name, { exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Board', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible()
    await expect(page.getByTestId('swarm-bottom-bar')).toHaveCount(0)
  })
}
