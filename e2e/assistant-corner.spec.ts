import { test, expect, type Page, type Locator } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// The assistant's character sits at the SAME bottom-right spot on every screen
// (owner 2026-10-06) and a project screen makes room for it — measured on the
// REAL layout (Chromium, the built CSS), since jsdom lays nothing out. Review of
// 2026-10-07 found the Board drawer's Run under the character (30 % with the
// team bar folded, 60 % with no bar) and Canvas redo unclickable without a bar.
// "Covered" = share of a 3px grid over a control whose topmost hit is the
// character. The assistant's records are stubbed; nothing reaches it.

const W = 1280
const H = 800

const setup = async (page: Page, o: { swarm: boolean; projectId: string; tab: 'board' | 'canvas' }) => {
  await page.route('**/api/experiments', (r) =>
    r.fulfill({ json: { eligible: true, flags: { swarm: o.swarm, sandbox: false }, swarmOptIn: { available: true, enabled: o.swarm } } }),
  )
  await page.route('**/api/phone-link/assistant/log', (r) =>
    r.fulfill({ json: { entries: [], name: 'ノノ', look: 'verm', logDays: 30, memoryChars: 4000, voice: true, proposals: [] } }),
  )
  await page.addInitScript(([id, tab]) => {
    localStorage.setItem('openground:onboarded', '1')
    localStorage.setItem('og-lang', 'en')
    localStorage.removeItem('og.assistant.pos')
    localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: tab }))
  }, [o.projectId, o.tab] as const)
  await page.setViewportSize({ width: W, height: H })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const character = page.getByRole('button', { name: 'ノノ' })
  await expect(character).toBeVisible()
  // the same spot as on Ground: 18px up, 20px in
  const b = (await character.boundingBox())!
  expect(Math.round(H - (b.y + b.height))).toBe(18)
  expect(Math.round(W - (b.x + b.width))).toBe(20)
  if (o.swarm) await expect(page.getByTestId('swarm-bottom-bar')).toBeVisible()
  else await expect(page.getByTestId('swarm-bottom-bar')).toHaveCount(0)
  return character
}

/** Share (0..1) of the control whose topmost hit is the character. */
const covered = async (control: Locator, character: Locator) => {
  await expect(control).toBeVisible()
  const ch = await character.elementHandle()
  return control.evaluate((el, c) => {
    const r = el.getBoundingClientRect()
    let n = 0
    let hit = 0
    for (let x = r.left + 1; x < r.right - 1; x += 3)
      for (let y = r.top + 1; y < r.bottom - 1; y += 3) {
        n++
        const top = document.elementFromPoint(x, y)
        if (top && c && (top === c || c.contains(top))) hit++
      }
    return n ? hit / n : 0
  }, ch)
}

for (const swarm of [true, false]) {
  const bar = swarm ? 'team bar folded' : 'no team bar'

  test(`${bar}: the Board drawer's Run is clear of the character`, async ({ page, request }) => {
    const project = await createAndImportProject(request, `corner-board-${swarm}`)
    expect((await request.post('/api/project/tasks', { data: { path: project.path, add: ['Corner card'] } })).status()).toBe(200)
    const character = await setup(page, { swarm, projectId: project.id, tab: 'board' })
    await page.getByText('Corner card').first().click()
    expect(await covered(page.locator('aside').getByRole('button', { name: /実行|^Run$/ }), character)).toBe(0)
  })

  test(`${bar}: Canvas undo / redo are clear of the character`, async ({ page, request }) => {
    const project = await createAndImportProject(request, `corner-canvas-${swarm}`)
    const character = await setup(page, { swarm, projectId: project.id, tab: 'canvas' })
    expect(await covered(page.getByTitle(/^(Undo|元に戻す)/), character)).toBe(0)
    expect(await covered(page.getByTitle(/^(Redo|やり直す)/), character)).toBe(0)
  })
}
