// The engine→supply-desk notice channel (card: 司令官・エンジンからの知らせを
// タスク窓口に届ける, 2026-09-22).
//
// WHAT THESE ASSERT, AND WHY THAT SHAPE. The completion condition is "the line
// ARRIVED AT THE DESK", not "a function was callable" — a `typeof` check or a
// 200 would be satisfied by an empty implementation (docs/VERIFICATION.md §2,
// measured: kill/say/nudge all emptied and 76 tests stayed green). So every
// delivery assertion here reads the WRITES array: which terminal id was typed
// into, and exactly what text plus the submitting CR.
//
// RED MEASURED before this file was kept (2026-09-22), by severing the route in
// production and re-running:
//   • `noticeToSupply(app)` removed from createSwarmFatalNotification  → the
//     end-to-end test fails: writes stays [].
//   • `supplyNoticeFor` made to return null for 'swarm-fatal'          → same.
//   • `pending.delete(desk.cwd)` removed after a successful write      → the
//     "cleared once delivered" test fails (the line is typed twice).
//   • the busy/half-typed/menu guard removed                            → the
//     three refusal tests fail (a line lands on a generating desk).
// Restored after each.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  supplyNoticeFor,
  supplyNoticeLine,
  sanitizeSupplyNotice,
  queueSupplyNotice,
  flushSupplyNotices,
  noticeToSupply,
  peekSupplyNotices,
  resetSupplyNoticeState,
  SUPPLY_NOTICE_PREFIX,
  SUPPLY_NOTICE_MAX,
  SUPPLY_NOTICE_TTL_MS,
} from './supplyNotice'
import { buildFatalAppNotification, buildInfoAppNotification } from './swarmNotifications'
import type { AppNotification, SwarmInfoEvent } from '../types'

const PROJECT = '/repo/alpha'
const DESK = 'term-supply-1'

// ── SCREEN LITERALS ─────────────────────────────────────────────────────────
// Shaped like the frames noticeDeliverable was measured against on a live desk
// (see deskDeliverable.ts). The point of using literals is that the safety
// property is testable without a PTY.
const RULE = '\u2500'.repeat(40)
const FOOTER_IDLE = '\u23f5\u23f5 bypass permissions on (shift+tab to cycle)'
const FOOTER_BUSY = `${FOOTER_IDLE} \u00b7 esc to interrupt`
const frame = (boxText: string, footer: string) =>
  ['\u23fa done.', '', RULE, `\u276f ${boxText}`, RULE, `  ${footer}`].join('\n')

const IDLE = frame('', FOOTER_IDLE)
const BUSY = frame('', FOOTER_BUSY)
const HALF_TYPED = frame('\u660e\u65e5\u306e\u6bb5\u53d6\u308a\u3060\u3051\u3069', FOOTER_IDLE)
const MENU = ['\u23fa Select a model:', '\u276f 1. Opus', '  2. Sonnet', '  3. Haiku', RULE, `  ${FOOTER_IDLE}`].join('\n')

interface Harness {
  writes: [string, string][]
  deps: Parameters<typeof flushSupplyNotices>[0]
}
const harness = (screen: string, desks: { id: string; cwd: string }[] = [{ id: DESK, cwd: PROJECT }]): Harness => {
  const writes: [string, string][] = []
  return {
    writes,
    deps: {
      desks: () => desks,
      screen: () => screen,
      write: (id, data) => {
        writes.push([id, data])
        return true
      },
    },
  }
}

// `projectPath: null` means "the event names no project" — spelt as null rather
// than an omitted argument, because a default parameter would swallow an
// explicit `undefined` and quietly test the opposite case.
const fatal = (detail: string, projectPath: string | null = PROJECT): AppNotification =>
  buildFatalAppNotification({ event: 'high-risk-hold', detail, ...(projectPath ? { projectPath } : {}) }, 1_000)
const info = (event: SwarmInfoEvent, detail: string, projectPath = PROJECT): AppNotification =>
  buildInfoAppNotification({ event, detail, projectPath }, 1_000)

beforeEach(() => resetSupplyNoticeState())

describe('supplyNoticeFor — WHICH events are worth the owner\'s conversation', () => {
  it('delivers a question that landed in the inbox (event ①)', () => {
    expect(supplyNoticeFor(info('escalation-open', '統合の可否を確認したい'))).toContain('統合の可否を確認したい')
  })

  it('delivers the high-risk force-hold (event ②) — it rides the fatal lane', () => {
    expect(supplyNoticeFor(fatal('高リスクの変更なので統合を止めた'))).toContain('高リスクの変更なので統合を止めた')
  })

  it('delivers every fatal event (event ④)', () => {
    const anyFatal = buildFatalAppNotification(
      { event: 'all-workers-down', detail: 'worker が全滅した', projectPath: PROJECT },
      1_000,
    )
    expect(supplyNoticeFor(anyFatal)).not.toBeNull()
  })

  // The seat is the owner's own conversation and the fattest context in the app
  // (38.3% of fuel, measured). Routine traffic must NOT reach it, or the channel
  // pays for itself twice over — this is the half of the contract that a
  // "deliver everything" implementation would silently break.
  it.each<SwarmInfoEvent>([
    'manager-woke',
    'review-idle',
    'daily-fuel-report',
    'engine-resumed',
    'escalation-reminder',
    'overseer-throttled',
    'session-limit',
    'stuck-processes',
    'ready-without-work',
  ])('does NOT deliver routine event %s', (event) => {
    expect(supplyNoticeFor(info(event, 'routine'))).toBeNull()
  })

  it('ignores notifications that are not swarm events at all', () => {
    expect(supplyNoticeFor({ id: 'x', kind: 'collab-invite', createdAt: 1 } as AppNotification)).toBeNull()
  })
})

describe('supplyNoticeLine — what is actually typed', () => {
  it('carries the prefix the supply skill matches on, and the retell instruction', () => {
    const line = supplyNoticeLine('質問が1件届いた')
    expect(line.startsWith(SUPPLY_NOTICE_PREFIX)).toBe(true)
    expect(line).toContain('平易な言葉で1〜3行')
  })

  it('never contains a bare CR — one notice is ONE turn, not two', () => {
    expect(sanitizeSupplyNotice('前半\r後半')).toBe('前半 後半')
    expect(supplyNoticeLine('前半\r\n後半')).not.toMatch(/[\r\n]/)
  })

  it('caps a fire site that grew into a paragraph', () => {
    expect(sanitizeSupplyNotice('あ'.repeat(SUPPLY_NOTICE_MAX + 200)).length).toBe(SUPPLY_NOTICE_MAX)
  })
})

describe('delivery — the line REACHES the desk', () => {
  it('types the notice, with the submitting CR, into the project\'s supply desk', () => {
    const h = harness(IDLE)
    noticeToSupply(fatal('高リスクの変更なので統合を止めた'), h.deps)
    expect(h.writes).toHaveLength(1)
    const [id, data] = h.writes[0]!
    expect(id).toBe(DESK)
    expect(data).toContain('高リスクの変更なので統合を止めた')
    expect(data.endsWith('\r')).toBe(true)
  })

  it('clears the slot once delivered — the same news is never typed twice', () => {
    const h = harness(IDLE)
    noticeToSupply(fatal('統合を止めた'), h.deps)
    expect(peekSupplyNotices().size).toBe(0)
    flushSupplyNotices(h.deps)
    expect(h.writes).toHaveLength(1)
  })

  it('writes ONLY to the desk of the project the event belongs to', () => {
    const h = harness(IDLE, [
      { id: 'term-other', cwd: '/repo/beta' },
      { id: DESK, cwd: PROJECT },
    ])
    noticeToSupply(fatal('統合を止めた'), h.deps)
    expect(h.writes.map(([id]) => id)).toEqual([DESK])
  })

  it('drops an event with no project — there is no desk to address', () => {
    const h = harness(IDLE)
    noticeToSupply(fatal('ホームのデータが壊れた', null), h.deps)
    expect(h.writes).toEqual([])
    expect(peekSupplyNotices().size).toBe(0)
  })
})

describe('the three refusals — a held notice is kept, never forced', () => {
  it.each([
    ['generating', BUSY],
    ['half-typed', HALF_TYPED],
    ['a menu is open', MENU],
  ])('writes nothing while %s, and keeps the notice for the next pass', (_label, screen) => {
    const held = harness(screen)
    noticeToSupply(fatal('統合を止めた'), held.deps)
    expect(held.writes).toEqual([])
    expect(peekSupplyNotices().get(PROJECT)).toContain('統合を止めた')

    // …and the very next pass, on an idle desk, delivers it.
    const free = harness(IDLE)
    flushSupplyNotices(free.deps)
    expect(free.writes).toHaveLength(1)
    expect(free.writes[0]![1]).toContain('統合を止めた')
  })

  it('a write that misses keeps the notice queued', () => {
    const writes: [string, string][] = []
    flushSupplyNotices({ desks: () => [], screen: () => IDLE, write: () => false })
    noticeToSupply(fatal('統合を止めた'), {
      desks: () => [{ id: DESK, cwd: PROJECT }],
      screen: () => IDLE,
      write: (id, d) => {
        writes.push([id, d])
        return false
      },
    })
    expect(writes).toHaveLength(1) // it tried
    expect(peekSupplyNotices().get(PROJECT)).toBeTruthy() // and did not lose it
  })
})

describe('ONE slot per project — newest overwrites', () => {
  it('a desk that was busy for two events hears only the newest', () => {
    const busy = harness(BUSY)
    noticeToSupply(fatal('古い知らせ'), busy.deps)
    noticeToSupply(fatal('新しい知らせ'), busy.deps)
    expect(peekSupplyNotices().size).toBe(1)

    const free = harness(IDLE)
    flushSupplyNotices(free.deps)
    expect(free.writes).toHaveLength(1)
    expect(free.writes[0]![1]).toContain('新しい知らせ')
    expect(free.writes[0]![1]).not.toContain('古い知らせ')
  })

  it('two projects keep independent slots', () => {
    const busy = harness(BUSY, [
      { id: 'a', cwd: '/repo/alpha' },
      { id: 'b', cwd: '/repo/beta' },
    ])
    noticeToSupply(fatal('alpha の件', '/repo/alpha'), busy.deps)
    noticeToSupply(fatal('beta の件', '/repo/beta'), busy.deps)
    expect(peekSupplyNotices().size).toBe(2)
  })
})

describe('queueSupplyNotice — the direct path (event ③, work landing)', () => {
  it('types a landing line into the desk', () => {
    const h = harness(IDLE)
    queueSupplyNotice(PROJECT, 'お願いされていた作業が 2 件、本体に取り込まれました。', h.deps)
    expect(h.writes[0]![1]).toContain('2 件、本体に取り込まれました')
  })

  it('ignores an empty project path rather than queueing an unaddressable line', () => {
    const h = harness(IDLE)
    queueSupplyNotice('', 'どこかで何かが起きた', h.deps)
    expect(h.writes).toEqual([])
    expect(peekSupplyNotices().size).toBe(0)
  })
})

// ─── stale news is DROPPED, not delivered late (adversarial review 0922) ────
// Without a clock a notice for a project with no supply desk waits for the life
// of the process and is typed the instant a desk first appears — greeting the
// owner at 17:00 with a question they answered from the inbox at 09:05. The
// bell still holds the event, so expiring one is not losing it.
//
// RED MEASURED 2026-09-22 (reverted after): removing the TTL sweep from
// flushSupplyNotices → the first test delivers the stale line.
describe('a notice expires rather than arriving hours late', () => {
  it('is dropped once it is older than the TTL, even when a desk finally appears', () => {
    let now = 1_000_000
    const busy = harness(BUSY)
    queueSupplyNotice(PROJECT, '朝の質問', { ...busy.deps, now: () => now })
    expect(peekSupplyNotices().size).toBe(1)

    now += SUPPLY_NOTICE_TTL_MS + 1
    const free = harness(IDLE)
    flushSupplyNotices({ ...free.deps, now: () => now })
    expect(free.writes).toEqual([])
    expect(peekSupplyNotices().size).toBe(0) // and it does not linger either
  })

  it('still delivers one that is merely a slow turn old', () => {
    let now = 1_000_000
    const busy = harness(BUSY)
    queueSupplyNotice(PROJECT, '直前の質問', { ...busy.deps, now: () => now })

    now += SUPPLY_NOTICE_TTL_MS - 1
    const free = harness(IDLE)
    flushSupplyNotices({ ...free.deps, now: () => now })
    expect(free.writes).toHaveLength(1)
  })

  it('expires an undeliverable project so the slot map cannot grow forever', () => {
    let now = 1_000_000
    queueSupplyNotice('/repo/no-desk-ever', 'どこにも届かない', {
      desks: () => [],
      screen: () => IDLE,
      write: () => true,
      now: () => now,
    })
    expect(peekSupplyNotices().size).toBe(1)

    now += SUPPLY_NOTICE_TTL_MS + 1
    queueSupplyNotice(PROJECT, '別件', { ...harness(IDLE).deps, now: () => now })
    expect(peekSupplyNotices().has('/repo/no-desk-ever')).toBe(false)
  })
})

// ─── one bad desk must not silence the rest (adversarial review 0922) ──────
// RED MEASURED (reverted after): moving the try/catch back around the whole
// loop → the second project never hears anything.
describe('a throwing desk does not abort the pass', () => {
  it('still delivers to the projects after it', () => {
    const writes: [string, string][] = []
    queueSupplyNotice('/repo/alpha', 'alphaの件', { desks: () => [], screen: () => IDLE, write: () => true })
    queueSupplyNotice('/repo/beta', 'betaの件', { desks: () => [], screen: () => IDLE, write: () => true })

    flushSupplyNotices({
      desks: () => [
        { id: 'bad', cwd: '/repo/alpha' },
        { id: 'good', cwd: '/repo/beta' },
      ],
      screen: (id) => {
        if (id === 'bad') throw new Error('screen read blew up')
        return IDLE
      },
      write: (id, d) => {
        writes.push([id, d])
        return true
      },
    })
    expect(writes.map(([id]) => id)).toEqual(['good'])
  })
})
