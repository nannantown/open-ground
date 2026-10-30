// Screenshots of the desktop assistant window's message states (docs/CHAT_SPEC.md
// §5b), light and dark: delivered (waiting for its turn), replying (the thinking
// row), failed (未送信 from this window + 返事なし from the log). Runs against an
// ISOLATED server, never the owner's app (see desktop-shots.mjs for the boot line):
//   node docs/design/chat-spec/states-shots.mjs http://127.0.0.1:47886 <out dir>
// The say stream is faked in the page (fetch), so each state holds still for its shot.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const [BASE = 'http://127.0.0.1:47886', OUT = 'chat-state-shots'] = process.argv.slice(2)
// This script POSTs /api/settings (theme, language): never point it at the owner's app.
if (new URL(BASE).port === '47776') throw new Error('refusing :47776 — that is the real app; boot an isolated server on another port')
mkdirSync(OUT, { recursive: true })
const NAME = 'ノノ'
const T0 = Date.now() - 3600_000
const talk = [
  { who: 'owner', text: '全体どう？' },
  { who: 'assistant', text: 'OPEN GROUND で作業が2件進んでいて、質問が1件届いています。' },
].map((l, i) => ({ id: `l${i}`, at: T0 + i * 60_000, via: 'screen', ...l }))
// An owner line in the log with no answer after it: 返事なし.
const lost = { id: 'lost', at: T0 + 180_000, via: 'phone', who: 'owner', text: 'NENE の質問に答えておいて', clientId: 'phone-1' }

const STATES = [
  { name: 'delivered', entries: talk, mode: 'hold', send: '明日の予定は？' },
  { name: 'replying', entries: talk, mode: 'replying', send: '明日の予定は？' },
  { name: 'failed', entries: [...talk, lost], mode: 'fail', send: '社長に進めてと伝えて' },
]

// No Playwright browser downloaded on this Mac: the installed Chrome does the same.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }))
for (const theme of ['light', 'dark']) {
  await fetch(`${BASE}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme, language: 'ja' }) })
  for (const s of STATES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'ja-JP' })
    await page.addInitScript((mode) => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('og.assistant.expanded', '1')
      window.EventSource = class {
        constructor() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }), 50) }
        close() {} addEventListener() {}
      }
      const real = window.fetch.bind(window)
      window.fetch = (url, init) => {
        if (!String(url).endsWith('/api/phone-link/assistant/say')) return real(url, init)
        if (mode === 'fail') return Promise.resolve(new Response(JSON.stringify({ error: 'mac-offline' }), { status: 503 }))
        // Taken by the server (the stream is open); 'replying' = its turn began. Never answers.
        return Promise.resolve(new Response(new ReadableStream({
          start: (c) => { if (mode === 'replying') c.enqueue(new TextEncoder().encode('{"state":"replying"}\n')) },
        })))
      }
    }, s.mode)
    await page.route('**/api/phone-link/assistant/log', (r) => r.fulfill({ json: { entries: s.entries, name: NAME, look: 'verm', logDays: 30, memoryChars: 4000, voice: true, proposals: [] } }))
    await page.route('**/api/phone-link/assistant/warm', (r) => r.fulfill({ json: { ok: true } }))
    await page.goto(BASE + '/')
    await page.getByRole('button', { name: NAME }).first().click()
    await page.waitForTimeout(600)
    await page.getByRole('textbox').last().fill(s.send)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    await page.locator('section[data-og-assistant]').screenshot({ path: `${OUT}/${theme}-${s.name}.png` })
    await page.close()
  }
}
await browser.close()
console.log(`shots in ${OUT}`)
