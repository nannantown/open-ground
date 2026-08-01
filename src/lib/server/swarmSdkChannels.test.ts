// @vitest-environment node
//
// THE CHANNELS BETWEEN THE ENGINE AND A WORKER, PINNED FOR BOTH RUNTIMES.
//
// swarmSdkWorkerContract.test.ts pins how a worker is ADDRESSED. This file pins
// what happens on the wire once it is addressed — the three channels that carry
// something in each direction:
//
//   presence   "is this desk / worker still there?"        (isAlive, isManagerDeskAlive)
//   inbound    "what is it saying?"                         (recentOutput)
//   outbound   "here is your answer, get back to work"      (deliverAnswerToWorker,
//                                                            the overseer's S4/T1 drain)
//
// Every defect this file guards is the SAME shape as the six the contract file
// records, one layer up: a question about a worker answered in the PTY's terms.
// The 2026-08-01 review found five more, and none of them failed loudly —
//
//   • liveness asked `status`, which `terminateSdkSession` flips SYNCHRONOUSLY.
//     "We asked it to stop" was read as "it stopped", so a commander desk being
//     torn down read ABSENT (→ a twin is seated beside it) and a worker whose
//     claude was still unwinding read DEAD (→ its worktree is removed under it).
//   • the overseer's S4 dedup key was `S4:${w.terminalId}` — the empty string for
//     EVERY SDK worker, so the whole fleet shared one slot and their questions
//     took turns overwriting each other's fingerprint, re-raising forever.
//   • the proxy's answer was delivered with `canInjectInto(terminalId) &&
//     injectAnswerIntoWorker(terminalId)`. For an SDK worker both are a no-op on
//     an empty id, so a perfectly deliverable answer was reported as "injection
//     failed" and thrown back at the owner on every pass.
//   • `recentOutput` returned `[sdk session working]` and nothing else, so every
//     text reader downstream (the rate-limit classifier, the escalation's tail
//     capture, the log) knew strictly less about an SDK worker than the PTY
//     runtime knows about a PTY one.
//
// Fixtures drive the REAL pools (sdkSession, spawned with an injected queryFn) —
// re-implementing the pool in the test is how a green suite certifies a rule the
// production code does not follow.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  spawnSdkSession,
  terminateSdkSession,
  getSdkSession,
  isSdkSessionReaped,
  lastQuotaRefusalText,
  __resetSdkSessionsForTests,
  __setQuotaPrefixesForTests,
  type SdkQueryFn,
} from './sdkSession'
import { sdkWorkerRuntime } from './workerRuntime'
import { isManagerDeskAlive, listManagerDesks } from './swarmManagerRuntime'
import { deliverAnswerToWorker, defaultCanPushIntoSdkWorker } from './swarmEscalations'
import {
  runOverseerPass,
  initOverseerRuntime,
  type OverseerDeps,
  type OverseerEngine,
  type OverseerRuntime,
} from './swarmOverseer'
import type { OpenEscalationInput } from './swarmEscalations'

// ── Fixtures over the REAL pool ──────────────────────────────────────────────

/** A session that starts and then never says anything — the shape of a worker
 *  the engine is watching. Note it exposes NO `interrupt`, so `terminate` can
 *  only ASK it to stop: exactly the state the liveness rule is about. */
const idleQuery: SdkQueryFn = () => ({
  async *[Symbol.asyncIterator]() {
    await new Promise(() => {})
    yield undefined
  },
})

/** Records every turn pushed INTO the session — the only honest way to check
 *  that an outbound answer actually reached the worker. */
const echoQuery = (seen: string[]): SdkQueryFn =>
  (({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const m of prompt) {
        const text = (m as { message?: { content?: { text?: string }[] } })?.message?.content?.[0]
          ?.text
        if (typeof text === 'string') seen.push(text)
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ack' }] } }
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      }
    },
  })) as SdkQueryFn

const sdkHandle = (id: string) => ({ runtime: 'sdk' as const, sdkSessionId: id, terminalId: '' })

const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  __resetSdkSessionsForTests()
  __setQuotaPrefixesForTests(["You've hit your"])
})
afterEach(() => {
  __resetSdkSessionsForTests()
  __setQuotaPrefixesForTests(null)
})

// ── PRESENCE — "asked to stop" is not "stopped" ──────────────────────────────

describe('presence: a session asked to stop is STILL THERE until it is reaped', () => {
  it('a worker whose claude is still unwinding reads ALIVE', async () => {
    const s = spawnSdkSession({ cwd: '/wt/live', role: 'worker', options: {}, queryFn: idleQuery })
    const w = sdkHandle(s.id)
    expect(sdkWorkerRuntime.isAlive(w)).toBe(true)

    terminateSdkSession(s.id)
    await settle()

    // The production state this pins, in three lines: status says gone, the pump
    // has NOT unwound, so the process is still there. Reading `status` here is
    // what let the teardown remove a live worker's worktree — the answer "dead"
    // is the answer that authorises destruction.
    expect(getSdkSession(s.id)?.status).toBe('exited')
    expect(isSdkSessionReaped(s.id)).toBe(false)
    expect(sdkWorkerRuntime.isAlive(w)).toBe(true)
  })

  it('…and reads DEAD once the pump has actually returned', async () => {
    // A generator that ENDS — the only in-process evidence that the claude
    // behind the session is done, as opposed to merely asked to stop.
    const finite: SdkQueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      },
    })
    const s = spawnSdkSession({ cwd: '/wt/done', role: 'worker', options: {}, queryFn: finite })
    await settle()
    expect(isSdkSessionReaped(s.id)).toBe(true)
    expect(sdkWorkerRuntime.isAlive(sdkHandle(s.id))).toBe(false)
  })

  it('an unknown session is not alive, and does not throw', () => {
    expect(sdkWorkerRuntime.isAlive(sdkHandle('no-such-session'))).toBe(false)
  })

  it('a COMMANDER desk being torn down is still a desk (no twin may be seated)', async () => {
    const s = spawnSdkSession({ cwd: '/proj', role: 'manager', options: {}, queryFn: idleQuery })
    const desk = listManagerDesks('/proj', { ptyDesks: () => [] })[0]
    expect(desk?.runtime).toBe('sdk')

    terminateSdkSession(s.id)
    await settle()

    // The two seams must AGREE. `listManagerDesks` selects on `reaped`, so the
    // desk is still listed; a status-based `isManagerDeskAlive` said the opposite
    // about the very same desk, and "no live desk" is the singleton guard's
    // permission to spawn a second commander into the same project.
    expect(listManagerDesks('/proj', { ptyDesks: () => [] })).toHaveLength(1)
    expect(isManagerDeskAlive(desk)).toBe(true)
  })
})

// ── INBOUND — recentOutput carries what the worker actually said ─────────────

describe('inbound: recentOutput is the worker’s real transcript, not a placeholder', () => {
  const talkingQuery: SdkQueryFn = () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'テストを走らせます。' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      }
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: '3 failed', is_error: true }] },
      }
      yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      await new Promise(() => {})
    },
  })

  it('surfaces the assistant’s words and its tool activity', async () => {
    const s = spawnSdkSession({ cwd: '/wt/talk', role: 'worker', options: {}, queryFn: talkingQuery })
    await settle()
    const out = sdkWorkerRuntime.recentOutput(sdkHandle(s.id))
    // The status header stays first — it is the one fact the events cannot state,
    // and existing readers key on it.
    expect(out).toMatch(/^\[sdk session /)
    expect(out).toContain('テストを走らせます。')
    expect(out).toContain('Bash')
    expect(out).toContain('3 failed')
    terminateSdkSession(s.id)
  })

  it('a session that has said NOTHING still reports only its status line', async () => {
    const s = spawnSdkSession({ cwd: '/wt/quiet', role: 'worker', options: {}, queryFn: idleQuery })
    expect(sdkWorkerRuntime.recentOutput(sdkHandle(s.id))).toMatch(/^\[sdk session \w/)
    terminateSdkSession(s.id)
  })

  it('does NOT re-assert a quota refusal the decay rule has already retired', async () => {
    // THE REGRESSION THIS EXISTS TO PREVENT. `lastQuotaRefusalText` owns the quota
    // channel and DECAYS its notice, because without decay a worker that hit a
    // limit once read as rate-limited forever and was reclaimed while healthy.
    // Rendering the same sentence as ordinary transcript text puts it back in
    // front of classifyOutput AFTER the decay — the identical bug, rebuilt one
    // function away from the comment warning about it.
    const refusal = "You've hit your usage limit. Your limit resets at 3pm."
    // The refusal and the tool call that retires it sit in the SAME turn, so the
    // decayed refusal is still INSIDE the transcript window — which is exactly the
    // case where the window alone does not save us.
    const refuseThenWork: SdkQueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: refusal }] } }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
        }
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
        await new Promise(() => {})
      },
    })
    const s = spawnSdkSession({ cwd: '/wt/decayed', role: 'worker', options: {}, queryFn: refuseThenWork })
    await settle()
    // Premise: the owning channel has already retired the notice (a tool call is
    // unambiguous evidence the worker moved on).
    expect(lastQuotaRefusalText(s.id)).toBeNull()
    const out = sdkWorkerRuntime.recentOutput(sdkHandle(s.id)) ?? ''
    expect(out).toContain('Bash') // the window DOES reach back this far…
    expect(out).not.toContain('usage limit') // …and the refusal still may not ride along
    terminateSdkSession(s.id)
  })
})

// ── OUTBOUND — the answer conduit reaches BOTH runtimes ──────────────────────

describe('outbound: deliverAnswerToWorker', () => {
  it('delivers to an SDK worker as a queued turn', async () => {
    const seen: string[] = []
    const s = spawnSdkSession({ cwd: '/wt/ans', role: 'worker', options: {}, queryFn: echoQuery(seen) })
    await settle()

    const ok = await deliverAnswerToWorker(sdkHandle(s.id), '/proj', '【本人からの回答】B で進めて', {
      canPushInto: async () => true, // the registry is not reachable in a unit test
    })
    await settle()

    expect(ok).toBe(true)
    expect(seen).toContain('【本人からの回答】B で進めて')
    terminateSdkSession(s.id)
  })

  it('delivers to a PTY worker with the bracketed paste + submitting CR, unchanged', async () => {
    const writes: string[] = []
    const ok = await deliverAnswerToWorker({ terminalId: 'pty-1' }, '/proj', 'answer', {
      canInjectInto: async () => true,
      write: (_id, data) => {
        writes.push(data)
        return true
      },
      sleep: async () => {},
      readScreen: () => null, // no frame to judge by ⇒ both writes landed
    })
    expect(ok).toBe(true)
    expect(writes.some((w) => w.includes('answer'))).toBe(true)
    expect(writes[writes.length - 1]).toBe('\r')
  })

  it('a handle with no id is a refusal, never a throw', async () => {
    // The escalation record it comes from may predate the field; a missing handle
    // must fall through to the caller's fallback, not abort an answer that is
    // already durable on disk.
    expect(await deliverAnswerToWorker({ runtime: 'sdk' }, '/proj', 'x')).toBe(false)
    expect(await deliverAnswerToWorker({}, '/proj', 'x')).toBe(false)
  })

  it('refuses an SDK session belonging to a DIFFERENT project (containment)', async () => {
    const s = spawnSdkSession({ cwd: '/wt/other', role: 'worker', options: {}, queryFn: idleQuery })
    const uuids: Record<string, string> = { '/wt/other': 'uuid-B', '/proj': 'uuid-A' }
    expect(
      await defaultCanPushIntoSdkWorker(s.id, '/proj', { uuidOf: async (p) => uuids[p] ?? 'x' }),
    ).toBe(false)
    expect(
      await defaultCanPushIntoSdkWorker(s.id, '/wt/other', { uuidOf: async (p) => uuids[p] ?? 'x' }),
    ).toBe(true)
    terminateSdkSession(s.id)
  })

  it('still allows a session asked to stop but not yet reaped (liveness, not status)', async () => {
    // Same rule as presence, on the outbound side: a session mid-unwind is still
    // there. The guard must not be the thing that decides it is gone — that is
    // `pushSdkInput`'s job, and it refuses a genuinely closed session on its own.
    const s = spawnSdkSession({ cwd: '/wt/stopping', role: 'worker', options: {}, queryFn: idleQuery })
    terminateSdkSession(s.id)
    await settle()
    expect(await defaultCanPushIntoSdkWorker(s.id, '/proj', { uuidOf: async () => 'same' })).toBe(true)
    // …and the delivery itself is the one that says no.
    expect(
      await deliverAnswerToWorker(sdkHandle(s.id), '/proj', 'too late', { canPushInto: async () => true }),
    ).toBe(false)
  })

  it('an unknown SDK session is refused', async () => {
    expect(await defaultCanPushIntoSdkWorker('nope', '/proj', { uuidOf: async () => 'same' })).toBe(
      false,
    )
  })
})

// ── The overseer's S4 → T1 path, driven end to end over SDK workers ──────────

interface Raised {
  opened: OpenEscalationInput[]
}

const overseerDeps = (raised: Raised, over: Partial<OverseerDeps> = {}): OverseerDeps => ({
  now: () => 1_700_000_000_000,
  isAlive: () => true,
  readHeartbeat: async () => null,
  answerAsOwner: async () => ({ kind: 'answer', text: '答え', confidence: 'high' }),
  openEscalation: async (input) => {
    raised.opened.push(input)
    return { escalation: { id: `esc-${raised.opened.length}`, status: 'open' } as never, deduped: false }
  },
  canInjectInto: async () => true,
  injectAnswer: async () => true,
  notifyInfo: async () => ({}),
  peekUsagePct: () => null,
  refreshUsage: () => {},
  listEscalations: async () => [],
  listReceiptKeys: async () => new Set<string>(),
  recentFatals: async () => [],
  runJanitor: async () => ({}),
  ...over,
})

const armedRuntime = (over: Partial<OverseerRuntime> = {}): OverseerRuntime => ({
  ...initOverseerRuntime(),
  enabled: true,
  lastJanitorAt: 9_000_000_000_000, // never fire the incidental W6 sweep here
  ...over,
})

const engineWith = (
  workers: OverseerEngine['workers'],
  ov: OverseerRuntime,
): OverseerEngine => ({
  path: '/proj',
  running: true,
  anomalies: [],
  notified: new Set<string>(),
  workers,
  reviews: [],
  overseer: ov,
})

describe('overseer S4: two blocked SDK workers are two workers', () => {
  it('does not re-raise the same two questions on every pass', async () => {
    // THE DEFECT, IN ONE SENTENCE: `S4:${w.terminalId}` is `S4:` for every SDK
    // worker, so the dedup map holds ONE slot for the whole fleet — and a map with
    // one slot per fleet dedups nothing. Two blocked workers overwrite each
    // other's fingerprint every pass, so both questions re-fire on every pass
    // (in the live engine: re-charging the 大脳's daily budget and letting the two
    // steal the single-flight from each other, so a third blocked worker is never
    // reached; the receiptKey is what keeps the inbox from visibly growing, which
    // is why none of it shows up on the owner's side).
    //
    // Driven through the THROTTLED lane on purpose: it is the one that raises
    // EVERY blocked worker in a single pass (the brain lane is single-flight and
    // stops after one), so the shared key is observable without a second worker
    // having to wait for a budget window.
    const questions: Record<string, string> = {
      'swarm/a': 'A案とB案、どちらで進めますか？',
      'swarm/b': 'このAPIは公開してよいですか？',
    }
    const raised: Raised = { opened: [] }
    const ov = armedRuntime()
    const engine = engineWith(
      [
        { ...sdkHandle('sdk-a'), branch: 'swarm/a', taskId: 'card-a', taskTitle: 'A' },
        { ...sdkHandle('sdk-b'), branch: 'swarm/b', taskId: 'card-b', taskTitle: 'B' },
      ],
      ov,
    )
    const deps = overseerDeps(raised, {
      peekUsagePct: () => 100, // S9 → THROTTLED → bare raise, no brain
      readHeartbeat: async (_p, branch) => ({ ready: false, blocked: true, blockers: questions[branch] }),
    })

    await runOverseerPass(engine, [], () => {}, deps)
    expect(raised.opened).toHaveLength(2)
    expect(raised.opened.map((o) => o.branch).sort()).toEqual(['swarm/a', 'swarm/b'])

    // The SECOND pass is the whole test: nothing changed, so nothing may be
    // raised again.
    await runOverseerPass(engine, [], () => {}, deps)
    expect(raised.opened).toHaveLength(2)
  })

  it('an unaddressable worker is skipped, not allowed to abort the pass', async () => {
    // `workerKey` throws by design on a handle-less record (a shared "" key is
    // worse than a loud failure) — and this loop runs inside the pass's try, so
    // one malformed roster row must not take S5/S7/S11 and the prune down with it.
    const raised: Raised = { opened: [] }
    const ov = armedRuntime()
    const engine = engineWith(
      [
        { runtime: 'sdk', branch: 'swarm/broken', taskId: 'card-x', taskTitle: 'X' },
        { ...sdkHandle('sdk-ok'), branch: 'swarm/ok', taskId: 'card-ok', taskTitle: 'OK' },
      ],
      ov,
    )
    const out = await runOverseerPass(
      engine,
      [],
      () => {},
      overseerDeps(raised, {
        peekUsagePct: () => 100,
        readHeartbeat: async () => ({ ready: false, blocked: true, blockers: 'どうしますか？' }),
      }),
    )
    expect(out.ran).toBe(true)
    expect(raised.opened.map((o) => o.branch)).toEqual(['swarm/ok'])
  })
})

describe('overseer T1: a proxy answer reaches an SDK worker', () => {
  it('delivers into the SDK session instead of raising a delivery failure', async () => {
    const seen: string[] = []
    const s = spawnSdkSession({ cwd: '/wt/t1', role: 'worker', options: {}, queryFn: echoQuery(seen) })
    await settle()

    const raised: Raised = { opened: [] }
    const ov = armedRuntime({
      // A brain result parked by a PRIOR pass — exactly what the fire-and-forget
      // chain leaves behind, carrying the worker's whole handle.
      brainResults: [
        {
          signalKey: 'S4:sdk-t1',
          question: 'A案とB案、どちらで進めますか？',
          context: 'ctx',
          taskId: 'card-t1',
          branch: 'swarm/t1',
          runtime: 'sdk',
          sdkSessionId: s.id,
          answer: { kind: 'answer', text: 'B案で進めてください', confidence: 'high' },
        },
      ],
    })
    const engine = engineWith(
      [{ ...sdkHandle(s.id), branch: 'swarm/t1', taskId: 'card-t1', taskTitle: 'T1' }],
      ov,
    )

    await runOverseerPass(
      engine,
      [],
      () => {},
      overseerDeps(raised, {
        // Only the registry lookup is faked — the RUNTIME BRANCH under test is
        // the real one inside deliverAnswerToWorker.
        deliverAnswer: (target, projectPath, text) =>
          deliverAnswerToWorker(target, projectPath, text, { canPushInto: async () => true }),
      }),
    )
    await settle()

    // The answer landed in the worker's own conversation…
    expect(seen.some((t) => t.includes('B案で進めてください'))).toBe(true)
    // …and the owner was NOT told the delivery failed. Before the fix this was
    // the ONLY outcome for an SDK worker: an inbox row saying "the proxy answered
    // but could not deliver it — please hand it over yourself", every pass.
    expect(raised.opened).toHaveLength(0)
    terminateSdkSession(s.id)
  })

  it('a PTY worker still goes through the injected canInjectInto / injectAnswer deps', async () => {
    // The other half of the same claim: adding the SDK arm must not quietly
    // re-route the PTY one (those two deps are what every existing overseer test
    // observes).
    const injected: { terminalId: string; text: string }[] = []
    const raised: Raised = { opened: [] }
    const ov = armedRuntime({
      brainResults: [
        {
          signalKey: 'S4:term-1',
          question: 'どちらにしますか？',
          context: 'ctx',
          taskId: 'card-p',
          branch: 'swarm/p',
          terminalId: 'term-1',
          answer: { kind: 'answer', text: 'A で', confidence: 'high' },
        },
      ],
    })
    const engine = engineWith(
      [{ terminalId: 'term-1', branch: 'swarm/p', taskId: 'card-p', taskTitle: 'P' }],
      ov,
    )
    await runOverseerPass(
      engine,
      [],
      () => {},
      overseerDeps(raised, {
        injectAnswer: async (terminalId, text) => {
          injected.push({ terminalId, text })
          return true
        },
      }),
    )
    expect(injected).toHaveLength(1)
    expect(injected[0].terminalId).toBe('term-1')
    expect(injected[0].text).toContain('A で')
    expect(raised.opened).toHaveLength(0)
  })
})
