import { expect, test } from '@playwright/test'
import { automationFrameMembership } from '../src/lib/automationFrame'
import type { CanvasState } from '../src/lib/types'

const projectId = '11111111-1111-4111-8111-111111111111'
let finishHeldSave: (() => void) | undefined
test.afterEach(async ({ page }) => { finishHeldSave?.(); finishHeldSave = undefined; await page.unrouteAll({ behavior: 'wait' }) })

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
  let holdNextSave = false
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let json: unknown = {}
    if (path === '/api/canvas' && route.request().method() === 'POST') {
      const next = route.request().postDataJSON() as CanvasState
      if (next.automation) next.automation.revision = (canvas.automation?.revision ?? 0) + 1
      canvas = structuredClone(next)
      writes.push(structuredClone(canvas))
      if (holdNextSave) { holdNextSave = false; await new Promise<void>(resolve => { finishHeldSave = resolve }) }
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
  await expect(page.getByRole('button', { name: '自動運用', exact: true })).toHaveCount(0)
  const ordinary = page.locator('[data-element-id="ordinary"]')
  const ordinaryControl = ordinary.getByRole('switch', { name: '自動運用', exact: true })
  await expect(ordinaryControl).toHaveAttribute('aria-checked', 'false')
  expect(await ordinary.getByText('My Projects', { exact: true }).evaluate(el => getComputedStyle(el).fontFamily)).not.toMatch(/Mincho|Serif JP/)
  await ordinaryControl.click()
  await expect.poll(() => canvas.automation?.version === 2 ? canvas.automation.frameIds : []).toEqual(['ordinary'])
  expect(automationFrameMembership(canvas, [projectId]).projectIds.has(projectId)).toBe(true)
  await expect(ordinaryControl).toBeEnabled()
  await ordinaryControl.click()
  await expect.poll(() => canvas.automation?.version === 2 ? canvas.automation.frameIds : null).toEqual([])
  expect(automationFrameMembership(canvas, [projectId]).projectIds.size).toBe(0)

  // Draw a normal frame with the existing F tool, rather than a special
  // automation creation path. It remains OFF until its own header is toggled.
  await page.keyboard.press('f')
  await page.mouse.move(500, 160); await page.mouse.down()
  await page.mouse.move(1180, 600, { steps: 12 }); await page.mouse.up()
  const label = page.getByPlaceholder('Frame name')
  await label.fill('Operations')
  expect(await label.evaluate(el => getComputedStyle(el).fontFamily)).not.toMatch(/Mincho|Serif JP/)
  await label.press('Escape')
  await expect.poll(() => canvas.elements.length).toBe(2)
  const id = canvas.elements.find(element => element.id !== 'ordinary')!.id
  const frame = page.locator(`[data-element-id="${id}"]`)
  const control = frame.getByRole('switch', { name: '自動運用', exact: true })
  await expect(control).toHaveAttribute('aria-checked', 'false')
  await expect(frame.getByText('自動運用', { exact: true })).toHaveCount(1)
  await page.mouse.move(0, 0)
  const style = () => control.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
  const normal = await style()
  await control.hover(); await expect.poll(style).not.toEqual(normal)
  const hover = await style()
  await control.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
  await expect(control).toBeFocused()
  expect(await control.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid')
  holdNextSave = true
  await control.hover(); await page.mouse.down(); await expect.poll(style).not.toEqual(hover); await page.mouse.up()
  await expect(control).toHaveAttribute('aria-checked', 'true')
  await expect(control).toBeDisabled()
  await expect(control).toHaveAttribute('aria-busy', 'true')
  expect(await control.evaluate(el => getComputedStyle(el).opacity)).toBe('0.4')
  expect(finishHeldSave).toBeTruthy(); finishHeldSave!()
  await expect.poll(() => canvas.automation?.version === 2 ? canvas.automation.frameIds : []).toEqual([id])
  await expect(control).toBeEnabled()
  expect(automationFrameMembership(canvas, [projectId]).projectIds.size).toBe(0)
  await ordinaryControl.click()
  await expect.poll(() => canvas.automation?.version === 2 ? canvas.automation.frameIds : []).toEqual([id, 'ordinary'].sort())
  expect(automationFrameMembership(canvas, [projectId]).projectIds.has(projectId)).toBe(true)
  await expect(ordinaryControl).toBeEnabled()
  await ordinaryControl.click()
  await expect.poll(() => canvas.automation?.version === 2 ? canvas.automation.frameIds : []).toEqual([id])

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
  // OFF/ON only changes this normal frame's configured intent.
  await control.press('Space')
  await expect(control).toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => canvas.automation?.version === 2 ? canvas.automation.frameIds : null).toEqual([])
  await expect(control).toBeEnabled()
  await control.press('Enter')
  await expect.poll(() => canvas.automation?.version === 2 ? canvas.automation.frameIds : null).toEqual([id])
  const saved = structuredClone(canvas)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator(`[data-element-id="${id}"]`)).toBeVisible()
  expect(canvas.automation).toEqual(saved.automation)
  expect(automationFrameMembership(canvas, [projectId]).projectIds.size).toBe(0)
  await expect(page.locator(`[data-element-id="${id}"]`).getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  expect(writes.length).toBeGreaterThanOrEqual(5)
  await page.screenshot({ path: info.outputPath(`automation-frame-${theme}.png`), fullPage: true })
})
