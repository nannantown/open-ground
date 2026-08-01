// @vitest-environment node
//
// The commander's SDK→PTY degrade must be VISIBLE.
//
// Degrading is the right behaviour — "this project's commander is a PTY" beats
// "this project has no commander", and launchSdkDesk is written never to throw
// for a preflight reason. The defect this file pins is the other half: for the
// first two releases the REASON went only to `console.warn`, inside a server the
// packaged app forks, whose stdout nobody reads. From the owner's chair that is
// indistinguishable from a switch that does not work — they turn on "Commander on
// the Agent SDK", get a terminal, and nothing on screen explains why.
//
// So the contract is: dial 'sdk' + an SDK path that cannot be established ⇒ a
// working PTY desk AND a non-empty `fellBackBecause` in the response, which the
// Swarm tab renders. Every side effect is mocked — no PTY, no claude, no SDK
// session — and HOME is the suite's tmp dir, so the dial write never touches the
// real ~/.openground.

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
vi.mock('./swarmManagerSdk', () => ({
  sdkManagerPreflight: mocks.sdkManagerPreflight,
  sdkManagerLaunchPlan: mocks.sdkManagerLaunchPlan,
}))
vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: mocks.spawnSdkSession,
}))

import { spawnSwarmManager, MANAGER_DESK_LABEL } from './swarmManager'
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
  mocks.launchClaude.mockImplementation(() => ({ terminalId: 'term-1' }))
  // The dial the whole file is about. Written to the ISOLATED tmp home.
  await setSettings({ swarmManagerRuntime: { mode: 'sdk' } })
})

describe('commander SDK→PTY degrade is reported, not just logged', () => {
  it('a failed preflight still seats a desk AND names the reason', async () => {
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: false,
      problems: ['claude not found on PATH'],
      claudeBin: null,
      cliVersion: null,
    })

    const r = await spawnSwarmManager({ projectPath: PROJ })

    // Still a working desk — the degrade itself is correct behaviour.
    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    expect(r.runtime).toBe('pty')
    expect(r.terminalId).toBe('term-1')
    // …and the owner can find out WHY, which is the whole point.
    expect(r.fellBackBecause).toBeTruthy()
    expect(r.fellBackBecause).toContain('claude not found on PATH')
    expect(mocks.spawnSdkSession).not.toHaveBeenCalled()
  })

  it('a spawn that throws is reported with its message, not swallowed', async () => {
    mocks.sdkManagerPreflight.mockReturnValue({
      ok: true,
      problems: [],
      claudeBin: '/usr/local/bin/claude',
      cliVersion: '2.1.220',
    })
    mocks.spawnSdkSession.mockImplementation(() => {
      throw new Error('query() blew up')
    })

    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(r.runtime).toBe('pty')
    expect(r.fellBackBecause).toContain('query() blew up')
  })

  it("a session that dies at start is reported with the SDK's own exit reason", async () => {
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

    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(r.runtime).toBe('pty')
    expect(r.fellBackBecause).toContain('ENOENT')
    // The comment here used to claim "a dead session must NOT be recorded", then
    // assert a call that ALWAYS happens on both paths — an assertion that could
    // not fail either way (flagged 2026-07-31). What actually matters is that the
    // desk we hand back is the PTY one and it is addressable: recordSwarmSession
    // persists the CONVERSATION id (shared by both runtimes), so it is not the
    // observable that separates them.
    expect(r.terminalId).toBe('term-1')
    expect(r.sdkSessionId).toBeUndefined()
    // …and the dead SDK session did not become this project's desk.
    expect(mocks.spawnSdkSession).toHaveBeenCalledTimes(1)
  })

  it('a SUCCESSFUL SDK desk carries no reason (the field means something)', async () => {
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
    expect(r.fellBackBecause).toBeUndefined()
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })

  it('with the dial OFF there is no reason to report — an ordinary PTY desk', async () => {
    await setSettings({ swarmManagerRuntime: { mode: 'pty' } })

    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(r.runtime).toBe('pty')
    expect(r.fellBackBecause).toBeUndefined()
    // The SDK path is not even consulted when the dial is off.
    expect(mocks.sdkManagerPreflight).not.toHaveBeenCalled()
    expect(MANAGER_DESK_LABEL).toBeTruthy()
  })
})
