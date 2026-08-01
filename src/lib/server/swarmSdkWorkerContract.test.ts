import { describe, it, expect } from 'vitest'
import { runtimeOf, workerKey, workerRuntimeKind, type WorkerHandle } from './workerRuntime'

// THE RULE, MADE ENFORCEABLE.
//
// Five review rounds produced defects of exactly ONE shape: an operation that
// reaches a worker through `w.terminalId` instead of through its runtime. An SDK
// worker's terminalId is EMPTY by the identity invariant (pty ⇔ terminalId,
// sdk ⇔ sdkSessionId), so every such operation either did nothing or hit the
// wrong worker — and never said so. The confirmed instances:
//
//   • worktreeCleanup asked only the PTY pool → removed a live worker's worktree
//   • defaultRecoverWorker killed only a PTY   → tore the tree down under claude
//   • stopOrchestratorWorker matched terminalId → dropped ALL SDK workers at once
//   • listSwarmWorkers omitted the runtime      → drew a live worker as EXITED
//   • readConsumption read the PTY pool         → no fuel accounting for SDK
//   • the Ground beacon read the PTY pool       → a busy project looked idle
//
// A reviewer's grep found those. This file is the part that does not depend on
// anyone remembering to grep: it pins the PROPERTY every such call site relies
// on, so a change that breaks the addressing model fails here rather than in the
// field. What it cannot do is prove a NEW call site asks correctly — for that,
// the rule is written where the next author will read it (workerRuntime.ts, and
// docs/MAP.md §5).

const sdkWorker: WorkerHandle = { runtime: 'sdk', sdkSessionId: 'sdk-1', terminalId: '' }
const ptyWorker: WorkerHandle = { terminalId: 'pty-1' }
const legacyWorker: WorkerHandle = { terminalId: 'pty-old' } // predates the field

describe('the worker addressing model', () => {
  it('an SDK worker is addressed by its SDK session id, NEVER by terminalId', () => {
    expect(workerKey(sdkWorker)).toBe('sdk-1')
    // The trap in one line: this is what every broken call site used.
    expect(sdkWorker.terminalId).toBe('')
    expect(workerKey(sdkWorker)).not.toBe(sdkWorker.terminalId)
  })

  it('two SDK workers are DISTINCT — keying on terminalId makes them the same worker', () => {
    const a: WorkerHandle = { runtime: 'sdk', sdkSessionId: 'sdk-a', terminalId: '' }
    const b: WorkerHandle = { runtime: 'sdk', sdkSessionId: 'sdk-b', terminalId: '' }
    expect(workerKey(a)).not.toBe(workerKey(b))
    // …whereas the old model collapsed them, which is how one "stop" dropped
    // every SDK worker from the engine's roster at once.
    expect(a.terminalId).toBe(b.terminalId)
  })

  it('absent runtime still means pty — every pre-SDK record keeps working', () => {
    expect(workerRuntimeKind(legacyWorker)).toBe('pty')
    expect(workerKey(legacyWorker)).toBe('pty-old')
    expect(workerKey(ptyWorker)).toBe('pty-1')
  })

  it('a handle with no usable id THROWS rather than silently keying on ""', () => {
    // Louder is safer: an unaddressable worker sharing the empty key with every
    // other one is precisely the collision the engine's maps must never have.
    expect(() => workerKey({ runtime: 'sdk', terminalId: 'not-mine' })).toThrow()
    expect(() => workerKey({})).toThrow()
    expect(() => workerKey({ runtime: 'sdk', sdkSessionId: '' })).toThrow()
  })
})

describe('every runtime-dispatched operation resolves for BOTH runtimes', () => {
  // The engine reaches a worker through these six and only these six. If a
  // runtime is missing one, the operation is a silent no-op for that runtime —
  // which is how "the worker never stopped" happens.
  const OPS = ['isAlive', 'recentOutput', 'kill', 'lastOutputAt', 'nudge', 'say'] as const

  for (const w of [sdkWorker, ptyWorker, legacyWorker]) {
    const label = `${workerRuntimeKind(w)}${w === legacyWorker ? ' (legacy record)' : ''}`
    it(`${label}: resolves an adapter implementing all ${OPS.length} operations`, () => {
      const rt = runtimeOf(w)
      expect(rt.kind).toBe(workerRuntimeKind(w))
      for (const op of OPS) {
        expect(typeof rt[op], `${label}.${op}`).toBe('function')
      }
    })
  }

  it('the two adapters are DIFFERENT objects — an SDK worker never gets PTY behaviour', () => {
    expect(runtimeOf(sdkWorker)).not.toBe(runtimeOf(ptyWorker))
    expect(runtimeOf(sdkWorker).kind).toBe('sdk')
    expect(runtimeOf(ptyWorker).kind).toBe('pty')
    // A legacy record must land on the PTY adapter, not on a third thing.
    expect(runtimeOf(legacyWorker)).toBe(runtimeOf(ptyWorker))
  })
})

// ── The three engine-facing contracts an SDK worker must satisfy ────────────
// Each pins a defect the 2026-07-31 adversarial review confirmed. They live here
// rather than in their own files because they are all the same claim: an SDK
// worker must be indistinguishable from a PTY one to the engine's machinery.

import {
  spawnSdkSession,
  terminateSdkSession,
  pushSdkInput,
  lastQuotaRefusalText,
  terminateSdkSessionsInDir,
  isSdkSessionReaped,
  getSdkSession,
  listActiveSdkCwds,
  listSdkSessions,
  listSdkSessionsIn,
  isSdkSessionLive,
  __resetSdkSessionsForTests,
  __setQuotaPrefixesForTests,
  type SdkQueryFn,
} from './sdkSession'
import { liveSdkWorkerCount, sdkSlotLimit, chooseWorkerRuntime } from './swarmWorkerRuntimeDial'
import { sdkWorkerRuntime } from './workerRuntime'
import { listAllActiveDesks } from './liveDesks'
import { afterEach, beforeEach } from 'vitest'

const REFUSAL = "You've hit your usage limit. Your limit resets at 3pm."
const idleQuery: SdkQueryFn = () => ({
  async *[Symbol.asyncIterator]() {
    await new Promise(() => {})
    yield undefined
  },
})
/** Refusal + its `result` in one batch — the shape the CLI actually produces. */
const refusingWithResult: SdkQueryFn = () => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } }
    yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
    await new Promise(() => {})
  },
})
/** Emits the CLI's real refusal sentence, then parks. */
const refusingQuery: SdkQueryFn = () => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } }
    await new Promise(() => {})
  },
})

beforeEach(() => {
  __resetSdkSessionsForTests()
  __setQuotaPrefixesForTests(["You've hit your", "You've reached your"])
})
afterEach(() => {
  __resetSdkSessionsForTests()
  __setQuotaPrefixesForTests(null)
})

describe('the SDK adapter’s operations actually DO something', () => {
  // WHY THIS EXISTS ON TOP OF THE DESCRIBE ABOVE. That one asserts
  // `typeof rt[op] === 'function'` — which is satisfied by a function that does
  // NOTHING. Measured 2026-08-01: replacing the SDK adapter's kill / nudge / say
  // / lastOutputAt with `() => {}`, `() => false`, `() => false`, `() => null`
  // left all 76 tests in these three files green.
  //
  // What that gutted version is, in the engine's terms:
  //   • kill    — swarmOrchestrator's `killPty: (w) => runtimeOf(w).kill(w)` is
  //               the ONLY stop path for an SDK worker. A no-op means "the worker
  //               never stopped": the teardown salvages and removes the worktree
  //               while claude is still writing into it.
  //   • say     — the 差し戻し / escalation conduit. Silently dropping it means
  //               the commander's rework instruction is never delivered and the
  //               worker sits on the old task forever.
  //   • nudge   — a quiet worker is never poked, so it stalls out and is reclaimed.
  //   • lastOutputAt — null means NO EVIDENCE to every caller, so the stall clock
  //               can never fire (or, read the other way, fires immediately).
  // Every one of those is silent. So this pins the EFFECT of each, through the
  // real pool, not the existence of a symbol.
  //
  // The PTY arm is deliberately not mirrored here: `terminal.ts` is not mocked in
  // this file (importing it for real is what lets liveDesks be exercised), and
  // the PTY adapter is pure delegation to functions the orchestrator suite
  // already covers. The SDK arm is the one nothing else reaches.

  /** Echoes every turn it is handed back to the test — so `say`/`nudge` can be
   *  checked on the SDK's side of the wire (did the TEXT arrive?), not merely by
   *  their own return value. The message shape is what makeInputIterable emits. */
  const echoTurns = (seen: string[]): SdkQueryFn =>
    (({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
      async *[Symbol.asyncIterator]() {
        for await (const m of prompt) {
          const text = (m as { message?: { content?: { text?: string }[] } })?.message
            ?.content?.[0]?.text
          if (typeof text === 'string') seen.push(text)
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ack' }] } }
          yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
        }
      },
    })) as SdkQueryFn

  it('kill really terminates the session — a no-op here means the worker never stopped', async () => {
    // ⚠ WHAT "kill worked" PROVES, AND WHAT IT DOES NOT. `kill` only ASKS: it
    // flips status/exitReason synchronously while claude is still unwinding. So
    // the evidence that kill DID something is the exit reason — and `isAlive`
    // must still answer TRUE, because the desk is still there and its worktree
    // must not be deleted yet. An assertion of `false` right after kill encodes
    // the exact premise (`status` ⇒ liveness) that nine seams got wrong; it was
    // written here once and immediately contradicted the adapter's own fix.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({
      cwd: '/wt/adapter-kill', role: 'worker', options: {},
      queryFn: (() => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((r) => { control.stop = r })
          yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
        },
      })) as SdkQueryFn,
    })
    const w = { runtime: 'sdk' as const, sdkSessionId: s.id, terminalId: '' }
    await new Promise((r) => setTimeout(r, 20))
    expect(sdkWorkerRuntime.isAlive(w)).toBe(true)

    sdkWorkerRuntime.kill(w)

    expect(getSdkSession(s.id)?.status).toBe('exited')
    expect(getSdkSession(s.id)?.exitReason).toBe('terminated')
    expect(sdkWorkerRuntime.isAlive(w)).toBe(true) // asked to stop ≠ stopped

    control.stop?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(sdkWorkerRuntime.isAlive(w)).toBe(false) // …and gone once the pump unwinds
  })

  it('say DELIVERS the text to the session, and nudge delivers a turn', async () => {
    const seen: string[] = []
    const s = spawnSdkSession({
      cwd: '/wt/adapter-say', role: 'worker', options: {}, initialPrompt: 'go',
      queryFn: echoTurns(seen),
    })
    const w = { runtime: 'sdk' as const, sdkSessionId: s.id, terminalId: '' }
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual(['go'])

    expect(await sdkWorkerRuntime.say(w, 'rework: split the card')).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    // The point of the assertion: the ENGINE'S OWN SENTENCE reached the session.
    // A `say` that returns true without pushing anything is the escalation
    // conduit going quietly dead.
    expect(seen).toEqual(['go', 'rework: split the card'])

    expect(sdkWorkerRuntime.nudge(w)).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(3) // a real turn, not a bare CR (which a stream ignores)

    terminateSdkSession(s.id)
  })

  it('lastOutputAt reports the session’s real newest-event clock, never null while live', async () => {
    // ⚠ null is the contract's "NO EVIDENCE" value. An adapter that always
    // returns it does not merely lose precision — it removes the stall detector's
    // only input for every SDK worker.
    const before = Date.now()
    const s = spawnSdkSession({ cwd: '/wt/adapter-clock', role: 'worker', options: {}, initialPrompt: 'go', queryFn: idleQuery })
    const w = { runtime: 'sdk' as const, sdkSessionId: s.id, terminalId: '' }
    await new Promise((r) => setTimeout(r, 20))
    const at = sdkWorkerRuntime.lastOutputAt(w)
    expect(at).not.toBeNull()
    expect(at).toBe(getSdkSession(s.id)?.lastEventAt)
    expect(at!).toBeGreaterThanOrEqual(before)
    terminateSdkSession(s.id)
  })

  it('every operation addresses the session by sdkSessionId — an empty terminalId reaches nothing', async () => {
    // The identity invariant, from the adapter's side: a handle carrying only a
    // terminalId is unaddressable on this runtime and must THROW rather than
    // quietly operate on ''. (`workerKey` is what raises; this pins that every
    // op goes through it instead of reading a field directly.)
    const orphan = { runtime: 'sdk' as const, terminalId: 'pty-looking-id' }
    expect(() => sdkWorkerRuntime.isAlive(orphan)).toThrow()
    expect(() => sdkWorkerRuntime.recentOutput(orphan)).toThrow()
    expect(() => sdkWorkerRuntime.kill(orphan)).toThrow()
    expect(() => sdkWorkerRuntime.lastOutputAt(orphan)).toThrow()
    expect(() => sdkWorkerRuntime.nudge(orphan)).toThrow()
    // `say` is async, so its throw arrives as a REJECTION — the await matters:
    // without it this line asserts nothing and passes on any implementation.
    await expect(sdkWorkerRuntime.say(orphan, 'hi')).rejects.toThrow()
  })
})

describe('the engine can SEE an SDK worker’s quota stop', () => {
  it('recentOutput surfaces the CLI’s own refusal sentence once it refuses', async () => {
    // Before: it returned `[sdk session waiting]`, which classifies as ordinary
    // output — so a quota-parked worker read as a plain stall and was nudged,
    // reclaimed and re-dispatched into the same wall, burning a worktree a go.
    const s = spawnSdkSession({ cwd: '/wt/q', role: 'worker', options: {}, initialPrompt: 'go', queryFn: refusingQuery })
    await new Promise((r) => setTimeout(r, 20))
    const w = { runtime: 'sdk' as const, sdkSessionId: s.id, terminalId: '' }
    expect(lastQuotaRefusalText(s.id)).toBe(REFUSAL)
    // The text handed to the classifier IS the CLI's sentence — not a private
    // paraphrase of Anthropic's wording, which is the trap we must not rebuild.
    expect(sdkWorkerRuntime.recentOutput(w)).toBe(REFUSAL)
    terminateSdkSession(s.id)
  })

  it('a worker that has NOT refused still reports its honest status line', async () => {
    const s = spawnSdkSession({ cwd: '/wt/ok', role: 'worker', options: {}, queryFn: idleQuery })
    const w = { runtime: 'sdk' as const, sdkSessionId: s.id, terminalId: '' }
    expect(lastQuotaRefusalText(s.id)).toBeNull()
    expect(sdkWorkerRuntime.recentOutput(w)).toMatch(/^\[sdk session /)
    terminateSdkSession(s.id)
  })
})

describe('the SDK slot cap counts the FLEET, not one roster', () => {
  it('counts a pool worker the caller’s roster does not know about', () => {
    // The curl-direct dispatch path passes NO roster (there is none), so a
    // roster-only count was 0 forever and the cap never applied — on the
    // commander's primary dispatch path, while the switch promised "at most N".
    const a = spawnSdkSession({ cwd: '/wt/a', role: 'worker', options: {}, queryFn: idleQuery })
    const b = spawnSdkSession({ cwd: '/wt/b', role: 'worker', options: {}, queryFn: idleQuery })
    expect(liveSdkWorkerCount([], [{ id: a.id, role: 'worker', status: 'working' }, { id: b.id, role: 'worker', status: 'working' }])).toBe(2)
    terminateSdkSession(a.id)
    terminateSdkSession(b.id)
  })

  it('dedupes a worker present in BOTH the pool and the roster', () => {
    expect(
      liveSdkWorkerCount(
        [{ runtime: 'sdk', sdkSessionId: 's1' }],
        [{ id: 's1', role: 'worker', status: 'working' }],
      ),
    ).toBe(1)
  })

  it('still counts a roster entry that carries no session id', () => {
    // Dropping these is how the counter first regressed the shipped tests: the
    // engine believes it dispatched that worker, so a cap ignoring it under-counts.
    expect(liveSdkWorkerCount([{ runtime: 'sdk' }], [])).toBe(1)
  })

  it('ignores finished sessions, and non-worker roles (a commander is not a slot)', () => {
    // Production shape: a session that has actually finished carries `reaped`
    // (the pump's finally stamps it, as does the spawn-failure path). The first
    // version of this fixture set only `status`, which production never produces
    // for a finished session — and it therefore certified the status-based rule
    // that the very fix under test had to delete.
    expect(
      liveSdkWorkerCount([], [
        { id: 'x', role: 'worker', status: 'exited', reaped: true },
        { id: 'y', role: 'worker', status: 'failed', reaped: true },
        { id: 'z', role: 'manager', status: 'working' },
      ]),
    ).toBe(0)
  })

  it('an "exited" session that has NOT been reaped is still a slot', () => {
    // The dangerous shape, and the only one that matters: terminate flips status
    // synchronously while claude keeps unwinding. Counting it as finished frees
    // the slot for a replacement that lands in the same worktree.
    expect(liveSdkWorkerCount([], [{ id: 'x', role: 'worker', status: 'exited' }])).toBe(1)
  })

  it('the shipped default budget is ONE', () => {
    expect(sdkSlotLimit({ swarmWorkerRuntime: { mode: 'sdk' } })).toBe(1)
  })
})

describe('the cap is WIRED, not merely computable', () => {
  it('an empty roster + a live pool worker still fills the slot (curl-direct dispatch)', () => {
    // The wiring, not the counter: chooseWorkerRuntime used `countSdkWorkers(opts.workers)`,
    // and every curl-direct dispatch passes `workers: []` because no roster exists
    // there. So `live` was 0 forever and the dial's own budget never applied on the
    // commander's PRIMARY dispatch path.
    const c = chooseWorkerRuntime({
      settings: { swarmWorkerRuntime: { mode: 'sdk' } }, // budget = 1
      workers: [], // ← the curl-direct path
      worktree: '/wt/next',
      poolSessions: () => [{ id: 'already-running', role: 'worker', status: 'working' }],
      preflight: () => ({ ok: true, problems: [], claudeBin: '/bin/claude', cliVersion: '2.1.220' }) as never,
    })
    expect(c.runtime).toBe('pty')
    expect(c.fellBackBecause).toMatch(/slots are full \(1\/1\)/)
  })

  it('…and an empty pool with an empty roster still dispatches on the SDK', () => {
    const c = chooseWorkerRuntime({
      settings: { swarmWorkerRuntime: { mode: 'sdk' } },
      workers: [],
      worktree: '/wt/next',
      poolSessions: () => [],
      preflight: () => ({ ok: true, problems: [], claudeBin: '/bin/claude', cliVersion: '2.1.220' }) as never,
    })
    expect(c.runtime).toBe('sdk')
  })
})

describe('the quota notice DECAYS (a recovered worker is not reclaimed forever)', () => {
  /** Refuse, then — on the next turn — do real work. */
  const refuseThenResume = (control: { next?: () => void }): SdkQueryFn =>
    (() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } }
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
        await new Promise<void>((r) => {
          control.next = r
        })
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
        await new Promise(() => {})
      },
    })) as SdkQueryFn

  it('reports the refusal while it is current…', async () => {
    const control: { next?: () => void } = {}
    const s = spawnSdkSession({ cwd: '/wt/d', role: 'worker', options: {}, initialPrompt: 'go', queryFn: refuseThenResume(control) })
    await new Promise((r) => setTimeout(r, 20))
    expect(lastQuotaRefusalText(s.id)).toBe(REFUSAL)
    control.next?.()
    await new Promise((r) => setTimeout(r, 20))
    // …and STOPS once the worker has actually done work again. Before this, the
    // scan walked the whole ring buffer and returned that sentence forever, so
    // the engine reclaimed a healthy worker on every later pass.
    expect(lastQuotaRefusalText(s.id)).toBeNull()
    terminateSdkSession(s.id)
  })

  it('the refusal’s OWN text does not count as "moved on"', async () => {
    // The distiller emits quota_refusal AND the same block as `text`. A decay
    // rule that stopped at `text` would never find a refusal at all.
    const s = spawnSdkSession({ cwd: '/wt/e', role: 'worker', options: {}, initialPrompt: 'go', queryFn: refusingQuery })
    await new Promise((r) => setTimeout(r, 20))
    expect(lastQuotaRefusalText(s.id)).toBe(REFUSAL)
    terminateSdkSession(s.id)
  })
})

describe('the delete gate sees a session that was ALREADY asked to stop', () => {
  const stuck = (control: { stop?: () => void }): SdkQueryFn =>
    (() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((r) => {
          control.stop = r
        })
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      },
    })) as SdkQueryFn

  it('terminateSdkSessionsInDir selects on REAPED, not on status', async () => {
    // The main teardown terminates FIRST and removes the worktree after. Since
    // terminate flips status to 'exited' synchronously, a status-based filter
    // found NOTHING on exactly that path — reported the directory clear, and let
    // the delete run under a still-unwinding claude. The same hole this seam
    // exists to close, reintroduced inside the fix for it.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({ cwd: '/wt/gate', role: 'worker', options: {}, initialPrompt: 'go', queryFn: stuck(control) })
    await new Promise((r) => setTimeout(r, 20))

    terminateSdkSession(s.id) // ← status is now 'exited'…
    expect(isSdkSessionReaped(s.id)).toBe(false) // …but the pump has NOT unwound

    expect(terminateSdkSessionsInDir('/wt/gate')).toEqual([s.id])
    control.stop?.()
    await new Promise((r) => setTimeout(r, 20))
    // Once really gone, there is nothing left to wait for.
    expect(terminateSdkSessionsInDir('/wt/gate')).toEqual([])
  })
})

describe('a spawn that fails synchronously leaves a FINISHED entry, not a ghost', () => {
  const throwingQuery: SdkQueryFn = (() => {
    throw new Error('require blew up')
  }) as SdkQueryFn

  it('the delete gate is not held shut forever by it', () => {
    // The gate selects `!reaped`. A spawn-failure entry never runs the pump, so
    // without stamping `reaped` here it would be reported as "still running in
    // this directory" for the life of the process — the worktree could NEVER be
    // removed. A gate that can never open is as broken as one that never closes.
    const s = spawnSdkSession({ cwd: '/wt/ghost', role: 'worker', options: {}, queryFn: throwingQuery })
    expect(s.status).toBe('failed')
    expect(isSdkSessionReaped(s.id)).toBe(true)
    expect(terminateSdkSessionsInDir('/wt/ghost')).toEqual([])
  })
})

describe('the cap does not let FINISHED work hold a slot', () => {
  it('a roster worker whose session already ended is not counted', () => {
    // A worker sitting in review, waiting to be integrated, still has a roster
    // entry. Counting it would shut the slot with nothing running, and the dial
    // would silently stop dispatching on the SDK.
    expect(
      liveSdkWorkerCount(
        [{ runtime: 'sdk', sdkSessionId: 'done-1' }],
        // Production shape for a session that has really ended: `reaped` set.
        [{ id: 'done-1', role: 'worker', status: 'exited', reaped: true }],
      ),
    ).toBe(0)
  })

  it('a roster worker the pool does NOT know is finished, not live', () => {
    // This assertion used to expect 1, on the theory that an unknown id might be
    // a worker recorded before the pool saw it. That reasoning was wrong and the
    // rule it pinned expired on a timer: the pool only ever FORGETS sessions that
    // closed (the 30-minute retention sweep), and a pool reset means the process
    // died and took every session with it. Either way an id the pool cannot find
    // is not running — and counting it charged a slot for work that had finished
    // half an hour earlier, silently jamming the dial shut.
    expect(liveSdkWorkerCount([{ runtime: 'sdk', sdkSessionId: 'unknown-1' }], [])).toBe(0)
  })

  it('…but a roster worker with NO id at all still counts', () => {
    // The one case the pool genuinely cannot answer: nothing to look up. The
    // engine believes it dispatched this worker, so ignoring it under-counts.
    expect(liveSdkWorkerCount([{ runtime: 'sdk' }], [])).toBe(1)
  })
})

describe('a quota park stays observable', () => {
  it("the refusal's own turn_end does not immediately clear 'quota-parked'", async () => {
    // The refusal and its `result` arrive in one batch, so the distiller yields
    // [quota_refusal, …, turn_end]. Applying both in order parked the session
    // and then instantly un-parked it — the tile drew a limit-stopped worker as
    // merely "waiting", and every status reader saw idle instead of blocked.
    const s = spawnSdkSession({ cwd: '/wt/park', role: 'worker', options: {}, initialPrompt: 'go', queryFn: refusingWithResult })
    await new Promise((r) => setTimeout(r, 20))
    expect(getSdkSession(s.id)?.status).toBe('quota-parked')
    terminateSdkSession(s.id)
  })
})

describe('the park is not a one-way door', () => {
  /** Refuse, then (next turn) do REAL work. */
  const refuseThenWork: SdkQueryFn = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } }
      yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
      await new Promise(() => {})
    },
  })
  /** Refuse, then a whole second turn that produces only prose. */
  const refuseThenSecondTurn: SdkQueryFn = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } }
      yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'back to work' }] } }
      yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      await new Promise(() => {})
    },
  })

  it('real work clears the park', async () => {
    const s = spawnSdkSession({ cwd: '/wt/p1', role: 'worker', options: {}, initialPrompt: 'go', queryFn: refuseThenWork })
    await new Promise((r) => setTimeout(r, 25))
    // Swallowing turn_end removed the ONLY event-driven exit from 'quota-parked';
    // without an exit a resumed worker reads as limit-stopped for hours.
    expect(getSdkSession(s.id)?.status).toBe('working')
    terminateSdkSession(s.id)
  })

  it('a SECOND completed turn clears it too (the first belongs to the refusal)', async () => {
    const s = spawnSdkSession({ cwd: '/wt/p2', role: 'worker', options: {}, initialPrompt: 'go', queryFn: refuseThenSecondTurn })
    await new Promise((r) => setTimeout(r, 25))
    expect(getSdkSession(s.id)?.status).toBe('waiting')
    terminateSdkSession(s.id)
  })

  it("the refusal's own text does NOT clear it — same trap as the decay rule", async () => {
    const s = spawnSdkSession({ cwd: '/wt/p3', role: 'worker', options: {}, initialPrompt: 'go', queryFn: refusingWithResult })
    await new Promise((r) => setTimeout(r, 25))
    expect(getSdkSession(s.id)?.status).toBe('quota-parked')
    terminateSdkSession(s.id)
  })
})

describe('BOTH liveness seams answer the same question the same way', () => {
  const stuck = (control: { stop?: () => void }): SdkQueryFn =>
    (() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((r) => { control.stop = r })
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      },
    })) as SdkQueryFn

  it('a terminated-but-unwinding session is live to BOTH the cleaner and the gate', async () => {
    // The rule ("select on reaped, never on status") was written into
    // terminateSdkSessionsInDir and NOT into listActiveSdkCwds — seventy lines
    // apart in one file. The cleaner stands on the second one, so it still read
    // the tree as abandoned and removed it under a running claude.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({ cwd: '/wt/both', role: 'worker', options: {}, initialPrompt: 'go', queryFn: stuck(control) })
    await new Promise((r) => setTimeout(r, 20))
    terminateSdkSession(s.id)

    expect(listActiveSdkCwds()).toContain('/wt/both')          // the CLEANER's seam
    expect(terminateSdkSessionsInDir('/wt/both')).toEqual([s.id]) // the GATE's seam

    control.stop?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(listActiveSdkCwds()).not.toContain('/wt/both')
    expect(terminateSdkSessionsInDir('/wt/both')).toEqual([])
  })
})

describe('the park latches EVERY time, not just the first', () => {
  /** Refuses on every turn — the limit is still standing when the owner retries. */
  const refusesEveryTurn: SdkQueryFn = ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _m of prompt) {
        void _m
        yield { type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } }
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      }
    },
  })

  it('a SECOND refusal parks again — its own turn_end must not clear it', async () => {
    // The counter used to carry over between parks: park #1 counted its own
    // turn_end (=1), the owner's input resumed the session, and park #2
    // inherited that stale 1 — so its own turn_end made 2 and cleared it
    // INSTANTLY. Every park after the first was unobservable: the owner retried
    // against a standing limit and the tile showed "waiting", not "parked".
    const s = spawnSdkSession({ cwd: '/wt/repark', role: 'worker', options: {}, initialPrompt: 'go', queryFn: refusesEveryTurn })
    await new Promise((r) => setTimeout(r, 25))
    expect(getSdkSession(s.id)?.status).toBe('quota-parked') // park #1 latched

    pushSdkInput(s.id, 'try again') // the owner retries; the limit still stands
    await new Promise((r) => setTimeout(r, 25))
    expect(getSdkSession(s.id)?.status).toBe('quota-parked') // park #2 must latch too

    terminateSdkSession(s.id)
  })
})

describe('ALL FOUR liveness seams answer with `reaped`, never with status', () => {
  const stuck = (control: { stop?: () => void }): SdkQueryFn =>
    (() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((r) => { control.stop = r })
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      },
    })) as SdkQueryFn

  it('a terminated-but-unwinding worker still HOLDS ITS SLOT', async () => {
    // The third sibling of the same rule, missed twice. A status filter releases
    // the slot of a worker whose claude is still unwinding in its worktree, so
    // the dial dispatches a replacement immediately — the cap is exceeded by
    // exactly the workers hardest to see, and two claudes share one worktree.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({ cwd: '/wt/slot', role: 'worker', options: {}, initialPrompt: 'go', queryFn: stuck(control) })
    await new Promise((r) => setTimeout(r, 20))
    terminateSdkSession(s.id) // status is now 'exited'; the pump has NOT unwound

    expect(liveSdkWorkerCount([], listSdkSessions())).toBe(1)

    control.stop?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(liveSdkWorkerCount([], listSdkSessions())).toBe(0) // …and released once gone
  })

  it('the session snapshot EXPOSES reaped, so every consumer can apply one rule', async () => {
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({ cwd: '/wt/snap', role: 'worker', options: {}, initialPrompt: 'go', queryFn: stuck(control) })
    await new Promise((r) => setTimeout(r, 20))
    terminateSdkSession(s.id)
    expect(getSdkSession(s.id)?.reaped).toBeUndefined() // asked to stop ≠ stopped
    control.stop?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(getSdkSession(s.id)?.reaped).toBe(true)
  })
})

describe('an injected turn does not run while the tile says "waiting"', () => {
  /** One turn per input, so the session returns to 'waiting' between them. */
  const perTurn: SdkQueryFn = ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _m of prompt) {
        void _m
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
        await new Promise((r) => setTimeout(r, 40))
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      }
    },
  })

  it('a turn pushed while BUSY still reads as working once it runs', async () => {
    // pushSdkInput can only promote what it can see; a turn pushed mid-turn is
    // queued while the status is 'working', and by the time it actually runs the
    // previous turn_end has moved the status to 'waiting'. Nothing promoted it
    // back, so the whole injected turn executed while the tile, the Ground beacon
    // and the engine's liveness all reported an idle worker.
    const s = spawnSdkSession({ cwd: '/wt/inject', role: 'worker', options: {}, initialPrompt: 'first', queryFn: perTurn })
    await new Promise((r) => setTimeout(r, 10))
    pushSdkInput(s.id, 'second') // queued MID-TURN
    await new Promise((r) => setTimeout(r, 60)) // turn 1 ends, turn 2 begins
    expect(getSdkSession(s.id)?.status).toBe('working')
    terminateSdkSession(s.id)
  })

  it('…but a BETWEEN-TURN message must leave an idle desk idle', async () => {
    // The other half of the same rule, and the half the fix above got wrong.
    // Promotion written as "a message arrived ⇒ working" fires on the CLI's
    // out-of-turn chatter, which distils to ZERO events: the repo's own worker
    // shape is to start `npm test` as a BACKGROUND task, announce it and end its
    // turn to wait — and when that job finishes 20 minutes later the CLI emits
    // background_tasks_changed. There is no turn left to end, so nothing can
    // ever walk the status back: the desk reads 作業中 forever while it is in
    // fact sitting on the owner. session_state_changed(state:'idle') is worse —
    // it lands after EVERY result, which would make 'waiting' unreachable.
    const control: { idle?: () => void } = {}
    const s = spawnSdkSession({
      cwd: '/wt/bg', role: 'worker', options: {}, initialPrompt: 'go',
      queryFn: (() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test &' } }] } }
          yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
          await new Promise<void>((r) => { control.idle = r })
          // Both distil to [] — they are evidence that NO turn is running.
          yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'x' }
          yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] }
          await new Promise(() => {})
        },
      })) as SdkQueryFn,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(getSdkSession(s.id)?.status).toBe('waiting') // turn ended

    control.idle?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(getSdkSession(s.id)?.status).toBe('waiting') // …and STAYS ended

    terminateSdkSession(s.id)
  })
})

describe('stopping a worker on purpose is not a crash', () => {
  it('terminate → the iterator throws → the tile must NOT say 失敗', async () => {
    // terminateSdkSession sets `closed` BEFORE it fires interrupt(), so the
    // aborted turn's result lands on the closed side of the pump's drain branch.
    // Swallowing it there dropped `sawAbort`, the catch wrote
    // `error: [ede_diagnostic] …` over terminate's own 'terminated', and the
    // finally read that prefix as a failure — so EVERY worker the engine stopped
    // cleanly after integrating was drawn as a failed one. The tile's single
    // most important distinction, inverted.
    const control: { fire?: () => void } = {}
    const s = spawnSdkSession({
      cwd: '/wt/stop', role: 'worker', options: {}, initialPrompt: 'go',
      queryFn: (() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }
          await new Promise<void>((r) => { control.fire = r })
          // What interrupt() actually produces, in this order (measured 07-30).
          yield { type: 'result', subtype: 'success', terminal_reason: 'aborted_streaming' }
          throw new Error('Claude Code returned an error result: [ede_diagnostic] aborted')
        },
      })) as SdkQueryFn,
    })
    await new Promise((r) => setTimeout(r, 20))
    terminateSdkSession(s.id)
    control.fire?.()
    await new Promise((r) => setTimeout(r, 20))

    const done = getSdkSession(s.id)
    expect(done?.status).toBe('exited') // NOT 'failed'
    expect(done?.exitReason).toBe('terminated')
  })

  it('…and a stop is still a stop when the CLI throws without the aborted result', async () => {
    // sawAbort is second-hand evidence: nothing guarantees the result arrives
    // before the throw. `closed` is first-hand — we set it ourselves.
    const control: { fire?: () => void } = {}
    const s = spawnSdkSession({
      cwd: '/wt/stop2', role: 'worker', options: {}, initialPrompt: 'go',
      queryFn: (() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }
          await new Promise<void>((r) => { control.fire = r })
          throw new Error('socket hang up')
        },
      })) as SdkQueryFn,
    })
    await new Promise((r) => setTimeout(r, 20))
    terminateSdkSession(s.id)
    control.fire?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(getSdkSession(s.id)?.status).toBe('exited')
  })

  it('a session that crashed on its OWN still reports failed', async () => {
    // The distinction the two guards above must not erase.
    const s = spawnSdkSession({
      cwd: '/wt/crash', role: 'worker', options: {}, initialPrompt: 'go',
      queryFn: (() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }
          throw new Error('spawn ENOENT')
        },
      })) as SdkQueryFn,
    })
    await new Promise((r) => setTimeout(r, 20))
    const done = getSdkSession(s.id)
    expect(done?.status).toBe('failed')
    expect(done?.exitReason).toMatch(/^error: /)
  })
})

describe('EVERY liveness seam uses isSdkSessionLive — six of them, found one at a time', () => {
  const stuck = (control: { stop?: () => void }): SdkQueryFn =>
    (() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((r) => { control.stop = r })
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      },
    })) as SdkQueryFn

  it('the COMMANDER SINGLETON guard still sees a terminated-but-unwinding desk', async () => {
    // listSdkSessionsIn is what swarmManager.adoptLiveDesk asks "is a commander
    // already up here?". Answering from `status` says NO while the old desk is
    // still unwinding — and a TWIN commander is spawned into the same project.
    // That is the 2026-07-19 eleven-desk incident, by construction.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({ cwd: '/wt/cmd', role: 'manager', options: {}, initialPrompt: 'go', queryFn: stuck(control) })
    await new Promise((r) => setTimeout(r, 20))
    terminateSdkSession(s.id)

    expect(listSdkSessionsIn('/wt/cmd', 'manager').map((x) => x.id)).toEqual([s.id])

    control.stop?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(listSdkSessionsIn('/wt/cmd', 'manager')).toEqual([])
  })

  it('terminate ENDS status — the pump must not resurrect a stopped session', async () => {
    // The iterator keeps yielding after terminate. Every status write below then
    // walked a terminated session back up: turn_end → 'waiting', and (after the
    // round-4 promotion) the next message → 'working'. A desk the owner stopped
    // announced itself as working.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({
      cwd: '/wt/zombie', role: 'worker', options: {}, initialPrompt: 'go',
      queryFn: (() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }
          await new Promise<void>((r) => { control.stop = r })
          // Arrives AFTER terminate — must not move the status.
          yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'still here' }] } }
          await new Promise(() => {})
        },
      })) as SdkQueryFn,
    })
    await new Promise((r) => setTimeout(r, 20))
    terminateSdkSession(s.id)
    expect(getSdkSession(s.id)?.status).toBe('exited')

    control.stop?.()
    await new Promise((r) => setTimeout(r, 30))
    expect(getSdkSession(s.id)?.status).toBe('exited') // NOT 'waiting', NOT 'working'
  })

  it('the Ground beacon agrees with the cleaner about the same session', async () => {
    // One file, two answers: listAllLiveDeskCwds said the tree is occupied while
    // the beacon went dark, so the owner's card read "idle" for a project whose
    // worktree the cleaner was refusing to touch.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({ cwd: '/wt/beacon', role: 'worker', options: {}, initialPrompt: 'go', queryFn: stuck(control) })
    await new Promise((r) => setTimeout(r, 20))
    terminateSdkSession(s.id)

    expect(listActiveSdkCwds()).toContain('/wt/beacon')            // the cleaner
    expect(listAllActiveDesks().claude.some((c) => c.id === s.id)).toBe(true) // the beacon

    control.stop?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(listActiveSdkCwds()).not.toContain('/wt/beacon')
    expect(listAllActiveDesks().claude.some((c) => c.id === s.id)).toBe(false)
  })

  it('isSdkSessionLive is the single predicate — status is not consulted', () => {
    expect(isSdkSessionLive({})).toBe(true)
    expect(isSdkSessionLive({ reaped: true })).toBe(false)
    // The shape that fooled five seams: terminal-looking status, still running.
    expect(isSdkSessionLive({ status: 'exited' } as never)).toBe(true)
  })
})
