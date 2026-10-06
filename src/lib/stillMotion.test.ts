import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// "Still" has ONE look (rework M1, 2026-10-06): globals.css draws it under
// html[data-motion='still'], which src/lib/presence.ts sets both for the OS
// "reduce motion" setting and while nobody is looking. Two ways this rots:
//   1. a reduce-motion rule written in an @media block again — then the
//      away-look and the reduce-motion look can drift apart;
//   2. a new looping animation with no still rule — presence then pauses it at
//      its first frame, which may not be its resting look.
// Both are caught here from the stylesheet itself (an over-approximation: any
// rule with an `infinite` animation must have a still twin).

const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')

const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({
  selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
  body: m[2],
}))

const STILL = "html[data-motion='still']"

describe('the still look has one source', () => {
  it('writes no reduce-motion rules in an @media block (they live under data-motion="still")', () => {
    expect(css).not.toMatch(/prefers-reduced-motion/)
  })

  // MUTATION that turns this red: delete `.run-pulse` from the still rule.
  it('gives every looping animation a still rule', () => {
    const looping = rules
      .filter((r) => /animation\s*:[^;]*\binfinite\b/.test(r.body))
      .flatMap((r) => r.selectors)
      .filter((s) => !s.startsWith(STILL))
    expect(looping.length).toBeGreaterThan(5) // the parse found the loops
    const stilled = new Set(
      rules
        .filter((r) => /animation\s*:\s*none/.test(r.body))
        .flatMap((r) => r.selectors)
        .filter((s) => s.startsWith(STILL))
        .map((s) => s.slice(STILL.length).trim()),
    )
    expect(looping.filter((s) => !stilled.has(s))).toEqual([])
  })
})
