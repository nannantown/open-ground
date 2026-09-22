// Guards for scripts/fuel-mark.ts — the before/after fuel reading.
//
// WHY THIS FILE EXISTS. The owner asked whether I could catch the numbers
// myself instead of having them copied out of a popover. From a cloud session I
// cannot (different machine), but a local session can — and then the arithmetic
// is what decides whether a trial is kept. Two ways it could lie quietly:
//
//   • summing the wrong thing, so a card that ran on a different model tier
//     looks like an effect of the directive;
//   • subtracting two readings that are further apart than the breakdown's
//     MOVING window, where the earlier cards have aged out and the difference
//     silently understates — it can even come out negative and read as a win.
//
// Both are pinned here, and each was measured RED against a mutated source.

import { describe, it, expect } from 'vitest'
import { diffMarks, summarize, type Breakdown, type Mark } from '../../scripts/fuel-mark'

const bd = (rows: [string, string, number][], total: number, days = 7): Breakdown => ({
  days,
  total,
  rows: rows.map(([model, source, tokens]) => ({ model, source, tokens })),
})

describe('summarize', () => {
  it('sums a role ACROSS models, so a tier change is not read as an effect', () => {
    const m = summarize(
      bd(
        [
          ['claude-opus-5', 'swarm-worker', 100],
          ['claude-fable-5-1', 'swarm-worker', 250],
          ['claude-opus-5', 'manager', 40],
        ],
        390,
      ),
    )
    expect(m.byRole['swarm-worker']).toBe(350)
    expect(m.byRole.manager).toBe(40)
  })

  it("takes total from the API, not from re-summing the rows", () => {
    // The rows are only the NON-ZERO ones; the API owns the denominator.
    const m = summarize(bd([['claude-opus-5', 'swarm-worker', 10]], 999))
    expect(m.total).toBe(999)
  })

  it('ignores a row with a non-numeric token count rather than producing NaN', () => {
    const broken = { days: 7, total: 10, rows: [{ model: 'x', source: 'swarm-worker', tokens: 'lots' }] }
    const m = summarize(broken as unknown as Breakdown)
    expect(m.byRole['swarm-worker']).toBeUndefined()
    expect(Number.isNaN(m.total)).toBe(false)
  })

  it('keeps the label and the window so a later diff can check both', () => {
    const m = summarize(bd([], 0, 3), 'before-off')
    expect(m.label).toBe('before-off')
    expect(m.days).toBe(3)
  })
})

describe('diffMarks', () => {
  const mk = (at: string, worker: number, label = '', days = 7): Mark => ({
    at,
    label,
    days,
    total: worker,
    byRole: { 'swarm-worker': worker },
  })

  it('gives the per-card figure the trial is judged on', () => {
    const d = diffMarks(mk('2026-09-22T01:00:00Z', 1_000, 'A'), mk('2026-09-22T05:00:00Z', 7_000, 'B'), 6)
    expect(d.delta['swarm-worker']).toBe(6_000)
    expect(d.perCard['swarm-worker']).toBe(1_000)
    expect(d.windowRisk).toBe(false)
  })

  it('FLAGS readings taken further apart than the moving window', () => {
    // 10 days apart on a 7-day window: the earlier cards have aged out of the
    // later reading, so the subtraction understates. Without the flag this
    // reads as a large saving.
    const d = diffMarks(mk('2026-09-01T00:00:00Z', 9_000, 'A'), mk('2026-09-11T00:00:00Z', 9_100, 'B'), 6)
    expect(d.windowRisk).toBe(true)
  })

  it('does not flag a reading pair inside the window', () => {
    const d = diffMarks(mk('2026-09-01T00:00:00Z', 1, 'A'), mk('2026-09-06T00:00:00Z', 2, 'B'), 6)
    expect(d.windowRisk).toBe(false)
  })

  it('covers a role that appears in only one of the two readings', () => {
    const a: Mark = { at: '2026-09-22T01:00:00Z', label: 'A', days: 7, total: 10, byRole: { manager: 10 } }
    const b: Mark = {
      at: '2026-09-22T02:00:00Z',
      label: 'B',
      days: 7,
      total: 40,
      byRole: { manager: 10, 'swarm-worker': 30 },
    }
    const d = diffMarks(a, b, 3)
    expect(d.delta['swarm-worker']).toBe(30)
    expect(d.delta.manager).toBe(0)
    expect(d.perCard['swarm-worker']).toBe(10)
  })

  it('omits perCard when no card count was given, rather than dividing by zero', () => {
    const d = diffMarks(mk('2026-09-22T01:00:00Z', 1_000), mk('2026-09-22T02:00:00Z', 4_000), 0)
    expect(d.delta['swarm-worker']).toBe(3_000)
    expect(d.perCard['swarm-worker']).toBeUndefined()
  })

  it('reports a NEGATIVE delta as negative — never as an absolute saving', () => {
    // Fuel going DOWN between two readings means the window rotated, not that
    // cards refunded tokens. Hiding the sign would turn that into a fake win.
    const d = diffMarks(mk('2026-09-22T01:00:00Z', 9_000), mk('2026-09-22T02:00:00Z', 4_000), 6)
    expect(d.delta['swarm-worker']).toBe(-5_000)
    expect(d.perCard['swarm-worker']).toBeLessThan(0)
  })
})
