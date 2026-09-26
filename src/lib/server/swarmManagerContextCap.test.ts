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
  getDeskContextCapTokens: vi.fn(async () => 300_000),
  logToEngine: vi.fn((_p: string, _l: string, _m: string) => {}),
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
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  getDeskContextCapTokens: mocks.getDeskContextCapTokens,
}))
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
import { sdkManagerLaunchPlan } from './swarmManagerSdk'

const PROJ = '/repo/alpha'
type Launched = { agentSessionId: string; options: { resume?: string }; initialPrompt?: string }
const launched = (): Launched => mocks.spawnSdkSession.mock.calls[0][0] as Launched

beforeEach(() => {
  vi.clearAllMocks()
  mocks.spawnSdkSession.mockImplementation(() => ({ id: 'sdk-1', status: 'working' }))
  mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'old-sid', resume: true })
  mocks.getDeskContextCapTokens.mockResolvedValue(300_000)
})

describe('commander spawn × desk context cap', () => {
  it('UNDER the cap ⇒ resumes the persisted conversation exactly as before', async () => {
    mocks.sessionContextTokens.mockResolvedValue(120_000)
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

  it('cap 0 (off) ⇒ resumes even a huge conversation', async () => {
    mocks.getDeskContextCapTokens.mockResolvedValue(0)
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
