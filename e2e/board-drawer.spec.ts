import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// Board detail drawer geometry — REAL mouse drags (the placeholder regression
// taught us synthetic events lie about drag behaviour). Covers:
//   - the fields/terminal split divider moves with a vertical drag
//   - the drawer's left-edge grip widens the panel with a horizontal drag
// Both gestures are the answer to "the terminal only gets the bottom sliver".

test.describe('Board detail drawer', () => {
  test('terminal split and panel width are drag-resizable', async ({ request, page }) => {
    const project = await createAndImportProject(request, 'drawer')
    const res = await request.post('/api/project/tasks', {
      data: { path: project.path, add: ['Resize me'] },
    })
    expect(res.status()).toBe(200)

    // Deep-link straight into the project's Board tab via the persisted view.
    await page.addInitScript(
      ([id]) => {
        // Fresh isolated HOME → skip first-run onboarding, land on the board.
        localStorage.setItem('openground:onboarded', '1')
        localStorage.setItem(
          'openground.view',
          JSON.stringify({ projectId: id, panelTab: 'board' }),
        )
      },
      [project.id],
    )
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    // Open the card → detail drawer (aside) appears.
    await page.getByText('Resize me').first().click()
    const split = page.getByRole('separator', {
      name: /terminal height|ターミナルの高さ/i,
    })
    await expect(split).toBeVisible()

    // ── Vertical: drag the split divider up 80px → divider follows. ──────────
    const before = await split.boundingBox()
    expect(before).toBeTruthy()
    if (!before) return
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + before.width / 2, before.y - 80, { steps: 8 })
    await page.mouse.up()
    const after = await split.boundingBox()
    expect(after).toBeTruthy()
    if (!after) return
    expect(before.y - after.y).toBeGreaterThan(50)

    // ── Horizontal: drag the left-edge grip 120px left → drawer widens. ──────
    const aside = page.locator('aside')
    const wBefore = (await aside.boundingBox())?.width ?? 0
    const grip = page.getByRole('separator', { name: /panel width|パネル幅/i })
    const gb = await grip.boundingBox()
    expect(gb).toBeTruthy()
    if (!gb) return
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
    await page.mouse.down()
    await page.mouse.move(gb.x + gb.width / 2 - 120, gb.y + gb.height / 2, { steps: 8 })
    await page.mouse.up()
    const wAfter = (await aside.boundingBox())?.width ?? 0
    expect(wAfter - wBefore).toBeGreaterThan(80)

    // Both choices are remembered across a reload.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('Resize me').first().click()
    const splitAgain = await page
      .getByRole('separator', { name: /terminal height|ターミナルの高さ/i })
      .boundingBox()
    const wAgain = (await page.locator('aside').boundingBox())?.width ?? 0
    expect(splitAgain).toBeTruthy()
    if (!splitAgain) return
    expect(Math.abs(splitAgain.y - after.y)).toBeLessThan(8)
    expect(Math.abs(wAgain - wAfter)).toBeLessThan(8)
  })
})
