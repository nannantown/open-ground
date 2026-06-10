import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { validateName } from '../_shared'

// Property tests for validateName — the guard on every user-supplied project
// folder name (rename + projects/new). "どんな操作でも" means hostile names too:
// path separators, traversal, control chars, absurd lengths. A name that slips
// through becomes a real folder + a shell/git argument, so the accept set must
// be airtight.

describe('validateName (property: the accept set is airtight)', () => {
  it('an ACCEPTED name never contains a separator, control char, or leading dot', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        if (validateName(name) !== null) return // only reason about accepted names
        // Invariants every accepted name must satisfy — these are what the rest
        // of the system relies on when it mkdir/spawns with the name.
        expect(name.length).toBeGreaterThan(0)
        expect(name.length).toBeLessThanOrEqual(64)
        expect(name.startsWith('.')).toBe(false)
        expect(/[\\/]/.test(name)).toBe(false)
        expect(/[\x00-\x1f]/.test(name)).toBe(false)
        expect(name === '.' || name === '..').toBe(false)
      }),
    )
  })

  it('any name containing "/" or "\\" is ALWAYS rejected', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom('/', '\\'),
        fc.string(),
        (a, sep, b) => {
          expect(validateName(a + sep + b)).not.toBeNull()
        },
      ),
    )
  })

  it('any name with a control character is ALWAYS rejected', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 0, max: 0x1f }).map((n) => String.fromCharCode(n)),
        fc.string(),
        (a, ctrl, b) => {
          expect(validateName(a + ctrl + b)).not.toBeNull()
        },
      ),
    )
  })

  it('empty, traversal, and over-long names are rejected', () => {
    expect(validateName('')).not.toBeNull()
    expect(validateName('.')).not.toBeNull()
    expect(validateName('..')).not.toBeNull()
    fc.assert(
      fc.property(fc.string({ minLength: 65, maxLength: 200 }), (long) => {
        // (a >64 string with no other issue is rejected purely for length)
        if (!/[\\/]/.test(long) && !/[\x00-\x1f]/.test(long) && !long.startsWith('.')) {
          expect(validateName(long)).toMatch(/too long/)
        }
      }),
    )
  })
})
