import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasState } from '../types'
import { assertAutomaticOperationAllowed, readProjectAutomationPolicy, reconcileAutomationPolicy, startAutomationPolicyLoop, stopAutomationPolicyLoop } from './automationPolicy'

const fixture = vi.hoisted(() => ({ canvas: {} as CanvasState, health: 'ok', owner: true, projects: [{ id: 'inside', path: '/fixture/inside' }, { id: 'outside', path: '/fixture/outside' }], reconcile: vi.fn(async () => ({ started: [], paused: [], failures: [] })) }))
vi.mock('./store', () => ({ getCanvasWithHealth: async () => ({ value: fixture.canvas, health: fixture.health }), getSettings: async () => ({ projects: fixture.projects }) }))
vi.mock('./swarmOrchestrator', () => ({ reconcileAutomationOrchestrators: () => fixture.reconcile() }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => fixture.owner }))

beforeEach(() => {
  fixture.health = 'ok'
  fixture.owner = true
  fixture.reconcile.mockClear()
  fixture.canvas = { positions: { inside: { x: 10, y: 10 }, outside: { x: 1000, y: 1000 } }, viewport: { x: 0, y: 0, zoom: 1 },
    automation: { version: 1, enabled: true, frameId: 'auto', revision: 1 },
    elements: [{ id: 'auto', type: 'frame', groundRole: 'automation', x: 0, y: 0, width: 500, height: 400, text: 'Automatic operation' }] }
})
afterEach(() => { stopAutomationPolicyLoop(); vi.useRealTimers() })

describe('server automation-frame admission', () => {
  it('uses the registered project identity and persisted membership', async () => {
    expect(await readProjectAutomationPolicy('/fixture/inside')).toMatchObject({ enabled: true, allowed: true, healthy: true, frameId: 'auto' })
    expect(await readProjectAutomationPolicy('/fixture/outside')).toMatchObject({ enabled: true, allowed: false, healthy: true })
    expect(await readProjectAutomationPolicy('/fixture/unknown')).toMatchObject({ enabled: true, allowed: false })
    await expect(assertAutomaticOperationAllowed('/fixture/outside')).rejects.toMatchObject({ code: 'automation-frame-off' })
  })

  it('retains legacy admission only for healthy unconfigured or explicitly disabled policy', async () => {
    delete fixture.canvas.automation
    fixture.canvas.elements.forEach((element) => { delete element.groundRole })
    expect((await readProjectAutomationPolicy('/fixture/inside')).allowed).toBe(true)
    fixture.canvas.automation = { version: 1, enabled: false, frameId: null, revision: 2 }
    expect((await readProjectAutomationPolicy('/fixture/outside')).allowed).toBe(true)
    fixture.health = 'absent'
    expect((await readProjectAutomationPolicy('/fixture/inside')).allowed).toBe(true)
  })

  it('fails closed on unreadable canvas and on an enabled policy whose designated frame vanished', async () => {
    fixture.health = 'unreadable'
    expect(await readProjectAutomationPolicy('/fixture/inside')).toMatchObject({ enabled: true, allowed: false, healthy: false })
    fixture.health = 'ok'
    fixture.canvas.elements = []
    expect(await readProjectAutomationPolicy('/fixture/inside')).toMatchObject({ enabled: true, allowed: false, healthy: true, frameId: null })
  })

  it('does not cache membership across an awaited launch preflight', async () => {
    await assertAutomaticOperationAllowed('/fixture/inside')
    fixture.canvas.positions.inside = { x: 1000, y: 1000 }
    await expect(assertAutomaticOperationAllowed('/fixture/inside')).rejects.toMatchObject({ code: 'automation-frame-off' })
  })

  it('requires the current actual owner for enabled-frame admission while preserving legacy grants', async () => {
    fixture.owner = false
    expect((await readProjectAutomationPolicy('/fixture/inside')).allowed).toBe(true)
    await expect(assertAutomaticOperationAllowed('/fixture/inside')).rejects.toMatchObject({ code: 'automation-frame-off' })
    delete fixture.canvas.automation
    fixture.canvas.elements.forEach((element) => { delete element.groundRole })
    await expect(assertAutomaticOperationAllowed('/fixture/inside')).resolves.toBeUndefined()
  })

  it('does not treat a remaining automation marker without its policy envelope as legacy permission', async () => {
    delete fixture.canvas.automation
    expect(await readProjectAutomationPolicy('/fixture/inside')).toMatchObject({ enabled: true, allowed: false, healthy: true, frameId: null })
  })

  it('does not turn a malformed readable Canvas into legacy permission', async () => {
    fixture.canvas = { ...fixture.canvas, elements: null } as unknown as CanvasState
    delete fixture.canvas.automation
    expect(await readProjectAutomationPolicy('/fixture/inside')).toMatchObject({ enabled: true, allowed: false, healthy: false })
  })

  it('serializes reconciliation without hiding a failed application of persisted policy', async () => {
    fixture.reconcile.mockRejectedValueOnce(new Error('synthetic projection failure'))
    await expect(reconcileAutomationPolicy()).rejects.toThrow('synthetic projection failure')
    await expect(reconcileAutomationPolicy()).resolves.toEqual({ started: [], paused: [], failures: [] })
    expect(fixture.reconcile).toHaveBeenCalledTimes(2)
  })

  it('does not auto-start a legacy Ground from the periodic policy loop', async () => {
    vi.useFakeTimers()
    delete fixture.canvas.automation
    fixture.canvas.elements.forEach((element) => { delete element.groundRole })
    startAutomationPolicyLoop(1000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fixture.reconcile).not.toHaveBeenCalled()
  })

  it('retries enabled policy after a transient failure without overlapping reconciliations', async () => {
    vi.useFakeTimers()
    let release!: () => void
    fixture.reconcile.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ started: [], paused: [], failures: [] }) }))
    startAutomationPolicyLoop(1000)
    await vi.advanceTimersByTimeAsync(0)
    try {
      expect(fixture.reconcile).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(5000)
      expect(fixture.reconcile).toHaveBeenCalledOnce()
    } finally { release() }
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.reconcile).toHaveBeenCalledTimes(2)
  })
})
