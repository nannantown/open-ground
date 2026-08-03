import { describe, it, expect } from 'vitest'
import { parseResetLabel } from './swarmQuota'

// ─── the reset label the CLI ACTUALLY prints ─────────────────────────────────
//
// THE MISPARSE (overnight review 2026-08-04). The absolute-date branch dropped
// the timezone and collapsed " at ", then handed the rest to Date.parse — which
// does not understand "3pm". So the CLI's own weekly-reset wording,
// "May 25 at 3pm (Asia/Tokyo)", became NaN and the parse returned null: a limit
// DAYS away fell through to the flat 20-minute grace, and the engine re-launched
// workers into a dry tier every 20 minutes until the real reset.
//
// The branch's existing test fed an ISO-8601 string — a shape production never
// emits — so it was green throughout. That is the trap 掟2 names: a fixture that
// is easier than reality tests the fixture. Every case here is a literal the
// CLI prints, and the year-relative ones are computed from a FIXED `now` so the
// suite cannot rot into a date-dependent flake.

const NOW = Date.parse('2026-05-20T02:00:00Z')

describe('parseResetLabel — real CLI wordings', () => {
  it('parses the weekly absolute label with a 12-hour time (the miss)', () => {
    const ms = parseResetLabel('May 25 at 3pm (Asia/Tokyo)', NOW)
    expect(ms).not.toBeNull()
    // …and it lands DAYS out, not the 20-minute grace the failure produced.
    expect(ms! - NOW).toBeGreaterThan(3 * 24 * 60 * 60_000)
  })

  it('handles am/12am/12pm and minutes', () => {
    const at = (label: string) => new Date(parseResetLabel(label, NOW)!)
    expect(at('May 25 at 3pm').getHours()).toBe(15)
    expect(at('May 25 at 9am').getHours()).toBe(9)
    expect(at('May 25 at 12am').getHours()).toBe(0)
    expect(at('May 25 at 12pm').getHours()).toBe(12)
    const withMin = at('May 25 at 3:30pm')
    expect(withMin.getHours()).toBe(15)
    expect(withMin.getMinutes()).toBe(30)
  })

  it('still parses a plain 24-hour absolute date (no regression)', () => {
    expect(parseResetLabel('May 25 15:00', NOW)).not.toBeNull()
  })

  it('a date that lands in the PAST is refused — stale text is not evidence', () => {
    // Same stance as the bare-clock branch: never cool until a moment already gone.
    expect(parseResetLabel('May 1 at 3pm', NOW)).toBeNull()
  })

  it('relative and bare-clock branches are untouched', () => {
    expect(parseResetLabel('in 30 minutes', NOW)).toBe(NOW + 30 * 60_000)
    expect(parseResetLabel('nonsense', NOW)).toBeNull()
  })
})
