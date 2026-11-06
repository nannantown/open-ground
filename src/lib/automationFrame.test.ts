import { describe, expect, it } from 'vitest'
import type { CanvasState } from './types'
import { automationFrameMembership, createAutomationFrame, configuredFrameIds, isAutomationAllowed, isFrameAutomationOn, setFrameAutomation } from './automationFrame'
import { cloneSubset } from './canvasClone'

const canvas = (): CanvasState => ({
  positions: { inside: { x: 100, y: 100 }, outside: { x: 800, y: 100 } },
  viewport: { x: 0, y: 0, zoom: 1 },
  automation: { version: 1, revision: 0, enabled: true, frameId: 'auto' },
  elements: [{ id: 'auto', type: 'frame', groundRole: 'automation', text: '自動運用', x: 0, y: 0, width: 600, height: 400 }],
})

const multiFrame = (): CanvasState => ({
  positions: { first: { x: 20, y: 20 }, second: { x: 820, y: 20 }, outside: { x: 1600, y: 20 } },
  viewport: { x: 0, y: 0, zoom: 1 },
  automation: { version: 2, revision: 4, enabled: true, frameIds: ['first-frame', 'second-frame'] },
  elements: [
    { id: 'first-frame', type: 'frame', text: 'First', x: 0, y: 0, width: 500, height: 400 },
    { id: 'second-frame', type: 'frame', text: 'Second', x: 800, y: 0, width: 500, height: 400 },
  ],
} as unknown as CanvasState)

describe('normal frames share an explicit ON allowlist', () => {
  it('migrates the first explicit toggle without losing the previous dedicated ON frame or writing during reads', () => {
    const legacy = canvas()
    legacy.elements.push({ id: 'ordinary', type: 'frame', text: 'Ordinary', x: 800, y: 0, width: 500, height: 400 })
    const before = JSON.stringify(legacy)
    expect(configuredFrameIds(legacy)).toEqual(['auto'])
    expect(isFrameAutomationOn(legacy, 'ordinary')).toBe(false)
    expect(JSON.stringify(legacy)).toBe(before)
    const migrated = setFrameAutomation(legacy, 'ordinary', true)
    expect(migrated.automation).toEqual({ version: 2, revision: 0, enabled: true, frameIds: ['auto', 'ordinary'] })
    expect(migrated.elements.every(element => !element.groundRole)).toBe(true)
    expect(isAutomationAllowed(migrated, 'inside')).toBe(true)
    expect(isAutomationAllowed(migrated, 'outside')).toBe(true)
    expect(JSON.stringify(legacy)).toBe(before)
    const one = setFrameAutomation(migrated, 'auto', false)
    expect(configuredFrameIds(one)).toEqual(['ordinary'])
    expect(isAutomationAllowed(one, 'inside')).toBe(false)
  })

  it('keeps ordinary and cloned frames OFF and uses the configured ID list rather than a copied element flag', () => {
    const state = multiFrame()
    const copy = cloneSubset(state.elements, new Set(['first-frame']), () => 'clone')!
    const cloned = { ...state, elements: [...state.elements, ...copy.clones] }
    expect(isFrameAutomationOn(cloned, 'clone')).toBe(false)
    expect(configuredFrameIds(cloned)).toEqual(['first-frame', 'second-frame'])
    const enabled = setFrameAutomation(cloned, 'clone', true)
    expect(isFrameAutomationOn(enabled, 'clone')).toBe(true)
    const off = setFrameAutomation(setFrameAutomation(setFrameAutomation(enabled, 'clone', false), 'first-frame', false), 'second-frame', false)
    expect(off.automation).toEqual({ version: 2, revision: 4, enabled: true, frameIds: [] })
    expect(isAutomationAllowed(off, 'first')).toBe(false)
  })

  it('migrates an explicitly disabled legacy setting only when a switch is used', () => {
    const state = multiFrame(); delete state.automation
    state.automation = { version: 1, revision: 7, enabled: false, frameId: null }
    expect(isAutomationAllowed(state, 'outside')).toBe(true)
    const optedIn = setFrameAutomation(state, 'first-frame', false)
    expect(optedIn.automation).toEqual({ version: 2, revision: 7, enabled: true, frameIds: [] })
    expect(isAutomationAllowed(optedIn, 'outside')).toBe(false)
  })

  it('admits the union of visible ON frames while keeping outside projects OFF', () => {
    const state = multiFrame()
    const membership = automationFrameMembership(state, ['first', 'second', 'outside'])
    expect(Array.from(membership.projectIds)).toEqual(['first', 'second'])
    expect(membership.frameId).toBeNull()
    expect(isAutomationAllowed(state, 'outside')).toBe(false)
  })

  it('does not let a hidden or deleted ON frame revoke another valid ON frame', () => {
    const state = multiFrame()
    state.elements[0].hidden = true
    expect(Array.from(automationFrameMembership(state, ['first', 'second']).projectIds)).toEqual(['second'])
    expect(automationFrameMembership(state, []).frameId).toBe('second-frame')
    state.elements = state.elements.slice(1)
    expect(isAutomationAllowed(state, 'second')).toBe(true)
    expect(isAutomationAllowed(state, 'first')).toBe(false)
  })

  it('keeps an explicit empty list OFF and rejects malformed V2 authority', () => {
    for (const policy of [
      { version: 2, revision: 4, enabled: true, frameIds: [] },
      { version: 2, revision: 4, enabled: true, frameIds: ['first-frame', 'first-frame'] },
      { version: 2, revision: 4, enabled: false, frameIds: ['first-frame'] },
      { version: 2, revision: 4, enabled: true, frameIds: 'first-frame' },
      { version: 2, revision: 4, enabled: true, frameIds: ['first-frame'], frameId: 'first-frame' },
    ]) {
      const state = multiFrame(); state.automation = policy as CanvasState['automation']
      expect(automationFrameMembership(state, ['first']).enabled).toBe(true)
      expect(isAutomationAllowed(state, 'first')).toBe(false)
    }
  })

  it('unions overlapping/nested ON frames without duplicate project admission and ignores invalid frame geometry independently', () => {
    const state = multiFrame()
    state.elements[1] = { ...state.elements[1], x: 10, y: 10 }
    expect(Array.from(automationFrameMembership(state, ['first', 'first']).projectIds)).toEqual(['first'])
    state.elements[0].rotation = Number.NaN
    expect(isAutomationAllowed(state, 'first')).toBe(true)
    expect(automationFrameMembership(state, []).frameId).toBe('second-frame')
    expect(setFrameAutomation(state, 'not-a-frame', true)).toBe(state)
  })
})

describe('the dedicated Ground automation frame', () => {
  it('uses the persisted singleton role and card centre, including nested decorative frames', () => {
    const state = canvas()
    state.elements.push({ id: 'nested', type: 'frame', text: 'nested', x: 90, y: 90, width: 300, height: 200 })
    state.elements[0].text = 'Renamed'
    expect(Array.from(automationFrameMembership(state, ['inside', 'outside']).projectIds)).toEqual(['inside'])
    expect(isAutomationAllowed(state, 'outside')).toBe(false)
  })

  it('changes membership on card move and frame resize, with the rendered 256×140 centre', () => {
    const state = canvas()
    state.positions.edge = { x: -128, y: -70 }
    expect(isAutomationAllowed(state, 'edge')).toBe(true)
    state.positions.edge.y -= 1
    expect(isAutomationAllowed(state, 'edge')).toBe(false)
    state.elements[0].width = 200
    expect(isAutomationAllowed(state, 'inside')).toBe(false)
    state.elements[0].width = 600
    state.positions.inside.x = 700
    expect(isAutomationAllowed(state, 'inside')).toBe(false)
  })

  it('keeps an enabled empty allowlist after deletion, hiding, mismatched role, or duplicate roles', () => {
    for (const mutate of [
      (state: CanvasState) => { state.elements = [] },
      (state: CanvasState) => { state.elements[0].hidden = true },
      (state: CanvasState) => { state.elements[0].opacity = 0 },
      (state: CanvasState) => { state.elements[0].opacity = -1 },
      (state: CanvasState) => {
        state.elements[0].parentId = 'hidden-group'
        state.elements.push({ id: 'hidden-group', type: 'group', text: '', x: 0, y: 0, hidden: true })
      },
      (state: CanvasState) => { state.automation!.frameId = 'other' },
      (state: CanvasState) => { state.elements.push({ ...state.elements[0], id: 'duplicate' }) },
      (state: CanvasState) => { state.elements.push({ id: 'auto', type: 'text', text: 'duplicate ID', x: 0, y: 0 }) },
      (state: CanvasState) => { state.elements[0].rotation = Number.NaN },
    ]) {
      const state = canvas()
      mutate(state)
      expect(automationFrameMembership(state, ['inside']).enabled).toBe(true)
      expect(isAutomationAllowed(state, 'inside')).toBe(false)
    }
  })

  it('matches the visible rotated frame rather than its unrotated rectangle', () => {
    const state = canvas()
    state.elements[0].rotation = 90
    state.positions.rotatedOnly = { x: 300 - 128, y: 450 - 70 }
    state.positions.unrotatedOnly = { x: 550 - 128, y: 200 - 70 }
    expect(isAutomationAllowed(state, 'rotatedOnly')).toBe(true)
    expect(isAutomationAllowed(state, 'unrotatedOnly')).toBe(false)
  })

  it('leaves legacy and explicitly disabled policy under manual control', () => {
    const state = canvas()
    delete state.automation
    delete state.elements[0].groundRole
    expect(isAutomationAllowed(state, 'outside')).toBe(true)
    state.automation = { version: 1, revision: 0, enabled: false, frameId: null }
    expect(isAutomationAllowed(state, 'outside')).toBe(true)
  })

  it('does not mistake an orphan role marker or malformed policy for legacy opt-out', () => {
    const state = canvas()
    delete state.automation
    expect(automationFrameMembership(state, ['inside']).enabled).toBe(true)
    expect(isAutomationAllowed(state, 'inside')).toBe(false)
    for (const policy of [null, { version: 2, enabled: false }, { version: 1, revision: -1, enabled: false, frameId: null }]) {
      state.automation = policy as CanvasState['automation']
      expect(isAutomationAllowed(state, 'inside')).toBe(false)
    }
  })

  it('creates an empty dedicated frame without moving existing cards and survives JSON reload', () => {
    const state = canvas()
    delete state.automation
    state.elements = []
    const created = createAutomationFrame(state, 'new', '自動運用')
    expect(created.positions).toEqual(state.positions)
    expect(created.automation).toEqual({ version: 1, revision: 0, enabled: true, frameId: 'new' })
    expect(automationFrameMembership(JSON.parse(JSON.stringify(created)), ['inside', 'outside']).projectIds.size).toBe(0)
    expect(createAutomationFrame(created, 'second', 'second')).toBe(created)
  })

  it('does not copy execution authority when an automation frame is duplicated', () => {
    const state = canvas()
    const result = cloneSubset(state.elements, new Set(['auto']), () => 'copy')!
    expect(result.clones[0].groundRole).toBeUndefined()
    expect(automationFrameMembership({ ...state, elements: [...state.elements, ...result.clones] }, ['inside']).projectIds.has('inside')).toBe(true)
  })
})
