import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

const ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`saved custom tab renders and attaches without distribution at ${viewport.width}px`, async ({ page, request }, info) => {
    await page.setViewportSize(viewport)
    const project = await createAndImportProject(request, 'local-tab')
    const projectUrl = `/api/project?path=${encodeURIComponent(project.path)}`
    let revision = 1
    const retiredRequests: string[] = []
    page.on('request', req => {
      if (/\/api\/(marketplace|module-submissions)|\/publish(?:\?|$)/.test(req.url())) retiredRequests.push(req.url())
    })
    await page.route('**/api/experiments', route => route.fulfill({ json: {
      eligible: true, flags: { swarm: false, sandbox: false },
      swarmOptIn: { available: true, enabled: false },
    } }))
    // Never start a live editing session from the mocked owner library.
    await page.route('**/api/terminal/claude', route => route.fulfill({ status: 503, json: { error: 'fixture' } }))
    // The real server handles project attachment/persistence. These fixtures
    // supply a saved library without requiring a live owner login or Claude.
    await page.route('**/api/custom-modules', route => route.fulfill({ json: {
      role: 'owner',
      modules: [{
        id: ID, label: 'Saved tab', description: 'Existing local content',
        framework: 'html', origin: 'installed', version: 3,
        createdAt: '2026-06-12T00:00:00Z', updatedAt: '2026-06-12T00:00:00Z',
      }],
    } }))
    await page.route(`**/api/custom-modules/${ID}/source`, route => route.fulfill({ json: {
      source: `<html><body style="margin:0;padding:24px;font-family:system-ui;background:#fafafa;color:#111"><h1>Local tab ${revision}</h1><button onclick="this.textContent='Clicked'">Try tab</button></body></html>`,
      mtimeMs: revision, framework: 'html',
    } }))
    await page.addInitScript(id => {
      localStorage.setItem('openground:onboarded', '1')
      if (!localStorage.getItem('openground.view')) {
        localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'board' }))
      }
    }, project.id)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Add tab', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Add a tab to this project' })
    await expect(picker.getByText('Saved tab', { exact: true })).toBeVisible()
    await expect(picker.getByText(/marketplace/i)).toHaveCount(0)
    await picker.getByText('Saved tab', { exact: true }).click()
    await expect.poll(async () => (await (await request.get(projectUrl)).json()).customTabs).toContain(ID)
    const frame = page.frameLocator('iframe[title="Saved tab"]')
    await expect(frame.getByRole('heading', { name: 'Local tab 1' })).toBeVisible()
    await frame.getByRole('button', { name: 'Try tab' }).click()
    await expect(frame.getByRole('button', { name: 'Clicked' })).toBeVisible()
    await expect(page.getByRole('button', { name: /publish|submit for review/i })).toHaveCount(0)
    const box = await page.locator('iframe[title="Saved tab"]').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(200)
    expect(box!.height).toBeGreaterThan(200)
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
    await page.screenshot({ path: info.outputPath(`local-tab-${viewport.width}.png`), fullPage: true })

    revision = 2
    await expect(frame.getByRole('heading', { name: 'Local tab 2' })).toBeVisible()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(frame.getByRole('heading', { name: 'Local tab 2' })).toBeVisible()
    expect(retiredRequests).toEqual([])
  })
}
