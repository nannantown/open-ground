// Real spawn services, Git worktrees and session pool; the provider stream is synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const mock = vi.hoisted(() => ({
  catalog: vi.fn(), tier: vi.fn(), wiring: vi.fn(), preload: vi.fn(),
  workerPreflight: vi.fn(), managerPreflight: vi.fn(), query: vi.fn(),
}))
vi.mock('./chatgptAuth', async (original) => ({ ...(await original<typeof import('./chatgptAuth')>()), listChatGptModels: mock.catalog }))
// Launch acceptance exercises a signed-in owner; a local Swarm unlock alone
// deliberately does not grant the ChatGPT provider in release builds.
vi.mock('./roles', () => ({ getCustomTabRole: async () => 'owner' }))
vi.mock('./authStore', async original => ({ ...(await original<typeof import('./authStore')>()), readSession: async () => ({ user: { id: 'synthetic-owner' } }) }))
vi.mock('./chatgptTools', async (original) => ({ ...(await original<typeof import('./chatgptTools')>()), chatGptShellPreflight: async () => ({ executable: '/usr/bin/sandbox-exec', profile: 'synthetic preflight' }) }))
vi.mock('./swarmLaunch', async (original) => ({ ...(await original<typeof import('./swarmLaunch')>()), resolveSwarmModelEffortProbed: mock.tier }))
vi.mock('./hooksInstall', async (original) => ({ ...(await original<typeof import('./hooksInstall')>()), ensureGuardWiring: mock.wiring }))
vi.mock('./sdkSession', async (original) => ({ ...(await original<typeof import('./sdkSession')>()), preloadSdk: mock.preload }))
vi.mock('./swarmWorkerSdk', async (original) => ({ ...(await original<typeof import('./swarmWorkerSdk')>()), sdkWorkerPreflight: mock.workerPreflight }))
vi.mock('./swarmManagerSdk', async (original) => ({ ...(await original<typeof import('./swarmManagerSdk')>()), sdkManagerPreflight: mock.managerPreflight }))
vi.mock('./chatgptQuery', async (original) => ({ ...(await original<typeof import('./chatgptQuery')>()), createChatGptQuery: () => mock.query }))

import { spawnSwarmWorker, removeSwarmWorktree } from './swarmWorker'
import { spawnSwarmManager } from './swarmManager'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { setSettings } from './store'
import { markCoolingUntil, MODEL_TIER_LADDER, __resetQuotaForTest, flushQuotaPersist, isTierCooling } from './swarmQuota'
import { clearChatGptCooling } from './chatgptQuota'
import { getSdkSession, listSdkSessions, readSdkFrames, terminateSdkSession, __resetSdkSessionsForTests, type SdkQueryParams } from './sdkSession'

const execFile = promisify(execFileCb)
const git = (cwd: string, args: string[]) => execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
let scratch: string, project: string, priorHome: string | undefined
let worktrees: string[]
beforeEach(async () => {
  vi.clearAllMocks(); __resetSdkSessionsForTests(); __resetQuotaForTest(); clearChatGptCooling(); __resetMigrationCacheForTests()
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-chatgpt-spawn-')))
  const home = join(scratch, 'user-home'); await mkdir(home)
  priorHome = process.env.HOME; process.env.HOME = home
  project = join(scratch, 'project'); worktrees = []
  await git(scratch, ['init', '-q', '-b', 'main', 'project'])
  await git(project, ['config', 'user.email', 'synthetic@example.test'])
  await git(project, ['config', 'user.name', 'Synthetic test'])
  await writeFile(join(project, 'README.md'), '# Synthetic fixture\n')
  await git(project, ['add', 'README.md']); await git(project, ['commit', '-q', '-m', 'fixture'])
  await setSettings({ projects: [], swarmLocalOwner: true, swarmProvider: 'chatgpt', assistantProvider: 'claude', chatgptModel: 'synthetic-spawn-model', chatgptEffort: 'high', lockdownMode: false, experiments: undefined })
  await addProjectEntry(project)
  for (const tier of MODEL_TIER_LADDER) markCoolingUntil(tier, Date.now() + 60_000)
  await flushQuotaPersist()
  mock.catalog.mockResolvedValue([{ id: 'synthetic-spawn-model', name: 'Synthetic model', supportedEfforts: ['high'] }])
  mock.tier.mockRejectedValue(new Error('All Claude tiers are exhausted'))
  mock.preload.mockRejectedValue(new Error('Claude SDK is not logged in'))
  mock.wiring.mockResolvedValue({ ok: false, problems: ['No Claude hooks installed'] })
  mock.workerPreflight.mockReturnValue({ ok: false, claudeBin: null, cliVersion: null, problems: ['Claude is signed out'] })
  mock.managerPreflight.mockReturnValue({ ok: false, claudeBin: null, cliVersion: null, problems: ['Claude is signed out'] })
  mock.query.mockImplementation(({ prompt }: SdkQueryParams) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _message of prompt) {
        yield { kind: 'text', text: 'Synthetic ChatGPT turn completed.' }
        yield { kind: 'turn_end', reason: 'completed', isError: false }
      }
    },
  }))
})
afterEach(async () => {
  for (const session of listSdkSessions()) terminateSdkSession(session.id)
  await vi.waitFor(() => expect(listSdkSessions().every((session) => session.reaped)).toBe(true))
  for (const worktree of worktrees) await removeSwarmWorktree(project, worktree, { force: true })
  __resetSdkSessionsForTests(); __resetQuotaForTest(); clearChatGptCooling(); await flushQuotaPersist()
  if (priorHome !== undefined) process.env.HOME = priorHome
  await rm(scratch, { recursive: true, force: true })
})

const expectChatGptStream = async (id: string, role: 'worker' | 'manager') => {
  await vi.waitFor(() => expect(getSdkSession(id)).toMatchObject({ provider: 'chatgpt', role, status: 'waiting' }))
  expect(readSdkFrames(id, 0, 100)?.frames.some((frame) => frame.ev.kind === 'text' && frame.ev.text === 'Synthetic ChatGPT turn completed.')).toBe(true)
  const call = mock.query.mock.calls.find(([params]) => (params as SdkQueryParams).options.runtimeRole === role)
  const options = (call?.[0] as SdkQueryParams | undefined)?.options
  expect(options).toMatchObject({ model: 'synthetic-spawn-model', effort: 'high' })
  expect(options).not.toHaveProperty('pathToClaudeCodeExecutable')
  expect(mock.tier).not.toHaveBeenCalled()
  expect(mock.preload).not.toHaveBeenCalled()
  expect(mock.wiring).not.toHaveBeenCalled()
  expect(mock.workerPreflight).not.toHaveBeenCalled()
  expect(mock.managerPreflight).not.toHaveBeenCalled()
  expect(MODEL_TIER_LADDER.every((tier) => isTierCooling(tier, Date.now()))).toBe(true)
}

describe('ChatGPT spawn services are independent of Claude login and quota', () => {
  it('launches a guarded worker in a real Git worktree and streams through the real pool', async () => {
    const result = await spawnSwarmWorker({ projectPath: project, title: 'Synthetic bounded task' })
    worktrees.push(result.worktree)
    expect(result).toMatchObject({ runtime: 'sdk', terminalId: '', model: 'synthetic-spawn-model', effort: 'high' })
    expect(result.agentSessionId).toMatch(/^chatgpt-/)
    expect(result.worktree).not.toBe(project)
    expect(await readFile(join(result.worktree, 'README.md'), 'utf8')).toBe('# Synthetic fixture\n')
    await expectChatGptStream(result.sdkSessionId!, 'worker')
  })
  it('launches a commander despite a missing Claude binary, SDK login and exhausted tiers', async () => {
    const result = await spawnSwarmManager({ projectPath: project })
    expect(result).toMatchObject({ runtime: 'sdk', terminalId: '', resumed: false })
    expect(result.agentSessionId).toMatch(/^chatgpt-/)
    await expectChatGptStream(result.sdkSessionId!, 'manager')
  })
})
