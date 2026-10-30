// Screenshots the desktop assistant window passing a message to a president
// (docs/CHAT_SPEC.md §9.9), light and dark. Same rules as desktop-shots.mjs: an
// ISOLATED server (throwaway HOME, never the owner's app), every assistant route
// stubbed — nothing reaches a model or a president.
//   H=$(mktemp -d); mkdir -p $H/.openground $H/.claude
//   HOME=$H OPENGROUND_HOME=$H/.openground OPENGROUND_WEB_ROOT=$PWD/dist-web PORT=47886 node server/dist/index.cjs
//   node docs/design/chat-spec/president-shots.mjs http://127.0.0.1:47886 <out dir> [<card id> <project path>]
// With a card id + project path the PNGs are also attached to that Board card on
// the running app (:47776) — task-asset upload + a CAS PUT of the card's
// attachments only (as ~/.claude/openground-canvas-shot.mjs does).
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const [BASE = 'http://127.0.0.1:47886', OUT = 'president-shots', TASK, PROJECT] = process.argv.slice(2)
if (new URL(BASE).port === '47776') throw new Error('refusing :47776 — that is the real app; boot an isolated server on another port')
mkdirSync(OUT, { recursive: true })
const NAME = 'ノノ'
const T0 = Date.now() - 600_000
const ask = [
  { who: 'owner', text: 'NENEの社長に、進み具合を聞いてきて' },
  { who: 'assistant', text: '伝言の案を出したよ。よければ「送る」を押してね。' },
]
const line = (l, i) => ({ id: `l${i}`, at: T0 + i * 60_000, via: 'screen', ...l })
const frame = {
  id: 'p1', kind: 'president', projectId: 'x', project: 'NENE', title: '社長へ', body: '進み具合を教えて',
  at: T0, expiresAt: Date.now() + 600_000, state: 'open', via: 'screen',
}
const STATES = [
  { name: 'president-proposal', entries: ask.map(line), proposals: [frame] },
  {
    name: 'president-answer',
    entries: [
      ...ask,
      { who: 'assistant', text: 'NENEの社長に伝えたよ。返事が来たら教えるね。' },
      { who: 'assistant', text: 'NENEの社長から返事: 送料の作業は半分まで進んでいて、残りは明日の朝に仕上がる見込みだって。', president: { projectId: 'x', project: 'NENE' } },
    ].map(line),
    proposals: [{ ...frame, state: 'done', closedAt: T0 + 120_000 }],
  },
]

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) // PW_CHANNEL=chrome = the installed Chrome
const shots = []
for (const theme of ['light', 'dark']) {
  await fetch(`${BASE}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme, language: 'ja' }) })
  for (const s of STATES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'ja-JP' })
    await page.addInitScript(() => {
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('og.assistant.expanded', '1')
      window.EventSource = class {
        constructor() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }), 50) }
        close() {} addEventListener() {}
      }
    })
    await page.route('**/api/phone-link/assistant/log', (r) => r.fulfill({ json: { entries: s.entries, name: NAME, look: 'verm', logDays: 30, memoryChars: 4000, voice: true, proposals: s.proposals } }))
    await page.route('**/api/phone-link/assistant/warm', (r) => r.fulfill({ json: { ok: true } }))
    await page.goto(BASE + '/')
    await page.getByRole('button', { name: NAME }).first().click()
    await page.waitForTimeout(900)
    const file = join(OUT, `${theme}-${s.name}.png`)
    await page.locator('section[data-og-assistant]').screenshot({ path: file })
    shots.push(file)
    await page.close()
  }
}
await browser.close()
console.log(shots.join('\n'))

if (TASK && PROJECT) {
  const APP = 'http://127.0.0.1:47776'
  const q = `path=${encodeURIComponent(PROJECT)}`
  const api = async (method, url, body) => {
    const r = await fetch(APP + url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  const attachments = []
  for (const file of shots) {
    const { status, json } = await api('POST', '/api/project/task-asset', { path: PROJECT, name: `assistant-${basename(file)}`, mime: 'image/png', dataBase64: readFileSync(file).toString('base64') })
    if (status !== 200 || !json?.id) throw new Error(`upload failed (${status}): ${JSON.stringify(json)}`)
    attachments.push(json)
  }
  let attached = false
  for (let attempt = 0; attempt < 5 && !attached; attempt++) {
    const { json: data } = await api('GET', `/api/project?${q}`)
    const card = data?.tasks?.find((t) => t.id === TASK)
    if (!card) throw new Error(`card not found: ${TASK}`)
    const have = new Set((card.attachments ?? []).map((a) => a.id))
    card.attachments = [...(card.attachments ?? []), ...attachments.filter((a) => !have.has(a.id))]
    attached = (await api('PUT', `/api/project?${q}`, data)).status !== 409
  }
  if (!attached) throw new Error('could not attach (the board kept changing) — the PNGs are in ' + OUT)
  console.log(`attached ${attachments.length} to card ${TASK}`)
}
