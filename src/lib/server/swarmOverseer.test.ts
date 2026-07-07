// @vitest-environment node
//
// Overseer BRAINSTEM (EPIC C / C-core) — proves the §6 threshold table fires on the
// right edges, dedups, respects the brain budget, degrades under THROTTLE, and NEVER
// blocks the tick (fire-and-forget), all with FAKE deps (no real claude / PTY / fs):
//   • OFF by default (D1) — a disabled runtime does nothing, touches no dep.
//   • S1 rework-exhausted / S2 all-workers-down → the inbox, ONCE per rising edge.
//   • S4 free-text worker question → the proxy brain (T1): a confident answer is
//     injected (W16), an abstention/escalate lands in the inbox (T3) with a draft.
//   • Budget (L7) — throttle + day-cap + single-flight gate the brain.
//   • S9 usage-over → THROTTLED: the brain is skipped and S4 degrades to a bare raise.
//   • Fire-and-forget (D2) — an in-flight (never-resolving) brain never blocks the
//     pass and never launches a second brain.
//   • NEVER throws — a dep fault is swallowed + logged, the pass still returns.
//   • Every threshold read from OVERSEER_THRESHOLDS (no re-literalised constants).

import { describe, it, expect } from 'vitest'
import {
  runOverseerPass,
  initOverseerRuntime,
  defaultOverseerDeps,
  looksLikeQuestion,
  OVERSEER_THRESHOLDS,
  OVERSEER_SIGNALS,
  type OverseerEngine,
  type OverseerRuntime,
  type OverseerDeps,
} from './swarmOverseer'
import type { OwnerAnswer } from './swarmOverseerBrain'
import type { EscalationView, OrchestratorAnomaly, ProjectTask } from '../types'

// ── Fakes ────────────────────────────────────────────────────────────────────

interface Calls {
  answerAsOwner: { question: string }[]
  openEscalation: import('./swarmEscalations').OpenEscalationInput[]
  injectAnswer: { terminalId: string; text: string }[]
  notifyInfo: { event: string; detail: string }[]
  janitor: number
  canInject: number
}

const makeCalls = (): Calls => ({
  answerAsOwner: [],
  openEscalation: [],
  injectAnswer: [],
  notifyInfo: [],
  janitor: 0,
  canInject: 0,
})

/** A controllable clock the pass reads through deps.now(). */
const clock = (start = 1_000_000_000_000) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const makeDeps = (
  calls: Calls,
  over: Partial<OverseerDeps> = {},
): OverseerDeps => ({
  now: () => 1_000_000_000_000,
  isAlive: () => true,
  readHeartbeat: async () => null,
  answerAsOwner: async (q) => {
    calls.answerAsOwner.push({ question: q.question })
    return { kind: 'answer', text: 'デフォルトの回答', confidence: 'high' }
  },
  openEscalation: async (input) => {
    calls.openEscalation.push(input)
    return {
      escalation: { id: `esc-${calls.openEscalation.length}`, status: 'open' } as never,
      deduped: false,
    }
  },
  canInjectInto: async () => {
    calls.canInject += 1
    return true
  },
  injectAnswer: async (terminalId, text) => {
    calls.injectAnswer.push({ terminalId, text })
    return true
  },
  notifyInfo: async (n) => {
    calls.notifyInfo.push({ event: n.event, detail: n.detail })
    return {}
  },
  peekUsagePct: () => null,
  refreshUsage: () => {},
  listEscalations: async () => [],
  recentFatals: async () => [],
  runJanitor: async () => {
    calls.janitor += 1
    return {}
  },
  ...over,
})

const armed = (over: Partial<OverseerRuntime> = {}): OverseerRuntime => ({
  ...initOverseerRuntime(),
  enabled: true,
  // Push lastJanitorAt into the future so the incidental W6 janitor never fires in
  // signal tests (its own test drives it explicitly).
  lastJanitorAt: 2_000_000_000_000,
  ...over,
})

const makeEngine = (over: Partial<OverseerEngine> = {}): OverseerEngine => ({
  path: '/proj',
  running: true,
  anomalies: [],
  notified: new Set<string>(),
  workers: [],
  reviews: [],
  overseer: armed(),
  ...over,
})

const worker = (terminalId = 'term-1', branch = 'swarm/x', taskId = 'card-1') => ({
  terminalId,
  branch,
  taskId,
  taskTitle: 'あるカード',
})

// Flush the microtask + macrotask queue so a fire-and-forget brain's `.then/.finally`
// (which run AFTER the awaited pass returns) settle before we assert on the mailbox.
const flush = () => new Promise((r) => setTimeout(r, 0))

// ── OFF by default (D1) ────────────────────────────────────────────────────────

describe('overseer — armed/disarmed (D1)', () => {
  it('initOverseerRuntime is OFF and empty (default OFF, in-memory)', () => {
    const ov = initOverseerRuntime()
    expect(ov.enabled).toBe(false)
    expect(ov.assessInFlight).toBe(false)
    expect(ov.brainResults).toEqual([])
    expect(ov.seen.size).toBe(0)
    expect(ov.watch.size).toBe(0)
    expect(ov.brainCallsToday).toBe(0)
  })

  it('a DISABLED overseer does nothing — touches no dep, returns ran:false', async () => {
    const calls = makeCalls()
    const engine = makeEngine({
      overseer: { ...initOverseerRuntime(), enabled: false },
      anomalies: [{ kind: 'rework-exhausted', ref: 'card-1', attempts: 3 }],
      notified: new Set(['all-workers-down']),
    })
    const out = await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(out.ran).toBe(false)
    expect(calls.openEscalation).toHaveLength(0)
    expect(calls.answerAsOwner).toHaveLength(0)
    expect(calls.janitor).toBe(0)
  })
})

// ── S1 / S2 — fatal-derived escalations, rising edge + dedup ────────────────────

describe('overseer — S1 rework-exhausted', () => {
  const anomaly = (attempts: number): OrchestratorAnomaly => ({
    kind: 'rework-exhausted',
    ref: 'card-9',
    branch: 'swarm/nine',
    taskTitle: 'ナイン',
    attempts,
  })

  it('fires ONCE to the inbox on the rising edge, then dedups', async () => {
    const calls = makeCalls()
    const engine = makeEngine({ anomalies: [anomaly(2)] })

    const out1 = await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(out1.fired).toContain('S1')
    expect(calls.openEscalation).toHaveLength(1)
    expect(calls.openEscalation[0].whyEscalated).toBe('policy')
    expect(calls.openEscalation[0].taskId).toBe('card-9')

    // Same anomaly next pass → deduped (no second raise).
    const out2 = await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(out2.fired).not.toContain('S1')
    expect(calls.openEscalation).toHaveLength(1)
  })

  it('re-fires when the rework count moves (a genuinely new exhaustion)', async () => {
    const calls = makeCalls()
    const engine = makeEngine({ anomalies: [anomaly(2)] })
    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(calls.openEscalation).toHaveLength(1)

    engine.anomalies = [anomaly(3)] // count moved
    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(calls.openEscalation).toHaveLength(2)
  })

  it('re-fires after the anomaly clears and returns (prune → recurrence)', async () => {
    const calls = makeCalls()
    const engine = makeEngine({ anomalies: [anomaly(2)] })
    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(calls.openEscalation).toHaveLength(1)

    engine.anomalies = [] // cleared → pruned from seen
    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    engine.anomalies = [anomaly(2)] // same anomaly recurs
    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(calls.openEscalation).toHaveLength(2)
  })
})

describe('overseer — S2 all-workers-down', () => {
  it('fires ONCE from engine.notified, then dedups until cleared', async () => {
    const calls = makeCalls()
    const engine = makeEngine({ notified: new Set(['all-workers-down']) })

    const out1 = await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(out1.fired).toContain('S2')
    expect(calls.openEscalation).toHaveLength(1)

    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(calls.openEscalation).toHaveLength(1) // deduped

    engine.notified = new Set() // recovered → pruned
    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    engine.notified = new Set(['all-workers-down']) // recurs
    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(calls.openEscalation).toHaveLength(2)
  })
})

// ── S4 — worker free-text question → the proxy brain (T1) ───────────────────────

describe('overseer — S4 worker question (brain ignition)', () => {
  const blockedQuestion = (blockers: string) => async () => ({
    ready: false,
    blocked: true,
    blockers,
  })

  it('wakes the brain fire-and-forget, then injects a confident answer next pass', async () => {
    const calls = makeCalls()
    const engine = makeEngine({ workers: [worker()] })
    const deps = makeDeps(calls, {
      readHeartbeat: blockedQuestion('どのDBを使うべきですか？'),
      answerAsOwner: async (q) => {
        calls.answerAsOwner.push({ question: q.question })
        return { kind: 'answer', text: 'Postgres を使ってください', confidence: 'high' } as OwnerAnswer
      },
    })

    // Pass 1: launches the brain (fire-and-forget). The result is routed on the NEXT
    // pass's mailbox drain, so pass 1 injects nothing. (An INSTANT-resolving fake
    // settles during this pass's own awaits — the "brain stays in flight" property is
    // proved separately with a never-resolving brain; here we only need the routing.)
    const out1 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out1.fired).toContain('S4')
    expect(calls.answerAsOwner).toHaveLength(1)
    expect(calls.injectAnswer).toHaveLength(0)

    await flush() // let the detached brain settle → its result lands in the mailbox
    expect(engine.overseer.assessInFlight).toBe(false)
    expect(engine.overseer.brainResults).toHaveLength(1)

    // Pass 2: drains the mailbox → injects the answer into the live worker (W16).
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.injectAnswer).toHaveLength(1)
    expect(calls.injectAnswer[0].terminalId).toBe('term-1')
    expect(calls.injectAnswer[0].text).toContain('Postgres')
    expect(calls.openEscalation).toHaveLength(0) // answered, not escalated
  })

  it('routes an ABSTENTION to the inbox with a proxy draft (the E2E path)', async () => {
    const calls = makeCalls()
    const engine = makeEngine({ workers: [worker()] })
    const deps = makeDeps(calls, {
      readHeartbeat: blockedQuestion('この機能の価格はいくらにすべき？'),
      answerAsOwner: async () =>
        ({ kind: 'escalate', why: 'insufficient-info', reason: 'コーパスに価格判断の記録が薄い' }) as OwnerAnswer,
    })

    await runOverseerPass(engine, [], () => {}, deps) // launch
    await flush()
    await runOverseerPass(engine, [], () => {}, deps) // drain → escalate

    expect(calls.injectAnswer).toHaveLength(0)
    expect(calls.openEscalation).toHaveLength(1)
    const esc = calls.openEscalation[0]
    expect(esc.whyEscalated).toBe('insufficient-info')
    expect(esc.proxyDraft?.isAbstention).toBe(true)
    expect(esc.taskId).toBe('card-1')
  })

  it('does NOT wake the brain for a mechanical (non-question) blocker', async () => {
    const calls = makeCalls()
    const engine = makeEngine({ workers: [worker()] })
    const deps = makeDeps(calls, { readHeartbeat: blockedQuestion('依存パッケージのインストール待ち') })
    const out = await runOverseerPass(engine, [], () => {}, deps)
    expect(out.fired).not.toContain('S4')
    expect(calls.answerAsOwner).toHaveLength(0)
  })
})

// ── Budget (L7) — throttle, day cap, single-flight ─────────────────────────────

describe('overseer — brain budget (L7)', () => {
  const blocked = async () => ({ ready: false, blocked: true, blockers: 'どうすればいい？' })

  it('THROTTLE: a second question inside brainMinIntervalMs is skipped', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine({ workers: [worker('term-a', 'swarm/a', 'card-a')] })
    const deps = makeDeps(calls, { now: c.now, readHeartbeat: blocked })

    await runOverseerPass(engine, [], () => {}, deps)
    await flush()
    expect(calls.answerAsOwner).toHaveLength(1)

    // A DIFFERENT worker asks just under the throttle window → skipped.
    engine.workers = [worker('term-b', 'swarm/b', 'card-b')]
    c.advance(OVERSEER_THRESHOLDS.brainMinIntervalMs - 1)
    await runOverseerPass(engine, [], () => {}, deps)
    await flush()
    expect(calls.answerAsOwner).toHaveLength(1) // still 1 — throttled

    // Past the window → fires.
    c.advance(2)
    await runOverseerPass(engine, [], () => {}, deps)
    await flush()
    expect(calls.answerAsOwner).toHaveLength(2)
  })

  it('DAY CAP: no brain once brainCallsToday hits the cap', async () => {
    const calls = makeCalls()
    const engine = makeEngine({
      workers: [worker()],
      overseer: armed({ brainCallsToday: OVERSEER_THRESHOLDS.brainMaxPerDay, dayKey: new Date(1_000_000_000_000).toISOString().slice(0, 10) }),
    })
    const deps = makeDeps(calls, { readHeartbeat: blocked })
    const out = await runOverseerPass(engine, [], () => {}, deps)
    expect(out.fired).not.toContain('S4')
    expect(calls.answerAsOwner).toHaveLength(0)
  })

  it('SINGLE-FLIGHT: an in-flight brain blocks a second launch', async () => {
    const calls = makeCalls()
    // lastBrainAt = now (a RECENT launch) so the stuck-brain watchdog does NOT fire —
    // we are testing the healthy single-flight hold, not the force-release.
    const engine = makeEngine({
      workers: [worker()],
      overseer: armed({ assessInFlight: true, lastBrainAt: 1_000_000_000_000 }),
    })
    const deps = makeDeps(calls, { readHeartbeat: blocked })
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.answerAsOwner).toHaveLength(0)
  })
})

// ── S9 — usage-over THROTTLE (S4 degrades to a bare raise) ──────────────────────

describe('overseer — S9 THROTTLED degradation', () => {
  it('enters THROTTLED once (T3′ notice), degrades S4 to a bare inbox raise, recovers silently', async () => {
    const calls = makeCalls()
    let pct = 100
    const engine = makeEngine({ workers: [worker()] })
    const deps = makeDeps(calls, {
      peekUsagePct: () => pct,
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: '本番に出していい？' }),
    })

    // Pass 1: usage over → THROTTLED, one 'overseer-throttled' notice, and the worker
    // question goes STRAIGHT to the inbox (no brain).
    const out1 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out1.throttled).toBe(true)
    expect(out1.fired).toEqual(expect.arrayContaining(['S9', 'S4']))
    expect(calls.notifyInfo.filter((n) => n.event === 'overseer-throttled')).toHaveLength(1)
    expect(calls.answerAsOwner).toHaveLength(0) // brain paused
    expect(calls.openEscalation).toHaveLength(1) // bare question raised
    expect(calls.openEscalation[0].proxyDraft).toBeUndefined()

    // Pass 2 still over → no duplicate throttle notice (edge-triggered).
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.notifyInfo.filter((n) => n.event === 'overseer-throttled')).toHaveLength(1)

    // Recovery (<100) is silent and clears the flag.
    pct = 40
    const out3 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out3.throttled).toBe(false)
    expect(calls.notifyInfo.filter((n) => n.event === 'overseer-throttled')).toHaveLength(1)
  })

  it('a null usage % does NOT throttle (idle is not over — §5)', async () => {
    const calls = makeCalls()
    const engine = makeEngine()
    const out = await runOverseerPass(engine, [], () => {}, makeDeps(calls, { peekUsagePct: () => null }))
    expect(out.throttled).toBe(false)
  })
})

// ── Fire-and-forget (D2) — the tick is never blocked ───────────────────────────

describe('overseer — fire-and-forget (D2)', () => {
  it('an in-flight brain that never resolves neither blocks the pass nor launches a second', async () => {
    const calls = makeCalls()
    const engine = makeEngine({ workers: [worker()] })
    let launches = 0
    const deps = makeDeps(calls, {
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: 'どっち？' }),
      answerAsOwner: () => {
        launches += 1
        return new Promise<OwnerAnswer>(() => {}) // never resolves
      },
    })

    // The pass MUST resolve promptly even though the brain hangs forever.
    const out1 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out1.assessInFlight).toBe(true)
    expect(launches).toBe(1)

    // A second pass while the brain is still in flight launches NOTHING (single-flight).
    const out2 = await runOverseerPass(engine, [], () => {}, deps)
    expect(launches).toBe(1)
    expect(out2.assessInFlight).toBe(true)
  })

  it('WATCHDOG force-releases a brain stuck past timeout+slack (S4 never goes permanently silent)', async () => {
    const calls = makeCalls()
    const c = clock()
    // Seed a runtime that looks like a brain launched long ago and never settled.
    const engine = makeEngine({
      workers: [worker()],
      overseer: armed({ assessInFlight: true, lastBrainAt: c.now() }),
    })
    const logs: string[] = []
    const deps = makeDeps(calls, {
      now: c.now,
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: 'どうする？' }),
    })

    // Just under the deadline+slack → still held (single-flight), no new brain.
    c.advance(OVERSEER_THRESHOLDS.brainTimeoutMs + OVERSEER_THRESHOLDS.brainStuckSlackMs - 1_000)
    await runOverseerPass(engine, [], (_l, m) => logs.push(m), deps)
    expect(engine.overseer.assessInFlight).toBe(true)
    expect(calls.answerAsOwner).toHaveLength(0)

    // Well past the deadline+slack AND the 10-min throttle (the watchdog force-releases
    // but does NOT reset lastBrainAt, so the throttle must also have elapsed for the
    // pending S4 to wake a fresh brain).
    c.advance(OVERSEER_THRESHOLDS.brainMinIntervalMs)
    await runOverseerPass(engine, [], (_l, m) => logs.push(m), deps)
    expect(logs.some((m) => m.includes('force-released'))).toBe(true)
    expect(calls.answerAsOwner).toHaveLength(1) // no longer silenced
  })

  it('a STALE brain settling after a watchdog force-release does not clobber the NEW brain', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine({ workers: [worker('term-1', 'swarm/a', 'card-a')] })
    // Controllable brains: each launch parks a resolver so the test settles them
    // OUT OF ORDER (the stale one after the new one launched).
    const resolvers: Array<(a: OwnerAnswer) => void> = []
    const deps = makeDeps(calls, {
      now: c.now,
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: 'どっちにする？' }),
      answerAsOwner: (q) => {
        calls.answerAsOwner.push({ question: q.question })
        return new Promise<OwnerAnswer>((resolve) => {
          resolvers.push(resolve)
        })
      },
    })

    // Pass 1: brain #1 launches and HANGS.
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.answerAsOwner).toHaveLength(1)
    expect(engine.overseer.assessInFlight).toBe(true)

    // Past timeout+slack AND the throttle: the watchdog force-releases, and the
    // SAME pass wakes brain #2 for a DIFFERENT worker's question.
    engine.workers = [worker('term-2', 'swarm/b', 'card-b')]
    c.advance(
      OVERSEER_THRESHOLDS.brainTimeoutMs +
        OVERSEER_THRESHOLDS.brainStuckSlackMs +
        OVERSEER_THRESHOLDS.brainMinIntervalMs,
    )
    const logs: string[] = []
    await runOverseerPass(engine, [], (_l, m) => logs.push(m), deps)
    expect(logs.some((m) => m.includes('force-released'))).toBe(true)
    expect(calls.answerAsOwner).toHaveLength(2) // brain #2 in flight
    expect(engine.overseer.assessInFlight).toBe(true)
    const abort2 = engine.overseer.brainAbort
    expect(abort2).toBeDefined()

    // NOW the stale brain #1 settles. Its .finally must NOT release brain #2's
    // single-flight or abort handle (the clobber this guards against).
    resolvers[0]({ kind: 'answer', text: '古い回答', confidence: 'low' })
    await flush()
    expect(engine.overseer.assessInFlight).toBe(true) // #2 still holds the flight
    expect(engine.overseer.brainAbort).toBe(abort2) // #2's abort handle intact

    // Brain #2 settles normally → released by ITS OWN finally (the ownership
    // check never blocks the healthy path).
    resolvers[1]({ kind: 'answer', text: '新しい回答', confidence: 'high' })
    await flush()
    expect(engine.overseer.assessInFlight).toBe(false)
    expect(engine.overseer.brainAbort).toBeUndefined()
  })

  it('after a stale settle, the NEW brain is still watchdog-managed (abortable, never orphaned)', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine({ workers: [worker('term-1', 'swarm/a', 'card-a')] })
    const resolvers: Array<(a: OwnerAnswer) => void> = []
    const deps = makeDeps(calls, {
      now: c.now,
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: 'どっちにする？' }),
      answerAsOwner: (q) => {
        calls.answerAsOwner.push({ question: q.question })
        return new Promise<OwnerAnswer>((resolve) => {
          resolvers.push(resolve)
        })
      },
    })

    // Brain #1 hangs → watchdog force-release → brain #2 (same shape as above).
    await runOverseerPass(engine, [], () => {}, deps)
    engine.workers = [worker('term-2', 'swarm/b', 'card-b')]
    c.advance(
      OVERSEER_THRESHOLDS.brainTimeoutMs +
        OVERSEER_THRESHOLDS.brainStuckSlackMs +
        OVERSEER_THRESHOLDS.brainMinIntervalMs,
    )
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.answerAsOwner).toHaveLength(2)
    const abort2 = engine.overseer.brainAbort
    resolvers[0]({ kind: 'answer', text: '古い回答', confidence: 'low' }) // stale settle
    await flush()

    // Brain #2 now hangs past timeout+slack itself. Because the stale settle did
    // NOT clear assessInFlight, the watchdog still SEES #2 and force-releases it —
    // aborting through the intact handle. (The clobber orphaned exactly this: with
    // assessInFlight wiped, the watchdog went blind and #2 could never be aborted.)
    engine.workers = []
    c.advance(OVERSEER_THRESHOLDS.brainTimeoutMs + OVERSEER_THRESHOLDS.brainStuckSlackMs + 1)
    const logs: string[] = []
    await runOverseerPass(engine, [], (_l, m) => logs.push(m), deps)
    expect(logs.some((m) => m.includes('force-released'))).toBe(true)
    expect(abort2?.signal.aborted).toBe(true) // #2 was actually aborted, not orphaned
    expect(engine.overseer.assessInFlight).toBe(false)

    // The released #2 settling later is itself a stale settle now — a no-op.
    resolvers[1]({ kind: 'answer', text: '遅い回答', confidence: 'low' })
    await flush()
    expect(engine.overseer.assessInFlight).toBe(false)
    expect(engine.overseer.brainAbort).toBeUndefined()
  })
})

// ── S11/S3/S10 — sub-cycle seen-keys must survive non-subcycle prunes ──────────

describe('overseer — S11 inbox stale (sub-cycle dedup survives every-pass prune)', () => {
  const staleOpen = (c: { now: () => number }): EscalationView =>
    ({
      id: 'esc-stale',
      status: 'open',
      // Open for 6h + 1min at the CLOCK START — computed once so advancing the
      // clock ages it naturally.
      createdAt: new Date(c.now() - OVERSEER_THRESHOLDS.inboxStaleMs - 60_000).toISOString(),
    }) as EscalationView

  it('re-notifies ONCE per 6h bucket — not once per sub-cycle (crossing ≥2 boundaries)', async () => {
    const calls = makeCalls()
    const c = clock()
    const esc = staleOpen(c)
    const engine = makeEngine()
    const deps = makeDeps(calls, { now: c.now, listEscalations: async () => [esc] })
    const reminders = () => calls.notifyInfo.filter((n) => n.event === 'escalation-reminder').length

    // Pass 1 (first sub-cycle): the 6h-stale open record fires ONE reminder.
    const out1 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out1.fired).toContain('S11')
    expect(reminders()).toBe(1)

    // Interleave non-subcycle passes (the ~3s ticks) with TWO further sub-cycle
    // boundaries — all inside the SAME 6h bucket. The non-subcycle prune must not
    // drop the S11 key, so no further reminder fires on any of them.
    c.advance(3_000)
    await runOverseerPass(engine, [], () => {}, deps) // non-subcycle
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    await runOverseerPass(engine, [], () => {}, deps) // sub-cycle boundary #2
    c.advance(3_000)
    await runOverseerPass(engine, [], () => {}, deps) // non-subcycle
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    await runOverseerPass(engine, [], () => {}, deps) // sub-cycle boundary #3
    expect(reminders()).toBe(1) // still exactly one — no per-subcycle leak

    // The NEXT 6h bucket is a genuinely new dwell → exactly one more reminder.
    c.advance(OVERSEER_THRESHOLDS.inboxStaleMs)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(reminders()).toBe(2)
  })

  it('a resolved escalation is pruned on the SUB-CYCLE pass, and a genuine recurrence re-fires', async () => {
    const calls = makeCalls()
    const c = clock()
    const esc = staleOpen(c)
    let open: EscalationView[] = [esc]
    const engine = makeEngine()
    const deps = makeDeps(calls, { now: c.now, listEscalations: async () => open })
    const reminders = () => calls.notifyInfo.filter((n) => n.event === 'escalation-reminder').length

    await runOverseerPass(engine, [], () => {}, deps) // sub-cycle → reminder #1
    expect(reminders()).toBe(1)

    open = [] // answered/dismissed → condition resolved
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    await runOverseerPass(engine, [], () => {}, deps) // sub-cycle RAN → key prunable
    expect(engine.overseer.seen.has('S11:esc-stale')).toBe(false)

    open = [esc] // the same record recurs (genuine recurrence)
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(reminders()).toBe(2) // pruned dedup re-fires — §6 discipline intact
  })

  it('a transient listEscalations failure retains the S11 key — no duplicate reminder in-bucket (MF1 read-failure)', async () => {
    // Adversarial-review finding: the every-pass prune keys prunability on the
    // sub-cycle TIMER (doSubcycle), but a read that THREW used to swallow to [] and
    // read as 'all resolved' → the key was pruned and recovery re-notified inside
    // the same 6h bucket. A failed read must NOT conclude resolved.
    const calls = makeCalls()
    const c = clock()
    const esc = staleOpen(c)
    let failNext = false
    const engine = makeEngine()
    const deps = makeDeps(calls, {
      now: c.now,
      listEscalations: async () => {
        if (failNext) throw new Error('inbox read blew up')
        return [esc]
      },
    })
    const reminders = () => calls.notifyInfo.filter((n) => n.event === 'escalation-reminder').length

    // Pass 1 (sub-cycle): ONE reminder, records the S11 bucket key.
    await runOverseerPass(engine, [], () => {}, deps)
    expect(reminders()).toBe(1)
    expect(engine.overseer.seen.has('S11:esc-stale')).toBe(true)

    // Next sub-cycle READ FAILS → the key must survive (a blip ≠ 'resolved').
    failNext = true
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(engine.overseer.seen.has('S11:esc-stale')).toBe(true)

    // Read RECOVERS, SAME 6h bucket → must NOT re-notify (the churn the finding flags).
    failNext = false
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(reminders()).toBe(1)
  })
})

describe('overseer — S3/S10 edge fatals (sub-cycle dedup survives every-pass prune)', () => {
  it('the same fatal raises ONCE across non-subcycle passes and later sub-cycles', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [
        {
          event: 'exec-timeout',
          detail: '実行時間上限を超過',
          projectPath: '/proj',
          taskId: 'card-t',
          branch: 'swarm/t',
          taskTitle: 'タイムアウトしたカード',
        },
      ],
    })

    // Pass 1 (first sub-cycle): S3 raises to the inbox once.
    const out1 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out1.fired).toContain('S3')
    expect(calls.openEscalation).toHaveLength(1)

    // A non-subcycle pass must NOT churn the S3 dedup key…
    c.advance(3_000)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(Array.from(engine.overseer.seen.keys()).some((k) => k.startsWith('S3:exec-timeout:card-t'))).toBe(true)

    // …so the next sub-cycle does NOT re-raise the identical fatal.
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    const out3 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out3.fired).not.toContain('S3')
    expect(calls.openEscalation).toHaveLength(1)
  })

  it('two same-key fatals with different detail each raise ONCE — no per-subcycle ping-pong (MF1 finding 2)', async () => {
    // Adversarial-review finding: seen mapped ONE signalKey → ONE fp, so two fatals
    // sharing S3:exec-timeout:card-t but differing in detail (the same card timing
    // out twice at different run-minutes) overwrote each other's fp and BOTH re-raised
    // every ~60s sub-cycle. detail is now part of the key → each is a 1-shot slot.
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const twoFatals = [
      { event: 'exec-timeout' as const, detail: '上限30分を超過（31分稼働）', projectPath: '/proj', taskId: 'card-t', branch: 'swarm/t', taskTitle: 'T' },
      { event: 'exec-timeout' as const, detail: '上限30分を超過（45分稼働）', projectPath: '/proj', taskId: 'card-t', branch: 'swarm/t', taskTitle: 'T' },
    ]
    const deps = makeDeps(calls, { now: c.now, recentFatals: async () => twoFatals })

    // Pass 1 (sub-cycle): BOTH distinct occurrences raise — once each.
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.openEscalation).toHaveLength(2)

    // Next sub-cycle: neither re-raises (each owns a 1-shot key — no ping-pong churn).
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    const out2 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out2.fired).not.toContain('S3')
    expect(calls.openEscalation).toHaveLength(2)
  })

  it('a transient recentFatals failure retains S3 keys — no re-raise on recovery (MF1 read-failure)', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    let failNext = false
    const fatal = { event: 'exec-timeout' as const, detail: 'd', projectPath: '/proj', taskId: 'card-t', branch: 'swarm/t', taskTitle: 'T' }
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => {
        if (failNext) throw new Error('fatal store read blew up')
        return [fatal]
      },
    })

    await runOverseerPass(engine, [], () => {}, deps) // raise once
    expect(calls.openEscalation).toHaveLength(1)
    const keyCount = engine.overseer.seen.size

    // Sub-cycle READ FAILS → the S3 key must be RETAINED (not pruned as 'cleared').
    failNext = true
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(engine.overseer.seen.size).toBe(keyCount)

    // Read RECOVERS → must NOT re-raise the already-open fatal.
    failNext = false
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.openEscalation).toHaveLength(1)
  })
})

describe('overseer — S5 dwell survives a board-read blip (MF1 finding 3)', () => {
  const blockedCard = (id = 'card-b'): ProjectTask =>
    ({ id, title: 'ブロック中', boardColumn: 'blocked' }) as ProjectTask

  it('a tasks=null pass neither resets the dwell clock nor re-asks an already-raised S5', async () => {
    // Adversarial-review finding: on a board-read blip (tasks=null) the dwell
    // detectors are skipped, so S5/S7 keys fell out of activeSeen/activeWatch and the
    // every-pass prune reset the dwell clock / dropped the answered-card dedup. A
    // detector that didn't run must not conclude the condition resolved.
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const deps = makeDeps(calls, { now: c.now })
    const tasks = [blockedCard()]

    // Pass 1 starts the S5 dwell clock.
    await runOverseerPass(engine, tasks, () => {}, deps)
    const since = engine.overseer.watch.get('S5:card-b')?.since
    expect(since).toBeDefined()

    // A board-read blip (tasks=null) must NOT drop the watch entry / reset the clock.
    c.advance(60_000)
    await runOverseerPass(engine, null, () => {}, deps)
    expect(engine.overseer.watch.get('S5:card-b')?.since).toBe(since)

    // Past the 30min dwell → S5 raises ONCE.
    c.advance(OVERSEER_THRESHOLDS.blockedStuckMs)
    const out = await runOverseerPass(engine, tasks, () => {}, deps)
    expect(out.fired).toContain('S5')
    expect(calls.openEscalation).toHaveLength(1)

    // A blip AFTER the raise must NOT drop the S5 seen key → the answered card is not re-asked.
    c.advance(60_000)
    await runOverseerPass(engine, null, () => {}, deps)
    expect(engine.overseer.seen.has('S5:card-b')).toBe(true)
    c.advance(60_000)
    const out2 = await runOverseerPass(engine, tasks, () => {}, deps)
    expect(out2.fired).not.toContain('S5')
    expect(calls.openEscalation).toHaveLength(1)
  })
})

// ── Robustness — never throws into the tick ────────────────────────────────────

describe('overseer — never throws', () => {
  it('swallows + logs a dep fault, still returns ran:true', async () => {
    const logs: string[] = []
    const engine = makeEngine()
    const deps = makeDeps(makeCalls(), {
      peekUsagePct: () => {
        throw new Error('usage read blew up')
      },
    })
    const out = await runOverseerPass(engine, [], (_l, m) => logs.push(m), deps)
    expect(out.ran).toBe(true)
    expect(logs.some((m) => m.includes('pass errored'))).toBe(true)
  })

  it('an openEscalation rejection does not break the pass (S1 just does not stick)', async () => {
    const engine = makeEngine({ anomalies: [{ kind: 'rework-exhausted', ref: 'c', attempts: 2 }] })
    const deps = makeDeps(makeCalls(), {
      openEscalation: async () => {
        throw new Error('fs hiccup')
      },
    })
    const out = await runOverseerPass(engine, [], () => {}, deps)
    expect(out.ran).toBe(true)
    // seen was NOT set (raise failed) → the next pass will retry.
    expect(engine.overseer.seen.has('S1:c')).toBe(false)
  })
})

// ── Table + helpers ────────────────────────────────────────────────────────────

describe('overseer — threshold table + helpers', () => {
  it('OVERSEER_SIGNALS covers S1-S5, S7-S11 and NOT S6 (§11 Q4)', () => {
    const ids = OVERSEER_SIGNALS.map((s) => s.id)
    expect(ids).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S7', 'S8', 'S9', 'S10', 'S11'])
    expect(ids).not.toContain('S6')
  })

  it('OVERSEER_THRESHOLDS pins the documented numbers (single source)', () => {
    expect(OVERSEER_THRESHOLDS.brainMinIntervalMs).toBe(10 * 60_000)
    expect(OVERSEER_THRESHOLDS.brainMaxPerDay).toBe(24)
    expect(OVERSEER_THRESHOLDS.blockedStuckMs).toBe(30 * 60_000)
    expect(OVERSEER_THRESHOLDS.inboxStaleMs).toBe(6 * 60 * 60_000)
  })

  it('looksLikeQuestion distinguishes questions from mechanical blockers', () => {
    expect(looksLikeQuestion('どのAPIを使うべきですか？')).toBe(true)
    expect(looksLikeQuestion('Which database should I use?')).toBe(true)
    expect(looksLikeQuestion('waiting on the build to finish')).toBe(false)
    expect(looksLikeQuestion('')).toBe(false)
  })

  it('defaultOverseerDeps wires the real seams (smoke — shape only)', () => {
    const deps = defaultOverseerDeps({ isAlive: () => true, readHeartbeat: async () => null })
    expect(typeof deps.openEscalation).toBe('function')
    expect(typeof deps.answerAsOwner).toBe('function')
    expect(typeof deps.peekUsagePct).toBe('function')
    expect(typeof deps.runJanitor).toBe('function')
  })
})

// ── S8 — usage warn halves the day cap (a real S4 fires at the reduced cap) ─────

describe('overseer — S8 usage warn halves the brain cap', () => {
  it('at a warn %, the brain is capped at floor(max/2)', async () => {
    const calls = makeCalls()
    const halfCap = Math.floor(OVERSEER_THRESHOLDS.brainMaxPerDay / 2)
    const engine = makeEngine({
      workers: [worker()],
      overseer: armed({
        brainCallsToday: halfCap, // already at the HALVED cap
        dayKey: new Date(1_000_000_000_000).toISOString().slice(0, 10),
      }),
    })
    const deps = makeDeps(calls, {
      peekUsagePct: () => 85, // warn (80-100)
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: 'どう進める？' }),
    })
    const out = await runOverseerPass(engine, [], () => {}, deps)
    expect(out.fired).not.toContain('S4') // halved cap already reached
    expect(calls.answerAsOwner).toHaveLength(0)
  })
})
