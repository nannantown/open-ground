// Screenshots the desktop assistant window in each state, light and dark, for the
// Canvas page 「チャットの違い」. Runs against an ISOLATED server (throwaway HOME,
// not the owner's app) — boot one the way playwright.config.ts does, on another port:
//   H=$(mktemp -d); mkdir -p $H/.openground $H/.claude
//   HOME=$H OPENGROUND_HOME=$H/.openground OPENGROUND_WEB_ROOT=$PWD/dist-web PORT=47886 node server/dist/index.cjs
//   node docs/design/chat-spec/desktop-shots.mjs http://127.0.0.1:47886 <out dir>
// Every assistant route is stubbed (as e2e/assistant-proposal-frames.spec.ts does):
// nothing reaches a model, nothing is spoken.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const [BASE = 'http://127.0.0.1:47886', OUT = 'chat-shots'] = process.argv.slice(2)
// This script POSTs /api/settings (theme, language): never point it at the owner's app.
if (new URL(BASE).port === '47776') throw new Error('refusing :47776 — that is the real app; boot an isolated server on another port')
mkdirSync(OUT, { recursive: true })
const NAME = 'ノノ'
const T0 = Date.now() - 3600_000
const talk = [
  { who: 'owner', text: '全体どう？' },
  { who: 'assistant', text: 'OPEN GROUND で作業が2件進んでいて、質問が1件届いています。NENE は終わりました。' },
  { who: 'owner', text: '質問は何？' },
  { who: 'assistant', text: '今日のうちに新しい版を公開してよいか、社長が聞いています。' },
].map((l, i) => ({ id: `l${i}`, at: T0 + i * 60_000, via: 'screen', ...l }))
const card = {
  id: 'p1', kind: 'card', projectId: 'x', project: 'NENE', title: '送料を地域ごとに出す',
  body: 'やること: 注文画面で送料を地域ごとに分けて出す\n完了の条件:\n- 3つの地域で画面を確かめる',
  at: T0, expiresAt: Date.now() + 600_000, state: 'open', via: 'screen',
}

const STATES = [
  { name: 'empty', entries: [], proposals: [] },
  { name: 'chat', entries: talk, proposals: [] },
  { name: 'typing', entries: talk, proposals: [], type: '明日の予定は？' },
  { name: 'proposal', entries: talk, proposals: [card] },
  { name: 'call', entries: talk, proposals: [], call: true },
  { name: 'error', entries: talk, proposals: [], fail: true },
]

const browser = await chromium.launch()
for (const theme of ['light', 'dark']) {
  await fetch(`${BASE}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme, language: 'ja' }) })
  for (const s of STATES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'ja-JP' })
    await page.addInitScript(() => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('og.assistant.expanded', '1')
      ;(window).EventSource = class {
        constructor() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }), 50) }
        close() {} addEventListener() {}
      }
    })
    await page.route('**/api/phone-link/assistant/log', (r) => r.fulfill({ json: { entries: s.entries, name: NAME, look: 'verm', logDays: 30, memoryChars: 4000, voice: true, proposals: s.proposals } }))
    await page.route('**/api/phone-link/assistant/warm', (r) => r.fulfill({ json: { ok: true } }))
    await page.route('**/api/phone-link/assistant/say', (r) => (s.fail ? r.fulfill({ status: 503, json: { error: 'mac-offline' } }) : r.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ reply: 'はい。' }) + '\n' })))
    await page.goto(BASE + '/')
    await page.getByRole('button', { name: NAME }).first().click()
    await page.waitForTimeout(600)
    if (s.call) await page.getByRole('button', { name: /^(Call|通話)$/ }).click()
    if (s.type) await page.getByRole('textbox').last().fill(s.type)
    if (s.fail) { await page.getByRole('textbox').last().fill('全体どう？'); await page.keyboard.press('Enter') }
    await page.waitForTimeout(900)
    const panel = page.locator('section[data-og-assistant]')
    await panel.screenshot({ path: `${OUT}/${theme}-${s.name}.png` })
    await page.close()
  }
}
await browser.close()
console.log(`shots in ${OUT}`)
