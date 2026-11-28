// @vitest-environment node
//
// THE ENGINE AND AN OPERATION NOBODY CONFIRMED (2026-11-23).
//
// One unconfirmed tool result in a project makes every SDK launch into it die at
// its first step and denies every running worker's tool calls. The safeguard is
// right; the engine not knowing about it was the bug: it kept dispatching workers
// that were lost in seconds (cards parked after two tries), kept waking a
// commander that could not start, and told nobody — for two weeks, in five
// projects. Worse, the engine made such operations ITSELF: its quota stop cut a
// worker off in the middle of a running test command (JobSearch, 16:29).
//
// Pinned here, each measured red against the pre-fix engine:
//   • SCOPED (AUTONOMY-SPEC R-B3, owner decision 2026-11-28 §7-1 = A): an unknown
//     result holds ONLY the conversation that issued it. Its worker is stopped and
//     never resumed, its card waits in blocked, ONE question waits in the owner's
//     inbox — and every other worker, the commander and the president go on. This
//     file used to pin the opposite ("a held project dispatches NOTHING"): that
//     project-wide hold turned eight stale receipts into days without automation
//     in seven projects (§1.1), while the only actor that can run an unknown call
//     again is the conversation that issued it;
//   • when the launch guard's question cannot be answered at all (sign-in gone,
//     record unreadable) every launch would fail the same way — that still holds
//     the whole project, under its own words;
//   • the question names the seat, the time and the call's own description, in
//     plain words, with no path, branch name or command text (R-B4);
//   • a worker lost at start carries its session's exit reason into the journal;
//   • a quota stop waits for a running command instead of cutting it off, and a
//     stop that had to cut one off anyway is recorded and named in the question.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm } from 'fs/promises'
import { NativeUnfinishedToolsError } from './swarmNativeTranscript'
import {
  runDispatchPass,
  __resetOrchestratorForTests,
  defaultDeps,
  emptyMetricsCounters,
  TOOL_BOUNDARY_WAIT_MS,
  TOOL_DENIAL_ALERT,
  DISPATCH_FAILURE_TELL,
  MAX_EXEC_MS,
  STALL_SILENCE_MS,
  STALL_NUDGE_COOLDOWN_MS,
  OWNER_REVIEW_HOLD_HINT,
  unparkBlockedCard,
  adoptResumeCandidates,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { askAboutHeldOperation, automationStartNotice, commanderFailureWords, dispatchFailureNotice, unconfirmedOperationQuestion, heldOperationOpening, plainDescription, toolDenialNotice, ownerUnconfirmedNotice, holdAnswerReason, OWNER_REVIEW_WHERE, APP_SIGN_IN_WHERE, chatGptHoldHint, isOwnerReviewHold, CHATGPT_REVIEW_HOLD_HINT, CHATGPT_SIGN_IN_HOLD_HINT, CHATGPT_UNREADABLE_HOLD_HINT, type HeldOperation } from './savedWorkHold'
import { getSettings, setSettings } from './store'
import { answerEscalation, dismissEscalation, listEscalations, ownerQuestionDetail } from './swarmEscalations'
import { projectPanel as panelMessages } from '../../i18n/messages/projectPanel'
import { board as boardMessages } from '../../i18n/messages/board'
import { quotaRefusalKindOfText, refusalClosesEveryModel } from './swarmRateLimitText'
import { SUPPLY_NOTICE_MAX, sanitizeSupplyNotice } from './supplyNotice'
import { __resetQuotaForTest, flushQuotaPersist, isTierCooling, MODEL_TIER_LADDER } from './swarmQuota'
import { initOverseerRuntime } from './swarmOverseer'
import { escalationsFile, swarmNotificationsFile } from './paths'
import type { OrchestratorWorker, ProjectTask, SpawnSwarmWorkerResponse, SwarmFatalNotification } from '../types'

vi.setConfig({ testTimeout: 60_000 })
// The signed-in owner role (receipts are recorded and asked about only for it).
// Off by default, as these tests always ran; on where a test says so.
const role = vi.hoisted(() => ({ owner: false }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => role.owner }))

const T0 = Date.parse('2026-11-23T07:00:00Z')

const card = (id: string, boardColumn = 'todo'): ProjectTask =>
  ({ id, title: `card ${id}`, notes: 'completion conditions', boardColumn, branch: `swarm/${id}` }) as unknown as ProjectTask

const sdkSpawn = (id: string): SpawnSwarmWorkerResponse => ({
  terminalId: '',
  runtime: 'sdk',
  sdkSessionId: `sdk-${id}`,
  agentSessionId: `sess-${id}`,
  worktree: `/central/wt/${id}`,
  branch: `swarm/${id}`,
  model: 'fable',
})

const sdkWorker = (over: Partial<OrchestratorWorker> = {}): OrchestratorWorker => ({
  terminalId: '',
  runtime: 'sdk',
  sdkSessionId: 'sdk-q1',
  branch: 'swarm/q1',
  worktree: '/central/wt/q1',
  taskId: 'q1',
  taskTitle: 'quota me',
  startedAt: new Date(T0 - 10 * 60_000).toISOString(),
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
const stubDeps = (over: Partial<Deps>): Deps => ({
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
  isAlive: () => true,
  savedWorkHold: async () => [],
  sdkWorkerFacts: () => undefined,
  toolDenialStreak: () => 0,
  sessionAgentActivityAt: async () => null,
  sessionBackgroundTaskAt: async () => null,
  ...over,
})

const held = (notify: (n: SwarmFatalNotification) => void) =>
  (notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as SwarmFatalNotification).filter((n) => n.event === 'automation-held')

beforeEach(async () => {
  role.owner = false
  __resetOrchestratorForTests()
  __resetQuotaForTest()
  await rm(swarmNotificationsFile(), { force: true })
  await rm(escalationsFile(), { force: true })
})

afterEach(async () => {
  __resetOrchestratorForTests()
  // A quota stop schedules the cooling table's write; let it (and its log line)
  // finish inside the test, not after the file's worker has closed.
  await flushQuotaPersist().catch(() => {})
  __resetQuotaForTest()
  await rm(swarmNotificationsFile(), { force: true })
  await rm(escalationsFile(), { force: true })
})

const OP_AT = '2026-11-23T06:58:00.000Z'
const heldOp = (over: Partial<HeldOperation> = {}): HeldOperation =>
  ({ id: 'tool-w1', sessionId: 'sess-w1', tool: 'Bash', at: OP_AT, description: 'テストをすべて実行', seat: { role: 'unknown' }, ...over })
const openHoldQuestions = async () => (await listEscalations({ status: 'open' })).filter((e) => e.receiptKey.startsWith('hold:'))

describe('saved-work hold — only the conversation that issued the unknown call stops (R-B3)', () => {
  // These cases read the owner's Japanese question: the owner's machine runs
  // Settings.language = 'ja' (unset ⇒ English, promptLang.langOf).
  let langBefore: 'en' | 'ja' | undefined
  beforeEach(async () => { langBefore = (await getSettings()).language; await setSettings({ language: 'ja' }) })
  afterEach(async () => { await setSettings({ language: langBefore }) })
  const w1 = () => sdkWorker({ sdkSessionId: 'sdk-w1', sessionId: 'sess-w1', taskId: 'w1', taskTitle: 'card w1', branch: 'swarm/w1', worktree: '/central/wt/w1' })

  it('W1 held: W1 is stopped and never resumed, its card waits in blocked, W2 is dispatched, nothing holds the project, one question is open', async () => {
    const engine = newEngine({ workers: [w1()] })
    const columns: Record<string, string> = { w1: 'doing', w2: 'todo' }
    const spawnWorker = vi.fn(async () => sdkSpawn('w2'))
    const recoverCard = vi.fn(async (_p: string, id: string, to: 'todo' | 'blocked') => { columns[id] = to; return true })
    const notify = vi.fn()
    const deps = stubDeps({ fetchTasks: async () => [card('w1', columns.w1), card('w2', columns.w2)], spawnWorker, recoverCard, notify, savedWorkHold: async () => [heldOp()] })

    for (const at of [T0, T0 + 3000, T0 + 6000]) await runDispatchPass(engine, deps, at)

    // W1: its session is ended through the normal teardown (work saved), once.
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
    expect(deps.recoverWorker).toHaveBeenCalledWith(expect.objectContaining({ worktree: '/central/wt/w1', sdkSessionId: 'sdk-w1' }))
    expect(recoverCard).toHaveBeenCalledWith('/proj', 'w1', 'blocked')
    expect(columns.w1).toBe('blocked')
    // W2 in the same project is dispatched. Nothing is ever spawned onto W1's card
    // or its conversation — the unknown call is not run again, nor handed on.
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(spawnWorker.mock.calls[0]).toMatchObject([{ title: 'card w2' }])
    expect((spawnWorker.mock.calls as unknown as { title?: string; resumeSessionId?: string }[][]).some(([o]) => o.title === 'card w1' || o.resumeSessionId === 'sess-w1')).toBe(false)
    expect(engine.workers.map((w) => w.taskId)).toEqual(['w2'])
    // Nothing holds the project: the commander's wake reads exactly this field.
    expect(engine.savedWorkHold).toBeUndefined()
    // ONE question in the owner's inbox for the operation — not addressed to W1.
    const open = await openHoldQuestions()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ receiptKey: 'hold:tool-w1', taskId: 'w1', projectPath: '/proj' })
    expect(open[0].sdkSessionId).toBeUndefined()
    expect(open[0].terminalId).toBeUndefined()
    expect(open[0].plainQuestion).toContain('「card w1」のワーカー')
    // The president hears it through the question — no separate project-wide notice.
    expect(held(notify)).toHaveLength(0)
    expect(engine.log.filter((l) => l.message.includes('held conversation'))).toHaveLength(1)
  })

  it('after a restart (no live worker; a failed resume put the card back in todo) the card still waits and only the other card dispatches', async () => {
    const engine = newEngine()
    const columns: Record<string, string> = { w1: 'todo', w2: 'todo' }
    const spawnWorker = vi.fn(async () => sdkSpawn('w2'))
    const recoverCard = vi.fn(async (_p: string, id: string, to: 'todo' | 'blocked') => { columns[id] = to; return true })
    const deps = stubDeps({ fetchTasks: async () => [card('w1', columns.w1), card('w2', columns.w2)], spawnWorker, recoverCard,
      savedWorkHold: async () => [heldOp({ seat: { role: 'worker', taskId: 'w1' } })] })
    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(recoverCard).toHaveBeenCalledWith('/proj', 'w1', 'blocked')
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(spawnWorker.mock.calls[0]).toMatchObject([{ title: 'card w2' }])
    expect(await openHoldQuestions()).toHaveLength(1)
  })

  it('a held commander or president conversation: one question each, and every worker still dispatches', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => sdkSpawn('a'))
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker,
      savedWorkHold: async () => [heldOp({ id: 'tool-m', sessionId: 'sess-m', seat: { role: 'manager' } }), heldOp({ id: 'input-p', sessionId: 'sess-p', tool: undefined, description: undefined, seat: { role: 'supply' } })] })
    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(engine.savedWorkHold).toBeUndefined()
    const open = await openHoldQuestions()
    expect(open.map((e) => e.receiptKey).sort()).toEqual(['hold:input-p', 'hold:tool-m'])
    expect(open.find((e) => e.receiptKey === 'hold:tool-m')?.plainQuestion).toContain('マネージャー')
    expect(open.find((e) => e.receiptKey === 'hold:input-p')?.plainQuestion).toContain('社長')
  })

  // An answer that picks neither is refused and leaves the question open (review
  // D-M2, 2026-11-28); a question closed some other way while the operation still
  // holds is raised again.
  it('a question closed without an A or B while the operation still holds is asked again (never a hold without its question)', async () => {
    const engine = newEngine()
    const deps = stubDeps({ fetchTasks: async () => [card('w1', 'blocked')], savedWorkHold: async () => [heldOp({ seat: { role: 'worker', taskId: 'w1' } })] })
    await runDispatchPass(engine, deps, T0)
    const [first] = await openHoldQuestions()
    await expect(answerEscalation(first.id, 'ちょっと考えさせて', { isPathAllowed: async () => true, queueForNextDispatch: async () => {} })).rejects.toThrow()
    expect(await openHoldQuestions()).toHaveLength(1)
    await dismissEscalation(first.id)
    expect(await openHoldQuestions()).toHaveLength(0)
    await runDispatchPass(engine, deps, T0 + 3000)
    const again = await openHoldQuestions()
    expect(again).toHaveLength(1)
    expect(again[0].id).not.toBe(first.id)
    expect(again[0]).toMatchObject({ receiptKey: 'hold:tool-w1', taskId: 'w1' })
  })

  // Review R3-ui S2 (2026-11-28): the president branches on the 409 `reason`, never on
  // the sentence — the onlyA sentence also asks for "the letter alone on the first line".
  it('each refusal carries its reason: unreadable on a worker question = format naming A or B, on a desk question = format naming A only, B on a desk = onlyA', async () => {
    const engine = newEngine()
    const deps = stubDeps({ fetchTasks: async () => [card('w1', 'blocked')],
      savedWorkHold: async () => [heldOp({ seat: { role: 'worker', taskId: 'w1' } }), heldOp({ id: 'tool-m', sessionId: 'sess-m', seat: { role: 'manager' } })] })
    await runDispatchPass(engine, deps, T0)
    const open = await openHoldQuestions()
    const worker = open.find((e) => e.receiptKey === 'hold:tool-w1')!, desk = open.find((e) => e.receiptKey === 'hold:tool-m')!
    const opts = { isPathAllowed: async () => true, queueForNextDispatch: async () => {} }
    await expect(answerEscalation(worker.id, 'ちょっと考えさせて', opts)).rejects.toMatchObject({ code: 'hold', reason: 'format', message: holdAnswerReason('unread', 'ja') })
    await expect(answerEscalation(desk.id, 'ちょっと考えさせて', opts)).rejects.toMatchObject({ code: 'hold', reason: 'format', message: holdAnswerReason('unreadA', 'ja') })
    expect(holdAnswerReason('unreadA', 'ja')).not.toMatch(/B/)
    await expect(answerEscalation(desk.id, 'B', opts)).rejects.toMatchObject({ code: 'hold', reason: 'onlyA', message: holdAnswerReason('onlyA', 'ja') })
    expect(await openHoldQuestions()).toHaveLength(2)
  })

  it('missing from the owner-gated read but still on record (owner-role lookup offline): not released — the question stays, the card stays out of dispatch', async () => {
    const engine = newEngine()
    const columns: Record<string, string> = { w1: 'doing' }
    const op = heldOp({ seat: { role: 'worker', taskId: 'w1' } })
    let gated = [op]
    const spawnWorker = vi.fn(async () => sdkSpawn('w1b'))
    const recoverCard = vi.fn(async (_p: string, id: string, to: 'todo' | 'blocked') => { columns[id] = to; return true })
    const deps = stubDeps({ fetchTasks: async () => [card('w1', columns.w1)], spawnWorker, recoverCard,
      savedWorkHold: async (_p: string, opts?: { anyOwner?: boolean }) => (opts?.anyOwner ? [op] : gated) })
    await runDispatchPass(engine, deps, T0)
    expect(columns.w1).toBe('blocked')
    gated = [] // the gated read goes blind
    columns.w1 = 'todo' // whatever put it back in the queue, it must not be dispatched
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(await openHoldQuestions()).toHaveLength(1)
    expect(recoverCard).not.toHaveBeenCalledWith('/proj', 'w1', 'todo')
    expect(spawnWorker).not.toHaveBeenCalled()
  })

  it('an operation that names no conversation holds every launch here — dispatch and the commander — with its question', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => sdkSpawn('a'))
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker,
      savedWorkHold: async () => [heldOp({ id: 'input-x', sessionId: undefined, tool: undefined, description: undefined, seat: { role: 'supply' } })] })
    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(spawnWorker).not.toHaveBeenCalled()
    expect(engine.savedWorkHold).toBeDefined()
    expect(await openHoldQuestions()).toHaveLength(1)
  })

  it('an open hold question the receipt read does not list (a native-only hold raised at boot) still keeps its card parked and out of dispatch', async () => {
    const engine = newEngine()
    const columns: Record<string, string> = { n1: 'doing', free: 'todo' }
    const spawnWorker = vi.fn(async () => sdkSpawn('free'))
    const recoverCard = vi.fn(async (_p: string, id: string, to: 'todo' | 'blocked') => { columns[id] = to; return true })
    await askAboutHeldOperation('/proj', { id: 'native-sess-n1', sessionId: 'sess-n1', tool: 'Bash', at: OP_AT, seat: { role: 'worker', taskId: 'n1' } })
    const deps = stubDeps({ fetchTasks: async () => [card('n1', columns.n1), card('free', columns.free)], spawnWorker, recoverCard, savedWorkHold: async () => [] })
    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(columns.n1).toBe('blocked')
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(spawnWorker.mock.calls[0]).toMatchObject([{ title: 'card free' }])
  })

  it('released without an answer (its transcript showed the result after all): the question is withdrawn and the card goes back to todo', async () => {
    const engine = newEngine({ workers: [w1()] })
    const columns: Record<string, string> = { w1: 'doing' }
    let ops = [heldOp()]
    const recoverCard = vi.fn(async (_p: string, id: string, to: 'todo' | 'blocked') => { columns[id] = to; return true })
    const deps = stubDeps({ fetchTasks: async () => [card('w1', columns.w1)], recoverCard, savedWorkHold: async () => ops, spawnWorker: vi.fn(async () => sdkSpawn('w1b')) })
    await runDispatchPass(engine, deps, T0)
    expect(await openHoldQuestions()).toHaveLength(1)
    ops = []
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(await openHoldQuestions()).toHaveLength(0)
    expect(recoverCard).toHaveBeenLastCalledWith('/proj', 'w1', 'todo')
  })

  it('when the question cannot be answered (owner sign-in gone) it holds too — the launch would die the same way — and says why', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => sdkSpawn('a'))
    const notify = vi.fn()
    let signedIn = false
    const deps = stubDeps({
      fetchTasks: async () => [card('a')],
      spawnWorker,
      notify,
      savedWorkHold: async () => {
        if (!signedIn) throw new Error('Owner sign-in is required.')
        return []
      },
    })
    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(spawnWorker).not.toHaveBeenCalled() // held from the first pass…
    expect(engine.log.filter((l) => l.message.includes('cannot confirm the owner'))).toHaveLength(1)
    expect(held(notify)).toHaveLength(0) // …told only once it lasts
    await runDispatchPass(engine, deps, T0 + 61_000)
    await runDispatchPass(engine, deps, T0 + 64_000)
    const told = held(notify)
    expect(told).toHaveLength(1)
    // the app's sign-in is the toolbar's person icon, not Settings (review R5 S1)
    expect(told[0].detail).toContain(`${APP_SIGN_IN_WHERE.ja}からサインインしているかを確かめてください`)
    signedIn = true
    await runDispatchPass(engine, deps, T0 + 67_000)
    expect(spawnWorker).toHaveBeenCalledTimes(1)
  })

  it('a single read error holds one pass and tells nobody; a lasting one is told as a record problem, not a sign-in one', async () => {
    // EMFILE / EBUSY on the record used to ring 「設定でサインインしているかを
    // 確かめてください」 at once (review 2026-11-26).
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => sdkSpawn('a'))
    const notify = vi.fn()
    let failing = true
    const deps = stubDeps({
      fetchTasks: async () => [card('a')],
      spawnWorker,
      notify,
      savedWorkHold: async () => {
        if (failing) throw new Error('EMFILE: too many open files')
        return []
      },
    })
    await runDispatchPass(engine, deps, T0)
    expect(spawnWorker).not.toHaveBeenCalled()
    failing = false
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(held(notify)).toHaveLength(0)

    const later = newEngine()
    failing = true
    for (const at of [T0, T0 + 30_000, T0 + 61_000, T0 + 90_000]) await runDispatchPass(later, { ...deps, spawnWorker: vi.fn() }, at)
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].detail).toContain('操作の記録が読み取れない')
    expect(told[0].detail).not.toContain('サインイン')
  })
})

describe('the question is plain, names who / when / what, and carries no path, branch or command (R-B4)', () => {
  it('the hint points at the question inbox by the label the bar shows', () => {
    expect(OWNER_REVIEW_WHERE).toContain(panelMessages.ja['projectPanel.swarm.bar.questions'].replace(/\s*\{count\}/, ''))
    expect(OWNER_REVIEW_HOLD_HINT).toContain(OWNER_REVIEW_WHERE)
    expect(OWNER_REVIEW_HOLD_HINT).not.toContain('会話の復旧')
  })

  it('a worker\'s question names the seat, the time and the call\'s own description; gives the two options and what each really does', () => {
    const q = unconfirmedOperationQuestion(heldOp({ seat: { role: 'worker', taskId: 'w1', title: 'ログイン画面の修正' } }))
    const local = new Date(OP_AT)
    expect(q.plainQuestion).toContain('「ログイン画面の修正」のワーカー')
    expect(q.plainQuestion).toContain(`${local.getMonth() + 1}月${local.getDate()}日 ${local.getHours()}:${String(local.getMinutes()).padStart(2, '0')}`)
    expect(q.plainQuestion).toContain('テストをすべて実行')
    expect(q.plainQuestion).toContain('決めていただきたいこと')
    // A keeps the work saved so far; B starts over (the earlier changes are kept, not continued).
    expect(q.plainQuestion).toContain('A「引き継いで続ける」')
    expect(q.plainQuestion).toContain('B「初めからやり直す」')
    expect(q.question).toMatch(/A: .*引き継いで続ける.* \/ B: .*初めからやり直す/)
    expect(q.plainQuestion).toContain('もう一度実行することはありません')
    expect(q.plainQuestion).toContain('ほかの作業は止まらずに続いています')
    // "until you answer, the stopped conversation is not resumed" implied A resumes it — it never does.
    expect(q.plainQuestion).not.toMatch(/再開しません/)
  })

  // Review R2 S-2: the question quoted a Board column 「保留」 / "On hold" that the
  // Board does not have — its blocked column is 判断待ち / "Needs decision".
  it('a worker\'s question names the Board column the card waits in by the Board\'s own label', () => {
    const op = heldOp({ seat: { role: 'worker', taskId: 'w1', title: 'card w1' } })
    const ja = unconfirmedOperationQuestion(op, undefined, 'ja').plainQuestion, en = unconfirmedOperationQuestion(op, undefined, 'en').plainQuestion
    expect(ja).toContain(`「${boardMessages.ja['board.col.blocked']}」`)
    expect(en).toContain(`"${boardMessages.en['board.col.blocked']}"`)
    expect(ja).not.toContain('「保留」')
    expect(en).not.toContain('On hold')
  })

  // Review R2 S-3: a question already withdrawn is refused in plain words that say
  // no answer is needed, in both languages.
  it('the refusal for a question that is already closed is plain and says nothing is needed', () => {
    expect(holdAnswerReason('closed', 'ja')).toMatch(/答えは要りません/)
    expect(holdAnswerReason('closed', 'en')).toMatch(/no answer is needed/)
  })

  it.each([
    [{ role: 'manager' } as const, 'マネージャー'],
    [{ role: 'supply' } as const, '社長'],
  ])('a desk\'s question (%o) offers ONE honest option — both answers would open a new conversation', (seat, who) => {
    const q = unconfirmedOperationQuestion(heldOp({ seat }))
    expect(q.plainQuestion).toContain(who)
    expect(q.plainQuestion).toContain('A「確認した」')
    expect(q.plainQuestion).toContain('新しい会話')
    expect(q.plainQuestion).not.toContain('B「')
    expect(q.question).not.toContain('B:')
    for (const text of [q.question, q.plainQuestion, q.context]) expect(text).not.toMatch(/司令官|作業の担当/)
  })

  it('an operation that names no conversation does not claim the rest of the project goes on — it holds every launch', () => {
    const q = unconfirmedOperationQuestion(heldOp({ sessionId: undefined, tool: undefined, description: undefined, seat: { role: 'supply' } }))
    expect(q.plainQuestion).not.toContain('ほかの作業は止まらずに続いています')
    expect(q.plainQuestion).toContain('新しい作業を始めません')
  })

  it('a description with command words, a path, an option or a branch name is dropped whole; no path, branch or command reaches the owner', () => {
    for (const description of ['Run npm test --watch in /Users/me/projects/app on swarm/w1 && rm -rf ~/tmp', 'Push to origin main', 'git push origin main --force to swarm/abc-123', 'Run npm test in and rm dist']) {
      const q = unconfirmedOperationQuestion(heldOp({ seat: { role: 'worker', taskId: 'w1', title: 'card w1' }, description }))
      for (const text of [q.question, q.plainQuestion, q.context]) {
        expect(text).not.toMatch(/\/Users|swarm\/|--watch|&&|rm|~\/|npm|git|push|origin|main/)
      }
      expect(q.plainQuestion).toContain('コマンドの実行')
      expect(plainDescription(description)).toBeUndefined()
    }
    expect(plainDescription('Run full verification on current fixed page')).toBe('Run full verification on current fixed page')
    expect(plainDescription('テストをすべて実行')).toBe('テストをすべて実行')
  })

  it('the hold notices name the seats as the screen does (社長 / マネージャー / ワーカー)', () => {
    for (const text of [toolDenialNotice('ログイン画面の修正'), ownerUnconfirmedNotice(1), ownerUnconfirmedNotice(0, false)]) expect(text).not.toMatch(/司令官|の担当/)
    expect(toolDenialNotice('ログイン画面の修正')).toContain('「ログイン画面の修正」のワーカー')
    expect(ownerUnconfirmedNotice(0)).toContain('マネージャー')
  })

  it('a fresh desk is told what stopped, when, and to look at the current state first — never the call\'s arguments', () => {
    const line = heldOperationOpening(heldOp({ description: 'Deploy the site' }))
    expect(line).toContain('Bash')
    expect(line).toContain(OP_AT)
    expect(line).toContain('Deploy the site')
    expect(line).toContain('NEW conversation')
    expect(line).toMatch(/current state/)
  })

  it('the line the president hears names who and what, and survives the supply desk untouched (no redaction, under the cap)', () => {
    const q = unconfirmedOperationQuestion(heldOp({ seat: { role: 'worker', taskId: 'w1', title: '長いカード名の作業' } }), { ja: '「長いカード名の作業」の担当を使用量の上限で止めたとき、実行中だった操作が途中で切れました', en: 'unused' })
    const bell = ownerQuestionDetail(q)
    expect(Array.from(bell).length).toBeLessThan(SUPPLY_NOTICE_MAX)
    expect(sanitizeSupplyNotice(bell)).toBe(bell.replace(/\s+/g, ' ').trim()) // line breaks fold; nothing is redacted
    expect(bell).toContain('「長いカード名の作業」のワーカー')
    expect(bell).toContain('テストをすべて実行')
  })
})

// The owner's B on a worker's held operation means 「初めからやり直す」 (review D S3):
// the card goes back to the queue without its branch, so the next dispatch starts
// from the main line instead of re-entering the stopped work (the branch itself is
// kept — only an explicit force sweep ever deletes an unmerged branch).
describe('unparking a held card', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it.each([[false, []], [true, [{ id: 'w1', branch: '' }]]] as const)('fresh=%s → the card goes to todo, its branch cleared only when fresh', async (fresh, setBranch) => {
    const posted: { setColumn?: unknown; setBranch?: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') { posted.push(JSON.parse(init.body ?? '{}')); return new Response('{}', { status: 200 }) }
      return new Response(JSON.stringify({ tasks: [card('w1', 'blocked')] }), { status: 200 })
    }))
    expect(await unparkBlockedCard('/proj', 'w1', { fresh })).toBe(true)
    expect(posted).toEqual([expect.objectContaining({ setColumn: [expect.objectContaining({ id: 'w1', column: 'todo' })], setBranch })])
  })
})

// Review A S6 (2026-11-28): boot resume parks a card whose saved conversation
// stopped mid-tool and raises its question once. If that ask failed, nothing raised
// it again — refreshSavedWorkHold re-asks only receipt operations or cards that
// already have a question — and the card sat in blocked with no question at all.
describe('a card parked at boot for a held conversation is never left without its question', () => {
  it('the ask fails at boot; the next pass raises it, once', async () => {
    const engine = newEngine()
    await mkdir(escalationsFile(), { recursive: true }) // the inbox cannot be written: the ask throws
    const recoverCard = vi.fn(async () => true)
    const deps = stubDeps({ fetchTasks: async () => [card('w1', 'doing')], recoverCard, heldConversation: async () => undefined,
      spawnWorker: async () => { throw new NativeUnfinishedToolsError([{ id: 'toolu_1', name: 'Bash', at: OP_AT }], 'sess-w1') } })
    await adoptResumeCandidates(engine, { resumeCandidates: [{ branch: 'swarm/w1', tier: 'fable', spawnAt: T0 - 60_000, workedMs: 0, reworkCount: 0,
      sessionId: 'sess-w1', taskId: 'w1', worktree: '/central/wt/w1' }], ready: [], vanished: [], cardGone: [] } as never, deps, async () => true, T0)
    expect(recoverCard).toHaveBeenCalledWith('/proj', 'w1', 'blocked')
    await rm(escalationsFile(), { recursive: true, force: true })
    expect(await openHoldQuestions()).toHaveLength(0)
    const spawnWorker = vi.fn(async () => sdkSpawn('w1'))
    const after = { ...deps, spawnWorker, fetchTasks: async () => [card('w1', 'blocked')] }
    await runDispatchPass(engine, after, T0 + 3000)
    expect(await openHoldQuestions()).toMatchObject([{ receiptKey: 'hold:native-sess-w1', taskId: 'w1' }])
    await runDispatchPass(engine, after, T0 + 6000)
    expect(await openHoldQuestions()).toHaveLength(1)
    expect(spawnWorker).not.toHaveBeenCalled()
  })
})

// Review A N4 (2026-11-28): hold questions were Japanese whatever Settings.language
// said. They follow it now — Japanese by default (the coordinator's decision for
// these questions: they were Japanese-only), English when the owner chose English —
// with the same shape in both, as escalation questions should (CLAUDE.md policy).
describe('a held operation\'s question follows Settings.language', () => {
  const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/
  const seats: HeldOperation['seat'][] = [{ role: 'worker', taskId: 'w1', title: 'Login page' }, { role: 'manager' }, { role: 'supply' }, { role: 'unknown' }]
  it.each(seats)('ja and en have the same shape for %o (lines, letters offered, no Japanese in en)', (seat) => {
    for (const sessionId of ['sess-1', undefined]) {
      const op = heldOp({ seat, sessionId, description: 'Run the whole test suite' })
      const cause = { ja: '止めたとき', en: 'when it was stopped' }
      const ja = unconfirmedOperationQuestion(op, cause, 'ja'), en = unconfirmedOperationQuestion(op, cause, 'en')
      expect(en.plainQuestion.split('\n')).toHaveLength(ja.plainQuestion.split('\n').length)
      for (const letter of ['A', 'B']) expect(en.plainQuestion.includes(`${letter} "`)).toBe(ja.plainQuestion.includes(`${letter}「`))
      for (const text of [en.question, en.plainQuestion, en.context]) expect(text).not.toMatch(JAPANESE)
      expect(ja.plainQuestion).toMatch(JAPANESE)
      expect(en.context).toContain('When it was stopped.')
    }
  })
  // Review R5 S1: the app's sign-in is the toolbar's person icon; Settings shows only
  // the Claude CLI's connection. Six owner-facing sentences in three files sent the
  // owner to Settings to sign in — a false door. This guards the whole class.
  it('no owner-facing text sends the owner to Settings to sign in', async () => {
    const { readdir, readFile } = await import('fs/promises')
    const offenders: string[] = []
    for (const root of ['src/lib/server', 'src/i18n/messages', 'src/components', 'server/routes', 'skills']) {
      for (const rel of await readdir(root, { recursive: true }) as string[]) {
        if (!/\.(ts|tsx|md)$/.test(rel) || /\.test\.tsx?$/.test(rel)) continue
        const text = await readFile(`${root}/${rel}`, 'utf8')
        for (const bad of [/設定でサインイン/, /signed in \(Settings\)/, /in Settings that you are signed in/i]) if (bad.test(text)) offenders.push(`${root}/${rel}: ${bad}`)
      }
    }
    expect(offenders).toEqual([])
    for (const lang of ['ja', 'en'] as const) expect(holdAnswerReason('signIn', lang)).toContain(APP_SIGN_IN_WHERE[lang])
  })
  // Review R3-ui S1: the Settings door only while the panel can list it.
  it('a held ChatGPT conversation names the Settings panel only when that panel can show it', () => {
    // third argument: the panel's other conditions hold (app sign-in, live connection, work mode off)
    expect(chatGptHoldHint('this', 'uncertain', true)).toBe(CHATGPT_REVIEW_HOLD_HINT)
    for (const [account, recovery, panelShows] of [['this', 'uncertain', false], ['other', 'uncertain', true], ['signed-out', 'uncertain', true],
      ['other', 'invalid', true], ['signed-out', 'invalid', true], ['this', 'invalid', true]] as const) {
      expect(chatGptHoldHint(account, recovery, panelShows)).toBe(CHATGPT_SIGN_IN_HOLD_HINT)
    }
    expect(chatGptHoldHint('unreadable', 'invalid', true)).toBe(CHATGPT_UNREADABLE_HOLD_HINT)
    expect(CHATGPT_SIGN_IN_HOLD_HINT).not.toContain(CHATGPT_REVIEW_HOLD_HINT)
    // each is a hold only the owner clears: no "launch it by hand", retried on the owner's timer
    for (const hint of [CHATGPT_REVIEW_HOLD_HINT, CHATGPT_SIGN_IN_HOLD_HINT, CHATGPT_UNREADABLE_HOLD_HINT]) expect(isOwnerReviewHold(`x(${hint})`)).toBe(true)
  })
  it('the refusal reasons exist in both languages', () => {
    for (const kind of ['unread', 'unreadA', 'onlyA', 'failed', 'signIn', 'running', 'closed'] as const) {
      expect(holdAnswerReason(kind, 'ja')).toMatch(JAPANESE)
      expect(holdAnswerReason(kind, 'en')).not.toMatch(JAPANESE)
    }
  })
  it('raised with Settings.language = en or unset, the inbox question is English; ja, Japanese', async () => {
    const before = (await getSettings()).language
    try {
      await setSettings({ language: 'en' })
      await askAboutHeldOperation('/proj', heldOp({ id: 'tool-en', seat: { role: 'manager' } }))
      await setSettings({ language: undefined })
      await askAboutHeldOperation('/proj', heldOp({ id: 'tool-unset', seat: { role: 'manager' } }))
      await setSettings({ language: 'ja' })
      await askAboutHeldOperation('/proj', heldOp({ id: 'tool-ja', seat: { role: 'manager' } }))
      const open = await openHoldQuestions()
      expect(open.find((e) => e.receiptKey === 'hold:tool-en')?.plainQuestion).toMatch(/^What to decide: The manager/)
      // unset ⇒ English: the app's one resolver (promptLang.langOf), CLAUDE.md language policy
      expect(open.find((e) => e.receiptKey === 'hold:tool-unset')?.plainQuestion).toMatch(/^What to decide: The manager/)
      expect(open.find((e) => e.receiptKey === 'hold:tool-ja')?.plainQuestion).toMatch(/^決めていただきたいこと: マネージャー/)
      // …and an answer it cannot read is refused in the owner's language.
      await setSettings({ language: 'en' })
      const en = open.find((e) => e.receiptKey === 'hold:tool-en')!
      // (a manager's question offers only A, so the refusal names only A — R3-ui S2)
      await expect(answerEscalation(en.id, 'ちょっと考えさせて', { isPathAllowed: async () => true })).rejects.toThrow(/^Please answer with "A" alone on the first line/)
    } finally { await setSettings({ language: before }) }
  })
})

describe('a worker lost at start says why', () => {
  it('journals the SDK session exit reason instead of a bare "worker lost"', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      isAlive: () => false,
      sdkWorkerFacts: () => ({ exitReason: 'error: A previous tool operation has an unconfirmed result.' }),
    })
    await runDispatchPass(engine, deps, T0)
    const lost = engine.log.find((l) => l.message.includes('worker lost'))
    expect(lost?.message).toContain('exit: error: A previous tool operation has an unconfirmed result.')
  })
})

describe('the quota stop does not cut a worker off in the middle of a command', () => {
  // These cases read the owner's Japanese question: the owner's machine runs
  // Settings.language = 'ja' (unset ⇒ English, promptLang.langOf).
  let langBefore: 'en' | 'ja' | undefined
  beforeEach(async () => { langBefore = (await getSettings()).language; await setSettings({ language: 'ja' }) })
  afterEach(async () => { await setSettings({ language: langBefore }) })
  const quotaDeps = (over: Partial<Deps>): Deps =>
    stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      recentOutput: () => '[sdk session quota-parked]',
      quotaBlocked: () => true,
      ...over,
    })

  it('waits while a command is running, then stops cleanly once it has finished', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    let running = 1
    const deps = quotaDeps({ sdkWorkerFacts: () => ({ toolCallsInFlight: running }) })

    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 3000)
    // Kept: the command is still running, so nothing was torn down or requeued.
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(deps.recoverCard).not.toHaveBeenCalled()
    expect(engine.workers).toHaveLength(1)
    expect(engine.log.filter((l) => l.message.includes('waiting for them to finish'))).toHaveLength(1)

    running = 0
    await runDispatchPass(engine, deps, T0 + 6000)
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'todo')
    expect(engine.workers).toHaveLength(0)
    // Nothing was cut off, so nothing is recorded as cut off.
    expect(engine.log.some((l) => l.message.includes('stopped in the middle of'))).toBe(false)
    expect(engine.forcedStopNote).toBeUndefined()
  })

  // The real reader names no card here: the cut-off worker is pruned and its
  // roster row synced away before the next pass reads the hold, and the quota
  // stop itself put the card back in todo (review 2026-11-28, MUST-FIX 1). The
  // engine must still find the card — and keep every new worker off it.
  it('a command the engine itself cut off: recorded, the requeued card is parked on the next pass, its question names the card and the stop, and no new worker takes it', async () => {
    const engine = newEngine({ workers: [sdkWorker({ sessionId: 'sess-q1' })] })
    const columns: Record<string, string> = { q1: 'doing' }
    let unconfirmed = 0
    const spawnWorker = vi.fn(async () => sdkSpawn('q1-again'))
    const deps = quotaDeps({ sdkWorkerFacts: () => ({ toolCallsInFlight: 1 }), spawnWorker,
      fetchTasks: async () => [card('q1', columns.q1)],
      recoverCard: vi.fn(async (_p: string, id: string, to: 'todo' | 'blocked') => { columns[id] = to; return true }),
      savedWorkHold: async () => (unconfirmed ? [heldOp({ id: 'tool-q1', sessionId: 'sess-q1', seat: { role: 'unknown' } })] : []) })

    await runDispatchPass(engine, deps, T0)
    expect(deps.recoverWorker).not.toHaveBeenCalled()

    // The stop itself is what leaves the operation unconfirmed.
    ;(deps.recoverWorker as ReturnType<typeof vi.fn>).mockImplementation(async () => { unconfirmed = 1; return { removed: true } })
    await runDispatchPass(engine, deps, T0 + TOOL_BOUNDARY_WAIT_MS)
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
    expect(engine.log.some((l) => l.message.includes('stopped in the middle of 1 running command(s) (rate-limit)'))).toBe(true)
    expect(columns.q1, 'without the owner role nothing records or asks — the old requeue stands').toBe('todo')

    // The hold is read at the top of the NEXT pass (3 s later).
    for (const at of [3000, 6000, 9000]) await runDispatchPass(engine, deps, T0 + TOOL_BOUNDARY_WAIT_MS + at)
    expect(columns.q1).toBe('blocked')
    expect(spawnWorker).not.toHaveBeenCalled()
    const open = await openHoldQuestions()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ taskId: 'q1' })
    expect(open[0].context).toContain('使用量の上限で止めたとき、実行中だった操作が途中で切れました')
  })

  it('for the owner role the cut-off card is parked ON DISK by the stop itself — a restart before the next pass cannot hand it on', async () => {
    role.owner = true
    const engine = newEngine({ workers: [sdkWorker({ sessionId: 'sess-q1' })] })
    const columns: Record<string, string> = { q1: 'doing' }
    const deps = quotaDeps({ sdkWorkerFacts: () => ({ toolCallsInFlight: 1 }),
      fetchTasks: async () => [card('q1', columns.q1)],
      recoverCard: vi.fn(async (_p: string, id: string, to: 'todo' | 'blocked') => { columns[id] = to; return true }) })
    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + TOOL_BOUNDARY_WAIT_MS)
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
    expect(columns.q1).toBe('blocked')
  })

  // A wait that ended because the worker went back to work used to leave its
  // stamp behind. The next stop, fifteen minutes or more later, read that stamp
  // as "already waited long enough": it cut the running command off at once (the
  // very harm the wait exists to prevent) and skipped the cooling mark with it.
  it('a wait belongs to one stop: a later refusal waits (and cools) afresh instead of inheriting the old stamp', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    let refused = true
    let lastOut: number | null = null
    const deps = quotaDeps({
      quotaBlocked: () => refused,
      recentOutput: () => (refused ? '[sdk session quota-parked]' : '[sdk session working]'),
      lastOutputAt: () => lastOut,
      sdkWorkerFacts: () => ({
        toolCallsInFlight: 1,
        ...(refused ? { refusal: "You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)" } : {}),
      }),
    })
    await runDispatchPass(engine, deps, T0) // refused in the middle of a command: the wait starts
    expect(engine.toolBoundaryWaits?.size).toBe(1)

    // The limit lifts and the worker goes back to work — nobody wants to stop it.
    refused = false
    lastOut = T0 + 3000
    __resetQuotaForTest()
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(engine.toolBoundaryWaits?.size ?? 0).toBe(0)

    // Refused again much later, again in the middle of a command.
    refused = true
    const later = T0 + TOOL_BOUNDARY_WAIT_MS + 5 * 60_000
    await runDispatchPass(engine, deps, later)
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(isTierCooling('fable', later + 1000)).toBe(true)
  })
})

describe('an all-model limit is not walked down tier by tier', () => {
  // Which wordings close EVERY model. All-model needs two agreeing signs: the CLI
  // offered no "/model" way out AND named no model. Anything else keeps the old
  // promise — cool only the tier that met the wall (and nothing by guess).
  it('splits the measured refusal wordings: all-model vs one model vs not known', () => {
    const allModel = [
      "You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)", // 2026-11-23 16:33, commander desk
      "You've hit your session limit · resets 3pm",
      "You've hit your weekly limit · resets Dec 1, 9am",
      'Claude usage limit reached — resets in 30 minutes', // the older CLI's account limit
    ]
    const oneModel = [
      "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.", // offers /model
      'Fable 5 requires usage credits. Add funds to continue.', // names the model, no remedy line
      "You've reached your Opus limit · resets 5pm",
      "You've reached your Fable 5 limit — resets in 30 minutes",
      // The CLI's credit / spend family (2.1.220 bundled, 2.1.332 installed — review
      // 2026-11-26): one model's credits, another model still runs. Read as all-model
      // before (no "switch models with /model" line, no model named).
      "You're out of usage credits. /model to switch models.",
      "You've hit your monthly spend limit. /model to switch models.",
      "You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage, to continue.",
      "You've hit your monthly spend limit. Switch to another model to continue.",
      "You've hit your team's pooled group budget. Switch to another model to continue.",
      "You're out of usage credits. Add funds to continue.", // no window named — never all-model by guess
      'ChatGPT usage limit; retry after 9:00 PM', // another provider's limit
    ]
    for (const said of allModel) expect(refusalClosesEveryModel(quotaRefusalKindOfText(said), said), said).toBe(true)
    for (const said of oneModel) expect(refusalClosesEveryModel(quotaRefusalKindOfText(said), said), said).toBe(false)
    // A refusal whose kind could not be read is not all-model either.
    expect(refusalClosesEveryModel(null, allModel[0])).toBe(false)
  })

  const parked = (refusal: string) =>
    stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      recentOutput: () => '[sdk session quota-parked]',
      quotaBlocked: () => true,
      sdkWorkerFacts: () => ({ refusal }),
    })

  it('the 5-hour window cools EVERY tier on one refusal (measured: 4 cards × 4 tiers = 16 refused launches)', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    await runDispatchPass(engine, parked("You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)"), T0)
    for (const tier of MODEL_TIER_LADDER) expect(isTierCooling(tier, T0 + 1000), tier).toBe(true)
    expect(engine.log.some((l) => l.message.includes('every tier cooling until'))).toBe(true)
  })

  it('a per-model limit (the CLI offers /model) cools only that tier, so the next launch steps down', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    await runDispatchPass(engine, parked("You've reached your Fable 5 limit. Resets at 3:00pm. Switch models with /model"), T0)
    expect(isTierCooling('fable', T0 + 1000)).toBe(true)
    for (const tier of MODEL_TIER_LADDER.filter((t) => t !== 'fable')) expect(isTierCooling(tier, T0 + 1000), tier).toBe(false)
  })

  // Cooling the whole ladder parks every dispatch until the stated reset, so "no
  // /model line" alone must not decide it: these wordings carry none, and they
  // are one model's limit. Read as all-model, a spent Opus would have parked the
  // swarm although Sonnet could run.
  it.each([
    ["You've reached your Opus limit · resets 5pm", 'opus'],
    ['Opus 4.8 requires usage credits.', 'opus'],
    ["You've reached your Fable limit for this week.", 'fable'],
  ] as const)('a limit that names a model is that model\'s own, /model line or not: %s', async (refusal, model) => {
    const engine = newEngine({ workers: [sdkWorker({ model })] })
    await runDispatchPass(engine, parked(refusal), T0)
    expect(isTierCooling(model, T0 + 1000)).toBe(true)
    for (const tier of MODEL_TIER_LADDER.filter((t) => t !== model)) expect(isTierCooling(tier, T0 + 1000), tier).toBe(false)
  })

  it.each([
    "You're out of usage credits. /model to switch models.",
    "You've hit your monthly spend limit. Switch to another model to continue.",
    "You've hit your team's pooled group budget. Switch to another model to continue.",
  ])('a credit / spend limit that offers another model cools only the worker\'s tier: %s', async (refusal) => {
    const engine = newEngine({ workers: [sdkWorker()] })
    await runDispatchPass(engine, parked(refusal), T0)
    expect(MODEL_TIER_LADDER.filter((t) => isTierCooling(t, T0 + 1000))).toEqual(['fable'])
  })

  it("a ChatGPT worker's usage limit cools no Claude tier (a ChatGPT limit cools only ChatGPT)", async () => {
    const engine = newEngine({ workers: [sdkWorker({ model: 'gpt-5.5' })] })
    await runDispatchPass(engine, parked("You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)"), T0)
    await runDispatchPass(engine, parked('ChatGPT usage limit; retry after 9:00 PM'), T0 + 1000)
    expect(MODEL_TIER_LADDER.filter((t) => isTierCooling(t, T0 + 2000))).toEqual([])
  })

  it.each(['weekly', 'session', '5-hour'])('the %s limit names no model and closes them all', async (window) => {
    const engine = newEngine({ workers: [sdkWorker({ model: 'sonnet' })] })
    await runDispatchPass(engine, parked(`You've hit your ${window} limit · resets 9pm (Asia/Tokyo)`), T0)
    for (const tier of MODEL_TIER_LADDER) expect(isTierCooling(tier, T0 + 1000), tier).toBe(true)
  })
})

describe('every engine stop waits for a running command', () => {
  it('the execution ceiling keeps a worker until its command finishes', async () => {
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(T0 - MAX_EXEC_MS - 60_000).toISOString() })] })
    let running = 1
    const deps = stubDeps({ fetchTasks: async () => [card('q1', 'doing')], sdkWorkerFacts: () => ({ toolCallsInFlight: running }) })
    await runDispatchPass(engine, deps, T0)
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(engine.log.filter((l) => l.message.includes('over its execution budget with 1 command(s) still running'))).toHaveLength(1)
    running = 0
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
  })

  it('a silent worker running a long command is not reclaimed as stalled until the command ends', async () => {
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(T0).toISOString() })] })
    let running = 1
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      sdkWorkerFacts: () => ({ toolCallsInFlight: running }),
      nudge: vi.fn(() => true),
      escalate: vi.fn(async () => true),
    })
    const S = STALL_SILENCE_MS
    const C = STALL_NUDGE_COOLDOWN_MS
    for (const at of [T0 + S + 1, T0 + S + C + 2, T0 + S + 2 * C + 3, T0 + S + 3 * C + 4]) await runDispatchPass(engine, deps, at)
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(engine.log.some((l) => l.message.includes('silent past the stall limit with 1 command(s) still running'))).toBe(true)
    running = 0
    await runDispatchPass(engine, deps, T0 + S + 3 * C + 5)
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
  })

  // The ceiling's arm runs first in the loop. Judging another stop's wait there
  // turned a quota stop — or a stall — into a runaway once the command ended
  // past the ceiling: card → blocked, never re-dispatched (review 2026-11-26).
  it('a usage stop waiting out a command in the budget\'s last minutes leaves as a quota stop (card → todo), not a runaway', async () => {
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(T0 - (MAX_EXEC_MS - 2 * 60_000)).toISOString() })] })
    let running = 1
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      recentOutput: () => '[sdk session quota-parked]',
      quotaBlocked: () => true,
      sdkWorkerFacts: () => ({ toolCallsInFlight: running }),
    })
    await runDispatchPass(engine, deps, T0) // 88 minutes in: refused mid-command
    await runDispatchPass(engine, deps, T0 + 3 * 60_000) // 91 minutes: past the ceiling, still running
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    running = 0
    await runDispatchPass(engine, deps, T0 + 3 * 60_000 + 3000)
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'todo')
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
  })

  it('a stall reclaim waiting out a command past the ceiling stays a stall (card → todo), not a runaway', async () => {
    const S = STALL_SILENCE_MS
    const C = STALL_NUDGE_COOLDOWN_MS
    const holdAt = T0 + S + 3 * C + 4
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(holdAt - (MAX_EXEC_MS - 5 * 60_000)).toISOString() })] })
    let running = 1
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      sdkWorkerFacts: () => ({ toolCallsInFlight: running }),
      nudge: vi.fn(() => true),
      escalate: vi.fn(async () => true),
    })
    for (const at of [T0 + S + 1, T0 + S + C + 2, T0 + S + 2 * C + 3, holdAt]) await runDispatchPass(engine, deps, at)
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(engine.log.some((l) => l.message.includes('silent past the stall limit with 1 command(s) still running'))).toBe(true)
    running = 0
    await runDispatchPass(engine, deps, holdAt + 10 * 60_000) // 95 minutes in
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'todo')
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
  })

  it('a quota stop during a command: the re-dispatched worker comes up instead of dying in seconds (JobSearch 16:29)', async () => {
    // The real teardown interrupts the session; a command cut off mid-run is
    // left unconfirmed, and every launch into the project then dies at once.
    let column = 'doing'
    let running = 1
    let unconfirmed = 0
    const engine = newEngine({ workers: [sdkWorker()] })
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', column)],
      recentOutput: (w) => (w.sdkSessionId === 'sdk-q1' ? '[sdk session quota-parked]' : '[sdk session working]'),
      quotaBlocked: (w) => w.sdkSessionId === 'sdk-q1',
      sdkWorkerFacts: (id) => (id === 'sdk-q1' ? { toolCallsInFlight: running } : {}),
      savedWorkHold: async () => (unconfirmed ? [heldOp({ sessionId: 'sess-q1' })] : []),
      recoverWorker: vi.fn(async () => {
        if (running > 0) unconfirmed = 1
        return { removed: true }
      }),
      recoverCard: vi.fn(async (_p: string, _id: string, to: 'todo' | 'blocked') => {
        column = to
        return true
      }),
      moveToDoing: vi.fn(async () => {
        column = 'doing'
        return true
      }),
      spawnWorker: vi.fn(async () => sdkSpawn('q1-again')),
      isAlive: (w) => w.sdkSessionId !== 'sdk-q1-again' || unconfirmed === 0,
    })
    await runDispatchPass(engine, deps, T0)
    running = 0 // the test run finishes
    for (let i = 1; i <= 4; i++) await runDispatchPass(engine, deps, T0 + i * 3000)
    expect(unconfirmed).toBe(0)
    expect(deps.spawnWorker).toHaveBeenCalledTimes(1)
    expect(engine.workers.map((w) => w.sdkSessionId)).toEqual(['sdk-q1-again'])
    expect(engine.log.some((l) => l.message.includes('worker lost'))).toBe(false)
  })
})

describe('a worker whose every tool call is refused is reported early', () => {
  it('journals and tells the president once, after a few refusals in a row — not at the 90-minute ceiling', async () => {
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(T0).toISOString() })] })
    let streak = TOOL_DENIAL_ALERT
    const notify = vi.fn()
    const deps = stubDeps({ fetchTasks: async () => [card('q1', 'doing')], notify, toolDenialStreak: () => streak, lastOutputAt: () => T0 })
    await runDispatchPass(engine, deps, T0 + 1000)
    await runDispatchPass(engine, deps, T0 + 4000)
    expect(engine.log.filter((l) => l.message.includes('tool calls are all refused'))).toHaveLength(1)
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].detail).toContain('「quota me」のワーカーが、道具(コマンドやファイルの操作)をすべて断られていて')
    expect(told[0].detail).toContain(OWNER_REVIEW_WHERE)
    // A call that goes through re-arms it; a new run of refusals is told again.
    streak = 0
    await runDispatchPass(engine, deps, T0 + 7000)
    streak = TOOL_DENIAL_ALERT
    await runDispatchPass(engine, deps, T0 + 10_000)
    expect(held(notify)).toHaveLength(2)
  })

  it('a worker refused because its OWN conversation is held is stopped and parked first — its question says it, no second notice', async () => {
    const engine = newEngine({ workers: [sdkWorker({ sessionId: 'sess-q1', startedAt: new Date(T0).toISOString() })] })
    const notify = vi.fn()
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      notify,
      savedWorkHold: async () => [heldOp({ id: 'tool-q1', sessionId: 'sess-q1' })],
      toolDenialStreak: () => TOOL_DENIAL_ALERT,
      lastOutputAt: () => T0,
    })
    await runDispatchPass(engine, deps, T0 + 1000)
    await runDispatchPass(engine, deps, T0 + 4000)
    expect(held(notify)).toHaveLength(0)
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'blocked')
    expect(await openHoldQuestions()).toHaveLength(1)
  })
})

describe('a dispatch that keeps failing is told, not retried in silence', () => {
  it('a first-time project with no commit: told once after a few failures, with the reason; a working dispatch clears it', async () => {
    const engine = newEngine()
    const notify = vi.fn()
    let fail = true
    const spawnWorker = vi.fn(async () => {
      if (fail) throw new Error('このプロジェクトにはまだ git の記録(コミット)がありません — 最初のコミットができると作業を始められます')
      return sdkSpawn('a')
    })
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker, notify })
    for (let i = 0; i < DISPATCH_FAILURE_TELL * 2; i++) await runDispatchPass(engine, deps, T0 + i * 3000)
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].detail).toContain('「card a」の作業を始めようとして、失敗が続いています')
    expect(told[0].detail).toContain('git の記録(コミット)がありません')
    fail = false
    await runDispatchPass(engine, deps, T0 + 60_000)
    expect(engine.workers).toHaveLength(1)
    expect(engine.dispatchFailures?.has('a')).toBe(false)
  })
})

describe('a worker refused by the usage limit and gone at once is a quota stop, not a crash', () => {
  // Measured 2026-11-23 17:44 / 22:21: the transcript ends "You've hit your
  // 5-hour limit", the session is gone seconds later, and the engine journalled
  // "worker lost — card → blocked (crash)". Nothing returns a blocked card to
  // todo when the limit lifts, so three cards sat there overnight.
  const REFUSAL = "You've hit your 5-hour limit · resets 2:50am (Asia/Tokyo)"
  const gone = (worker: Partial<OrchestratorWorker>, facts: { exitReason?: string; refusal?: string }) => {
    let column = 'doing'
    const engine = newEngine({ workers: [sdkWorker(worker)] })
    const moveToReview = vi.fn(async () => {
      column = 'review'
      return true
    })
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', column)],
      isAlive: () => false,
      countCommitsAhead: async () => 3, // it had committed — the rule that parks a crash in blocked
      sdkWorkerFacts: () => facts,
      recoverCard: vi.fn(async (_p: string, _id: string, to: 'todo' | 'blocked') => {
        column = to
        return true
      }),
      moveToReview,
    })
    return { engine, deps, moveToReview, column: () => column }
  }
  const reentered = { reenteredAt: new Date(T0 - 5 * 60_000).toISOString() }
  const ended = 'error: A previous tool operation has an unconfirmed result.'

  it('the card returns to todo (not blocked), every tier cools, and the journal says quota stop with the exit reason', async () => {
    const t = gone(reentered, { exitReason: ended, refusal: REFUSAL })
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.column()).toBe('todo')
    expect(MODEL_TIER_LADDER.every((tier) => isTierCooling(tier, T0 + 1000))).toBe(true)
    expect(t.engine.log.some((l) => l.message.includes('worker lost'))).toBe(false)
    const line = t.engine.log.find((l) => l.message.includes('quota-stopped — requeued'))
    expect(line?.message).toContain('card → todo')
    expect(line?.message).toContain(`exit: ${ended}`)
  })

  it('a first-run worker with commits is requeued too — not handed to review as if it had finished', async () => {
    const t = gone({}, { exitReason: ended, refusal: REFUSAL })
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.moveToReview).not.toHaveBeenCalled()
    expect(t.column()).toBe('todo')
  })

  it('a death whose last words were not a refusal is still a crash: commits park the card in blocked, nothing cools', async () => {
    const t = gone(reentered, { exitReason: 'error: boom' })
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.column()).toBe('blocked')
    expect(MODEL_TIER_LADDER.some((tier) => isTierCooling(tier, T0 + 1000))).toBe(false)
  })
})

describe('why the commander did not come up — said as it is', () => {
  it('an unconfirmed operation names the Settings screen; a quota wall is called a usage limit; anything else is quoted', () => {
    const guard = 'A previous tool operation has an unconfirmed result. Inspect the saved project work before resuming automatic work.'
    // The launch's own words win over a wall in the table: on 2026-11-24 the
    // journal said "no usable tier" for eight hours while this was the cause.
    expect(commanderFailureWords(guard, 'all-cooling')).toContain(OWNER_REVIEW_HOLD_HINT)
    expect(commanderFailureWords(guard, 'all-cooling')).not.toContain('上限')
    expect(commanderFailureWords(undefined, 'all-cooling')).toContain('使用量の上限')
    expect(commanderFailureWords(undefined, 'none-allowed')).toContain('使用可能モデル')
    // A raw English error stays in the journal; the owner gets plain words (review 2026-11-26).
    expect(commanderFailureWords('claude CLI is signed out', null)).not.toContain('claude CLI is signed out')
    expect(commanderFailureWords('claude CLI is signed out', null)).toContain('エンジンの記録')
    expect(commanderFailureWords('オーナーのアカウントが確かめられません', null)).toContain('オーナーのアカウントが確かめられません')
  })

  it("git's own output never reaches the owner's notice; a plain reason does", () => {
    const git = "createSwarmWorktree: fatal: invalid reference: main\nhint: use 'git branch -a'"
    expect(dispatchFailureNotice('card a', git)).not.toContain('fatal')
    expect(dispatchFailureNotice('card a', git)).toContain('エンジンの記録')
    expect(automationStartNotice('EACCES: permission denied')).not.toContain('EACCES')
    expect(dispatchFailureNotice('card a', 'createSwarmWorktree: 作業場所を作れませんでした')).toContain('理由: 作業場所を作れませんでした')
  })
})
