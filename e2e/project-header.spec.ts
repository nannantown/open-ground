import { test, expect, type Locator } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

const ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const description = 'A saved song workspace with playback, chord annotations, and a guitar fretboard.'

async function expectInsideViewport(locator: Locator, width: number, height: number) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1)
}

// A long branch name is the worst case for the inline branch chip.
const BRANCH = 'feature/a-really-long-branch-name-for-header-layout'
// Folder / editor / branch sit beside the name from Tailwind's lg (1024px) up;
// narrower, they live in the ⋯ menu (inline from 640px they squeezed the tabs
// to 0px — owner card 2026-10-02, rework 1).
const INLINE_TOOLS = 1024

for (const width of [1600, 1280, 1024, 700, 640, 390, 320]) {
  test(`one-row project header keeps tabs and header tools usable at ${width}px`, async ({ page, request }, info) => {
    const height = 900
    await page.setViewportSize({ width, height })
    const project = await createAndImportProject(request, 'NENE-long-project-name-for-header-layout')
    const projectUrl = `/api/project?path=${encodeURIComponent(project.path)}`
    const initial = await (await request.get(projectUrl)).json()
    expect((await request.put(projectUrl, { data: {
      ...initial, description, customTabs: [ID],
      tabOrder: [`custom:${ID}`, 'swarm', 'board', 'canvas', 'terminal', 'research'],
    } })).ok()).toBe(true)
    const saved = await (await request.get(projectUrl)).json()
    await page.route('**/api/experiments', route => route.fulfill({ json: {
      eligible: true, flags: { swarm: true, sandbox: false },
      swarmOptIn: { available: true, enabled: false },
    } }))
    await page.route('**/api/terminal/claude', route => route.fulfill({ status: 503, json: { error: 'fixture' } }))
    await page.route('**/api/custom-modules', route => route.fulfill({ json: {
      role: 'owner', modules: [{
        id: ID, label: 'Songs', description: '', framework: 'html', origin: 'installed', version: 3,
        createdAt: '2026-06-12T00:00:00Z', updatedAt: '2026-06-12T00:00:00Z',
      }],
    } }))
    await page.route(`**/api/custom-modules/${ID}/source`, route => route.fulfill({ json: {
      source: '<html><body style="margin:0;padding:24px;background:#181818;color:#eee;font-family:system-ui"><h1>Songs</h1><button onclick="this.textContent=\'Playback state retained\'">Play fixture</button></body></html>',
      mtimeMs: 1, framework: 'html',
    } }))
    await page.route('**/api/usage', route => route.fulfill({ json: {
      windowHours: 5, windowStart: null, nextResetAt: null,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1000 },
      messageCount: 0, byModel: {}, currentModel: 'claude-opus-4-6',
      cli: { session: { pct: 23, resetsAt: '3:50 pm' }, weekAll: { pct: 25, resetsAt: '1:00 pm (Mon)' }, capturedAt: new Date().toISOString(), status: 'ok' },
    } }))
    await page.route('**/api/usage/breakdown*', route => route.fulfill({ json: { days: 7, total: 0, scannedAt: null, rows: [] } }))
    await page.route('**/api/project/branch-changes?*', route => route.fulfill({ json: {
      isGit: true, branch: BRANCH, target: 'main', sameBranch: true, ahead: 0, behind: 0, working: [], committed: [],
    } }))
    await page.route('**/api/project/active-branches?*', route => route.fulfill({ json: {
      isGit: true, branches: [{ name: BRANCH, current: true, worktreePath: project.path }],
    } }))
    await page.route('**/api/project/editors', route => route.fulfill({ json: {
      editors: [{ name: 'Test editor', path: '/fixture/editor' }], default: null, canPick: false,
    } }))
    await page.addInitScript(({ id, tab }) => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: tab }))
    }, { id: project.id, tab: `custom:${ID}` })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const frame = page.frameLocator('iframe[title="Songs"]')
    await frame.getByRole('button', { name: 'Play fixture' }).click()
    const header = page.getByTestId('project-header')
    // The name is plain text: hovering shows name + description, clicking opens nothing.
    const title = header.getByText(project.name, { exact: true })
    await expect(title).toHaveAttribute('title', `${project.name}\n${description}`)
    expect(await title.evaluate(el => el.closest('button'))).toBeNull()
    await expect(header.getByRole('button', { name: 'Claude usage', exact: true })).toContainText('23%')
    const box = (await header.boundingBox())!
    expect(box.height).toBe(48)
    const iframeBox = (await page.locator('iframe[title="Songs"]').boundingBox())!
    expect(iframeBox.y).toBe(box.y + box.height)
    // The folded Swarm bottom bar (0.11.138) sits under every tab: the tab body
    // fills everything between the header and the bar, and the bar ends at the
    // bottom of the screen. Measured, so a taller bar can't hide a short body.
    // Bounded from both sides: the bar must not be pushed off-screen, and the
    // body must not run under the bar (an overlaid bar would pass the minimum).
    const barBox = (await page.getByTestId('swarm-bottom-bar').boundingBox())!
    expect(barBox.y + barBox.height).toBeGreaterThanOrEqual(height - 1)
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(height + 1)
    expect(iframeBox.y + iframeBox.height).toBeLessThanOrEqual(barBox.y + 1)
    expect(iframeBox.height).toBeGreaterThanOrEqual(height - 50 - barBox.height)
    expect(iframeBox.width).toBeGreaterThanOrEqual(width - 2)
    await expect(page.getByTitle('Open Terminal', { exact: true })).toHaveCount(0)
    // The back button's name carries its chord hint ("Back to Ground ⌘[").
    const controls = [/^Back to Ground/, 'Claude usage', 'More actions', ...(width >= 640 ? ['Close'] : [])]
    for (const label of controls) {
      await expectInsideViewport(header.getByRole('button', { name: label, exact: true }), width, 48)
    }
    expect(await header.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(width)
    const strip = page.getByTestId('project-tabs')
    const songBox = (await strip.getByRole('button', { name: 'Songs', exact: true }).boundingBox())!
    const stripBox = (await strip.boundingBox())!
    expect(songBox.width).toBeGreaterThanOrEqual(40)
    expect(songBox.x).toBeGreaterThanOrEqual(stripBox.x)
    expect(songBox.x + songBox.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + 1)
    await page.screenshot({ path: info.outputPath(`project-header-${width}.png`), fullPage: true })

    // Clicking the name opens nothing (other dialogs, e.g. Settings, stay mounted hidden).
    const dialogs = await page.getByRole('dialog').count()
    await title.click()
    await page.waitForTimeout(300)
    await expect(page.getByRole('dialog')).toHaveCount(dialogs)

    // Editor chooser + branch list: inline from INLINE_TOOLS up, else via ⋯ —
    // the same menus either way. Escape closes only the menu, never the project.
    const more = header.getByRole('button', { name: 'More actions', exact: true })
    const inline = width >= INLINE_TOOLS
    await expect(header.getByRole('button', { name: 'Open in editor', exact: true })).toBeVisible({ visible: inline })
    for (const [trigger, item] of [['Open in editor', 'Test editor'], ['Active branches', BRANCH]] as const) {
      if (inline) await header.getByRole('button', { name: trigger, exact: true }).click()
      else {
        await more.click()
        await page.getByRole('button', { name: trigger, exact: true }).last().click()
      }
      await expect(page.getByRole('menu').getByText(item, { exact: true })).toBeVisible()
      await expectInsideViewport(page.getByRole('menu'), width, height)
      await page.screenshot({ path: info.outputPath(`project-header-${trigger.replace(/ /g, '-')}-${width}.png`), fullPage: true })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(header).toBeVisible()
    }
    await expect(frame.getByRole('button', { name: 'Playback state retained' })).toBeVisible()

    await more.click()
    await expect(page.getByRole('button', { name: 'Refresh description', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Refresh description', exact: true })).toHaveCount(0)
    await expect(header).toBeVisible()

    await header.getByRole('button', { name: 'Claude usage', exact: true }).click()
    await expect(page.getByText('Session', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(frame.getByRole('button', { name: 'Playback state retained' })).toBeVisible()
    expect(await (await request.get(projectUrl)).json()).toEqual(saved)

    // Selecting an off-screen tab brings that tab into the strip, not the body.
    await strip.getByRole('button', { name: 'Board', exact: true }).click()
    await expect(strip.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect.poll(async () => {
      const bounds = (await strip.boundingBox())!
      const selected = (await strip.locator('[aria-current="page"]').boundingBox())!
      return selected.x >= bounds.x - 1 && selected.x + selected.width <= bounds.x + bounds.width + 1
    }).toBe(true)
    expect((await header.boundingBox())!.height).toBe(48)
    await expect(page.getByRole('dialog')).toHaveCount(dialogs)
  })
}
