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
// the dark instrument panel sets status colours (moss/ochre/azure lamps)
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

const SURFACES = ['bg', 'bg-elevated', 'bg-card', 'bg-inset'] as const
const TEXTS = ['ink', 'ink-muted', 'ink-subtle', 'ink-faint'] as const

// Read pairs common to BOTH themes.
const COMMON_PAIRS: [string, string][] = [
  ...SURFACES.flatMap((s) => TEXTS.map((t): [string, string] => [t, s])),
  ['accent', 'bg'], // vermillion labels/links on the ground
  ['accent', 'bg-card'], // …and on cards (181 text-accent usages)
  ['ink-inverse', 'accent'], // filled accent buttons
  ['accent-deeper', 'accent-soft'], // IconButton active / selected chips
  ['ochre-deep', 'ochre-soft'], // Board priority "high" chip (boardPriority.ts)
  ['invite', 'invite-soft'], // shared/invite badge
]

// The night panel additionally carries status colours straight on its surfaces
// (the instrument lamps) and labels on the deepest terminal-frame surface.
const DARK_ONLY_PAIRS: [string, string][] = [
  ['accent', 'bg-inset'],
  ['accent', 'accent-soft'],
  ['moss', 'bg'],
  ['moss', 'bg-card'],
  ['moss', 'moss-soft'],
  ['ochre', 'bg'],
  ['ochre', 'bg-card'],
  ['azure', 'bg'],
  ['azure', 'bg-card'],
  ['azure', 'azure-soft'],
  ['ink', 'bg-deep'],
  ['ink-muted', 'bg-deep'],
]

describe('theme palettes (globals.css) keep every read pair ≥ 4.5:1', () => {
  const light = parsePalette(':root {')
  const dark = parsePalette("html[data-theme='dark'] {")

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
