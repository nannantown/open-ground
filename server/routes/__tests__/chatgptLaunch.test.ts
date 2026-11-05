import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
const mock = vi.hoisted(() => ({ claude: vi.fn(), catalog: vi.fn(), worker: vi.fn(), manager: vi.fn(), supply: vi.fn() }))
vi.mock('@/lib/server/claudePreflight', () => ({ claudeRunPreflight: mock.claude }))
vi.mock('@/lib/server/chatgptAuth', async (original) => ({ ...(await original<typeof import('@/lib/server/chatgptAuth')>()), listChatGptModels: mock.catalog }))
vi.mock('@/lib/server/roles', async (original) => ({ ...(await original<typeof import('@/lib/server/roles')>()), getCustomTabRole: async () => 'owner' }))
// This suite checks provider routing, not the macOS kernel sandbox. Its real
// sandbox controls run separately on macOS in chatgptTools/Review.test.ts.
vi.mock('@/lib/server/chatgptTools', async (original) => ({ ...(await original<typeof import('@/lib/server/chatgptTools')>()), chatGptShellPreflight: async () => ({ executable: '/usr/bin/sandbox-exec', profile: 'synthetic-preflight' }) }))
vi.mock('@/lib/server/swarmEnvPreflight', () => ({ swarmEnvPreflight: async () => ({ ok: true, issues: [] }) }))
vi.mock('@/lib/server/swarmWorker', async (original) => ({ ...(await original<typeof import('@/lib/server/swarmWorker')>()), spawnSwarmWorker: mock.worker }))
vi.mock('@/lib/server/swarmManager', async (original) => ({ ...(await original<typeof import('@/lib/server/swarmManager')>()), spawnSwarmManager: mock.manager }))
vi.mock('@/lib/server/swarmSupply', async (original) => ({ ...(await original<typeof import('@/lib/server/swarmSupply')>()), spawnSwarmSupply: mock.supply }))
import { swarmRoutes } from '../swarm'
import { addProjectEntry, __resetMigrationCacheForTests } from '@/lib/server/registry'
import { getSettings, setSettings } from '@/lib/server/store'
import { markCoolingUntil, MODEL_TIER_LADDER, __resetQuotaForTest, flushQuotaPersist } from '@/lib/server/swarmQuota'
import { clearChatGptCooling } from '@/lib/server/chatgptQuota'

let project: string
const post = (role: string) => swarmRoutes.request(`/api/swarm/${role}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: project, title: 'Small bounded task' }) })
beforeEach(async () => {
  vi.clearAllMocks(); __resetQuotaForTest(); clearChatGptCooling(); __resetMigrationCacheForTests()
  project = await realpath(await mkdtemp(join(tmpdir(), 'og-chatgpt-route-launch-')))
  await setSettings({ projects: [], swarmLocalOwner: true, swarmProvider: 'chatgpt', assistantProvider: 'claude', chatgptModel: 'synthetic-model', chatgptEffort: 'high', lockdownMode: false, experiments: undefined })
  await addProjectEntry(project)
  mock.claude.mockResolvedValue({ ok: false, body: { error: 'Claude is signed out', claudeLoggedOut: true } })
  mock.catalog.mockResolvedValue([{ id: 'synthetic-model', name: 'Synthetic model', supportedEfforts: ['high'] }])
  mock.worker.mockResolvedValue({ terminalId: '', runtime: 'sdk', sdkSessionId: 'worker-pool', agentSessionId: 'chatgpt-11111111-1111-4111-8111-111111111111', branch: 'swarm/test', worktree: project, model: 'synthetic-model' })
  mock.manager.mockResolvedValue({ terminalId: '', runtime: 'sdk', sdkSessionId: 'manager-pool', agentSessionId: 'chatgpt-22222222-2222-4222-8222-222222222222', resumed: false })
  mock.supply.mockResolvedValue({ terminalId: '', runtime: 'sdk', sdkSessionId: 'supply-pool', agentSessionId: 'chatgpt-33333333-3333-4333-8333-333333333333', resumed: false })
  for (const tier of MODEL_TIER_LADDER) markCoolingUntil(tier, Date.now() + 60_000)
  await flushQuotaPersist()
})
afterEach(async () => { __resetQuotaForTest(); clearChatGptCooling(); await flushQuotaPersist(); await rm(project, { recursive: true, force: true }) })

describe('manual HTTP launch uses the chosen subscription preflight', () => {
  it.each(['worker', 'manager', 'supply'])('%s reaches its ChatGPT spawn with Claude signed out and every Claude tier cooling', async (role) => {
    const response = await post(role)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ runtime: 'sdk', sdkSessionId: `${role}-pool` })
    expect(mock[role as 'worker' | 'manager' | 'supply']).toHaveBeenCalledWith(expect.objectContaining({ projectPath: project }))
    expect(mock.catalog).toHaveBeenCalled()
    expect(mock.claude).not.toHaveBeenCalled()
  })
  it.each(['worker', 'manager', 'supply'])('%s preserves the old signed-out Claude 503 contract when Claude is selected', async (role) => {
    await setSettings({ swarmProvider: 'claude' })
    const response = await post(role)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Claude is signed out', claudeLoggedOut: true })
    expect(mock[role as 'worker' | 'manager' | 'supply']).not.toHaveBeenCalled()
    expect(mock.claude).toHaveBeenCalledOnce()
    expect(mock.catalog).not.toHaveBeenCalled()
  })
  it('a failed ChatGPT model/account check refuses before any worker or desk launch and does not fall back', async () => {
    mock.catalog.mockRejectedValue(new Error('ChatGPT must be connected'))
    for (const role of ['worker', 'manager', 'supply']) {
      const response = await post(role)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ chatgptUnavailable: true })
      expect(mock[role as 'worker' | 'manager' | 'supply']).not.toHaveBeenCalled()
    }
    expect(mock.claude).not.toHaveBeenCalled()
    expect((await getSettings()).swarmProvider).toBe('chatgpt')
  })
})
