import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'
import type { RuntimeTransitionStatus } from '../src/lib/types'

// Both provider names use the same SDK surface. All account, conversation,
// draft and execution responses below are fixtures; no model is started.
let releaseHeldSend: (() => void) | undefined
test.afterEach(async ({ page }) => { releaseHeldSend?.(); releaseHeldSend = undefined; await page.unrouteAll({ behavior: 'wait' }) })
for (const provider of ['claude', 'chatgpt']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`${provider} SDK president chat ${width}px ${theme}`, async ({ page, request }, info) => {
    const project = await createAndImportProject(request, 'president-chat')
    const id = 'sdk-fixture-president-chat', owner = 'fixture-owner'
    const words = Array.from({ length: 5 }, (_, index) => [
      { kind: 'input', text: `相談 ${index + 1}：次の変更を確認してください。` },
      { kind: 'text', text: `確認 ${index + 1}：まず現在の実装と検査結果を読みます。\n\n**変更の理由**が伝わるように、会話の段落と作業の区切りを保ちます。\n\n- 入力した文章を残す\n- 返答を読みやすく表示する` },
    ]).flat()
    let revision = 1, turn: string | undefined
    let deskOpen = true
    let runtimePhase: RuntimeTransitionStatus['phase'] = 'stable', runtimeRevision = 3
    let runtimeProvider = provider, desiredProvider = provider === 'chatgpt' ? 'claude' : 'chatgpt'
    const transitionError = 'Sign in to a Claude subscription before retrying the switch.'
    const runtime = () => ({ scope: 'swarm', revision: runtimeRevision, phase: runtimePhase, effective: { provider: runtimeProvider },
      desired: { provider: runtimePhase === 'stable' ? runtimeProvider : desiredProvider }, updatedAt: new Date(runtimeRevision * 1000).toISOString(),
      ...(runtimePhase === 'attention' ? { error: transitionError } : {}) })
    let draft = { revision: 0, text: '', updatedAt: '2026-11-06T00:00:00Z' }
    const sends: Record<string, unknown>[] = [], stops: Record<string, unknown>[] = [], cancellations: Record<string, unknown>[] = []
    const transitions: Record<string, unknown>[] = [], opens: unknown[] = [], deletes: string[] = []
    const receipts = new Map<string, { id: string; state: string }>()
    let releaseSend: (() => void) | undefined
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: owner, email: 'owner@example.test' } } }))
    await page.route('**/api/experiments', route => route.fulfill({ json: { eligible: true, assistantEligible: false, flags: { swarm: true, sandbox: false }, swarmOptIn: { available: true, enabled: true } } }))
    await page.route('**/api/settings', async route => {
      if (route.request().method() !== 'GET') return route.fulfill({ json: { ok: true } })
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...await response.json(), theme, language: 'ja', swarmOptIn: true, swarmProvider: provider } })
    })
    await page.route('**/api/projects', async route => {
      const response = await route.fetch(), data = await response.json()
      await route.fulfill({ response, json: { ...data, settings: { ...data.settings, theme, language: 'ja', swarmOptIn: true, swarmProvider: provider } } })
    })
    await page.route('**/api/swarm/orchestrator?*', route => route.fulfill({ json: { running: true, workers: [] } }))
    await page.route('**/api/swarm/orchestrator/drain-tick', route => route.fulfill({ json: { running: true, workers: [] } }))
    await page.route('**/api/swarm/workers?*', route => route.fulfill({ json: { workers: [] } }))
    await page.route('**/api/swarm/preflight?*', route => route.fulfill({ json: { issues: [] } }))
    await page.route('**/api/swarm/escalations?*', route => route.fulfill({ json: { escalations: [] } }))
    await page.route('**/api/terminal/active', route => route.fulfill({ json: { cwds: [], claude: deskOpen ? [{ id, cwd: project.path, status: 'working', desk: true }] : [] } }))
    await page.route('**/api/phone-link/call-notes?*', route => route.fulfill({ json: { entries: [] } }))
    await page.route('**/api/chatgpt/status', route => route.fulfill({ json: { connection: { state: 'signed-out', models: [] }, preferences: { swarmProvider: provider } } }))
    await page.route(`**/api/sdk-session/${id}?*`, route => {
      if (route.request().method() === 'DELETE') deletes.push(route.request().url())
      return route.fulfill(deskOpen ? { json: { status: 'working' } } : { status: 404, json: { error: 'closed-fixture' } })
    })
    await page.route('**/api/swarm/supply/open', route => {
      opens.push(route.request().postDataJSON())
      return route.fulfill({ status: 409, json: { error: 'No president launch belongs in this fixture.' } })
    })
    await page.route('**/api/swarm/supply/stop', route => {
      expect(route.request().postDataJSON()).toEqual({ path: project.path })
      deskOpen = false; turn = undefined
      for (const receipt of receipts.values()) if (receipt.state === 'executing') receipt.state = 'uncertain'
      return route.fulfill({ json: { ok: true, stopped: 1 } })
    })
    await page.route(`**/api/sdk-session/${id}/tail?*`, route => route.fulfill({ json: { frames: [
      { seq: 70, ev: { kind: 'input', text: 'INTERNAL KICKOFF MUST NOT BE A CHAT BUBBLE' } },
      { seq: 71, ev: { kind: 'text', text: words[1].text } },
      { seq: 72, ev: { kind: 'tool_use', name: 'Bash', detail: 'npm test -- --run' } },
      { seq: 73, ev: { kind: 'tool_result', ok: true, head: '24 tests passed' } },
    ], reaped: !deskOpen } }))
    await page.route('**/api/conversation/president/history?*', route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      return route.fulfill({ json: { lines: words, revision: String(revision), overflow: false, seq: 73 } })
    })
    await page.route('**/api/conversation/president/status?*', route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      return route.fulfill({ json: { state: 'delivered', conversationId: 'fixture-conversation', epoch: 3, activeTurnId: turn, runtime: runtime(), capabilities: { conversationControl: 1, cancelPresidentInputs: 1 } } })
    })
    await page.route('**/api/chatgpt/transition', route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      const body = route.request().postDataJSON(); transitions.push(body)
      expect(runtimePhase).toBe('attention')
      expect(body).toMatchObject({ scope: 'swarm', revision: runtimeRevision })
      expect(['retry', 'cancel']).toContain(body.action)
      if (body.action === 'retry') runtimeProvider = desiredProvider
      runtimePhase = 'stable'; runtimeRevision++
      return route.fulfill({ status: 202, json: { runtime: { swarm: runtime() } } })
    })
    await page.route('**/api/conversation/draft?*', async route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON()
        if (body.revision !== draft.revision) return route.fulfill({ status: 409, json: { draft } })
        draft = { ...draft, revision: draft.revision + 1, text: body.text }
      }
      await route.fulfill({ json: draft })
    })
    await page.route('**/api/conversation/receipt?*', route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      const receipt = receipts.get(new URL(route.request().url()).searchParams.get('clientId') ?? '')
      return route.fulfill(receipt ? { json: receipt } : { status: 404, json: { error: 'not-found' } })
    })
    await page.route('**/api/conversation/president/cancel-inputs', route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      const body = route.request().postDataJSON(); cancellations.push(body)
      expect(body).toMatchObject({ path: project.path, conversationId: 'fixture-conversation', epoch: 3 })
      expect(body.operationId).toBeTruthy(); expect(body.note).toBeTruthy()
      expect(body.messageIds).toHaveLength(1)
      const receipt = receipts.get(body.messageIds[0])
      expect(receipt).toBeTruthy()
      expect(['queued', 'uncertain']).toContain(receipt!.state)
      receipt!.state = 'cancelled'
      return route.fulfill({ json: { ok: true, receipts: [receipt], conversationId: 'fixture-conversation', epoch: 3 } })
    })
    await page.route(`**/api/sdk-session/${id}/input?*`, async route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      const body = route.request().postDataJSON(); sends.push(body)
      if (sends.length === 1) return route.fulfill({ status: 409, json: { error: 'fixture refusal' } })
      if (sends.length > 2) {
        const receipt = { id: body.clientId, state: sends.length === 3 ? 'queued' : 'executing' }
        receipts.set(receipt.id, receipt)
        draft = { ...draft, revision: draft.revision + 1, text: '' }
        return route.fulfill({ status: 202, json: { queued: true, delivered: false, receipt } })
      }
      await new Promise<void>(resolve => { releaseSend = resolve; releaseHeldSend = resolve })
      words.push({ kind: 'input', text: body.text }, { kind: 'text', text: '依頼を受け付けました。作業を進めます。' })
      revision++; turn = 'fixture-turn-a'; draft = { ...draft, revision: draft.revision + 1, text: '' }
      await route.fulfill({ json: { queued: true, delivered: true, receipt: { id: body.clientId, state: 'delivered' } } })
    })
    await page.route('**/api/conversation/president/stop', async route => {
      expect(route.request().headers()['x-openground-owner']).toBe(owner)
      stops.push(route.request().postDataJSON())
      if (stops.length === 1) { turn = 'fixture-turn-b'; return route.abort('failed') }
      await route.fulfill({ json: { type: 'ack', id: stops.at(-1)!.operationId, state: 'delivered' } })
    })
    await page.addInitScript(({ projectId, id, theme }) => {
      localStorage.setItem('openground:onboarded', '1'); localStorage.setItem('og-lang', 'ja'); localStorage.setItem('og-theme', theme)
      localStorage.setItem('openground.view', JSON.stringify({ projectId, panelTab: 'board' }))
      localStorage.setItem(`openground.swarm.supply.${projectId}`, JSON.stringify({ terminalId: '', runtime: 'sdk', sdkSessionId: id, agentSessionId: '', startedAt: '2026-11-06T00:00:00Z' }))
    }, { projectId: project.id, id, theme })
    await page.goto('/')
    const toggle = page.getByTestId('swarm-bar-toggle')
    await toggle.click()
    const seat = page.locator('[data-seat-key="supply"]'), scroll = seat.locator('[data-president-scroll]')
    const box = seat.getByRole('textbox', { name: '社長に話す' }), send = seat.getByRole('button', { name: '送る', exact: true })
    await expect(box).toBeVisible(); await expect(toggle).toBeFocused()
    // Use the existing accessible dock resize, as an owner can while reading.
    // The legacy suite also covers the ordinary 360px dock unchanged.
    for (let index = 0; index < 10; index++) await toggle.press('ArrowUp')
    await expect(seat.locator('[data-chat-role="owner"]')).toHaveCount(5)
    await expect(seat.getByText('INTERNAL KICKOFF MUST NOT BE A CHAT BUBBLE')).toHaveCount(0)
    await expect(seat.getByText(words[1].text, { exact: true })).toHaveCount(0) // prose has real paragraph/strong/list blocks
    await expect(seat.locator('[data-chat-role="assistant"]')).toHaveCount(5)
    const activities = seat.getByRole('button', { name: '直近の作業', exact: true })
    await expect(activities).toHaveAttribute('aria-expanded', 'false')
    await activities.click()
    const activity = seat.getByRole('button', { name: 'コマンドを実行しました' })
    await expect(activity).toHaveAttribute('aria-expanded', 'false')
    await activity.click(); await expect(seat.getByText('24 tests passed')).toBeVisible(); await activity.click(); await activities.click()
    await expect(send).toBeDisabled()
    expect(await send.evaluate(el => getComputedStyle(el).opacity)).toBe('0.4')
    await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    words.push({ kind: 'text', text: '手動で読んでいる位置はそのままです。' }); revision++
    await expect(seat.getByText('手動で読んでいる位置はそのままです。')).toHaveCount(1)
    expect(await scroll.evaluate(el => el.scrollTop)).toBe(0)
    await seat.getByRole('button', { name: '最新へ', exact: true }).click()
    await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)
    await box.fill('一行目'); await box.press('Shift+Enter'); await box.pressSequentially('二行目')
    await box.dispatchEvent('compositionstart'); await box.dispatchEvent('keydown', { key: 'Enter' }); await box.dispatchEvent('compositionend')
    await box.dispatchEvent('keydown', { key: 'Enter', isComposing: true }); await box.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
    expect(sends).toHaveLength(0)
    await page.mouse.move(0, 0)
    const style = () => send.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
    const normal = await style(); await send.hover(); await expect.poll(style).not.toEqual(normal)
    const hover = await style(); await box.focus(); await page.keyboard.press('Tab'); await expect(send).toBeFocused()
    expect(await send.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid')
    await send.hover(); await page.mouse.down(); await expect.poll(style).not.toEqual(hover); await page.mouse.up()
    await expect(seat.getByRole('status')).toContainText('fixture refusal'); await expect(box).toHaveValue('一行目\n二行目')
    await box.press('Enter'); await expect(seat.locator('[data-president-composer] button').first()).toBeDisabled(); await expect(box).toHaveAttribute('readonly', '')
    await expect.poll(() => !!releaseSend).toBe(true); releaseSend!()
    await expect(box).toHaveValue('')
    const stop = seat.getByRole('button', { name: '返答を止める', exact: true })
    await stop.click(); await expect(seat.getByText('停止を確認できませんでした。現在の返答を確認してから、もう一度お試しください。')).toBeVisible()
    await page.screenshot({ path: info.outputPath(`stop-error-${provider}-${width}-${theme}.png`), animations: 'disabled' })
    await seat.getByRole('button', { name: '停止結果を確認する', exact: true }).click()
    expect(stops).toHaveLength(2); expect(stops[1]).toEqual(stops[0]); expect(stops[0]).toMatchObject({ path: project.path, turnId: 'fixture-turn-a', conversationId: 'fixture-conversation', epoch: 3 })
    await box.fill('次の相談も保存します。'.repeat(6))
    await expect.poll(() => draft.text).toContain('次の相談')
    const before = await box.inputValue()
    await toggle.click(); await toggle.click(); await expect(box).toHaveValue(before)
    await page.reload()
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    await expect(box).toHaveValue(before)
    await expect(seat.locator('[data-chat-role="assistant"]')).toHaveCount(7)
    const bounds = await box.boundingBox(), panel = await scroll.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900); expect(panel!.y + panel!.height).toBeLessThanOrEqual(bounds!.y)
    const ownerBubble = await seat.locator('[data-chat-role="owner"]').last().boundingBox()
    expect(ownerBubble!.x).toBeGreaterThan(panel!.x)
    await page.screenshot({ path: info.outputPath(`chat-${provider}-${width}-${theme}.png`), animations: 'disabled' })

    // Acceptance is not execution: cancel only the queued immutable input ID,
    // keeping an independently edited draft and the open desk intact.
    const queuedText = 'まだ始まっていないため、この指示は取り消します。'
    await box.fill(queuedText); await box.press('Enter'); await expect(box).toHaveValue('')
    const queuedId = sends[2].clientId as string
    const queued = page.locator('details').filter({ has: page.getByText(queuedText, { exact: true }) })
    await expect(queued.locator('summary')).toHaveText('受信済み・待機中')
    await queued.locator('summary').click()
    await box.fill('この下書きは取消操作とは別に残します。')
    await page.screenshot({ path: info.outputPath(`queued-cancel-${provider}-${width}-${theme}.png`), animations: 'disabled' })
    await queued.getByRole('button', { name: '指示を取り消す', exact: true }).click()
    await expect(queued).toHaveCount(0)
    await expect(box).toHaveValue('この下書きは取消操作とは別に残します。')
    expect(cancellations[0].messageIds).toEqual([queuedId]); expect(receipts.get(queuedId)?.state).toBe('cancelled')
    expect(sends).toHaveLength(3); expect(deskOpen).toBe(true)

    // A consumed instruction becomes uncertain after its actor closes. Its
    // recovery controls remain available outside the now-unmounted seat.
    const uncertainText = '別の手段で完了した作業なので、これ以上続けないでください。'
    await box.fill(uncertainText); await box.press('Enter'); await expect(box).toHaveValue('')
    const uncertainId = sends[3].clientId as string
    const uncertain = page.locator('details').filter({ has: page.getByText(uncertainText, { exact: true }) })
    await expect(uncertain.locator('summary')).toHaveText('回答中')
    await expect(uncertain.getByRole('button', { name: '指示を取り消す', exact: true })).toHaveCount(0)
    await seat.getByRole('button', { name: '社長を終了', exact: true }).click()
    await expect(box).toHaveCount(0)
    await expect(page.getByText('前の指示の確認が必要なため、後の指示も待機しています。不要な指示は取り消せます。', { exact: true })).toBeVisible()
    await uncertain.locator('summary').click()
    await expect(uncertain.getByText(uncertainText, { exact: true })).toBeVisible()
    const cancelClosed = uncertain.getByRole('button', { name: '指示を取り消す', exact: true })
    await expect(cancelClosed).toBeEnabled()
    const cancelBounds = await cancelClosed.boundingBox()
    expect(cancelBounds!.x).toBeGreaterThanOrEqual(0); expect(cancelBounds!.x + cancelBounds!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: info.outputPath(`closed-uncertain-${provider}-${width}-${theme}.png`), animations: 'disabled' })
    await cancelClosed.click()
    await expect(uncertain).toHaveCount(0)
    await expect(page.getByText('前の指示の確認が必要なため、後の指示も待機しています。不要な指示は取り消せます。', { exact: true })).toHaveCount(0)
    expect(cancellations[1].messageIds).toEqual([uncertainId]); expect(cancellations[1].operationId).not.toBe(cancellations[0].operationId)
    expect(receipts.get(uncertainId)?.state).toBe('cancelled'); expect(sends).toHaveLength(4); expect(deskOpen).toBe(false)

    // The closed president is also the recovery surface. A pending switch must
    // not become an unrelated supply/open or an old-handle DELETE request.
    const deletedBeforeSwitch = deletes.length
    const launch = seat.getByRole('button', { name: '社長を呼ぶ', exact: true })
    runtimePhase = 'draining'; runtimeRevision++
    await page.evaluate(() => window.dispatchEvent(new Event('openground:chatgpt-change')))
    await expect(page.locator('[data-runtime-phase="draining"]')).toContainText('現在の作業の完了待ち')
    await expect(launch).toBeDisabled()
    await expect(page.getByRole('button', { name: '切り替えをやめる', exact: true })).toHaveCount(0)
    await launch.dispatchEvent('click')
    expect(opens).toEqual([]); expect(deletes).toHaveLength(deletedBeforeSwitch)
    runtimePhase = 'attention'
    await page.evaluate(() => window.dispatchEvent(new Event('openground:chatgpt-change')))
    const attention = page.locator('[data-runtime-phase="attention"]')
    await expect(attention).toContainText('ChatGPT'); await expect(attention).toContainText('Claude')
    await expect(attention).toContainText(transitionError)
    await expect(attention.getByRole('button', { name: '再試行', exact: true })).toBeEnabled()
    await expect(attention.getByRole('button', { name: '切り替えをやめる', exact: true })).toBeEnabled()
    await expect(launch).toBeDisabled()
    const recoveryBounds = await attention.boundingBox()
    expect(recoveryBounds!.x).toBeGreaterThanOrEqual(0); expect(recoveryBounds!.x + recoveryBounds!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: info.outputPath(`switch-attention-${provider}-${width}-${theme}.png`), animations: 'disabled' })
    const retryRevision = runtimeRevision
    await attention.getByRole('button', { name: '再試行', exact: true }).click()
    await expect(attention).toHaveCount(0); await expect(launch).toBeEnabled()
    expect(transitions[0]).toEqual({ action: 'retry', scope: 'swarm', revision: retryRevision })
    expect(opens).toEqual([]); expect(deletes).toHaveLength(deletedBeforeSwitch)

    // Cancel uses the next observed revision, preserving the current effective
    // provider rather than issuing another launch or replaying owner input.
    runtimePhase = 'attention'; runtimeRevision++; desiredProvider = runtimeProvider === 'claude' ? 'chatgpt' : 'claude'
    await page.evaluate(() => window.dispatchEvent(new Event('openground:chatgpt-change')))
    await expect(attention).toBeVisible(); await expect(launch).toBeDisabled()
    const cancelRevision = runtimeRevision
    await attention.getByRole('button', { name: '切り替えをやめる', exact: true }).click()
    await expect(attention).toHaveCount(0); await expect(launch).toBeEnabled()
    expect(transitions[1]).toEqual({ action: 'cancel', scope: 'swarm', revision: cancelRevision })
    expect(opens).toEqual([]); expect(deletes).toHaveLength(deletedBeforeSwitch)
    expect(sends).toHaveLength(4); expect(deskOpen).toBe(false)
    await page.screenshot({ path: info.outputPath(`switch-recovered-${provider}-${width}-${theme}.png`), animations: 'disabled' })
  })
}
