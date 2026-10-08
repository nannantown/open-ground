import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { getSettings, setSettings } from '@/lib/server/store'
import { registerTestProject } from '@/test/registerProject'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@/lib/server/canvasData'
import { readProjectData, writeProjectData } from '@/lib/server/projectData'
import { runEnginePass, type ProjectEngine, type OrchestratorDeps, type IntegrationDeps, type AnomalyDeps } from '@/lib/server/swarmOrchestrator'
const h = vi.hoisted(() => ({ plan: 'free' }))
vi.mock('@/lib/server/billing', () => ({ getBillingState: async () => ({ plan: h.plan }), billingRequest: async () => null }))
let path: string
const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
beforeEach(async () => {
  path = await realpath(await mkdtemp(join(tmpdir(), 'og-product-access-')))
  await registerTestProject(path)
  await clearSession(); h.plan = 'free'
  vi.stubEnv('OPENGROUND_OWNER_EMAILS', 'owner@example.com')
})
afterEach(async () => { await clearSession(); vi.unstubAllEnvs(); await rm(path, { recursive: true, force: true }) })
const owner = () => writeSession({ user: { id: 'owner', email: 'owner@example.com', provider: 'google' }, expiresAt: Date.now() + 3600000, accessToken: 'a', refreshToken: 'r' })

it('Free and Pro are denied Owner APIs before reading files or starting jobs', async () => {
  await setSettings({ swarmLocalOwner: true })
  for (const plan of ['free', 'pro']) {
    h.plan = plan
    for (const [method, url] of [
      ['GET', '/api/research/reports'], ['POST', '/api/research/blog-publish'],
      ['GET', '/api/custom-modules'], ['GET', '/api/custom-modules/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/source'],
      ['POST', '/api/local-apps/nene-songs/start'], ['GET', '/api/project/canvases'],
      ['GET', '/api/phone-link/assistant/log'], ['GET', '/api/collab/shared-canvas'],
      ['POST', '/api/canvas/ai/generate'], ['GET', '/api/project/skills'], ['GET', '/api/skills/global'],
    ]) expect((await app.request(url, method === 'GET' ? undefined : json({}))).status).toBe(403)
  }
})
it('public settings reads/writes cannot expose or overwrite owner credentials', async () => {
  const wordpress = { baseUrl: 'https://blog.example', username: 'owner', appPassword: 'fixture-password' }
  await setSettings({ wordpress, experiments: { swarm: true } })
  expect((await (await app.request('/api/settings')).json()).wordpress).toBeUndefined()
  await app.request('/api/settings', json({ displayName: 'Public', wordpress: null, experiments: {} }))
  expect((await getSettings()).wordpress).toEqual(wordpress)
  expect((await getSettings()).experiments).toEqual({ swarm: true })
})
it('public Board writes retain saved owner layout and existing Canvas bytes', async () => {
  const saved = await writeProjectData(path, { ...await readProjectData(path), tabOrder: ['canvas', 'board'], customTabs: ['saved-id'], disabledModules: ['terminal'] })
  const canvas = await createCanvas(path, 'Owner design')
  const url = `/api/project?path=${encodeURIComponent(path)}`
  const res = await app.request(url, json({ ...saved, tabOrder: [], customTabs: [], disabledModules: [], notes: 'Public edit' }, 'PUT'))
  expect(res.status).toBe(200)
  const kept = await readProjectData(path)
  expect(kept.notes).toBe('Public edit')
  expect(kept.tabOrder).toEqual(saved.tabOrder); expect(kept.customTabs).toEqual(saved.customTabs)
  await owner()
  const actual = await (await app.request(`/api/project/canvases?path=${encodeURIComponent(path)}&id=${canvas.canvas.id}`)).json()
  expect(actual).toEqual(canvas.canvas)
})
it('Free cannot unlock Swarm; macOS Pro and Owner reach start validation', async () => {
  await setSettings({ swarmOptIn: true, swarmLocalOwner: true, experiments: { swarm: true } })
  expect((await app.request('/api/swarm/worker', json({}))).status).toBe(403)
  h.plan = 'pro'
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect((await app.request('/api/swarm/worker', json({}))).status).toBe(400)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect((await app.request('/api/swarm/worker', json({}))).status).toBe(403)
    await owner()
    expect((await app.request('/api/swarm/worker', json({}))).status).toBe(400)
  } finally { Object.defineProperty(process, 'platform', original) }
})
it('revocation pauses production engine work without touching the board or existing workers', async () => {
  const worker = { terminalId: 'existing' }
  const engine = { running: true, passInFlight: false, overseer: { enabled: true }, workers: [worker] } as unknown as ProjectEngine
  const fetchTasks = vi.fn()
  const deps = { hasAccess: async () => false, fetchTasks } as unknown as OrchestratorDeps & IntegrationDeps & AnomalyDeps
  await runEnginePass(engine, deps)
  expect(engine.running).toBe(false); expect(engine.overseer.enabled).toBe(false)
  expect(engine.workers).toEqual([worker]); expect(fetchTasks).not.toHaveBeenCalled()
})
