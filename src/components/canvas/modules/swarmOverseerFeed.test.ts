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

/** "the owner has dismissed nothing" — spelled out at every call site because
 *  deriveOverseerAlerts deliberately has no default for it. */
const NONE: ReadonlySet<string> = new Set()

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
    const alerts = deriveOverseerAlerts(DEFAULT_ENGINE, notifs, NONE)
    expect(alerts).toHaveLength(5)
    expect(alerts.every((a) => a.source === 'fatal')).toBe(true)
    expect(alerts.map((a) => a.fatal?.event)).toEqual([
      'rework-exhausted', 'all-workers-down', 'exec-timeout', 'rollback', 'canary-failed',
    ])
  })

  it('puts the fatal notifications FIRST, then the engine anomalies', () => {
    const notifs = [fatal({ id: 'n1', event: 'all-workers-down' })]
    const anomalies: EngineAnomaly[] = [{ kind: 'worker-stale', ref: 'swarm/w1', staleMinutes: 14 }]
    const alerts = deriveOverseerAlerts(engineWith({ anomalies }), notifs, NONE)
    expect(alerts.map((a) => a.source)).toEqual(['fatal', 'anomaly'])
  })

  it('still surfaces anomalies when there are no fatal notifications', () => {
    const anomalies: EngineAnomaly[] = [
      { kind: 'orphan-doing', ref: 'task-1' },
      { kind: 'move-stuck', ref: 'task-2', intent: 'review', attempts: 5 },
    ]
    const alerts = deriveOverseerAlerts(engineWith({ anomalies }), [], NONE)
    expect(alerts).toHaveLength(2)
    expect(alerts.every((a) => a.source === 'anomaly')).toBe(true)
  })

  it('does NOT show a rework-exhausted twice (notification dedups the anomaly by ref)', () => {
    const notifs = [fatal({ id: 'n1', event: 'rework-exhausted', taskId: 'task-9' })]
    const anomalies: EngineAnomaly[] = [
      { kind: 'rework-exhausted', ref: 'task-9' }, // SAME card → deduped out
      { kind: 'rework-exhausted', ref: 'task-other' }, // different card → kept
    ]
    const alerts = deriveOverseerAlerts(engineWith({ anomalies }), notifs, NONE)
    expect(alerts).toHaveLength(2) // 1 notification + 1 (other) anomaly
    expect(alerts.filter((a) => a.source === 'anomaly')).toHaveLength(1)
    expect(alerts.find((a) => a.source === 'anomaly')?.anomaly?.ref).toBe('task-other')
  })

  it('is empty when nothing is wrong', () => {
    expect(deriveOverseerAlerts(DEFAULT_ENGINE, [], NONE)).toEqual([])
  })
})

// GUARD (2026-08-04, 5th adversarial cycle): the feed could never go quiet again.
// Fatal notifications are PERSISTED and never expire — they leave only by falling
// out of the 50-row cap — so the very first fatal event of an install pinned the
// "needs attention" section open for good, and SwarmOverseerPane's quiet state
// ("nothing needs you") became unreachable. A permanently-lit alert panel is one
// nobody reads, which costs exactly the alerts it was built to deliver.
describe('deriveOverseerAlerts — the owner can clear what they have handled', () => {
  it('hides a fatal the owner marked handled', () => {
    const notifs = [
      fatal({ id: 'n1', event: 'all-workers-down' }),
      fatal({ id: 'n2', event: 'exec-timeout' }),
    ]
    const alerts = deriveOverseerAlerts(DEFAULT_ENGINE, notifs, new Set(['n1']))
    expect(alerts.map((a) => a.fatal?.id)).toEqual(['n2'])
  })

  it('CAN REACH QUIET: every fatal handled and no drift ⇒ nothing to show', () => {
    const notifs = [
      fatal({ id: 'n1', event: 'rollback' }),
      fatal({ id: 'n2', event: 'guard-unwired' }),
    ]
    expect(deriveOverseerAlerts(DEFAULT_ENGINE, notifs, new Set(['n1', 'n2']))).toEqual([])
  })

  it('marking history handled does NOT hide live engine drift', () => {
    // The notification records something that happened once; the anomaly is
    // present-tense state. Acking the first must not silence the second — hiding
    // live drift would be a silent failure, the direction CLAUDE.md forbids.
    const notifs = [fatal({ id: 'n1', event: 'rework-exhausted', taskId: 'task-9' })]
    const anomalies: EngineAnomaly[] = [{ kind: 'rework-exhausted', ref: 'task-9' }]
    const alerts = deriveOverseerAlerts(engineWith({ anomalies }), notifs, new Set(['n1']))
    expect(alerts.map((a) => a.source)).toEqual(['anomaly'])
  })

  it('the mirrored engine-level events are shown ONCE while the notification stands', () => {
    // MEASURED 2026-08-04. 'all-workers-down' and 'manager-unrevivable' now
    // arrive on BOTH lanes for the same fact — the one-shot notification wakes
    // the owner, the every-pass anomaly keeps a STANDING failure visible after
    // they dismiss it. That is deliberate, but while the notification is still
    // showing they are the same sentence twice, in a feed whose own header warns
    // that a list which repeats itself is one nobody reads.
    const notifs = [fatal({ id: 'n1', event: 'all-workers-down' })]
    const anomalies: EngineAnomaly[] = [{ kind: 'all-workers-down', ref: 'engine', attempts: 2 }]
    const alerts = deriveOverseerAlerts(engineWith({ anomalies }), notifs, NONE)
    expect(alerts.map((a) => a.source)).toEqual(['fatal']) // the richer row wins
  })

  it('…and the anomaly TAKES OVER the moment the notification is dismissed', () => {
    // The whole reason the mirror exists: dismissing history must not hide a
    // condition that is still true.
    const notifs = [fatal({ id: 'n1', event: 'all-workers-down' })]
    const anomalies: EngineAnomaly[] = [{ kind: 'all-workers-down', ref: 'engine', attempts: 2 }]
    const alerts = deriveOverseerAlerts(engineWith({ anomalies }), notifs, new Set(['n1']))
    expect(alerts.map((a) => a.source)).toEqual(['anomaly'])
  })

  it('nothing dismissed ⇒ everything shows — degrade LOUD', () => {
    // The dismissal set has NO default parameter on purpose: a call site that
    // forgets it is a build error, not a feed that silently stops hiding rows.
    const notifs = [fatal({ id: 'n1', event: 'all-workers-down' })]
    expect(deriveOverseerAlerts(DEFAULT_ENGINE, notifs, NONE)).toHaveLength(1)
  })

  it('hides a row the SERVER says was handled, with no local set at all', () => {
    // The durable half: `handled` comes from the notification's own `handledAt`,
    // so a dismissal survives a reload / another window. Without it the feed
    // would light up again on every restart and the quiet state would last only
    // until the next launch.
    const notifs = [
      fatal({ id: 'n1', event: 'all-workers-down', handled: true }),
      fatal({ id: 'n2', event: 'exec-timeout' }),
    ]
    expect(deriveOverseerAlerts(DEFAULT_ENGINE, notifs, NONE).map((a) => a.fatal?.id)).toEqual(['n2'])
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
