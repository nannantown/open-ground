import { test, expect, type Page } from '@playwright/test'

// The assistant's proposal frame in the floating window, measured on the REAL
// layout (Chromium, the built CSS) — jsdom does no flex layout, so this is the
// only place a frame cut by a pixel or two can be seen (rework 2, 2026-10-06:
// with a long talk the talk list and the frames shared the shrink by their sizes,
// the frames lost ~2 px and 「出す」 went grey). The window's records are stubbed;
// nothing here reaches the assistant.

const card = {
  id: 'p1', kind: 'card', projectId: 'x', project: 'kiwi-shop', title: '送料を500円にする',
  body: 'やること: 送料を一律500円に変更する\n完了の条件:\n- チェックアウトで送料が500円\n- テストが緑',
  at: 1, expiresAt: Date.now() + 600_000, state: 'open', via: 'screen',
}
/** About `px` of talk once laid out (each line ~3 rows of text). */
const talk = (px: number) =>
  Array.from({ length: Math.ceil(px / 70) }, (_, i) => ({
    id: `l${i}`, at: i + 1, who: i % 2 ? 'assistant' : 'owner', via: 'screen',
    text: '商品ページの画像を軽くする話の続きで、表示が遅いページを順番に見ていこう。'.repeat(2),
  }))

/** `after`: the proposals the log holds once a line was said (a card made by that line). */
const open = async (page: Page, o: { entries: unknown[]; proposals: unknown[]; after?: unknown[]; call?: boolean; folded?: boolean; height?: number }) => {
  let said = false
  await page.addInitScript((folded) => {
    localStorage.setItem('openground:onboarded', '1')
    localStorage.setItem('og.assistant.expanded', folded ? '0' : '1')
    // The ears answer "ready" at once (no microphone here): the call as while listening.
    ;(window as unknown as { EventSource: unknown }).EventSource = class {
      onmessage?: (m: { data: string }) => void
      constructor() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }), 50) }
      close() {}
      addEventListener() {}
    }
  }, !!o.folded)
  await page.route('**/api/phone-link/assistant/log', (r) =>
    r.fulfill({ json: { entries: o.entries, name: 'ノノ', look: 'verm', logDays: 30, memoryChars: 4000, voice: true, proposals: said && o.after ? o.after : o.proposals } }),
  )
  await page.route('**/api/phone-link/assistant/warm', (r) => r.fulfill({ json: { ok: true } }))
  // A line said gets one answer (as the window's stream route answers).
  await page.route('**/api/phone-link/assistant/say', (r) => {
    said = true
    return r.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ reply: '今日は水曜日だよ。', speak: '今日は水曜日だよ。' }) + '\n' })
  })
  await page.setViewportSize({ width: 1200, height: o.height ?? 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'ノノ' }).click()
  if (o.call) await page.getByRole('button', { name: /^(Call|通話)$/ }).click()
}

/** The frame as laid out: whole inside its box, and whether 「出す」 can be pressed. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-testid="assistant-proposals"]')
    const f = box?.querySelector<HTMLElement>('[data-proposal]')
    const list = document.querySelector<HTMLElement>('[data-testid="assistant-talk"]')
    const panel = document.querySelector<HTMLElement>('section[data-og-assistant]')!
    if (!box || !f) return null
    const b = box.getBoundingClientRect()
    const r = f.getBoundingClientRect()
    return {
      frame: r.height,
      cut: Math.round((r.bottom - (b.top + box.clientHeight)) * 100) / 100,
      add: !(f.querySelectorAll('button')[1] as HTMLButtonElement).disabled,
      talk: list?.clientHeight ?? 0,
      /** Anything running out of the window (the call keys, the input). */
      spill: panel.scrollHeight - panel.clientHeight,
    }
  })

test('chat with a long talk: the talk gives way, the frame is whole and 「出す」 can be pressed', async ({ page }) => {
  await open(page, { entries: talk(1000), proposals: [card] })
  await expect(page.locator('[data-proposal]')).toBeVisible()
  await expect.poll(() => measure(page)).toMatchObject({ add: true })
  const m = (await measure(page))!
  expect(m.cut).toBeLessThanOrEqual(0)
  expect(m.frame).toBeGreaterThan(150)
  expect(m.spill).toBeLessThanOrEqual(1)
})

test('chat with no proposal: the talk still fills the window', async ({ page }) => {
  await open(page, { entries: talk(1000), proposals: [] })
  await expect(page.getByTestId('assistant-talk')).toBeVisible()
  expect(await page.getByTestId('assistant-talk').evaluate((e) => e.clientHeight)).toBeGreaterThan(250)
})

test('a call: the frame is whole above the call keys and 「出す」 can be pressed', async ({ page }) => {
  await open(page, { entries: talk(1000), proposals: [card], call: true })
  await expect(page.getByTestId('assistant-call')).toBeVisible()
  await expect.poll(() => measure(page)).toMatchObject({ add: true })
  const m = (await measure(page))!
  expect(m.cut).toBeLessThanOrEqual(0)
  expect(m.spill).toBeLessThanOrEqual(1)
})

const done = (id: string) => ({ ...card, id, state: 'done' })
const opened = (id: string, title: string) => ({ ...card, id, title })
/** The talk line holding `text` is inside the talk's visible area (not scrolled or squeezed out). */
const seen = (page: Page, text: string) =>
  page.evaluate((t) => {
    const list = document.querySelector<HTMLElement>('[data-testid="assistant-talk"]')
    const el = list && Array.from(list.querySelectorAll('p')).find((p) => p.textContent?.includes(t))
    if (!list || !el) return false
    const a = list.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.height > 0 && r.top >= a.top - 0.5 && r.bottom <= a.bottom + 0.5
  }, text)
const say = async (page: Page, text: string) => {
  await page.getByRole('textbox').last().fill(text)
  await page.getByRole('textbox').last().press('Enter')
}

// Rework 3 (2026-10-07): two or more frames — a closed one included — took the
// whole window and the talk was squeezed to 0 px: the answer was nowhere to be seen.
test('the folded window, one card added and one open: the answer is seen and the open card can be pressed', async ({ page }) => {
  await open(page, { entries: [], proposals: [done('d1'), opened('o1', '画像を軽くする')], folded: true })
  await say(page, '今日は何曜日?')
  await expect.poll(() => seen(page, '今日は水曜日だよ。')).toBe(true)
  expect(await seen(page, '今日は何曜日?')).toBe(true)
  await expect.poll(() => measure(page)).toMatchObject({ add: true })
})

test('two open cards: the newest line of the talk is still seen', async ({ page }) => {
  const entries = [...talk(1000), { id: 'last', at: 999, who: 'assistant', via: 'screen', text: '最新の答えはこれだよ。' }]
  await open(page, { entries, proposals: [opened('o1', '送料を500円にする'), opened('o2', '画像を軽くする')] })
  await expect(page.locator('[data-proposal]').first()).toBeVisible()
  await expect.poll(() => seen(page, '最新の答えはこれだよ。')).toBe(true)
})

test('closed proposals take no room from the talk', async ({ page }) => {
  await open(page, { entries: talk(1000), proposals: [done('d1'), done('d2'), { ...card, id: 'd3', state: 'expired' }] })
  await expect(page.getByTestId('assistant-talk')).toBeVisible()
  expect(await page.getByTestId('assistant-talk').evaluate((e) => e.clientHeight)).toBeGreaterThan(250)
})

test('the folded window, the largest card the server takes (10 lines) and one added: the answer is seen and the card can be pressed', async ({ page }) => {
  const largest = {
    ...card, id: 'big', title: 'う'.repeat(20),
    body: ['やること: ' + 'あ'.repeat(15), '完了の条件:', ...Array.from({ length: 6 }, () => '- ' + 'い'.repeat(19))].join('\n'),
  }
  await open(page, { entries: [], proposals: [done('d1'), largest], folded: true })
  await say(page, '今日は何曜日?')
  await expect.poll(() => seen(page, '今日は水曜日だよ。')).toBe(true)
  expect(await seen(page, '今日は何曜日?')).toBe(true)
  await expect.poll(() => measure(page)).toMatchObject({ add: true })
})

// Review of rework 3 (2026-10-07): a photo takes its height only once loaded,
// after the talk was scrolled to its end — the answer under it was pushed out of
// sight; and in a shorter window the 88 px reserve made an ordinary card unpressable.
test('a photo in the talk loads late: the answer under it is still seen, beside an open card', async ({ page }) => {
  await page.route('**/api/phone-link/assistant/photo/**', async (r) => {
    await new Promise((ok) => setTimeout(ok, 700))
    await r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="300"><rect width="120" height="300" fill="#888"/></svg>' })
  })
  const entries = [
    ...talk(400),
    { id: 'pic', at: 900, who: 'owner', via: 'screen', text: 'これ見て', photo: 'p.svg' },
    { id: 'ans', at: 901, who: 'assistant', via: 'screen', text: '写真の答えはこれだよ。' },
  ]
  await open(page, { entries, proposals: [card] })
  await expect.poll(() => page.locator('[data-testid="assistant-talk"] img').evaluate((i: HTMLImageElement) => i.complete && i.naturalHeight > 0)).toBe(true)
  await expect.poll(() => seen(page, '写真の答えはこれだよ。')).toBe(true)
  await expect.poll(() => measure(page)).toMatchObject({ add: true })
})

test('a shorter window (336 px): an ordinary card still fits whole and can be pressed — the talk gives up its reserve for it', async ({ page }) => {
  await open(page, { entries: talk(1000), proposals: [card], height: 480 })
  await expect(page.locator('[data-proposal]')).toBeVisible()
  await expect.poll(() => measure(page)).toMatchObject({ add: true })
  const m = (await measure(page))!
  expect(m.cut).toBeLessThanOrEqual(0)
  expect(m.spill).toBeLessThanOrEqual(1)
})

test('the open window with its name, a long talk, one added and the largest card: the card is whole and can be pressed, the name is not squeezed, the talk keeps what the card leaves', async ({ page }) => {
  const largest = {
    ...card, id: 'big', title: 'う'.repeat(20),
    body: ['やること: ' + 'あ'.repeat(15), '完了の条件:', ...Array.from({ length: 6 }, () => '- ' + 'い'.repeat(19))].join('\n'),
  }
  await open(page, { entries: talk(1000), proposals: [done('d1'), largest] })
  await expect(page.locator('[data-proposal="big"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => !(document.querySelectorAll<HTMLButtonElement>('[data-proposal="big"] button')[1]).disabled)).toBe(true)
  const m = await page.evaluate(() => {
    const h = document.querySelector<HTMLElement>('section[data-og-assistant] header')!
    const panel = document.querySelector<HTMLElement>('section[data-og-assistant]')!
    return {
      header: h.clientHeight, headerNeeds: h.scrollHeight,
      talk: document.querySelector<HTMLElement>('[data-testid="assistant-talk"]')!.clientHeight,
      spill: panel.scrollHeight - panel.clientHeight,
    }
  })
  expect(m.header).toBeGreaterThan(0)
  expect(m.header).toBeGreaterThanOrEqual(m.headerNeeds)
  // The card needs all but ~58 px here (a fixed 88 px reserve made it unpressable):
  // the talk keeps the rest, never squeezed to nothing.
  expect(m.talk).toBeGreaterThan(40)
  expect(m.spill).toBeLessThanOrEqual(1)
})

// Review E of rework 3 (2026-10-07): in a smaller window (the character dragged
// toward the middle) the 88 px reserve was weighed against the WHOLE box — the
// faded closed line and every open frame behind the first — so a first card that
// fits whole was cut and 「出す」 went grey. Only the first open frame counts.
test('a smaller folded window (320 px), one added then a new card after the answer: 「出す」 can be pressed', async ({ page }) => {
  await open(page, { entries: [], proposals: [done('d1')], after: [done('d1'), opened('o1', '画像を軽くする')], folded: true, height: 410 })
  await say(page, 'Bのカードも作って')
  await expect.poll(() => seen(page, '今日は水曜日だよ。')).toBe(true)
  await expect.poll(() => measure(page)).toMatchObject({ add: true })
  const m = (await measure(page))!
  expect(m.cut).toBeLessThanOrEqual(0)
  expect(m.spill).toBeLessThanOrEqual(1)
})

test('a smaller open window (360 px), two open cards: the first 「出す」 can be pressed', async ({ page }) => {
  await open(page, { entries: talk(300), proposals: [], after: [opened('o1', '送料を500円にする'), opened('o2', '画像を軽くする')], height: 450 })
  await say(page, 'AとBのカード作って')
  await expect(page.locator('[data-proposal]').first()).toBeVisible()
  await expect.poll(() => measure(page)).toMatchObject({ add: true })
  const m = (await measure(page))!
  expect(m.cut).toBeLessThanOrEqual(0)
  expect(m.spill).toBeLessThanOrEqual(1)
})
