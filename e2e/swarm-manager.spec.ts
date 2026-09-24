import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// The manager's seat (card ③, 2026-09-23): a nameplate only — status + one
// start/stop — in a narrow fixed-width seat. The seat clips its overflow, so
// the one thing that must hold is that its buttons sit INSIDE the seat, in
// both languages (the Japanese words are the wide ones) and both states (no desk
// → Start, a live desk → Stop). Since 86cd5e71 the seat also carries a folded
// "Send a word" link whose box appears only when opened. Plus: no runtime
// selector for owner or public, and no Monitoring switch on the screen at all
// (owner 2026-09-24 — the owner asks the president instead).
const WORDS = {
  en: {
    open: 'Open Agent Team',
    manager: 'Manager',
    absent: 'Not started',
    running: 'Running',
    start: 'Start manager',
    stop: 'Stop manager',
    monitoring: 'Monitoring',
    say: 'Send a word',
    sayBox: 'A word to the manager (usually not needed)',
    cancel: 'Cancel',
  },
  ja: {
    open: 'エージェントチームをひらく',
    manager: 'マネージャー',
    absent: 'いない',
    running: '動いている',
    start: 'マネージャーを起動',
    stop: 'マネージャーを停止',
    monitoring: '状況の監視',
    say: '一言送る',
    sayBox: 'マネージャーへの一言(ふだんは不要です)',
    cancel: 'やめる',
  },
} as const

const MANAGER_SDK_ID = 'sdk-e2e-manager'

for (const lang of ['en', 'ja'] as const) {
  for (const width of [1280, 390]) {
    for (const desk of ['absent', 'running'] as const) {
      for (const owner of [false, true]) {
        test(`manager seat: ${lang} ${width}px ${desk} ${owner ? 'owner' : 'public'}`, async ({ page, request }, info) => {
          const w = WORDS[lang]
          await page.setViewportSize({ width, height: 900 })
          const project = await createAndImportProject(request, 'sdk-manager')
          await request.post('/api/settings', { data: { swarmOptIn: true } })
          await page.route('**/api/experiments', route => route.fulfill({ json: {
            eligible: owner, flags: { swarm: true, sandbox: false },
            swarmOptIn: { available: true, enabled: true },
          } }))
          await page.route('**/api/settings', async route => {
            const response = await route.fetch()
            await route.fulfill({ response, json: { ...await response.json(), swarmManagerRuntime: { mode: 'pty' } } })
          })
          // A dashboard fixture, independent of the host's public opt-in gate.
          await page.route('**/api/swarm/orchestrator?*', route => route.fulfill({
            status: 200, json: { running: true, workers: [], managerDesk: null, supplyDesk: null },
          }))
          if (desk === 'running') {
            // A live SDK manager: the stored record, the both-pools active poll
            // listing it, and its liveness probe answering "alive".
            await page.route('**/api/terminal/active', route => route.fulfill({
              json: { cwds: [], claude: [{ id: MANAGER_SDK_ID, cwd: '/x', status: 'working', desk: true }] },
            }))
            await page.route(`**/api/sdk-session/${MANAGER_SDK_ID}?*`, route => route.fulfill({
              json: { status: 'working' },
            }))
          }
          await page.addInitScript(({ id, lang, desk, sdkId }) => {
            localStorage.setItem('openground:onboarded', '1')
            localStorage.setItem('og-lang', lang)
            localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'board' }))
            if (desk === 'running')
              localStorage.setItem(`openground.swarm.manager.${id}`, JSON.stringify({
                terminalId: '', runtime: 'sdk', sdkSessionId: sdkId, agentSessionId: '', startedAt: '2026-09-23T00:00:00.000Z',
              }))
          }, { id: project.id, lang, desk, sdkId: MANAGER_SDK_ID })
          await page.goto('/', { waitUntil: 'domcontentloaded' })
          // Swarm is a bottom bar under every tab (0.11.138), folded to one line:
          // open it to reach the seats.
          await page.getByTestId('swarm-bottom-bar').getByRole('button', { name: w.open, exact: true }).click()

          // The manager is the SECOND seat of a sideways-scrolling row; at 390px
          // it starts off-screen, so scroll it in first.
          const seat = page.locator('[data-seat="manager"]')
          await expect(seat).toHaveCount(1)
          await seat.scrollIntoViewIfNeeded()
          await expect(seat.getByText(w.manager, { exact: true })).toBeVisible()
          await expect(seat.getByText(desk === 'running' ? w.running : w.absent, { exact: true })).toBeVisible()
          const button = seat.getByRole('button', { name: desk === 'running' ? w.stop : w.start, exact: true })
          const say = seat.getByRole('button', { name: w.say, exact: true })
          await expect(button).toBeVisible()
          await expect(say).toBeVisible()
          // The seat's only two controls — start/stop and the folded "Send a
          // word" — and neither is clipped by the seat.
          await expect(seat.getByRole('button')).toHaveCount(2)
          const seatBox = await seat.boundingBox()
          expect(seatBox).not.toBeNull()
          expect(seatBox!.x).toBeGreaterThanOrEqual(0)
          expect(seatBox!.x + seatBox!.width).toBeLessThanOrEqual(width)
          for (const control of [button, say]) {
            const box = await control.boundingBox()
            expect(box).not.toBeNull()
            expect(box!.x).toBeGreaterThanOrEqual(seatBox!.x)
            expect(box!.x + box!.width).toBeLessThanOrEqual(seatBox!.x + seatBox!.width)
          }
          // Folded: no input at all; the retired dashboard stays retired.
          await expect(seat.locator('textarea, input, aside')).toHaveCount(0)
          // Opened: exactly one box appears (nothing is sent). Cancel folds it.
          await say.click()
          await expect(seat.locator('textarea, input')).toHaveCount(1)
          await expect(seat.getByRole('textbox', { name: w.sayBox, exact: true })).toBeVisible()
          await seat.getByRole('button', { name: w.cancel, exact: true }).click()
          await expect(seat.locator('textarea, input')).toHaveCount(0)

          // Monitoring left the screen (owner 2026-09-24).
          await expect(page.getByRole('button', { name: w.monitoring, exact: true })).toHaveCount(0)
          await expect(page.getByText('Runtime (experimental · all projects)', { exact: true })).toHaveCount(0)
          await expect(page.getByRole('group', { name: 'Commander on the Agent SDK', exact: true })).toHaveCount(0)
          await page.screenshot({ path: info.outputPath('manager.png'), fullPage: true, animations: 'disabled' })
        })
      }
    }
  }
}
