// Unit guard for the PURE flow derivations (swarmFlow.ts) that drive the Swarm
// loop visualization (SwarmFlowPane). These lock the worker-stage mapping, the
// heartbeat-liveness thresholds, the fatal-notification + anomaly surfacing
// (条件3), the pipeline summary, the event-feed noise filter, and the relative-time
// token — all without a DOM, exactly like useSwarmEngine.test.ts does for its merges.

import { describe, it, expect } from 'vitest'
import {
  stageFromPhase,
  workerStage,
  heartbeatLiveness,
  deriveFatalEvents,
  summarizeFlow,
  meaningfulEvents,
  isFlowIdle,
  compactAge,
  FRESH_MS,
  STALE_MS,
} from './swarmFlow'
import {
  DEFAULT_ENGINE,
  type EngineWorker,
  type EngineReview,
  type EngineAnomaly,
  type EngineLogLine,
  type SwarmEngineState,
  type SwarmFatalView,
  type SwarmFatalEventKind,
} from './useSwarmEngine'

const NOW = Date.parse('2026-06-29T12:00:00.000Z')
const agoMs = (ms: number) => new Date(NOW - ms).toISOString()

const fatal = (
  over: Partial<SwarmFatalView> & { id: string; event: SwarmFatalEventKind },
): SwarmFatalView => ({
  detail: `detail ${over.id}`,
  createdAt: NOW - 1_000,
  ...over,
})

const worker = (over: Partial<EngineWorker> & { terminalId: string }): EngineWorker => ({
  branch: `swarm/${over.terminalId}`,
  taskId: `task-${over.terminalId}`,
  taskTitle: `Card ${over.terminalId}`,
  startedAt: agoMs(60_000),
  ...over,
})

const review = (over: Partial<EngineReview> & { taskId: string }): EngineReview => ({
  branch: `swarm/${over.taskId}`,
  taskTitle: `Card ${over.taskId}`,
  status: 'unknown',
  ...over,
})

const logLine = (over: Partial<EngineLogLine> & { id: string }): EngineLogLine => ({
  at: agoMs(1_000),
  level: 'info',
  message: `line ${over.id}`,
  ...over,
})

const engineWith = (over: Partial<SwarmEngineState>): SwarmEngineState => ({
  ...DEFAULT_ENGINE,
  ...over,
})

describe('stageFromPhase — heartbeat phase → fine stage', () => {
  it('maps the canonical /order phases', () => {
    expect(stageFromPhase('audit')).toBe('audit')
    expect(stageFromPhase('implement')).toBe('implement')
    expect(stageFromPhase('testing')).toBe('verify')
    expect(stageFromPhase('done')).toBe('awaiting')
    expect(stageFromPhase('blocked')).toBe('blocked')
    expect(stageFromPhase('init')).toBe('starting')
  })

  it('matches bilingual / synonym phrases on a substring', () => {
    expect(stageFromPhase('検証中・tsc/lint 確認')).toBe('verify')
    expect(stageFromPhase('実装をすすめている')).toBe('implement')
    expect(stageFromPhase('監査おわり')).toBe('audit')
    expect(stageFromPhase('統合可・テスト緑')).toBe('awaiting') // 'awaiting' wins before 'verify'
    expect(stageFromPhase('詰まってます')).toBe('blocked')
  })

  it('is case-insensitive and falls back to implement for an unknown but present phase', () => {
    expect(stageFromPhase('TESTING')).toBe('verify')
    expect(stageFromPhase('refactoring the thing')).toBe('implement')
  })

  it('returns undefined for an empty / nullish phase', () => {
    expect(stageFromPhase('')).toBeUndefined()
    expect(stageFromPhase(undefined)).toBeUndefined()
    expect(stageFromPhase(null)).toBeUndefined()
  })
})

describe('workerStage — phase wins, coarse stage is the fallback', () => {
  it('prefers the fine heartbeat phase over the coarse stage', () => {
    expect(workerStage({ phase: 'testing', stage: 'running' })).toBe('verify')
  })

  it('falls back to the coarse stage when there is no phase', () => {
    expect(workerStage({ stage: 'starting' })).toBe('starting')
    expect(workerStage({ stage: 'done' })).toBe('awaiting')
    expect(workerStage({ stage: 'running' })).toBe('implement')
  })

  it('defaults to implement when neither phase nor stage is present', () => {
    expect(workerStage({})).toBe('implement')
  })
})

describe('heartbeatLiveness — fresh / aging / stale / none by age', () => {
  it('buckets by the documented thresholds', () => {
    expect(heartbeatLiveness(agoMs(10_000), NOW)).toBe('fresh') // 10s
    expect(heartbeatLiveness(agoMs(FRESH_MS - 1), NOW)).toBe('fresh')
    expect(heartbeatLiveness(agoMs(FRESH_MS + 1), NOW)).toBe('aging')
    expect(heartbeatLiveness(agoMs(STALE_MS - 1), NOW)).toBe('aging')
    expect(heartbeatLiveness(agoMs(STALE_MS + 1), NOW)).toBe('stale')
  })

  it('treats a missing / unparseable / future timestamp sensibly', () => {
    expect(heartbeatLiveness(undefined, NOW)).toBe('none')
    expect(heartbeatLiveness('', NOW)).toBe('none')
    expect(heartbeatLiveness('not-a-date', NOW)).toBe('none')
    expect(heartbeatLiveness(agoMs(-5_000), NOW)).toBe('fresh') // small clock skew
  })
})

describe('deriveFatalEvents — fatal notifications + anomalies (条件3)', () => {
  it('surfaces ALL FIVE fatal-event kinds from the persisted notifications', () => {
    const notifs: SwarmFatalView[] = [
      fatal({ id: 'n1', event: 'rework-exhausted', taskId: 'task-1' }),
      fatal({ id: 'n2', event: 'all-workers-down' }),
      fatal({ id: 'n3', event: 'exec-timeout', branch: 'swarm/w5' }),
      fatal({ id: 'n4', event: 'rollback' }),
      fatal({ id: 'n5', event: 'canary-failed' }),
    ]
    const alerts = deriveFatalEvents(DEFAULT_ENGINE, notifs)
    expect(alerts).toHaveLength(5)
    expect(alerts.every((a) => a.source === 'fatal')).toBe(true)
    expect(alerts.map((a) => a.fatal?.event)).toEqual([
      'rework-exhausted', 'all-workers-down', 'exec-timeout', 'rollback', 'canary-failed',
    ])
  })

  it('puts the fatal notifications FIRST, then the engine anomalies', () => {
    const notifs = [fatal({ id: 'n1', event: 'all-workers-down' })]
    const anomalies: EngineAnomaly[] = [{ kind: 'worker-stale', ref: 'swarm/w1', staleMinutes: 14 }]
    const alerts = deriveFatalEvents(engineWith({ anomalies }), notifs)
    expect(alerts.map((a) => a.source)).toEqual(['fatal', 'anomaly'])
  })

  it('still surfaces anomalies when there are no fatal notifications', () => {
    const anomalies: EngineAnomaly[] = [
      { kind: 'orphan-doing', ref: 'task-1' },
      { kind: 'move-stuck', ref: 'task-2', intent: 'review', attempts: 5 },
    ]
    const alerts = deriveFatalEvents(engineWith({ anomalies }))
    expect(alerts).toHaveLength(2)
    expect(alerts.every((a) => a.source === 'anomaly')).toBe(true)
  })

  it('does NOT show a rework-exhausted twice (notification dedups the anomaly by ref)', () => {
    const notifs = [fatal({ id: 'n1', event: 'rework-exhausted', taskId: 'task-9' })]
    const anomalies: EngineAnomaly[] = [
      { kind: 'rework-exhausted', ref: 'task-9' }, // SAME card → deduped out
      { kind: 'rework-exhausted', ref: 'task-other' }, // different card → kept
    ]
    const alerts = deriveFatalEvents(engineWith({ anomalies }), notifs)
    expect(alerts).toHaveLength(2) // 1 notification + 1 (other) anomaly
    expect(alerts.filter((a) => a.source === 'anomaly')).toHaveLength(1)
    expect(alerts.find((a) => a.source === 'anomaly')?.anomaly?.ref).toBe('task-other')
  })

  it('is empty when nothing is wrong', () => {
    expect(deriveFatalEvents(DEFAULT_ENGINE, [])).toEqual([])
  })
})

describe('summarizeFlow — the pipeline station counts', () => {
  it('buckets workers by fine stage and tallies reviews / integrations', () => {
    const engine = engineWith({
      running: true,
      workers: [
        worker({ terminalId: 'w1', phase: 'audit' }),
        worker({ terminalId: 'w2', phase: 'implement' }),
        worker({ terminalId: 'w3', phase: 'testing' }),
        worker({ terminalId: 'w4', phase: 'done' }),
      ],
      reviews: [
        review({ taskId: 'r1', status: 'ff' }),
        review({ taskId: 'r2', status: 'conflict' }),
        review({ taskId: 'r3', status: 'rebase' }),
      ],
      log: [
        logLine({ id: 'i1', kind: 'integrate' }),
        logLine({ id: 'i2', kind: 'integrate' }),
        logLine({ id: 'd1', kind: 'dispatch' }),
      ],
    })
    const s = summarizeFlow(engine, true)
    expect(s.engineRunning).toBe(true)
    expect(s.workerCount).toBe(4)
    expect(s.byStage).toMatchObject({ audit: 1, implement: 1, verify: 1, awaiting: 1 })
    expect(s.reviewCount).toBe(3)
    expect(s.reviewReady).toBe(1)
    expect(s.reviewBlocked).toBe(1)
    expect(s.recentIntegrations).toBe(2)
  })

  it('is all-zero on the default (empty) engine', () => {
    const s = summarizeFlow(DEFAULT_ENGINE, false)
    expect(s.workerCount).toBe(0)
    expect(s.reviewCount).toBe(0)
    expect(s.recentIntegrations).toBe(0)
    expect(s.available).toBe(false)
  })
})

describe('meaningfulEvents — drops routine, newest first, capped', () => {
  it('hides routine bookkeeping but keeps uncategorized + categorized events', () => {
    const log: EngineLogLine[] = [
      logLine({ id: '1', kind: 'routine' }),
      logLine({ id: '2', kind: 'dispatch' }),
      logLine({ id: '3' }), // no kind = uncategorized meaningful → kept
      logLine({ id: '4', kind: 'integrate' }),
    ]
    const events = meaningfulEvents(engineWith({ log }))
    expect(events.map((e) => e.id)).toEqual(['4', '3', '2']) // newest first, routine gone
  })

  it('caps to the requested maximum', () => {
    const log: EngineLogLine[] = Array.from({ length: 30 }, (_, i) =>
      logLine({ id: `n${i}`, kind: 'dispatch' }),
    )
    expect(meaningfulEvents(engineWith({ log }), 5)).toHaveLength(5)
  })
})

describe('isFlowIdle — stopped and nothing in flight', () => {
  it('is idle on a stopped, empty engine with no fatal notifications', () => {
    expect(isFlowIdle(DEFAULT_ENGINE)).toBe(true)
    expect(isFlowIdle(DEFAULT_ENGINE, [])).toBe(true)
  })

  it('is NOT idle while running, or with workers / reviews / anomalies in flight', () => {
    expect(isFlowIdle(engineWith({ running: true }))).toBe(false)
    expect(isFlowIdle(engineWith({ workers: [worker({ terminalId: 'w1' })] }))).toBe(false)
    expect(isFlowIdle(engineWith({ reviews: [review({ taskId: 'r1' })] }))).toBe(false)
    expect(isFlowIdle(engineWith({ anomalies: [{ kind: 'orphan-doing', ref: 'task-1' }] }))).toBe(false)
  })

  it('is NOT idle when a fatal notification is pending (it must keep the banner up)', () => {
    expect(isFlowIdle(DEFAULT_ENGINE, [fatal({ id: 'n1', event: 'rollback' })])).toBe(false)
  })
})

describe('compactAge — language-neutral relative token', () => {
  it('formats seconds / minutes / hours / days', () => {
    expect(compactAge(agoMs(30_000), NOW)).toBe('30s')
    expect(compactAge(agoMs(4 * 60_000), NOW)).toBe('4m')
    expect(compactAge(agoMs(2 * 3_600_000), NOW)).toBe('2h')
    expect(compactAge(agoMs(3 * 86_400_000), NOW)).toBe('3d')
  })

  it('clamps a future timestamp to 0s and returns null on bad input', () => {
    expect(compactAge(agoMs(-10_000), NOW)).toBe('0s')
    expect(compactAge(undefined, NOW)).toBeNull()
    expect(compactAge('nope', NOW)).toBeNull()
  })
})
