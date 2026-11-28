// @vitest-environment node
//
// RESUME GAPS (docs/AUTONOMY-SPEC.md R-C1(2), R-C2 — unit U6).
//
//  (1) A worker refused by the usage limit whose SDK session the pool has since
//      forgotten (its linger ran out while the engine was off, the Mac slept, a
//      runtime switch held the pass) arrived at the dead-worker path with no
//      "last words": the refusal read as a crash and a branch with commits
//      parked the card in `blocked`, where nothing brings it back when the limit
//      lifts. The transcript still records the refusal (`isApiErrorMessage`).
//  (2) A turn that ended on `terminal_reason: api_error` (network loss, sleep,
//      provider 5xx) left the worker — or the commander — sitting `waiting` until
//      the 10-minute stall arm. It now gets one "continue" as soon as the API host
//      answers, at most 3 times per card attempt; after that the stall path rules.
//
// Transcripts are written to a throwaway directory under the OS tmpdir and the
// reader is handed that path — never the real ~/.claude.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { rm } from 'fs/promises'
import {
  runDispatchPass,
  __resetOrchestratorForTests,
  defaultDeps,
  emptyMetricsCounters,
  STALL_SILENCE_MS,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { apiErrorTurnSeq, lastTranscriptUsageRefusal, TRANSCRIPT_TAIL_BYTES } from './swarmResumeEvidence'
import { __resetQuotaForTest, isTierCooling, MODEL_TIER_LADDER } from './swarmQuota'
import { initOverseerRuntime } from './swarmOverseer'
import { swarmNotificationsFile } from './paths'
import type { OrchestratorWorker, ProjectTask } from '../types'
import type { SdkEvent } from './sdkEvents'

vi.setConfig({ testTimeout: 60_000 })

const T0 = Date.parse('2026-11-28T07:00:00Z')
// The vendor's list as the SDK exports it (USAGE_LIMIT_ERROR_PREFIXES, 0.3.x) — a
// subset is enough for the shapes below.
const PREFIXES = ["You've hit your", "You've reached your", "You're out of usage credits"]
const REFUSAL = "You've hit your 5-hour limit · resets 2:50pm (Asia/Tokyo)"

const dir = mkdtempSync(join(tmpdir(), 'og-u6-transcripts-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let fileSeq = 0
/** One JSONL transcript in the throwaway dir, from records shaped like the CLI's. */
const transcript = (...records: unknown[]): string => {
  const file = join(dir, `t${++fileSeq}.jsonl`)
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}
const userLine = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const assistantLine = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', model: extra.isApiErrorMessage ? '<synthetic>' : 'claude', content: [{ type: 'text', text }] },
  ...extra,
})
const apiErrorLine = (text: string) => assistantLine(text, { isApiErrorMessage: true })

const card = (id: string, boardColumn = 'todo'): ProjectTask =>
  ({ id, title: `card ${id}`, notes: 'completion conditions', boardColumn, branch: `swarm/${id}` }) as unknown as ProjectTask

const sdkWorker = (over: Partial<OrchestratorWorker> = {}): OrchestratorWorker => ({
  terminalId: '',
  runtime: 'sdk',
  sdkSessionId: 'sdk-q1',
  sessionId: 'sess-q1',
  branch: 'swarm/q1',
  worktree: '/central/wt/q1',
  taskId: 'q1',
  taskTitle: 'quota me',
  startedAt: new Date(T0 - 30 * 60_000).toISOString(),
  stage: 'running',
  model: 'fable',
  reworkCount: 0,
  ...over,
})

const newEngine = (over: Partial<ProjectEngine> = {}): ProjectEngine =>
  ({
    path: '/proj',
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
    overseer: initOverseerRuntime(),
    notified: new Set(),
    pendingFatal: [],
    metrics: emptyMetricsCounters(),
    ...over,
  }) as ProjectEngine

type Deps = OrchestratorDeps & IntegrationDeps & AnomalyDeps
const stubDeps = (over: Record<string, unknown>): Deps =>
  ({
    ...defaultDeps(),
    fetchTasks: async () => [],
    spawnWorker: async () => {
      throw new Error('spawnWorker not stubbed for this test')
    },
    moveToDoing: async () => true,
    moveToReview: async () => true,
    recoverCard: vi.fn(async () => true),
    recoverWorker: vi.fn(async () => ({ removed: true })),
    countCommitsAhead: async () => 0,
    readHeartbeat: async () => null,
    lastOutputAt: () => null,
    recentOutput: () => null,
    quotaBlocked: () => false,
    isAlive: () => true,
    nudge: vi.fn(() => true),
    savedWorkHold: async () => [],
    sdkWorkerFacts: () => undefined,
    toolDenialStreak: () => 0,
    sessionAgentActivityAt: async () => null,
    sessionBackgroundTaskAt: async () => null,
    managerApiErrorTurn: () => null,
    isOnline: async () => true,
    ...over,
  }) as unknown as Deps

const messages = (engine: ProjectEngine) => engine.log.map((l) => l.message)

beforeEach(async () => {
  __resetOrchestratorForTests()
  __resetQuotaForTest()
  await rm(swarmNotificationsFile(), { force: true })
})
afterEach(async () => {
  __resetOrchestratorForTests()
  __resetQuotaForTest()
  await rm(swarmNotificationsFile(), { force: true })
})

// ── R-C1(2) ─────────────────────────────────────────────────────────────────

describe('the transcript reader: does it END on a usage-limit refusal?', () => {
  it('reads the CLI error entry the vendor prints', async () => {
    const file = transcript(userLine('go'), assistantLine('working on it'), apiErrorLine(REFUSAL), { type: 'system', subtype: 'x' })
    expect(await lastTranscriptUsageRefusal(file, PREFIXES)).toBe(REFUSAL)
  })

  it('a quote of the same sentence (no isApiErrorMessage marker) is not a refusal', async () => {
    const file = transcript(userLine('go'), assistantLine(`The worker printed: ${REFUSAL}`), assistantLine(REFUSAL))
    expect(await lastTranscriptUsageRefusal(file, PREFIXES)).toBeNull()
  })

  it('a refusal it moved on from (a normal reply after it) is not where it ended', async () => {
    const file = transcript(apiErrorLine(REFUSAL), userLine('Continue.'), assistantLine('resuming'))
    expect(await lastTranscriptUsageRefusal(file, PREFIXES)).toBeNull()
  })

  it('an API error that is not a usage limit is not a refusal', async () => {
    const file = transcript(userLine('go'), apiErrorLine('API Error: 529 Overloaded.'))
    expect(await lastTranscriptUsageRefusal(file, PREFIXES)).toBeNull()
  })

  it('a missing file, a torn last line and a refusal beyond the tail window answer safely', async () => {
    expect(await lastTranscriptUsageRefusal(join(dir, 'absent.jsonl'), PREFIXES)).toBeNull()
    const torn = transcript(apiErrorLine(REFUSAL))
    writeFileSync(torn, `${JSON.stringify(apiErrorLine(REFUSAL))}\n{"type":"assist`)
    expect(await lastTranscriptUsageRefusal(torn, PREFIXES)).toBe(REFUSAL)
    // A huge trailing non-assistant entry pushes the refusal out of the window:
    // nothing found ⇒ null (the old crash rule), never a guess.
    const far = transcript(apiErrorLine(REFUSAL), { type: 'user', pad: 'x'.repeat(TRANSCRIPT_TAIL_BYTES + 10) })
    expect(await lastTranscriptUsageRefusal(far, PREFIXES)).toBeNull()
  })
})

describe('a worker refused by the usage limit, gone, and forgotten by the pool is still a quota stop', () => {
  // Re-entered onto its branch (a quota requeue or 「やり直す」): the old commits are
  // not its own delivery, so a death is judged by recoveryColumn — commits ⇒ blocked.
  const reentered = { reenteredAt: new Date(T0 - 5 * 60_000).toISOString() }
  const gone = (file: string, over: Partial<OrchestratorWorker> = reentered) => {
    let column = 'doing'
    const moveToReview = vi.fn(async () => {
      column = 'review'
      return true
    })
    const engine = newEngine({ workers: [sdkWorker(over)] })
    const transcriptUsageRefusal = vi.fn(async () => lastTranscriptUsageRefusal(file, PREFIXES))
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', column)],
      isAlive: () => false,
      countCommitsAhead: async () => 3, // it had committed — the rule that parks a crash in blocked
      sdkWorkerFacts: () => undefined, // the pool has forgotten the session
      transcriptUsageRefusal,
      moveToReview,
      recoverCard: vi.fn(async (_p: string, _id: string, to: 'todo' | 'blocked') => {
        column = to
        return true
      }),
    })
    return { engine, deps, transcriptUsageRefusal, moveToReview, column: () => column }
  }

  it('card → todo (not blocked), every tier cools, and the journal says quota stop', async () => {
    const t = gone(transcript(userLine('go'), assistantLine('step 1 done'), apiErrorLine(REFUSAL)))
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.column()).toBe('todo')
    expect(t.transcriptUsageRefusal).toHaveBeenCalledWith('/central/wt/q1', 'sess-q1')
    expect(MODEL_TIER_LADDER.every((tier) => isTierCooling(tier, T0 + 1000))).toBe(true)
    expect(messages(t.engine).some((m) => m.includes('a quota stop, not a crash'))).toBe(true)
    expect(messages(t.engine).some((m) => m.includes('quota-stopped — requeued — card → todo'))).toBe(true)
    expect(messages(t.engine).some((m) => m.includes('worker lost'))).toBe(false)
  })

  it('a first-run worker with commits is requeued too — not handed to review as if it had finished', async () => {
    const t = gone(transcript(userLine('go'), apiErrorLine(REFUSAL)), {})
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.moveToReview).not.toHaveBeenCalled()
    expect(t.column()).toBe('todo')
  })

  it('a transcript that did not end on a refusal is still a crash: commits park the card in blocked', async () => {
    const t = gone(transcript(userLine('go'), apiErrorLine(REFUSAL), userLine('Continue.'), assistantLine('resumed, then died')))
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.column()).toBe('blocked')
    expect(MODEL_TIER_LADDER.some((tier) => isTierCooling(tier, T0 + 1000))).toBe(false)
  })

  it('while the pool still remembers the session, its verdict stands and the transcript is not read', async () => {
    const t = gone(transcript(apiErrorLine(REFUSAL)))
    t.deps.sdkWorkerFacts = () => ({ exitReason: 'error: boom' })
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.transcriptUsageRefusal).not.toHaveBeenCalled()
    expect(t.column()).toBe('blocked')
  })
})

// ── R-C2 ────────────────────────────────────────────────────────────────────

describe('which turn ended on a transient API error (the frame reading)', () => {
  const f = (seq: number, ev: SdkEvent) => ({ seq, ev })
  const end = (seq: number, reason = 'api_error') => f(seq, { kind: 'turn_end', reason, isError: true })
  const waiting = (seq: number) => f(seq, { kind: 'status', status: 'waiting' })

  it('api_error then its turn boundary, nothing since ⇒ the boundary', () => {
    expect(apiErrorTurnSeq([f(1, { kind: 'text', text: 'API Error: Unable to connect' }), f(2, { kind: 'api_error', status: null, head: 'Unable to connect' }), end(3), waiting(4)])).toBe(3)
  })
  it('a usage refusal is the quota arm\'s, not a retry', () => {
    expect(apiErrorTurnSeq([f(1, { kind: 'quota_refusal', raw: REFUSAL }), f(2, { kind: 'text', text: REFUSAL }), end(3), waiting(4)])).toBeUndefined()
  })
  it('a turn handed over since (our own "Continue.") clears it; a completed turn never matches', () => {
    expect(apiErrorTurnSeq([f(2, { kind: 'api_error', status: 529, head: 'overloaded' }), end(3), waiting(4), f(5, { kind: 'input', text: 'Continue.' })])).toBeUndefined()
    expect(apiErrorTurnSeq([f(1, { kind: 'text', text: 'done' }), end(2, 'completed'), waiting(3)])).toBeUndefined()
  })
})

describe('a worker whose turn ended on an API error is given "continue" once the API answers', () => {
  const setup = () => {
    const state = { seq: 3 as number | undefined, online: true, lastOut: T0 - 5_000 }
    const nudge = vi.fn(() => true)
    const engine = newEngine({ workers: [sdkWorker({ sdkSessionId: 'sdk-a1', taskId: 'a1', branch: 'swarm/a1', worktree: '/central/wt/a1' })] })
    const deps = stubDeps({
      fetchTasks: async () => [card('a1', 'doing')],
      countCommitsAhead: async () => 1,
      lastOutputAt: () => state.lastOut,
      sdkWorkerFacts: () => (state.seq === undefined ? {} : { apiErrorTurnSeq: state.seq }),
      isOnline: async () => state.online,
      nudge,
    })
    return { state, nudge, engine, deps }
  }

  it('reachable ⇒ one "continue" within the next pass, and not again for the same turn', async () => {
    const t = setup()
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.nudge).toHaveBeenCalledTimes(1)
    expect(messages(t.engine).some((m) => m.includes('turn ended on an API error') && m.includes('(1/3)'))).toBe(true)
    await runDispatchPass(t.engine, t.deps, T0 + 3_000)
    expect(t.nudge).toHaveBeenCalledTimes(1) // the same turn boundary is answered once
  })

  it('unreachable ⇒ none; the pass after the API host answers again ⇒ one', async () => {
    const t = setup()
    t.state.online = false
    await runDispatchPass(t.engine, t.deps, T0)
    await runDispatchPass(t.engine, t.deps, T0 + 3_000)
    expect(t.nudge).not.toHaveBeenCalled()
    t.state.online = true
    await runDispatchPass(t.engine, t.deps, T0 + 6_000)
    expect(t.nudge).toHaveBeenCalledTimes(1)
  })

  it('the fourth API-error turn gets none, and the stall path takes over', async () => {
    const t = setup()
    const seqs = [3, 7, 11]
    for (let i = 0; i < seqs.length; i++) {
      t.state.seq = seqs[i]
      await runDispatchPass(t.engine, t.deps, T0 + i * 3_000)
    }
    expect(t.nudge).toHaveBeenCalledTimes(3)
    t.state.seq = 15
    await runDispatchPass(t.engine, t.deps, T0 + 9_000)
    expect(t.nudge).toHaveBeenCalledTimes(3)
    // …and once it has been silent past the stall limit, the ordinary ladder pokes it.
    t.state.lastOut = T0 - STALL_SILENCE_MS - 60_000
    await runDispatchPass(t.engine, t.deps, T0 + 12_000)
    expect(t.nudge).toHaveBeenCalledTimes(4)
    expect(messages(t.engine).filter((m) => m.includes('turn ended on an API error'))).toHaveLength(3)
    expect(messages(t.engine).some((m) => m.includes('worker stalled') && m.includes('nudged (1/'))).toBe(true)
  })
})

describe('the commander gets the same "continue" after an API-error turn', () => {
  const setup = () => {
    const state = { seq: 4, online: true, desk: 'm1' }
    const say = vi.fn(() => true)
    const engine = newEngine()
    const deps = stubDeps({
      managerApiErrorTurn: () => ({ desk: state.desk, seq: state.seq, say }),
      isOnline: async () => state.online,
    })
    return { state, say, engine, deps }
  }

  it('reachable ⇒ one "continue" per API-error turn, at most 3 per desk; unreachable ⇒ none', async () => {
    const t = setup()
    t.state.online = false
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.say).not.toHaveBeenCalled()
    t.state.online = true
    await runDispatchPass(t.engine, t.deps, T0 + 3_000)
    await runDispatchPass(t.engine, t.deps, T0 + 6_000) // same turn: not again
    expect(t.say).toHaveBeenCalledTimes(1)
    expect(t.say).toHaveBeenCalledWith('Continue.')
    for (const seq of [8, 12, 16]) {
      t.state.seq = seq
      await runDispatchPass(t.engine, t.deps, T0 + seq * 1_000)
    }
    expect(t.say).toHaveBeenCalledTimes(3)
    // A fresh desk is a fresh conversation: its own budget.
    t.state.desk = 'm2'
    t.state.seq = 2
    await runDispatchPass(t.engine, t.deps, T0 + 30_000)
    expect(t.say).toHaveBeenCalledTimes(4)
  })
})
