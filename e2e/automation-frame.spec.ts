import { expect, test } from '@playwright/test'
import { automationFrameMembership } from '../src/lib/automationFrame'
import type { CanvasState } from '../src/lib/types'

const projectId = '11111111-1111-4111-8111-111111111111'

// All API traffic is a synthetic in-memory fixture; no project, engine, model,
// subscription, or ordinary app state is accessed by this browser test.
for (const theme of ['light', 'dark']) test(`automation frame membership survives drag, resize, and reload in ${theme}`, async ({ page }, info) => {
  let canvas: CanvasState = {
    positions: { [projectId]: { x: 40, y: 100 } }, viewport: { x: 0, y: 0, zoom: 1 },
    elements: [{ id: 'ordinary', type: 'frame', text: 'My Projects', x: 0, y: 40, width: 340, height: 300 }],
  }
  const project = { id: projectId, name: 'Synthetic project', path: '/synthetic/project', hasGit: true,
    description: '', lastModified: '2026-11-06T00:00:00Z', openTaskCount: 0, totalTaskCount: 0 }
  const settings = { projects: [], projectsRoot: null, excludePatterns: [], theme }
  const writes: CanvasState[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let json: unknown = {}
    if (path === '/api/canvas' && route.request().method() === 'POST') {
      const next = route.request().postDataJSON() as CanvasState
      if (next.automation) next.automation.revision = (canvas.automation?.revision ?? 0) + 1
      canvas = structuredClone(next)
      writes.push(structuredClone(canvas))
      json = { ok: true, canvas, reconciliation: 'complete' }
    } else if (path === '/api/canvas') json = canvas
    else if (path === '/api/projects') json = { settings, canvas, projects: [project] }
    else if (path === '/api/settings') json = settings
    else if (path === '/api/auth/session') json = { user: { id: 'synthetic-owner' } }
    else if (path === '/api/experiments') json = { eligible: true, assistantEligible: false, flags: { swarm: true }, swarmOptIn: { available: true, enabled: true } }
    else if (path === '/api/terminal/active') json = { cwds: [], claude: [] }
    else if (path === '/api/ground/lamps') json = { lamps: [] }
    else if (path === '/api/canvas/ai/active') json = { jobs: [] }
    await route.fulfill({ json })
  })
  await page.addInitScript(({ theme }) => {
    localStorage.setItem('openground:onboarded', '1')
    localStorage.setItem('og-lang', 'ja')
    localStorage.setItem('og-theme', theme)
  }, { theme })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const control = page.getByRole('button', { name: '自動運用', exact: true })
  await control.click()
  await expect.poll(() => canvas.automation?.revision).toBe(1)
  expect(automationFrameMembership(canvas, [projectId]).projectIds.size).toBe(0)
  expect(canvas.elements.find((element) => element.id === 'ordinary')?.text).toBe('My Projects')
  const id = canvas.automation!.frameId!
  const frame = page.locator(`[data-element-id="${id}"]`)
  await expect(frame).toBeVisible()
  await expect(control).toHaveAttribute('aria-pressed', 'true')
  await expect(control).toBeEnabled()

  const card = page.locator(`[data-card-id="${projectId}"]`)
  const cardBox = (await card.boundingBox())!
  const frameBox = (await frame.boundingBox())!
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
  }
  await drag({ x: cardBox.x + 120, y: cardBox.y + 20 }, { x: frameBox.x + 200, y: frameBox.y + 120 })
  await expect.poll(() => automationFrameMembership(canvas, [projectId]).projectIds.has(projectId)).toBe(true)
  await expect(control).toBeEnabled()
  await page.screenshot({ path: info.outputPath(`automation-frame-active-${theme}.png`), fullPage: true })
  // Resize the real frame chrome until the stationary card's centre is outside.
  await page.mouse.click(frameBox.x + 300, frameBox.y + 18)
  const handle = page.locator('[data-handle="br"]')
  const handleBox = (await handle.boundingBox())!
  await drag({ x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }, { x: frameBox.x + 100, y: frameBox.y + 90 })
  await expect.poll(() => automationFrameMembership(canvas, [projectId]).projectIds.has(projectId)).toBe(false)
  await expect(control).toBeEnabled()
  const saved = structuredClone(canvas)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator(`[data-element-id="${id}"]`)).toBeVisible()
  expect(canvas.automation).toEqual(saved.automation)
  expect(automationFrameMembership(canvas, [projectId]).projectIds.size).toBe(0)
  expect(writes.length).toBeGreaterThanOrEqual(3)
  await page.screenshot({ path: info.outputPath(`automation-frame-${theme}.png`), fullPage: true })
})
