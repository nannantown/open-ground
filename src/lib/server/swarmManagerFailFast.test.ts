// @vitest-environment node
// Every new manager uses SDK, including installs with legacy PTY settings.
// Failures remain visible and must never open a terminal fallback.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  launchClaude: vi.fn(),
  listLiveDesksIn: vi.fn(() => [] as unknown[]),
  onTerminalExit: vi.fn((_id: string, _onExit: () => void) => () => {}),
  getTerminalScreen: vi.fn((_id: string): string | null => null),
  isTerminalProcessAlive: vi.fn((_id: string) => true),
  resolveSwarmSession: vi.fn(async () => ({ agentSessionId: 'sid-1', resume: false })),
  recordSwarmSession: vi.fn(async () => {}),
  forgetSwarmSessionIf: vi.fn(async () => false),
  installOgManageSkill: vi.fn(async () => ({ outcome: 'installed' as const, path: '/tmp/skill' })),
  resolveSwarmModelEffortProbed: vi.fn(async () => ({ model: 'opus', effort: 'max' as const })),
  resolveSwarmRemoteName: vi.fn(async () => 'manager'),
  sdkManagerPreflight: vi.fn(),
  sdkManagerLaunchPlan: vi.fn(() => ({ options: {}, initialPrompt: '/og-manage', warnings: [] })),
  spawnSdkSession: vi.fn(),
}))

vi.mock('./claudeTerminal', () => ({ launchClaude: mocks.launchClaude }))
vi.mock('./terminal', () => ({
  listLiveDesksIn: mocks.listLiveDesksIn,
  onTerminalExit: mocks.onTerminalExit,
  getTerminalScreen: mocks.getTerminalScreen,
  isTerminalProcessAlive: mocks.isTerminalProcessAlive,
}))
vi.mock('./swarmSessions', () => ({
  resolveSwarmSession: mocks.resolveSwarmSession,
  recordSwarmSession: mocks.recordSwarmSession,
  forgetSwarmSessionIf: mocks.forgetSwarmSessionIf,
}))
vi.mock('./ogManageSkill', () => ({ installOgManageSkill: mocks.installOgManageSkill }))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: mocks.resolveSwarmModelEffortProbed,
  resolveSwarmRemoteName: mocks.resolveSwarmRemoteName,
}))
// The REAL error class must ride through the mock: swarmManager.ts throws it
// and the assertions below catch it by identity.
vi.mock('./swarmManagerSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmManagerSdk')>()),
  sdkManagerPreflight: mocks.sdkManagerPreflight,
  sdkManagerLaunchPlan: mocks.sdkManagerLaunchPlan,
}))
vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: mocks.spawnSdkSession,
}))

import { spawnSwarmManager } from './swarmManager'
import { SdkManagerUnavailableError } from './swarmManagerSdk'
import { setSettings } from './store'

const PROJ = '/repo/alpha'

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.listLiveDesksIn.mockReturnValue([])
  mocks.onTerminalExit.mockImplementation(() => () => {})
  mocks.isTerminalProcessAlive.mockReturnValue(true)
  mocks.getTerminalScreen.mockReturnValue(null)
  mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'sid-1', resume: false })
  mocks.resolveSwarmModelEffortProbed.mockResolvedValue({ model: 'opus', effort: 'max' })
  mocks.resolveSwarmRemoteName.mockResolvedValue('manager')
  mocks.installOgManageSkill.mockResolvedValue({ outcome: 'installed', path: '/tmp/skill' })
  mocks.recordSwarmSession.mockResolvedValue(undefined)
  mocks.sdkManagerLaunchPlan.mockReturnValue({ options: {}, initialPrompt: '/og-manage', warnings: [] })
  mocks.launchClaude.mockImplementation(() => {
    throw new Error(
      'launchClaude must never be reached for an SDK-only manager',
    )
  })
})

describe('commander SDK fail-fast — an SDK dial never seats a PTY desk', () => {
  it('a failed preflight THROWS the typed error naming the cause — no desk, no PTY', async () => {
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: false,
      problems: ['claude not found on PATH'],
      claudeBin: null,
      cliVersion: null,
    })

    await expect(spawnSwarmManager({ projectPath: PROJ })).rejects.toThrow(
      SdkManagerUnavailableError,
    )
    await expect(spawnSwarmManager({ projectPath: PROJ })).rejects.toThrow(
      /claude not found on PATH/,
    )
    expect(mocks.spawnSdkSession).not.toHaveBeenCalled()
    expect(mocks.launchClaude).not.toHaveBeenCalled()
    // No conversation id is persisted for a desk that never existed.
    expect(mocks.recordSwarmSession).not.toHaveBeenCalled()
  })

  it('a spawn that throws propagates as the typed error with its message', async () => {
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: true,
      problems: [],
      claudeBin: '/usr/local/bin/claude',
      cliVersion: '2.1.220',
    })
    mocks.spawnSdkSession.mockImplementation(() => {
      throw new Error('query() blew up')
    })

    await expect(spawnSwarmManager({ projectPath: PROJ })).rejects.toThrow(
      SdkManagerUnavailableError,
    )
    await expect(spawnSwarmManager({ projectPath: PROJ })).rejects.toThrow(/query\(\) blew up/)
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })

  it("a session that dies at start THROWS with the SDK's own exit reason", async () => {
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: true,
      problems: [],
      claudeBin: '/usr/local/bin/claude',
      cliVersion: '2.1.220',
    })
    mocks.spawnSdkSession.mockReturnValue({
      id: 'sdk-dead',
      status: 'failed',
      exitReason: 'error: ENOENT',
    })

    await expect(spawnSwarmManager({ projectPath: PROJ })).rejects.toThrow(/ENOENT/)
    // The SDK spawn really was attempted — this is a failure, not a skip.
    expect(mocks.spawnSdkSession).toHaveBeenCalledTimes(1)
    expect(mocks.launchClaude).not.toHaveBeenCalled()
    // A dead session's conversation id is never persisted.
    expect(mocks.recordSwarmSession).not.toHaveBeenCalled()
  })

  it('a SUCCESSFUL SDK desk is returned whole — the identity invariant holds', async () => {
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: true,
      problems: [],
      claudeBin: '/usr/local/bin/claude',
      cliVersion: '2.1.220',
    })
    mocks.spawnSdkSession.mockReturnValue({ id: 'sdk-live', status: 'working' })

    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(r.runtime).toBe('sdk')
    expect(r.sdkSessionId).toBe('sdk-live')
    expect(r.terminalId).toBe('') // identity invariant
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })

  it('a legacy PTY preference cannot change the SDK-only launch path', async () => {
    await setSettings({ swarmManagerRuntime: { mode: 'pty' } } as never)
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: true, problems: [], claudeBin: '/usr/local/bin/claude', cliVersion: '2.1.220',
    })
    mocks.spawnSdkSession.mockReturnValue({ id: 'sdk-live', status: 'working' })

    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(r.runtime).toBe('sdk')
    expect(r.sdkSessionId).toBe('sdk-live')
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })
})
