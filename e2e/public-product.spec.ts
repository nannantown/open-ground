import { test, expect, type Page } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

const SWITCH = 'Show as a public user sees it'
// The project screen is a full overlay: leave it, flip the Settings switch, reopen the card.
async function setPublicView(page: Page, on: boolean, projectName: string) {
  await page.getByRole('button', { name: 'Back to Ground', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('group', { name: SWITCH }).getByRole('button', { name: on ? 'On' : 'Off', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCSS('pointer-events', 'none')
  await page.getByText(projectName, { exact: true }).first().click()
}

const ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

for (const width of [1280, 390]) {
  test(`public visibility preserves saved owner data at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 900 })
    const project = await createAndImportProject(request, 'public-product')
    const url = `/api/project?path=${encodeURIComponent(project.path)}`
    const initial = await (await request.get(url)).json()
    expect((await request.put(url, { data: {
      ...initial, customTabs: [ID],
      tabOrder: ['canvas', `custom:${ID}`, 'board', 'research', 'terminal', 'swarm'],
      disabledModules: ['board', 'terminal', 'swarm'],
    } })).ok()).toBe(true)
    const saved = await (await request.get(url)).json()
    const created = await request.post('/api/project/canvases?action=create', {
      data: { path: project.path, name: 'Saved design' },
    })
    expect(created.ok()).toBe(true)
    const { canvas } = await created.json()
    const canvasUrl = `/api/project/canvases?path=${encodeURIComponent(project.path)}&id=${canvas.id}`
    const savedCanvas = await (await request.get(canvasUrl)).json()
    let owner = false
    const hiddenRequests: string[] = []
    page.on('request', req => {
      if (!owner && /\/api\/(research|custom-modules|project\/canvases)/.test(req.url())) hiddenRequests.push(req.url())
    })
    await page.route('**/api/experiments', route => route.fulfill({ json: {
      eligible: owner, flags: { swarm: false, sandbox: false },
      swarmOptIn: { available: true, enabled: false },
    } }))
    await page.route('**/api/custom-modules', route => route.fulfill({ json: {
      role: owner ? 'owner' : 'tester', modules: [{
        id: ID, label: 'Saved tab', description: '', framework: 'html', origin: 'installed',
        createdAt: '2026-06-12T00:00:00Z', updatedAt: '2026-06-12T00:00:00Z',
      }],
    } }))
    await page.addInitScript(id => {
      localStorage.setItem('openground:onboarded', '1')
      if (!localStorage.getItem('openground.view')) {
        localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'canvas' }))
      }
    }, project.id)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: 'Board', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Saved tab', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Skills', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to Ground', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('group', { name: SWITCH })).toHaveCount(0)
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCSS('pointer-events', 'none')
    await page.getByText(project.name, { exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Add tab', exact: true })).toHaveCount(0)
    const board = page.getByRole('button', { name: 'Board', exact: true })
    const terminal = page.getByRole('button', { name: 'Terminal', exact: true })
    await expect(terminal).toBeVisible()
    await expect(board).toHaveAttribute('draggable', 'false')
    expect((await board.boundingBox())!.x).toBeLessThan((await terminal.boundingBox())!.x)
    await board.press('Alt+ArrowRight')
    await board.click({ button: 'right' })
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.getByRole('button', { name: 'Project details', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Generate description', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.screenshot({ path: info.outputPath(`public-${width}.png`), fullPage: true })
    expect(await (await request.get(url)).json()).toEqual(saved)
    expect(await (await request.get(canvasUrl)).json()).toEqual(savedCanvas)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('openground.view')!).panelTab)).toBe('canvas')
    expect(hiddenRequests).toEqual([])

    owner = true
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Saved tab', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Saved design', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add tab', exact: true })).toBeVisible()
    expect(await (await request.get(url)).json()).toEqual(saved)
    expect(await (await request.get(canvasUrl)).json()).toEqual(savedCanvas)
    await page.screenshot({ path: info.outputPath(`owner-${width}.png`), fullPage: true })

    // Switching display mode uses the SAME owner session and saved layout.
    const mutations: string[] = []
    page.on('request', req => {
      if (req.method() !== 'GET' && /\/api\/(settings|auth|project(?:\?|$))/.test(req.url())) mutations.push(req.url())
    })
    await setPublicView(page, true, project.name)
    await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Saved tab', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Skills', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Board', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add tab', exact: true })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`owner-public-preview-${width}.png`), fullPage: true, animations: 'disabled' })
    await setPublicView(page, false, project.name)
    await expect(page.getByRole('button', { name: 'Saved design', exact: true })).toBeVisible()
    expect(await (await request.get(url)).json()).toEqual(saved)
    expect(await (await request.get(canvasUrl)).json()).toEqual(savedCanvas)
    expect(mutations).toEqual([])
  })

  test(`owner preview and Ground editing controls at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 900 })
    const project = await createAndImportProject(request, 'owner-preview')
    await request.post('/api/settings', { data: { swarmOptIn: false } })
    await page.route('**/api/experiments', async route => {
      const settings = await (await request.get('/api/settings')).json()
      await route.fulfill({ json: {
        eligible: true, flags: { swarm: true, sandbox: true },
        swarmOptIn: { available: true, enabled: !!settings.swarmOptIn },
      } })
    })
    await page.addInitScript(id => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'board' }))
    }, project.id)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('swarm-bottom-bar')).toBeVisible()
    await setPublicView(page, true, project.name)
    await expect(page.getByTestId('swarm-bottom-bar')).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to Ground', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('group', { name: SWITCH }).getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('button', { name: 'Skills', exact: true })).toHaveCount(0)
    await expect(page.getByTitle('Text (T)', { exact: true })).toBeHidden()
    const before = await (await request.get('/api/canvas')).json()
    await page.getByRole('button', { name: 'Edit layout', exact: true }).click()
    await page.getByTitle('Text (T)', { exact: true }).click()
    await page.getByRole('button', { name: 'Finish layout editing', exact: true }).click()
    await expect(page.getByTitle('Text (T)', { exact: true })).toBeHidden()
    await page.keyboard.press('t')
    await expect(page.getByTitle('Text (T)', { exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Finish layout editing', exact: true }).click()
    const after = await (await request.get('/api/canvas')).json()
    expect(after.elements).toEqual(before.elements)
    expect(after.positions).toEqual(before.positions)
    await page.screenshot({ path: info.outputPath(`preview-ground-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByText('WordPress', { exact: true })).toHaveCount(0)
    await page.getByText('Advanced', { exact: true }).click()
    const group = page.getByRole('group').filter({ has: page.getByRole('button', { name: 'On', exact: true }) }).last()
    await group.getByRole('button', { name: 'On', exact: true }).click()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).swarmOptIn).toBe(true)
    await page.keyboard.press('Escape')
    // The display choice survives navigation, but reload returns to owner view.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Back to Ground', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('group', { name: SWITCH }).getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCSS('pointer-events', 'none')
    await page.getByText(project.name, { exact: true }).first().click()
    await setPublicView(page, true, project.name)
    await expect(page.getByTestId('swarm-bottom-bar')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toHaveCount(0)
    await setPublicView(page, false, project.name)
    await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toBeVisible()
    await request.post('/api/settings', { data: { swarmOptIn: false } })
  })
}

test('public Swarm opt-in follows the platform gate while owner settings stay hidden', async ({ page, request }) => {
  const available = process.platform === 'darwin'
  const project = await createAndImportProject(request, 'public-swarm')
  await request.post('/api/settings', { data: { swarmOptIn: false } })
  await expect.poll(async () => (await (await request.get('/api/experiments')).json()).swarmOptIn.available).toBe(available)
  await page.addInitScript(id => {
    localStorage.setItem('openground:onboarded', '1')
    localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'board' }))
  }, project.id)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: 'Board', exact: true })).toBeVisible()
  await expect(page.getByTestId('swarm-bottom-bar')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to Ground', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByText('WordPress', { exact: true })).toHaveCount(0)
  await page.getByText('Advanced', { exact: true }).click()
  const group = page.getByRole('group', { name: 'Enable Agent Team', exact: true })
  if (available) {
    await group.getByRole('button', { name: 'On', exact: true }).click()
  } else {
    await expect(group).toHaveCount(0)
    // A saved opt-in cannot bypass the non-macOS server gate.
    await request.post('/api/settings', { data: { swarmOptIn: true } })
  }
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).swarmOptIn).toBe(true)
  await expect.poll(async () => (await (await request.get('/api/experiments')).json()).swarmOptIn.enabled).toBe(available)
  await page.reload({ waitUntil: 'domcontentloaded' })
  if (available) await expect(page.getByTestId('swarm-bottom-bar')).toBeVisible()
  else await expect(page.getByTestId('swarm-bottom-bar')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toHaveCount(0)
  await request.post('/api/settings', { data: { swarmOptIn: false } })
})
