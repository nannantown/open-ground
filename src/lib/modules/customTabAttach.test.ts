import { describe, it, expect } from 'vitest'
import { attachCustomTab, detachCustomTab } from './customTabAttach'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'

describe('attachCustomTab', () => {
  it('appends to an undefined list', () => {
    expect(attachCustomTab(undefined, A)).toEqual([A])
  })

  it('appends at the end, preserving prior order', () => {
    expect(attachCustomTab([A], B)).toEqual([A, B])
  })

  it('is idempotent — re-attaching an attached id changes nothing', () => {
    expect(attachCustomTab([A, B], A)).toEqual([A, B])
  })

  it('never mutates the input (always a fresh array)', () => {
    const input = [A]
    const out = attachCustomTab(input, A)
    expect(out).not.toBe(input)
    expect(input).toEqual([A])
    const out2 = attachCustomTab(input, B)
    expect(input).toEqual([A])
    expect(out2).toEqual([A, B])
  })
})

describe('detachCustomTab', () => {
  it('removes the id from customTabs and its custom:<id> from tabOrder', () => {
    const res = detachCustomTab(
      { customTabs: [A, B], tabOrder: ['board', `custom:${A}`, 'terminal', `custom:${B}`] },
      A,
    )
    expect(res.customTabs).toEqual([B])
    expect(res.tabOrder).toEqual(['board', 'terminal', `custom:${B}`])
  })

  it('keeps tabOrder undefined when the project never saved one', () => {
    const res = detachCustomTab({ customTabs: [A] }, A)
    expect(res.customTabs).toEqual([])
    expect(res.tabOrder).toBeUndefined()
  })

  it('detaching an unattached id is a clean no-op on values', () => {
    const res = detachCustomTab(
      { customTabs: [B], tabOrder: ['board', `custom:${B}`] },
      A,
    )
    expect(res.customTabs).toEqual([B])
    expect(res.tabOrder).toEqual(['board', `custom:${B}`])
  })

  it('does not touch the bare uuid inside tabOrder (only the custom:<id> form)', () => {
    // A pathological saved order holding a bare uuid must survive — detach
    // only owns the `custom:` namespace.
    const res = detachCustomTab({ customTabs: [A], tabOrder: [A, `custom:${A}`] }, A)
    expect(res.tabOrder).toEqual([A])
  })

  it('never mutates the input arrays', () => {
    const data = { customTabs: [A], tabOrder: [`custom:${A}`] }
    detachCustomTab(data, A)
    expect(data.customTabs).toEqual([A])
    expect(data.tabOrder).toEqual([`custom:${A}`])
  })
})
