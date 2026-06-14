import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// Board detail drawer — REAL mouse drags (the placeholder regression taught us
// synthetic events lie about drag behaviour). Opening a TITLED card's drawer
// lands in DRAFT mode (nothing launches by itself — the 2026-06-12 redesign
// removed the auto-launch): per-card run settings (flow/model/effort) + an
// explicit 実行/Run button. Clicking Run launches claude WITH the composed
// task prompt auto-sent, flipping the drawer to Session mode:
//   Session: the terminal owns the drawer; the chevron header expands the
//     fields block, whose split divider is drag-resizable; the insert button
//     sits under the status strip.
// Width (the drawer's left edge) is draggable too.

test.describe('Board detail drawer', () => {
  test('Run launches the task session; insert still pastes; split/width drags remembered on reload', async ({
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

    // Open the card → DRAFT mode: content-first (the title is auto, so there
    // is no title field) + run settings + the explicit Run button. NO terminal
    // yet (nothing auto-launches, F031 for all).
    await page.getByText('Resize me').first().click()
    const aside = page.locator('aside')
    const runBtn = aside.getByRole('button', { name: /実行|^Run$/ })
    await expect(runBtn).toBeVisible()
    // Run needs content now (not a title). Type into the content textarea —
    // the only field; the card keeps its 'Resize me' title, so the launch
    // payload title stays that.
    const content = aside.locator('textarea').first()
    await content.click()
    await content.fill('Resize me — make the drawer resizable')
    await content.blur()
    await expect(runBtn).toBeEnabled()
    await expect(aside.locator('.xterm-screen')).toHaveCount(0)
    // The per-card run settings selects render (model + effort at minimum;
    // the flow select needs git, which this scratch project doesn't have).
    expect(await aside.locator('select').count()).toBeGreaterThanOrEqual(2)

    // Run → POST /api/terminal/claude carries the task payload; the server
    // composes the prompt and auto-starts it. The drawer flips to Session.
    const [launchRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/terminal/claude') && r.request().method() === 'POST',
      ),
      runBtn.click(),
    ])
    expect(launchRes.status()).toBe(200)
    const launchBody = launchRes.request().postDataJSON() as {
      task?: { id?: string; title?: string }
    }
    expect(launchBody.task?.title).toBe('Resize me')
    const terminalId = ((await launchRes.json()) as { id: string }).id
    expect(terminalId).toBeTruthy()

    // Session mode: compact header + live terminal; the insert button is the
    // follow-up path (unsent paste) and must be enabled.
    const header = aside.getByRole('button', { name: 'Resize me' })
    await expect(header).toBeVisible()
    await expect(aside.locator('.xterm-screen')).toBeVisible()
    const insert = aside.getByRole('button', {
      name: /Insert task into input|タスク内容を入力欄へ/i,
    })
    await expect(insert).toBeVisible()
    await expect(insert).toBeEnabled()

    // The auto-sent prompt reached the session: fake-claude prints a "# Task:"
    // positional prompt to the PTY, so the SERVER-SIDE replay buffer carries
    // the title. (With the WebGL renderer, glyphs are canvas pixels —
    // .xterm-screen holds no DOM text — so a DOM getByText can never see it.)
    // Each probe opens a fresh EventSource (the endpoint's first event is
    // `init` with the full replay) and closes it immediately; errors soften
    // to '' so the poll retries.
    const readReplay = () =>
      page
        .evaluate(
          (id) =>
            new Promise<string>((resolve, reject) => {
              const es = new EventSource(`/api/terminal/${id}/stream`)
              const timer = setTimeout(() => {
                es.close()
                reject(new Error('terminal stream init timeout'))
              }, 5000)
              es.addEventListener('init', (ev) => {
                clearTimeout(timer)
                es.close()
                resolve(JSON.parse((ev as MessageEvent).data).replay ?? '')
              })
            }),
          terminalId,
        )
        .catch(() => '')
    await expect.poll(readReplay, { timeout: 10_000 }).toContain('Resize me')

    // Insert (unsent paste) still works on the live session — paste-task 200
    // means the bytes hit the PTY master.
    const [pasteRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/paste-task')),
      insert.click(),
    ])
    expect(pasteRes.status()).toBe(200)

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
