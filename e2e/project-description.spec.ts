import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

test('generated descriptions survive a delayed old read, Ground navigation and reload', async ({ page, request }) => {
  const project = await createAndImportProject(request, 'description')
  const url = `/api/project?path=${encodeURIComponent(project.path)}`
  const before = await (await request.get(url)).json()
  await page.addInitScript(id => {
    localStorage.setItem('openground:onboarded', '1')
    localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'board' }))
  }, project.id)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  // The project name is plain text; its hover tooltip carries the description.
  const title = page.getByTestId('project-header').getByText(project.name, { exact: true })
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  const generate = page.getByRole('button', { name: 'Generate description', exact: true })
  await expect(generate).toBeVisible()

  let captured!: () => void
  const oldReadStarted = new Promise<void>(resolve => { captured = resolve })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let holdNext = true
  await page.route('**/api/project?*', async route => {
    if (route.request().method() !== 'GET' || !holdNext) return route.continue()
    holdNext = false
    captured()
    await held
    await route.fulfill({ json: before })
  })
  try {
    // The real five-second board poll starts before generation and finishes last.
    await oldReadStarted
    await generate.click()
    const summary = 'A project for testing saved descriptions.'
    await expect(title).toHaveAttribute('title', `${project.name}\n${summary}`)
    const saved = await (await request.get(url)).json()
    expect(saved.descriptionEn).toBe(summary)
    expect(saved.descriptionJa).toBeTruthy()
    const oldReadFinished = page.waitForResponse(async response =>
      new URL(response.url()).pathname === '/api/project'
      && response.request().method() === 'GET'
      && (await response.json()).updatedAt === before.updatedAt,
    )
    release()
    await oldReadFinished
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(title).toHaveAttribute('title', `${project.name}\n${summary}`)
    await page.getByRole('button', { name: /^Back to Ground/ }).click()
    await expect(page.getByText(summary, { exact: true })).toBeVisible()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(summary, { exact: true })).toBeVisible()
    expect(await (await request.get(url)).json()).toEqual(saved)
  } finally {
    release()
  }
})
