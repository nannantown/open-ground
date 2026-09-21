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
import type { EscalationView, OrchestratorAnomaly, ProjectTask } from '../types'

// ── Fakes ────────────────────────────────────────────────────────────────────

interface Calls {
  openEscalation: import('./swarmEscalations').OpenEscalationInput[]
  notifyInfo: { event: string; detail: string }[]
  janitor: number
}

const makeCalls = (): Calls => ({
  openEscalation: [],
  notifyInfo: [],
  janitor: 0,
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
  openEscalation: async (input) => {
    calls.openEscalation.push(input)
    return {
      escalation: { id: `esc-${calls.openEscalation.length}`, status: 'open' } as never,
      deduped: false,
    }
  },
  notifyInfo: async (n) => {
    calls.notifyInfo.push({ event: n.event, detail: n.detail })
    return {}
  },
  peekUsagePct: () => null,
  refreshUsage: () => {},
  listEscalations: async () => [],
  listReceiptKeys: async () => new Set<string>(),
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

describe('owner questions without Persona', () => {
  it.each([null, 20, 85, 100])('delivers directly at usage %s and deduplicates later ticks', async (usage) => {
    const calls = makeCalls()
    const engine = makeEngine({ workers: [{ ...worker(), runtime: 'sdk', terminalId: '', sdkSessionId: 'sdk-owner-question' }] })
    const deps = makeDeps(calls, {
      peekUsagePct: () => usage,
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: 'May I publish this release?' }),
    })
    await runOverseerPass(engine, [], () => {}, deps)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.openEscalation).toHaveLength(1)
    expect(calls.openEscalation[0]).toMatchObject({
      question: 'May I publish this release?',
      runtime: 'sdk',
      sdkSessionId: 'sdk-owner-question',
    })
    expect(calls.openEscalation[0]).not.toHaveProperty('proxyDraft')
  })

  it('retries a failed inbox write without losing the question', async () => {
    const calls = makeCalls()
    const engine = makeEngine({ workers: [worker()] })
    const deps = makeDeps(calls, {
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: 'May I publish this release?' }),
    })
    await runOverseerPass(engine, [], () => {}, { ...deps, openEscalation: async () => { throw new Error('disk unavailable') } })
    expect(engine.overseer.seen.has('S4:term-1')).toBe(false)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.openEscalation).toHaveLength(1)
    expect(calls.openEscalation[0].question).toBe('May I publish this release?')
  })
})

// ── OFF by default (D1) ────────────────────────────────────────────────────────

describe('overseer — armed/disarmed (D1)', () => {
  it('initOverseerRuntime is OFF and empty (default OFF, in-memory)', () => {
    const ov = initOverseerRuntime()
    expect(ov.enabled).toBe(false)
    expect(ov.seen.size).toBe(0)
    expect(ov.watch.size).toBe(0)
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
    // 平易文 rides every overseer TEMPLATE raise (non-programmer owner surface):
    // ①決めること ②選択肢 ③影響 — here just pin presence + the A/B shape.
    expect(calls.openEscalation[0].plainQuestion).toContain('A: ')
    expect(calls.openEscalation[0].plainQuestion).toContain('B: ')
    expect(calls.openEscalation[0].plainQuestion).toContain('ナイン')

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
    expect(calls.openEscalation[0].plainQuestion).toContain('AIが全員止まって')
    expect(calls.openEscalation[0].plainQuestion).toContain('A: ')

    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(calls.openEscalation).toHaveLength(1) // deduped

    engine.notified = new Set() // recovered → pruned
    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    engine.notified = new Set(['all-workers-down']) // recurs
    await runOverseerPass(engine, [], () => {}, makeDeps(calls))
    expect(calls.openEscalation).toHaveLength(2)
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
    expect(calls.openEscalation).toHaveLength(1) // bare question raised
    expect(calls.openEscalation[0]).not.toHaveProperty('proxyDraft')

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
    // The store record's append time is FIXED (append-once) — capture it before
    // the clock advances, like the real store would.
    const createdAt = c.now()
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [
        {
          fatal: {
            event: 'exec-timeout',
            detail: '実行時間上限を超過',
            projectPath: '/proj',
            taskId: 'card-t',
            branch: 'swarm/t',
            taskTitle: 'タイムアウトしたカード',
          },
          createdAt,
        },
      ],
    })

    // Pass 1 (first sub-cycle): S3 raises to the inbox once.
    const out1 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out1.fired).toContain('S3')
    expect(calls.openEscalation).toHaveLength(1)
    // 平易文: what happened + A/B + consequences, in everyday language; the
    // technical detail stays in `context` (c.f.detail) untouched.
    expect(calls.openEscalation[0].plainQuestion).toContain('持ち時間を使い切った')
    expect(calls.openEscalation[0].plainQuestion).toContain('タイムアウトしたカード')
    expect(calls.openEscalation[0].plainQuestion).toContain('A: ')
    expect(calls.openEscalation[0].context).toBe('実行時間上限を超過')

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

  it('a ready worker\'s exec-timeout does NOT offer the owner "split it up and retry" (2026-07-18)', async () => {
    // One event, two situations. A worker that had ALREADY delivered is stopped
    // with its work on the branch and its card back in 'review' — the integration
    // call is the commander's, not the owner's. The legacy A ("作業を小さく分けて、
    // もう一度やらせる") is actively harmful here: an answered escalation whose
    // worker is gone rides into the card's NEXT dispatch as a directive, so that
    // answer would order a fresh worker to redo work that is already delivered.
    // 0718 harm (c) — a judgement-free card piled into the owner's queue.
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [
        {
          fatal: {
            event: 'exec-timeout',
            execTimeoutKind: 'integration-wait',
            detail: '一度 ready に到達したワーカーが、差し戻し後の再作業で作業上限に到達',
            projectPath: '/proj',
            taskId: 'card-t',
            branch: 'swarm/t',
            taskTitle: '計測器カード',
          },
          createdAt: c.now(),
        },
      ],
    })

    expect((await runOverseerPass(engine, [], () => {}, deps)).fired).toContain('S3')
    const { plainQuestion, question } = calls.openEscalation[0]
    // The destructive option is GONE — this is the assertion that fails if the
    // flavor stops being carried through the fatal.
    expect(plainQuestion).not.toContain('作業を小さく分けて')
    expect(question).not.toContain('分割して再依頼')
    // …replaced by an honest one: nothing for the owner to decide but abandonment.
    expect(plainQuestion).toContain('あなたが決めることは基本ありません')
    expect(plainQuestion).toContain('A: ')
    expect(plainQuestion).toContain('B: ')
    expect(plainQuestion).toContain('計測器カード')
    // plainQuestion renders as RAW text (whitespace-pre-wrap, no markdown), so
    // markup would show up literally in the owner's inbox.
    expect(plainQuestion).not.toContain('**')
  })

  it('a LONG-QUEUE stop never tells the owner about a 手直し that did not happen', async () => {
    // execTimeoutReworked:false = ready, then simply queued past the credit cap.
    // Nothing was re-worked, so the plain text must not say 「その後の手直しが…」.
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [
        {
          fatal: {
            event: 'exec-timeout',
            execTimeoutKind: 'integration-wait',
            execTimeoutShape: 'capped-wait',
            detail: '統合待ちが長引いたため停止',
            projectPath: '/proj',
            taskId: 'card-q',
            branch: 'swarm/q',
            taskTitle: '週末レビューのカード',
          },
          createdAt: c.now(),
        },
      ],
    })

    await runOverseerPass(engine, [], () => {}, deps)
    const { plainQuestion, question } = calls.openEscalation[0]
    expect(plainQuestion).not.toContain('手直しが持ち時間を使い切って')
    expect(question).not.toContain('差し戻し後の再作業')
    expect(plainQuestion).toContain('手直しはしていません')
    expect(plainQuestion).toContain('順番待ち')
    // still not an owner decision, and still no destructive re-dispatch option
    expect(plainQuestion).not.toContain('作業を小さく分けて')
    expect(plainQuestion).toContain('あなたが決めることは基本ありません')
    expect(plainQuestion).not.toContain('**') // renders as raw text
  })

  it('a WORK overrun blames neither the queue nor a 手直し (MF1 — the shape the 2-way split dropped)', async () => {
    // The gap the boolean left. The engine has THREE shapes but the notification
    // carried a 2-valued flag, so the kept-promote / short-wait worker arrived with
    // "not reworked" and the owner was told 「取り込みの順番待ちが長引いた…時間を
    // 使い切った原因は待ち時間」 — about a worker that waited zero minutes and
    // worked the entire time. The detail said the opposite in the same card.
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [
        {
          fatal: {
            event: 'exec-timeout',
            execTimeoutKind: 'integration-wait',
            execTimeoutShape: 'work',
            detail: '実作業が作業上限に到達',
            projectPath: '/proj',
            taskId: 'card-w',
            branch: 'swarm/w',
            taskTitle: '働き続けたカード',
          },
          createdAt: c.now(),
        },
      ],
    })

    await runOverseerPass(engine, [], () => {}, deps)
    const { plainQuestion, question } = calls.openEscalation[0]
    // neither fiction
    expect(plainQuestion).not.toContain('順番待ちが長引いた')
    expect(plainQuestion).not.toContain('手直しが持ち時間を使い切って')
    expect(question).not.toContain('差し戻し後の再作業')
    expect(question).not.toContain('統合待ちが控除上限')
    // …and it says the true thing
    expect(plainQuestion).toContain('順番待ちのせいではありません')
    expect(question).toContain('待ち時間が原因ではありません')
    // still not an owner decision, still no destructive re-dispatch option
    expect(plainQuestion).toContain('あなたが決めることは基本ありません')
    expect(plainQuestion).not.toContain('作業を小さく分けて')
    expect(plainQuestion).not.toContain('**')
  })

  it('a REAL rework overrun still says 手直し (the split must not silence the true case)', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [
        {
          fatal: {
            event: 'exec-timeout',
            execTimeoutKind: 'integration-wait',
            execTimeoutShape: 'rework',
            detail: '差し戻し後の再作業で作業上限に到達',
            projectPath: '/proj',
            taskId: 'card-r',
            branch: 'swarm/r',
            taskTitle: '差し戻されたカード',
          },
          createdAt: c.now(),
        },
      ],
    })

    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.openEscalation[0].plainQuestion).toContain('手直しが持ち時間を使い切って')
  })

  it('an exec-timeout with NO flavor keeps the legacy question (older persisted fatals)', async () => {
    // execTimeoutKind is optional and absent on notifications persisted before
    // 2026-07-18; those must not silently become the ready-worker wording.
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [
        {
          fatal: {
            event: 'exec-timeout',
            detail: 'd',
            projectPath: '/proj',
            taskId: 'card-legacy',
            branch: 'swarm/l',
            taskTitle: '旧カード',
          },
          createdAt: c.now(),
        },
      ],
    })

    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.openEscalation[0].plainQuestion).toContain('作業を小さく分けて')
  })

  it('two occurrences of the same card each raise ONCE — no per-subcycle ping-pong (MF1 finding 2)', async () => {
    // Adversarial-review finding: seen mapped ONE signalKey → ONE fp, so two fatals
    // sharing S3:exec-timeout:card-t (the same card timing out twice) overwrote each
    // other's fp and BOTH re-raised every ~60s sub-cycle. The store createdAt is now
    // part of the key — each occurrence is its own 1-shot slot.
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const shared = { event: 'exec-timeout' as const, projectPath: '/proj', taskId: 'card-t', branch: 'swarm/t', taskTitle: 'T' }
    const twoFatals = [
      { fatal: { ...shared, detail: '上限30分を超過（31分稼働）' }, createdAt: c.now() - 120_000 },
      { fatal: { ...shared, detail: '上限30分を超過（45分稼働）' }, createdAt: c.now() - 60_000 },
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
    const fatal = {
      fatal: { event: 'exec-timeout' as const, detail: 'd', projectPath: '/proj', taskId: 'card-t', branch: 'swarm/t', taskTitle: 'T' },
      createdAt: c.now(),
    }
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

// ── S3/S10 — the fatal window + the persistent receipt (the re-post bug class) ──
//
// The 2026-07-09 field bug: every overseer OFF→ON replayed 8 exec-timeouts of
// workers dead since 07/01-07/06 — recentFatals had NO time window (the store
// never expires its cap-50 records), ov.seen is in-memory (reset on re-arm), and
// dismiss only wrote escalations.json (a store the raise path never consulted).
// These tests pin the three fixes: the window, the sinceMs contract, and the
// persistent receipt check that makes dismiss stick across restarts.

describe('overseer — S3/S10 fatal window + persistent receipt (re-post bug)', () => {
  const FATAL = {
    event: 'exec-timeout' as const,
    detail: 'ワーカーが実行時間上限を超過',
    projectPath: '/proj',
    taskId: 'card-t',
    branch: 'swarm/t',
    taskTitle: 'T',
  }

  it('passes sinceMs = now - fatalWindowMs to recentFatals (the window is explicit)', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const sinceSeen: number[] = []
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async (sinceMs) => {
        sinceSeen.push(sinceMs)
        return []
      },
    })
    await runOverseerPass(engine, [], () => {}, deps)
    expect(sinceSeen).toEqual([c.now() - OVERSEER_THRESHOLDS.fatalWindowMs])
  })

  it('a fatal older than the window NEVER raises — even if recentFatals returns it', async () => {
    // Defense-in-depth: the pass re-enforces the window locally, so an
    // out-of-contract recentFatals (or the raw store) cannot replay old fatals.
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const stale = { fatal: FATAL, createdAt: c.now() - OVERSEER_THRESHOLDS.fatalWindowMs - 1 }
    const deps = makeDeps(calls, { now: c.now, recentFatals: async () => [stale] })

    const out = await runOverseerPass(engine, [], () => {}, deps)
    expect(out.fired).not.toContain('S3')
    expect(calls.openEscalation).toHaveLength(0)
    // Nothing tracked either — an out-of-window fatal is not a live condition.
    expect(Array.from(engine.overseer.seen.keys()).some((k) => k.startsWith('S3:'))).toBe(false)
  })

  it('an in-window fatal whose receiptKey already exists (e.g. DISMISSED) does not re-raise — receipt is persistent', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const createdAt = c.now() - 60_000
    // What a prior raise persisted, later dismissed by the owner — the receipt
    // check reads keys regardless of status, so the dismissed record still counts.
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [{ fatal: FATAL, createdAt }],
      listReceiptKeys: async () => new Set([`S3:/proj:card-t:${createdAt}`]),
    })

    const out = await runOverseerPass(engine, [], () => {}, deps)
    expect(out.fired).not.toContain('S3')
    expect(calls.openEscalation).toHaveLength(0)
    // The occurrence is marked seen (skip the ledger read next sub-cycle)…
    expect(engine.overseer.seen.has(`S3:exec-timeout:card-t:${createdAt}`)).toBe(true)

    // …and it STAYS quiet on later sub-cycles too.
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(calls.openEscalation).toHaveLength(0)
  })

  it('a dismissed fatal stays dismissed ACROSS A RESTART (fresh runtime, same ledger)', async () => {
    // The user-visible bug: dismiss → app restart (ov.seen reset) → the same 8
    // escalations reopen. The receipt now lives in escalations.json, which survives.
    const c = clock()
    const createdAt = c.now() - 60_000
    // The persistent ledger, as receiptKey→status rows (what escalations.json keeps).
    const ledger: { receiptKey: string; status: string }[] = []
    const receiptKeysOf = async () => new Set(ledger.map((e) => e.receiptKey))

    // Session 1: the fatal raises once; the raise lands in the (fake) ledger.
    const calls1 = makeCalls()
    const engine1 = makeEngine()
    const deps1 = makeDeps(calls1, {
      now: c.now,
      recentFatals: async () => [{ fatal: FATAL, createdAt }],
      listReceiptKeys: receiptKeysOf,
      openEscalation: async (input) => {
        calls1.openEscalation.push(input)
        ledger.push({ receiptKey: input.receiptKey ?? '', status: 'open' })
        return { escalation: { id: 'esc-1', status: 'open' } as never, deduped: false }
      },
    })
    await runOverseerPass(engine1, [], () => {}, deps1)
    expect(calls1.openEscalation).toHaveLength(1)

    // The owner dismisses it (status flips in the persistent ledger — the receipt
    // row itself SURVIVES; that survival is what the check keys on)…
    ledger[0] = { ...ledger[0], status: 'dismissed' }

    // …then the app RESTARTS: a brand-new runtime (seen is empty), same ledger.
    const calls2 = makeCalls()
    const engine2 = makeEngine() // fresh armed() runtime — the in-memory seen is gone
    const deps2 = makeDeps(calls2, {
      now: c.now,
      recentFatals: async () => [{ fatal: FATAL, createdAt }],
      listReceiptKeys: receiptKeysOf,
    })
    const out = await runOverseerPass(engine2, [], () => {}, deps2)
    expect(out.fired).not.toContain('S3')
    expect(calls2.openEscalation).toHaveLength(0) // ← the bug would make this 1
  })

  it('an unreadable receipt ledger defers the raise (no blind re-post), then raises once on recovery', async () => {
    // Dep-contract shape (the REAL strict reader throwing on a corrupt ledger is
    // exercised end-to-end in swarmOverseer.e2e.test.ts against the actual file).
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    let failLedger = true
    const createdAt = c.now() - 60_000 // fixed append time — the SAME stored occurrence across passes
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [{ fatal: FATAL, createdAt }],
      listReceiptKeys: async () => {
        if (failLedger) throw new Error('ledger read blew up')
        return new Set<string>()
      },
    })

    // Ledger unreadable → nothing raised (raising blind could re-post a dismissed
    // fatal — the exact bug), nothing marked seen.
    const out1 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out1.fired).not.toContain('S3')
    expect(calls.openEscalation).toHaveLength(0)

    // Ledger recovers on the next sub-cycle → the (unreceipted) fatal raises once.
    failLedger = false
    c.advance(OVERSEER_THRESHOLDS.escalationsPollMs)
    const out2 = await runOverseerPass(engine, [], () => {}, deps)
    expect(out2.fired).toContain('S3')
    expect(calls.openEscalation).toHaveLength(1)
  })

  it('S10 rides the same window + receipt path as S3', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const inWindow = c.now() - 60_000
    const outOfWindow = c.now() - OVERSEER_THRESHOLDS.fatalWindowMs - 1
    const rollback = (createdAt: number) => ({
      fatal: { event: 'rollback' as const, detail: '自己入替がrollback', projectPath: '/proj' },
      createdAt,
    })
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [rollback(outOfWindow), rollback(inWindow)],
      // The in-window occurrence is already receipted (dismissed earlier).
      listReceiptKeys: async () => new Set([`S10:/proj:rollback:${inWindow}`]),
    })

    const out = await runOverseerPass(engine, [], () => {}, deps)
    expect(out.fired).not.toContain('S10')
    expect(calls.openEscalation).toHaveLength(0)
  })

  it('an UNRECEIPTED in-window S10 raises with the self-update 平易文 (A/B + consequences)', async () => {
    const calls = makeCalls()
    const c = clock()
    const engine = makeEngine()
    const deps = makeDeps(calls, {
      now: c.now,
      recentFatals: async () => [
        {
          fatal: { event: 'rollback' as const, detail: 'canary健康チェック失敗→旧版へ復帰', projectPath: '/proj' },
          createdAt: c.now() - 60_000,
        },
      ],
    })

    const out = await runOverseerPass(engine, [], () => {}, deps)
    expect(out.fired).toContain('S10')
    expect(calls.openEscalation).toHaveLength(1)
    expect(calls.openEscalation[0].plainQuestion).toContain('元の版に戻して動いています')
    expect(calls.openEscalation[0].plainQuestion).toContain('A: ')
    expect(calls.openEscalation[0].plainQuestion).toContain('B: ')
    // The technical original is untouched (question keeps the event name).
    expect(calls.openEscalation[0].question).toContain('rollback')
    expect(calls.openEscalation[0].context).toBe('canary健康チェック失敗→旧版へ復帰')
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
    expect(calls.openEscalation[0].plainQuestion).toContain('「保留」の置き場')
    expect(calls.openEscalation[0].plainQuestion).toContain('A: ')

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
    expect(ids).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S7', 'S9', 'S10', 'S11'])
    expect(ids).not.toContain('S6')
  })

  it('OVERSEER_THRESHOLDS pins the documented numbers (single source)', () => {
    expect(OVERSEER_THRESHOLDS.blockedStuckMs).toBe(30 * 60_000)
    expect(OVERSEER_THRESHOLDS.inboxStaleMs).toBe(6 * 60 * 60_000)
    // The S3/S10 fatal window: only fatals this fresh may open an escalation.
    expect(OVERSEER_THRESHOLDS.fatalWindowMs).toBe(24 * 60 * 60_000)
  })

  it('looksLikeQuestion distinguishes questions from mechanical blockers', () => {
    expect(looksLikeQuestion('どのAPIを使うべきですか？')).toBe(true)
    expect(looksLikeQuestion('Which database should I use?')).toBe(true)
    expect(looksLikeQuestion('waiting on the build to finish')).toBe(false)
    expect(looksLikeQuestion('')).toBe(false)
  })

  it('defaultOverseerDeps.recentFatals honours sinceMs against the REAL store (isolated HOME)', async () => {
    // The store keeps up to 50 records with no expiry — the window filter in this
    // seam is what stands between a re-arm and a replay of week-old fatals.
    const { createSwarmFatalNotification } = await import('./swarmNotifications')
    const now = Date.now()
    const old = { event: 'exec-timeout' as const, detail: '古いfatal(窓外)', projectPath: '/proj-window' }
    const recent = { event: 'exec-timeout' as const, detail: '新しいfatal(窓内)', projectPath: '/proj-window' }
    await createSwarmFatalNotification(old, { os: false, now: now - OVERSEER_THRESHOLDS.fatalWindowMs - 60_000 })
    await createSwarmFatalNotification(recent, { os: false, now: now - 60_000 })

    const deps = defaultOverseerDeps({ isAlive: () => true, readHeartbeat: async () => null })
    const got = await deps.recentFatals(now - OVERSEER_THRESHOLDS.fatalWindowMs)
    const details = got.map((t) => t.fatal.detail)
    expect(details).toContain('新しいfatal(窓内)')
    expect(details).not.toContain('古いfatal(窓外)')
    // The pairing carries the store timestamp (the occurrence's identity).
    const hit = got.find((t) => t.fatal.detail === '新しいfatal(窓内)')
    expect(hit?.createdAt).toBe(now - 60_000)
  })
})

// ── W6 janitor is OFF-TICK (2026-07-29) ──────────────────────────────────────
// The sweep is a `git fetch` (60s timeout) plus a git spawn per swarm branch.
// It used to be `await`ed inside this pass, which runs inside runEnginePass
// while `passInFlight` is held — so for the whole sweep EVERY 3s tick bailed:
// no monitor, no stall/crash detection, no runaway clock, no quota sighting.
// The engine went blind precisely while the overseer was supposed to be
// watching. integrate and self-supply were moved off the tick for this same
// reason; the janitor was the one left behind.
//
// TEETH — pins the ACT (the pass does not wait), not a duration: the injected
// janitor never settles, so an awaiting implementation can never return and the
// test times out. Also pins the guard that fire-and-forget newly requires: a
// second tick must not stack a second sweep on the same repo.
describe('overseer janitor — fired, not awaited', () => {
  it('the pass RETURNS while the sweep is still running (no tick starvation)', async () => {
    const calls = makeCalls()
    let started = 0
    const deps = makeDeps(calls, {
      // Never settles: an `await` here would hang the pass forever.
      runJanitor: async () => {
        started += 1
        return new Promise(() => {}) as unknown as Record<string, never>
      },
    })
    const engine = makeEngine({ overseer: armed({ lastJanitorAt: 0 }) })
    const out = await runOverseerPass(engine, [], () => {}, deps)
    expect(out.ran).toBe(true) // pre-fix: never reached — the test times out
    expect(started).toBe(1)
  })

  it('a later tick does NOT stack a second sweep while one is in flight', async () => {
    const calls = makeCalls()
    let started = 0
    const deps = makeDeps(calls, {
      runJanitor: async () => {
        started += 1
        return new Promise(() => {}) as unknown as Record<string, never>
      },
      // Every pass is past the cadence, so only the in-flight guard can hold it.
      now: () => 9_000_000_000_000,
    })
    const engine = makeEngine({ overseer: armed({ lastJanitorAt: 0 }) })
    await runOverseerPass(engine, [], () => {}, deps)
    await runOverseerPass(engine, [], () => {}, deps)
    await runOverseerPass(engine, [], () => {}, deps)
    expect(started).toBe(1)
  })
})
