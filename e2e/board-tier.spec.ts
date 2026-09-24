import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Swarm hides manual defaults without changing saved settings at ${viewport.width}px`, async ({ page, request }, info) => {
    await page.setViewportSize(viewport)
    const project = await createAndImportProject(request, 'run-defaults')
    const url = `/api/project?path=${encodeURIComponent(project.path)}`
    const data = await (await request.get(url)).json()
    expect((await request.put(url, { data: {
      ...data,
      config: { completionFlow: 'pr', targetBranch: 'main' },
      launch: { model: 'sonnet', effort: 'high', permissionMode: 'plan' },
    } })).ok()).toBe(true)
    const saved = await (await request.get(url)).json()
    let swarm = false
    await page.route('**/api/experiments', route => route.fulfill({ json: {
      eligible: false, flags: { swarm, sandbox: false },
      swarmOptIn: { available: true, enabled: swarm },
    } }))
    await page.addInitScript(id => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'board' }))
      localStorage.setItem(`openground.board.defaultsOpen.${id}`, '1')
    }, project.id)
    const mutations: string[] = []
    page.on('request', req => {
      if (req.method() === 'PUT' && new URL(req.url()).pathname === '/api/project') mutations.push(req.url())
    })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const defaults = page.getByRole('button', { name: 'Run defaults', exact: true })
    await expect(defaults).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('sonnet')
    await expect(page.getByRole('combobox', { name: 'Effort', exact: true })).toHaveValue('high')
    await expect(page.getByRole('combobox', { name: 'Permissions', exact: true })).toHaveValue('plan')
    swarm = true
    await page.reload({ waitUntil: 'domcontentloaded' })
    // Swarm is a bottom bar under every tab (0.11.138), not a tab.
    await expect(page.getByTestId('swarm-bottom-bar')).toBeVisible()
    await expect(defaults).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Permissions', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Board', exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath(`swarm-defaults-hidden-${viewport.width}.png`), fullPage: true })
    swarm = false
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(defaults).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('swarm-bottom-bar')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('sonnet')
    await expect(page.getByRole('combobox', { name: 'Effort', exact: true })).toHaveValue('high')
    await expect(page.getByRole('combobox', { name: 'Permissions', exact: true })).toHaveValue('plan')
    expect(await (await request.get(url)).json()).toEqual(saved)
    expect(mutations).toEqual([])
    for (const name of ['Model', 'Effort', 'Permissions']) {
      const bounds = await page.getByRole('combobox', { name, exact: true }).boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    }
    await page.screenshot({ path: info.outputPath(`manual-defaults-restored-${viewport.width}.png`), fullPage: true })
  })

  test(`difficulty persists, resets and shows the safety floor at ${viewport.width}px`, async ({ page, request }, info) => {
    await page.setViewportSize(viewport)
    const project = await createAndImportProject(request, 'tier')
    const url = `/api/project?path=${encodeURIComponent(project.path)}`
    const data = await (await request.get(url)).json()
    expect((await request.put(url, {
      data: {
        ...data,
        tasks: [{
          id: 'tier-card', title: 'Authentication update', notes: 'Update auth checks.',
          tier: 'ultra', boardColumn: 'todo', done: false, createdAt: new Date().toISOString(),
        }],
      },
    })).ok()).toBe(true)

    // Exercise the picker on every OS without opening a real model session.
    await page.route('**/api/experiments', route => route.fulfill({ json: {
      eligible: false, flags: { swarm: true, sandbox: false },
      swarmOptIn: { available: true, enabled: true },
    } }))
    const launches: Record<string, unknown>[] = []
    await page.route('**/api/swarm/worker', async route => {
      launches.push(route.request().postDataJSON())
      await route.fulfill({ json: { ok: true } })
    })
    await page.addInitScript(id => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'board' }))
    }, project.id)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByText('Authentication update').first().click()
    const aside = page.locator('aside')
    await aside.getByRole('button', { name: 'Options', exact: true }).click()
    const group = aside.getByRole('group', { name: 'Difficulty', exact: true })
    await expect(group.getByRole('button', { name: 'Ultra', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await group.getByRole('button', { name: 'Touch', exact: true }).click()
    await expect(aside.getByText('Actually runs as: Design (raised for safety)', { exact: true })).toBeVisible()
    await expect.poll(async () => (await (await request.get(url)).json()).tasks[0].tier).toBe('touch')

    await group.getByRole('button', { name: 'Auto', exact: true }).click()
    await aside.getByRole('button', { name: 'Run', exact: true }).click()
    await expect.poll(() => launches.length).toBe(1)
    expect(launches[0].tier).toBeNull()
    await expect.poll(async () => (await (await request.get(url)).json()).tasks[0].tier ?? null).toBeNull()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('Authentication update').first().click()
    const options = aside.getByRole('button', { name: 'Options', exact: true })
    if (await options.getAttribute('aria-expanded') === 'false') await options.click()
    await expect(group.getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await group.scrollIntoViewIfNeeded()
    const bounds = await group.boundingBox()
    expect(bounds).not.toBeNull()
    for (const button of await group.getByRole('button').all()) {
      const box = await button.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
    }
    await page.screenshot({ path: info.outputPath(`difficulty-${viewport.width}.png`), fullPage: true })
  })
}
