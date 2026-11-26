import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// The assistant's character floats over the screen and the layout never moves
// for it (assistant-corner.spec.ts) — so a terminal whose corner it covers
// moves its own text out from under it (owner 2026-11-20: the character hid
// Claude Code's "Update installed · Restart to update" and the end of the
// input box on the president's seat). Measured on the REAL layout (Chromium,
// the built CSS, xterm's own fit): jsdom lays nothing out. Every desk response
// is a browser fixture — no agent, no subscription, nothing is sent.

const W = 1280
const H = 800
const DESK = 'pty-fixture-president'
/** The president on the SDK: a chat (SwarmSupplyPane) instead of a terminal. */
const PRESIDENT = 'sdk-fixture-president'
const MANAGER = 'sdk-fixture-manager'
const WORKER = 'sdk-fixture-worker'
const NOTICE = 'Update installed · Restart to update'
/** A conversation long enough to scroll, every line reaching the seat's right
 *  edge — ending the way a desk mid-turn does, on a tool row: a button as wide
 *  as the seat, so its end is in the corner whatever the words above it do. */
const TALK = [
  ...Array.from({ length: 14 }, (_, i) => ({ seq: i + 1, ev: { kind: 'text', text: `${i + 1} ${'進捗を確認しました。'.repeat(10)}` } })),
  { seq: 15, ev: { kind: 'tool_use', name: 'Bash', detail: 'npm test' } },
]

/** Claude Code's last rows — the input box and, right-aligned on the bottom
 *  row, the update notice — drawn without knowing the grid's size: autowrap
 *  is off and every position is taken from the bottom-right corner (999;999
 *  clamps to the last row / column). */
const at = (up: number, col: 1 | 999) => `\x1b[999;${col}H${up ? `\x1b[${up}A` : ''}`
const TUI = [
  '\x1b[?7l\x1b[2J\x1b[H',
  ' 何から進めましょうか。',
  `${at(3, 1)}╭${'─'.repeat(600)}${at(3, 999)}╮`,
  `${at(2, 1)}│ > ${at(2, 999)}│`,
  `${at(1, 1)}╰${'─'.repeat(600)}${at(1, 999)}╯`,
  `${at(0, 1)}  ? for shortcuts${at(0, 999)}\x1b[${NOTICE.length - 1}D${NOTICE}`,
].join('')

type Theme = 'light' | 'dark'
interface Scene {
  theme: Theme
  tab?: 'board' | 'canvas' | 'terminal' | 'research'
  /** The character's dragged spot (px from the window's right / bottom); unset = never dragged. */
  pos?: { right: number; bottom: number }
  /** Seats open beside the president's (the rest are icons on the rail). */
  seats?: string[]
  /** Give the project a president's desk (a terminal fixture). */
  desk?: boolean
  /** Give the project a president on the SDK — its seat is a chat. */
  presidentChat?: boolean
  /** Give the project a live manager with a conversation (a chat-style seat). */
  manager?: boolean
  /** Workers on the roster — folded, so icons on the rail. */
  workers?: number
  /** Every worker's seat is open, and the last worker is a live one with a conversation. */
  openWorker?: boolean
}

const setup = async (page: Page, request: APIRequestContext, o: Scene) => {
  const project = await createAndImportProject(request, 'assistant-room')
  const resized: { cols: number; rows: number }[] = []
  await page.setViewportSize({ width: W, height: H })
  await page.route('**/api/experiments', (r) =>
    r.fulfill({ json: { eligible: true, assistantEligible: true, flags: { swarm: true, sandbox: false }, swarmOptIn: { available: true, enabled: true } } }),
  )
  await page.route('**/api/phone-link/assistant/log', (r) =>
    r.fulfill({ json: { entries: [], name: 'ノノ', look: 'verm', logDays: 30, memoryChars: 4000, voice: true, proposals: [] } }),
  )
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: { ok: true } })
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), theme: o.theme, swarmOptIn: true, swarmProvider: 'claude' } })
  })
  await page.route('**/api/projects', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    await route.fulfill({ response, json: { ...data, settings: { ...data.settings, theme: o.theme, swarmOptIn: true, swarmProvider: 'claude' } } })
  })
  await page.route('**/api/swarm/orchestrator?*', (r) => r.fulfill({ json: { running: false, workers: [] } }))
  await page.route('**/api/swarm/orchestrator/drain-tick', (r) => r.fulfill({ json: { running: false, workers: [] } }))
  const workers = Array.from({ length: o.workers ?? 0 }, (_, i) => ({
    worktree: `${project.path}/.fixture-worktrees/${i + 1}`,
    branch: `swarm/fixture-${i + 1}`,
    ...(o.openWorker && i + 1 === o.workers ? { terminalId: '', runtime: 'sdk', sdkSessionId: WORKER } : { terminalId: `pty-fixture-worker-${i + 1}` }),
    taskTitle: `fixture job ${i + 1}`,
  }))
  const seats = [...(o.seats ?? []), ...(o.openWorker ? workers.map((w) => w.worktree) : [])]
  await page.route('**/api/swarm/workers?*', (r) => r.fulfill({ json: { workers } }))
  await page.route('**/api/swarm/preflight?*', (r) => r.fulfill({ json: { issues: [] } }))
  await page.route('**/api/swarm/escalations?*', (r) => r.fulfill({ json: { escalations: [] } }))
  await page.route('**/api/phone-link/call-notes?*', (r) => r.fulfill({ json: { entries: [] } }))
  const talkers = [...(o.presidentChat ? [PRESIDENT] : []), ...(o.manager ? [MANAGER] : []), ...(o.openWorker ? [WORKER] : [])]
  if (o.presidentChat) {
    // (the president's chat reads its history, status and draft as the owner)
    await page.route('**/api/auth/session', (r) => r.fulfill({ json: { user: { id: 'fixture-owner', email: 'owner@example.test' } } }))
    await page.route('**/api/chatgpt/status', (r) => r.fulfill({ json: { connection: { state: 'signed-out', models: [] }, preferences: { swarmProvider: 'claude' } } }))
    await page.route('**/api/conversation/president/history?*', (r) =>
      r.fulfill({ json: { lines: TALK.filter((f) => f.ev.kind === 'text').slice(-4).map((f) => f.ev), revision: '1', overflow: false, seq: TALK.length } }),
    )
    await page.route('**/api/conversation/president/status?*', (r) =>
      r.fulfill({
        json: {
          state: 'delivered',
          conversationId: 'fixture-conversation',
          epoch: 1,
          runtime: { scope: 'swarm', revision: 1, phase: 'stable', effective: { provider: 'claude' }, desired: { provider: 'claude' }, updatedAt: '2026-11-05T00:00:00.000Z' },
          capabilities: { conversationControl: 1, cancelPresidentInputs: 1 },
        },
      }),
    )
    await page.route('**/api/conversation/draft?*', (r) => r.fulfill({ json: { revision: 0, text: '', updatedAt: '2026-11-05T00:00:00.000Z' } }))
  }
  const live = [...(o.desk ? [DESK] : []), ...talkers]
  if (live.length) {
    await page.route('**/api/terminal/active', (r) =>
      r.fulfill({ json: { cwds: [], claude: live.map((id) => ({ id, cwd: project.path, status: 'working', desk: id !== WORKER })) } }),
    )
  }
  for (const id of talkers) {
    await page.route(`**/api/sdk-session/${id}?*`, (r) => r.fulfill({ json: { status: 'working' } }))
    // (registered after the status route: the later route wins)
    await page.route(`**/api/sdk-session/${id}/tail?*`, (r) => {
      const after = Number(new URL(r.request().url()).searchParams.get('after') ?? 0)
      return r.fulfill({ json: { frames: TALK.filter((f) => f.seq > after) } })
    })
    // A worker's opened log reads the same talk as a stream.
    await page.route(`**/api/sdk-session/${id}/stream?*`, (r) =>
      r.fulfill({
        headers: { 'Content-Type': 'text/event-stream' },
        body: `event: init\ndata: ${JSON.stringify({ session: { status: 'working' }, truncated: false, replay: TALK })}\n\n`,
      }),
    )
  }
  if (o.desk) {
    await page.route(`**/api/terminal/${DESK}`, (r) =>
      r.fulfill({ json: { id: DESK, cwd: project.path, cols: 80, rows: 24, tag: 'claude', agentSessionId: 'fixture-claude', createdAt: Date.now(), finishedAt: null } }),
    )
    await page.route(`**/api/terminal/${DESK}/stream`, (r) =>
      r.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: `event: init\ndata: ${JSON.stringify({ replay: TUI })}\n\n` }),
    )
    await page.route(`**/api/terminal/${DESK}/resize`, (r) => {
      resized.push(r.request().postDataJSON())
      return r.fulfill({ json: { ok: true } })
    })
    await page.route(`**/api/terminal/${DESK}/input`, (r) => r.fulfill({ json: { ok: true } }))
  }
  await page.addInitScript(
    ({ projectId, o, seats, desk, president, manager }) => {
      if (o.manager)
        localStorage.setItem(
          `openground.swarm.manager.${projectId}`,
          JSON.stringify({ terminalId: '', runtime: 'sdk', sdkSessionId: manager, agentSessionId: '', startedAt: '2026-11-05T00:00:00.000Z' }),
        )
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('og-lang', 'ja')
      localStorage.setItem('og-theme', o.theme)
      localStorage.setItem('openground.view', JSON.stringify({ projectId, panelTab: o.tab ?? 'board' }))
      if (o.pos) localStorage.setItem('og.assistant.pos', JSON.stringify(o.pos))
      else localStorage.removeItem('og.assistant.pos')
      if (seats.length) localStorage.setItem(`openground.swarmseats.${projectId}`, JSON.stringify(seats))
      if (o.desk)
        localStorage.setItem(
          `openground.swarm.supply.${projectId}`,
          JSON.stringify({ terminalId: desk, runtime: 'pty', agentSessionId: '', startedAt: '2026-11-05T00:00:00.000Z' }),
        )
      if (o.presidentChat)
        localStorage.setItem(
          `openground.swarm.supply.${projectId}`,
          JSON.stringify({ terminalId: '', runtime: 'sdk', sdkSessionId: president, agentSessionId: '', startedAt: '2026-11-05T00:00:00.000Z' }),
        )
    },
    { projectId: project.id, o, seats, desk: DESK, president: PRESIDENT, manager: MANAGER },
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  if (o.theme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  else await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
  const character = page.getByRole('button', { name: 'ノノ' })
  await expect(character).toBeVisible()
  return { project, character, resized }
}

const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

/** The president's terminal, as laid out: the grid xterm drew (`screen`), the
 *  box it lives in (`viewport`) and the character. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const screen = document.querySelector('[data-seat-key="supply"] .xterm-screen')!
    return {
      screen: box(screen),
      viewport: box(screen.closest('.xterm')!.parentElement!.parentElement!),
      character: box(document.querySelector('button[aria-haspopup="dialog"][aria-label="ノノ"]')!),
    }
  })

type Box = { left: number; top: number; right: number; bottom: number }
const meet = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/** What of `scope` is drawn under the character, as laid out: its words (cut
 *  the way the boxes around them cut them — a scrolled-away line is not drawn)
 *  and its controls. */
const covered = (page: Page, scope: string) =>
  page.evaluate((scope) => {
    type B = { left: number; top: number; right: number; bottom: number }
    const cut = (a: B, b: B): B => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) })
    // (2px: a screen-reader-only label is a 1px box)
    const drawn = (r: B) => r.right - r.left > 2 && r.bottom - r.top > 2
    const visible = (el: Element | null, r: B): B => {
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') r = cut(r, p.getBoundingClientRect())
      }
      return r
    }
    const c = document.querySelector('button[aria-haspopup="dialog"][aria-label="ノノ"]')!.getBoundingClientRect()
    const root = document.querySelector(scope)!
    const at = (r: B) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right - r.left)}x${Math.round(r.bottom - r.top)}`
    const out: string[] = []
    const texts = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = texts.nextNode(); n; n = texts.nextNode()) {
      if (!n.textContent?.trim()) continue
      range.selectNodeContents(n)
      for (const r of Array.from(range.getClientRects()))
        if (drawn(cut(visible(n.parentElement, r), c))) out.push(`"${n.textContent.trim().slice(0, 16)}" ${at(r)}`)
    }
    for (const el of Array.from(root.querySelectorAll('button, input, textarea'))) {
      const r = el.getBoundingClientRect()
      if (drawn(cut(visible(el.parentElement, r), c))) out.push(`${el.tagName.toLowerCase()} ${at(r)}`)
    }
    return out
  }, scope)

/** Where the character is over `scope`'s box: wholly on it, partly, or not at all. */
const characterOn = (page: Page, scope: string) =>
  page.evaluate((scope) => {
    const c = document.querySelector('button[aria-haspopup="dialog"][aria-label="ノノ"]')!.getBoundingClientRect()
    const r = document.querySelector(scope)!.getBoundingClientRect()
    if (c.left >= r.left && c.right <= r.right && c.top >= r.top && c.bottom <= r.bottom) return 'on'
    return c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top ? 'partly' : 'off'
  }, scope)

/** Scroll the row `scope` sits in — the nearest box around it that overflows
 *  sideways — to one end. False when no box around it overflows. */
const scrollRow = (page: Page, scope: string, to: 'start' | 'end') =>
  page.evaluate(
    ([scope, to]) => {
      let row = document.querySelector(scope)!.parentElement
      while (row && !(row.scrollWidth > row.clientWidth + 1 && getComputedStyle(row).overflowX !== 'visible')) row = row.parentElement
      if (row) row.scrollLeft = to === 'end' ? row.scrollWidth : 0
      return !!row
    },
    [scope, to] as const,
  )

const openPresident = async (page: Page) => {
  const connected = page.waitForResponse((r) => r.url().endsWith(`/api/terminal/${DESK}/stream`))
  await page.getByTestId('swarm-bar-toggle').click()
  await connected
  await expect(page.locator('[data-seat-key="supply"] .xterm-screen')).toBeVisible()
  // xterm fits on a timer after its box settles.
  await page.waitForTimeout(400)
  await settle(page)
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: the president's terminal keeps its last rows out from under the character`, async ({ page, request }, info) => {
    // The owner's screen: the character dragged a little in from the icon
    // rail, onto the corner of the president's terminal.
    const { resized } = await setup(page, request, { theme, desk: true, pos: { right: 96, bottom: 18 } })
    await openPresident(page)
    // (polled: the grid re-fits a beat after the viewport makes the room)
    await expect.poll(async () => {
      const now = await measure(page)
      return meet(now.screen, now.character)
    }).toBe(false)
    const m = await measure(page)
    // …by giving up columns, not rows: the grid still ends within one row of
    // the viewport's bottom (8px is the viewport's own padding).
    const rows = resized.at(-1)?.rows ?? 0
    expect(rows).toBeGreaterThan(0)
    expect(m.viewport.bottom - 8 - m.screen.bottom).toBeLessThan(m.screen.height / rows)
    await page.screenshot({ path: info.outputPath(`president-${theme}.png`), animations: 'disabled' })
  })

  test(`${theme}: at its default spot the character sits on the icon rail, off the president's terminal`, async ({ page, request }, info) => {
    await setup(page, request, { theme, desk: true })
    await openPresident(page)
    const m = await measure(page)
    expect(meet(m.screen, m.character), JSON.stringify(m)).toBe(false)
    await page.screenshot({ path: info.outputPath(`president-default-${theme}.png`), animations: 'disabled' })
  })

  test(`${theme}: the president's chat keeps its send box out from under the character dragged onto it`, async ({ page, request }, info) => {
    // The president on the SDK talks in a chat whose send card is centred —
    // the owner drags the character onto that card's send-button end.
    const { character } = await setup(page, request, { theme, presidentChat: true })
    await page.getByTestId('swarm-bar-toggle').click()
    const SEAT = '[data-seat-key="supply"]'
    const CARD = `${SEAT} [data-president-composer] > div:has(textarea)`
    await expect(page.locator(SEAT).getByRole('textbox', { name: '社長に話す' })).toBeVisible()
    await settle(page)
    const c = (await character.boundingBox())!
    const card = (await page.locator(CARD).boundingBox())!
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
    await page.mouse.down()
    await page.mouse.move(card.x + card.width - 40, card.y + card.height - 30, { steps: 8 })
    await page.mouse.up()
    await settle(page)
    // (the character is over the card at all — or the check below says nothing)
    expect(await characterOn(page, CARD)).not.toBe('off')
    await expect.poll(() => covered(page, SEAT)).toEqual([])
    await page.screenshot({ path: info.outputPath(`president-chat-${theme}.png`), animations: 'disabled' })
  })

  test(`${theme}: the president's chat keeps its text field whole with the character on the card's left end`, async ({ page, request }, info) => {
    // review ab3-R1: dragged here, the card used to give its whole width up as
    // room — the text field went to 0px and the send button slid under the
    // character. Now it lifts what is in it above the character instead.
    const { character } = await setup(page, request, { theme, presidentChat: true })
    await page.getByTestId('swarm-bar-toggle').click()
    const SEAT = '[data-seat-key="supply"]'
    const CARD = `${SEAT} [data-president-composer] > div:has(textarea)`
    const field = page.locator(SEAT).getByRole('textbox', { name: '社長に話す' })
    await expect(field).toBeVisible()
    await settle(page)
    const width = (await field.boundingBox())!.width
    const c = (await character.boundingBox())!
    const card = (await page.locator(CARD).boundingBox())!
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
    await page.mouse.down()
    await page.mouse.move(card.x + 30, card.y + card.height - 20, { steps: 12 })
    await page.mouse.up()
    await settle(page)
    expect(await characterOn(page, CARD)).not.toBe('off')
    await expect.poll(() => covered(page, SEAT)).toEqual([])
    expect((await field.boundingBox())!.width).toBe(width)
    const seat = (await page.locator(SEAT).boundingBox())!
    const after = (await page.locator(CARD).boundingBox())!
    expect(after.x + after.width).toBeLessThanOrEqual(seat.x + seat.width)
    await page.screenshot({ path: info.outputPath(`president-chat-left-${theme}.png`), animations: 'disabled' })
  })

  test(`${theme}: the manager's send box keeps its words whole with the character on its left end`, async ({ page, request }, info) => {
    // review ab3-R1: here the closed row broke its link one letter a line, and
    // the opened box crushed its text field to a sliver.
    const { character } = await setup(page, request, { theme, manager: true, seats: ['manager'] })
    await page.getByTestId('swarm-bar-toggle').click()
    const SEAT = '[data-seat="manager"]'
    const say = page.locator(`${SEAT} [data-seat-say]`)
    await expect(page.locator(`${SEAT} [data-seat-feed]`)).toContainText('14 進捗')
    await settle(page)
    const row = (await say.boundingBox())!
    const link = (await say.locator('button').first().boundingBox())!
    const c = (await character.boundingBox())!
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
    await page.mouse.down()
    await page.mouse.move(row.x + 20, row.y + row.height / 2, { steps: 12 })
    await page.mouse.up()
    await settle(page)
    expect(await characterOn(page, `${SEAT} [data-seat-say]`)).not.toBe('off')
    await expect.poll(() => covered(page, SEAT)).toEqual([])
    // still one line
    expect((await say.locator('button').first().boundingBox())!.height).toBe(link.height)
    // opened: the text field keeps the box's width
    await say.locator('button').first().click()
    await expect(say.locator('textarea')).toBeVisible()
    await settle(page)
    await expect.poll(() => covered(page, SEAT)).toEqual([])
    expect((await say.locator('textarea').boundingBox())!.width).toBeGreaterThan(row.width * 0.9)
    // the talk above, squeezed by the lifted box, still ends on its newest line
    await expect.poll(() => page.locator(`${SEAT} [data-seat-feed] > div`).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2)
    await page.screenshot({ path: info.outputPath(`manager-left-${theme}.png`), animations: 'disabled' })
  })

  test(`${theme}: the manager's seat keeps its words and its send box out from under the character`, async ({ page, request }, info) => {
    // A chat-style seat (the manager's, every SDK worker's): a scrolling
    // conversation over a "send a word" box whose button ends the row.
    await setup(page, request, { theme, manager: true, seats: ['manager'], pos: { right: 96, bottom: 18 } })
    await page.getByTestId('swarm-bar-toggle').click()
    const seat = page.locator('[data-seat="manager"]')
    await expect(seat.locator('[data-seat-feed]')).toContainText('14 進捗')
    await settle(page)
    // The words: every line drawn in the conversation's box, as laid out.
    const wordsUnder = () =>
      page.evaluate(() => {
        const c = document.querySelector('button[aria-haspopup="dialog"][aria-label="ノノ"]')!.getBoundingClientRect()
        const feed = document.querySelector('[data-seat="manager"] [data-seat-feed] > div')!
        const port = feed.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(feed)
        return Array.from(range.getClientRects())
          .filter((r) => r.width > 0 && r.bottom > port.top && r.top < port.bottom)
          .filter((r) => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top)
          .map((r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`)
      })
    expect(await wordsUnder()).toEqual([])
    // The send box, opened: its text field and both buttons.
    await seat.locator('[data-seat-say] button').first().click()
    await expect(seat.locator('[data-seat-say] textarea')).toBeVisible()
    await settle(page)
    const boxUnder = await page.evaluate(() => {
      const c = document.querySelector('button[aria-haspopup="dialog"][aria-label="ノノ"]')!.getBoundingClientRect()
      return Array.from(document.querySelectorAll('[data-seat="manager"] [data-seat-say] :is(textarea, button)'))
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top)
        .map(({ el, r }) => `${el.tagName.toLowerCase()} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`)
    })
    expect(boxUnder).toEqual([])
    expect(await wordsUnder()).toEqual([])
    await page.screenshot({ path: info.outputPath(`manager-${theme}.png`), animations: 'disabled' })
  })

  test(`${theme}: with every seat open, the last one keeps its words and buttons out from under the character`, async ({ page, request }, info) => {
    // No seat folded → no icon rail: the last seat reaches the window's
    // corner, where the character rests when it was never dragged.
    await setup(page, request, { theme, workers: 1, openWorker: true, seats: ['manager'] })
    await page.getByTestId('swarm-bar-toggle').click()
    const SEAT = '[data-seat-key$="/.fixture-worktrees/1"]'
    const seat = page.locator(SEAT)
    await expect(page.locator('[data-seat-rail]')).toHaveCount(0)
    await expect(seat.locator('[data-seat-feed]')).toContainText('14 進捗')
    await settle(page)
    // (the character is over this seat at all — or the check below says nothing)
    expect(await characterOn(page, SEAT)).toBe('on')
    expect(await covered(page, SEAT)).toEqual([])
    // The send box, opened: a text field as wide as the seat, its buttons at the end.
    await seat.locator('[data-seat-say] button').first().click()
    await expect(seat.locator('[data-seat-say] textarea')).toBeVisible()
    await settle(page)
    expect(await covered(page, SEAT)).toEqual([])
    await page.screenshot({ path: info.outputPath(`worker-${theme}.png`), animations: 'disabled' })
    // Its work, opened: the whole transcript over a one-line input row.
    await seat.getByRole('button', { name: '作業の様子を見る' }).click()
    await expect(seat.getByPlaceholder('この worker に話しかける…')).toBeVisible()
    await expect(seat.getByRole('button', { name: /npm test/ })).toBeVisible()
    await settle(page)
    expect(await characterOn(page, SEAT)).toBe('on')
    expect(await covered(page, SEAT)).toEqual([])
    await page.screenshot({ path: info.outputPath(`worker-log-${theme}.png`), animations: 'disabled' })
  })

  test(`${theme}: a seat scrolled in under the character makes its room then`, async ({ page, request }, info) => {
    // More open seats than the window is wide: the row scrolls sideways, and a
    // seat arrives under the character without changing size.
    await setup(page, request, { theme, workers: 4, openWorker: true, seats: ['manager'] })
    await page.getByTestId('swarm-bar-toggle').click()
    const SEAT = '[data-seat-key$="/.fixture-worktrees/4"]'
    const seat = page.locator(SEAT)
    // Its send box is open (not a real click: the seat is off to the right)…
    await seat.locator('[data-seat-say] button').first().dispatchEvent('click')
    await expect(seat.locator('[data-seat-say] textarea')).toBeAttached()
    // …and everything was last measured with the seat out there, clear of the character.
    expect(await scrollRow(page, SEAT, 'start')).toBe(true)
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await settle(page)
    expect(await characterOn(page, SEAT)).toBe('off')
    await scrollRow(page, SEAT, 'end')
    await expect.poll(() => characterOn(page, SEAT)).toBe('on')
    await expect.poll(() => covered(page, SEAT)).toEqual([])
    await page.screenshot({ path: info.outputPath(`scrolled-${theme}.png`), animations: 'disabled' })
  })

  test(`${theme}: the icon rail's last seat scrolls out from under the character`, async ({ page, request }, info) => {
    // More folded seats than the rail is tall: the character rests on its foot.
    await setup(page, request, { theme, workers: 6 })
    await page.getByTestId('swarm-bar-toggle').click()
    const last = page.locator('[data-seat-rail] [data-rail-seat]').last()
    await expect(last).toBeAttached()
    await settle(page)
    const under = await page.evaluate(() => {
      const c = document.querySelector('button[aria-haspopup="dialog"][aria-label="ノノ"]')!.getBoundingClientRect()
      const rail = document.querySelector('[data-seat-rail]')!
      rail.scrollTop = rail.scrollHeight
      const seats = rail.querySelectorAll('[data-rail-seat]')
      const r = seats[seats.length - 1].getBoundingClientRect()
      return { seats: seats.length, meets: r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top, onRail: c.left >= rail.getBoundingClientRect().left }
    })
    expect(under).toEqual({ seats: 7, meets: false, onRail: true })
    await page.screenshot({ path: info.outputPath(`rail-${theme}.png`), animations: 'disabled' })
  })

  test(`${theme}: canvas — dragging the character up the right edge does not carry the undo/redo pair along`, async ({ page, request }, info) => {
    // commander 2026-11-24: measured with the room it had been given, the pair
    // stepped up with the character all the way — over the zoom readout and
    // off the canvas — while a fresh load at the same spot left it at home.
    const { character } = await setup(page, request, { theme, tab: 'canvas' })
    const undo = page.getByRole('button', { name: '元に戻す (⌘Z)' })
    await expect(undo).toBeVisible()
    await settle(page)
    const c = (await character.boundingBox())!
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
    await page.mouse.down()
    await page.mouse.move(c.x + c.width / 2, 140, { steps: 30 })
    await page.mouse.up()
    await settle(page)
    // Well clear of its corner now: the pair is at home, as on a fresh load here.
    const pair = undo.locator('xpath=..')
    expect(await pair.locator('xpath=..').evaluate((el) => getComputedStyle(el).paddingBottom)).toBe('0px')
    const p = (await pair.boundingBox())!
    // (the zoom readout: its name is the percentage it shows, its title says what it does)
    const fit = (await page.getByTitle('全体を表示 (⇧1)').boundingBox())!
    expect(meet({ left: p.x, top: p.y, right: p.x + p.width, bottom: p.y + p.height }, { left: fit.x, top: fit.y, right: fit.x + fit.width, bottom: fit.y + fit.height })).toBe(false)
    await page.screenshot({ path: info.outputPath(`canvas-dragged-${theme}.png`), animations: 'disabled' })
  })

  for (const tab of ['board', 'canvas', 'terminal', 'research'] as const) {
    test(`${theme}: ${tab} — no control sits under the character`, async ({ page, request }, info) => {
      const { character } = await setup(page, request, { theme, tab })
      await page.waitForTimeout(tab === 'terminal' ? 1500 : 600)
      await settle(page)
      const under = await character.evaluate((c) => {
        const cr = c.getBoundingClientRect()
        const meets = (el: Element) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && r.left < cr.right && r.right > cr.left && r.top < cr.bottom && r.bottom > cr.top
        }
        return Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="tab"], [role="slider"]'))
          .filter((el) => el !== c && !c.contains(el) && meets(el))
          .map((el) => {
            const r = el.getBoundingClientRect()
            return `${el.tagName.toLowerCase()} "${el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('data-testid') ?? (el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
          })
      })
      await page.screenshot({ path: info.outputPath(`${tab}-${theme}.png`), animations: 'disabled' })
      expect(under).toEqual([])
    })
  }
}
