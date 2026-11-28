import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { dirname } from 'path'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  resumeEngines,
  retryBootResumes,
  reconcileAutomationOrchestrators,
  getOrchestratorState,
  defaultDeps,
  __resetOrchestratorForTests,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
  OWNER_REVIEW_HOLD_HINT,
  BOOT_HOLD_ANNOUNCE_MS,
  BOOT_OWNER_HOLD_RETRY_MS,
} from './swarmOrchestrator'
import { recordSwarmSession } from './swarmSessions'
import { sessionJsonlPath } from './transcript'
import type { AppNotification } from '../types'
import { writeEngineIntent } from './swarmEnginePersistence'
import { settingsFile, canvasFile, engineBootsFile } from './paths'
import { assertNoUncertainRuntimeActions } from './runtimeActionReceipts'
import { listEscalations } from './swarmEscalations'
import { engineJournalPath } from './engineJournal'
import { AUTOMATION_START_TELL_MS } from './swarmOrchestrator'
import { CHATGPT_REVIEW_HOLD_HINT } from './savedWorkHold'

// 2026-11-17 adversarial review M1: inside the Ground frame the policy loop's
// reconcile used to start an engine the boot resume was still HOLDING (saved
// work awaiting review) — skipping the hold, the roster reconcile and --resume
// adoption. The boot resume owns that start until its hold clears.
vi.setConfig({ testTimeout: 60_000 })
// gate.access = the owner-account check (hasChatGptAccess); gate.owner = the
// signed-in owner's key, null = not known yet (lookup offline / signed out).
const gate = vi.hoisted(() => ({ access: true, owner: null as string | null }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => gate.access }))
// Transcripts go to a temp dir, never the real ~/.claude/projects.
const claudeRoot = vi.hoisted(() => ({ dir: '' }))
vi.mock('./transcript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transcript')>()),
  sessionJsonlPath: (cwd: string, sessionId: string) => join(claudeRoot.dir, encodeURIComponent(cwd), `${sessionId}.jsonl`),
}))
vi.mock('./runtimeOwner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtimeOwner')>()),
  runtimeOwnerKey: async () => { if (!gate.owner) throw new Error('Owner sign-in is required.'); return gate.owner },
}))
vi.mock('./claudePreflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudePreflight')>()),
  claudeRunPreflight: async () => ({ ok: true }),
}))

const home = () => process.env.OPENGROUND_HOME ?? ''
const notificationsPath = () => join(home(), 'swarm-notifications.json')
const receiptsPath = () => join(home(), 'runtime', 'receipts-v2.json')
const notices = async (): Promise<AppNotification[]> => {
  try { return (JSON.parse(await readFile(notificationsPath(), 'utf8')) as { items: AppNotification[] }).items } catch { return [] }
}
const heldNotice = async () => (await notices()).filter((n) => n.kind === 'swarm-fatal' && n.swarmFatal?.event === 'engine-resume-suppressed' && n.swarmFatal?.projectPath === proj)
const backNotice = async () => (await notices()).filter((n) => n.kind === 'swarm-info' && n.swarmInfo?.event === 'engine-resumed' && n.swarmInfo?.detail?.includes('待っていた'))
const OWNER = 'a'.repeat(64)
/** One saved receipt in the shape conversationReceipts.ts persists. */
const seedReceipt = async (owner: string, body: Record<string, unknown>, state = 'uncertain') => {
  const rid = 'r-' + randomUUID()
  const key = createHash('sha256').update(JSON.stringify([owner, id, rid])).digest('hex')
  const at = '2026-11-09T09:06:14.575Z'
  await mkdir(dirname(receiptsPath()), { recursive: true })
  await writeFile(receiptsPath(), JSON.stringify({ version: 1, contexts: {}, acceptedDrafts: {}, receipts: { [key]: {
    id: rid, scope: id, owner, hash: 'c'.repeat(64), state, acceptedAt: at, updatedAt: at, epoch: 0, body,
  } } }))
}

const safeDeps = (): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({ ...defaultDeps(), fetchTasks: async () => [] })
let proj = ''
let id = ''

beforeAll(async () => { claudeRoot.dir = await mkdtemp(join(tmpdir(), 'og-bootframe-claude-')) })
afterAll(async () => { await rm(claudeRoot.dir, { recursive: true, force: true }) })
beforeEach(async () => {
  __resetOrchestratorForTests()
  gate.access = true
  gate.owner = null
  await rm(notificationsPath(), { force: true })
  await rm(receiptsPath(), { force: true })
  proj = await mkdtemp(join(tmpdir(), 'og-bootframe-'))
  id = randomUUID()
  // The owner's machine runs Japanese (Settings.language; unset ⇒ English).
  await writeFile(settingsFile(), JSON.stringify({ language: 'ja', projects: [{ id, path: proj, addedAt: '2026-01-01T00:00:00.000Z' }] }))
  await writeFile(canvasFile(), JSON.stringify({
    positions: { [id]: { x: 10, y: 10 } }, viewport: { x: 0, y: 0, zoom: 1 },
    automation: { version: 1, enabled: true, frameId: 'auto', revision: 1 },
    elements: [{ id: 'auto', type: 'frame', groundRole: 'automation', x: 0, y: 0, width: 500, height: 400, text: 'Automatic operation' }],
  }))
  await rm(engineBootsFile(), { force: true })
})
afterEach(async () => {
  __resetOrchestratorForTests()
  await rm(receiptsPath(), { force: true })
  await rm(proj, { recursive: true, force: true })
  await writeFile(settingsFile(), JSON.stringify({ projects: [] }))
  await rm(canvasFile(), { force: true })
})

describe('boot resume inside the Ground frame (2026-11-17)', () => {
  it('a held engine is not started by the frame reconcile; it comes back through the boot resume once the hold clears', async () => {
    let reviewed = false
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false })
    await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [proj],
      runtimeHold: async () => (reviewed ? null : 'unconfirmed result'),
    })
    expect((await getOrchestratorState(proj, safeDeps())).running).toBe(false)
    await reconcileAutomationOrchestrators(safeDeps())
    expect((await getOrchestratorState(proj, safeDeps())).running, 'the frame reconcile must not bypass the hold').toBe(false)
    reviewed = true
    await retryBootResumes()
    const state = await getOrchestratorState(proj, safeDeps())
    expect(state.running).toBe(true)
    expect(state.autonomyResumed, 'it came back through the boot resume path').toBe(true)
  })
})

describe('boot resume follow-ups (2026-11-17, 4d9b7d9c reviews)', () => {
  it('owner-account check closed at boot, open later ⇒ president and autopilot come back; the blip is never announced', async () => {
    gate.access = false
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false, supplyDesired: true })
    const supplies: string[] = []
    const spawnSupply = async ({ projectPath }: { projectPath: string }) => { supplies.push(projectPath) }
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj], spawnSupply })
    expect(supplies).toEqual([])
    expect((await getOrchestratorState(proj, safeDeps())).running).toBe(false)
    gate.access = true
    await retryBootResumes()
    expect(supplies, 'the president comes back once the check answers').toEqual([proj])
    expect((await getOrchestratorState(proj, safeDeps())).running, 'and so does the autopilot').toBe(true)
    expect(await heldNotice(), 'a hold that cleared on its first retry is not an incident').toEqual([])
    expect(await backNotice(), 'nor is its recovery').toEqual([])
  })

  it('a hold is announced once it has lasted 15 s — not on the retry right after boot — and its recovery too', async () => {
    gate.access = false
    let now = 1_000_000
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj], clock: () => now })
    await retryBootResumes() // the policy loop's first tick, milliseconds after boot
    now += BOOT_HOLD_ANNOUNCE_MS - 1
    await retryBootResumes()
    expect(await heldNotice(), 'a few seconds of an offline check is not an incident').toEqual([])
    now += 1
    await retryBootResumes()
    await retryBootResumes()
    expect(await heldNotice(), 'announced once it lasted, once').toHaveLength(1)
    gate.access = true
    await retryBootResumes()
    expect((await getOrchestratorState(proj, safeDeps())).running).toBe(true)
    expect(await backNotice()).toHaveLength(1)
  })

  it('a hold only the owner can clear is retried on an owner review or slowly — not every 15 s — and is announced at once', async () => {
    let reviewed = false
    let checks = 0
    const now = 1_000_000
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false })
    await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [proj],
      clock: () => now,
      runtimeHold: async () => { checks++; return reviewed ? null : `saved work (${OWNER_REVIEW_HOLD_HINT})` },
    })
    const afterBoot = checks
    expect(afterBoot).toBeGreaterThan(0)
    expect(await heldNotice(), 'nothing a timer could clear, so said at once').toHaveLength(1)
    await retryBootResumes()
    await retryBootResumes()
    expect(checks, 'the 15 s policy-loop retry skips it').toBe(afterBoot)
    reviewed = true
    await retryBootResumes({ ownerReview: true })
    expect((await getOrchestratorState(proj, safeDeps())).running).toBe(true)
  })

  // Review R2 S-4: a held ChatGPT desk conversation names the Settings door (it
  // raises no question in the bar) — and is still a hold only the owner clears:
  // off the 15 s timer, announced at once, without "launch it by hand".
  it('a ChatGPT conversation held for the owner\'s review in Settings is an owner-only hold too', async () => {
    let checks = 0
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false })
    await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [proj],
      clock: () => 1_000_000,
      runtimeHold: async () => { checks++; return `saved ChatGPT conversation (${CHATGPT_REVIEW_HOLD_HINT})` },
    })
    const afterBoot = checks
    const told = await heldNotice()
    expect(told, 'said at once').toHaveLength(1)
    expect(told[0].swarmFatal?.detail).not.toContain('手動で立ち上げても構いません')
    await retryBootResumes()
    expect(checks, 'the 15 s policy-loop retry skips it').toBe(afterBoot)
  })

  it('a later few-second blip is not announced at once on the strength of an older, different hold', async () => {
    let now = 1_000_000
    await writeEngineIntent(proj, { desiredRunning: false, overseer: false, supplyDesired: true })
    await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [proj],
      clock: () => now,
      spawnSupply: async () => {},
      runtimeHold: async () => `saved work (${OWNER_REVIEW_HOLD_HINT})`,
    })
    const before = (await heldNotice()).length // the owner-only hold, said at once
    now += 10 * 60_000 // ten minutes later the slow retry runs — during a blip
    gate.access = false
    await retryBootResumes()
    expect((await heldNotice()).length, 'the blip has lasted 0 s, not 10 min').toBe(before)
    now += BOOT_HOLD_ANNOUNCE_MS
    await retryBootResumes({ ownerReview: true })
    expect((await heldNotice()).length, 'a blip that does last is still said').toBe(before + 1)
  })

  it('an owner-only hold that clears by itself (no review) still comes back, on the slow retry', async () => {
    let cleared = false
    let now = 1_000_000
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false })
    await resumeEngines(safeDeps(), {
      listProjectPaths: async () => [proj],
      clock: () => now,
      runtimeHold: async () => (cleared ? null : `saved work (${OWNER_REVIEW_HOLD_HINT})`),
    })
    cleared = true // e.g. the orphaned claude finished its call — nothing re-notifies
    now += BOOT_OWNER_HOLD_RETRY_MS - 1
    await retryBootResumes()
    expect((await getOrchestratorState(proj, safeDeps())).running).toBe(false)
    now += 1
    await retryBootResumes()
    expect((await getOrchestratorState(proj, safeDeps())).running).toBe(true)
  })

  it('a project unregistered after boot is dropped, not retried forever', async () => {
    let registered = [proj]
    let checks = 0
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false })
    await resumeEngines(safeDeps(), {
      listProjectPaths: async () => registered,
      runtimeHold: async () => { checks++; return 'transient' },
    })
    registered = ['/some/other/project']
    const before = checks
    await retryBootResumes()
    registered = [proj]
    await retryBootResumes()
    expect(checks).toBe(before)
  })

  it('an unreadable settings.json (reads as no projects) drops nothing', async () => {
    let registered = [proj]
    let checks = 0
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => registered, runtimeHold: async () => { checks++; return 'transient' } })
    registered = []
    const before = checks
    await retryBootResumes()
    expect(checks).toBeGreaterThan(before)
  })

  it('an unsettled president instruction holds the PRESIDENT — even before the owner is known', async () => {
    await writeEngineIntent(proj, { desiredRunning: false, overseer: false, supplyDesired: true })
    await seedReceipt(OWNER, { kind: 'president-input', sessionId: 'president-session' })
    const supplies: string[] = []
    const spawnSupply = async ({ projectPath }: { projectPath: string }) => { supplies.push(projectPath) }
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj], spawnSupply })
    expect(supplies, 'owner not known yet: fail closed').toEqual([])
    gate.owner = OWNER
    await retryBootResumes({ ownerReview: true })
    expect(supplies, 'the owner can see and clear it, so it holds').toEqual([])
    expect((await heldNotice()).at(-1)?.swarmFatal?.detail).toContain('社長')
  })

  it('an unfinished president conversation holds the PRESIDENT', async () => {
    gate.owner = OWNER
    const sessionId = randomUUID()
    await writeEngineIntent(proj, { desiredRunning: false, overseer: false, supplyDesired: true })
    await recordSwarmSession(proj, 'supply', sessionId)
    const file = sessionJsonlPath(proj, sessionId)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_cut', name: 'Bash', input: {} }] } }) + '\n')
    const supplies: string[] = []
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj], spawnSupply: async ({ projectPath }) => { supplies.push(projectPath) } })
    expect(supplies).toEqual([])
    expect((await heldNotice()).at(-1)?.swarmFatal?.detail).toContain('社長')
    await rm(file, { force: true })
  })

  it('a transcript that cannot be read yet is a timer-retried hold, not one waiting for the owner', async () => {
    gate.owner = OWNER
    const sessionId = randomUUID()
    await writeEngineIntent(proj, { desiredRunning: false, overseer: false, supplyDesired: true })
    await recordSwarmSession(proj, 'supply', sessionId)
    const file = sessionJsonlPath(proj, sessionId)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n')
    await chmod(file, 0o000)
    const supplies: string[] = []
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj], spawnSupply: async ({ projectPath }) => { supplies.push(projectPath) } })
    expect(supplies).toEqual([])
    await chmod(file, 0o644)
    await retryBootResumes()
    expect(supplies, 'the 15 s timer brings it back once the read works').toEqual([proj])
    await rm(file, { force: true })
  })

  // These two pinned the owner scoping on the COMMANDER's boot resume until
  // 2026-11-28, when the commander stopped being revived at boot (R-D3a — it is
  // started by its first need instead). The same scoping guards the engine's
  // project-wide hold, so they now pin it there.
  it("another account's unconfirmed result does not hold this owner's autopilot (会話の復旧 could never show it)", async () => {
    gate.owner = OWNER
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false })
    await seedReceipt('f'.repeat(64), { kind: 'runtime-tool', provider: 'claude', sessionId: 'old-commander', tool: 'Bash' })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })
    expect((await getOrchestratorState(proj, safeDeps())).running).toBe(true)
  })

  // R-B3 (AUTONOMY-SPEC, owner decision 2026-11-28 §7-1 = A) together with R-D3a.
  // These used to pin "this owner's own unconfirmed result still holds the
  // commander" and, after the commander stopped being revived at boot, "...still
  // holds the autopilot": one cut-off call kept the project down until the owner
  // found the Settings screen. Only the conversation that issued a call can run it
  // again, so nothing else waits for it: the autopilot resumes, the commander is
  // not revived at boot (it opens a FRESH conversation on its first need —
  // swarmManager.launchNewDesk), and the owner gets ONE question in the inbox at
  // boot, even when no desk and no autopilot comes back.
  const holdQuestions = async () =>
    (await listEscalations({ projectPath: proj, status: 'open' })).filter((e) => e.receiptKey.startsWith('hold:r-'))

  it("this owner's unconfirmed result on the commander's conversation does not hold the autopilot", async () => {
    gate.owner = OWNER
    await writeEngineIntent(proj, { desiredRunning: true, overseer: false, managerDesired: true })
    await recordSwarmSession(proj, 'manager', 'old-commander')
    await seedReceipt(OWNER, { kind: 'runtime-tool', provider: 'claude', sessionId: 'old-commander', tool: 'Bash' })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })
    expect((await getOrchestratorState(proj, safeDeps())).running).toBe(true)
    expect(await holdQuestions()).toHaveLength(1)
  })

  it('with nothing coming back at boot (no frame, autopilot off), the commander\'s held operation is still asked about once', async () => {
    gate.owner = OWNER
    // No automation frame at all: the engine path returns before it asks, and no
    // president is wished for — only the commander's saved conversation is left.
    await writeFile(canvasFile(), JSON.stringify({ positions: { [id]: { x: 10, y: 10 } }, viewport: { x: 0, y: 0, zoom: 1 } }))
    await writeEngineIntent(proj, { desiredRunning: false, overseer: false, managerDesired: true })
    await recordSwarmSession(proj, 'manager', 'old-commander')
    await seedReceipt(OWNER, { kind: 'runtime-tool', provider: 'claude', sessionId: 'old-commander', tool: 'Bash' })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })
    const open = await holdQuestions()
    expect(open).toHaveLength(1)
    expect(open[0].plainQuestion).toContain('マネージャー')
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })
    expect(await holdQuestions()).toHaveLength(1)
  })
})

describe('the engine asks the launch guard its own question (2026-11-23)', () => {
  it('a saved unconfirmed result holds its own conversation only; a signed-out owner holds; the review releases — exactly when a launch would fail', async () => {
    const holds = defaultDeps().savedWorkHold!
    gate.owner = OWNER
    await seedReceipt(OWNER, { kind: 'runtime-tool', provider: 'claude', sessionId: 'gone-worker', tool: 'Bash' })
    expect((await holds(proj)).map((op) => op.sessionId)).toEqual(['gone-worker'])
    await expect(assertNoUncertainRuntimeActions(proj, false, 'gone-worker')).rejects.toThrow(/unconfirmed result/)
    // R-B3: another conversation in the same project launches.
    await expect(assertNoUncertainRuntimeActions(proj, false, 'another-worker')).resolves.toBeUndefined()
    gate.owner = null
    await expect(holds(proj)).rejects.toThrow(/sign-in/)
    await expect(assertNoUncertainRuntimeActions(proj, false, 'another-worker')).rejects.toThrow(/sign-in/)
    gate.owner = OWNER
    await rm(receiptsPath(), { force: true })
    expect(await holds(proj)).toEqual([])
    await expect(assertNoUncertainRuntimeActions(proj, false, 'gone-worker')).resolves.toBeUndefined()
  })
})

describe('a Ground-frame project whose automatic start keeps failing is told once (2026-11-23)', () => {
  afterEach(() => { vi.useRealTimers() })
  it('the reason reaches the engine record and the president after a minute — once — instead of being dropped', async () => {
    gate.access = false // the owner account cannot be confirmed: the start throws
    const notify = vi.fn()
    const deps = { ...safeDeps(), notify }
    const t0 = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t0)
    expect((await reconcileAutomationOrchestrators(deps)).failures).toHaveLength(1)
    expect(notify).not.toHaveBeenCalled() // a switch that settles in seconds is not news
    vi.setSystemTime(t0 + AUTOMATION_START_TELL_MS + 1000)
    await reconcileAutomationOrchestrators(deps)
    vi.setSystemTime(t0 + 2 * AUTOMATION_START_TELL_MS)
    await reconcileAutomationOrchestrators(deps)
    const told = notify.mock.calls.map((c) => c[0]).filter((n) => n.event === 'automation-held')
    expect(told).toHaveLength(1)
    expect(told[0].projectPath).toBe(proj)
    expect(told[0].detail).toContain('作業を自動で始められない状態が続いています')
    expect(told[0].detail).toContain('オーナーのアカウントが確かめられません')
    await vi.waitFor(async () => expect(await readFile(await engineJournalPath(proj), 'utf8')).toContain('automatic start keeps failing'))
  })
})
