// @vitest-environment jsdom
//
// Regression guard for the single-source worker fix (card 70874f): the worker
// tab and the manager monitor must show the SAME worker set — manual workers
// PLUS the engine's own workers — deduped by PTY id. The bug was the worker tab
// rendering ONLY the manual localStorage registry, so it sat empty while the
// autonomous engine had live workers. These tests lock the pure merge that both
// tabs now derive from, and assert the two tabs' projections agree.

import { describe, it, expect } from 'vitest'
import {
  mergeSwarmWorkers,
  sanitizeEngineState,
  sanitizeKpis,
  sanitizeConsumption,
  sanitizeFatalNotifications,
  planSwarmPower,
  EMPTY_KPIS,
  EMPTY_CONSUMPTION,
  DEFAULT_ENGINE,
  type EngineWorker,
  type ManualWorkerInput,
  type ManagerWorkerStage,
} from './useSwarmEngine'

const manual = (over: Partial<ManualWorkerInput> & { terminalId: string }): ManualWorkerInput => ({
  branch: `swarm/${over.terminalId}`,
  worktree: `/wt/${over.terminalId}`,
  taskId: `task-${over.terminalId}`,
  taskTitle: `Manual ${over.terminalId}`,
  ...over,
})

const engineWorker = (over: Partial<EngineWorker> & { terminalId: string }): EngineWorker => ({
  branch: `swarm/${over.terminalId}`,
  taskId: `task-${over.terminalId}`,
  taskTitle: `Engine ${over.terminalId}`,
  startedAt: '2026-06-24T00:00:00.000Z',
  stage: 'running',
  ...over,
})

// Mirror of how SwarmModule projects the unified list into the worker TAB tiles
// (it maps the views straight through) and into the manager MONITOR rows. Both
// derive from the SAME mergeSwarmWorkers output — these helpers just take the id
// set each view would key its tiles/rows on, so we can assert they agree.
const workerTabIds = (m: ReturnType<typeof mergeSwarmWorkers>) => m.map((w) => w.terminalId)
const managerMonitorIds = (m: ReturnType<typeof mergeSwarmWorkers>) =>
  m.map((w) => ({
    terminalId: w.terminalId,
    taskTitle: w.taskTitle,
    branch: w.branch,
    stage: (w.source === 'manual' ? 'running' : (w.engineStage ?? 'running')) as ManagerWorkerStage,
  })).map((r) => r.terminalId)

describe('mergeSwarmWorkers — the single worker source for both Swarm tabs', () => {
  it('includes engine-spawned workers (worker tab is no longer blind to them)', () => {
    const merged = mergeSwarmWorkers([], [engineWorker({ terminalId: 'eng-1' })])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ terminalId: 'eng-1', source: 'engine', engineStage: 'running' })
    // The empty-state bug: a non-empty engine set must yield a non-empty list.
    expect(merged.length).toBeGreaterThan(0)
  })

  it('unifies manual + engine workers, manual first then engine', () => {
    const merged = mergeSwarmWorkers(
      [manual({ terminalId: 'man-1' }), manual({ terminalId: 'man-2' })],
      [engineWorker({ terminalId: 'eng-1' }), engineWorker({ terminalId: 'eng-2' })],
    )
    expect(merged.map((w) => w.terminalId)).toEqual(['man-1', 'man-2', 'eng-1', 'eng-2'])
    expect(merged.map((w) => w.source)).toEqual(['manual', 'manual', 'engine', 'engine'])
  })

  it('dedupes by PTY id — the manual entry wins (it owns the worktree)', () => {
    const merged = mergeSwarmWorkers(
      [manual({ terminalId: 'shared', worktree: '/wt/real' })],
      [engineWorker({ terminalId: 'shared', taskTitle: 'engine dup' })],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ terminalId: 'shared', source: 'manual', worktree: '/wt/real' })
  })

  it('carries the worktree for manual workers and omits it for engine workers', () => {
    const merged = mergeSwarmWorkers(
      [manual({ terminalId: 'man-1', worktree: '/wt/man-1' })],
      [engineWorker({ terminalId: 'eng-1' })],
    )
    expect(merged.find((w) => w.terminalId === 'man-1')?.worktree).toBe('/wt/man-1')
    expect(merged.find((w) => w.terminalId === 'eng-1')?.worktree).toBeUndefined()
  })

  it('drops a forged duplicate manual id (untrusted localStorage), keeping the first', () => {
    const merged = mergeSwarmWorkers(
      [manual({ terminalId: 'dup', branch: 'first' }), manual({ terminalId: 'dup', branch: 'second' })],
      [],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].branch).toBe('first')
  })

  it('preserves the engine-reported stage (folds an absent stage to running)', () => {
    const merged = mergeSwarmWorkers(
      [],
      [
        engineWorker({ terminalId: 'eng-done', stage: 'done' }),
        engineWorker({ terminalId: 'eng-bare', stage: undefined }),
      ],
    )
    expect(merged.find((w) => w.terminalId === 'eng-done')?.engineStage).toBe('done')
    // The view records the raw (possibly absent) stage; SwarmModule folds the
    // absent case to 'running' when it projects the manager row.
    expect(merged.find((w) => w.terminalId === 'eng-bare')?.engineStage).toBeUndefined()
  })

  it('both tabs render the SAME worker set (the empty-state inconsistency is gone)', () => {
    const merged = mergeSwarmWorkers(
      [manual({ terminalId: 'man-1' })],
      [engineWorker({ terminalId: 'eng-1' }), engineWorker({ terminalId: 'eng-2' })],
    )
    const tab = workerTabIds(merged)
    const monitor = managerMonitorIds(merged)
    // Identical sets, in the same order — the worker tab and manager monitor key
    // their tiles/rows on the same ids. Engine workers appear in BOTH.
    expect(tab).toEqual(monitor)
    expect(tab).toContain('eng-1')
    expect(tab).toContain('eng-2')
    expect(monitor).toContain('eng-1')
  })

  it('empty in, empty out (no spurious rows)', () => {
    expect(mergeSwarmWorkers([], [])).toEqual([])
  })

  it('carries the engine worker phase/note through the merge (engine source only)', () => {
    const merged = mergeSwarmWorkers(
      [],
      [engineWorker({ terminalId: 'eng-1', phase: 'implement', note: 'wiring' })],
    )
    expect(merged[0]).toMatchObject({ source: 'engine', phase: 'implement', note: 'wiring' })
  })

  it('omits phase/note for manual workers (the engine reads no heartbeat for them)', () => {
    const merged = mergeSwarmWorkers([manual({ terminalId: 'man-1' })], [])
    expect(merged[0].phase).toBeUndefined()
    expect(merged[0].note).toBeUndefined()
  })
})

describe('sanitizeEngineState — engine workers survive the poll → merge path', () => {
  it('parses engine workers from a raw orchestrator response and feeds the merge', () => {
    const raw = {
      running: true,
      autoMerge: false,
      maxWorkers: 4,
      workers: [
        { terminalId: 'eng-1', branch: 'swarm/eng-1', taskId: 't1', taskTitle: 'T1', startedAt: 'x', stage: 'running' },
        { nope: true }, // malformed — must be dropped, not crash
      ],
      reviews: [],
      log: [],
    }
    const state = sanitizeEngineState(raw)
    expect(state.workers.map((w) => w.terminalId)).toEqual(['eng-1'])
    // End-to-end: the sanitized engine workers merge into the unified list.
    const merged = mergeSwarmWorkers([], state.workers)
    expect(merged.map((w) => w.terminalId)).toEqual(['eng-1'])
    expect(merged[0].source).toBe('engine')
  })

  it('a garbage response degrades to the empty default (no throw)', () => {
    expect(sanitizeEngineState(null).workers).toEqual([])
    expect(sanitizeEngineState('boom').workers).toEqual([])
    expect(mergeSwarmWorkers([], sanitizeEngineState(undefined).workers)).toEqual([])
  })

  it('preserves known structured log kinds and drops unknown ones', () => {
    const state = sanitizeEngineState({
      log: [
        { at: 'a', level: 'info', message: 'dispatch: X', kind: 'dispatch' },
        { at: 'b', level: 'info', message: 'worker crashed', kind: 'crash' },
        { at: 'c', level: 'info', message: 'slot freed', kind: 'routine' },
        { at: 'd', level: 'info', message: 'no tag', kind: undefined }, // meaningful, untagged
        { at: 'e', level: 'info', message: 'spoofed', kind: 'bogus' }, // unknown → dropped
      ],
    })
    // The tag drives the dashboard's noise filter + per-event chip, so each known
    // kind must survive the poll verbatim; anything unknown folds to "meaningful".
    expect(state.log.map((l) => l.kind)).toEqual(['dispatch', 'crash', 'routine', undefined, undefined])
  })

  it('sanitizes anomalies — keeps known kinds with a ref, drops malformed', () => {
    const state = sanitizeEngineState({
      anomalies: [
        { kind: 'orphan-doing', ref: 't1', branch: 'swarm/a', taskTitle: 'Card A' },
        { kind: 'worker-stale', ref: 'swarm/b', branch: 'swarm/b', staleMinutes: 42 },
        { kind: 'bogus', ref: 't2' }, // unknown kind → dropped
        { kind: 'orphan-doing' }, // no ref → dropped
        'nope', // not an object → dropped
      ],
    })
    expect(state.anomalies).toEqual([
      { kind: 'orphan-doing', ref: 't1', branch: 'swarm/a', taskTitle: 'Card A' },
      { kind: 'worker-stale', ref: 'swarm/b', branch: 'swarm/b', staleMinutes: 42 },
    ])
  })

  it('degrades to empty anomalies on a garbage response', () => {
    expect(sanitizeEngineState(null).anomalies).toEqual([])
    expect(sanitizeEngineState({ anomalies: 'boom' }).anomalies).toEqual([])
  })

  it('defaults kpis to the empty roll-up on a garbage / missing response', () => {
    expect(sanitizeEngineState(null).kpis).toEqual(EMPTY_KPIS)
    expect(sanitizeEngineState({}).kpis).toEqual(EMPTY_KPIS)
    expect(sanitizeKpis('boom')).toEqual(EMPTY_KPIS)
  })

  it('CLAMPS a forged rate into [0,1] (defence in depth — never renders "150%")', () => {
    const k = sanitizeKpis({
      conflictRate: 1.7, // a buggy/forged > 1 …
      reworkRate: -0.4, // … or < 0
      workerSuccessRate: 0.83, // a valid one passes through
      leadTime: { medianMs: 1000, count: 2 },
      counts: { dispatched: 5, integrated: 6, conflicted: 1, reworked: 1, crashed: 0, stalled: 0 },
    })
    expect(k.conflictRate).toBe(1)
    expect(k.reworkRate).toBe(0)
    expect(k.workerSuccessRate).toBeCloseTo(0.83)
  })

  it('keeps a null rate null (no data) and a negative count at 0', () => {
    const k = sanitizeKpis({ conflictRate: null, leadTime: { medianMs: null, count: -3 } })
    expect(k.conflictRate).toBeNull()
    expect(k.leadTime).toEqual({ medianMs: null, count: 0 })
  })

  // Consumption snapshot (the BUDGET layer) — same defensive coercion as kpis.
  it('defaults consumption to the empty snapshot on a garbage / missing response', () => {
    expect(sanitizeEngineState(null).consumption).toEqual(EMPTY_CONSUMPTION)
    expect(sanitizeEngineState({}).consumption).toEqual(EMPTY_CONSUMPTION)
    expect(sanitizeConsumption('boom')).toEqual(EMPTY_CONSUMPTION)
    expect(DEFAULT_ENGINE.consumption).toEqual(EMPTY_CONSUMPTION)
  })

  it('passes a well-formed consumption snapshot through, coercing overLimit to a strict boolean', () => {
    const c = sanitizeConsumption({
      activeWorkers: 2,
      activeRunMs: 90_000,
      dispatched: 51,
      limit: 50,
      overLimit: true,
    })
    expect(c).toEqual({ activeWorkers: 2, activeRunMs: 90_000, dispatched: 51, limit: 50, overLimit: true })
  })

  it('floors every numeric field to a finite ≥0 number and overLimit to false unless strictly true', () => {
    const c = sanitizeConsumption({
      activeWorkers: -3, // negative → 0
      activeRunMs: Number.NaN, // non-finite → 0
      dispatched: 'lots', // wrong type → 0
      limit: 50,
      overLimit: 'yes', // truthy-but-not-true → false (never a forged alarm)
    })
    expect(c).toEqual({ activeWorkers: 0, activeRunMs: 0, dispatched: 0, limit: 50, overLimit: false })
  })
})

// The single master power switch's contract (条件: 単一の開始/停止スイッチ). ON
// starts the engine AND launches the commander + supply conversations together;
// OFF stops the engine's NEW dispatch only and never touches the conversations.
// Every step is IDEMPOTENT — no double start, no double launch. This locks that
// contract so a future refactor can't silently re-introduce a twin launch or let
// OFF tear a running conversation down.
describe('planSwarmPower — the master Start/Stop switch contract', () => {
  it('ON from cold: starts the engine and launches BOTH conversations', () => {
    expect(planSwarmPower(true, { running: false, hasSupply: false, hasManager: false })).toEqual({
      engine: true,
      launchSupply: true,
      launchManager: true,
    })
  })

  it('ON is idempotent: nothing re-starts / re-launches when everything is already up', () => {
    // No `engine` key (the engine is already running) and no launches — 二重起動しない.
    expect(planSwarmPower(true, { running: true, hasSupply: true, hasManager: true })).toEqual({
      launchSupply: false,
      launchManager: false,
    })
  })

  it('ON launches ONLY the missing conversations (partial up)', () => {
    // Engine + supply already up, commander missing → launch only the commander.
    expect(planSwarmPower(true, { running: true, hasSupply: true, hasManager: false })).toEqual({
      launchSupply: false,
      launchManager: true,
    })
    // Engine down, commander up, supply missing → start engine + launch supply only.
    expect(planSwarmPower(true, { running: false, hasSupply: false, hasManager: true })).toEqual({
      engine: true,
      launchSupply: true,
      launchManager: false,
    })
  })

  it('OFF stops the engine ONLY — never launches or touches the conversations', () => {
    // 条件: オフは新規 dispatch の停止のみ（走行中 worker / 会話は kill しない）.
    expect(planSwarmPower(false, { running: true, hasSupply: true, hasManager: true })).toEqual({
      engine: false,
      launchSupply: false,
      launchManager: false,
    })
  })

  it('OFF while already stopped is a no-op (no engine key)', () => {
    expect(planSwarmPower(false, { running: false, hasSupply: false, hasManager: false })).toEqual({
      launchSupply: false,
      launchManager: false,
    })
  })

  it('OFF never launches a conversation even when one is missing', () => {
    // Powering down must not spawn supply/manager as a side effect.
    expect(planSwarmPower(false, { running: true, hasSupply: false, hasManager: false })).toEqual({
      engine: false,
      launchSupply: false,
      launchManager: false,
    })
  })
})

// The fatal-notifications sanitizer guards the flow pane's "needs attention" banner
// (条件3) against an untrusted on-disk notifications file — the same defensive
// discipline as sanitizeEngineState.
describe('sanitizeFatalNotifications — the fatal-event source (条件3)', () => {
  const wrap = (notifications: unknown) => ({ notifications })

  it('keeps swarm-fatal rows with a known event, mapping the fields', () => {
    const out = sanitizeFatalNotifications(
      wrap([
        {
          id: 'swarm-fatal:all-workers-down:x:1',
          kind: 'swarm-fatal',
          createdAt: 1000,
          swarmFatal: {
            event: 'all-workers-down',
            detail: '全ワーカー停止',
            branch: 'swarm/w5',
            projectPath: '/proj',
          },
        },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'swarm-fatal:all-workers-down:x:1',
      event: 'all-workers-down',
      detail: '全ワーカー停止',
      branch: 'swarm/w5',
      projectPath: '/proj',
      createdAt: 1000,
    })
  })

  it('drops non-swarm-fatal kinds, unknown events, and malformed rows', () => {
    const out = sanitizeFatalNotifications(
      wrap([
        { id: 'a', kind: 'collab-invite', collabInvite: {} }, // wrong kind
        { id: 'b', kind: 'swarm-fatal', swarmFatal: { event: 'made-up', detail: 'x' } }, // unknown event
        { id: 'c', kind: 'swarm-fatal' }, // no swarmFatal payload
        null,
        'nope',
      ]),
    )
    expect(out).toEqual([])
  })

  it('accepts every one of the five known events', () => {
    const events = ['rework-exhausted', 'all-workers-down', 'exec-timeout', 'rollback', 'canary-failed']
    const out = sanitizeFatalNotifications(
      wrap(events.map((event, i) => ({ id: `n${i}`, kind: 'swarm-fatal', createdAt: i, swarmFatal: { event } }))),
    )
    expect(out.map((n) => n.event).sort()).toEqual([...events].sort())
  })

  it('sorts newest-first and tolerates a non-array / non-object input', () => {
    const out = sanitizeFatalNotifications(
      wrap([
        { id: 'old', kind: 'swarm-fatal', createdAt: 100, swarmFatal: { event: 'rollback' } },
        { id: 'new', kind: 'swarm-fatal', createdAt: 900, swarmFatal: { event: 'exec-timeout' } },
      ]),
    )
    expect(out.map((n) => n.id)).toEqual(['new', 'old'])
    expect(sanitizeFatalNotifications(null)).toEqual([])
    expect(sanitizeFatalNotifications({ notifications: 'nope' })).toEqual([])
  })
})
