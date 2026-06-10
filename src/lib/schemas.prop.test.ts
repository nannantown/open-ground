import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { ProjectDataSchema, ProjectTaskSchema } from './schemas'

// Property tests for schema robustness. tasks.json / doc.json etc. are read back
// from disk every load; a hand-edited, truncated, or corrupted file must never
// crash the parser. safeParse must always RETURN a verdict (never throw) for
// arbitrary input — that's what keeps a bad file from taking down a project card.

describe('ProjectDataSchema (property: parsing never throws on hostile input)', () => {
  it('safeParse returns a verdict for ANY json value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (anyJson) => {
        const r = ProjectDataSchema.safeParse(anyJson)
        expect(typeof r.success).toBe('boolean')
      }),
    )
  })

  it('safeParse survives deeply nested / huge structures', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(fc.jsonValue(), { maxLength: 50 }),
          fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 30 }),
        ),
        (blob) => {
          expect(() => ProjectDataSchema.safeParse(blob)).not.toThrow()
        },
      ),
    )
  })

  it('a valid ProjectData round-trips through JSON unchanged', () => {
    fc.assert(
      fc.property(
        fc.record({
          description: fc.string(),
          notes: fc.string(),
          updatedAt: fc.string(),
        }),
        (partial) => {
          const valid = { ...partial, tasks: [] }
          const first = ProjectDataSchema.parse(valid)
          const roundTripped = ProjectDataSchema.parse(JSON.parse(JSON.stringify(first)))
          expect(roundTripped).toEqual(first)
        },
      ),
    )
  })
})

describe('ProjectTaskSchema (property: tolerates partial/legacy task rows)', () => {
  it('safeParse never throws on arbitrary json', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (anyJson) => {
        expect(() => ProjectTaskSchema.safeParse(anyJson)).not.toThrow()
      }),
    )
  })
})
