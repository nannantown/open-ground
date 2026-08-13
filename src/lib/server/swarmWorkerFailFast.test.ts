// @vitest-environment node
//
// THE SDK-ONLY FAIL-FAST CONTRACT (2026-08-13 owner decision).
//
// This file used to pin the OPPOSITE behaviour (sdkDialAndFallback.test.ts):
// a worker that could not establish the SDK runtime degraded to a PTY and the
// reason rode back as `fellBackBecause`. The owner deleted that crutch — the
// fallback absorbed real breakage so quietly that the migration could never
// finish behind it (measured: DEFAULT_SDK_MAX_WORKERS=1 sent every extra worker
// to a PTY and the owner read it as a bug). The new contract, pinned here:
//
//   • a spawn either RETURNS an SDK identity or THROWS SdkWorkerUnavailableError
//     — there is no third outcome, and launchClaude is NEVER reached;
//   • a throw leaves NO orphan behind: the fresh worktree and its `swarm/*`
//     branch are rolled back (the 2026-07-29 leak class, now on every failure
//     path — one persistent failure must not mint a tree per attempt);
//   • the old worker runtime dial is INERT: whatever `swarmWorkerRuntime` says,
//     a worker is an SDK session (the dial's remaining reader is the manager's).
//
// TEETH: drives the real git paths (real repo, real `git worktree add`) through
// spawnSwarmWorker and asserts on the thrown error, the returned response, and
// the repo's on-disk state — never on a log line.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const execFile = promisify(execFileCb)
const git = (cwd: string, args: string[]) =>
  execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

const LIVE_PREFLIGHT = {
  ok: true,
  problems: [] as string[],
  claudeBin: '/usr/local/bin/claude' as string | null,
  cliVersion: '2.1.220' as string | null,
}
const liveSession = (cwd: string) => ({
  id: 'sdk-live',
  cwd,
  status: 'working' as string,
  exitReason: undefined as string | undefined,
  startedAt: 0,
  lastEventAt: 0,
  seq: 0,
})

const mocks = vi.hoisted(() => ({
  launchClaude: vi.fn(),
  preflight: vi.fn(),
  spawnSdkSession: vi.fn(),
}))

vi.mock('./claudeTerminal', () => ({ launchClaude: mocks.launchClaude }))
vi.mock('./hooksInstall', () => ({ ensureGuardWiring: async () => ({ ok: true, problems: [] }) }))
vi.mock('./experiments', () => ({ isExperimentEnabled: async () => false }))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: async () => ({ model: 'sonnet', effort: 'medium' }),
}))
vi.mock('./swarmWorkerSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmWorkerSdk')>()),
  sdkWorkerPreflight: mocks.preflight,
  sdkWorkerLaunchPlan: () => ({ options: {}, initialPrompt: '/order go', warnings: [] }),
}))
vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: mocks.spawnSdkSession,
}))

import { spawnSwarmWorker } from './swarmWorker'
import { SdkWorkerUnavailableError } from './swarmWorkerSdk'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { setSettings } from './store'
import { __resetSdkSessionsForTests } from './sdkSession'

/** No swarm/* branch and no worktree beyond the primary — the rollback proof. */
const expectNoOrphans = async (project: string) => {
  const branches = (await git(project, ['branch', '--list', 'swarm/*'])).stdout.trim()
  expect(branches).toBe('')
  const worktrees = (await git(project, ['worktree', 'list', '--porcelain'])).stdout
  expect(worktrees.split('\n\n').filter((b) => b.trim()).length).toBe(1)
}

describe('SDK-only worker spawn — the fail-fast contract', () => {
  let scratch: string
  let project: string

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.launchClaude.mockImplementation(() => {
      throw new Error('launchClaude must never be reached by a worker spawn (PTY workers were deleted 2026-08-13)')
    })
    mocks.preflight.mockReturnValue({ ...LIVE_PREFLIGHT })
    mocks.spawnSdkSession.mockImplementation((o: { cwd: string }) => liveSession(o.cwd))
    __resetSdkSessionsForTests()
    __resetMigrationCacheForTests?.()
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-failfast-')))
    project = join(scratch, 'proj')
    await git(scratch, ['init', '-q', '-b', 'main', 'proj'])
    await git(project, ['config', 'user.email', 'dev@test'])
    await git(project, ['config', 'user.name', 'Dev'])
    await writeFile(join(project, 'README.md'), '# x\n')
    await git(project, ['add', '-A'])
    await git(project, ['commit', '-q', '-m', 'base'])
    await addProjectEntry(project)
  })

  afterEach(async () => {
    __resetSdkSessionsForTests()
    await setSettings({})
    await rm(scratch, { recursive: true, force: true })
  })

  it('a successful spawn returns the SDK identity — and only that shape exists', async () => {
    const res = await spawnSwarmWorker({ projectPath: project, title: 'a card' })
    expect(res.runtime).toBe('sdk')
    expect(res.sdkSessionId).toBe('sdk-live')
    // terminalId is EMPTY for an SDK worker (pty ⇔ terminalId / sdk ⇔ sdkSessionId).
    expect(res.terminalId).toBe('')
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })

  it('a refused preflight THROWS the typed error and leaves no worktree/branch behind', async () => {
    mocks.preflight.mockReturnValue({
      ok: false,
      problems: ['guard did not deny a write outside the worktree'],
      claudeBin: null,
      cliVersion: null,
    })
    await expect(spawnSwarmWorker({ projectPath: project, title: 'a card' })).rejects.toThrow(
      SdkWorkerUnavailableError,
    )
    await expect(spawnSwarmWorker({ projectPath: project, title: 'a card' })).rejects.toThrow(
      /guard did not deny/,
    )
    expect(mocks.spawnSdkSession).not.toHaveBeenCalled()
    expect(mocks.launchClaude).not.toHaveBeenCalled()
    // The rollback proof: a 3s-tick retry loop must not mint a tree per attempt.
    await expectNoOrphans(project)
  })

  it('an SDK session that dies at start THROWS with the exit reason and rolls back', async () => {
    mocks.spawnSdkSession.mockImplementation((o: { cwd: string }) => ({
      ...liveSession(o.cwd),
      id: 'sdk-dead',
      status: 'failed',
      exitReason: 'spawn failed: require blew up',
    }))
    await expect(spawnSwarmWorker({ projectPath: project, title: 'a card' })).rejects.toThrow(
      /require blew up/,
    )
    // The SDK spawn really was attempted — this is a failure, not a skip.
    expect(mocks.spawnSdkSession).toHaveBeenCalledTimes(1)
    expect(mocks.launchClaude).not.toHaveBeenCalled()
    await expectNoOrphans(project)
  })

  it('the legacy worker dial is INERT — an explicit pty mode still spawns an SDK worker', async () => {
    // The kill switch the dial used to be is gone WITH the runtime it switched
    // to. A machine whose settings.json still carries {"mode":"pty"} (every
    // pre-0.11.72 install that ever touched the toggle) must not change behaviour:
    // there is nothing to switch to anymore.
    await setSettings({ swarmWorkerRuntime: { mode: 'pty' } } as never)
    const res = await spawnSwarmWorker({ projectPath: project, title: 'a card' })
    expect(res.runtime).toBe('sdk')
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })

  it('a RESTART into an existing worktree keeps it on failure (the work is not ours to roll back)', async () => {
    // First, a successful spawn creates the worktree.
    const first = await spawnSwarmWorker({ projectPath: project, title: 'a card' })
    // Now the environment breaks and a restart into that same worktree fails.
    mocks.preflight.mockReturnValue({ ok: false, problems: ['CLI signed out'], claudeBin: null, cliVersion: null })
    await expect(
      spawnSwarmWorker({ projectPath: project, title: 'a card', worktree: first.worktree }),
    ).rejects.toThrow(SdkWorkerUnavailableError)
    // The pre-existing worktree + branch survive: they hold the worker's real work.
    const branches = (await git(project, ['branch', '--list', 'swarm/*'])).stdout.trim()
    expect(branches).not.toBe('')
  })
})
