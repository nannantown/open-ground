import { mkdtemp, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// Click-to-place (owner ask 2026-09-24): after Create / Import, the new card
// rides the cursor as a translucent ghost and lands where the user clicks
// (or, on Esc, in a free slot). Drives the real prod bundle with the Electron
// folder-picker bridge stubbed, and checks the SAVED position — not just DOM.

const SHOTS = process.env.OG_PLACE_SHOTS

type Pos = { x: number; y: number }
const state = async (request: APIRequestContext) => {
  const body = await (await request.get('/api/projects')).json()
  return body as {
    projects: { id: string; path: string; name: string }[]
    canvas: { positions: Record<string, Pos>; viewport: { x: number; y: number; zoom: number } }
  }
}

// `pick` is what the stubbed native folder picker returns: one path for every
// call, or a list handed out one per call (last one repeats).
const boot = async (page: Page, pick: string | string[]) => {
  await page.addInitScript((paths) => {
    localStorage.setItem('openground:onboarded', '1')
    let i = 0
    ;(window as unknown as { openground: unknown }).openground = {
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: [paths[Math.min(i++, paths.length - 1)]],
      }),
    }
  }, ([] as string[]).concat(pick))
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
}

const openAddMenu = async (page: Page) => {
  await page.getByRole('button', { name: /^(Add|追加)$/ }).first().click()
}

test.describe('Click-to-place a new Ground card', () => {
  test('import → ghost follows the cursor → click places it there, and it survives reload', async ({
    request,
    page,
  }) => {
    await createAndImportProject(request, 'neighbour-a')
    await createAndImportProject(request, 'neighbour-b')
    const settings = (await (await request.get('/api/projects')).json()).settings
    await request.post('/api/settings', { data: { ...settings, theme: 'dark' } })
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-e2e-placed-')))
    await boot(page, dir)

    await openAddMenu(page)
    await page.getByRole('button', { name: /Import folder|フォルダをインポート/ }).first().click()
    const hint = page.getByRole('status').filter({ hasText: /Esc/ })
    await expect(hint).toBeVisible()

    await page.mouse.move(900, 600)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/import-ghost-dark.png` })
    await page.mouse.click(900, 600)
    await expect(hint).toBeHidden()

    const name = dir.split('/').pop()!
    let s = await state(request)
    const id = s.projects.find((p) => p.path === dir)!.id
    const { x: vx, y: vy, zoom } = s.canvas.viewport
    const want = { x: (900 - vx) / zoom - 128, y: (600 - vy) / zoom - 70 }
    await expect
      .poll(async () => {
        s = await state(request)
        const p = s.canvas.positions[id]
        return p ? Math.abs(p.x - want.x) + Math.abs(p.y - want.y) : 1e9
      })
      .toBeLessThan(2)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/import-placed-dark.png` })
    // Landed card stays in view, selected on the Ground — its panel is NOT
    // auto-opened; clicking the card opens it as usual.
    const boardTab = page.getByRole('button', { name: /^BOARD$|^Board$|ボード/ })
    await expect(boardTab).toHaveCount(0)
    await page.mouse.click(900, 600)
    await expect(boardTab.first()).toBeVisible()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(name).first()).toBeVisible()
    const after = (await state(request)).canvas.positions[id]
    expect(Math.abs(after.x - want.x) + Math.abs(after.y - want.y)).toBeLessThan(2)
  })

  test('create → Esc auto-places it in a free spot (light theme)', async ({ request, page }) => {
    await createAndImportProject(request, 'crowd')
    const settings = (await (await request.get('/api/projects')).json()).settings
    await request.post('/api/settings', { data: { ...settings, theme: 'light' } })
    const ws = await realpath(await mkdtemp(join(tmpdir(), 'og-e2e-ws-')))
    await boot(page, ws)

    await openAddMenu(page)
    await page.getByRole('button', { name: /New project|新規プロジェクト/ }).click()
    await page.getByPlaceholder('my-new-project').fill('placed-by-esc')
    await page.getByRole('button', { name: /^(Create|作成)$/ }).click()
    const hint = page.getByRole('status').filter({ hasText: /Esc/ })
    await expect(hint).toBeVisible()
    await page.mouse.move(500, 400)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/create-ghost-light.png` })
    await page.keyboard.press('Escape')
    await expect(hint).toBeHidden()

    let s = await state(request)
    const id = s.projects.find((p) => p.name === 'placed-by-esc')!.id
    const before = s.canvas.positions[id]
    await expect
      .poll(async () => {
        s = await state(request)
        return JSON.stringify(s.canvas.positions[id]) !== JSON.stringify(before)
      })
      .toBe(true)
    const mine = s.canvas.positions[id]
    for (const [other, p] of Object.entries(s.canvas.positions)) {
      if (other === id) continue
      const clear = Math.abs(p.x - mine.x) >= 256 || Math.abs(p.y - mine.y) >= 160
      expect(clear, `overlaps ${other}`).toBe(true)
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/create-esc-light.png` })
  })

  test('Space+drag pans while placing and does NOT drop the card', async ({ request, page }) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-e2e-space-')))
    await boot(page, dir)
    await openAddMenu(page)
    await page.getByRole('button', { name: /Import folder|フォルダをインポート/ }).first().click()
    const hint = page.getByRole('status').filter({ hasText: /Esc/ })
    await expect(hint).toBeVisible()
    const vp0 = (await state(request)).canvas.viewport

    await page.mouse.move(700, 500)
    await page.keyboard.down('Space')
    await page.mouse.down()
    await page.mouse.move(600, 420, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Space')

    await expect(hint).toBeVisible() // still placing — the press was a pan
    await expect
      .poll(async () => {
        const v = (await state(request)).canvas.viewport
        return Math.round(v.x - vp0.x) + ',' + Math.round(v.y - vp0.y)
      })
      .toBe('-100,-80')
  })

  test('⌘K after placing opens the placed card (quiet selection ends)', async ({ request, page }) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-e2e-jump-')))
    await boot(page, dir)
    await openAddMenu(page)
    await page.getByRole('button', { name: /Import folder|フォルダをインポート/ }).first().click()
    await expect(page.getByRole('status').filter({ hasText: /Esc/ })).toBeVisible()
    await page.mouse.click(700, 600)
    const boardTab = page.getByRole('button', { name: /^BOARD$|^Board$|ボード/ })
    await expect(boardTab).toHaveCount(0)

    await page.keyboard.press('ControlOrMeta+k')
    await page.getByPlaceholder('Jump to project…').fill(dir.split('/').pop()!)
    await page.keyboard.press('Enter')
    await expect(boardTab.first()).toBeVisible()
    void request
  })

  test('a second import while placing settles the first card in a free spot', async ({
    request,
    page,
  }) => {
    await createAndImportProject(request, 'dense')
    const first = await realpath(await mkdtemp(join(tmpdir(), 'og-e2e-first-')))
    const second = await realpath(await mkdtemp(join(tmpdir(), 'og-e2e-second-')))
    await boot(page, [first, second])
    await openAddMenu(page)
    await page.getByRole('button', { name: /Import folder|フォルダをインポート/ }).first().click()
    const hint = page.getByRole('status').filter({ hasText: /Esc/ })
    await expect(hint).toContainText(first.split('/').pop()!)

    await openAddMenu(page)
    await page.getByRole('button', { name: /Import folder|フォルダをインポート/ }).first().click()
    await expect(hint).toContainText(second.split('/').pop()!)

    // The first card is now on the Ground (not hidden as a ghost) and saved
    // clear of every other card.
    await expect(page.getByText(first.split('/').pop()!).first()).toBeVisible()
    let s = await state(request)
    const id = s.projects.find((p) => p.path === first)!.id
    const secondId = s.projects.find((p) => p.path === second)!.id
    await expect
      .poll(async () => {
        s = await state(request)
        const mine = s.canvas.positions[id]
        if (!mine) return 'unsaved'
        const hits = Object.entries(s.canvas.positions).filter(
          ([k, p]) =>
            k !== id &&
            k !== secondId &&
            Math.abs(p.x - mine.x) < 256 &&
            Math.abs(p.y - mine.y) < 160,
        )
        return hits.map(([k]) => k).join(',') || 'clear'
      })
      .toBe('clear')
  })

  test('⌘Z right after a click-place undoes the placement (Ground keys stay live)', async ({
    request,
    page,
  }) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-e2e-undo-')))
    await boot(page, dir)
    await openAddMenu(page)
    await page.getByRole('button', { name: /Import folder|フォルダをインポート/ }).first().click()
    await expect(page.getByRole('status').filter({ hasText: /Esc/ })).toBeVisible()
    let s = await state(request)
    const id = s.projects.find((p) => p.path === dir)!.id
    const { x: vx, y: vy, zoom } = s.canvas.viewport
    const placed = { x: (1000 - vx) / zoom - 128, y: (700 - vy) / zoom - 70 }
    const at = async () => {
      s = await state(request)
      const p = s.canvas.positions[id]
      return p ? Math.abs(p.x - placed.x) + Math.abs(p.y - placed.y) < 2 : false
    }
    await page.mouse.click(1000, 700)
    await expect.poll(at).toBe(true)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(at).toBe(false)
  })

  test('Esc closes an overlay opened mid-placement instead of ending the placement', async ({
    request,
    page,
  }) => {
    await createAndImportProject(request, 'escov-neighbour')
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-e2e-escov-')))
    await boot(page, dir)
    await openAddMenu(page)
    await page.getByRole('button', { name: /Import folder|フォルダをインポート/ }).first().click()
    const hint = page.getByRole('status').filter({ hasText: /Esc/ })
    await expect(hint).toBeVisible()

    await page.keyboard.press('ControlOrMeta+k')
    const search = page.getByPlaceholder('Jump to project…')
    await expect(search).toBeFocused() // the palette takes focus a frame after opening
    await page.keyboard.press('Escape')
    await expect(search).toBeHidden()
    await expect(hint).toBeVisible() // still placing

    // An overlay with focus OUTSIDE any text field (Settings, opened from its
    // toolbar button) — pins the [data-esc-overlay] check on its own.
    await page.getByRole('button', { name: /^(Settings|設定)$/ }).first().click()
    await expect(page.locator('[data-esc-overlay]').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(hint).toBeVisible()
    if (await page.locator('[data-esc-overlay]').count())
      await page.getByRole('button', { name: /^(Close|閉じる)$/ }).first().click()
    await expect(page.locator('[data-esc-overlay]')).toHaveCount(0)

    await page.keyboard.press('Escape') // now it's ours: auto-place
    await expect(hint).toBeHidden()
  })
})
