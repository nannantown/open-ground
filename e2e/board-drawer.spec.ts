import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// Board detail drawer — REAL mouse drags (the placeholder regression taught us
// synthetic events lie about drag behaviour). Opening a TITLED card's drawer
// auto-launches a plain claude session (no prompt is sent — the task content
// is injected unsent via the "Insert task into input" button), so the drawer
// lands straight in Session mode:
//   Session: the terminal owns the drawer; the chevron header expands the
//     fields block, whose split divider is drag-resizable; the insert button
//     sits under the status strip.
// Width (the drawer's left edge) is draggable too.

test.describe('Board detail drawer', () => {
  test('open auto-launches session; insert button present; split/width drags remembered on reload', async ({
    request,
    page,
  }) => {
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

    // Open the card → the titled task AUTO-LAUNCHES (fake-claude) → SESSION
    // mode: compact header, no Launch button anywhere, insert button present.
    await page.getByText('Resize me').first().click()
    const aside = page.locator('aside')
    const header = aside.getByRole('button', { name: 'Resize me' })
    await expect(header).toBeVisible()
    await expect(
      aside.getByRole('button', { name: /Launch Claude/i }),
    ).toHaveCount(0)
    const insert = aside.getByRole('button', {
      name: /Insert task into input|タスク内容を入力欄へ/i,
    })
    await expect(insert).toBeVisible()
    await expect(insert).toBeEnabled()

    // Click insert → the composed task prompt lands UNSENT in the PTY; the
    // fake claude just reads stdin, so the PTY's canonical echo renders it —
    // the task title showing up inside the terminal proves the paste arrived.
    await insert.click()
    await expect(
      aside.locator('.xterm-screen').getByText(/Resize me/).first(),
    ).toBeVisible()

    // ── Width: drag the left-edge grip 120px left → drawer widens. ───────────
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

    // Chevron expands the fields; the split divider appears and drags.
    await header.click()
    const split = page.getByRole('separator', {
      name: /terminal height|ターミナルの高さ/i,
    })
    await expect(split).toBeVisible()
    const before = await split.boundingBox()
    expect(before).toBeTruthy()
    if (!before) return
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + before.width / 2, before.y + 80, { steps: 8 })
    await page.mouse.up()
    const after = await split.boundingBox()
    expect(after).toBeTruthy()
    if (!after) return
    // The insert-task block under the status strip shrinks the drag range, so
    // an 80px drag may clamp around ~40px — assert meaningful movement, not
    // the full distance.
    expect(after.y - before.y).toBeGreaterThan(25)

    // ── Both choices survive a reload (slot persists → Session mode). ────────
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('Resize me').first().click()
    const wAgain = (await page.locator('aside').boundingBox())?.width ?? 0
    expect(Math.abs(wAgain - wAfter)).toBeLessThan(8)
    const headerAgain = page
      .locator('aside')
      .getByRole('button', { name: 'Resize me' })
    await expect(headerAgain).toBeVisible()
    await headerAgain.click()
    const splitAgain = await page
      .getByRole('separator', { name: /terminal height|ターミナルの高さ/i })
      .boundingBox()
    expect(splitAgain).toBeTruthy()
    if (!splitAgain) return
    expect(Math.abs(splitAgain.y - after.y)).toBeLessThan(8)
  })
})
