// @vitest-environment node
//
// THE COMMANDER'S SDK FAIL-FAST CONTRACT (2026-08-13).
//
// This file used to pin the OPPOSITE behaviour (swarmManagerFallback.test.ts):
// dial 'sdk' + an SDK path that could not be established ⇒ a PTY desk plus a
// `fellBackBecause` reason on the response. The owner deleted that
// auto-fallback together with the worker's — a fallback that absorbs real
// breakage keeps it broken forever, and an invisible degrade is
// indistinguishable from a switch that does not work. The new contract:
//
//   • dial 'sdk' ⇒ the spawn either RETURNS an SDK desk or THROWS
//     SdkManagerUnavailableError — launchClaude is NEVER reached from an SDK
//     dial, and no desk is seated on a failure;
//   • dial 'pty' (the EXPLICIT kill switch — it survives) ⇒ a plain PTY desk,
//     and the SDK path is not even consulted;
//   • the throw's message names the cause, because the route turns it into the
//     500 body the owner reads (a console.warn inside a forked server in a
//     packaged app reaches nobody — that part of the old lesson still holds).
//
// The retry/bell story for a broken machine lives with the CALLERS: the
// engine's resurrection reflex counts a failed wake (grace → 3-strike
// 'manager-unrevivable' fatal → 30-min re-arm), and the 司令官 button surfaces
// the error text directly. Every side effect is mocked — no PTY, no claude, no
// SDK session — and HOME is the suite's tmp dir, so the dial write never
// touches the real ~/.openground.

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

import { spawnSwarmManager, MANAGER_DESK_LABEL } from './swarmManager'
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
      'launchClaude must never be reached from an SDK dial (the auto-fallback was deleted 2026-08-13)',
    )
  })
  // The dial the whole file is about. Written to the ISOLATED tmp home.
  await setSettings({ swarmManagerRuntime: { mode: 'sdk' } })
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

  it('the EXPLICIT pty dial still seats a PTY desk — and never consults the SDK path', async () => {
    // The kill switch survives the fallback's deletion on purpose: an owner can
    // still force the commander onto a terminal (Remote Control), and that
    // choice must not run any SDK code.
    await setSettings({ swarmManagerRuntime: { mode: 'pty' } })
    mocks.launchClaude.mockImplementation(() => ({ terminalId: 'term-1' }))

    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(r.runtime).toBe('pty')
    expect(r.terminalId).toBe('term-1')
    expect(mocks.sdkManagerPreflight).not.toHaveBeenCalled()
    expect(mocks.spawnSdkSession).not.toHaveBeenCalled()
    expect(MANAGER_DESK_LABEL).toBeTruthy()
  })
})
