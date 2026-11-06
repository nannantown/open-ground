import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { canvasFile, ensureOpenGroundHome } from '@/lib/server/paths'
import { createAutomationFrame, isAutomationAllowed, setFrameAutomation } from '@/lib/automationFrame'
import type { CanvasState } from '@/lib/types'

const access = vi.hoisted(() => ({ owner: false, changed: false, reconciled: vi.fn() }))
vi.mock('@/lib/server/runtimeOwner', () => ({
  runtimeRequestOwnerKey: async () => { if (!access.owner) throw new Error('not owner'); return 'owner' },
  runtimeOwnerKey: async () => { if (access.changed) throw new Error('changed'); return 'owner' },
}))
vi.mock('@/lib/server/automationPolicy', () => ({ reconcileAutomationPolicy: async () => access.reconciled() }))

import * as store from '@/lib/server/store'
import * as atomic from '@/lib/server/atomicWrite'
import { canvasRoutes } from '../canvas'

const initial = (): CanvasState => ({ positions: { project: { x: 0, y: 0 } }, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] })
const post = (body: unknown) => canvasRoutes.request('/api/canvas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(async () => {
  vi.restoreAllMocks(); access.owner = false; access.changed = false; access.reconciled.mockReset()
  await ensureOpenGroundHome()
  await rm(canvasFile(), { force: true })
})

describe('POST Ground canvas — execution consent is durable and authorized', () => {
  it('durably saves ordinary frame switches before reconciliation, rejects stale/downgrade input, and keeps the last OFF explicit', async () => {
    const ordinary = initial()
    ordinary.elements = [
      { id: 'first', type: 'frame', text: 'First', x: 0, y: 0, width: 500, height: 400 },
      { id: 'second', type: 'frame', text: 'Second', x: 800, y: 0, width: 500, height: 400 },
    ]
    const toggled = setFrameAutomation(ordinary, 'first', true)
    expect((await post(toggled)).status).toBe(403)
    expect(access.reconciled).not.toHaveBeenCalled()
    access.owner = true
    access.reconciled.mockImplementation(async () => {
      const saved = await store.getCanvas()
      expect(saved.automation?.version).toBe(2)
      expect(saved.automation!.revision).toBeGreaterThan(0)
    })
    expect((await post(toggled)).status).toBe(200)
    const first = await store.getCanvas()
    expect(first.automation).toEqual({ version: 2, revision: 1, enabled: true, frameIds: ['first'] })
    expect(isAutomationAllowed(first, 'project')).toBe(true)
    expect((await post(setFrameAutomation(first, 'second', true))).status).toBe(200)
    expect((await post(setFrameAutomation(first, 'first', false))).status).toBe(409)
    const both = await store.getCanvas()
    expect(both.automation).toMatchObject({ version: 2, frameIds: ['first', 'second'], revision: 2 })
    const off = setFrameAutomation(setFrameAutomation(both, 'first', false), 'second', false)
    expect((await post(off)).status).toBe(200)
    expect(isAutomationAllowed(await store.getCanvas(), 'project')).toBe(false)
    const downgrade = { ...off, automation: { version: 1, enabled: false, revision: 3, frameId: null } }
    expect((await post(downgrade)).status).toBe(409)
    expect((await post(ordinary)).status).toBe(409)
    expect(access.reconciled).toHaveBeenCalledTimes(3)
    expect((await store.getCanvas()).automation).toEqual({ version: 2, revision: 3, enabled: true, frameIds: [] })
  })

  it('does not grant a decorative frame named 自動運用 any execution authority', async () => {
    const canvas = initial()
    canvas.elements.push({ id: 'ordinary', type: 'frame', text: '自動運用', x: 0, y: 0, width: 500, height: 500 })
    const response = await post(canvas)
    expect(response.status).toBe(200)
    expect((await store.getCanvas()).automation).toBeUndefined()
  })

  it('rejects unsigned/local/opt-in designation, then persists an owner designation before reconciliation and ACK', async () => {
    const created = createAutomationFrame(initial(), 'auto', '自動運用')
    expect((await post(created)).status).toBe(403)
    expect(access.reconciled).not.toHaveBeenCalled()
    access.owner = true
    access.reconciled.mockImplementationOnce(async () => {
      const persisted = JSON.parse(await readFile(canvasFile(), 'utf8')) as CanvasState
      expect(persisted.automation).toMatchObject({ frameId: 'auto', revision: 1 })
    })
    const response = await post(created)
    expect(response.status).toBe(200)
    expect((await response.json()).canvas.automation.revision).toBe(1)
    if (process.platform !== 'win32') expect((await stat(canvasFile())).mode & 0o777).toBe(0o600)
  })

  it('requires owner+CAS for a project move, frame resize, deletion, and explicit policy disable', async () => {
    access.owner = true
    await post(createAutomationFrame(initial(), 'auto', '自動運用'))
    const current = await store.getCanvas()
    for (const operation of ['move', 'resize', 'delete', 'disable']) {
      const changed = structuredClone(current)
      if (operation === 'move') changed.positions.project = { x: changed.elements[0].x + 10, y: changed.elements[0].y + 10 }
      if (operation === 'resize') changed.elements[0].width = 900
      if (operation === 'delete') changed.elements = []
      if (operation === 'disable') changed.automation!.enabled = false
      access.owner = false
      expect((await post(changed)).status).toBe(403)
      expect(await store.getCanvas()).toEqual(current)
    }
    access.owner = true
    const moved = structuredClone(current)
    moved.positions.project = { x: moved.elements[0].x + 10, y: moved.elements[0].y + 10 }
    expect((await post(moved)).status).toBe(200)
    expect((await post(current)).status).toBe(409)
    expect((await post(initial())).status).toBe(409)
    expect((await store.getCanvas()).automation?.revision).toBe(2)
  })

  it('does not ACK/reconcile on a write failure and preserves the previous authority', async () => {
    access.owner = true
    await post(createAutomationFrame(initial(), 'auto', '自動運用'))
    const current = await store.getCanvas()
    const changed = structuredClone(current)
    changed.elements[0].x += 50
    access.reconciled.mockClear()
    const write = atomic.atomicWriteJson
    vi.spyOn(atomic, 'atomicWriteJson').mockImplementation(async (path, data, options) => {
      if (path === canvasFile()) throw new Error('synthetic fsync failure')
      await write(path, data, options)
    })
    expect((await post(changed)).status).toBe(503)
    expect(access.reconciled).not.toHaveBeenCalled()
    expect(await store.getCanvas()).toEqual(current)
  })

  it('refuses to overwrite damaged policy and refuses an owner swap before commit', async () => {
    access.owner = true
    const created = createAutomationFrame(initial(), 'auto', '自動運用')
    access.changed = true
    expect((await post(created)).status).toBe(403)
    access.changed = false
    await writeFile(canvasFile(), '{"automation":', 'utf8')
    expect((await post(created)).status).toBe(503)
    expect(await readFile(canvasFile(), 'utf8')).toBe('{"automation":')
    expect(access.reconciled).not.toHaveBeenCalled()
  })

  it('keeps syntactically valid but malformed stored authority closed, and reports malformed request JSON as input failure', async () => {
    access.owner = true
    await writeFile(canvasFile(), JSON.stringify({ ...initial(), automation: { version: 99, enabled: false } }))
    expect((await post(initial())).status).toBe(503)
    expect(JSON.parse(await readFile(canvasFile(), 'utf8')).automation.version).toBe(99)
    const invalid = await canvasRoutes.request('/api/canvas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' })
    expect(invalid.status).toBe(400)
    expect(access.reconciled).not.toHaveBeenCalled()
  })
})
