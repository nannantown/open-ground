import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasState } from '../types'

const mock = vi.hoisted(() => ({
  canvas: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] } as CanvasState,
  health: 'ok', owner: true, changedOwner: false,
  save: vi.fn(), requestOwner: vi.fn(), verifyOwner: vi.fn(),
}))
let mutations: Promise<unknown> = Promise.resolve()
vi.mock('./store', () => ({
  mutateCanvas: (mutate: (current: CanvasState) => Promise<CanvasState>) => {
    const task = mutations.catch(() => {}).then(async () => {
      if (mock.health === 'unreadable') throw Object.assign(new Error('unreadable'), { status: 503 })
      const value = await mutate(structuredClone(mock.canvas))
      await mock.save(value); mock.canvas = structuredClone(value)
      return value
    })
    mutations = task
    return task
  },
}))
vi.mock('./runtimeOwner', () => ({
  runtimeRequestOwnerKey: async (id?: string) => { mock.requestOwner(id); if (!mock.owner) throw new Error('no owner'); return 'owner-a' },
  runtimeOwnerKey: async (key?: string) => { mock.verifyOwner(key); if (mock.changedOwner) throw new Error('changed'); return 'owner-a' },
}))
import { saveGroundCanvas } from './groundCanvas'
import { createAutomationFrame } from '../automationFrame'

const empty = (): CanvasState => ({ positions: { project: { x: 0, y: 0 } }, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] })
beforeEach(() => {
  mock.canvas = empty(); mock.health = 'ok'; mock.owner = true; mock.changedOwner = false
  vi.clearAllMocks()
})

describe('durable Ground automation authority', () => {
  it('keeps existing canvases manual until an owner explicitly designates a frame', async () => {
    mock.owner = false
    await saveGroundCanvas({ ...empty(), viewport: { x: 2, y: 3, zoom: 1 } })
    expect(mock.requestOwner).not.toHaveBeenCalled()
    await expect(saveGroundCanvas(createAutomationFrame(mock.canvas, 'auto', '自動運用'))).rejects.toMatchObject({ status: 403 })
    expect(mock.canvas.automation).toBeUndefined()
  })

  it('durably saves designation then requires owner consent for membership changes', async () => {
    const created = await saveGroundCanvas(createAutomationFrame(empty(), 'auto', '自動運用'), 'signed-in-owner')
    expect(created.automation?.revision).toBe(1)
    expect(mock.requestOwner).toHaveBeenCalledWith('signed-in-owner')
    mock.owner = false
    const inside = structuredClone(created)
    inside.positions.project = { x: inside.elements[0].x + 40, y: 150 }
    await expect(saveGroundCanvas(inside)).rejects.toMatchObject({ status: 403 })
    expect(mock.canvas.positions.project).toEqual({ x: 0, y: 0 })
    mock.owner = true
    const accepted = await saveGroundCanvas(inside)
    expect(accepted.automation?.revision).toBe(2)
  })

  it('rejects stale membership and policy saves, including old clients with omitted metadata', async () => {
    const original = await saveGroundCanvas(createAutomationFrame(empty(), 'auto', '自動運用'))
    const moved = structuredClone(original)
    moved.positions.project = { x: moved.elements[0].x + 40, y: 150 }
    await saveGroundCanvas(moved)
    await expect(saveGroundCanvas(original)).rejects.toMatchObject({ status: 409 })
    await expect(saveGroundCanvas(empty())).rejects.toMatchObject({ status: 409 })
    expect(mock.canvas.automation?.revision).toBe(2)
  })

  it('does not trust forged revisions and keeps authority when only the label/viewport changes', async () => {
    const created = await saveGroundCanvas(createAutomationFrame(empty(), 'auto', '自動運用'))
    mock.owner = false
    const renamed = structuredClone(created)
    renamed.automation!.revision = 9999
    renamed.elements[0].text = 'Renamed'
    renamed.viewport.x = 20
    const saved = await saveGroundCanvas(renamed)
    expect(saved.automation?.revision).toBe(1)
    expect(saved.elements[0].groundRole).toBe('automation')
  })

  it('retains enabled policy with an empty allowlist when the frame is deleted', async () => {
    const created = await saveGroundCanvas(createAutomationFrame(empty(), 'auto', '自動運用'))
    const saved = await saveGroundCanvas({ ...created, elements: [] })
    expect(saved.automation).toMatchObject({ enabled: true, frameId: 'auto', revision: 2 })
  })

  it('rejects duplicate roles, wrong dimensions, and unreadable authority without writing', async () => {
    const created = createAutomationFrame(empty(), 'auto', '自動運用')
    await expect(saveGroundCanvas({ ...created, elements: [...created.elements, { ...created.elements[0], id: 'duplicate' }] })).rejects.toMatchObject({ status: 400 })
    await expect(saveGroundCanvas({ ...created, elements: [{ ...created.elements[0], width: -1 }] })).rejects.toMatchObject({ status: 400 })
    mock.health = 'unreadable'
    await expect(saveGroundCanvas(created)).rejects.toMatchObject({ status: 503 })
    expect(mock.save).not.toHaveBeenCalled()
  })

  it('does not acknowledge a persistence fault or an owner change before commit', async () => {
    const created = createAutomationFrame(empty(), 'auto', '自動運用')
    mock.save.mockRejectedValueOnce(new Error('fsync failure'))
    await expect(saveGroundCanvas(created)).rejects.toThrow('fsync failure')
    expect(mock.canvas.automation).toBeUndefined()
    mock.changedOwner = true
    await expect(saveGroundCanvas(created)).rejects.toMatchObject({ status: 403 })
    expect(mock.save).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent authority writes so exactly one stale snapshot can commit', async () => {
    const created = await saveGroundCanvas(createAutomationFrame(empty(), 'auto', '自動運用'))
    const first = structuredClone(created)
    first.elements[0].x += 50
    const second = structuredClone(created)
    second.elements[0].x += 100
    const results = await Promise.allSettled([saveGroundCanvas(first), saveGroundCanvas(second)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(mock.canvas.automation?.revision).toBe(2)
    expect(mock.canvas.elements[0].x).toBe(first.elements[0].x)
  })
})
