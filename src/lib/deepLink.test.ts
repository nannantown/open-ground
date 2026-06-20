import { describe, it, expect } from 'vitest'
import { parseJoinDeepLink } from './deepLink'

// The pure parser for `openground://join?code=…` custom-scheme deep links. It must
// extract a code only from a well-formed join link of OUR scheme, and reject
// everything else (no throws), since it feeds the auto-redeem path.

describe('parseJoinDeepLink', () => {
  it('extracts the code from a host-form join link', () => {
    expect(parseJoinDeepLink('openground://join?code=ABC-123_xyz')).toBe('ABC-123_xyz')
  })

  it('extracts the code from a path-form join link (trailing slash)', () => {
    expect(parseJoinDeepLink('openground://join/?code=tok')).toBe('tok')
  })

  it('extracts the code from the opaque (no //) form', () => {
    expect(parseJoinDeepLink('openground:join?code=tok2')).toBe('tok2')
  })

  it('trims surrounding whitespace on the URL and the code', () => {
    expect(parseJoinDeepLink('  openground://join?code=%20spaced%20  ')).toBe('spaced')
  })

  it('is case-insensitive on the scheme', () => {
    expect(parseJoinDeepLink('OPENGROUND://join?code=tok')).toBe('tok')
  })

  it('keeps a real base64url 256-bit code intact', () => {
    const real = 'aB3-_xY0123456789abcdefghijklmnopqrstuvwxyz'
    expect(parseJoinDeepLink(`openground://join?code=${real}`)).toBe(real)
  })

  it('rejects a foreign scheme', () => {
    expect(parseJoinDeepLink('https://example.com/join?code=tok')).toBeNull()
    expect(parseJoinDeepLink('evil://join?code=tok')).toBeNull()
  })

  it('rejects a non-join action of our scheme', () => {
    expect(parseJoinDeepLink('openground://settings?code=tok')).toBeNull()
    expect(parseJoinDeepLink('openground://open?path=/etc')).toBeNull()
  })

  it('rejects a join link with no code / empty code', () => {
    expect(parseJoinDeepLink('openground://join')).toBeNull()
    expect(parseJoinDeepLink('openground://join?code=')).toBeNull()
    expect(parseJoinDeepLink('openground://join?other=1')).toBeNull()
  })

  it('rejects an absurdly long code (defensive ceiling)', () => {
    expect(parseJoinDeepLink('openground://join?code=' + 'a'.repeat(600))).toBeNull()
  })

  it('rejects non-strings and garbage without throwing', () => {
    expect(parseJoinDeepLink(undefined)).toBeNull()
    expect(parseJoinDeepLink(null)).toBeNull()
    expect(parseJoinDeepLink(42)).toBeNull()
    expect(parseJoinDeepLink('not a url at all')).toBeNull()
    expect(parseJoinDeepLink('')).toBeNull()
  })
})
