import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── 第三弾「計器盤」palette guard (2026-08-03) ──────────────────────────────
// Both colour palettes live as RGB channel variables in src/app/globals.css
// (:root = light paper, html[data-theme='dark'] = night instrument), and every
// Tailwind token reads them — so globals.css IS the palette. This test parses
// that file and recomputes WCAG contrast for the pairs the UI actually READS
// (text token on the surface it sits on), pinning them ≥ 4.5:1 (AA). Change a
// channel value and this recomputes — a palette tweak can't silently ship an
// unreadable pair.
//
// Pair lists are PER THEME because the two palettes carry text differently:
// light uses the `deeper`/`deep` variants on soft chip surfaces (the DEFAULTs
// are decorative there — a pre-existing property of the paper palette), while
// the dark instrument panel sets status colours (moss / ochre lamps)
// directly on the dark surfaces, so those direct pairs are load-bearing.

const css = readFileSync(resolve(__dirname, 'app/globals.css'), 'utf8')

const parsePalette = (blockStart: string): Record<string, [number, number, number]> => {
  const start = css.indexOf(blockStart)
  expect(start, `palette block "${blockStart}" exists in globals.css`).toBeGreaterThan(-1)
  const block = css.slice(start, css.indexOf('}', start))
  const out: Record<string, [number, number, number]> = {}
  for (const m of Array.from(block.matchAll(/--og-([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g))) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])]
  }
  return out
}

const luminance = ([r, g, b]: [number, number, number]): number => {
  const [lr, lg, lb] = [r, g, b]
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// HOVER SURFACES were missing here until 2026-08-04, and that omission was the
// bug: `--og-plane` and `--og-bg-card-hover` arrived with the hover rework, so
// nothing ever measured text on them — while `hover:bg-plane` alone reached 98
// sites. On paper ALL FOUR inks plus accent were below AA on `plane` (3.75 to
// 4.26) and the suite was green. A surface that carries text belongs in this
// list the day it is born.
const SURFACES = [
  'bg',
  'bg-elevated',
  'bg-card',
  'bg-inset',
  'plane',
  'bg-card-hover',
] as const
const TEXTS = ['ink', 'ink-muted', 'ink-subtle', 'ink-faint'] as const

// Read pairs common to BOTH themes.
const COMMON_PAIRS: [string, string][] = [
  ...SURFACES.flatMap((s) => TEXTS.map((t): [string, string] => [t, s])),
  ['accent', 'bg'], // vermillion labels/links on the ground
  ['accent', 'bg-card'], // …and on cards (181 text-accent usages)
  ['accent', 'plane'], // …and on the hover lift (SettingsPanel/SdkWorkerPane)
  ['accent', 'bg-card-hover'], // …and on a hovered card
  // `bg-deep` is the one surface that stays dark in BOTH palettes, so it needs a
  // text token that stays light in both — neither `ink` nor `ink-inverse` does.
  ['ink-on-deep', 'bg-deep'],
  ['ink-inverse', 'accent'], // filled accent buttons
  ['accent-deeper', 'accent-soft'], // IconButton active / selected chips
  ['ochre-deep', 'ochre-soft'], // Board priority "high" chip (boardPriority.ts)
  ['invite', 'invite-soft'], // shared/invite badge
]

// The night panel additionally carries status colours straight on its surfaces
// (the instrument lamps) and labels on the deepest terminal-frame surface.
// Azure was removed from the palette on 2026-08-04 — the vocabulary is three
// colours (稼働=苔 / 待ち=黄土 / 高=朱) and a fourth had been signalling the
// SAME state that moss already signalled on the Board.
const DARK_ONLY_PAIRS: [string, string][] = [
  ['accent', 'bg-inset'],
  ['accent', 'accent-soft'],
  ['moss', 'bg'],
  ['moss', 'bg-card'],
  ['moss', 'moss-soft'],
  ['ochre', 'bg'],
  ['ochre', 'bg-card'],
  ['ink', 'bg-deep'],
  ['ink-muted', 'bg-deep'],
]

// ─── THE LADDER ────────────────────────────────────────────────────────────
// AA per pair is necessary and not sufficient: three ranks can each clear 4.5:1
// and still be indistinguishable from each other. That is exactly what happened
// to the night palette — ink-muted / -subtle / -faint sat within 5.4 L* (gaps of
// 2.8 and 2.6, against 24.4 from `ink` down to `muted`), separated by HUE rather
// than lightness, so at 10–11px they rendered as one flat grey and the ranking
// the token names promise did not exist on screen. Every pair was green.
//
// BOTH THEMES since 2026-08-04. It was dark-only for a few hours, with a note
// saying paper could not be fixed: `ink-faint` is pinned at 4.60:1 on
// `bg-inset`, so lifting it drops it under AA. Both halves of that were true and
// the conclusion did not follow — it only considered opening the ladder UPWARD.
// `faint` is pinned from BELOW, so the ladder opens downward instead: darken
// `muted` and `subtle`. On a LIGHT ground darker means more contrast, so that
// direction cost nothing across all six paper surfaces, and the binding pair is
// still faint-on-inset at exactly 4.60.
// Two lessons, and the second one was expensive:
//   1. A constraint that blocks one direction is not a constraint on the problem.
//   2. "Darker is more contrast" is a claim about LIGHT grounds — and the paper
//      palette owns a dark one (`bg-deep`, the terminal-frame slab, which does
//      not invert with the theme). This comment briefly said "no combination
//      anywhere regresses"; on that surface the combination did regress, 2.38 to
//      1.54, and nothing here was measuring it. `ink-on-deep` and the pairs below
//      exist because of that.
const LADDER = ['ink', 'ink-muted', 'ink-subtle', 'ink-faint'] as const
const MIN_LADDER_STEP = 4 // L* — below this the ranks stop being distinguishable

const lstar = (rgb: [number, number, number]): number => {
  const y = luminance(rgb)
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : y * (24389 / 27)
}

describe('theme palettes (globals.css) keep every read pair ≥ 4.5:1', () => {
  const light = parsePalette(':root {')
  const dark = parsePalette("html[data-theme='dark'] {")

  it.each([
    ['dark', () => dark, 'desc'],
    ['light', () => light, 'asc'],
  ] as const)('%s: the ink ladder stays four distinguishable ranks', (_name, get, order) => {
    const p = get()
    const steps = LADDER.slice(0, -1).map((t, i) => ({
      pair: `${t} → ${LADDER[i + 1]}`,
      delta: Math.abs(lstar(p[t]) - lstar(p[LADDER[i + 1]])),
    }))
    for (const s of steps) {
      expect(s.delta, `${s.pair} is ${s.delta.toFixed(1)} L* apart`).toBeGreaterThanOrEqual(
        MIN_LADDER_STEP,
      )
    }
    // …and the ranks must stay in order: away from the ground, never back toward
    // it. On paper that means progressively LIGHTER, at night progressively
    // darker — a rank that doubles back is a rank nobody can read as a rank.
    const ls = LADDER.map((t) => lstar(p[t]))
    const sorted = [...ls].sort((a, b) => (order === 'desc' ? b - a : a - b))
    expect(ls, `${_name} ink ranks run ${order === 'desc' ? 'brightest' : 'darkest'} first`).toEqual(
      sorted,
    )
  })

  it('parses both palettes with the same token set', () => {
    // A token added to one palette but forgotten in the other would fall back
    // to the light value in dark mode — likely unreadable. Overapproximate:
    // the sets must be identical.
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(25)
  })

  it.each(COMMON_PAIRS)('light: %s on %s', (text, surface) => {
    expect(light[text], `--og-${text} in :root`).toBeDefined()
    expect(light[surface], `--og-${surface} in :root`).toBeDefined()
    expect(contrast(light[text], light[surface])).toBeGreaterThanOrEqual(4.5)
  })

  it.each([...COMMON_PAIRS, ...DARK_ONLY_PAIRS])('dark: %s on %s', (text, surface) => {
    expect(dark[text], `--og-${text} in dark palette`).toBeDefined()
    expect(dark[surface], `--og-${surface} in dark palette`).toBeDefined()
    expect(contrast(dark[text], dark[surface])).toBeGreaterThanOrEqual(4.5)
  })
})
