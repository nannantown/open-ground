// @vitest-environment node
//
// WHERE A PROJECT STANDS (AUTONOMY-SPEC R-A1 / R-A2 / R-E1).
//
// Every silent stop so far was found by the owner and patched one cause at a
// time: six hold fields on the engine (savedWorkHold, sdkSpawnHold, parkUntil,
// manualStop, managerOfflineHold, the boot map) each held work and each told the
// owner through a different path — or not at all. `standingOf` is the one place
// that states "work is needed, and this is why it is not being served", and the
// engine's watchdog catches the next cause nobody has named yet.
//
// Pinned here:
//   • every hold field, set alone with a need and no progress, names its kind —
//     and removing that field's adapter turns exactly that field's cases red;
//   • nothing held, a need, no progress for 15 minutes ⇒ `unexplained`;
//     progress inside the window ⇒ no reason;
//   • the state ranks needs-owner over running over waiting;
//   • every sentence exists in Japanese and English.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { STANDING_ADAPTERS, STANDING_STALL_MS, standingOf, type StandingFacts } from './swarmStanding'
import {
  runEnginePass,
  __resetOrchestratorForTests,
  defaultDeps,
  emptyMetricsCounters,
  standingFactsOf,
  BG_TASK_GRACE_MS,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { initOverseerRuntime } from './swarmOverseer'
import { CHATGPT_REVIEW_HOLD_HINT, CHATGPT_SIGN_IN_HOLD_HINT, CHATGPT_UNREADABLE_HOLD_HINT, OWNER_REVIEW_HOLD_HINT } from './savedWorkHold'
import { projectPanel as panelMessages } from '../../i18n/messages/projectPanel'
import { settings as settingsMessages } from '../../i18n/messages/settings'
import type { ProjectTask, StandingReasonKind, StandingState, SwarmFatalNotification } from '../types'

const NOW = Date.parse('2026-11-28T05:00:00Z')
const MIN = 60_000

/** A running engine with one card to start, nothing serving it, and quiet for
 *  longer than the stall window — the state the watchdog exists for. */
const stalled = (over: Partial<StandingFacts> = {}): StandingFacts => ({
  now: NOW,
  lang: 'ja',
  engineRunning: true,
  needs: { dispatch: 1, integrate: 0 },
  serving: false,
  quietSince: NOW - STANDING_STALL_MS - MIN,
  ...over,
})

/** One row per hold field that exists on this base: set it ALONE and the
 *  standing must say so. `fact` is the adapter that owns it. */
const HOLDS: Array<{ name: string; fact: keyof StandingFacts; over: Partial<StandingFacts>; kind: StandingReasonKind; state: StandingState; until?: number }> = [
  { name: 'open question', fact: 'openQuestions', over: { openQuestions: 2 }, kind: 'owner-question', state: 'needs-owner' },
  { name: 'saved-work hold', fact: 'savedWorkHold', over: { savedWorkHold: { count: 1 } }, kind: 'owner-question', state: 'needs-owner' },
  { name: 'saved-work hold, sign-in unconfirmed', fact: 'savedWorkHold', over: { savedWorkHold: { count: 0, unanswered: 'Owner sign-in is required' } }, kind: 'owner-question', state: 'needs-owner' },
  { name: 'every model switched off', fact: 'modelsOff', over: { modelsOff: true }, kind: 'models-off', state: 'needs-owner' },
  { name: 'boot resume held', fact: 'bootHold', over: { bootHold: { reason: 'AI の接続の切り替えが終わるのを待っています' } }, kind: 'boot-pending', state: 'waiting' },
  { name: 'boot resume held for the owner', fact: 'bootHold', over: { bootHold: { reason: '確認すると再開します', ownerOnly: true } }, kind: 'boot-pending', state: 'needs-owner' },
  { name: 'stopped by hand', fact: 'manualStop', over: { engineRunning: false, manualStop: true }, kind: 'manual-stop', state: 'off' },
  { name: 'outside the frame', fact: 'outsideFrame', over: { outsideFrame: true }, kind: 'outside-frame', state: 'off' },
  { name: 'usage-limit park', fact: 'parkUntil', over: { parkUntil: NOW + 90 * MIN }, kind: 'usage-limit', state: 'waiting', until: NOW + 90 * MIN },
  { name: 'spawn backoff', fact: 'sdkSpawnHold', over: { sdkSpawnHold: { until: NOW + 5 * MIN } }, kind: 'spawn-backoff', state: 'waiting', until: NOW + 5 * MIN },
  { name: 'offline hold', fact: 'offlineHold', over: { offlineHold: true }, kind: 'offline', state: 'waiting' },
  { name: '5-hour window near its ceiling', fact: 'budget', over: { budget: { kind: 'window-headroom', until: NOW + 120 * MIN } }, kind: 'window-headroom', state: 'waiting', until: NOW + 120 * MIN },
  { name: "the owner's weekly reserve", fact: 'budget', over: { budget: { kind: 'weekly-reserve', until: NOW + 48 * 60 * MIN } }, kind: 'weekly-reserve', state: 'waiting', until: NOW + 48 * 60 * MIN },
  // Holds the engine already knew but the standing did not (review 2026-11-28 B-S3):
  { name: 'automatic operation blocked (owner signed out)', fact: 'automationBlocked', over: { automationBlocked: true }, kind: 'owner-question', state: 'needs-owner' },
  { name: 'commander paused on a usage limit', fact: 'commanderQuotaPause', over: { needs: { dispatch: 0, integrate: 1 }, commanderQuotaPause: { until: NOW + 120 * MIN } }, kind: 'usage-limit', state: 'waiting', until: NOW + 120 * MIN },
  { name: 'dispatch keeps failing', fact: 'dispatchFailing', over: { dispatchFailing: true }, kind: 'spawn-backoff', state: 'waiting' },
  { name: 'commander given up on', fact: 'commanderDown', over: { needs: { dispatch: 0, integrate: 1 }, commanderDown: true }, kind: 'commander-down', state: 'needs-owner' },
]

const kinds = (f: StandingFacts, adapters = STANDING_ADAPTERS) => standingOf(f, adapters).reasons.map((r) => r.kind)

describe('standingOf — every hold field names its reason', () => {
  it.each(HOLDS)('$name ⇒ $kind, state $state, never unexplained', ({ over, kind, state, until }) => {
    const s = standingOf(stalled(over))
    expect(s.reasons.map((r) => r.kind)).toContain(kind)
    expect(s.reasons.map((r) => r.kind)).not.toContain('unexplained')
    expect(s.state).toBe(state)
    const reason = s.reasons.find((r) => r.kind === kind)!
    expect(reason.plain.length).toBeGreaterThan(0)
    if (until !== undefined) expect(reason.until).toBe(until)
    // Only the owner can clear it ⇔ it says what to press.
    expect(reason.ownerAction !== undefined).toBe(state === 'needs-owner')
  })

  it('every adapter is covered by a case, and removing ONE adapter turns exactly its own cases red', () => {
    const facts = new Set(STANDING_ADAPTERS.map((a) => a.fact))
    expect(new Set(HOLDS.map((h) => h.fact))).toEqual(facts)
    for (const fact of Array.from(facts)) {
      const without = STANDING_ADAPTERS.filter((a) => a.fact !== fact)
      const red = HOLDS.filter((h) => !kinds(stalled(h.over), without).includes(h.kind)).map((h) => h.fact)
      expect(new Set(red), `without the ${String(fact)} adapter`).toEqual(new Set([fact]))
    }
  })

  it('a dispatch hold says nothing when nothing is waiting for it', () => {
    // A cooling park with an empty todo column holds no work — the standing is idle.
    const s = standingOf(stalled({ needs: { dispatch: 0, integrate: 0 }, parkUntil: NOW + 90 * MIN }))
    expect(s.state).toBe('idle')
    expect(s.reasons).toEqual([])
  })
})

describe('standingOf — the stall watchdog (R-A2)', () => {
  it('nothing held, a need, no progress for 15 minutes ⇒ unexplained, the clock waits', () => {
    const s = standingOf(stalled({ quietSince: NOW - STANDING_STALL_MS }))
    expect(s.reasons.map((r) => r.kind)).toEqual(['unexplained'])
    expect(s.state).toBe('waiting')
    expect(s.reasons[0].plain).toContain('15')
  })

  it('one minute short of the window ⇒ no reason; the engine is presumed to be serving it', () => {
    const s = standingOf(stalled({ quietSince: NOW - STANDING_STALL_MS + MIN }))
    expect(s.reasons).toEqual([])
    expect(s.state).toBe('running')
  })

  it('a live worker or the commander mid-turn is progress: never unexplained', () => {
    const s = standingOf(stalled({ serving: true }))
    expect(s.reasons).toEqual([])
    expect(s.state).toBe('running')
  })

  it('a review card waiting for the commander is a need too', () => {
    expect(kinds(stalled({ needs: { dispatch: 0, integrate: 1 } }))).toEqual(['unexplained'])
  })

  it('no need ⇒ idle, however long it has been quiet', () => {
    const s = standingOf(stalled({ needs: { dispatch: 0, integrate: 0 } }))
    expect(s).toMatchObject({ state: 'idle', reasons: [] })
  })

  it('a stopped engine is off, not stalled', () => {
    expect(standingOf(stalled({ engineRunning: false }))).toMatchObject({ state: 'off', reasons: [] })
  })
})

describe('standingOf — one state, ranked', () => {
  it('needs-owner outranks running outranks waiting', () => {
    expect(standingOf(stalled({ serving: true, openQuestions: 1, parkUntil: NOW + MIN })).state).toBe('needs-owner')
    expect(standingOf(stalled({ serving: true, parkUntil: NOW + MIN })).state).toBe('running')
    expect(standingOf(stalled({ parkUntil: NOW + MIN })).state).toBe('waiting')
  })

  it('owner reasons come first, so the first sentence is what the owner can act on', () => {
    const s = standingOf(stalled({ parkUntil: NOW + MIN, openQuestions: 1 }))
    expect(s.reasons.map((r) => r.kind)).toEqual(['owner-question', 'usage-limit'])
  })

  it('carries needs and the last progress instant through', () => {
    const s = standingOf(stalled({ needs: { dispatch: 2, integrate: 1 }, progressedAt: NOW - 3 * MIN, serving: true }))
    expect(s.needs).toEqual({ dispatch: 2, integrate: 1 })
    expect(s.progressedAt).toBe(NOW - 3 * MIN)
  })
})

describe('standingOf — the owner reads it in their language', () => {
  const every = [...HOLDS.map((h) => stalled(h.over)), stalled()]
  it.each(['ja', 'en'] as const)('%s: one sentence per reason, the until time inside it', (lang) => {
    for (const f of every) {
      for (const r of standingOf({ ...f, lang }).reasons) {
        expect(r.plain.trim()).toBe(r.plain)
        // Japanese text has Japanese characters; English text has none — the
        // boot hold's own reason is Japanese-only and stays out of English.
        expect(/[぀-ヿ一-鿿]/.test(r.plain), `${lang} ${r.kind}: ${r.plain}`).toBe(lang === 'ja')
        if (r.ownerAction) expect(/[぀-ヿ一-鿿]/.test(r.ownerAction)).toBe(lang === 'ja')
        if (r.until !== undefined) {
          const hhmm = new Date(r.until).toLocaleTimeString(lang === 'ja' ? 'ja-JP' : 'en-US', { hour: '2-digit', minute: '2-digit' })
          expect(r.plain).toContain(hhmm)
        }
      }
    }
  })

  // Review D S1 (2026-11-28): it named Settings › … › 中断した作業の確認 while the hint
  // and the question pointed at the inbox — two instructions for one hold. The
  // owner answers the hold's question in the bar (HoldQuestionDialog), so: the inbox.
  it('the saved-work hold points at the question inbox by the label the bar shows', () => {
    const r = standingOf(stalled({ savedWorkHold: { count: 1 } })).reasons[0]
    expect(r.ownerAction).toContain('あなたへの質問')
    expect(r.ownerAction).not.toContain('中断した作業の確認')
    const en = standingOf(stalled({ lang: 'en', savedWorkHold: { count: 1 } })).reasons[0]
    expect(en.ownerAction).toContain('Questions for you')
  })

  // Review R2 S-4: a held ChatGPT desk conversation raises no question in the bar
  // (its recovery lives in Settings' ChatGPT panel), so its hold names that door —
  // the bar's list would be empty.
  it('a boot hold names the door its own words name: the bar question, or Settings for a ChatGPT conversation', () => {
    for (const lang of ['ja', 'en'] as const) {
      const listLabel = lang === 'ja' ? 'あなたへの質問' : 'Questions for you'
      const bar = standingOf(stalled({ lang, bootHold: { reason: `x(${OWNER_REVIEW_HOLD_HINT})`, ownerOnly: true } })).reasons[0]
      expect(bar.ownerAction).toContain(listLabel)
      const gpt = standingOf(stalled({ lang, bootHold: { reason: `x(${CHATGPT_REVIEW_HOLD_HINT})`, ownerOnly: true } })).reasons[0]
      expect(gpt.ownerAction).toContain(settingsMessages[lang]['settings.recovery.title'])
      expect(gpt.ownerAction).toContain(settingsMessages[lang]['settings.advanced'])
      expect(gpt.ownerAction).not.toContain(listLabel)
    }
  })

  // Review R3-ui S1: the Settings panel lists a ChatGPT item only while connected to
  // the account that started it with work mode off, and an unreadable history has
  // no door at all — the hold's words, and so its action, say exactly that.
  it('a ChatGPT hold the panel cannot show names its conditions; an unreadable one promises no door', () => {
    for (const lang of ['ja', 'en'] as const) {
      const listLabel = lang === 'ja' ? 'あなたへの質問' : 'Questions for you'
      // the Settings-review sentence's own ending (「で確かめると再開します」 / "to resume.")
      const reviewOnly = panelMessages[lang]['projectPanel.standing.action.reviewSettings'].split('{recovery}')[1].trim()
      const signIn = standingOf(stalled({ lang, bootHold: { reason: `x(${CHATGPT_SIGN_IN_HOLD_HINT})`, ownerOnly: true } })).reasons[0]
      expect(signIn.ownerAction).toContain(settingsMessages[lang]['settings.lockdown.heading'])
      expect(signIn.ownerAction).toContain('ChatGPT')
      expect(signIn.ownerAction).not.toContain(reviewOnly)
      expect(signIn.ownerAction).not.toContain(listLabel)
      const unreadable = standingOf(stalled({ lang, bootHold: { reason: `x(${CHATGPT_UNREADABLE_HOLD_HINT})`, ownerOnly: true } })).reasons[0]
      expect(unreadable.ownerAction).toBe(panelMessages[lang]['projectPanel.standing.action.chatgptUnreadable'])
    }
  })

  // Review R2 S-5: open questions said only "tell the president" — the seat that
  // cannot open when its own conversation is the held one. Held-operation
  // questions are answered in the bar, so the action names that door as well.
  it('open questions name the bar\'s question list, not only the president', () => {
    const ja = standingOf(stalled({ openQuestions: 1 })).reasons[0].ownerAction
    expect(ja).toContain('「あなたへの質問」')
    expect(ja).toContain('社長')
    const en = standingOf(stalled({ lang: 'en', openQuestions: 1 })).reasons[0].ownerAction
    expect(en).toContain('"Questions for you"')
    expect(en).toContain('president')
  })

  // Review R2 S-7: "open the manager and check on it" gave the owner nothing to do.
  it('the commander being down names the manager seat\'s own buttons', () => {
    for (const lang of ['ja', 'en'] as const) {
      const r = standingOf(stalled({ lang, needs: { dispatch: 0, integrate: 1 }, commanderDown: true })).reasons[0]
      const [open, close] = lang === 'ja' ? ['「', '」'] : ['"', '"']
      expect(r.ownerAction).toContain(`${open}${panelMessages[lang]['projectPanel.swarm.manager.start']}${close}`)
      expect(r.ownerAction).toContain(`${open}${panelMessages[lang]['projectPanel.swarm.manager.stop']}${close}`)
    }
  })
})

// ── The engine runs the watchdog once per pass (R-A2 wiring) ────────────────
// A review card nobody integrates, nothing held: the silent stop the watchdog
// exists for. The integrate pass is kept out (lastIntegrateAt far ahead) so
// nothing but the clock moves.
describe('runEnginePass — the stall watchdog', () => {
  const T0 = Date.parse('2026-11-28T03:00:00Z')
  const review = (id: string): ProjectTask =>
    ({ id, title: `card ${id}`, notes: 'completion conditions', boardColumn: 'review', branch: `swarm/${id}` }) as unknown as ProjectTask
  const engineOf = (over: Partial<ProjectEngine> = {}): ProjectEngine =>
    ({
      path: '/proj-standing',
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
      lastIntegrateAt: Number.MAX_SAFE_INTEGER,
      recoveries: new Map(),
      reworks: new Map(),
      reworkReasons: new Map(),
      conflictReworks: new Map(),
      stuckMoves: new Map(),
      nudges: new Map(),
      log: [],
      anomalies: [],
      overseer: initOverseerRuntime(),
      notified: new Set(),
      pendingFatal: [],
      metrics: emptyMetricsCounters(),
      ...over,
    }) as ProjectEngine
  type Deps = OrchestratorDeps & IntegrationDeps & AnomalyDeps
  const depsOf = (board: ProjectTask[], over: Partial<Deps> = {}): Deps => ({
    ...defaultDeps(),
    fetchTasks: async () => board.map((c) => ({ ...c })),
    spawnWorker: async () => {
      throw new Error('spawnWorker not stubbed')
    },
    moveToDoing: async () => true,
    moveToReview: async () => true,
    recoverCard: async () => true,
    recoverWorker: async () => ({ removed: true }),
    countCommitsAhead: async () => 0,
    readHeartbeat: async () => null,
    lastOutputAt: () => null,
    isAlive: () => true,
    savedWorkHold: async () => [],
    worktreeExists: async () => true,
    deskOccupies: async () => false,
    deskAttended: async () => false,
    notify: vi.fn(),
    ...over,
  })
  const stalledNotices = (deps: Deps) =>
    (deps.notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as SwarmFatalNotification).filter((n) => n.event === 'automation-stalled')
  const passAt = async (engine: ProjectEngine, deps: Deps, at: number) => {
    vi.setSystemTime(at)
    await runEnginePass(engine, deps)
  }

  beforeEach(() => {
    __resetOrchestratorForTests()
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    __resetOrchestratorForTests()
  })

  it('raises automation-stalled once per episode, journals the facts, and progress ends the episode', async () => {
    const board = [review('r1')]
    const engine = engineOf()
    const deps = depsOf(board)
    await passAt(engine, deps, T0) // the baseline: not progress, not a stall
    await passAt(engine, deps, T0 + STANDING_STALL_MS - MIN)
    expect(stalledNotices(deps)).toHaveLength(0)

    await passAt(engine, deps, T0 + STANDING_STALL_MS + MIN)
    expect(stalledNotices(deps)).toHaveLength(1)
    expect(stalledNotices(deps)[0]).toMatchObject({ projectPath: '/proj-standing' })
    expect(stalledNotices(deps)[0].detail).toMatch(/16/)
    const journal = engine.log.filter((l) => /automation stalled/.test(l.message))
    expect(journal).toHaveLength(1)
    expect(journal[0].message).toMatch(/integrate 1/)

    await passAt(engine, deps, T0 + STANDING_STALL_MS + 2 * MIN) // still stalled: not told again
    expect(stalledNotices(deps)).toHaveLength(1)
    expect(engine.log.filter((l) => /automation stalled/.test(l.message))).toHaveLength(1)

    // Progress: the commander landed r1 and r2 arrived. A new window starts.
    board.splice(0, 1, { ...board[0], boardColumn: 'done' } as ProjectTask, review('r2'))
    const moved = T0 + STANDING_STALL_MS + 3 * MIN
    await passAt(engine, deps, moved)
    expect(engine.standingWatch?.progressedAt).toBe(moved)
    await passAt(engine, deps, moved + STANDING_STALL_MS - MIN)
    expect(stalledNotices(deps)).toHaveLength(1)
    await passAt(engine, deps, moved + STANDING_STALL_MS)
    expect(stalledNotices(deps)).toHaveLength(2) // a new episode is told again
  })

  it('a named hold is never reported as a stall', async () => {
    // A project-wide hold — since R-B3 (2026-11-28) only the launch guard unable
    // to answer at all (sign-in gone) — the standing names it, so the watchdog
    // stays quiet however long it lasts. (A known operation holds only its own
    // conversation and reaches the standing as an inbox question.)
    const board = [review('r1')]
    const engine = engineOf()
    const deps = depsOf(board, { savedWorkHold: async () => { throw new Error('Owner sign-in is required') } })
    await passAt(engine, deps, T0)
    await passAt(engine, deps, T0 + 2 * STANDING_STALL_MS)
    expect(stalledNotices(deps)).toHaveLength(0)
    // …and the quiet clock restarts while it is held, so a stall is measured
    // from the moment the hold lifts, not from the start of the hold.
    deps.savedWorkHold = async () => []
    await passAt(engine, deps, T0 + 2 * STANDING_STALL_MS + MIN)
    expect(stalledNotices(deps)).toHaveLength(0)
  })

  // The commander's own background full test run (og-manage: "run it in the
  // background and wait") leaves its desk 'waiting' with nothing moving. That
  // is the commander working, not a stall (review 2026-11-28 B-S3b).
  it("the commander waiting on its own background command is serving, not stalled", async () => {
    const board = [review('r1')]
    const engine = engineOf()
    const asked: string[] = []
    const deps = depsOf(board, { commanderBackgroundTaskAt: async (p: string) => (asked.push(p), T0) })
    await passAt(engine, deps, T0)
    await passAt(engine, deps, T0 + STANDING_STALL_MS + MIN)
    await passAt(engine, deps, T0 + 2 * STANDING_STALL_MS)
    expect(stalledNotices(deps)).toHaveLength(0)
    expect(asked).toContain('/proj-standing')
    // …and once the command is gone, the quiet clock runs from that moment.
    deps.commanderBackgroundTaskAt = async () => null
    await passAt(engine, deps, T0 + 2 * STANDING_STALL_MS + MIN)
    expect(stalledNotices(deps)).toHaveLength(0)
    await passAt(engine, deps, T0 + 3 * STANDING_STALL_MS + MIN)
    expect(stalledNotices(deps)).toHaveLength(1)
  })

  // ⚠ Only a command that is plausibly still running (review R2-M2): one start
  // whose end record never lands must not silence the watchdog for good.
  it('a background start older than the run grace is not serving: the stall is told', async () => {
    const board = [review('r1')]
    const engine = engineOf()
    const deps = depsOf(board, { commanderBackgroundTaskAt: async () => T0 - BG_TASK_GRACE_MS - MIN })
    await passAt(engine, deps, T0)
    await passAt(engine, deps, T0 + STANDING_STALL_MS + MIN)
    expect(stalledNotices(deps)).toHaveLength(1)
  })

  it("the commander's background run serves the review need only — a dispatch need beside it still stalls", async () => {
    // The todo card's spawn fails 3 times (below the told streak), so nothing
    // names it; the commander's run must not restart the clock for it.
    const board = [review('r1'), { id: 't1', title: 'card t1', notes: 'completion conditions', boardColumn: 'todo' } as unknown as ProjectTask]
    const engine = engineOf()
    const deps = depsOf(board, { commanderBackgroundTaskAt: async () => Date.now() - MIN, spawnWorker: async () => { throw new Error('test: spawn refused') } })
    await passAt(engine, deps, T0)
    await passAt(engine, deps, T0 + STANDING_STALL_MS - MIN)
    await passAt(engine, deps, T0 + STANDING_STALL_MS + MIN)
    expect(stalledNotices(deps)).toHaveLength(1)
  })

  it('an engine whose automatic operation is blocked (owner signed out) never reads as stalled', async () => {
    const board = [review('r1')]
    const engine = engineOf({ automationBlocked: true })
    const deps = depsOf(board)
    await passAt(engine, deps, T0)
    await passAt(engine, deps, T0 + 2 * STANDING_STALL_MS)
    expect(stalledNotices(deps)).toHaveLength(0)
  })
})

describe("the budget gate's verdict reaches the standing (standingFactsOf)", () => {
  const engine = (budgetHold: ProjectEngine['budgetHold']): ProjectEngine =>
    ({ running: true, workers: [], reviews: [], highRiskHolds: new Map(), anomalies: [], budgetHold } as unknown as ProjectEngine)
  const facts = (e: ProjectEngine) => standingFactsOf(e, '/proj-budget', { now: NOW, lang: 'en', tasks: [] })

  it('names the hold that lifts soonest', () => {
    const e = engine({ held: [
      { taskId: 'a', kind: 'window-headroom', until: NOW + 120 * MIN },
      { taskId: 'b', kind: 'weekly-reserve', until: NOW + 30 * MIN },
    ] })
    expect(facts(e).budget).toEqual({ kind: 'weekly-reserve', until: NOW + 30 * MIN })
  })
  it('carries the usage-unknown note when nothing is held', () => {
    expect(facts(engine({ held: [], note: 'usage-unknown' })).budget).toEqual({ kind: 'usage-unknown' })
  })
  it('says nothing when the gate held nothing', () => {
    expect(facts(engine({ held: [] })).budget).toBeUndefined()
    expect(facts(engine(undefined)).budget).toBeUndefined()
  })
  it('a hold whose time has passed says nothing — no past clock time (review R2 NIT 4 / B-N1)', () => {
    // Left from a pass that returned early (a quota park, automation not allowed).
    expect(facts(engine({ held: [{ taskId: 'a', kind: 'window-headroom', until: NOW - MIN }] })).budget).toBeUndefined()
    const reserveLeft = { ...engine(undefined), commanderReserveHold: { until: NOW - MIN, usedPct: 95, linePct: 90 } } as ProjectEngine
    expect(facts(reserveLeft).budget).toBeUndefined()
  })
})

// HOLDS THE ENGINE ALREADY KNOWS (review 2026-11-28 B-S3). Each used to read as
// `unexplained` after 15 quiet minutes — a false defect report, a president turn,
// and a second notice where the hold already had its own.
describe('standingFactsOf — holds the engine knows are named, never unexplained', () => {
  const todo: ProjectTask = { id: 't1', title: 'card t1', notes: 'completion conditions', boardColumn: 'todo' } as unknown as ProjectTask
  const review: ProjectTask = { id: 'r1', title: 'card r1', notes: 'completion conditions', boardColumn: 'review', branch: 'swarm/r1' } as unknown as ProjectTask
  const quietEngine = (over: Partial<ProjectEngine> = {}): ProjectEngine =>
    ({
      running: true, workers: [], reviews: [], highRiskHolds: new Map(), anomalies: [],
      standingWatch: { sig: '', quietSince: NOW - STANDING_STALL_MS - MIN },
      ...over,
    }) as unknown as ProjectEngine
  const kindsOf = (e: ProjectEngine, tasks: ProjectTask[], ctx: Partial<Parameters<typeof standingFactsOf>[2]> = {}) =>
    standingOf(standingFactsOf(e, '/proj-s3', { now: NOW, lang: 'ja', tasks, ...ctx })).reasons.map((r) => r.kind)

  it('control: nothing known ⇒ unexplained', () => {
    expect(kindsOf(quietEngine(), [review])).toEqual(['unexplained'])
  })
  it('automationBlocked (the owner signed out) ⇒ the sign-in reason', () => {
    expect(kindsOf(quietEngine({ automationBlocked: true }), [review])).toEqual(['owner-question'])
  })
  it('an engine dragged OUT of the frame is off — never the sign-in reason (review R2-M1)', () => {
    // automaticOperationAllowed is false outside the frame too, so the engine's
    // flag is set there; the owner is signed in and asked nothing.
    const e = quietEngine({ automation: { enabled: true, allowed: false }, automationBlocked: true })
    for (const tasks of [[], [todo], [review]]) {
      const s = standingOf(standingFactsOf(e, '/proj-s3', { now: NOW, lang: 'ja', tasks }))
      expect(s.state).toBe('off')
      expect(s.reasons.map((r) => r.kind)).toEqual(['outside-frame'])
    }
  })
  it("the commander's usage-limit pause ⇒ usage-limit with its until", () => {
    const s = standingOf(standingFactsOf(quietEngine(), '/proj-s3', { now: NOW, lang: 'ja', tasks: [review], commander: () => ({ quotaPauseUntil: NOW + 90 * MIN }) }))
    expect(s.reasons.map((r) => [r.kind, r.until])).toEqual([['usage-limit', NOW + 90 * MIN]])
    expect(s.reasons[0].plain).toContain('マネージャー')
  })
  it('a pause that already ended holds nothing', () => {
    expect(kindsOf(quietEngine(), [review], { commander: () => ({ quotaPauseUntil: NOW - MIN }) })).toEqual(['unexplained'])
  })
  it('a card whose dispatch keeps failing (its own notice told) ⇒ spawn-backoff', () => {
    const e = quietEngine({ dispatchFailures: new Map([['t1', { count: 5, told: true }]]) })
    expect(kindsOf(e, [todo])).toEqual(['spawn-backoff'])
    // A streak left by a card that is no longer waiting says nothing.
    expect(kindsOf(e, [{ ...todo, boardColumn: 'done' } as ProjectTask, review])).toEqual(['unexplained'])
  })
  it('the commander given up on (manager-unrevivable rang) ⇒ commander-down', () => {
    const e = quietEngine({ managerResume: { attempts: 3, lastWakeAt: NOW - 10 * MIN, fatalFired: true } })
    expect(kindsOf(e, [review])).toEqual(['commander-down'])
  })
  it('the commander that ignored every poke (manager-unresponsive rang) ⇒ commander-down', () => {
    const e = quietEngine({ managerResume: { attempts: 0, lastWakeAt: 0, fatalFired: false, unresponsiveFatalFired: true } })
    expect(kindsOf(e, [review])).toEqual(['commander-down'])
  })
})
