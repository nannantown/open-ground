import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAndImportProject } from './fixtures/helpers'

// An image an agent sends shows in the Mac chats (docs/CHAT_SPEC.md §9.4):
// under the assistant's words in its window, and in the president's seat chat
// from a whole-line `![…](/path)`; a click opens it large. All fixtures: no
// model runs. Shot light and dark for the card.
const IMAGE = readFileSync(join(__dirname, '..', 'docs', 'screenshots', 'swarm-bar-drag-20260926', 'light-2-open.png'))
const PATH = '/tmp/og-shots/login.png'
const GONE = '/tmp/og-shots/gone.png'

const theme = async (page: Page, t: string, extra: Record<string, unknown> = {}) => {
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: { ok: true } })
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), theme: t, language: 'ja', ...extra } })
  })
  await page.route('**/api/projects', async (route) => {
    const response = await route.fetch(), data = await response.json()
    await route.fulfill({ response, json: { ...data, settings: { ...data.settings, theme: t, language: 'ja', ...extra } } })
  })
}

for (const t of ['light', 'dark']) {
  test(`assistant window shows a sent image, large on click (${t})`, async ({ page }, info) => {
    await theme(page, t)
    await page.route('**/api/experiments', (r) => r.fulfill({ json: { eligible: true, assistantEligible: true, flags: { swarm: false, sandbox: false }, swarmOptIn: { available: true, enabled: false } } }))
    await page.route('**/api/chatgpt/status', (r) => r.fulfill({ json: { connection: { state: 'signed-out', models: [] }, lockdown: false, preferences: {} } }))
    await page.addInitScript(() => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('og.assistant.expanded', '1')
      ;(window as unknown as { EventSource: unknown }).EventSource = class { onmessage?: unknown; constructor() {} close() {} addEventListener() {} }
    })
    const entries = [
      { id: 'o1', at: 1, who: 'owner', via: 'screen', text: 'ログイン画面のスクショ送って' },
      { id: 'a1', at: 2, who: 'assistant', via: 'screen', text: 'どうぞ。今のログイン画面です。', photo: '2026-11-16-shot.png' },
    ]
    await page.route('**/api/phone-link/assistant/log', (r) => r.fulfill({ json: { entries, name: 'ノノ', look: 'verm', logDays: 30, memoryChars: 4000, voice: true, proposals: [] } }))
    await page.route('**/api/phone-link/assistant/warm', (r) => r.fulfill({ json: { ok: true } }))
    await page.route('**/api/phone-link/assistant/photo/*', (r) => r.fulfill({ contentType: 'image/png', body: IMAGE }))
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: 'ノノ' }).click()
    const talk = page.getByTestId('assistant-talk')
    const thumb = talk.locator('img[src$="2026-11-16-shot.png"]')
    await expect(thumb).toBeVisible()
    await expect.poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    expect((await thumb.boundingBox())!.height).toBeLessThanOrEqual(160)
    await page.screenshot({ path: info.outputPath(`assistant-image-${t}.png`), animations: 'disabled' })
    await thumb.click()
    const large = page.locator('[data-esc-overlay] img')
    await expect(large).toBeVisible()
    expect((await large.boundingBox())!.height).toBeGreaterThan(160)
    await page.screenshot({ path: info.outputPath(`assistant-image-large-${t}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(large).toHaveCount(0)
    await expect(talk).toBeVisible()
  })

  test(`president seat chat shows an image line as the image (${t})`, async ({ page, request }, info) => {
    const project = await createAndImportProject(request, `agent-image-${t}`)
    const id = 'sdk-fixture-agent-image', owner = 'fixture-owner'
    await theme(page, t, { swarmOptIn: true, swarmProvider: 'claude' })
    await page.route('**/api/auth/session', (r) => r.fulfill({ json: { user: { id: owner, email: 'owner@example.test' } } }))
    await page.route('**/api/experiments', (r) => r.fulfill({ json: { eligible: true, assistantEligible: false, flags: { swarm: true, sandbox: false }, swarmOptIn: { available: true, enabled: true } } }))
    await page.route('**/api/swarm/orchestrator?*', (r) => r.fulfill({ json: { running: true, workers: [] } }))
    await page.route('**/api/swarm/orchestrator/drain-tick', (r) => r.fulfill({ json: { running: true, workers: [] } }))
    await page.route('**/api/swarm/workers?*', (r) => r.fulfill({ json: { workers: [] } }))
    await page.route('**/api/swarm/preflight?*', (r) => r.fulfill({ json: { issues: [] } }))
    await page.route('**/api/swarm/escalations?*', (r) => r.fulfill({ json: { escalations: [] } }))
    await page.route('**/api/terminal/active', (r) => r.fulfill({ json: { cwds: [], claude: [{ id, cwd: project.path, status: 'working', desk: true }] } }))
    await page.route('**/api/phone-link/call-notes?*', (r) => r.fulfill({ json: { entries: [] } }))
    await page.route('**/api/chatgpt/status', (r) => r.fulfill({ json: { connection: { state: 'signed-out', models: [] }, preferences: { swarmProvider: 'claude' } } }))
    await page.route(`**/api/sdk-session/${id}?*`, (r) => r.fulfill({ json: { status: 'idle' } }))
    await page.route(`**/api/sdk-session/${id}/tail?*`, (r) => r.fulfill({ json: { frames: [], reaped: false } }))
    const lines = [
      { kind: 'input', text: 'いまのログイン画面の画像を送って' },
      { kind: 'text', text: `今のログイン画面です。\n\n![ログイン画面](${PATH})\n\nボタンの位置は昨日の修正のままです。` },
      { kind: 'input', text: '前の画像も' },
      { kind: 'text', text: `前の画像はもう残っていません。\n\n![前の画面](${GONE})` },
    ]
    await page.route('**/api/conversation/president/history?*', (r) => r.fulfill({ json: { lines, revision: '1', overflow: false, seq: 1 } }))
    await page.route('**/api/conversation/president/status?*', (r) => r.fulfill({ json: { state: 'delivered', conversationId: 'fixture-conversation', epoch: 1, runtime: { scope: 'swarm', revision: 1, phase: 'stable', effective: { provider: 'claude' }, desired: { provider: 'claude' }, updatedAt: new Date(1000).toISOString() }, capabilities: { conversationControl: 1, cancelPresidentInputs: 1 } } }))
    const asked: string[] = []
    await page.route('**/api/agent-image?*', (r) => (asked.push(new URL(r.request().url()).searchParams.get('path') ?? ''), new URL(r.request().url()).searchParams.get('path') === GONE ? r.fulfill({ status: 404, json: { error: 'not found' } }) : r.fulfill({ contentType: 'image/png', body: IMAGE })))
    await page.route('**/api/conversation/draft?*', (r) => r.fulfill({ json: { revision: 0, text: '', updatedAt: '2026-11-16T00:00:00Z' } }))
    await page.addInitScript(({ projectId, id, t }) => {
      localStorage.setItem('openground:onboarded', '1'); localStorage.setItem('og-lang', 'ja'); localStorage.setItem('og-theme', t)
      localStorage.setItem('openground.view', JSON.stringify({ projectId, panelTab: 'board' }))
      localStorage.setItem(`openground.swarm.supply.${projectId}`, JSON.stringify({ terminalId: '', runtime: 'sdk', sdkSessionId: id, agentSessionId: '', startedAt: '2026-11-16T00:00:00Z' }))
    }, { projectId: project.id, id, t })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    const toggle = page.getByTestId('swarm-bar-toggle')
    await toggle.click()
    for (let i = 0; i < 10; i++) await toggle.press('ArrowUp')
    const seat = page.locator('[data-seat-key="supply"]')
    const img = seat.locator('[data-chat-role="assistant"] img').first()
    await expect(img).toBeVisible()
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    expect(asked).toContain(PATH)
    await expect(seat.getByText(PATH)).toHaveCount(0)
    await expect(seat.getByText('ボタンの位置は昨日の修正のままです。')).toBeVisible()
    // An image that cannot load: its words in place, faded, never opened large.
    const gone = seat.locator('[data-chat-role="assistant"] button:has(img[alt="前の画面"])')
    await expect(gone).toBeDisabled()
    await expect.poll(() => gone.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.4') // after its 150 ms fade
    await page.screenshot({ path: info.outputPath(`president-image-${t}.png`), animations: 'disabled' })
    await gone.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`president-image-gone-${t}.png`), animations: 'disabled' })
    await img.click()
    await expect(page.locator('[data-esc-overlay] img')).toBeVisible()
    await page.screenshot({ path: info.outputPath(`president-image-large-${t}.png`), animations: 'disabled' })
  })
}
