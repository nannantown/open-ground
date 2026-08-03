import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { answerEscalation, openEscalation } from './swarmEscalations'
import { escalationsFile } from './paths'
import { initSelfSupplyRuntime } from './swarmSelfSupply'
import {
  initOverseerRuntime,
  runOverseerPass,
  type OverseerDeps,
  type OverseerEngine,
} from './swarmOverseer'
import { handleWorkerQuestion } from './swarmQuestions'
import { app } from '../../../server/app'
import { writeSession, clearSession } from './authStore'
import { __resetMigrationCacheForTests, addImportedProjectEntry } from './registry'
import {
  SDK_QUESTION_SILENCE_MS,
  STALL_SILENCE_MS,
  emptyMetricsCounters,
  runDispatchPass,
  type OrchestratorDeps,
  type ProjectEngine,
} from './swarmOrchestrator'
import type { AnswerEscalationDeps, OpenEscalationInput } from './swarmEscalations'
import type {
  Escalation,
  OrchestratorWorker,
  ProjectTask,
  SpawnSwarmWorkerResponse,
} from '../types'
import {
  renderSdkTail,
  sdkRecentOutputHead,
  workerKey,
  type WorkerHandle,
} from './workerRuntime'

// CAN THE OWNER'S ANSWER REACH AN SDK WORKER AT ALL?
//
// The escalations inbox is the human valve of the unmanned swarm: a worker that
// cannot decide something stops and asks, and the owner's reply is what restarts
// it. Every part of that loop was written when there was one runtime, so the
// blocked worker's address on the PERSISTED record was a single `terminalId`.
// An SDK worker's terminalId is EMPTY by the identity invariant (workerRuntime.ts:
// pty ⇔ terminalId, sdk ⇔ sdkSessionId), so for those workers the loop had no
// closing half:
//
//   • the raiser (swarmOrchestrator's free-text-question arm) passed terminalId
//     alone, so the record named nobody;
//   • the record had no field that COULD name an SDK session, so even a correct
//     raiser had nowhere to put the handle;
//   • delivery rebuilt the handle from `terminalId` only, so the answer fell
//     through to the next-dispatch queue on EVERY attempt — reported as success
//     ('queued'), with the worker still sitting there waiting;
//   • the evidence tail was captured from the PTY pool, so an SDK escalation
//     reached the owner with no record of what the worker was doing.
//
// None of those four failed loudly. That is the whole reason this file exists:
// the tests below assert the answer ARRIVES (the push seam receives the owner's
// text at the right session id), not that some function is callable.
//
// ISOLATED HOME throughout — the inbox is a real file under ~/.openground.

let home: string
let project: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-esc-runtime-')))
  process.env.OPENGROUND_HOME = home
  // A real directory so canonicalize() resolves it cleanly (openEscalation
  // canonicalizes projectPath before storing it).
  project = join(home, 'proj')
  await mkdir(project, { recursive: true })
})

afterEach(async () => {
  // ⚠ RETRY, BECAUSE THE ENGINE IS STILL WRITING. `logLine` is append-through to
  // the on-disk journal under this home and is deliberately fire-and-forget —
  // the engine must never block a dispatch pass on a log write. So when
  // `runDispatchPass` returns there can still be an append in flight, and a
  // plain rmdir loses the race with it: `ENOTEMPTY`. Measured 2026-08-01 by
  // running this file under six busy cores — roughly one run in three failed,
  // and vitest attributed the teardown's error to whichever test had just
  // finished, which is why it looked like two different assertions were flaky.
  // maxRetries/retryDelay is node's own answer to a concurrent writer; the
  // alternative (making the journal awaitable) would put disk latency on the
  // engine's hot path to make a test tidier.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  // NEVER `delete`: an unset OPENGROUND_HOME aims every later write in this
  // process at the REAL ~/.openground (the 2026-07-18 data loss).
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

const readInbox = async (): Promise<Escalation[]> =>
  (JSON.parse(await readFile(escalationsFile(), 'utf8')) as { items: Escalation[] }).items

const sdkInput = (over: Partial<OpenEscalationInput> = {}): OpenEscalationInput => ({
  projectPath: project,
  question: 'この移行で既存の worktree を消してよいですか？',
  context: '消すと復元できない。',
  whyEscalated: 'irreversible',
  taskId: 'card-sdk',
  branch: 'swarm/card-sdk',
  // The address exactly as the engine holds it for an SDK worker: the runtime,
  // the SDK handle, and an EMPTY terminalId (never absent — that empty string is
  // the trap the old code walked into).
  runtime: 'sdk',
  sdkSessionId: 'sdk-1',
  terminalId: '',
  ...over,
})

/** The delivery seams, recorded. `push` is the SDK conduit (`pushSdkInput`) and
 *  `write` the PTY one (`writeInput`) — the two bytes-on-the-wire ends of
 *  `deliverAnswerToWorker`. Asserting on THESE is the difference between "the
 *  code branched somewhere" and "the worker got the answer". */
const answerSeams = () => {
  const pushes: { id: string; text: string }[] = []
  const writes: { id: string; data: string }[] = []
  const queued: { taskId: string; line: string }[] = []
  return {
    pushes,
    writes,
    queued,
    deps: {
      isPathAllowed: async () => true,
      appendMemory: async () => {},
      canPushInto: async () => true,
      push: (id: string, text: string) => {
        pushes.push({ id, text })
        return true
      },
      canInjectInto: async () => true,
      write: (id: string, data: string) => {
        writes.push({ id, data })
        return true
      },
      sleep: async () => {},
      readScreen: () => null, // no frame to judge by ⇒ both writes landed
      queueForNextDispatch: async (_p: string, taskId: string, line: string) => {
        queued.push({ taskId, line })
      },
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPE-LEVEL GUARD (enforced by `tsc`, NOT by this run — vitest strips types).
//
// `answerEscalation`'s dep bag is handed WHOLE to `deliverAnswerToWorker` as its
// `DeliverAnswerDeps`, so `readScreen` (the PTY landing check) has always reached
// production through this type — while `AnswerEscalationDeps` did not declare it.
// `answerSeams()` above only got away with passing it because excess-property
// checking fires on object LITERALS and not on a helper's inferred return type
// (verified standalone against this repo's tsc: the helper form compiles, the
// inline form errors TS2353). The literal below is the inline form, so a
// regression that deletes the declaration fails the type gate instead of quietly
// re-creating an undeclared-dep situation.
const _readScreenIsDeclared: AnswerEscalationDeps = { readScreen: () => null }
void _readScreenIsDeclared

describe('① the escalation RECORD carries the blocked worker’s full address', () => {
  it('persists runtime + sdkSessionId for an SDK worker', async () => {
    await openEscalation(sdkInput(), { notify: async () => {} })
    const [rec] = await readInbox()
    expect(rec.runtime).toBe('sdk')
    expect(rec.sdkSessionId).toBe('sdk-1')
    // …and NOT the empty terminalId it was handed: a record carrying `''` as an
    // address is indistinguishable from one carrying a real id at every reader.
    expect(rec.terminalId).toBeUndefined()
  })

  it('a PTY worker’s record is byte-identical to what it always was (no runtime field)', async () => {
    // Absent ⇒ 'pty' everywhere. Writing `runtime:'pty'` would make records from
    // before and after this change differ for no behavioural reason.
    await openEscalation(
      { ...sdkInput(), runtime: undefined, sdkSessionId: undefined, terminalId: 'pty-1' },
      { notify: async () => {}, captureScreen: () => null },
    )
    const [rec] = await readInbox()
    expect(rec.terminalId).toBe('pty-1')
    expect(rec.runtime).toBeUndefined()
    expect(rec.sdkSessionId).toBeUndefined()
  })
})

describe('② the owner’s answer ARRIVES at the SDK worker', () => {
  it('pushes the answer into the SDK session — not the next-dispatch queue', async () => {
    const { escalation } = await openEscalation(sdkInput(), { notify: async () => {} })
    const seams = answerSeams()
    const res = await answerEscalation(escalation.id, 'はい、消して構いません', seams.deps)

    expect(res.delivery).toBe('injected')
    // The bytes reached the SDK pool, addressed by the SDK handle.
    expect(seams.pushes).toHaveLength(1)
    expect(seams.pushes[0].id).toBe('sdk-1')
    expect(seams.pushes[0].text).toContain('はい、消して構いません')
    expect(seams.pushes[0].text).toContain('【本人からの回答】')
    // The PTY conduit was never touched, and the fallback never fired: a 'queued'
    // here is the exact false success the old code reported — the owner is told
    // the answer was delivered while the worker sits waiting for a turn that
    // will only arrive if the card is ever re-dispatched.
    expect(seams.writes).toHaveLength(0)
    expect(seams.queued).toHaveLength(0)
    // Persisted as delivered, so the inbox stops showing it as open.
    const [rec] = await readInbox()
    expect(rec.status).toBe('injected')
  })

  it('a LEGACY record (written before `runtime` existed) still delivers to its PTY', async () => {
    // Backward compatibility is not a nicety here: escalations.json is
    // accumulate-only and uncapped, so records predating this field are the
    // normal case on every existing install. Hand-written on disk in the exact
    // pre-change shape rather than produced by today's writer.
    await mkdir(home, { recursive: true })
    const legacy: Escalation = {
      id: 'legacy-1',
      receiptKey: 'k1',
      createdAt: new Date().toISOString(),
      projectPath: await realpath(project),
      taskId: 'card-old',
      branch: 'swarm/card-old',
      terminalId: 'pty-old',
      question: '古い質問?',
      context: 'ctx',
      whyEscalated: 'policy',
      status: 'open',
    }
    await writeFile(escalationsFile(), JSON.stringify({ items: [legacy] }), 'utf8')

    const seams = answerSeams()
    const res = await answerEscalation('legacy-1', '旧経路の回答', seams.deps)
    expect(res.delivery).toBe('injected')
    expect(seams.writes.length).toBeGreaterThan(0)
    expect(seams.writes.every((w) => w.id === 'pty-old')).toBe(true)
    expect(seams.pushes).toHaveLength(0)
  })

  it('a re-raise that moves the worker to the OTHER runtime replaces the whole address', async () => {
    // A respawn can land on a different runtime (the sdk dial falling back to a
    // PTY, or the reverse). Merging the new handle field-by-field would leave a
    // record holding BOTH ids, and the answer would go to whichever the reader
    // looks at first — i.e. to the dead desk.
    const first = await openEscalation(
      { ...sdkInput(), runtime: undefined, sdkSessionId: undefined, terminalId: 'pty-1' },
      { notify: async () => {}, captureScreen: () => null },
    )
    const second = await openEscalation(sdkInput(), { notify: async () => {} })
    expect(second.deduped).toBe(true)
    expect(second.escalation.id).toBe(first.escalation.id)

    const [rec] = await readInbox()
    expect(rec.runtime).toBe('sdk')
    expect(rec.sdkSessionId).toBe('sdk-1')
    expect(rec.terminalId).toBeUndefined() // the stale PTY handle is GONE

    const seams = answerSeams()
    await answerEscalation(rec.id, '回答', seams.deps)
    expect(seams.pushes.map((p) => p.id)).toEqual(['sdk-1'])
    expect(seams.writes).toHaveLength(0)
  })
})

describe('④ the evidence tail comes from the worker’s OWN runtime', () => {
  it('captures an SDK session’s recent events, and expands them on the record', async () => {
    const tail = '[sdk session working]\n[tool] Bash(npm test)\n[tool error] 3 failing'
    const { escalation } = await openEscalation(sdkInput(), {
      notify: async () => {},
      captureSdk: (id) => (id === 'sdk-1' ? tail : null),
    })
    expect(escalation.screenshotRef).toBeTruthy()
    expect(await readFile(escalation.screenshotRef as string, 'utf8')).toBe(tail)
  })

  it('NEVER asks the PTY pool about an SDK worker (the one-pool question)', async () => {
    // The failure this pins is not "no evidence" but "evidence from the wrong
    // pool": `captureScreen('')` — or worse, `captureScreen(<sdk id>)` — is the
    // shape that silently returns another desk's screen.
    const asked: string[] = []
    const { escalation } = await openEscalation(sdkInput(), {
      notify: async () => {},
      captureScreen: (id) => {
        asked.push(id)
        return 'A DIFFERENT DESK’S SCREEN'
      },
      // captureSdk deliberately omitted — the SDK arm must resolve its own
      // default, never fall back onto the PTY one.
    })
    expect(asked).toEqual([])
    expect(escalation.screenshotRef).toBeUndefined()
  })
})

// ── The engine side ──────────────────────────────────────────────────────────

const T0 = Date.parse('2026-06-25T00:00:00Z')
const RULE = '─'.repeat(100)
/** A live-faithful idle question frame (provenance: swarmQuestions.test.ts). The
 *  CLI's own chrome — not a shape invented here — because `detectFreeTextQuestion`
 *  is production code and must do the classifying. */
const QUESTION_SCREEN = [
  '⏺ 質問がひとつあります。',
  '  どのデータベースを使いますか？',
  '✻ Brewed for 7s',
  RULE,
  '❯ ',
  RULE,
  '  ? for shortcuts · ← for agents',
].join('\n')

/** The SDK worker's question, in the shape the SDK runtime ACTUALLY emits —
 *  status head + distilled tail, composed with the production writers. Until
 *  2026-08-03 the SDK tests below served the TUI frame above instead; the
 *  runtime-blind classifier accepted it, which meant they were green through an
 *  input production can never produce (VERIFICATION.md §3). The kind-aware
 *  classifier rejects that frame — correctly — and these fixtures moved to the
 *  real shape the same day the "once the classifier learns its output shape"
 *  note below stopped being future tense. */
const SDK_QUESTION_OUTPUT = [
  sdkRecentOutputHead('waiting'),
  renderSdkTail([
    { kind: 'text', text: '質問がひとつあります。\nどのデータベースを使いますか？' },
  ]),
].join('\n')

const card = (id: string, over: Partial<ProjectTask> = {}): ProjectTask => ({
  id,
  title: `task ${id}`,
  done: false,
  createdAt: '2026-06-23T00:00:01Z',
  boardColumn: 'todo',
  ...over,
})

const newEngine = (over: Partial<ProjectEngine> = {}): ProjectEngine =>
  ({
    path: project,
    running: true,
    passInFlight: false,
    generation: 0,
    timer: null,
    workers: [],
    reviews: [],
    conflictedBranches: new Set(),
    verifyFailed: new Map(),
    reviewFailed: new Map(),
    reviewDeferred: new Map(),
    highRiskHolds: new Map(),
    lastIntegrateAt: 0,
    recoveries: new Map(),
    reworks: new Map(),
    reworkReasons: new Map(),
    conflictReworks: new Map(),
    stuckMoves: new Map(),
    nudges: new Map(),
    rateLimited: new Map(),
    permissionWaits: new Map(),
    log: [],
    anomalies: [],
    selfSupply: initSelfSupplyRuntime(),
    overseer: initOverseerRuntime(),
    notified: new Set(),
    pendingFatal: [],
    metrics: emptyMetricsCounters(),
    ...over,
  }) as ProjectEngine

/** A minimal recording dep set. Everything is keyed by `workerKey(w)` — the same
 *  addressing rule the engine itself must follow — so a fake can never make a
 *  terminalId-keyed call site look correct. */
const makeDeps = (init: {
  cards: ProjectTask[]
  screens?: Map<string, string>
  spawn?: Partial<SpawnSwarmWorkerResponse>
}) => {
  const board = new Map(init.cards.map((c) => [c.id, { ...c }]))
  const screens = init.screens ?? new Map<string, string>()
  const raised: OpenEscalationInput[] = []
  const raiseImpl: { fn: (i: OpenEscalationInput) => Promise<unknown> } = {
    fn: async (i) => {
      raised.push(i)
      return { escalation: { id: 'x' }, deduped: false }
    },
  }
  const deps: OrchestratorDeps & { raised: OpenEscalationInput[] } = {
    raised,
    fetchTasks: async () => Array.from(board.values()),
    moveToDoing: async (_p, id) => {
      const c = board.get(id)
      if (c) board.set(id, { ...c, boardColumn: 'doing' })
      return true
    },
    moveToReview: async () => true,
    spawnWorker: async () => ({
      terminalId: 'pty-new',
      agentSessionId: 'sess-new',
      worktree: '/wt/new',
      branch: 'swarm/new',
      ...init.spawn,
    }),
    isAlive: () => true,
    countCommitsAhead: async () => 0,
    readHeartbeat: async () => null,
    recoverCard: async () => true,
    recoverWorker: async () => ({ removed: true }),
    lastOutputAt: () => null,
    nudge: () => true,
    escalate: async () => true,
    recentOutput: (w) => screens.get(workerKey(w)) ?? null,
    raiseQuestion: (i) => raiseImpl.fn(i),
  }
  return { deps, raised, raiseImpl, board }
}

describe('② the RAISER hands the inbox a complete address', () => {
  const sdkWorker = (): OrchestratorWorker => ({
    terminalId: '', // empty by the identity invariant — the whole trap in one field
    runtime: 'sdk',
    sdkSessionId: 'sdk-a-1',
    branch: 'swarm/a',
    worktree: '/wt/a',
    taskId: 'a',
    taskTitle: 'task a',
    startedAt: new Date(T0).toISOString(),
    stage: 'running',
  })

  it("an SDK worker's question is raised after ONE minute, not ten (2026-08-03)", async () => {
    // The 10-minute silence gate is the PTY's proof of idleness; the SDK
    // detector already carries the stronger proof (the pool's turn-ended head),
    // so the gate admits it after only the debounce. Measured cost of the old
    // inheritance: the 0.11.52 acceptance sat the OWNER in front of an
    // already-asked question for ten straight minutes, twice.
    const engine = newEngine({ workers: [sdkWorker()] })
    const { deps, raised } = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['sdk-a-1', SDK_QUESTION_OUTPUT]]),
    })
    // Under the debounce: NOT raised (back-to-back turns must not spam the inbox).
    await runDispatchPass(engine, deps, T0 + SDK_QUESTION_SILENCE_MS - 1_000)
    expect(raised).toHaveLength(0)
    // Past the debounce, far under ten minutes: raised.
    await runDispatchPass(engine, deps, T0 + SDK_QUESTION_SILENCE_MS + 1_000)
    expect(raised).toHaveLength(1)
    expect(raised[0].runtime).toBe('sdk')
  })

  it('a PTY worker still waits the full ten minutes — the fast lane is sdk-question-shaped only', async () => {
    // The false-kill fix must survive: a PTY worker PRINTING question-shaped
    // text mid-work is only proven idle by long silence. Widening the fast lane
    // to PTY would re-create the 2026-07 false-positive class the 10-minute
    // gate was built against.
    const engine = newEngine({
      workers: [
        {
          terminalId: 'pty-a-1',
          branch: 'swarm/a',
          worktree: '/wt/a',
          taskId: 'a',
          taskTitle: 'task a',
          startedAt: new Date(T0).toISOString(),
          stage: 'running',
        },
      ],
    })
    const { deps, raised } = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', QUESTION_SCREEN]]),
    })
    await runDispatchPass(engine, deps, T0 + SDK_QUESTION_SILENCE_MS + 1_000)
    expect(raised).toHaveLength(0) // one minute is NOT enough for a PTY
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(raised).toHaveLength(1) // ten minutes is, exactly as before
  })

  it('carries runtime + sdkSessionId, not just the (empty) terminalId', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    // The screen is served through the production `recentOutput` seam, keyed by
    // workerKey — i.e. exactly how the engine will read an SDK worker once the
    // classifier learns its output shape (workerRuntime.ts names that as OPEN).
    // The raise site must already be addressing it correctly by then, because the
    // failure mode is silent: an inbox row nobody can answer.
    const { deps, raised } = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['sdk-a-1', SDK_QUESTION_OUTPUT]]),
    })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)

    expect(raised).toHaveLength(1)
    expect(raised[0].runtime).toBe('sdk')
    expect(raised[0].sdkSessionId).toBe('sdk-a-1')
    expect(raised[0].branch).toBe('swarm/a')
  })

  it('end-to-end: worker asks → real inbox record → owner answers → the SDK session receives it', async () => {
    // The one test that proves the WHOLE conduit rather than any single hop:
    // the raiser is wired to the REAL openEscalation, the record goes to the real
    // file, and the answer comes back out at the SDK push seam. Every earlier
    // version of this loop passed its own unit tests and still could not deliver
    // a single answer.
    const engine = newEngine({ workers: [sdkWorker()] })
    const { deps, raiseImpl } = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['sdk-a-1', SDK_QUESTION_OUTPUT]]),
    })
    raiseImpl.fn = (i) => openEscalation(i, { notify: async () => {}, captureSdk: () => null })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)

    const [rec] = await readInbox()
    expect(rec.question).toContain('どのデータベースを使いますか？')

    const seams = answerSeams()
    const res = await answerEscalation(rec.id, 'Postgres で', seams.deps)
    expect(res.delivery).toBe('injected')
    expect(seams.pushes).toHaveLength(1)
    expect(seams.pushes[0].id).toBe('sdk-a-1')
    expect(seams.pushes[0].text).toContain('Postgres で')
    expect(seams.queued).toHaveLength(0)
  })
})

describe('③ an unattended runtime degrade is ANNOUNCED', () => {
  it('records fellBackBecause in the engine log when the engine dispatches', async () => {
    // On the manual route this reason rides the HTTP response and the Swarm panel
    // shows it. The engine holds no response, and the server is a forked child in
    // a packaged app, so swarmWorker's console.warn reaches nobody: without this
    // line the owner flips the SDK dial on, every worker comes up as a PTY, and
    // there is no explanation anywhere.
    const engine = newEngine()
    const { deps } = makeDeps({
      cards: [card('a')],
      spawn: { fellBackBecause: 'SDK worker slots are full (2/2) — this worker runs as a PTY' },
    })
    await runDispatchPass(engine, deps, T0)

    const line = engine.log.find((l) => l.message.includes('SDK worker slots are full'))
    expect(line, 'the fallback reason must reach the engine journal').toBeTruthy()
    expect(line?.level).toBe('warn')
    // NOT counted as a failed dispatch — the worker IS running, just on the other
    // runtime. A `kind:'dispatch'` here would move the dispatchFailed KPI.
    expect(line?.kind).toBeUndefined()
    expect(engine.metrics?.dispatchFailed ?? 0).toBe(0)
  })

  it('says nothing when there was no fallback (no noise on the normal path)', async () => {
    const engine = newEngine()
    const { deps } = makeDeps({ cards: [card('a')] })
    await runDispatchPass(engine, deps, T0)
    expect(engine.log.some((l) => l.message.includes('runtime fallback'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ THE RECORD'S `runtime` DECIDES — never "whichever id is truthy".
//
// `deliverAnswer`'s comment calls this load-bearing, and it is: the ONE thing it
// buys over "prefer the id that is set" is a record carrying BOTH ids, which is
// exactly what a hand-edited / half-migrated / forward-compat file produces. Not
// one of the runtime tests above had ever passed such a record through, so the
// claim was untested in both directions — the failure is silent (the answer goes
// to the DEAD desk and the record is stamped 'injected').
//
// Two cases, because a one-sided test only pins one preference order.
// ─────────────────────────────────────────────────────────────────────────────

describe('⑤ a record carrying BOTH ids delivers by `runtime`, not by truthiness', () => {
  /** Write one record straight to disk — today's writer NORMALIZES to a single
   *  handle (addressOf), so a both-ids record cannot be produced through it. */
  const writeRecord = async (over: Partial<Escalation>): Promise<string> => {
    const rec: Escalation = {
      id: 'both-1',
      receiptKey: 'both-rk',
      createdAt: new Date().toISOString(),
      projectPath: await realpath(project),
      taskId: 'card-both',
      branch: 'swarm/both',
      question: '両方のIDを持つレコード?',
      context: 'ctx',
      whyEscalated: 'policy',
      status: 'open',
      terminalId: 'pty-stale',
      sdkSessionId: 'sdk-stale',
      ...over,
    }
    await writeFile(escalationsFile(), JSON.stringify({ items: [rec] }), 'utf8')
    return rec.id
  }

  it('runtime:"sdk" + BOTH ids → the SDK session, and the PTY is never touched', async () => {
    const id = await writeRecord({ runtime: 'sdk' })
    const seams = answerSeams()
    const res = await answerEscalation(id, 'SDK 側に届くべき回答', seams.deps)

    expect(res.delivery).toBe('injected')
    expect(seams.pushes.map((p) => p.id)).toEqual(['sdk-stale'])
    // A reader that preferred `terminalId` would have typed the owner's answer
    // into a PTY this worker does not own — and reported it delivered.
    expect(seams.writes).toHaveLength(0)
    expect(seams.queued).toHaveLength(0)
  })

  it('NO runtime (⇒ pty) + BOTH ids → the PTY, and the SDK pool is never touched', async () => {
    // The other direction, and the one a "prefer sdkSessionId when present"
    // shortcut breaks: absent `runtime` means pty EVERYWHERE (workerRuntime.ts),
    // so a stray sdkSessionId on a legacy record must change nothing.
    const id = await writeRecord({ runtime: undefined })
    const seams = answerSeams()
    const res = await answerEscalation(id, 'PTY 側に届くべき回答', seams.deps)

    expect(res.delivery).toBe('injected')
    expect(seams.writes.length).toBeGreaterThan(0)
    expect(seams.writes.every((w) => w.id === 'pty-stale')).toBe(true)
    expect(seams.pushes).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ THE RAISERS THAT STILL HELD ONLY A terminalId.
//
// The record can carry the whole address and delivery can read it — but only if
// the thing that OPENS the record was handed the whole address. Three raise
// sites passed `terminalId` alone while holding the rest:
//   • swarmOverseer's `raiseToInbox` (S4 THROTTLED direct raise, and both
//     brain-drain lanes — every one of which had `runtime`/`sdkSessionId` in
//     hand and dropped them);
//   • swarmQuestions' `handleWorkerQuestion` (PTY-only delivery AND PTY-only
//     escalation coords);
//   • POST /api/swarm/escalations/open (no field for the SDK handle at all).
// All three failed SILENTLY: an inbox row appears, the owner answers it, and
// the answer goes to the next-dispatch queue instead of the waiting worker.
// ─────────────────────────────────────────────────────────────────────────────

const sdkRosterWorker = () => ({
  // EMPTY, never absent — the field that made every one of these look fine.
  terminalId: '',
  runtime: 'sdk' as const,
  sdkSessionId: 'sdk-w1',
  branch: 'swarm/w1',
  taskId: 'card-w1',
  taskTitle: 'SDK のカード',
})

const overseerEngine = (over: Partial<OverseerEngine> = {}): OverseerEngine => ({
  path: project,
  running: true,
  anomalies: [],
  notified: new Set<string>(),
  workers: [sdkRosterWorker()],
  reviews: [],
  overseer: {
    ...initOverseerRuntime(),
    enabled: true,
    // Park the incidental W6 janitor far in the future — it is not under test.
    lastJanitorAt: Number.MAX_SAFE_INTEGER,
  },
  ...over,
})

const overseerDeps = (
  raised: OpenEscalationInput[],
  over: Partial<OverseerDeps> = {},
): OverseerDeps => ({
  now: () => 1_000_000_000_000,
  isAlive: () => true,
  readHeartbeat: async () => null,
  answerAsOwner: async () => ({ kind: 'answer', text: 'ok', confidence: 'high' }),
  openEscalation: async (input) => {
    raised.push(input)
    return { escalation: { id: `esc-${raised.length}`, status: 'open' } as never, deduped: false }
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

describe('⑥a the overseer’s raiseToInbox carries the worker’s WHOLE address', () => {
  it('S4 THROTTLED (bare question → inbox) names the SDK session', async () => {
    // The degraded lane: usage ≥100% pauses the brain, so the worker's question
    // goes straight to the human. This is the moment the owner matters MOST, and
    // it was raising rows addressed to nobody.
    const raised: OpenEscalationInput[] = []
    const engine = overseerEngine()
    await runOverseerPass(
      engine,
      [],
      () => {},
      overseerDeps(raised, {
        peekUsagePct: () => 100, // ⇒ usageLevel 'over' ⇒ ov.throttled
        readHeartbeat: async () => ({
          ready: false,
          blocked: true,
          blockers: 'main に直接 push してよいですか？',
        }),
      }),
    )

    expect(raised).toHaveLength(1)
    expect(raised[0].runtime).toBe('sdk')
    expect(raised[0].sdkSessionId).toBe('sdk-w1')
    expect(raised[0].branch).toBe('swarm/w1')
    // …and NOT the empty terminalId it used to forward: `''` on the wire is a
    // handle that names nobody, and openEscalation would store no address at all.
    expect(raised[0].terminalId).toBeFalsy()
  })

  it('the brain-drain’s “delivery failed → inbox” lane names the SDK session', async () => {
    // This record exists BECAUSE delivery failed, so the inbox row is the owner's
    // ONLY remaining route back to that worker. Dropping the address here means
    // the proxy's answer can never reach it by any path.
    const raised: OpenEscalationInput[] = []
    const engine = overseerEngine()
    engine.overseer.brainResults.push({
      signalKey: 'S4:sdk-w1',
      question: 'どちらの案で進めますか？',
      context: 'ctx',
      taskId: 'card-w1',
      branch: 'swarm/w1',
      runtime: 'sdk',
      sdkSessionId: 'sdk-w1',
      terminalId: '',
      answer: { kind: 'answer', text: 'A案で', confidence: 'high' },
    })
    await runOverseerPass(
      engine,
      [],
      () => {},
      overseerDeps(raised, { deliverAnswer: async () => false }),
    )

    expect(raised).toHaveLength(1)
    expect(raised[0].runtime).toBe('sdk')
    expect(raised[0].sdkSessionId).toBe('sdk-w1')
    expect(raised[0].proxyDraft?.answer).toBe('A案で')
  })

  it('the brain-drain’s ESCALATE lane names the SDK session', async () => {
    const raised: OpenEscalationInput[] = []
    const engine = overseerEngine()
    engine.overseer.brainResults.push({
      signalKey: 'S4:sdk-w1',
      question: 'この worktree を消してよいですか？',
      context: 'ctx',
      taskId: 'card-w1',
      branch: 'swarm/w1',
      runtime: 'sdk',
      sdkSessionId: 'sdk-w1',
      terminalId: '',
      answer: { kind: 'escalate', why: 'irreversible', reason: '不可逆' },
    })
    await runOverseerPass(engine, [], () => {}, overseerDeps(raised))

    expect(raised).toHaveLength(1)
    expect(raised[0].whyEscalated).toBe('irreversible')
    expect(raised[0].runtime).toBe('sdk')
    expect(raised[0].sdkSessionId).toBe('sdk-w1')
  })

  it('a PTY worker’s raise is unchanged (no runtime field, the real terminalId)', async () => {
    const raised: OpenEscalationInput[] = []
    const engine = overseerEngine({
      workers: [
        {
          terminalId: 'pty-w1',
          branch: 'swarm/p1',
          taskId: 'card-p1',
          taskTitle: 'PTY のカード',
        },
      ],
    })
    await runOverseerPass(
      engine,
      [],
      () => {},
      overseerDeps(raised, {
        peekUsagePct: () => 100,
        readHeartbeat: async () => ({ ready: false, blocked: true, blockers: 'どうしますか？' }),
      }),
    )
    expect(raised).toHaveLength(1)
    expect(raised[0].terminalId).toBe('pty-w1')
    expect(raised[0].runtime).toBeUndefined()
    expect(raised[0].sdkSessionId).toBeUndefined()
  })
})

describe('⑥b handleWorkerQuestion delivers on the worker’s OWN runtime', () => {
  const question = {
    projectPath: '/proj',
    question: 'どのDBを使いますか？',
    context: 'ctx',
    taskId: 'card-q',
    branch: 'swarm/q',
  }
  const ptyIsPoison = {
    canInjectInto: async () => {
      throw new Error('the PTY pool must never be asked about an SDK worker')
    },
    inject: async () => {
      throw new Error('the PTY pool must never be written to for an SDK worker')
    },
  }

  it('pushes the answer into the SDK session — the PTY pool is never asked', async () => {
    const pushes: { id: string; text: string }[] = []
    const out = await handleWorkerQuestion(
      { ...question, runtime: 'sdk', sdkSessionId: 'sdk-q1', terminalId: '' },
      {
        ...ptyIsPoison,
        answer: async () => ({ kind: 'answer', text: 'Postgres で', confidence: 'high' }),
        canPushInto: async () => true,
        push: (id, text) => {
          pushes.push({ id, text })
          return true
        },
        escalate: async () => {
          throw new Error('a delivered answer must not also be escalated')
        },
      },
    )

    expect(out).toEqual({ outcome: 'injected', answer: 'Postgres で', confidence: 'high' })
    expect(pushes).toHaveLength(1)
    expect(pushes[0].id).toBe('sdk-q1')
    expect(pushes[0].text).toContain('Postgres で')
    expect(pushes[0].text).toContain('どのDBを使いますか？')
  })

  it('when the SDK target refuses, the escalation still NAMES that session', async () => {
    // The fallback row has to be answerable. Raising it without the address is
    // the same dead end as not raising it at all.
    const raised: OpenEscalationInput[] = []
    const out = await handleWorkerQuestion(
      { ...question, runtime: 'sdk', sdkSessionId: 'sdk-q1', terminalId: '' },
      {
        ...ptyIsPoison,
        answer: async () => ({ kind: 'answer', text: 'A案で', confidence: 'medium' }),
        canPushInto: async () => false,
        push: () => {
          throw new Error('must not push past a refusing guard')
        },
        escalate: async (i) => {
          raised.push(i)
          return { escalation: { id: 'e1' } as Escalation, deduped: false }
        },
      },
    )

    expect(out.outcome).toBe('escalated')
    expect(raised[0].runtime).toBe('sdk')
    expect(raised[0].sdkSessionId).toBe('sdk-q1')
    expect(raised[0].terminalId).toBeFalsy()
    expect(raised[0].proxyDraft?.answer).toBe('A案で')
  })

  it('a PTY worker still goes through the PTY seams (unchanged)', async () => {
    const injected: { id: string; text: string }[] = []
    const out = await handleWorkerQuestion(
      { ...question, terminalId: 'pty-q1' },
      {
        answer: async () => ({ kind: 'answer', text: 'SQLiteで', confidence: 'high' }),
        canInjectInto: async () => true,
        inject: async (id, text) => {
          injected.push({ id, text })
          return true
        },
        push: () => {
          throw new Error('the SDK pool must never be pushed for a PTY worker')
        },
        escalate: async () => {
          throw new Error('must not escalate a delivered answer')
        },
      },
    )
    expect(out.outcome).toBe('injected')
    expect(injected.map((i) => i.id)).toEqual(['pty-q1'])
  })

  it('the whole conduit is overridable in ONE seam, and receives the whole handle', async () => {
    const seen: WorkerHandle[] = []
    await handleWorkerQuestion(
      { ...question, runtime: 'sdk', sdkSessionId: 'sdk-q1', terminalId: '' },
      {
        ...ptyIsPoison,
        answer: async () => ({ kind: 'answer', text: 'x', confidence: 'high' }),
        deliver: async (target) => {
          seen.push(target)
          return true
        },
        escalate: async () => {
          throw new Error('delivered')
        },
      },
    )
    expect(seen).toEqual([{ runtime: 'sdk', sdkSessionId: 'sdk-q1' }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥c THE HTTP RAISE — the door every raiser OUTSIDE the engine comes through
// (the commander skill, a manual curl, any external tool). It parsed
// `receiptKey / taskId / branch / terminalId` and nothing else, so an SDK worker
// could not be named from outside the process at all: the row appeared, and the
// owner's answer went to the next-dispatch queue forever.
//
// The length check is asserted too, on purpose: escalations.json is UNCAPPED and
// never pruned while 'open', so a new id-like field added to the passthrough but
// not to the validated list is an unbounded write straight into it.
// ─────────────────────────────────────────────────────────────────────────────

describe('⑥c POST /api/swarm/escalations/open accepts the worker’s ADDRESS', () => {
  const OWNER = 'owner@example.com'
  let routeProject: string
  let savedOwners: string | undefined
  let savedTesters: string | undefined

  beforeEach(async () => {
    savedOwners = process.env.OPENGROUND_OWNER_EMAILS
    savedTesters = process.env.OPENGROUND_TESTER_EMAILS
    process.env.OPENGROUND_OWNER_EMAILS = OWNER
    __resetMigrationCacheForTests()
    // OUTSIDE the isolated home, registered through the REAL registry so the
    // route crosses the same validateProjectPath boundary production does.
    routeProject = await realpath(await mkdtemp(join(tmpdir(), 'og-esc-route-proj-')))
    const imported = await addImportedProjectEntry(routeProject)
    if (!('entry' in imported)) throw new Error('test setup: import rejected')
    await writeSession({
      user: { id: 'test-user', email: OWNER, provider: 'google' },
      expiresAt: Date.now() + 3_600_000,
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
    })
  })

  afterEach(async () => {
    await clearSession()
    if (savedOwners !== undefined) process.env.OPENGROUND_OWNER_EMAILS = savedOwners
    else delete process.env.OPENGROUND_OWNER_EMAILS
    if (savedTesters !== undefined) process.env.OPENGROUND_TESTER_EMAILS = savedTesters
    await rm(routeProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const open = (over: Record<string, unknown> = {}) =>
    app.request('/api/swarm/escalations/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: routeProject,
        question: 'この移行を進めてよいですか？',
        context: '不可逆。',
        whyEscalated: 'irreversible',
        taskId: 'card-http',
        ...over,
      }),
    })

  it('persists runtime + sdkSessionId, and the owner’s answer reaches that session', async () => {
    const res = await open({ runtime: 'sdk', sdkSessionId: 'sdk-http-1', terminalId: '' })
    expect(res.status).toBe(200)

    const [rec] = (await readInbox()).filter((e) => e.taskId === 'card-http')
    expect(rec.runtime).toBe('sdk')
    expect(rec.sdkSessionId).toBe('sdk-http-1')
    expect(rec.terminalId).toBeUndefined()

    // The whole point: the row is ANSWERABLE. A record raised without the SDK
    // handle delivers 'queued' here — reported as success, worker still waiting.
    const seams = answerSeams()
    const out = await answerEscalation(rec.id, 'はい、進めてください', seams.deps)
    expect(out.delivery).toBe('injected')
    expect(seams.pushes.map((p) => p.id)).toEqual(['sdk-http-1'])
    expect(seams.queued).toHaveLength(0)
  })

  it('refuses an unknown runtime rather than silently downgrading it to a PTY', async () => {
    const res = await open({ runtime: 'agent', sdkSessionId: 'sdk-http-2' })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('runtime'),
    })
  })

  it('bounds sdkSessionId like every other id-like field (uncapped file)', async () => {
    const res = await open({ runtime: 'sdk', sdkSessionId: 'x'.repeat(600) })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('sdkSessionId'),
    })
  })

  it('a PTY raise over HTTP is unchanged (no runtime field on the record)', async () => {
    const res = await open({ terminalId: 'pty-http-1' })
    expect(res.status).toBe(200)
    const [rec] = (await readInbox()).filter((e) => e.taskId === 'card-http')
    expect(rec.terminalId).toBe('pty-http-1')
    expect(rec.runtime).toBeUndefined()
    expect(rec.sdkSessionId).toBeUndefined()
  })
})
