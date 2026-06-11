import { describe, it, expect } from 'vitest'
import { deriveCardFields, wantsAutoTitle, MAX_DERIVED_TITLE } from './cardTitle'

describe('deriveCardFields', () => {
  it('single short line: title only, no notes', () => {
    expect(deriveCardFields('Fix the login flow')).toEqual({ title: 'Fix the login flow' })
  })

  it('first line titles, the rest become notes', () => {
    expect(deriveCardFields('Account settings page\nUse the KsTextInputModal.\nAdd email.')).toEqual({
      title: 'Account settings page',
      notes: 'Use the KsTextInputModal.\nAdd email.',
    })
  })

  it('over-long first line: clipped title, FULL text kept as notes', () => {
    const long = 'x'.repeat(100)
    const r = deriveCardFields(`${long}\nmore`)
    expect(r.title).toBe('x'.repeat(MAX_DERIVED_TITLE))
    expect(r.notes).toBe(`${long}\nmore`)
  })

  it('normalizes CRLF and trims surrounding blank lines', () => {
    expect(deriveCardFields('\r\n  Title line\r\nbody\r\n\r\n')).toEqual({
      title: 'Title line',
      notes: 'body',
    })
  })

  it('empty input derives an empty title', () => {
    expect(deriveCardFields('   \n  ')).toEqual({ title: '' })
  })
})

describe('wantsAutoTitle', () => {
  it('multi-line / clipped content wants a summary; a bare short line does not', () => {
    expect(wantsAutoTitle(deriveCardFields('Just one line'))).toBe(false)
    expect(wantsAutoTitle(deriveCardFields('Line one\nline two'))).toBe(true)
    expect(wantsAutoTitle(deriveCardFields('y'.repeat(100)))).toBe(true)
  })
})
