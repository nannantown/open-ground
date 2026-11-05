import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// The provider-independent president UI (Claude PTY / ChatGPT SDK). Every desk/input response is a
// browser fixture: no agent, real subscription, settings write or send is used.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }) })

for (const provider of ['claude', 'chatgpt']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`${provider} president conversation at ${width}px in ${theme}`, async ({ page, request }, info) => {
    const project = await createAndImportProject(request, 'president-talk')
    const id = 'sdk-fixture-president'
    const runtime = provider === 'claude' ? 'pty' : 'sdk'
    const sent: string[] = []
    const nativeInput: string[] = []
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/experiments', route => route.fulfill({ json: {
      eligible: true, assistantEligible: false, flags: { swarm: true, sandbox: false }, swarmOptIn: { available: true, enabled: true },
    } }))
    await page.route('**/api/settings', async route => {
      if (route.request().method() !== 'GET') return route.fulfill({ json: { ok: true } })
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...await response.json(), theme, swarmOptIn: true, swarmProvider: provider } })
    })
    await page.route('**/api/projects', async route => {
      const response = await route.fetch()
      const data = await response.json()
      await route.fulfill({ response, json: { ...data, settings: { ...data.settings, theme, swarmOptIn: true, swarmProvider: provider } } })
    })
    await page.route('**/api/swarm/orchestrator?*', route => route.fulfill({ json: { running: true, workers: [] } }))
    await page.route('**/api/swarm/orchestrator/drain-tick', route => route.fulfill({ json: { running: true, workers: [] } }))
    await page.route('**/api/swarm/workers?*', route => route.fulfill({ json: { workers: [] } }))
    await page.route('**/api/swarm/preflight?*', route => route.fulfill({ json: { issues: [] } }))
    await page.route('**/api/swarm/escalations?*', route => route.fulfill({ json: { escalations: [] } }))
    await page.route('**/api/terminal/active', route => route.fulfill({ json: { cwds: [], claude: [{ id, cwd: project.path, status: 'working', desk: true }] } }))
    await page.route(`**/api/sdk-session/${id}?*`, route => route.fulfill({ json: { status: 'working' } }))
    await page.route(`**/api/sdk-session/${id}/tail?*`, route => route.fulfill({ json: {
      frames: [{ seq: 1, ev: { kind: 'text', text: '何から進めましょうか。' } }], reaped: false,
    } }))
    await page.route(`**/api/sdk-session/${id}/input?*`, async route => {
      expect(runtime).toBe('sdk')
      sent.push(route.request().postDataJSON().text)
      await route.fulfill(sent.length === 1 ? { status: 409, json: { error: 'fixture refusal' } } : { json: { ok: true, queued: true } })
    })
    await page.route('**/api/swarm/supply/input', async route => {
      expect(runtime).toBe('pty')
      expect(route.request().postDataJSON()).toMatchObject({ path: project.path, terminalId: id })
      sent.push(route.request().postDataJSON().text)
      await route.fulfill(sent.length === 1 ? { status: 409, json: { error: 'fixture refusal' } } : { json: { queued: true, delivered: false } })
    })
    await page.route(`**/api/terminal/${id}`, route => route.fulfill({ json: {
      id, cwd: project.path, cols: 80, rows: 24, tag: 'claude', agentSessionId: 'fixture-claude', createdAt: Date.now(), finishedAt: null,
    } }))
    await page.route(`**/api/terminal/${id}/stream`, route => route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: `event: init\ndata: ${JSON.stringify({ replay: '何から進めましょうか。\r\n> ' })}\n\n` }))
    await page.route(`**/api/terminal/${id}/resize`, route => route.fulfill({ json: { ok: true } }))
    await page.route(`**/api/terminal/${id}/input`, route => {
      nativeInput.push(route.request().postDataJSON().data)
      return route.fulfill({ json: { ok: true } })
    })
    await page.route('**/api/phone-link/call-notes?*', route => route.fulfill({ json: { entries: [] } }))
    await page.addInitScript(({ projectId, id, theme, runtime }) => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('og-lang', 'ja')
      localStorage.setItem('og-theme', theme)
      localStorage.setItem('openground.view', JSON.stringify({ projectId, panelTab: 'board' }))
      localStorage.setItem(`openground.swarm.supply.${projectId}`, JSON.stringify({ terminalId: runtime === 'pty' ? id : '', runtime, ...(runtime === 'sdk' ? { sdkSessionId: id } : {}), agentSessionId: '', startedAt: '2026-11-05T00:00:00.000Z' }))
    }, { projectId: project.id, id, theme, runtime })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    if (theme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    else await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
    const toggle = page.getByTestId('swarm-bar-toggle')
    const connected = runtime === 'pty' ? page.waitForResponse(response => response.url().endsWith(`/api/terminal/${id}/stream`)) : Promise.resolve()
    await toggle.click()
    const seat = page.locator('[data-seat-key="supply"]')
    const box = seat.getByRole('textbox', { name: '社長に話す' })
    const send = seat.getByRole('button', { name: '送る', exact: true })
    const measurements: unknown[] = []
    const measure = async (stage: string) => measurements.push(await box.evaluate((el, stage) => {
      const seat = el.closest('[data-seat-key]')!
      const row = seat.parentElement!
      const rect = el.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      return { stage, box: { left: rect.left, right: rect.right, width: rect.width }, seatWidth: seat.getBoundingClientRect().width,
        row: { left: rowRect.left, right: rowRect.right, clientWidth: row.clientWidth, scrollWidth: row.scrollWidth, scrollLeft: row.scrollLeft } }
    }, stage))
    const assertComposerFits = async () => {
      const bounds = await box.boundingBox()
      const row = await seat.evaluate(el => {
        const rect = el.parentElement!.getBoundingClientRect()
        return { left: rect.left, right: rect.right }
      })
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
      expect(bounds!.x).toBeGreaterThanOrEqual(row.left)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(row.right)
    }
    await expect(box).toBeVisible()
    await connected
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(toggle).toBeFocused()
    await measure('mounted')
    if (runtime === 'pty') {
      await seat.locator('.xterm-screen').click()
      await page.keyboard.type('native')
      await expect.poll(() => nativeInput.join('')).toBe('native')
    }
    await expect(send).toBeDisabled()
    expect(await send.evaluate(el => ({ opacity: getComputedStyle(el).opacity, cursor: getComputedStyle(el).cursor }))).toEqual({ opacity: '0.4', cursor: 'not-allowed' })
    await box.fill('一行目')
    await box.press('Shift+Enter')
    await box.pressSequentially('二行目')
    await expect(box).toHaveValue('一行目\n二行目')
    await measure('typed')
    await box.dispatchEvent('compositionstart')
    await box.dispatchEvent('keydown', { key: 'Enter', code: 'Enter' })
    await box.dispatchEvent('compositionend')
    await box.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await box.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 })
    await page.waitForTimeout(100)
    expect(sent).toEqual([])

    // All five states use the real compiled CSS in both palettes.
    await page.mouse.move(0, 0)
    const style = () => send.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
    const normal = await style()
    await send.hover()
    await measure('hover-send')
    await expect.poll(style).not.toEqual(normal)
    const hover = await style()
    await box.focus()
    await page.keyboard.press('Tab')
    await expect(send).toBeFocused()
    await measure('tab-to-send')
    expect(await send.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid')
    await send.hover()
    await page.mouse.down()
    await expect.poll(style).not.toEqual(hover)
    await page.mouse.up()
    await expect(seat.getByRole('status')).toContainText('fixture refusal')
    await expect(box).toHaveValue('一行目\n二行目')
    await expect(box).toBeFocused()
    await measure('after-refusal')
    await box.press('Enter')
    await expect(box).toHaveValue('')
    await expect(box).toBeVisible()
    await expect(box).toBeFocused()
    await expect(send).toBeDisabled()
    expect(sent).toEqual(['一行目\n二行目', '一行目\n二行目'])
    await expect(seat.getByRole('status')).toContainText(runtime === 'pty' ? '社長が空いたら届きます。' : '届けました。')
    await box.fill('次の相談も続けて話せます。')
    await measure('new-draft-before-collapse')
    await assertComposerFits()
    await toggle.click()
    await expect(box).toHaveCount(0)
    await toggle.click()
    await expect(box).toHaveValue('次の相談も続けて話せます。')
    await assertComposerFits()
    if (width === 1280) {
      // Normal screens keep saved resize widths and the other seats' minima.
      await page.locator('[data-rail-seat="manager"]').click()
      const border = page.locator('[data-seat-border="supply"]')
      await border.focus()
      await border.press('ArrowLeft')
      const savedWidth = await page.evaluate(projectId => JSON.parse(localStorage.getItem(`openground.swarmseatw.${projectId}`)!).w.supply as number, project.id)
      expect(savedWidth).toBeGreaterThanOrEqual(360)
      await expect.poll(async () => Math.round((await seat.boundingBox())!.width)).toBe(savedWidth)
      expect(await page.locator('[data-seat-key="manager"]').evaluate(el => getComputedStyle(el).minWidth)).toBe('280px')
      await box.focus()
      await page.setViewportSize({ width: 390, height: 900 })
      await expect.poll(async () => Math.round((await seat.boundingBox())!.width)).toBe(318)
      expect(await seat.evaluate(el => getComputedStyle(el).minWidth)).toBe('318px')
      await assertComposerFits()
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(async () => Math.round((await seat.boundingBox())!.width)).toBe(savedWidth)
      await assertComposerFits()
    }
    await measure('new-draft')
    await info.attach('composer-geometry', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
    await page.screenshot({ path: info.outputPath(`${provider}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' })
  })
}
