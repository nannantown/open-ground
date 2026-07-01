// @vitest-environment node
//
// Self-supply (card b3fbbfba) — the commander engine proposing its OWN improvement
// cards. Proves the observable conditions WITHOUT spawning real tsc/lint/vitest:
//   (1) findings from every source (anomaly/tsc/lint/test/todo) become observable,
//       completion-conditioned todo cards.
//   (2) per-pass AND per-day caps stop the flood (runaway defense).
//   (3) a proposed card is owner-approval-gated — selectDispatch refuses it until
//       approveSelfSupplyCard runs.
//   (4) a finding already represented by an OPEN card is deduped (never re-carded).
//   (5) every fire + suppression lands in the engine journal (the log sink).
//   (6) the real readProjectData/writeProjectData round-trip persists the gate
//       fields (isolated HOME) — if the schema dropped them the gate would fail open.
//
// The pure parsers are unit-tested with sample tool output (no subprocess); the
// carding pipeline is driven with synthetic findings + an in-memory board.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { readProjectData } from './projectData'
import { selectDispatch } from './swarmOrchestrator'
import {
  runSelfSupplyPass,
  approveSelfSupplyCard,
  anomalyFindings,
  parseTscFindings,
  parseEslintFindings,
  parseVitestFindings,
  parseTodoFindings,
  openSelfSupplyKeys,
  initSelfSupplyRuntime,
  defaultBoard,
  type SelfSupplyEngine,
  type SelfSupplyDeps,
  type SelfSupplyBoard,
  type SelfSupplyFinding,
  type SelfSupplyConfig,
  type SelfSupplyLog,
} from './swarmSelfSupply'
import type { OrchestratorAnomaly, ProjectData, ProjectTask } from '../types'

// A fixed clock (2023-11-14), well within one UTC day for the two-pass cap test.
const T0 = 1_700_000_000_000

const mk = (over: Partial<ProjectTask>): ProjectTask => ({
  id: 'x',
  title: 't',
  done: false,
  createdAt: '2026-01-01T00:00:00Z',
  boardColumn: 'todo',
  ...over,
})

const finding = (n: number): SelfSupplyFinding => ({
  source: 'todo',
  key: `k${n}`,
  title: `自動提案: fix ${n}`,
  body: `do ${n}. 完了条件: テスト緑`,
})

/** An in-memory CAS board — the unit-test stand-in for readProjectData/write. */
const memBoard = (initial: ProjectTask[] = []) => {
  const state = {
    data: { description: '', tasks: initial.map((t) => ({ ...t })), notes: '', updatedAt: 't0' } as ProjectData,
    writes: 0,
  }
  const board: SelfSupplyBoard = {
    read: async () => ({ ...state.data, tasks: state.data.tasks.map((t) => ({ ...t })) }),
    write: async (_p, next, opts) => {
      if (opts?.expectUpdatedAt !== undefined && opts.expectUpdatedAt !== state.data.updatedAt) {
        throw new Error('conflict')
      }
      state.writes++
      state.data = { ...next, tasks: next.tasks.map((t) => ({ ...t })), updatedAt: `t${state.writes}` }
      return state.data
    },
  }
  return { board, state }
}

const mkDeps = (board: SelfSupplyBoard, todoFindings: SelfSupplyFinding[] = [], nowMs = T0): SelfSupplyDeps => ({
  now: () => nowMs,
  board,
  scanTypeErrors: async () => [],
  scanLintErrors: async () => [],
  scanTestFailures: async () => [],
  scanTodoComments: async () => todoFindings,
})

const engine = (over: Partial<SelfSupplyEngine> = {}): SelfSupplyEngine => ({
  path: '/proj',
  anomalies: [],
  selfSupply: { ...initSelfSupplyRuntime(), enabled: true },
  ...over,
})

const collectLog = () => {
  const lines: { level: 'info' | 'warn'; message: string }[] = []
  const log: SelfSupplyLog = (level, message) => lines.push({ level, message })
  return { lines, log }
}

const NOOP: SelfSupplyLog = () => {}
const CFG: SelfSupplyConfig = { maxPerPass: 5, maxPerDay: 10, intervalMs: 0 }

// ── Guards: disarmed + throttled are no-ops ───────────────────────────────────

describe('self-supply gating (disarmed / throttled)', () => {
  it('does NOTHING when disarmed (default OFF — the ignition guard)', async () => {
    const { board, state } = memBoard()
    const e = engine({ selfSupply: { ...initSelfSupplyRuntime(), enabled: false } })
    const out = await runSelfSupplyPass(e, NOOP, mkDeps(board, [finding(1)]), CFG)
    expect(out.scanned).toBe(false)
    expect(out.proposed).toHaveLength(0)
    expect(state.data.tasks).toHaveLength(0)
  })

  it('does NOTHING inside the throttle window (no re-scan every tick)', async () => {
    const { board, state } = memBoard()
    const e = engine({ selfSupply: { enabled: true, lastScanAt: T0, dayKey: '', dayCount: 0 } })
    const out = await runSelfSupplyPass(e, NOOP, mkDeps(board, [finding(1)], T0 + 500), {
      maxPerPass: 5,
      maxPerDay: 5,
      intervalMs: 60_000,
    })
    expect(out.scanned).toBe(false)
    expect(state.data.tasks).toHaveLength(0)
  })
})

// ── Detection → carding ───────────────────────────────────────────────────────

describe('self-supply carding', () => {
  it('cards a discovered finding into todo as an approval-gated card + logs the fire', async () => {
    const { board, state } = memBoard()
    const { lines, log } = collectLog()
    const out = await runSelfSupplyPass(engine(), log, mkDeps(board, [finding(1)]), CFG)
    expect(out.scanned).toBe(true)
    expect(out.proposed.map((f) => f.key)).toEqual(['k1'])
    expect(state.data.tasks).toHaveLength(1)
    const card = state.data.tasks[0]
    expect(card.boardColumn).toBe('todo')
    expect(card.selfSupplyKey).toBe('k1')
    expect(card.selfSupplyApproved).toBe(false)
    expect(card.done).toBe(false)
    expect(card.notes).toContain('完了条件')
    expect(lines.some((l) => l.level === 'info' && l.message.includes('self-supply: 提案'))).toBe(true)
  })

  it('turns engine anomalies into cards with observable completion conditions', async () => {
    const { board, state } = memBoard()
    const e = engine({
      anomalies: [{ kind: 'orphan-doing', ref: 'task-x', branch: 'swarm/x', taskTitle: 'Orphan' }],
    })
    const out = await runSelfSupplyPass(e, NOOP, mkDeps(board, []), CFG)
    expect(out.proposed.map((f) => f.key)).toEqual(['anomaly:orphan-doing:task-x'])
    expect(state.data.tasks[0].selfSupplyKey).toBe('anomaly:orphan-doing:task-x')
    expect(state.data.tasks[0].notes).toContain('完了条件')
  })
})

// ── Caps (runaway defense) ────────────────────────────────────────────────────

describe('self-supply caps', () => {
  it('per-pass cap: only maxPerPass land, the rest are held + logged', async () => {
    const { board, state } = memBoard()
    const { lines, log } = collectLog()
    const out = await runSelfSupplyPass(engine(), log, mkDeps(board, [1, 2, 3, 4, 5].map(finding)), {
      maxPerPass: 2,
      maxPerDay: 10,
      intervalMs: 0,
    })
    expect(out.proposed).toHaveLength(2)
    expect(out.suppressed.filter((s) => s.reason === 'per-pass-cap')).toHaveLength(3)
    expect(state.data.tasks).toHaveLength(2)
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('上限到達'))).toBe(true)
  })

  it('per-day cap: holds across passes once the daily budget is spent', async () => {
    const { board, state } = memBoard()
    const e = engine()
    const cfg: SelfSupplyConfig = { maxPerPass: 2, maxPerDay: 3, intervalMs: 0 }
    // pass 1 (k1..k5): per-pass cap → 2 land (k1,k2), dayCount → 2.
    const o1 = await runSelfSupplyPass(e, NOOP, mkDeps(board, [1, 2, 3, 4, 5].map(finding), T0), cfg)
    expect(o1.proposed.map((f) => f.key)).toEqual(['k1', 'k2'])
    expect(e.selfSupply.dayCount).toBe(2)
    // pass 2 (same day): k1,k2 dedup; daily budget leaves room for ONE more (k3);
    // k4,k5 hit the daily cap.
    const o2 = await runSelfSupplyPass(e, NOOP, mkDeps(board, [1, 2, 3, 4, 5].map(finding), T0 + 1), cfg)
    expect(o2.proposed.map((f) => f.key)).toEqual(['k3'])
    expect(o2.suppressed.some((s) => s.reason === 'daily-cap')).toBe(true)
    expect(o2.suppressed.some((s) => s.reason === 'duplicate')).toBe(true)
    expect(state.data.tasks).toHaveLength(3)
    expect(e.selfSupply.dayCount).toBe(3)
  })
})

// ── Dedup ─────────────────────────────────────────────────────────────────────

describe('self-supply dedup', () => {
  it('skips a finding already represented by an OPEN card (todo/doing/review)', async () => {
    const { board } = memBoard([mk({ id: 'e1', boardColumn: 'doing', selfSupplyKey: 'k1' })])
    const { lines, log } = collectLog()
    const out = await runSelfSupplyPass(engine(), log, mkDeps(board, [finding(1), finding(2)]), CFG)
    expect(out.proposed.map((f) => f.key)).toEqual(['k2'])
    expect(out.suppressed.some((s) => s.reason === 'duplicate' && s.finding.key === 'k1')).toBe(true)
    expect(lines.some((l) => l.message.includes('既出') && l.message.includes('重複検出'))).toBe(true)
  })

  it('RE-proposes a finding whose only matching card already landed (a regression)', async () => {
    const { board } = memBoard([mk({ id: 'd1', done: true, boardColumn: 'done', selfSupplyKey: 'k1' })])
    const out = await runSelfSupplyPass(engine(), NOOP, mkDeps(board, [finding(1)]), CFG)
    expect(out.proposed.map((f) => f.key)).toEqual(['k1'])
  })
})

// ── Write-failure safety (CAS conflict holds everything) ──────────────────────

describe('self-supply write safety', () => {
  it('a board write failure cards nothing + holds the day budget, logs the hold', async () => {
    const board: SelfSupplyBoard = {
      read: async () => ({ description: '', tasks: [], notes: '', updatedAt: 't0' }),
      write: async () => {
        throw new Error('conflict')
      },
    }
    const e = engine()
    const { lines, log } = collectLog()
    const out = await runSelfSupplyPass(e, log, mkDeps(board, [finding(1)]), CFG)
    expect(out.scanned).toBe(true)
    expect(out.proposed).toHaveLength(0)
    expect(e.selfSupply.dayCount).toBe(0)
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('保留'))).toBe(true)
  })
})

// ── Dispatch gate (owner approval) ────────────────────────────────────────────

describe('selectDispatch self-supply approval gate (⑥)', () => {
  it('holds an unapproved self-supplied card; dispatches once approved', () => {
    const gated = mk({ id: 'g', selfSupplyKey: 'k1' })
    expect(selectDispatch([gated], new Set(), 5)).toHaveLength(0)
    const approved = mk({ id: 'a', selfSupplyKey: 'k1', selfSupplyApproved: true })
    expect(selectDispatch([approved], new Set(), 5).map((c) => c.id)).toEqual(['a'])
  })

  it('never gates a human-authored card (no selfSupplyKey)', () => {
    const normal = mk({ id: 'n' })
    expect(selectDispatch([normal], new Set(), 5).map((c) => c.id)).toEqual(['n'])
  })

  it('a held proposal does not block a sibling todo behind it', () => {
    const gated = mk({ id: 'g', selfSupplyKey: 'k1', createdAt: '2026-01-01T00:00:00Z' })
    const normal = mk({ id: 'n', createdAt: '2026-01-02T00:00:00Z' })
    expect(selectDispatch([gated, normal], new Set(), 5).map((c) => c.id)).toEqual(['n'])
  })
})

describe('approveSelfSupplyCard', () => {
  it('approves a self-supplied card (idempotent), no-op for normal/absent cards', async () => {
    const { board, state } = memBoard([mk({ id: 'c1', selfSupplyKey: 'k1' }), mk({ id: 'c2' })])
    expect((await approveSelfSupplyCard('/proj', 'c1', board)).approved).toBe(true)
    expect(state.data.tasks.find((t) => t.id === 'c1')?.selfSupplyApproved).toBe(true)
    // idempotent — already approved
    expect((await approveSelfSupplyCard('/proj', 'c1', board)).approved).toBe(false)
    // a human card carries no selfSupplyKey — nothing to approve
    expect((await approveSelfSupplyCard('/proj', 'c2', board)).approved).toBe(false)
    // absent card
    expect((await approveSelfSupplyCard('/proj', 'nope', board)).approved).toBe(false)
  })
})

// ── Pure parsers (sample tool output → findings, no subprocess) ────────────────

describe('finding parsers', () => {
  it('anomalyFindings: stable keys + observable completion bodies per kind', () => {
    const anoms: OrchestratorAnomaly[] = [
      { kind: 'orphan-doing', ref: 't1', branch: 'swarm/a', taskTitle: 'Card A' },
      { kind: 'worker-stale', ref: 'swarm/b', branch: 'swarm/b', staleMinutes: 42 },
      { kind: 'rework-exhausted', ref: 't3', taskTitle: 'Card C', attempts: 3 },
    ]
    const fs = anomalyFindings(anoms)
    expect(fs.map((f) => f.key)).toEqual([
      'anomaly:orphan-doing:t1',
      'anomaly:worker-stale:swarm/b',
      'anomaly:rework-exhausted:t3',
    ])
    expect(fs.every((f) => f.source === 'anomaly')).toBe(true)
    expect(fs.every((f) => f.body.includes('完了条件'))).toBe(true)
    expect(fs[1].body).toContain('42')
  })

  it('parseTscFindings: one finding per (file, code), line drift collapsed', () => {
    const out = parseTscFindings(
      [
        "src/foo.ts(12,5): error TS2322: Type 'X' is not assignable to 'Y'.",
        'src/foo.ts(20,1): error TS2322: another instance',
        "src/bar.ts(3,3): error TS1005: ';' expected.",
        'not an error line',
      ].join('\n'),
    )
    expect(out.map((f) => f.key).sort()).toEqual(['tsc:src/bar.ts:TS1005', 'tsc:src/foo.ts:TS2322'])
    expect(out.every((f) => f.source === 'tsc')).toBe(true)
    expect(out.find((f) => f.key.includes('foo'))?.body).toContain('npx tsc --noEmit')
  })

  it('parseEslintFindings: errors only (severity 2), relativized, keyed by file+rule', () => {
    const json = JSON.stringify([
      {
        filePath: '/root/src/a.ts',
        messages: [
          { ruleId: 'no-unused-vars', severity: 2, message: 'x is unused' },
          { ruleId: 'prefer-const', severity: 1, message: 'warn only' },
        ],
      },
      { filePath: '/root/src/b.ts', messages: [] },
    ])
    const out = parseEslintFindings(json, '/root')
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('lint:src/a.ts:no-unused-vars')
    expect(out[0].body).toContain('npm run lint')
  })

  it('parseEslintFindings: malformed JSON → no findings (never throws)', () => {
    expect(parseEslintFindings('{ not json')).toEqual([])
  })

  it('parseVitestFindings: failed assertions only, keyed by full name', () => {
    const json = JSON.stringify({
      testResults: [
        {
          name: '/root/x.test.ts',
          assertionResults: [
            { fullName: 'suite > passes', status: 'passed' },
            { fullName: 'suite > fails', status: 'failed' },
          ],
        },
      ],
    })
    const out = parseVitestFindings(json)
    expect(out.map((f) => f.key)).toEqual(['test:suite > fails'])
    expect(out[0].body).toContain('npm test')
  })

  it('parseTodoFindings: one per (file, comment), whitespace-folded dedup', () => {
    const out = parseTodoFindings(
      [
        'src/x.ts:10:  // TODO: handle null',
        'src/x.ts:99:  // TODO:  handle null ', // moved + double-spaced → same key
        'src/y.ts:1:// FIXME: broken',
      ].join('\n'),
    )
    expect(out.map((f) => f.key).sort()).toEqual([
      'todo:src/x.ts:// todo: handle null',
      'todo:src/y.ts:// fixme: broken',
    ])
  })
})

describe('openSelfSupplyKeys', () => {
  it('collects self-supply keys of OPEN cards only (done excluded, keyless ignored)', () => {
    const tasks: ProjectTask[] = [
      mk({ id: '1', boardColumn: 'todo', selfSupplyKey: 'a' }),
      mk({ id: '2', boardColumn: 'doing', selfSupplyKey: 'b' }),
      mk({ id: '3', boardColumn: 'review', selfSupplyKey: 'c' }),
      mk({ id: '4', boardColumn: 'done', done: true, selfSupplyKey: 'd' }),
      mk({ id: '5', boardColumn: 'todo' }),
    ]
    expect(Array.from(openSelfSupplyKeys(tasks)).sort()).toEqual(['a', 'b', 'c'])
  })
})

// ── Real board, isolated HOME (the schema round-trip + dispatch end to end) ────

describe('self-supply — real board (isolated HOME)', () => {
  let home: string
  let scratch: string
  let savedHome: string | undefined

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'og-ss-home-')))
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-ss-scratch-')))
    savedHome = process.env.OPENGROUND_HOME
    process.env.OPENGROUND_HOME = home
    __resetMigrationCacheForTests()
  })
  afterEach(async () => {
    if (savedHome === undefined) delete process.env.OPENGROUND_HOME
    else process.env.OPENGROUND_HOME = savedHome
    __resetMigrationCacheForTests()
    await rm(home, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  it('a finding persists as an approval-gated todo card; a 2nd scan dedups; approval makes it dispatchable', async () => {
    const proj = join(scratch, 'proj')
    await mkdir(proj, { recursive: true })
    await addProjectEntry(proj) // register so readProjectData/writeProjectData resolve

    const e: SelfSupplyEngine = {
      path: proj,
      anomalies: [{ kind: 'orphan-doing', ref: 'tX', branch: 'swarm/x', taskTitle: 'Orphan' }],
      selfSupply: { ...initSelfSupplyRuntime(), enabled: true },
    }
    const deps: SelfSupplyDeps = {
      now: () => T0,
      board: defaultBoard(), // the REAL readProjectData/writeProjectData
      scanTypeErrors: async () => [],
      scanLintErrors: async () => [],
      scanTestFailures: async () => [],
      scanTodoComments: async () => [],
    }
    const cfg: SelfSupplyConfig = { maxPerPass: 3, maxPerDay: 5, intervalMs: 0 }

    const o1 = await runSelfSupplyPass(e, NOOP, deps, cfg)
    expect(o1.proposed).toHaveLength(1)

    const data1 = await readProjectData(proj)
    expect(data1.tasks).toHaveLength(1)
    const card = data1.tasks[0]
    // The schema round-trip kept the gate fields (if schemas.ts dropped them this fails).
    expect(card.selfSupplyKey).toBe('anomaly:orphan-doing:tX')
    expect(card.selfSupplyApproved).toBe(false)
    expect(card.boardColumn).toBe('todo')
    // Gated: not dispatchable yet.
    expect(selectDispatch(data1.tasks, new Set(), 5)).toHaveLength(0)

    // Second scan: same anomaly → deduped, nothing added.
    const o2 = await runSelfSupplyPass(e, NOOP, deps, cfg)
    expect(o2.proposed).toHaveLength(0)
    expect(o2.suppressed.some((s) => s.reason === 'duplicate')).toBe(true)
    expect((await readProjectData(proj)).tasks).toHaveLength(1)

    // Owner approval via the real board → now dispatchable.
    expect((await approveSelfSupplyCard(proj, card.id)).approved).toBe(true)
    const data3 = await readProjectData(proj)
    expect(data3.tasks[0].selfSupplyApproved).toBe(true)
    expect(selectDispatch(data3.tasks, new Set(), 5).map((c) => c.id)).toEqual([card.id])
  })
})
