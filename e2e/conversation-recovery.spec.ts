import { test, expect } from '@playwright/test'

// All owner/auth/provider responses are browser fixtures. No model, real
// account, settings mutation or president receives these requests.
for (const provider of ['claude', 'chatgpt']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`${provider} durable assistant draft/photo and uncertain receipt ${width}px ${theme}`, async ({ page }, info) => {
    await page.addInitScript(() => localStorage.setItem('openground:onboarded', '1'))
    await page.setViewportSize({ width, height: 900 })
    const owner = 'fixture-owner'
    const draftText = '再起動のあとも、この相談と写真を残す。'.repeat(8)
    let draft = { revision: 0, text: '', updatedAt: '2026-11-05T00:00:00Z' }
    let accepted: { clientId: string; text: string; photo: string; draftRevision: number } | undefined
    let revision = 1
    let phase = 'stable'
    let desired = provider
    let finishRetry: (() => void) | undefined
    const runtime = (scope: string) => ({ scope, revision, phase: scope === 'assistant' ? phase : 'stable', effective: { provider }, desired: { provider: scope === 'assistant' ? desired : provider }, ...(scope === 'assistant' && phase === 'attention' ? { error: 'Fixture target could not start' } : {}), updatedAt: new Date(revision * 1000).toISOString() })
    await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: owner, email: 'owner@example.test' } } }))
    await page.route('**/api/experiments', route => route.fulfill({ json: { eligible: true, assistantEligible: true, flags: { swarm: false, sandbox: false } } }))
    await page.route('**/api/settings', async route => {
      if (route.request().method() !== 'GET') return route.fulfill({ json: { ok: true } })
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...await response.json(), language: 'en', theme } })
    })
    await page.route('**/api/projects', async route => {
      const response = await route.fetch(); const data = await response.json()
      await route.fulfill({ response, json: { ...data, settings: { ...data.settings, language: 'en', theme } } })
    })
    await page.route('**/api/swarm/notifications', route => route.fulfill({ json: { notifications: [] } }))
    await page.route('**/api/chatgpt/preferences', async route => {
      desired = route.request().postDataJSON().assistantProvider
      phase = 'attention'; revision++
      await route.fulfill({ json: { preferences: { assistantProvider: provider, swarmProvider: provider }, runtime: { assistant: runtime('assistant'), swarm: runtime('swarm') } } })
    })
    await page.route('**/api/chatgpt/transition', async route => {
      const body = route.request().postDataJSON()
      expect(body).toMatchObject({ scope: 'assistant', revision })
      if (body.action === 'retry') await new Promise<void>(resolve => { finishRetry = resolve })
      else { phase = 'stable'; desired = provider }
      revision++
      await route.fulfill({ json: { runtime: { assistant: runtime('assistant'), swarm: runtime('swarm') } } })
    })
    await page.route('**/api/chatgpt/status', route => route.fulfill({ json: { preferences: { assistantProvider: provider, swarmProvider: provider }, lockdown: false, connection: { state: 'connected', models: [{ id: 'catalog-fixture', name: 'Fixture model' }] }, runtime: { assistant: runtime('assistant'), swarm: runtime('swarm') } } }))
    await page.route('**/api/phone-link/assistant/log', route => route.fulfill({ json: { name: 'Fixture Assistant', entries: [], voice: false, proposals: [] } }))
    await page.route('**/api/phone-link/assistant/warm', route => route.fulfill({ json: { ok: true } }))
    await page.route('**/api/assistant/runtime', route => route.fulfill({ json: { conversationId: 'fixture-conversation', epoch: 1, pending: accepted ? [{ id: accepted.clientId, text: accepted.text, state: 'uncertain' }] : [], uncertainActions: accepted ? [{ id: 'fixture-action' }] : [] } }))
    await page.route('**/api/conversation/draft?*', async route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON()
        if (body.revision !== draft.revision) return route.fulfill({ status: 409, json: { draft } })
        draft = { ...draft, revision: draft.revision + 1, text: body.text }
      }
      await route.fulfill({ json: draft })
    })
    await page.route('**/api/conversation/receipt?*', route => route.fulfill(accepted ? { json: { id: accepted.clientId, state: 'uncertain' } } : { status: 404, json: { error: 'not-found' } }))
    await page.route('**/api/phone-link/assistant/say', async route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      accepted = route.request().postDataJSON()
      expect(accepted?.clientId).toBeTruthy()
      expect(accepted?.draftRevision).toBe(draft.revision)
      expect(accepted?.photo).toBeTruthy()
      draft = { ...draft, revision: draft.revision + 1, text: '' }
      await route.abort('failed') // durable accept happened; its acknowledgement was lost
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Fixture Assistant', exact: true }).click()
    const box = page.getByRole('textbox', { name: 'Message', exact: true })
    await box.fill(draftText)
    await page.getByTestId('assistant-photo-input').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') })
    await expect(page.getByTestId('assistant-photo-preview')).toBeVisible()
    await expect.poll(() => draft.text).toContain('再起動')
    await expect(page.getByText('Saving…', { exact: true })).toHaveCount(0)
    await page.reload()
    await page.getByRole('button', { name: 'Fixture Assistant', exact: true }).click()
    await expect(box).toHaveValue(draftText)
    await expect(page.getByTestId('assistant-photo-preview')).toBeVisible()
    // Request another provider through its real control. Only the fixture fails
    // the target start; the previous effective actor remains honestly labelled.
    await page.getByRole('button', { name: 'Model and effort', exact: true }).click()
    const picks = page.getByRole('group', { name: 'Assistant' })
    await expect(picks.getByRole('button', { name: provider === 'claude' ? 'Claude' : 'ChatGPT', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const target = provider === 'claude' ? 'ChatGPT' : 'Claude'
    await picks.getByRole('button', { name: target, exact: true }).click()
    const transition = page.locator('[data-runtime-phase="attention"]')
    await expect(transition).toContainText('Running:')
    await expect(transition).toContainText('Claude')
    await expect(transition).toContainText('ChatGPT')
    await expect(transition).toContainText('Fixture target could not start')
    await expect(box).toHaveValue(draftText)
    const retry = transition.getByRole('button', { name: 'Retry', exact: true })
    const style = () => retry.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
    await page.mouse.move(0, 0)
    const normal = await style()
    await retry.hover()
    await expect.poll(style).not.toEqual(normal)
    const hover = await style()
    await retry.focus()
    await page.keyboard.press('Tab')
    const cancel = transition.getByRole('button', { name: 'Cancel switch', exact: true })
    await expect(cancel).toBeFocused()
    expect(await cancel.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid')
    await page.keyboard.press('Shift+Tab')
    await expect(retry).toBeFocused()
    await page.keyboard.down('Space')
    await expect.poll(style).not.toEqual(hover)
    await page.keyboard.up('Space')
    await expect(retry).toBeDisabled()
    await expect(transition.getByRole('button', { name: 'Cancel switch', exact: true })).toBeDisabled()
    await page.screenshot({ path: info.outputPath(`transition-${provider}-${width}-${theme}.png`) })
    const bounds = await box.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900)
    expect(finishRetry).toBeTruthy()
    finishRetry!()
    await expect(retry).toBeEnabled()
    await transition.getByRole('button', { name: 'Cancel switch', exact: true }).click()
    await expect(page.locator('[data-runtime-phase="stable"]')).toBeVisible()
    await page.getByRole('button', { name: 'Model and effort', exact: true }).click()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => accepted?.clientId).toBeTruthy()
    await page.reload()
    await page.getByRole('button', { name: 'Fixture Assistant', exact: true }).click()
    await expect(box).toHaveValue('')
    await expect(page.getByTestId('assistant-photo-preview')).toHaveCount(0)
    await expect(page.getByText('An interrupted action needs review.', { exact: true })).toHaveCount(2) // one input, one distinct action; no duplicate input ID
    await expect(page.getByText('An interrupted action needs review.', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: info.outputPath(`recovery-${provider}-${width}-${theme}.png`) })
  })
}
