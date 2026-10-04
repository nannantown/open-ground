import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { phoneLinkRoutes } from '../phoneLink'
import { appendAssistantCall, clearAssistantLog } from '@/lib/server/assistantMemory'
import { openGroundHome } from '@/lib/server/paths'

vi.mock('@/lib/server/swarmGate', () => ({ isSwarmLocalOwnerUnlocked: async () => true }))
vi.mock('@/lib/server/roles', () => ({ getCustomTabRole: async () => null }))
const app = new Hono().route('/', phoneLinkRoutes)
let project: string
beforeEach(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), 'og-call-project-')))
  await writeFile(join(openGroundHome(), 'settings.json'), JSON.stringify({ projectsMigratedAt: new Date().toISOString(), projects: [{ id: 'p1', path: project, addedAt: new Date().toISOString() }] }))
  await clearAssistantLog()
})
afterEach(async () => { await rm(project, { recursive: true, force: true }) })

it('the Mac reader shows only its registered president notes; assistant reader excludes those notes', async () => {
  await appendAssistantCall('a', { at: Date.now(), kind: 'call', seconds: 102, projectId: 'assistant', who: 'owner', text: 'Call 1:42', via: 'phone' })
  await appendAssistantCall('p', { at: Date.now(), kind: 'call', seconds: 25, projectId: 'p1', who: 'owner', text: 'Call 0:25', via: 'phone' })
  const r = await app.request(`/api/phone-link/call-notes?path=${encodeURIComponent(project)}`)
  expect((await r.json()).entries).toEqual([expect.objectContaining({ id: 'call:p', seconds: 25, projectId: 'p1' })])
  const assistant = await app.request('/api/phone-link/assistant/log')
  expect((await assistant.json()).entries).toEqual([expect.objectContaining({ id: 'call:a', seconds: 102, projectId: 'assistant' })])
  const escaped = await app.request('/api/phone-link/call-notes?path=%2Fetc')
  expect(escaped.status).toBe(403)
  expect(await escaped.text()).not.toContain('Call')
  const rebound = await app.request(`/api/phone-link/call-notes?path=${encodeURIComponent(project)}`, { headers: { host: 'attacker.example', origin: 'https://attacker.example' } })
  expect(rebound.status).toBe(403)
  expect(await rebound.text()).not.toContain('Call')
})


it('clearing assistant conversation or deleting by a president id preserves unrelated project call records', async () => {
  await appendAssistantCall('a', { at: Date.now(), kind: 'call', seconds: 102, projectId: 'assistant', who: 'owner', text: 'Call 1:42', via: 'phone' })
  await appendAssistantCall('p', { at: Date.now(), kind: 'call', seconds: 25, projectId: 'p1', who: 'owner', text: 'Call 0:25', via: 'phone' })
  const deleteOther = await app.request('/api/phone-link/assistant/log/call:p', { method: 'DELETE' })
  expect(deleteOther.status).toBe(404)
  await app.request('/api/phone-link/assistant/log', { method: 'DELETE' })
  const assistant = await app.request('/api/phone-link/assistant/log')
  expect((await assistant.json()).entries).toEqual([])
  const president = await app.request(`/api/phone-link/call-notes?path=${encodeURIComponent(project)}`)
  expect((await president.json()).entries).toEqual([expect.objectContaining({ id: 'call:p', seconds: 25 })])
})
