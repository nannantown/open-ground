// @vitest-environment node
// Every new manager uses SDK, including installs with legacy PTY settings.
// Failures remain visible and must never open a terminal fallback.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  ownerAccess: false,
  liveWorker: false,
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
  preloadSdk: vi.fn(async () => null),
  recycleDeskSessionIfOverCap: vi.fn(async (session: { agentSessionId: string; resume: boolean }) => ({ session, recycledFromTokens: null })),
}))

vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => mocks.ownerAccess }))
vi.mock('./runtimeOwner', async original => ({
  ...(await original<typeof import('./runtimeOwner')>()),
  runtimeOwnerKey: async () => 'fixture-owner',
}))
vi.mock('./projectDataPath', async original => ({
  ...(await original<typeof import('./projectDataPath')>()),
  projectUUIDFromPath: async () => 'fixture-project',
}))
vi.mock('./liveDesks', async original => ({
  ...(await original<typeof import('./liveDesks')>()),
  isAgentConversationOccupied: () => mocks.liveWorker,
  isRecordedRuntimeHandleOccupied: (_runtime: string, handleId: string) => mocks.liveWorker && handleId === 'parallel-worker-handle',
}))
vi.mock('./deskContextCap', async original => ({
  ...(await original<typeof import('./deskContextCap')>()),
  recycleDeskSessionIfOverCap: mocks.recycleDeskSessionIfOverCap,
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
  preloadSdk: mocks.preloadSdk,
}))

import { spawnSwarmManager } from './swarmManager'
import { SdkManagerUnavailableError } from './swarmManagerSdk'
import { setSettings } from './store'
import { openGroundHome } from './paths'
import { acceptConversationReceipt, claimConversationReceipt, finishConversationReceipt, readConversationReceipt } from './conversationReceipts'

const PROJ = '/repo/alpha'

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.ownerAccess = false
  mocks.liveWorker = false
  await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true })
  mocks.listLiveDesksIn.mockReturnValue([])
  mocks.onTerminalExit.mockImplementation(() => () => {})
  mocks.isTerminalProcessAlive.mockReturnValue(true)
  mocks.getTerminalScreen.mockReturnValue(null)
  mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'sid-1', resume: false })
  mocks.resolveSwarmModelEffortProbed.mockResolvedValue({ model: 'opus', effort: 'max' })
  mocks.resolveSwarmRemoteName.mockResolvedValue('manager')
  mocks.installOgManageSkill.mockResolvedValue({ outcome: 'installed', path: '/tmp/skill' })
  mocks.recordSwarmSession.mockResolvedValue(undefined)
  mocks.recycleDeskSessionIfOverCap.mockImplementation(async session => ({ session, recycledFromTokens: null }))
  mocks.sdkManagerLaunchPlan.mockReturnValue({ options: {}, initialPrompt: '/og-manage', warnings: [] })
  mocks.launchClaude.mockImplementation(() => {
    throw new Error(
      'launchClaude must never be reached for an SDK-only manager',
    )
  })
})

describe('commander SDK fail-fast — an SDK dial never seats a PTY desk', () => {
  const savedAction = async (state: 'uncertain' | 'executing' | 'rejected') => {
    await acceptConversationReceipt('fixture-project', 'existing-tool', {
      kind: 'runtime-tool', provider: 'claude', sessionId: 'parallel-worker-session',
      toolId: 'fixture-call', tool: 'Bash', inputHash: 'fixture-input-hash',
    }, undefined, 'fixture-owner')
    await claimConversationReceipt('fixture-project', 'existing-tool', {
      sessionId: 'parallel-worker-session', handleId: 'parallel-worker-handle', runtime: 'sdk',
    }, 'fixture-owner')
    if (state !== 'executing') await finishConversationReceipt('fixture-project', 'existing-tool', state, { fixture: true }, 'fixture-owner')
  }

  it.each([false, true])('an existing unconfirmed action blocks before conversation resolution or replacement (fresh=%s)', async fresh => {
    mocks.ownerAccess = true
    await savedAction('uncertain')
    mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'previous-manager', resume: true })
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: true, problems: [], claudeBin: '/synthetic/claude', cliVersion: '2.1.220',
    })
    mocks.spawnSdkSession.mockReturnValue({ id: 'must-not-open', status: 'working' })

    await expect(spawnSwarmManager({ projectPath: PROJ, fresh })).rejects.toThrow('unconfirmed result')

    expect(mocks.resolveSwarmSession).not.toHaveBeenCalled()
    expect(mocks.recycleDeskSessionIfOverCap).not.toHaveBeenCalled()
    expect(mocks.installOgManageSkill).not.toHaveBeenCalled()
    expect(mocks.sdkManagerPreflight).not.toHaveBeenCalled()
    expect(mocks.preloadSdk).not.toHaveBeenCalled()
    expect(mocks.spawnSdkSession).not.toHaveBeenCalled()
    expect(mocks.recordSwarmSession).not.toHaveBeenCalled()
    expect(mocks.forgetSwarmSessionIf).not.toHaveBeenCalled()
    expect(await readConversationReceipt('fixture-project', 'existing-tool', 'fixture-owner')).toMatchObject({ state: 'uncertain' })
  })

  it.each(['executing', 'rejected'] as const)('a %s action with a known live or terminal result does not block the manager', async state => {
    mocks.ownerAccess = true
    mocks.liveWorker = true
    await savedAction(state)
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: true, problems: [], claudeBin: '/synthetic/claude', cliVersion: '2.1.220',
    })
    mocks.spawnSdkSession.mockReturnValue({ id: 'sdk-live', status: 'working' })

    const result = await spawnSwarmManager({ projectPath: PROJ })

    expect(result.sdkSessionId).toBe('sdk-live')
    expect(mocks.recordSwarmSession).toHaveBeenCalledWith(PROJ, 'manager', 'sid-1')
    expect(await readConversationReceipt('fixture-project', 'existing-tool', 'fixture-owner')).toMatchObject({ state })
  })

  it('keeps legacy non-owner launch access when the owner-only action guard is inapplicable', async () => {
    await savedAction('uncertain')
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: true, problems: [], claudeBin: '/synthetic/claude', cliVersion: '2.1.220',
    })
    mocks.spawnSdkSession.mockReturnValue({ id: 'sdk-legacy', status: 'working' })

    await expect(spawnSwarmManager({ projectPath: PROJ })).resolves.toMatchObject({ sdkSessionId: 'sdk-legacy' })
  })

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
