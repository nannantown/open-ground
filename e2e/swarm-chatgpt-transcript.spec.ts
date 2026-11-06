import { test, expect } from '@playwright/test'
import { ChatGptConversation } from '../src/lib/server/chatgptResponses'
import type { SdkEvent } from '../src/lib/server/sdkEvents'
import { createAndImportProject } from './fixtures/helpers'

// Real Responses decoder/adapter → real seat rendering. All model, auth and
// dashboard I/O is synthetic; no real agent is started or sent a message.
const prose = '切り替えはこのまま進めます。\n次も同じ設定です。\n\n' + '文章の前半と後半を保って表示します。'.repeat(9)
const final = '確認しました。'
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const response = (output: unknown[]) => ({ type: 'response.completed', response: { status: 'completed', model: 'test-model', output } })

const transcript = async () => {
  const events: SdkEvent[] = [{ kind: 'input', text: '表示を確認してください。' }]
  let requests = 0
  const conversation = new ChatGptConversation({ persist: false, model: 'test-model',
    accountKey: async () => 'fixture-account', accessToken: async () => 'fixture-token',
    tools: [{ name: 'Read', description: 'Fixture read', parameters: { type: 'object' }, invoke: async () => '確認用の結果です。' }],
    fetch: (async () => {
      const frames = ++requests === 1 ? [
        ...Array.from(prose, delta => ({ type: 'response.output_text.delta', item_id: 'first-message', output_index: 0, content_index: 0, delta })),
        response([message(prose), { type: 'function_call', namespace: 'openground', name: 'Read', call_id: 'fixture-read', arguments: '{}' }]),
      ] : [{ type: 'response.output_text.delta', delta: final }, response([message(final)])]
      const bytes = new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1))
        controller.close()
      } }), { headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch,
  })
  await conversation.run('確認', { onEvent: event => events.push(event) })
  return events.map((ev, i) => ({ seq: i + 1, ev }))
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }) })

for (const width of [1280, 390]) for (const role of ['manager', 'supply'] as const) {
  test(`ChatGPT ${role} keeps Japanese prose in paragraphs at ${width}px`, async ({ page, request }, info) => {
    const frames = await transcript()
    const project = await createAndImportProject(request, 'chatgpt-prose')
    const id = `sdk-fixture-${role}`
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/experiments', route => route.fulfill({ json: {
      eligible: true, assistantEligible: false, flags: { swarm: true, sandbox: false }, swarmOptIn: { available: true, enabled: true },
    } }))
    await page.route('**/api/settings', async route => {
      if (route.request().method() !== 'GET') return route.fulfill({ json: { ok: true } })
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...await response.json(), swarmOptIn: true, swarmProvider: 'chatgpt' } })
    })
    await page.route('**/api/swarm/orchestrator?*', route => route.fulfill({ json: { running: true, workers: [] } }))
    await page.route('**/api/swarm/orchestrator/drain-tick', route => route.fulfill({ json: { running: true, workers: [] } }))
    await page.route('**/api/swarm/workers?*', route => route.fulfill({ json: { workers: [] } }))
    await page.route('**/api/swarm/preflight?*', route => route.fulfill({ json: { issues: [] } }))
    await page.route('**/api/swarm/escalations?*', route => route.fulfill({ json: { escalations: [] } }))
    await page.route('**/api/terminal/active', route => route.fulfill({ json: { cwds: [], claude: [{ id, cwd: project.path, status: 'working', desk: true }] } }))
    await page.route(`**/api/sdk-session/${id}?*`, route => route.fulfill({ json: { status: 'working' } }))
    await page.route(`**/api/sdk-session/${id}/tail?*`, route => {
      const after = Number(new URL(route.request().url()).searchParams.get('after'))
      return route.fulfill({ json: { frames: frames.filter(frame => frame.seq > after).slice(-80), reaped: false } })
    })
    await page.route('**/api/phone-link/call-notes?*', route => route.fulfill({ json: { entries: [] } }))
    await page.addInitScript(({ projectId, role, id }) => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('og-lang', 'ja')
      localStorage.setItem('openground.view', JSON.stringify({ projectId, panelTab: 'board' }))
      localStorage.setItem(`openground.swarm.${role}.${projectId}`, JSON.stringify({ terminalId: '', runtime: 'sdk', sdkSessionId: id, agentSessionId: '', startedAt: '2026-11-05T00:00:00.000Z' }))
    }, { projectId: project.id, role, id })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByTestId('swarm-bottom-bar').getByRole('button', { name: 'エージェントチームをひらく', exact: true }).click()
    const folded = page.locator(`[data-rail-seat="${role}"]`)
    if (await folded.count()) await folded.click()
    const feed = page.locator(`[data-seat-key="${role}"] [data-seat-feed]`)
    await expect(feed).toBeVisible()
    await expect(feed.locator('p')).toHaveText([prose.split('\n\n')[0], prose.split('\n\n')[1], final])
    // More than 80 source deltas retain both ends of the text in the seat's
    // real 80-frame tail, and Japanese characters advance along one line.
    expect(Array.from(prose).length).toBeGreaterThan(80)
    const positions = await feed.locator('p').first().evaluate(p => {
      const text = p.querySelector('span')!.firstChild!
      return Array.from({ length: 5 }, (_, i) => {
        const range = document.createRange()
        range.setStart(text, i)
        range.setEnd(text, i + 1)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y }
      })
    })
    expect(new Set(positions.map(position => position.y)).size).toBe(1)
    expect(positions.every((position, i) => i === 0 || position.x > positions[i - 1].x)).toBe(true)
    // The president names public activities in the UI language; the manager
    // keeps its tool-card label. This legacy tail fixture has no owner login
    // (the canonical owner history/group is covered by president-chat.spec).
    const read = feed.getByRole('button', { name: role === 'supply' ? 'ファイルを読み込みました' : /Read/ })
    await expect(read).toBeVisible()
    await expect(read).toHaveAttribute('aria-expanded', 'false')
    await read.click()
    await expect(read).toHaveAttribute('aria-expanded', 'true')
    await expect(feed.getByText('確認用の結果です。', { exact: false })).toBeVisible()
    await feed.evaluate(element => { element.firstElementChild!.scrollTop = 0 })
    await page.screenshot({ path: info.outputPath(`chatgpt-${role}-${width}.png`), fullPage: true, animations: 'disabled' })
  })
}
