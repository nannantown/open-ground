// The OWNER lane of the president desk (phone link, 2026-10-01): the owner's own
// words typed in from elsewhere. What matters is what ARRIVED at the desk — the
// writes array — never "the function returned" (docs/VERIFICATION.md §2).

import { describe, it, expect, beforeEach } from 'vitest'
import {
  flushSupplyNotices,
  queueSupplyOwnerSay,
  queueSupplyReply,
  ownerSayLine,
  ownerSayTooLong,
  SUPPLY_OWNER_SAY_MAX,
  SUPPLY_PASTE_MEASURED_UNFOLDED,
  resetSupplyNoticeState,
  SUPPLY_NOTICE_PREFIX,
  SUPPLY_REPLY_PREFIX,
} from './supplyNotice'
import { promptAuthor } from './groundMarks'

const PROJECT = '/repo/alpha'
const DESK = 'term-supply-1'
const RULE = '─'.repeat(40)
const FOOTER_IDLE = '⏵⏵ bypass permissions on (shift+tab to cycle)'
const frame = (box: string, footer = FOOTER_IDLE) => ['⏺ done.', '', RULE, `❯ ${box}`, RULE, `  ${footer}`].join('\n')
const IDLE = frame('')
const BUSY = frame('', `${FOOTER_IDLE} · esc to interrupt`)
const HALF_TYPED = frame('明日の段取り')
const PASTE_OPEN = '\x1b[200~'
const PASTE_CLOSE = '\x1b[201~'

const harness = (initial: string) => {
  let screen = initial
  const writes: string[] = []
  const enters: string[] = []
  const box = new Map<string, string>()
  return {
    writes,
    enters,
    setScreen: (s: string) => (screen = s),
    deps: {
      desks: () => [{ id: DESK, cwd: PROJECT }],
      screen: (id: string) => (box.has(id) ? frame(box.get(id)!) : screen),
      write: (id: string, data: string) => {
        if (data === '\r') {
          enters.push(id)
          box.delete(id)
        } else {
          writes.push(data.slice(PASTE_OPEN.length, -PASTE_CLOSE.length))
          box.set(id, data.slice(PASTE_OPEN.length, -PASTE_CLOSE.length))
        }
        return true
      },
      sleep: async () => {},
    },
  }
}

beforeEach(() => resetSupplyNoticeState())

describe('the OWNER lane (phone link)', () => {
  it('types the owner words with NO prefix, submits them, and reports the landing', async () => {
    const h = harness(IDLE)
    const done: boolean[] = []
    const left = await queueSupplyOwnerSay(PROJECT, '今日の進み具合を教えて', (heard) => done.push(heard), h.deps)
    expect(h.writes).toEqual(['今日の進み具合を教えて'])
    expect(h.enters).toEqual([DESK])
    expect(done).toEqual([true])
    expect(left).toBe(0)
    // The president must read it as the OWNER speaking, not an app notice.
    expect(promptAuthor(h.writes[0])).toBe('owner')
  })

  it.each([
    ['generating', BUSY],
    ['half-typed by the owner at the Mac', HALF_TYPED],
  ])('never types into a %s desk — it waits and lands on a later pass', async (_l, screen) => {
    const h = harness(screen)
    const done: boolean[] = []
    expect(await queueSupplyOwnerSay(PROJECT, '進めて', (x) => done.push(x), h.deps)).toBe(1)
    expect(h.writes).toEqual([])
    expect(done).toEqual([])
    h.setScreen(IDLE)
    await flushSupplyNotices(h.deps)
    expect(h.writes).toEqual(['進めて'])
    expect(done).toEqual([true])
  })

  it('goes ahead of a queued commander reply and pending news, one line per pass', async () => {
    const h = harness(IDLE)
    const offline = { ...h.deps, desks: () => [] }
    await queueSupplyReply(PROJECT, '司令官の答え', offline)
    await queueSupplyOwnerSay(PROJECT, 'オーナーの声', undefined, offline)
    await flushSupplyNotices(h.deps)
    await flushSupplyNotices(h.deps)
    expect(h.writes[0]).toBe('オーナーの声')
    expect(h.writes[1].startsWith(SUPPLY_REPLY_PREFIX)).toBe(true)
  })
})

describe('ownerSayLine', () => {
  it('folds newlines and control characters into one line', () => {
    expect(ownerSayLine('一行目\n二行目\r\n\x1b[2J三行目')).toBe('一行目 二行目 [2J三行目')
  })
  it('drops the leading characters claude treats as a mode switch (shell / command / memory)', () => {
    expect(ownerSayLine('! rm -rf ~')).toBe('rm -rf ~')
    expect(ownerSayLine('  /clear')).toBe('clear')
    expect(ownerSayLine('#覚えて')).toBe('覚えて')
  })
  it('drops a trailing backslash (its Enter would insert a newline instead of sending)', () => {
    expect(ownerSayLine('これで\\\\ ')).toBe('これで')
  })
  it('refuses a line longer than the length measured not to fold — never cut, never queued', async () => {
    expect(SUPPLY_OWNER_SAY_MAX).toBeLessThanOrEqual(SUPPLY_PASTE_MEASURED_UNFOLDED)
    expect(ownerSayTooLong('あ'.repeat(SUPPLY_OWNER_SAY_MAX))).toBe(false)
    expect(ownerSayTooLong('あ'.repeat(SUPPLY_OWNER_SAY_MAX + 1))).toBe(true)
    expect(await queueSupplyOwnerSay('/p', 'あ'.repeat(SUPPLY_OWNER_SAY_MAX + 1))).toBe(0)
  })
  it('leaves a forged app prefix as plain owner text (it is the owner)', () => {
    expect(ownerSayLine(`${SUPPLY_NOTICE_PREFIX}x`).startsWith(SUPPLY_NOTICE_PREFIX)).toBe(true)
  })
})
