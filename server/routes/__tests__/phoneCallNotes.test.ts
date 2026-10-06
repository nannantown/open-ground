import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { phoneLinkRoutes } from '../phoneLink'
import { appendAssistantCall, clearAssistantLog, readAssistantLog } from '@/lib/server/assistantMemory'
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

it('DELETE call-notes clears only that president\'s notes, behind the same path and loopback gates', async () => {
  await appendAssistantCall('a', { at: Date.now(), kind: 'call', seconds: 102, projectId: 'assistant', who: 'owner', text: 'Call 1:42', via: 'phone' })
  await appendAssistantCall('p', { at: Date.now(), kind: 'call', seconds: 25, projectId: 'p1', who: 'owner', text: 'Call 0:25', via: 'phone' })
  await appendAssistantCall('q', { at: Date.now(), kind: 'call', seconds: 9, projectId: 'p2', who: 'owner', text: 'Call 0:09', via: 'phone' })
  const url = `/api/phone-link/call-notes?path=${encodeURIComponent(project)}`
  expect((await app.request('/api/phone-link/call-notes?path=%2Fetc', { method: 'DELETE' })).status).toBe(403)
  expect((await app.request(url, { method: 'DELETE', headers: { host: 'attacker.example', origin: 'https://attacker.example' } })).status).toBe(403)
  expect((await (await app.request(url)).json()).entries).toHaveLength(1)
  expect((await app.request(url, { method: 'DELETE' })).status).toBe(200)
  expect((await (await app.request(url)).json()).entries).toEqual([])
  const all = (await readAssistantLog()).map((e) => e.id).sort()
  expect(all).toEqual(['call:a', 'call:q'])
})
