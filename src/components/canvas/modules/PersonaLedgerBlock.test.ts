// PersonaLedgerBlock — the pure half, plus the STRUCTURAL guard that ties the
// screen's vocabulary to the server's.
//
// The rendering contract lives in PersonaModule.test.tsx (the block only ever
// appears inside that screen). What is tested here is the part that decides
// WHETHER a body may reach the render path at all, and the part that turns the
// store's slugs into words — both of which fail silently when they fail:
//
//   • isPersonaLedger — a 200 that is not a ledger blanked this screen once
//     already (the portrait, 2026-08-14). "Not a ledger" and "never read" must
//     be the same state, and the check is what makes them one.
//   • the label maps — a verdict with no message key reaches the owner as
//     `persona.ledger.verdict.<slug>` (t() falls back to the key), so a member
//     added to the server union must fail HERE rather than on the owner's
//     screen. The union is PARSED out of src/lib/types.ts, not imported: a TS
//     type has no runtime representation, so importing it would guard nothing.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isPersonaLedger,
  ledgerConfidenceKey,
  ledgerProjectLabel,
  ledgerWhyKey,
} from './PersonaLedgerBlock'
import { messages } from '@/i18n/messages'

const TYPES_PATH = path.join(process.cwd(), 'src/lib/types.ts')

/** Members of `export type <Name> = 'a' | 'b' | …`, read from the contract file
 *  itself so a new member is picked up without anyone remembering to update a
 *  list here. */
const readUnion = (name: string): string[] => {
  const src = readFileSync(TYPES_PATH, 'utf8')
  const decl = `export type ${name} =`
  const start = src.indexOf(decl)
  expect(
    start,
    `${name} not found in src/lib/types.ts — did it move or get renamed?`,
  ).toBeGreaterThan(-1)
  // From the `=` (never from the doc comment above it, whose prose quotes these
  // very names) to the end of the declaration.
  const rest = src.slice(start + decl.length)
  const cut = rest.search(/\n\s*\n|\n\/\*\*|\nexport /)
  const body = cut > -1 ? rest.slice(0, cut) : rest
  return Array.from(body.matchAll(/'([^']+)'/g), (m) => m[1])
}

const readVerdictUnion = (): string[] => readUnion('PersonaLedgerVerdict')
const readWhyUnion = (): string[] => readUnion('PersonaLedgerWhy')

const bothLocales = (key: string) =>
  typeof messages.en[key] === 'string' && typeof messages.ja[key] === 'string'

const ledgerBody = () => ({
  summary: {
    week: { answered: 1, asked: 0, abstained: 0 },
    total: { answered: 4, asked: 2, abstained: 1 },
    lastAt: '2026-08-12T09:00:00.000Z',
  },
  recent: [],
})

describe('isPersonaLedger — what may reach the render path', () => {
  it('accepts what the route actually sends', () => {
    expect(isPersonaLedger(ledgerBody())).toBe(true)
  })

  it('rejects the bodies an older or broken server sends instead', () => {
    // `{}` is the exact body App.render's fetch stub answers with, and what any
    // server without this route returns from a catch-all.
    for (const body of [null, undefined, {}, [], 'ok', 42, { recent: [] }, { summary: {} }])
      expect(isPersonaLedger(body), JSON.stringify(body ?? null)).toBe(false)
  })

  it('rejects a summary whose counts are not numbers', () => {
    const bad = ledgerBody()
    ;(bad.summary.week as unknown as Record<string, unknown>).asked = '2'
    expect(isPersonaLedger(bad)).toBe(false)
  })

  it('rejects a ledger with no `recent` array — the detail list reaches into it', () => {
    const { summary } = ledgerBody()
    expect(isPersonaLedger({ summary })).toBe(false)
  })
})

describe('what a row is allowed to show', () => {
  it('reduces a project path to its folder name', () => {
    expect(ledgerProjectLabel('/Users/me/dev/billing-api')).toBe('billing-api')
    expect(ledgerProjectLabel('/Users/me/dev/billing-api/')).toBe('billing-api')
    expect(ledgerProjectLabel('C:\\Users\\nami\\dev\\billing-api')).toBe('billing-api')
    expect(ledgerProjectLabel('')).toBe('')
  })

  it('maps a reason class to a message key, and an unknown one to nothing', () => {
    expect(ledgerWhyKey('irreversible')).toBe('persona.ledger.why.irreversible')
    expect(ledgerWhyKey('insufficient-info')).toBe('persona.ledger.why.insufficient-info')
    expect(ledgerWhyKey('policy')).toBe('persona.ledger.why.policy')
    // A slug the owner cannot read is worse than the verdict alone.
    expect(ledgerWhyKey('quantum')).toBeNull()
    expect(ledgerWhyKey(undefined)).toBeNull()
    expect(ledgerWhyKey('')).toBeNull()
  })

  it('maps confidence the same way', () => {
    expect(ledgerConfidenceKey('high')).toBe('persona.ledger.confidence.high')
    expect(ledgerConfidenceKey('medium')).toBe('persona.ledger.confidence.medium')
    expect(ledgerConfidenceKey('low')).toBe('persona.ledger.confidence.low')
    expect(ledgerConfidenceKey('certain')).toBeNull()
    expect(ledgerConfidenceKey(undefined)).toBeNull()
  })
})

describe('the ledger vocabulary vs the server contract', () => {
  it('parses a plausible verdict union out of types.ts (the parser is load-bearing)', () => {
    // A parser that silently returns [] makes the coverage test below pass
    // vacuously — the "guard that guards nothing" shape.
    const members = readVerdictUnion()
    expect(members.length).toBeGreaterThanOrEqual(3)
    expect(members).toContain('answered')
    expect(members).toContain('abstained')
    expect(new Set(members).size).toBe(members.length)
  })

  it('names EVERY verdict in both languages — a new one must not reach the owner as a slug', () => {
    // t() falls back to the KEY, so a missing entry ships
    // `persona.ledger.verdict.<slug>` onto the screen.
    const missing = readVerdictUnion().filter((v) => !bothLocales(`persona.ledger.verdict.${v}`))
    expect(missing, `verdicts with no label: ${missing.join(', ')}`).toEqual([])
    // The block's own inline labels are a separate set (lowercase, mid-line in
    // English) and are just as load-bearing.
    const missingInline = readVerdictUnion().filter((v) => !bothLocales(`persona.ledger.${v}`))
    expect(missingInline, `verdicts with no count label: ${missingInline.join(', ')}`).toEqual([])
  })

  it('parses a plausible reason-class union out of types.ts (the parser is load-bearing)', () => {
    // Same self-check as the verdicts: a parser that returns [] would make the
    // coverage test below pass while checking nothing.
    const members = readWhyUnion()
    expect(members.length).toBeGreaterThanOrEqual(3)
    expect(members).toContain('irreversible')
    expect(members).toContain('insufficient-info')
    expect(new Set(members).size).toBe(members.length)
  })

  it('names EVERY reason class in both languages — DERIVED from the union, not listed', () => {
    // `why` is a union (2026-08-14), so this is derived rather than transcribed:
    // a fourth class fails the build at WHY_KEY's exhaustive Record AND, if
    // someone adds the key but no wording, fails here.
    const missing = readWhyUnion().filter((w) => !bothLocales(`persona.ledger.why.${w}`))
    expect(missing, `reason classes with no label: ${missing.join(', ')}`).toEqual([])
    // …and each one really resolves through the production mapper.
    for (const w of readWhyUnion()) expect(ledgerWhyKey(w)).toBe(`persona.ledger.why.${w}`)
  })

  it('names every confidence level and every fixed line in both languages', () => {
    // LISTED, not derived: `confidence` mirrors OwnerAnswer's own literals and the
    // rest are fixed copy — this list is the contract's prose, written down where
    // a test can hold it.
    const keys = [
      'persona.ledger.confidence.high',
      'persona.ledger.confidence.medium',
      'persona.ledger.confidence.low',
      'persona.ledger.label',
      'persona.ledger.week',
      'persona.ledger.empty',
      'persona.ledger.last',
      'persona.ledger.detail.heading',
      'persona.ledger.ownerAnswered',
    ]
    expect(keys.filter((k) => !bothLocales(k))).toEqual([])
  })

  it('keeps the owner-facing lines free of the store’s internals', () => {
    // The screen's premise is that it never says anything it cannot evidence —
    // and never anything the owner did not ask to see. `key` is a join column;
    // the reason classes are slugs. Neither may leak into the copy itself.
    const ledgerCopy = (['en', 'ja'] as const).flatMap((lang) =>
      Object.entries(messages[lang])
        .filter(([k]) => k.startsWith('persona.ledger.'))
        .map(([k, v]) => ({ where: `${lang}:${k}`, text: String(v) })),
    )
    // Self-check: an empty sweep is the same colour as a clean one.
    expect(ledgerCopy.length).toBeGreaterThanOrEqual(30)
    for (const slug of ['insufficient-info', 'projectPath', 'abstained', 'byOwner'])
      expect(
        ledgerCopy.filter((c) => c.text.includes(slug)).map((c) => c.where),
        `${slug} appears in owner-facing copy`,
      ).toEqual([])
  })
})
