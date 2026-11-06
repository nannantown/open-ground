import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasState } from '../types'
import { automaticOperationAllowed, assertAutomaticOperationAllowed, readProjectAutomationPolicy, reconcileAutomationPolicy, startAutomationPolicyLoop, stopAutomationPolicyLoop } from './automationPolicy'

const fixture = vi.hoisted(() => ({ canvas: {} as CanvasState, health: 'ok', owner: true, ownerProbe: vi.fn<() => Promise<boolean>>(), canonicalize: vi.fn(async (path: string) => path), projects: [{ id: 'inside', path: '/fixture/inside' }, { id: 'outside', path: '/fixture/outside' }], reconcile: vi.fn(async () => ({ started: [], paused: [], failures: [] })) }))
vi.mock('./store', () => ({ getCanvasWithHealth: async () => ({ value: fixture.canvas, health: fixture.health }), getSettings: async () => ({ projects: fixture.projects }) }))
vi.mock('./swarmOrchestrator', () => ({ reconcileAutomationOrchestrators: () => fixture.reconcile() }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: () => fixture.ownerProbe() }))
vi.mock('./canonicalize', () => ({ canonicalize: (path: string) => fixture.canonicalize(path) }))

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  fixture.health = 'ok'
  fixture.owner = true
  fixture.ownerProbe.mockReset().mockImplementation(async () => fixture.owner)
  fixture.canonicalize.mockReset().mockImplementation(async path => path)
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

  it('rechecks persisted OFF after a delayed owner capability check before granting automatic admission', async () => {
    fixture.canvas = { ...fixture.canvas,
      automation: { version: 2, revision: 1, enabled: true, frameIds: ['auto'] },
      elements: fixture.canvas.elements.map(({ groundRole: _role, ...element }) => element) }
    const entered = deferred<void>(), auth = deferred<boolean>()
    fixture.ownerProbe.mockImplementationOnce(() => { entered.resolve(); return auth.promise })
    const allowed = automaticOperationAllowed('/fixture/inside')
    await entered.promise
    fixture.canvas = { ...fixture.canvas, automation: { version: 2, revision: 2, enabled: true, frameIds: [] } }
    auth.resolve(true)
    expect(await allowed).toBe(false)
  })

  it('reads authoritative membership after awaited project identity resolution observes a move OFF', async () => {
    const entered = deferred<void>(), identity = deferred<void>()
    fixture.canonicalize.mockImplementationOnce(async path => { entered.resolve(); await identity.promise; return path })
    const policy = readProjectAutomationPolicy('/fixture/inside')
    await entered.promise
    fixture.canvas = { ...fixture.canvas, positions: { ...fixture.canvas.positions, inside: { x: 1000, y: 1000 } } }
    identity.resolve()
    expect(await policy).toMatchObject({ enabled: true, allowed: false })
  })

  it('reads the union of normal ON frames and preserves all-OFF authority after the last switch turns off', async () => {
    fixture.canvas.automation = { version: 2, revision: 3, enabled: true, frameIds: ['auto', 'other'] }
    fixture.canvas.elements.forEach(element => { delete element.groundRole })
    fixture.canvas.elements.push({ id: 'other', type: 'frame', text: 'Other', x: 800, y: 0, width: 500, height: 400 })
    fixture.canvas.positions.outside.y = 10
    expect(await readProjectAutomationPolicy('/fixture/inside')).toMatchObject({ enabled: true, allowed: true, frameId: null })
    expect(await readProjectAutomationPolicy('/fixture/outside')).toMatchObject({ enabled: true, allowed: true, frameId: null })
    fixture.canvas.elements[0].hidden = true
    expect((await readProjectAutomationPolicy('/fixture/inside')).allowed).toBe(false)
    expect(await readProjectAutomationPolicy('/fixture/outside')).toMatchObject({ allowed: true, frameId: 'other' })
    fixture.canvas.automation.frameIds = []
    expect(await readProjectAutomationPolicy('/fixture/outside')).toMatchObject({ enabled: true, allowed: false, frameId: null })
    await expect(assertAutomaticOperationAllowed('/fixture/outside')).rejects.toMatchObject({ code: 'automation-frame-off' })
  })

  it('requires the current actual owner for enabled-frame admission while preserving legacy grants', async () => {
    fixture.owner = false
    expect((await readProjectAutomationPolicy('/fixture/inside')).allowed).toBe(true)
    await expect(assertAutomaticOperationAllowed('/fixture/inside')).rejects.toMatchObject({ code: 'automation-frame-off' })
    delete fixture.canvas.automation
    fixture.canvas.elements.forEach((element) => { delete element.groundRole })
    fixture.ownerProbe.mockClear()
    await expect(assertAutomaticOperationAllowed('/fixture/inside')).resolves.toBeUndefined()
    expect(fixture.ownerProbe).not.toHaveBeenCalled()
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

  it('reconciles explicit all-OFF and malformed policy without mistaking either for a legacy opt-out', async () => {
    vi.useFakeTimers()
    fixture.canvas.automation = { version: 2, revision: 1, enabled: true, frameIds: [] }
    fixture.canvas.elements.forEach(element => { delete element.groundRole })
    startAutomationPolicyLoop(1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.reconcile).toHaveBeenCalledOnce()
    fixture.canvas.automation = { version: 2, enabled: false } as unknown as CanvasState['automation']
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.reconcile).toHaveBeenCalledTimes(2)
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
