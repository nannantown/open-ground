import { describe, expect, it } from 'vitest'
import { localAppUrl, NENE_ORIGIN } from './localAppFrame'

describe('local application capability', () => {
  it('only resolves the explicit NENE integration on a distinct origin', () => {
    expect(localAppUrl({}, 'http://localhost:5175')).toBeNull()
    expect(localAppUrl({ localApp: 'nene-songs' }, NENE_ORIGIN)).toBeNull()
    expect(localAppUrl({ localApp: 'nene-songs' }, 'http://127.0.0.1:5175')).toBe(`${NENE_ORIGIN}/`)
    expect(localAppUrl({ localApp: 'https://example.com' as 'nene-songs' }, 'http://localhost:5175')).toBeNull()
  })
})
