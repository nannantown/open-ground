// @vitest-environment node
// The real manager launch plan must preserve context-cap and resume behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })

const mocks = vi.hoisted(() => ({
  spawnSdkSession: vi.fn(),
  listLiveDesksIn: vi.fn((_cwd: string, _label: string) => [] as unknown[]),
  resolveSwarmSession: vi.fn(),
  recordSwarmSession: vi.fn(async (_p: string, _r: string, _sid: string) => {}),
  sessionContextTokens: vi.fn(async (_sid: string): Promise<number | null> => null),
  /** Settings.deskContextCapTokens as the commander cap reads it (undefined = not set). */
  deskCapSetting: { value: undefined as number | undefined },
  logToEngine: vi.fn((_p: string, _l: string, _m: string) => {}),
  savedWorkHolds: vi.fn(async (_p: string, _o?: { sessionId?: string }): Promise<import('./savedWorkHold').HeldOperation[]> => []),
  askAboutHeldOperation: vi.fn(async () => ({ deduped: false })),
  /** The owner already answered this native hold (the review marker exists). */
  nativeReviewed: vi.fn(async (_projectId: string, _cwd: string, _sid: string): Promise<{ note: string } | undefined> => undefined),
}))
vi.mock('./swarmNativeRecovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmNativeRecovery')>()),
  nativeConversationRecoveryReview: mocks.nativeReviewed,
}))
vi.mock('./projectDataPath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./projectDataPath')>()),
  projectUUIDFromPath: async () => 'project-alpha',
}))
vi.mock('./savedWorkHold', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./savedWorkHold')>()),
  savedWorkHolds: mocks.savedWorkHolds,
  askAboutHeldOperation: mocks.askAboutHeldOperation,
}))

vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: mocks.spawnSdkSession,
}))
vi.mock('./swarmManagerSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmManagerSdk')>()),
  sdkManagerPreflight: () => ({ ok: true, claudeBin: '/bin/claude', problems: [] }),
}))
vi.mock('./terminal', () => ({
  listLiveDesksIn: mocks.listLiveDesksIn,
  onTerminalExit: vi.fn(() => () => {}),
  getTerminalScreen: vi.fn(() => null),
  isTerminalProcessAlive: vi.fn(() => true),
}))
vi.mock('./swarmSessions', () => ({
  resolveSwarmSession: mocks.resolveSwarmSession,
  recordSwarmSession: mocks.recordSwarmSession,
  forgetSwarmSessionIf: vi.fn(async () => false),
}))
vi.mock('./ogManageSkill', () => ({
  installOgManageSkill: vi.fn(async () => ({ outcome: 'installed' as const, path: '/tmp/skill' })),
}))
// The commander cap (deskContextCap.managerContextCapTokens) reads Settings directly:
// MANAGER_CONTEXT_CAP (120,000) unless the owner set deskContextCapTokens (2026-11-28).
vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>()
  return {
    ...actual,
    getSettings: async () => ({ ...(await actual.getSettings()), deskContextCapTokens: mocks.deskCapSetting.value }),
  }
})
vi.mock('./claudeUsage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeUsage')>()),
  sessionContextTokens: mocks.sessionContextTokens,
}))
vi.mock('./engineLogSink', () => ({ logToEngine: mocks.logToEngine, registerEngineLogSink: vi.fn() }))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: vi.fn(async () => ({ model: 'opus', effort: 'max' })),
  resolveSwarmRemoteName: vi.fn(async () => 'manager'),
}))

import { spawnSwarmManager, MANAGER_RESUME_INJECTION, MANAGER_INJECTION } from './swarmManager'
import { NativeUnfinishedToolsError } from './swarmNativeTranscript'
import { sdkManagerLaunchPlan } from './swarmManagerSdk'

const PROJ = '/repo/alpha'
type Launched = { agentSessionId: string; options: { resume?: string }; initialPrompt?: string }
const launched = (): Launched => mocks.spawnSdkSession.mock.calls[0][0] as Launched

beforeEach(() => {
  vi.clearAllMocks()
  mocks.spawnSdkSession.mockImplementation(() => ({ id: 'sdk-1', status: 'working' }))
  mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'old-sid', resume: true })
  mocks.deskCapSetting.value = undefined
  mocks.savedWorkHolds.mockResolvedValue([])
})

// R-B3 (docs/AUTONOMY-SPEC.md, owner decision 2026-11-28): a held commander
// conversation is never resumed. Its next launch opens a FRESH conversation
// whose opening names the unknown operation and says to look at the current
// state first — so the desk comes up instead of holding the whole project, and
// the call is never handed to anyone.
describe('a held commander conversation opens fresh, told what stopped', () => {
  it('an unconfirmed receipt on the saved conversation ⇒ not resumed; the opening names the tool, the time and its description', async () => {
    mocks.sessionContextTokens.mockResolvedValue(10_000)
    mocks.savedWorkHolds.mockResolvedValue([{ id: 'tool-c', sessionId: 'old-sid', tool: 'Bash', at: '2026-11-26T23:02:21.000Z', description: 'Run the integration tests', seat: { role: 'manager' } }])
    const res = await spawnSwarmManager({ projectPath: PROJ })
    const o = launched()
    expect(o.agentSessionId).not.toBe('old-sid')
    expect(o.options.resume).toBeUndefined()
    expect(res.resumed).toBe(false)
    expect(o.initialPrompt).toContain('NEW conversation')
    expect(o.initialPrompt).toContain('Bash')
    expect(o.initialPrompt).toContain('2026-11-26T23:02:21.000Z')
    expect(o.initialPrompt).toContain('Run the integration tests')
    expect(o.initialPrompt).toMatch(/current state/)
    // Review A S2 (2026-11-28): this branch opened a fresh desk but never asked the
    // owner — with the engine off nothing raised the R-B4 question at all.
    expect(mocks.askAboutHeldOperation).toHaveBeenCalledWith(PROJ, expect.objectContaining({ id: 'tool-c', seat: { role: 'manager' } }))
  })

  // Review A S3: the native branch asked unconditionally, so a commander that had not
  // relaunched before the owner answered raised a second question for the same stop.
  // Review R2 (A-S3 remainder): the fresh opening also carries what the owner said,
  // instead of "the owner has been asked about it".
  it('a native hold the owner already answered opens fresh WITHOUT asking again, and its opening carries the answer', async () => {
    mocks.resolveSwarmSession.mockRejectedValue(new NativeUnfinishedToolsError([{ id: 'toolu_1', name: 'Bash', at: '2026-11-26T23:01:03.000Z' }], 'old-sid'))
    mocks.nativeReviewed.mockResolvedValueOnce({ note: 'A\nThe merge did land; carry on.' })
    await spawnSwarmManager({ projectPath: PROJ })
    expect(launched().options.resume).toBeUndefined()
    expect(mocks.nativeReviewed).toHaveBeenCalledWith('project-alpha', PROJ, 'old-sid')
    expect(mocks.askAboutHeldOperation).not.toHaveBeenCalled()
    expect(launched().initialPrompt).toContain('The owner answered')
    expect(launched().initialPrompt).toContain('The merge did land; carry on.')
    expect(launched().initialPrompt).not.toContain('The owner has been asked about it')
  })

  it('a saved conversation cut mid-tool (native transcript) ⇒ a fresh desk instead of a failed launch, and the owner is asked', async () => {
    mocks.resolveSwarmSession.mockRejectedValue(new NativeUnfinishedToolsError([{ id: 'toolu_1', name: 'Bash', at: '2026-11-26T23:01:03.000Z', description: 'Check the release notes' }], 'old-sid'))
    const res = await spawnSwarmManager({ projectPath: PROJ })
    const o = launched()
    expect(o.agentSessionId).not.toBe('old-sid')
    expect(o.options.resume).toBeUndefined()
    expect(res.resumed).toBe(false)
    expect(o.initialPrompt).toContain('Check the release notes')
    expect(mocks.askAboutHeldOperation).toHaveBeenCalledWith(PROJ, expect.objectContaining({ id: 'native-old-sid', seat: { role: 'manager' } }))
  })

  it('a hold on ANOTHER conversation does not stop the commander resuming its own', async () => {
    mocks.sessionContextTokens.mockResolvedValue(10_000)
    const ops = [{ id: 'tool-w', sessionId: 'worker-sid', tool: 'Bash', at: '2026-11-26T23:02:21.000Z', seat: { role: 'worker' as const, taskId: 'w1' } }]
    // as the real reader: asked about one conversation, it returns only that one's
    mocks.savedWorkHolds.mockImplementation(async (_p: string, o?: { sessionId?: string }) => ops.filter((op) => !o?.sessionId || op.sessionId === o.sessionId))
    await spawnSwarmManager({ projectPath: PROJ })
    expect(launched().options.resume).toBe('old-sid')
  })
})

describe('commander spawn × desk context cap', () => {
  it('UNDER the cap ⇒ resumes the persisted conversation exactly as before', async () => {
    mocks.sessionContextTokens.mockResolvedValue(100_000)
    const res = await spawnSwarmManager({ projectPath: PROJ })
    expect(mocks.sessionContextTokens).toHaveBeenCalledWith('old-sid')
    expect(launched().agentSessionId).toBe('old-sid')
    expect(launched().options.resume).toBe('old-sid')
    expect(launched().initialPrompt?.startsWith(MANAGER_RESUME_INJECTION)).toBe(true)
    expect(res.resumed).toBe(true)
    expect(res.recycledFromTokens).toBeUndefined()
    expect(mocks.logToEngine).not.toHaveBeenCalled()
  })

  it('OVER the cap ⇒ a NEW conversation (not --resume), still told to re-read the world, recorded, and logged', async () => {
    mocks.sessionContextTokens.mockResolvedValue(346_076)
    const res = await spawnSwarmManager({ projectPath: PROJ })
    const o = launched()
    expect(o.agentSessionId).not.toBe('old-sid')
    expect(o.options.resume).toBeUndefined()
    // The recycled desk boots on the RESUME injection, not the bare skill — the
    // statelessness that makes recycling safe is that instruction.
    expect(o.initialPrompt?.startsWith(MANAGER_RESUME_INJECTION)).toBe(true)
    expect(res.resumed).toBe(false)
    expect(res.agentSessionId).toBe(o.agentSessionId)
    expect(res.recycledFromTokens).toBe(346_076)
    // The NEXT boot resumes the new, small conversation — not the dropped one.
    expect(mocks.recordSwarmSession).toHaveBeenCalledWith(PROJ, 'manager', o.agentSessionId)
    expect(mocks.logToEngine).toHaveBeenCalledTimes(1)
    expect(mocks.logToEngine.mock.calls[0][2]).toContain('司令官の卓を作り直した(文脈 346,076 から 0 へ)')
  })

  it('the commander default (MANAGER_CONTEXT_CAP 120,000) applies when the owner set none — 150k opens fresh', async () => {
    // 150k resumed under the shared 300,000 until 2026-11-28 (R-D3b).
    mocks.sessionContextTokens.mockResolvedValue(150_000)
    const res = await spawnSwarmManager({ projectPath: PROJ })
    expect(res.recycledFromTokens).toBe(150_000)
    expect(launched().options.resume).toBeUndefined()
  })

  it('the owner’s Settings value still overrides the commander default', async () => {
    mocks.deskCapSetting.value = 200_000
    mocks.sessionContextTokens.mockResolvedValue(150_000)
    await spawnSwarmManager({ projectPath: PROJ })
    expect(launched().options.resume).toBe('old-sid')
  })

  it('cap 0 (off) ⇒ resumes even a huge conversation', async () => {
    mocks.deskCapSetting.value = 0
    mocks.sessionContextTokens.mockResolvedValue(900_000)
    await spawnSwarmManager({ projectPath: PROJ })
    expect(launched().agentSessionId).toBe('old-sid')
    expect(launched().options.resume).toBe('old-sid')
  })

  it('a first-ever (fresh) desk is unaffected: bare skill prompt, no measurement', async () => {
    mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'brand-new', resume: false })
    await spawnSwarmManager({ projectPath: PROJ })
    expect(mocks.sessionContextTokens).not.toHaveBeenCalled()
    expect(launched().initialPrompt?.startsWith(MANAGER_INJECTION)).toBe(true)
    expect(launched().initialPrompt?.startsWith(MANAGER_RESUME_INJECTION)).toBe(false)
  })
})

describe('SDK commander plan × recycled', () => {
  it('a recycled SDK desk opens by sessionId (not resume) and boots on the RESUME injection', () => {
    const plan = sdkManagerLaunchPlan({
      projectPath: PROJ,
      agentSessionId: 'new-sid',
      resume: false,
      recycled: true,
      me: { model: 'opus' },
      claudeBin: '/usr/local/bin/claude',
      lang: 'ja',
    })
    expect(plan.options.sessionId).toBe('new-sid')
    expect(plan.options.resume).toBeUndefined()
    expect(plan.initialPrompt.startsWith(MANAGER_RESUME_INJECTION)).toBe(true)
  })
})
