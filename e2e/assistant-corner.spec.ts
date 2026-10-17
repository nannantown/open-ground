import { test, expect, type Page } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// The assistant's character sits at the SAME bottom-right spot on every screen
// (owner 2026-10-06) and FLOATS over it: the layout makes no room for it (owner
// 2026-10-07 — the team bar and its seats stay where they were before the
// character). Measured on the REAL layout (Chromium, the built CSS), since jsdom
// lays nothing out. The assistant's records are stubbed; nothing reaches it.

const W = 1280
const H = 800

const setup = async (page: Page, o: { swarm: boolean; projectId?: string; tab?: 'board' | 'canvas' }) => {
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
    if (id) localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: tab }))
  }, [o.projectId ?? '', o.tab ?? 'board'] as const)
  await page.setViewportSize({ width: W, height: H })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const character = page.getByRole('button', { name: 'ノノ' })
  await expect(character).toBeVisible()
  // the same spot on every screen: 18px up, 20px in
  const b = (await character.boundingBox())!
  expect(Math.round(H - (b.y + b.height))).toBe(18)
  expect(Math.round(W - (b.x + b.width))).toBe(20)
  // only the character itself takes the pointer: just beside it, the hit goes to the screen under it
  const beside = await character.evaluate((c, [x, y]) => {
    const top = document.elementFromPoint(x, y)
    return !!top && (top === c || c.contains(top))
  }, [b.x - 3, b.y + b.height / 2] as const)
  expect(beside).toBe(false)
  return b
}

test('Ground: the character floats at its spot', async ({ page }) => {
  await setup(page, { swarm: false })
})

test('project: the folded team bar spans the full width to the window bottom, under the character', async ({ page, request }) => {
  const project = await createAndImportProject(request, 'corner-bar')
  const c = await setup(page, { swarm: true, projectId: project.id, tab: 'board' })
  const bar = page.getByTestId('swarm-bottom-bar')
  await expect(bar).toBeVisible()
  const r = (await bar.boundingBox())!
  expect(Math.round(r.y + r.height)).toBe(H) // no floor under or above the bar
  expect(Math.round(r.x + r.width)).toBe(W)
  expect(await bar.evaluate((el) => getComputedStyle(el).paddingRight)).toBe('0px')
  // the character overlaps the bar (it floats over it, the bar did not move for it)
  expect(c.y + c.height).toBeGreaterThan(r.y)
})
