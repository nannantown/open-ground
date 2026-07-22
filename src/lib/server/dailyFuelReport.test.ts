import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEGRADE_BUNDLE_LT,
  DEGRADE_MAX_CONTEXT_GT,
  DEGRADE_MEDIAN_TURNS_GT,
  FUEL_PROPOSAL_KEY,
  QUIET_MS,
  REPORT_HOUR_LOCAL,
  buildReportDetail,
  plainCount,
  degradationReasons,
  effectiveFuelSentinel,
  localDateKey,
  readFuelSentinel,
  runDailyFuelReport,
  shouldReportNow,
  startDailyFuelReportLoop,
  stopDailyFuelReportLoop,
  summarizeAudits,
  trendLine,
  uuidFromSessionDir,
  type DailyFuelSentinel,
  type DailyFuelSummary,
} from './dailyFuelReport'
import type { SessionTokenAudit } from './swarmTokenAudit'
import type { ProjectData } from '../types'

// ── Fixture language ────────────────────────────────────────────────────────
// Everything runs in an isolated OPENGROUND_HOME + an isolated fake
// ~/.claude/projects root (claudeRoot injection) — no real home is ever read
// or written (house rule: tests never touch the production ~/.openground).

const NOW = new Date(2026, 6, 18, 10, 0, 0).getTime() // local 10:00 — past REPORT_HOUR_LOCAL

/** A synthetic per-card audit for the pure aggregation tests. */
const audit = (over: Partial<SessionTokenAudit> = {}): SessionTokenAudit => ({
  sessionId: 's',
  cwd: '/wt/x',
  firstAt: '2026-07-17T10:00:00.000Z',
  lastAt: '2026-07-17T12:00:00.000Z',
  turns: 100,
  toolUses: 150,
  toolTurns: 100,
  bundleRate: 1.5,
  maxContext: 200_000,
  outputTokens: 50_000,
  sidechainTurns: 0,
  sidechainOutputTokens: 0,
  readCount: 0,
  readRereads: 0,
  bash: { tsc: 0, test: 0, lint: 0, git: 0, other: 0 },
  ...over,
})

/** One assistant JSONL line carrying usage — the shape swarmTokenAudit meters. */
let blockN = 0
const assistantLine = (opts: {
  id: string
  timestamp: string
  usage?: { input?: number; cacheRead?: number; output?: number }
  tools?: number
}): string => {
  const content: unknown[] = [{ type: 'text', text: 'hi' }]
  for (let i = 0; i < (opts.tools ?? 0); i++) {
    content.push({ type: 'tool_use', id: `toolu_${++blockN}`, name: 'Bash', input: { command: 'ls' } })
  }
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: opts.timestamp,
    cwd: '/wt/x',
    sessionId: `sess-${opts.id}`,
    message: {
      id: opts.id,
      usage: {
        input_tokens: opts.usage?.input ?? 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: opts.usage?.cacheRead ?? 0,
        output_tokens: opts.usage?.output ?? 10,
      },
      content,
    },
  })
}

/** Build a session JSONL with `turns` responses ending at `lastAt`, each
 *  bundling `toolsPerTurn` tool calls. */
const sessionLines = (opts: {
  turns: number
  lastAtMs: number
  toolsPerTurn?: number
  maxContext?: number
}): string => {
  const lines: string[] = []
  for (let i = 0; i < opts.turns; i++) {
    const ts = new Date(opts.lastAtMs - (opts.turns - 1 - i) * 1000).toISOString()
    lines.push(
      assistantLine({
        id: `msg_${i}`,
        timestamp: ts,
        tools: opts.toolsPerTurn ?? 2,
        usage: { cacheRead: opts.maxContext ?? 100_000, output: 100 },
      }),
    )
  }
  return lines.join('\n')
}

const WORKER_BRANCH = ['a1', 'b2', 'c3', 'd4', 'e5']
/** A ~/.claude/projects dir name that isSwarmWorktreeSessionDir accepts. */
const workerDir = (uuid: string, n: number): string =>
  `-Users-x--openground-projects-${uuid}-worktrees-${WORKER_BRANCH[n] ?? `w${n}`}`

describe('dailyFuelReport', () => {
  let home = ''
  let claudeRoot = ''
  let projDir = ''
  const UUID = 'aaaa1111bbbb'
  const prevHome = process.env.OPENGROUND_HOME
  // The LOOP tests exercise the real boot tick, which resolves its session root
  // from os.homedir() (no injection point) — i.e. the developer's actual
  // ~/.claude/projects. Pointing HOME at an empty temp dir keeps those runs
  // isolated, deterministic and fast, and upholds the house rule that a test
  // never reads or writes the production home.
  const prevOsHome = process.env.HOME
  let osHome = ''

  beforeEach(async () => {
    // The once-a-day guard and the tick re-entrancy flag live on globalThis on
    // purpose (a `tsx watch` reload must not drop them) — which also means
    // they outlive a test. Reset both, or one test's "already reported today"
    // silently suppresses the next test's report.
    globalThis.__openground_fuel_memo = null
    globalThis.__openground_fuel_tick_inflight = false
    home = await mkdtemp(join(tmpdir(), 'og-fuel-home-'))
    claudeRoot = await mkdtemp(join(tmpdir(), 'og-fuel-claude-'))
    projDir = await mkdtemp(join(tmpdir(), 'og-fuel-proj-'))
    osHome = await mkdtemp(join(tmpdir(), 'og-fuel-oshome-'))
    process.env.OPENGROUND_HOME = home
    process.env.HOME = osHome
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({ projects: [{ id: UUID, path: projDir, addedAt: '2026-01-01T00:00:00.000Z' }] }),
    )
  })

  afterEach(async () => {
    stopDailyFuelReportLoop()
    // Restore the clock BEFORE anything else — a pinned Date leaking into the
    // next test would silently move it back to the vacuous state this file just
    // fixed.
    vi.useRealTimers()
    // NEVER unset either home var (repo guard, src/testHomeEnvGuard.test.ts):
    // vitest reuses worker processes, so an unset var aims every later write in
    // this process at the user's real ~/.openground — the 2026-07-19 settings.json
    // corruption. Leaving it pointed at the removed temp dir is inert; unset is not.
    if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
    if (prevOsHome !== undefined) process.env.HOME = prevOsHome
    await rm(home, { recursive: true, force: true })
    await rm(claudeRoot, { recursive: true, force: true })
    await rm(projDir, { recursive: true, force: true })
    await rm(osHome, { recursive: true, force: true })
  })

  /** Write a session JSONL. `mtimeMs` pins the file's mtime (tests that move
   *  `now` into the future must keep mtime >= the window's left edge, or the
   *  mtime PRE-filter — correct in production, where now is the real clock —
   *  would skip the fixture before the lastAt check even runs). */
  const writeSession = async (dir: string, file: string, content: string, mtimeMs?: number): Promise<void> => {
    await mkdir(join(claudeRoot, dir), { recursive: true })
    const full = join(claudeRoot, dir, file)
    await writeFile(full, content)
    if (mtimeMs !== undefined) await utimes(full, new Date(mtimeMs), new Date(mtimeMs))
  }

  const readNotifications = async (): Promise<Array<{ kind: string; swarmInfo?: { event: string; detail: string; projectPath?: string; taskId?: string } }>> => {
    try {
      const raw = JSON.parse(await readFile(join(home, 'swarm-notifications.json'), 'utf8')) as {
        items: Array<{ kind: string; swarmInfo?: { event: string; detail: string; projectPath?: string; taskId?: string } }>
      }
      return raw.items
    } catch {
      return []
    }
  }

  const readBoard = async (): Promise<ProjectData | null> => {
    try {
      return JSON.parse(
        await readFile(join(home, 'projects', UUID, 'tasks.json'), 'utf8'),
      ) as ProjectData
    } catch {
      return null
    }
  }

  // ── Pure pieces ───────────────────────────────────────────────────────────

  it('summarizeAudits: median (odd/even), weighted bundle rate, max, sums', () => {
    const s = summarizeAudits([
      audit({ turns: 10, toolUses: 10, toolTurns: 10, maxContext: 100, outputTokens: 5, sidechainOutputTokens: 1 }),
      audit({ turns: 30, toolUses: 60, toolTurns: 20, maxContext: 300, outputTokens: 7, sidechainOutputTokens: 2 }),
      audit({ turns: 20, toolUses: 0, toolTurns: 0, maxContext: 200, outputTokens: 9, sidechainOutputTokens: 0 }),
    ])
    expect(s.cards).toBe(3)
    expect(s.medianTurns).toBe(20)
    // Weighted: (10+60+0)/(10+20+0) — NOT the mean of per-card ratios.
    expect(s.bundleRate).toBeCloseTo(70 / 30)
    expect(s.maxContext).toBe(300)
    expect(s.outputTokens).toBe(21)
    expect(s.sidechainOutputTokens).toBe(3)

    const even = summarizeAudits([audit({ turns: 10 }), audit({ turns: 20 })])
    expect(even.medianTurns).toBe(15)

    const empty = summarizeAudits([])
    expect(empty.cards).toBe(0)
    expect(empty.medianTurns).toBe(0)
    expect(empty.bundleRate).toBeNull()
  })

  it('shouldReportNow: once per local day, at/after the fixed hour', () => {
    const at = (h: number, m = 0) => new Date(2026, 6, 18, h, m, 0).getTime()
    expect(shouldReportNow(null, at(8, 59))).toBe(false) // before the hour
    expect(shouldReportNow(null, at(9, 0))).toBe(true) // at the hour, never reported
    expect(shouldReportNow(null, at(14, 0))).toBe(true) // catch-up after a late boot
    const reported: DailyFuelSentinel = {
      lastReportDate: localDateKey(at(9)),
      lastCutoffMs: 0,
      lastSummary: null,
      proposal: null,
    }
    expect(shouldReportNow(reported, at(15, 0))).toBe(false) // same day → no second report
    const nextDay = new Date(2026, 6, 19, 9, 0, 0).getTime()
    expect(shouldReportNow(reported, nextDay)).toBe(true)
  })

  it('degradationReasons: each threshold independently; null bundle never trips', () => {
    const healthy: DailyFuelSummary = {
      cards: 3, medianTurns: 100, bundleRate: 1.8, maxContext: 200_000, outputTokens: 1, sidechainOutputTokens: 0,
    }
    expect(degradationReasons(healthy)).toEqual([])
    expect(degradationReasons({ ...healthy, bundleRate: DEGRADE_BUNDLE_LT - 0.01 })).toHaveLength(1)
    expect(degradationReasons({ ...healthy, medianTurns: DEGRADE_MEDIAN_TURNS_GT + 1 })).toHaveLength(1)
    expect(degradationReasons({ ...healthy, maxContext: DEGRADE_MAX_CONTEXT_GT + 1 })).toHaveLength(1)
    expect(degradationReasons({ ...healthy, bundleRate: null })).toEqual([])
    expect(
      degradationReasons({ ...healthy, bundleRate: 1.0, medianTurns: 200, maxContext: 400_000 }),
    ).toHaveLength(3)
  })

  it('trendLine: direction in plain language, keyed on median turns', () => {
    const base: DailyFuelSummary = {
      cards: 3, medianTurns: 100, bundleRate: 1.5, maxContext: 1, outputTokens: 1, sidechainOutputTokens: 0,
    }
    expect(trendLine(null, base)).toBe('')
    expect(trendLine({ ...base, cards: 0 }, base)).toBe('')
    expect(trendLine(base, { ...base, medianTurns: 80 })).toContain('良く')
    expect(trendLine(base, { ...base, medianTurns: 130 })).toContain('悪く')
    expect(trendLine(base, { ...base, medianTurns: 105 })).toContain('ほぼ同じ')
  })

  it('buildReportDetail: zero day is the one-liner; normal day carries the numbers', () => {
    const zero = buildReportDetail(summarizeAudits([]), '', '', 26)
    expect(zero).toContain('終わったカードはありませんでした')
    const s: DailyFuelSummary = {
      cards: 2, medianTurns: 101, bundleRate: 1.75, maxContext: 210_000, outputTokens: 1_200_000, sidechainOutputTokens: 0,
    }
    const d = buildReportDetail(s, 'trend.', 'note.', 26)
    expect(d).toContain('カード2枚')
    expect(d).toContain('101手')
    expect(d).toContain('1.75')
    expect(d).toContain('21万')
    expect(d).toContain('120万')
    expect(d).toContain('trend.')
    expect(d).toContain('note.')
  })

  it('buildReportDetail: names the REAL window, not a fixed 「きのう」', () => {
    const s = summarizeAudits([])
    // A catch-up run after an outage covers the clamped tail, and the first-ever
    // run covers 24h — calling either 「きのう」 would be a false statement.
    expect(buildReportDetail(s, '', '', 26)).toContain('直近26時間')
    expect(buildReportDetail(s, '', '', 24)).toContain('直近24時間')
    expect(buildReportDetail(s, '', '', 26)).not.toContain('きのう')
  })

  it('plainCount: owner-readable 万 units, not engineer k-notation', () => {
    expect(plainCount(1_200_000)).toBe('120万')
    expect(plainCount(336_000)).toBe('33.6万')
    expect(plainCount(300_000)).toBe('30万')
    expect(plainCount(9_999)).toBe('9999') // below 万 stays a plain number
  })

  it('uuidFromSessionDir: extracts the uuid; rejects non-swarm dirs', () => {
    expect(uuidFromSessionDir(workerDir(UUID, 0))).toBe(UUID)
    expect(uuidFromSessionDir('-Users-x-projects-foo')).toBeNull()
    // full (hyphenated) uuids survive the extraction too
    expect(
      uuidFromSessionDir('-Users-x--openground-projects-06c90656-c9f8-4d67-worktrees-b'),
    ).toBe('06c90656-c9f8-4d67')
  })

  // ── The daily run (integration over the isolated HOME) ────────────────────

  it('healthy day: bell notification with numbers, sentinel persisted, no card filed', async () => {
    const lastAt = NOW - QUIET_MS - 60 * 60 * 1000 // quiet well before the cutoff
    await writeSession(workerDir(UUID, 0), 's1.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt, toolsPerTurn: 2 }))
    await writeSession(workerDir(UUID, 1), 's2.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt, toolsPerTurn: 2 }))

    const r = await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(r.summary.cards).toBe(2)
    expect(r.summary.medianTurns).toBe(6)
    expect(r.degraded).toBe(false)
    expect(r.proposalOutcome).toBe('none')

    const items = await readNotifications()
    expect(items).toHaveLength(1)
    expect(items[0].swarmInfo?.event).toBe('daily-fuel-report')
    expect(items[0].swarmInfo?.detail).toContain('カード2枚')

    // Sentinel survives a "restart" — re-read straight from disk.
    const s = await readFuelSentinel()
    expect(s?.lastReportDate).toBe(localDateKey(NOW))
    expect(s?.lastCutoffMs).toBe(NOW - QUIET_MS)
    expect(s?.lastSummary?.cards).toBe(2)
    expect(await readBoard()).toBeNull() // nothing filed
  })

  it('zero day notifies with the one-liner (never silently skips)', async () => {
    const r = await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(r.summary.cards).toBe(0)
    const items = await readNotifications()
    expect(items).toHaveLength(1)
    expect(items[0].swarmInfo?.detail).toContain('終わったカードはありませんでした')
  })

  it('window: a still-active session (inside QUIET) and a pre-window session are both excluded', async () => {
    // Still writing: lastAt 10min ago (< QUIET_MS = 30min) → counted TOMORROW.
    await writeSession(workerDir(UUID, 0), 'live.jsonl', sessionLines({ turns: 9, lastAtMs: NOW - 10 * 60 * 1000 }))
    // Before the window's left edge (previous report already covered it) — the
    // file's mtime is fresh (just written), so this exercises the lastAt check
    // (not the mtime pre-filter).
    const prevCutoff = NOW - QUIET_MS - 2 * 60 * 60 * 1000
    await writeSession(workerDir(UUID, 1), 'old.jsonl', sessionLines({ turns: 9, lastAtMs: prevCutoff - 60_000 }))
    // In-window control.
    await writeSession(workerDir(UUID, 2), 'ok.jsonl', sessionLines({ turns: 5, lastAtMs: prevCutoff + 60 * 60 * 1000 }))

    const sentinel: DailyFuelSentinel = {
      lastReportDate: '2026-07-17',
      lastCutoffMs: prevCutoff,
      lastSummary: null,
      proposal: null,
    }
    await writeFile(join(home, 'daily-fuel-report.json'), JSON.stringify(sentinel))

    const r = await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(r.summary.cards).toBe(1)
    expect(r.summary.medianTurns).toBe(5)
  })

  it('degraded day (≥2 cards): files ONE blocked card with the summary in notes + notifies', async () => {
    const lastAt = NOW - QUIET_MS - 60 * 60 * 1000
    // 1 tool per turn ⇒ bundle rate 1.0 < 1.3 ⇒ degraded.
    await writeSession(workerDir(UUID, 0), 's1.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt, toolsPerTurn: 1 }))
    await writeSession(workerDir(UUID, 1), 's2.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt, toolsPerTurn: 1 }))

    const r = await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(r.degraded).toBe(true)
    expect(r.proposalOutcome).toBe('filed')
    expect(r.proposal?.projectPath).toBe(projDir)

    const board = await readBoard()
    expect(board?.tasks).toHaveLength(1)
    const card = board!.tasks[0]
    expect(card.boardColumn).toBe('blocked')
    expect(card.done).toBe(false)
    expect(card.title).toContain('【燃費】')
    expect(card.notes).toContain('束ね率')
    expect(card.notes).toContain('todo 列へ動かしてください')
    // The Board-truth dedup marker must be ON the persisted card (3点セット): if
    // schemas.ts ever drops it, the read→write round-trip strips it and the
    // duplicate-proposal guard opens silently.
    expect(card.fuelProposalKey).toBe(FUEL_PROPOSAL_KEY)
    // Owner-facing and worker-facing instructions are separated — after approval
    // these same notes become the worker's prompt verbatim (composeTaskPrompt).
    expect(card.notes).toContain('▼ オーナーへ')
    expect(card.notes).toContain('▼ 作業者へ')
    // The dedup guard + the notification both point at the same card.
    const s = await readFuelSentinel()
    expect(s?.proposal?.taskId).toBe(card.id)
    const items = await readNotifications()
    expect(items[0].swarmInfo?.detail).toContain('改善提案カードを保留列')
    expect(items[0].swarmInfo?.taskId).toBe(card.id)
    expect(items[0].swarmInfo?.projectPath).toBe(projDir)
  })

  it('degraded with <2 cards: thresholds are NOT evaluated (single-card sample)', async () => {
    const lastAt = NOW - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 0), 's1.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt, toolsPerTurn: 1 }))
    const r = await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(r.summary.cards).toBe(1)
    expect(r.degraded).toBe(false)
    expect(await readBoard()).toBeNull()
  })

  it('dedup: while the proposal card is unresolved no second card is filed; resolving it re-arms', async () => {
    const lastAt = NOW - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 0), 's1.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt, toolsPerTurn: 1 }))
    await writeSession(workerDir(UUID, 1), 's2.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt, toolsPerTurn: 1 }))
    const first = await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(first.proposalOutcome).toBe('filed')

    // Next day, same degradation (new sessions inside the NEW window).
    const NOW2 = NOW + 24 * 60 * 60 * 1000
    const lastAt2 = NOW2 - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 2), 's3.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt2, toolsPerTurn: 1 }), lastAt2)
    await writeSession(workerDir(UUID, 3), 's4.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt2, toolsPerTurn: 1 }), lastAt2)
    const second = await runDailyFuelReport({ now: NOW2, claudeRoot })
    expect(second.proposalOutcome).toBe('already-open')
    expect((await readBoard())?.tasks).toHaveLength(1) // still just the one card

    // Owner resolves the card (moves it to done) → the lane re-arms.
    const board = await readBoard()
    const resolved = {
      ...board!,
      tasks: board!.tasks.map((t) => ({ ...t, boardColumn: 'done' as const, done: true })),
    }
    await writeFile(join(home, 'projects', UUID, 'tasks.json'), JSON.stringify(resolved))

    const NOW3 = NOW2 + 24 * 60 * 60 * 1000
    const lastAt3 = NOW3 - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 4), 's5.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt3, toolsPerTurn: 1 }), lastAt3)
    await writeSession(workerDir(UUID, 0), 's6.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt3, toolsPerTurn: 1 }), lastAt3)
    const third = await runDailyFuelReport({ now: NOW3, claudeRoot })
    expect(third.proposalOutcome).toBe('filed')
    expect((await readBoard())?.tasks).toHaveLength(2)
  })

  it('LOST sentinel across restarts: the Board itself stops the proposal pile-up', async () => {
    // The failure this guards (adversarial review, 2026-07-19): the dedup used to
    // live ONLY in the sentinel — a tolerant reader (unreadable ⇒ null) plus an
    // in-process memo that dies with the process. So a daily-fuel-report.json
    // that was deleted (home migration, restore from backup) or could never be
    // written (EACCES / immutable) read as "no proposal open" on EVERY app start,
    // and an owner who keeps the fuel basis broken got an identical card in
    // blocked every single day. Only a Board-truth check can stop that, which is
    // why this test destroys BOTH halves of the sentinel between runs.
    const degradedDay = async (dayOffset: number, pair: [number, number]): Promise<number> => {
      const at = NOW + dayOffset * 24 * 60 * 60 * 1000
      const lastAt = at - QUIET_MS - 60 * 60 * 1000
      // 1 tool per turn ⇒ bundle rate 1.0 < 1.3 ⇒ degraded, every day.
      await writeSession(workerDir(UUID, pair[0]), `s${pair[0]}.jsonl`, sessionLines({ turns: 5, lastAtMs: lastAt, toolsPerTurn: 1 }), lastAt)
      await writeSession(workerDir(UUID, pair[1]), `s${pair[1]}.jsonl`, sessionLines({ turns: 7, lastAtMs: lastAt, toolsPerTurn: 1 }), lastAt)
      return at
    }

    const first = await runDailyFuelReport({ now: await degradedDay(0, [0, 1]), claudeRoot })
    expect(first.proposalOutcome).toBe('filed')
    expect((await readBoard())?.tasks).toHaveLength(1)

    // ── Simulate an app RESTART whose sentinel did not survive ──────────────
    // Both halves gone: the file (deleted/never written) AND the in-process memo
    // (a new process). This is precisely the state the old code could not
    // distinguish from "first run ever".
    for (const day of [1, 2, 3]) {
      await rm(join(home, 'daily-fuel-report.json'), { force: true })
      globalThis.__openground_fuel_memo = null
      expect(await readFuelSentinel()).toBeNull() // the guard really is gone

      const r = await runDailyFuelReport({
        now: await degradedDay(day, [(day * 2) % 5, (day * 2 + 1) % 5]),
        claudeRoot,
      })
      expect(r.degraded).toBe(true) // still degraded — the alarm itself keeps working
      expect(r.proposalOutcome).toBe('already-open') // …but files nothing new
      expect((await readBoard())?.tasks).toHaveLength(1) // no pile-up in blocked
    }

    // The re-adopted reference points back at the surviving card, so the lane
    // recovers a precise sentinel even though the old one was destroyed.
    const board = await readBoard()
    expect((await readFuelSentinel())?.proposal?.taskId).toBe(board!.tasks[0].id)
  })

  it('LOST sentinel + RESOLVED card: the lane re-arms (dedup is not a permanent mute)', async () => {
    // The mirror of the test above — proving the Board check gates on the card's
    // COLUMN, not on the card's existence. Otherwise the fix would trade a flood
    // for a silence: one proposal ever, and the loop never speaks again.
    const lastAt = NOW - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 0), 's1.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt, toolsPerTurn: 1 }))
    await writeSession(workerDir(UUID, 1), 's2.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt, toolsPerTurn: 1 }))
    expect((await runDailyFuelReport({ now: NOW, claudeRoot })).proposalOutcome).toBe('filed')

    // Owner deals with it (→ done), then the sentinel is lost as well.
    const board = await readBoard()
    await writeFile(
      join(home, 'projects', UUID, 'tasks.json'),
      JSON.stringify({ ...board!, tasks: board!.tasks.map((t) => ({ ...t, boardColumn: 'done', done: true })) }),
    )
    await rm(join(home, 'daily-fuel-report.json'), { force: true })
    globalThis.__openground_fuel_memo = null

    const NOW2 = NOW + 24 * 60 * 60 * 1000
    const lastAt2 = NOW2 - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 2), 's3.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt2, toolsPerTurn: 1 }), lastAt2)
    await writeSession(workerDir(UUID, 3), 's4.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt2, toolsPerTurn: 1 }), lastAt2)
    const second = await runDailyFuelReport({ now: NOW2, claudeRoot })
    expect(second.proposalOutcome).toBe('filed')
    expect((await readBoard())?.tasks).toHaveLength(2)
  })

  it('already-open wording follows the card\'s actual column, not a fixed 「保留列」', async () => {
    const lastAt = NOW - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 0), 's1.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt, toolsPerTurn: 1 }))
    await writeSession(workerDir(UUID, 1), 's2.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt, toolsPerTurn: 1 }))
    await runDailyFuelReport({ now: NOW, claudeRoot })

    // Owner APPROVES it (blocked → todo). 'Open' spans every non-done column, so
    // the old fixed sentence kept telling them it was still awaiting a decision.
    const board = await readBoard()
    await writeFile(
      join(home, 'projects', UUID, 'tasks.json'),
      JSON.stringify({ ...board!, tasks: board!.tasks.map((t) => ({ ...t, boardColumn: 'doing' })) }),
    )

    const NOW2 = NOW + 24 * 60 * 60 * 1000
    const lastAt2 = NOW2 - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 2), 's3.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt2, toolsPerTurn: 1 }), lastAt2)
    await writeSession(workerDir(UUID, 3), 's4.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt2, toolsPerTurn: 1 }), lastAt2)
    const r = await runDailyFuelReport({ now: NOW2, claudeRoot })
    expect(r.proposalOutcome).toBe('already-open')
    expect(r.detail).toContain('作業中')
    expect(r.detail).not.toContain('まだ保留列')
  })

  it('degraded but no registered target: notification only, no crash', async () => {
    const lastAt = NOW - QUIET_MS - 60 * 60 * 1000
    const foreign = 'ffff9999eeee' // not in settings.projects
    await writeSession(workerDir(foreign, 0), 's1.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt, toolsPerTurn: 1 }))
    await writeSession(workerDir(foreign, 1), 's2.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt, toolsPerTurn: 1 }))
    const r = await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(r.degraded).toBe(true)
    expect(r.proposalOutcome).toBe('no-target')
    const items = await readNotifications()
    expect(items[0].swarmInfo?.detail).toContain('起票先のプロジェクトが見つからない')
  })

  it('前回比: the second report compares against the first', async () => {
    const lastAt = NOW - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 0), 's1.jsonl', sessionLines({ turns: 100, lastAtMs: lastAt }))
    await writeSession(workerDir(UUID, 1), 's2.jsonl', sessionLines({ turns: 100, lastAtMs: lastAt }))
    await runDailyFuelReport({ now: NOW, claudeRoot })

    const NOW2 = NOW + 24 * 60 * 60 * 1000
    const lastAt2 = NOW2 - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 2), 's3.jsonl', sessionLines({ turns: 50, lastAtMs: lastAt2 }), lastAt2)
    await writeSession(workerDir(UUID, 3), 's4.jsonl', sessionLines({ turns: 50, lastAtMs: lastAt2 }), lastAt2)
    const r2 = await runDailyFuelReport({ now: NOW2, claudeRoot })
    expect(r2.detail).toContain('良くなっています')
  })

  it('corrupt sentinel: tolerated as first-run (report still goes out)', async () => {
    await writeFile(join(home, 'daily-fuel-report.json'), '{not json')
    const r = await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(r.summary.cards).toBe(0)
    expect(await readNotifications()).toHaveLength(1)
  })

  // ── The write-failure guard (regression: card flood) ─────────────────────
  // A corrupt sentinel self-heals on the next write; an UNWRITABLE one never
  // does. With the guard living only on disk, every 60s tick re-ran the whole
  // report and filed ANOTHER proposal card. Making the path a directory is the
  // cheapest permanent write failure to stage (same shape as EACCES / ENOSPC /
  // an immutable file).

  it('sentinel write permanently failing: ONE proposal card across repeated runs, not one per run', async () => {
    await mkdir(join(home, 'daily-fuel-report.json'), { recursive: true })
    const lastAt = NOW - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 0), 's1.jsonl', sessionLines({ turns: 5, lastAtMs: lastAt, toolsPerTurn: 1 }))
    await writeSession(workerDir(UUID, 1), 's2.jsonl', sessionLines({ turns: 7, lastAtMs: lastAt, toolsPerTurn: 1 }))

    // The same instant three times over — the harshest case, because the
    // window has not moved: the very same degraded sessions are re-analyzed
    // each run, and only the dedup guard stands between them and a new card.
    // (Before the fix an unwritable sentinel made every run look like the
    // first — window reset to 24h, no known proposal — so cards went 1→2→3.)
    const first = await runDailyFuelReport({ now: NOW, claudeRoot })
    const second = await runDailyFuelReport({ now: NOW, claudeRoot })
    const third = await runDailyFuelReport({ now: NOW, claudeRoot })

    expect(first.proposalOutcome).toBe('filed')
    expect(second.proposalOutcome).toBe('already-open')
    expect(third.proposalOutcome).toBe('already-open')
    expect((await readBoard())?.tasks).toHaveLength(1) // was 1 → 2 → 3
    expect(await readFuelSentinel()).toBeNull() // the disk genuinely never took it

    // A minute on, the remembered cutoff has moved past those sessions, so
    // they are not even re-counted — the other half of the same guard.
    const later = await runDailyFuelReport({ now: NOW + 60_000, claudeRoot })
    expect(later.summary.cards).toBe(0)
    expect((await readBoard())?.tasks).toHaveLength(1)
  })

  it('sentinel write permanently failing: the day still counts as reported (guard is in-process)', async () => {
    await mkdir(join(home, 'daily-fuel-report.json'), { recursive: true })
    await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(await readFuelSentinel()).toBeNull() // nothing on disk…
    const eff = await effectiveFuelSentinel() // …but the process remembers
    expect(eff?.lastReportDate).toBe(localDateKey(NOW))
    expect(shouldReportNow(eff, NOW + 5 * 60 * 60 * 1000)).toBe(false) // no second report today
    expect(shouldReportNow(eff, NOW + 24 * 60 * 60 * 1000)).toBe(true) // tomorrow re-arms
  })

  it('in-process guard wins over a STALER sentinel file, loses to a fresher one', async () => {
    const older: DailyFuelSentinel = {
      lastReportDate: '2026-07-16', lastCutoffMs: NOW - 48 * 60 * 60 * 1000, lastSummary: null, proposal: null,
    }
    await writeFile(join(home, 'daily-fuel-report.json'), JSON.stringify(older))
    globalThis.__openground_fuel_memo = {
      lastReportDate: '2026-07-17', lastCutoffMs: NOW - 24 * 60 * 60 * 1000, lastSummary: null, proposal: null,
    }
    expect((await effectiveFuelSentinel())?.lastReportDate).toBe('2026-07-17')

    // A restart that DID write (fresher file) takes precedence again.
    const newer: DailyFuelSentinel = {
      lastReportDate: '2026-07-18', lastCutoffMs: NOW - 60_000, lastSummary: null, proposal: null,
    }
    await writeFile(join(home, 'daily-fuel-report.json'), JSON.stringify(newer))
    expect((await effectiveFuelSentinel())?.lastReportDate).toBe('2026-07-18')
  })

  it('window is clamped: a multi-day outage reports one day, not the whole outage', async () => {
    // The app was off for 5 days; the sentinel's cutoff is that old.
    await writeFile(
      join(home, 'daily-fuel-report.json'),
      JSON.stringify({
        lastReportDate: '2026-07-13',
        lastCutoffMs: NOW - 5 * 24 * 60 * 60 * 1000,
        lastSummary: null,
        proposal: null,
      } satisfies DailyFuelSentinel),
    )
    // 4 days old → outside the clamped window (unclamped, it would be counted,
    // and its 400k context would trip the degradation check on its own).
    const oldMs = NOW - 4 * 24 * 60 * 60 * 1000
    await writeSession(
      workerDir(UUID, 0), 'old.jsonl',
      sessionLines({ turns: 9, lastAtMs: oldMs, maxContext: 400_000 }), oldMs,
    )
    // Inside the last day → reported.
    const freshMs = NOW - QUIET_MS - 60 * 60 * 1000
    await writeSession(workerDir(UUID, 1), 'fresh.jsonl', sessionLines({ turns: 5, lastAtMs: freshMs }), freshMs)

    const r = await runDailyFuelReport({ now: NOW, claudeRoot })
    expect(r.summary.cards).toBe(1)
    expect(r.summary.medianTurns).toBe(5)
    expect(r.summary.maxContext).toBeLessThan(400_000)
  })

  // The loop reads the REAL clock (Date.now) inside its tick, and shouldReportNow
  // returns false before REPORT_HOUR_LOCAL — so these two tests used to be
  // silently vacuous whenever the suite ran before 09:00: the tick stayed quiet
  // because of the hour, not because of the guard, and breaking the guard still
  // left them green. Only Date is faked (setTimeout/setInterval stay real, since
  // the loop is built on setInterval).
  const withClockAt = (h: number): void => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 6, 18, h, 0, 0))
  }
  /** Poll a condition on REAL timers with a generous ceiling. Deliberately not
   *  a fixed sleep: a loaded machine makes `setTimeout(50)` a coin flip (this
   *  repo's known flaky-test pattern), and deliberately not a Date.now()
   *  deadline, which cannot advance while the clock is pinned. */
  const waitFor = async (pred: () => Promise<boolean>, tries = 200, gapMs = 25): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await pred()) return true
      await new Promise((r) => setTimeout(r, gapMs))
    }
    return false
  }

  it('loop boot tick honours the in-process guard even with no sentinel file', async () => {
    // Guard says "already reported today", disk says nothing — the boot
    // catch-up must stay quiet (proves the tick reads the effective state).
    withClockAt(10) // past REPORT_HOUR_LOCAL, so the HOUR cannot be what silences it
    globalThis.__openground_fuel_memo = {
      lastReportDate: localDateKey(Date.now()),
      lastCutoffMs: Date.now(),
      lastSummary: null,
      proposal: null,
    }
    startDailyFuelReportLoop(60 * 60 * 1000)
    // Wait for the tick to actually run and release, then assert on the silence
    // (rather than assuming a fixed delay was long enough to observe anything).
    expect(await waitFor(async () => globalThis.__openground_fuel_tick_inflight === false)).toBe(true)
    expect(await readNotifications()).toHaveLength(0)
  })

  it('loop boot tick DOES report when nothing has claimed today (positive control)', async () => {
    // The counterpart that gives the test above its teeth: same loop, same hour,
    // guard ABSENT ⇒ a report must appear. Without this, "no notification" is
    // not evidence the guard did anything.
    withClockAt(10)
    globalThis.__openground_fuel_memo = null
    startDailyFuelReportLoop(60 * 60 * 1000)
    expect(await waitFor(async () => (await readNotifications()).length > 0)).toBe(true)
  })

  it('loop boot tick stays quiet BEFORE the report hour', async () => {
    withClockAt(REPORT_HOUR_LOCAL - 1)
    globalThis.__openground_fuel_memo = null
    startDailyFuelReportLoop(60 * 60 * 1000)
    expect(await waitFor(async () => globalThis.__openground_fuel_tick_inflight === false)).toBe(true)
    expect(await readNotifications()).toHaveLength(0)
  })

  it('loop start/stop: idempotent, timer cleaned up', async () => {
    // Pre-mark "already reported today" so the loop's immediate boot tick
    // (which uses the REAL clock) is a guaranteed no-op — the test must not
    // depend on what wall-clock hour vitest happens to run at.
    await writeFile(
      join(home, 'daily-fuel-report.json'),
      JSON.stringify({
        lastReportDate: localDateKey(Date.now()),
        lastCutoffMs: Date.now(),
        lastSummary: null,
        proposal: null,
      } satisfies DailyFuelSentinel),
    )
    startDailyFuelReportLoop(60 * 60 * 1000)
    startDailyFuelReportLoop(60 * 60 * 1000) // re-entrant: replaces, never stacks
    expect(globalThis.__openground_fuel_report_timer).toBeTruthy()
    stopDailyFuelReportLoop()
    expect(globalThis.__openground_fuel_report_timer).toBeNull()
    stopDailyFuelReportLoop() // idempotent
  })
})
