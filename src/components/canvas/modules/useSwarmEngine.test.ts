// @vitest-environment jsdom
//
// Regression guard for the single-source worker list (card 70874f, reworked
// server-truth in 2e7beb2): the worker tab and the manager monitor render the
// SAME worker set, unified SERVER-side by GET /api/swarm/workers (that unify
// logic is tested in src/lib/server/swarmWorkerRegistry.test.ts). What the
// client owns — and what these tests lock — is the defensive sanitize layer
// over every untrusted route response the one poll loop consumes.

import { describe, it, expect } from 'vitest'
import {
  sanitizeSwarmWorkers,
  sanitizeEngineState,
  sanitizeKpis,
  sanitizeConsumption,
  sanitizeFatalNotifications,
  sanitizeEnvIssues,
  planSwarmPower,
  commanderPresence,
  EMPTY_KPIS,
  EMPTY_CONSUMPTION,
  DEFAULT_ENGINE,
} from './useSwarmEngine'

// The server-truth worker list (GET /api/swarm/workers) is the single source the
// Swarm worker tab renders. Which workers exist is the SERVER's call
// (swarmWorkerRegistry has its own tests); this layer only guards the render
// against an untrusted response shape — coerce every field, drop a row that
// can't be identified, never throw.
describe('sanitizeSwarmWorkers — the server-truth worker list survives the poll', () => {
  const full = {
    worktree: '/wt/w1',
    branch: 'swarm/w1',
    terminalId: 'term-1',
    taskId: 'task-1',
    taskTitle: 'T1',
    startedAt: '2026-07-07T00:00:00.000Z',
    stage: 'running',
    phase: 'implement',
    note: 'wiring',
    heartbeatAt: '2026-07-07T00:01:00.000Z',
    ready: true,
    blocked: true,
    blockers: 'waiting on X',
  }

  it('passes a well-formed row through, field by field', () => {
    expect(sanitizeSwarmWorkers({ workers: [full] })).toEqual([full])
  })

  it('drops a row with no identifiable worktree/branch, keeping the survivors', () => {
    const out = sanitizeSwarmWorkers({
      workers: [
        { ...full, worktree: undefined }, // no worktree → unidentifiable
        { ...full, branch: '' }, // empty branch → unidentifiable
        'nope', // not an object
        null,
        { worktree: '/wt/ok', branch: 'swarm/ok' }, // minimal valid row survives
      ],
    })
    expect(out).toEqual([{ worktree: '/wt/ok', branch: 'swarm/ok' }])
  })

  it('a garbage response degrades to the empty list (no throw)', () => {
    expect(sanitizeSwarmWorkers(null)).toEqual([])
    expect(sanitizeSwarmWorkers('boom')).toEqual([])
    expect(sanitizeSwarmWorkers({})).toEqual([])
    expect(sanitizeSwarmWorkers({ workers: 'nope' })).toEqual([])
  })

  it('coerces forged fields — unknown stage dropped, ready/blocked strictly true', () => {
    const out = sanitizeSwarmWorkers({
      workers: [
        {
          worktree: '/wt/w1',
          branch: 'swarm/w1',
          stage: 'exploded', // not starting|running|done → dropped
          ready: 'yes', // truthy-but-not-true → dropped (never a forged ready)
          blocked: 1, // same
          note: '', // empty optional string → dropped
          terminalId: 42, // wrong type → dropped
        },
      ],
    })
    expect(out).toEqual([{ worktree: '/wt/w1', branch: 'swarm/w1' }])
  })
})

describe('sanitizeEngineState — engine workers survive the poll', () => {
  it('parses engine workers from a raw orchestrator response, dropping malformed rows', () => {
    const raw = {
      running: true,
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
    expect(state.workers[0]).toMatchObject({ branch: 'swarm/eng-1', taskTitle: 'T1', stage: 'running' })
  })

  it('keeps every move-stuck intent the server can emit — including recover-review', () => {
    // The KNOWN_* allowlists are a lockstep hazard: 'no-heartbeat' was emitted by
    // the server but stripped here for months (2026-07-14), and 'recover-review'
    // repeated it on 2026-07-18 — added to the type, the label map and both
    // locales, but not to the runtime set, so the pane fell back to the generic
    // label. That intent is the ONLY surface for a ready worker whose card could
    // not be returned to 'review' (it is deliberately excluded from the blocked
    // escalation), so dropping it hid the state entirely. A ReadonlySet<string>
    // is invisible to tsc, so this test is the only guard.
    const anomaly = (intent: string) => ({ kind: 'move-stuck', ref: 't1', intent })
    const state = sanitizeEngineState({
      anomalies: ['review', 'done', 'recover', 'recover-review'].map(anomaly),
    })
    expect(state.anomalies.map((a) => a.intent)).toEqual([
      'review',
      'done',
      'recover',
      'recover-review',
    ])
    // …and an unknown one is still dropped (the allowlist keeps its teeth).
    expect(sanitizeEngineState({ anomalies: [anomaly('bogus')] }).anomalies[0]?.intent).toBeUndefined()
  })

  it('a garbage response degrades to the empty default (no throw)', () => {
    expect(sanitizeEngineState(null).workers).toEqual([])
    expect(sanitizeEngineState('boom').workers).toEqual([])
    expect(sanitizeEngineState(undefined).workers).toEqual([])
  })

  it('parses autonomyRemembered STRICTLY — true only for boolean true (the restart-reminder gate)', () => {
    // The banner shows while !running && autonomyRemembered, so a forged / absent /
    // garbage value must fold to FALSE — the fail-safe direction (no spurious reminder).
    expect(sanitizeEngineState({ autonomyRemembered: true }).autonomyRemembered).toBe(true)
    expect(sanitizeEngineState({ autonomyRemembered: false }).autonomyRemembered).toBe(false)
    expect(sanitizeEngineState({ autonomyRemembered: 'yes' }).autonomyRemembered).toBe(false)
    expect(sanitizeEngineState({ autonomyRemembered: 1 }).autonomyRemembered).toBe(false)
    expect(sanitizeEngineState({}).autonomyRemembered).toBe(false) // absent ⇒ off
    expect(sanitizeEngineState('boom').autonomyRemembered).toBe(false) // garbage ⇒ off
  })

  it('parses manualStop STRICTLY — true only for boolean true (the "stopped by hand" badge gate)', () => {
    // The power bar / flow pane show "stopped by hand" off this flag, so a forged /
    // absent / garbage value must fold to FALSE (no spurious deliberate-stop badge) —
    // and an OLD server that predates the field reads back as a plain stop.
    expect(sanitizeEngineState({ manualStop: true }).manualStop).toBe(true)
    expect(sanitizeEngineState({ manualStop: false }).manualStop).toBe(false)
    expect(sanitizeEngineState({ manualStop: 'yes' }).manualStop).toBe(false)
    expect(sanitizeEngineState({ manualStop: 1 }).manualStop).toBe(false)
    expect(sanitizeEngineState({}).manualStop).toBe(false) // absent (old server) ⇒ off
    expect(sanitizeEngineState('boom').manualStop).toBe(false) // garbage ⇒ off
    expect(DEFAULT_ENGINE.manualStop).toBe(false) // the offline default carries no badge
  })

  it('parses the commander heartbeat whole-or-null — a well-formed record survives, field by field', () => {
    // The inspection presence line renders off this — phase/note pass through
    // (display-only), fresh stays a server verdict, blank optionals are omitted.
    const full = {
      phase: 'merge',
      note: '統合中 — swarm/x を検品',
      updatedAt: '2026-07-17T09:00:00.000Z',
      ageMs: 120_000,
      fresh: true,
    }
    expect(sanitizeEngineState({ manager: full }).manager).toEqual(full)
    // Blank/absent optionals are dropped (same omit-when-blank as worker beats).
    const minimal = sanitizeEngineState({
      manager: { updatedAt: full.updatedAt, ageMs: 0, fresh: false, phase: '', note: 7 },
    }).manager
    expect(minimal).toEqual({ updatedAt: full.updatedAt, ageMs: 0, fresh: false })
  })

  it('drops a forged/broken commander heartbeat to null — the standby fail-safe (完了条件4)', () => {
    // A record missing its identity or freshness inputs is dropped WHOLE: the UI
    // must degrade to the standby wording, never render a half-trusted "active".
    const base = { updatedAt: '2026-07-17T09:00:00.000Z', ageMs: 1000, fresh: true }
    expect(sanitizeEngineState({ manager: { ...base, updatedAt: undefined } }).manager).toBeNull()
    expect(sanitizeEngineState({ manager: { ...base, updatedAt: '' } }).manager).toBeNull()
    expect(sanitizeEngineState({ manager: { ...base, ageMs: 'soon' } }).manager).toBeNull()
    expect(sanitizeEngineState({ manager: { ...base, ageMs: -5 } }).manager).toBeNull()
    expect(sanitizeEngineState({ manager: { ...base, ageMs: Infinity } }).manager).toBeNull()
    expect(sanitizeEngineState({ manager: 'boom' }).manager).toBeNull()
    expect(sanitizeEngineState({ manager: null }).manager).toBeNull()
    expect(sanitizeEngineState({}).manager).toBeNull() // absent (old server / action ack)
    expect(DEFAULT_ENGINE.manager).toBeNull() // the offline default shows standby
    // fresh is STRICT boolean true — a forged truthy string can't fake "active now".
    expect(sanitizeEngineState({ manager: { ...base, fresh: 'yes' } }).manager?.fresh).toBe(false)
  })
})

describe('commanderPresence — the heartbeat alone is NOT life (2026-08-04)', () => {
  const beat = { updatedAt: '2026-07-17T09:00:00.000Z', ageMs: 60_000, fresh: true }

  it('MEASURED DEFECT: a fresh heartbeat with no live desk is NOT "working"', () => {
    // This is the whole fix. `fresh` only means the heartbeat FILE was written
    // inside its ten-minute window, so a commander that beat once and then died
    // (context overflow, an owner stop, a crash) kept the pane saying
    // 「マネージャーが動いています / 1件あたり数分かかるのが普通です」 for the rest
    // of that window. On an unattended run that sentence is an instruction not to
    // look. Only the SERVER can see whether a desk is actually seated, so the
    // server's verdict decides and the heartbeat no longer votes.
    expect(commanderPresence(beat, 'missing')).toBe('missing')
  })

  it('reports what the server says', () => {
    expect(commanderPresence(beat, 'working')).toBe('working')
    expect(commanderPresence(null, 'quiet')).toBe('quiet')
    expect(commanderPresence(null, 'missing')).toBe('missing')
  })

  it('a server that did not say is UNKNOWN — never "missing"', () => {
    // An older server, or a route that failed to answer. "We do not know" must
    // not be rendered as 「マネージャーがいません」, which would send the owner to
    // open a desk that is already there.
    expect(commanderPresence(beat, undefined)).toBe('unknown')
    expect(commanderPresence(null, undefined)).toBe('unknown')
    // …and a value outside the union degrades the same way.
    expect(commanderPresence(beat, 'bogus' as never)).toBe('unknown')
  })
})

// The rest of the sanitize layer over the one orchestrator poll: structured log
// kinds, anomalies, the KPI roll-up, and the consumption snapshot — same
// coerce-or-drop discipline as the state fields above.
describe('sanitizeEngineState — log / anomalies / kpis / consumption survive the poll', () => {
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

  it('sanitizes anomalies — drops malformed rows, keeps the rest', () => {
    const state = sanitizeEngineState({
      anomalies: [
        { kind: 'orphan-doing', ref: 't1', branch: 'swarm/a', taskTitle: 'Card A' },
        { kind: 'worker-stale', ref: 'swarm/b', branch: 'swarm/b', staleMinutes: 42 },
        { kind: 'orphan-doing' }, // no ref → dropped (nothing to key or point at)
        { kind: '   ', ref: 't3' }, // no kind → dropped
        'nope', // not an object → dropped
      ],
    })
    expect(state.anomalies).toEqual([
      { kind: 'orphan-doing', ref: 't1', branch: 'swarm/a', taskTitle: 'Card A' },
      { kind: 'worker-stale', ref: 'swarm/b', branch: 'swarm/b', staleMinutes: 42 },
    ])
  })

  it('KEEPS a kind this build does not know — the allowlist here dropped real ones TWICE', () => {
    // ⚠ THIS TEST CHANGED SIDES (2026-08-04). It used to assert that an unknown
    // kind is DROPPED. The hand-kept set that did the dropping was measured
    // wrong twice on record: 'no-heartbeat' was emitted by the server and
    // invisible in the UI until 2026-07-14, and 'recover-review' repeated it
    // four days later. A registration list fails by SILENCE — the row simply
    // never appears — while an unfamiliar row is something the owner can ask
    // about. The pane renders an unlabelled kind with its raw name, and
    // swarmOverseerFatalLabels.test.ts fails LOUDLY when a server kind has no
    // label, which is where that gap belongs.
    const state = sanitizeEngineState({ anomalies: [{ kind: 'brand-new-server-kind', ref: 't9' }] })
    expect(state.anomalies).toEqual([{ kind: 'brand-new-server-kind', ref: 't9' }])
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

  it('drops non-swarm-fatal kinds and malformed rows', () => {
    const out = sanitizeFatalNotifications(
      wrap([
        { id: 'a', kind: 'collab-invite', collabInvite: {} }, // wrong kind
        { id: 'c', kind: 'swarm-fatal' }, // no swarmFatal payload
        { id: 'd', kind: 'swarm-fatal', swarmFatal: { event: '   ' } }, // no event name
        null,
        'nope',
      ]),
    )
    expect(out).toEqual([])
  })

  it('KEEPS an event this build has no label for — dropping it is how a real alert vanished', () => {
    // ⚠ THIS TEST CHANGED SIDES (2026-08-04). It used to assert that an
    // unrecognised event is DROPPED. That allowlist held 7 names while the
    // server's SwarmFatalEvent union has 11 and no compile-time link joins
    // them, so four live alerts were discarded in silence — including
    // `guard-unwired`, which means the deny veto could not be verified and NO
    // worker can spawn at all. The pane then drew its "all quiet, nothing for
    // you to do" state. A registration list fails by silence; this channel is
    // the owner's only notice of a swarm failure, so the unknown row is kept
    // (the pane labels it with its raw name). Malformed rows are still dropped
    // — the test above keeps that half.
    const out = sanitizeFatalNotifications(
      wrap([{ id: 'b', kind: 'swarm-fatal', swarmFatal: { event: 'guard-unwired', detail: 'x' } }]),
    )
    expect(out).toHaveLength(1)
    expect(out[0].event).toBe('guard-unwired')
  })

  it('carries every display field through the coercion, for any event', () => {
    // This used to be "accepts every one of the five known events", which after
    // the allowlist removal was satisfied by a sanitizer that returned every row
    // unconditionally — a green that proved nothing. What is still worth pinning
    // is the FIELD MAPPING: each of these is a line the owner reads, and a typo
    // in one key would blank it with no other symptom.
    const out = sanitizeFatalNotifications(
      wrap([
        {
          id: 'n1',
          kind: 'swarm-fatal',
          createdAt: 1_700_000_000_000,
          handledAt: 1_700_000_050_000,
          swarmFatal: {
            event: 'guard-unwired',
            detail: '拒否ベトを確認できませんでした',
            branch: 'swarm/w3',
            taskTitle: 'カードの題',
            taskId: 'card-3',
            logHint: 'engine log の dispatch 行',
            projectPath: '/proj',
          },
        },
      ]),
    )
    expect(out).toEqual([
      {
        id: 'n1',
        event: 'guard-unwired',
        detail: '拒否ベトを確認できませんでした',
        branch: 'swarm/w3',
        taskTitle: 'カードの題',
        taskId: 'card-3',
        logHint: 'engine log の dispatch 行',
        projectPath: '/proj',
        createdAt: 1_700_000_000_000,
        handled: true,
      },
    ])
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

// Env preflight (git/shell) — GET /api/swarm/preflight (swarmEnvPreflight). The
// route response is untrusted like every other one here: keep only known ids so
// a forged/unrecognized id (which the banner has no copy for) never renders an
// empty row instead of just being dropped.
describe('sanitizeEnvIssues — the git/shell preflight banner survives the poll', () => {
  it('keeps every known issue id, in order', () => {
    const out = sanitizeEnvIssues({
      ok: false,
      issues: [{ id: 'gitMissing' }, { id: 'notAGitRepo' }, { id: 'shellMissing' }],
    })
    expect(out).toEqual([{ id: 'gitMissing' }, { id: 'notAGitRepo' }, { id: 'shellMissing' }])
  })

  it('drops an unknown/malformed id and tolerates a non-array / non-object input', () => {
    expect(sanitizeEnvIssues({ issues: [{ id: 'somethingElse' }, { id: 'gitMissing' }, 'nope', null] })).toEqual([
      { id: 'gitMissing' },
    ])
    expect(sanitizeEnvIssues(null)).toEqual([])
    expect(sanitizeEnvIssues('boom')).toEqual([])
    expect(sanitizeEnvIssues({})).toEqual([])
    expect(sanitizeEnvIssues({ issues: 'nope' })).toEqual([])
  })
})
