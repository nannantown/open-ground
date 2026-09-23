// THE WIRING, NOT THE PIECES — the test that fails when the ROUTE is cut.
//
// WHY A SECOND FILE. supplyNotice.test.ts exercises the channel by calling
// `noticeToSupply` itself, which proves the channel WORKS and proves nothing
// about whether the engine ever calls it. Measured 2026-09-22: deleting
// `noticeToSupply(app)` from BOTH create* functions — i.e. removing the entire
// feature — left all 28 of those tests green. That is the defect class
// docs/VERIFICATION.md §1 is about: a guard that only watches its own remedy.
//
// So this file starts where the ENGINE starts (createSwarmFatalNotification /
// createSwarmInfoNotification, the single seam all four deliverable events pass
// through) and ends at the SCREEN, asserting the keystrokes that reached the
// supply desk's terminal. Nothing in between is injected: the desk pool is
// mocked at the module boundary so the production `defaultDeps` path is the one
// under test.
//
// RED MEASURED (2026-09-22) — each reverted after:
//   • `noticeToSupply(app)` removed from createSwarmFatalNotification → red
//   • `noticeToSupply(app)` removed from createSwarmInfoNotification  → red
//   • 'escalation-open' removed from SUPPLY_NOTICE_INFO_EVENTS        → red

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const PROJECT = '/repo/alpha'
const DESK = 'term-supply-1'

const RULE = '─'.repeat(40)
const BUSY_SCREEN = [
  '\u23fa done.',
  '',
  RULE,
  '\u276f ',
  RULE,
  '  \u23f5\u23f5 bypass permissions on (shift+tab to cycle) \u00b7 esc to interrupt',
].join('\n')

const IDLE_SCREEN = [
  '⏺ done.',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const writes: [string, string][] = []
const enters: string[] = []
const typedBox = new Map<string, string>()
const IDLE_BOX = (text: string) =>
  ['⏺ done.', '', '─'.repeat(40), `❯ ${text}`, '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

// The PTY pool, mocked at the module boundary — so supplyNotice's own
// `defaultDeps` (the arrangement production actually runs) is what gets
// exercised, rather than a test-only deps object that can drift from it.
// The pool holds what a real project's pool holds: the supply desk, the
// COMMANDER desk (same cwd, `ownerDesk`, tag 'claude' — indistinguishable except
// by label), an OLDER orphan supply desk, and a dead one. Anything but the
// newest live 補給官 receiving a line is a bug, and with a single-desk mock none
// of those filters is observed at all.
vi.mock('./terminal', () => ({
  listOwnerDeskTerminals: () => [
    // insertion order = OLDEST first, which is what the real pool returns
    { id: 'term-supply-orphan', cwd: PROJECT, deskLabel: '補給官', startedAtMs: 1_000 },
    { id: 'term-supply-dead', cwd: PROJECT, deskLabel: '補給官', startedAtMs: 9_000 },
    { id: 'term-manager', cwd: PROJECT, deskLabel: '司令官', startedAtMs: 8_000 },
    { id: DESK, cwd: PROJECT, deskLabel: '補給官', startedAtMs: 5_000 },
  ],
  isTerminalProcessAlive: (id: string) => id !== 'term-supply-dead',
  // Like a real desk: a paste shows in the box, the Enter clears it.
  getTerminalScreen: (id: string) => (typedBox.has(id) ? IDLE_BOX(typedBox.get(id)!) : IDLE_SCREEN),
  // Lines only: the submitting Enter is a separate bare-CR write (after the
  // paste), counted in `enters`.
  writeInput: (id: string, data: string) => {
    if (data === '\r') {
      enters.push(id)
      typedBox.delete(id)
    } else {
      writes.push([id, data])
      typedBox.set(id, data.replace('\x1b[200~', '').replace('\x1b[201~', ''))
    }
    return true
  },
}))

// Static imports are correct here even though these modules reach the mocked
// pool: vitest hoists `vi.mock` above the import block, so they resolve against
// the mock. (They were dynamic at first, which tripped TS1378 — top-level await
// is not allowed under this tsconfig's module target.)
import { createSwarmFatalNotification, createSwarmInfoNotification } from './swarmNotifications'
import {
  resetSupplyNoticeState,
  queueSupplyNotice,
  peekSupplyNotices,
} from './supplyNotice'
import { startSupplyContextCapLoop, stopSupplyContextCapLoop } from './supplyContextCap'

let home: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-supplynotice-')))
  process.env.OPENGROUND_HOME = home
  writes.length = 0
  enters.length = 0
  typedBox.clear()
  resetSupplyNoticeState()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  // NEVER unset — an empty OPENGROUND_HOME resolves to the REAL ~/.openground
  // (the 2026-07-18 data loss). Restore the suite-wide pin.
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

describe('the engine actually reaches the supply desk', () => {
  it('a question opening (①) is typed into that project\'s supply desk', async () => {
    await createSwarmInfoNotification(
      { event: 'escalation-open', detail: '統合の可否を確認したい', projectPath: PROJECT },
      { os: false },
    )
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(writes).toHaveLength(1)
    expect(writes[0]![0]).toBe(DESK)
    expect(writes[0]![1]).toContain('統合の可否を確認したい')
    // Submitted by a SEPARATE Enter, after the paste (owner report 0923).
    expect(writes[0]![1]).not.toContain('\r')
    await vi.waitFor(() => expect(enters).toEqual([DESK]), { timeout: 10_000 })
  })

  it('a high-risk force-hold (②) and any other fatal (④) are typed in too', async () => {
    await createSwarmFatalNotification(
      { event: 'high-risk-hold', detail: '高リスクの変更なので統合を止めた', projectPath: PROJECT },
      { os: false },
    )
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(writes).toHaveLength(1)
    expect(writes[0]![1]).toContain('統合を止めた')
  })

  // The other half of the contract: the seat is the owner's own conversation and
  // the app's fattest context (38.3% of fuel, measured), so routine engine
  // traffic must NOT arrive. An implementation that delivered everything would
  // pass every test above and fail this one.
  it('routine engine traffic never reaches the desk', async () => {
    await createSwarmInfoNotification(
      { event: 'manager-woke', detail: '司令官を起こした', projectPath: PROJECT },
      { os: false },
    )
    await createSwarmInfoNotification(
      { event: 'daily-fuel-report', detail: '本日の燃料報告', projectPath: PROJECT },
      { os: false },
    )
    expect(writes).toEqual([])
  })

  it('another project\'s desk is never written to', async () => {
    await createSwarmFatalNotification(
      { event: 'high-risk-hold', detail: '別の件', projectPath: '/repo/beta' },
      { os: false },
    )
    expect(writes).toEqual([])
  })
})

// ─── the RETRY rides the loop that already exists ───────────────────────────
// A notice refused because the desk was generating / half-typed / showing a
// menu is re-offered by the SUPPLY DESK LOOP (supplyContextCap.ts, 60s), not by
// a timer of this channel's own — the owner decision that asked for the channel
// also forbade adding polling. That makes the flush call inside the loop
// load-bearing: delete it and every held notice is stranded forever.
//
// Observable here (and only here) because this file mocks the PTY pool, so the
// loop's un-injected `flushSupplyNotices()` reaches a desk that records writes.
//
// RED MEASURED 2026-09-22 (reverted after): removing `flushSupplyNotices()`
// from the interval callback → this test fails, writes stays [].
describe('a held notice is re-offered by the existing supply loop', () => {
  it('delivers on the loop\'s next tick, with no timer of its own', async () => {
    vi.useFakeTimers()
    try {
      // Refused: this desk is mid-turn. (The screen the POOL reports is IDLE, so
      // the refusal has to come from the deps handed in here.)
      queueSupplyNotice(PROJECT, '\u5224\u65ad\u304c\u307b\u3057\u3044', {
        desks: () => [{ id: DESK, cwd: PROJECT }],
        screen: () => BUSY_SCREEN,
        write: () => true,
      })
      expect(writes).toEqual([])
      expect(peekSupplyNotices().get(PROJECT)).toBeTruthy()

      startSupplyContextCapLoop(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      stopSupplyContextCapLoop()
      await vi.advanceTimersByTimeAsync(3_000) // paste → Enter → landing check

      expect(writes).toHaveLength(1)
      expect(writes[0]![1]).toContain('\u5224\u65ad\u304c\u307b\u3057\u3044')
      expect(peekSupplyNotices().size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── WHICH desk — the filter nothing observed before ────────────────────────
// RED MEASURED 2026-09-22 (reverted after), against the four-desk pool above:
//   • the `deskLabel === SUPPLY_DESK_LABEL` filter removed → the COMMANDER desk
//     is typed into as well (2 writes instead of 1)
//   • the `isTerminalProcessAlive` filter removed          → the dead desk wins
//     the sort and swallows the notice
//   • the newest-first `.sort` removed                     → the ORPHAN wins
// Adversarial review 2026-09-22 found all three unobserved: a single-desk mock
// cannot see a filter that only matters when there is something to filter out.
// The orphan case is not hypothetical — adoptLiveSupplyDesk deliberately leaves
// extra desks alive («余分な卓は Terminal タブから閉じてください»).
describe('the notice reaches the RIGHT desk, and only it', () => {
  it('goes to the NEWEST LIVE supply desk — never the commander, orphan or corpse', async () => {
    await createSwarmFatalNotification(
      { event: 'high-risk-hold', detail: '統合を止めた', projectPath: PROJECT },
      { os: false },
    )
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(writes.map(([id]) => id)).toEqual([DESK])
  })
})

// ─── the line the OWNER reads must not carry operator vocabulary ────────────
// The supply officer is told to retell in plain language, but the line is TYPED
// into the owner's own conversation, so they read it as sent. Several fire sites
// append paths / branches / ids to `detail` (the high-risk hold names changed
// files; an escalation with no plainQuestion falls back to the worker's raw
// wording), so the scrub is what stands between those and the owner's window.
//
// RED MEASURED 2026-09-22 (reverted after): emptying REDACTIONS → this fails.
describe("operator vocabulary never reaches the owner's window", () => {
  it('redacts branch names, file paths and ids out of a real-shaped detail', async () => {
    await createSwarmFatalNotification(
      {
        event: 'high-risk-hold',
        detail:
          '高リスク: swarm/fix-ci の .github/workflows/release.yml / ' +
          'src/lib/server/swarmQuota.ts を変更 (card 27537000deadbeef)',
        projectPath: PROJECT,
      },
      { os: false },
    )
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 10_000 })
    const line = writes[0]![1]
    expect(line).not.toContain('swarm/fix-ci')
    expect(line).not.toContain('release.yml')
    expect(line).not.toContain('swarmQuota')
    expect(line).not.toContain('27537000deadbeef')
    expect(line).toContain('高リスク') // the human half survives
  })
})

// ─── a path spelt differently still finds the desk ──────────────────────────
// The desk's cwd is the RAW string its launcher was handed; a notification's
// projectPath is canonicalized. A raw `===` lost every notice for a desk opened
// as '/repo/x/' — silently and forever (adversarial review 2026-09-22).
//
// RED MEASURED (reverted after): `deskKey` reduced to the identity function.
describe('the desk is found through a different spelling of the same path', () => {
  it('delivers when the notification path has a trailing slash', async () => {
    await createSwarmFatalNotification(
      { event: 'high-risk-hold', detail: '統合を止めた', projectPath: `${PROJECT}/` },
      { os: false },
    )
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(writes).toHaveLength(1)
  })

  it('delivers when the notification path carries a redundant segment', async () => {
    await createSwarmFatalNotification(
      { event: 'high-risk-hold', detail: '統合を止めた', projectPath: '/repo/./alpha' },
      { os: false },
    )
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(writes).toHaveLength(1)
  })
})
