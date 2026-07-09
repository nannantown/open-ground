// Unit guard for the PURE overseer-feed derivations (swarmOverseerFeed.ts) that
// drive the Overseer tab's "needs attention" feed (SwarmOverseerPane). These
// lock the fatal-notification + anomaly surfacing (carried over from the removed
// Flow tab) and the relative-time token — all without a DOM, exactly like
// useSwarmEngine.test.ts does for its merges.

import { describe, it, expect } from 'vitest'
import { deriveOverseerAlerts, compactAge } from './swarmOverseerFeed'
import {
  DEFAULT_ENGINE,
  type EngineAnomaly,
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

const engineWith = (over: Partial<SwarmEngineState>): SwarmEngineState => ({
  ...DEFAULT_ENGINE,
  ...over,
})

describe('deriveOverseerAlerts — fatal notifications + anomalies', () => {
  it('surfaces ALL FIVE fatal-event kinds from the persisted notifications', () => {
    const notifs: SwarmFatalView[] = [
      fatal({ id: 'n1', event: 'rework-exhausted', taskId: 'task-1' }),
      fatal({ id: 'n2', event: 'all-workers-down' }),
      fatal({ id: 'n3', event: 'exec-timeout', branch: 'swarm/w5' }),
      fatal({ id: 'n4', event: 'rollback' }),
      fatal({ id: 'n5', event: 'canary-failed' }),
    ]
    const alerts = deriveOverseerAlerts(DEFAULT_ENGINE, notifs)
    expect(alerts).toHaveLength(5)
    expect(alerts.every((a) => a.source === 'fatal')).toBe(true)
    expect(alerts.map((a) => a.fatal?.event)).toEqual([
      'rework-exhausted', 'all-workers-down', 'exec-timeout', 'rollback', 'canary-failed',
    ])
  })

  it('puts the fatal notifications FIRST, then the engine anomalies', () => {
    const notifs = [fatal({ id: 'n1', event: 'all-workers-down' })]
    const anomalies: EngineAnomaly[] = [{ kind: 'worker-stale', ref: 'swarm/w1', staleMinutes: 14 }]
    const alerts = deriveOverseerAlerts(engineWith({ anomalies }), notifs)
    expect(alerts.map((a) => a.source)).toEqual(['fatal', 'anomaly'])
  })

  it('still surfaces anomalies when there are no fatal notifications', () => {
    const anomalies: EngineAnomaly[] = [
      { kind: 'orphan-doing', ref: 'task-1' },
      { kind: 'move-stuck', ref: 'task-2', intent: 'review', attempts: 5 },
    ]
    const alerts = deriveOverseerAlerts(engineWith({ anomalies }))
    expect(alerts).toHaveLength(2)
    expect(alerts.every((a) => a.source === 'anomaly')).toBe(true)
  })

  it('does NOT show a rework-exhausted twice (notification dedups the anomaly by ref)', () => {
    const notifs = [fatal({ id: 'n1', event: 'rework-exhausted', taskId: 'task-9' })]
    const anomalies: EngineAnomaly[] = [
      { kind: 'rework-exhausted', ref: 'task-9' }, // SAME card → deduped out
      { kind: 'rework-exhausted', ref: 'task-other' }, // different card → kept
    ]
    const alerts = deriveOverseerAlerts(engineWith({ anomalies }), notifs)
    expect(alerts).toHaveLength(2) // 1 notification + 1 (other) anomaly
    expect(alerts.filter((a) => a.source === 'anomaly')).toHaveLength(1)
    expect(alerts.find((a) => a.source === 'anomaly')?.anomaly?.ref).toBe('task-other')
  })

  it('is empty when nothing is wrong', () => {
    expect(deriveOverseerAlerts(DEFAULT_ENGINE, [])).toEqual([])
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
