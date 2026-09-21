import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

for (const width of [1280, 390]) {
  for (const owner of [false, true]) {
    test(`manager has no runtime selector: ${owner ? 'owner' : 'public'} at ${width}px`, async ({ page, request }, info) => {
      await page.setViewportSize({ width, height: 900 })
      const project = await createAndImportProject(request, 'sdk-manager')
      await request.post('/api/settings', { data: { swarmOptIn: true, swarmPaneOrder: ['manager', 'supply', 'workers', 'overseer'] } })
      await page.route('**/api/experiments', route => route.fulfill({ json: {
        eligible: owner, flags: { swarm: true, sandbox: false },
        swarmOptIn: { available: true, enabled: true },
      } }))
      await page.route('**/api/settings', async route => {
        const response = await route.fetch()
        await route.fulfill({ response, json: { ...await response.json(), swarmManagerRuntime: { mode: 'pty' } } })
      })
      // Render the active dashboard without starting a real engine or model.
      await page.route('**/api/swarm/orchestrator?*', async route => {
        const response = await route.fetch()
        await route.fulfill({ response, json: { ...await response.json(), running: true } })
      })
      await page.addInitScript(id => {
        localStorage.setItem('openground:onboarded', '1')
        localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'board' }))
      }, project.id)
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'Swarm', exact: true }).click()
      await expect(page.getByRole('tab', { name: 'Manager', exact: true })).toBeVisible()
      await page.getByRole('tab', { name: 'Manager', exact: true }).click()
      await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click()
      const monitoring = page.getByRole('group', { name: 'Monitoring', exact: true })
      await expect(monitoring).toBeVisible()
      await monitoring.scrollIntoViewIfNeeded()
      const bounds = await monitoring.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      await expect(page.getByText('Runtime (experimental · all projects)', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('group', { name: 'Commander on the Agent SDK', exact: true })).toHaveCount(0)
      await page.screenshot({ path: info.outputPath('manager.png'), fullPage: true, animations: 'disabled' })
    })
  }
}
