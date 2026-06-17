import { describe, it, expect } from 'vitest'
import { disableNativeModule, enableNativeModule } from './nativeEnable'

describe('disableNativeModule', () => {
  it('adds to an undefined list', () => {
    expect(disableNativeModule(undefined, 'canvas')).toEqual(['canvas'])
  })

  it('appends at the end, preserving prior order', () => {
    expect(disableNativeModule(['canvas'], 'board')).toEqual(['canvas', 'board'])
  })

  it('is idempotent — re-disabling a hidden id changes nothing', () => {
    expect(disableNativeModule(['canvas'], 'canvas')).toEqual(['canvas'])
  })

  it('never mutates the input (always a fresh array)', () => {
    const input = ['canvas']
    const out = disableNativeModule(input, 'board')
    expect(out).not.toBe(input)
    expect(input).toEqual(['canvas'])
  })
})

describe('enableNativeModule', () => {
  it('removes the id', () => {
    expect(enableNativeModule(['canvas', 'board'], 'canvas')).toEqual(['board'])
  })

  it('handles an undefined list (nothing to remove)', () => {
    expect(enableNativeModule(undefined, 'canvas')).toEqual([])
  })

  it('enabling an already-enabled id is a clean no-op on values', () => {
    expect(enableNativeModule(['board'], 'canvas')).toEqual(['board'])
  })

  it('never mutates the input', () => {
    const input = ['canvas', 'board']
    enableNativeModule(input, 'canvas')
    expect(input).toEqual(['canvas', 'board'])
  })
})
