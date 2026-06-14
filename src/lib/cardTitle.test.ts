import { describe, it, expect } from 'vitest'
import {
  deriveCardFields,
  wantsAutoTitle,
  provisionalTitle,
  MAX_DERIVED_TITLE,
} from './cardTitle'

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

describe('provisionalTitle', () => {
  it('takes the first non-empty line WITHOUT consuming the content', () => {
    // Unlike deriveCardFields, the body is not returned — the caller keeps the
    // whole content as notes; this only yields a stopgap heading.
    expect(provisionalTitle('Add the login button\nand wire it to /auth')).toBe(
      'Add the login button',
    )
  })

  it('single line', () => {
    expect(provisionalTitle('Just one line')).toBe('Just one line')
  })

  it('clips an over-long first line to MAX_DERIVED_TITLE', () => {
    const long = 'z'.repeat(100)
    expect(provisionalTitle(long)).toBe('z'.repeat(MAX_DERIVED_TITLE))
  })

  it('normalizes CRLF and trims leading blank lines', () => {
    expect(provisionalTitle('\r\n  First\r\nsecond')).toBe('First')
  })

  it('empty / blank content yields an empty string', () => {
    expect(provisionalTitle('')).toBe('')
    expect(provisionalTitle('   \n  ')).toBe('')
  })
})
