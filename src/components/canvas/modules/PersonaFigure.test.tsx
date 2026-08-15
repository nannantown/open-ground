// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { PersonaFigure, regionCountLine, type RegionSummary } from './PersonaFigure'
import { PERSONA_REGIONS, REGION_LABEL_KEY, type PersonaNode } from '@/lib/persona/regions'
import type { PersonaRegion } from '@/lib/types'

// The FIGURE, as a surface rather than a picture.
//
// Two things are checkable here and were not checkable before the armature
// landed (jsdom has no 2D context, so the old mask-built field was null in every
// test and this file could not have existed):
//
//   1. THE NON-MOUSE PATHS. Two off-screen lists — one button per note, one
//      button per region — are the only way a keyboard owner reaches either the
//      notes or the probe. Deleting the first is caught by ~11 tests in
//      PersonaModule.test.tsx; deleting the second is caught here.
//   2. THE HIT TEST, end to end. `getBoundingClientRect` is stubbed so the
//      figure has a real size, which makes the production pointer path — screen
//      px → layout px → figure space → `nearestPoint` — run for real. A point
//      between the legs must answer NOTHING; a box test answers 「続けかた」.
//
// The probe's CONTENT is a prop (RegionSummary), because the figure holds no
// corpus. What is asserted here is that the figure renders the state it was
// handed and never rounds one state into another.

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    lang: 'en',
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  }),
}))

/** A 1200×900 stage, so the figure is 720px tall at (600, 76.5) — see
 *  `framePlacement`. Without this every rect in jsdom is zero and the whole
 *  pointer path collapses into a single degenerate point. */
const W = 1200
const H = 900
const FIG_S = Math.min(H * 0.8, W * 0.62)
const FIG_OX = W / 2
const FIG_OY = (H - FIG_S) / 2 - H * 0.015

/** Figure space → the client coordinate that lands on it. The camera starts
 *  centred at 1×, so layout px and screen px coincide on mount. */
const at = (fx: number, fy: number) => ({
  clientX: FIG_OX + fx * FIG_S,
  clientY: FIG_OY + fy * FIG_S,
})

const node = (over: Partial<PersonaNode> = {}): PersonaNode => ({
  id: 'n-1',
  region: 'head',
  placed: true,
  text: 'A thing known.',
  addedAt: '2026-08-01T00:00:00.000Z',
  tags: [],
  courseId: null,
  ...over,
})

const summary = (over: Partial<RegionSummary> = {}): RegionSummary => ({
  region: 'head',
  state: 'read',
  placed: 3,
  unplaced: 0,
  lines: [],
  ariaName: `${REGION_LABEL_KEY.head} 3`,
  ...over,
})

const onProbe = vi.fn()
const onSelect = vi.fn()
let summaries: Partial<Record<PersonaRegion, RegionSummary>> = {}

const draw = (over: Partial<ComponentProps<typeof PersonaFigure>> = {}) =>
  render(
    <PersonaFigure
      nodes={[]}
      gapRegion={null}
      pendingRegion={null}
      spark={null}
      onSelect={onSelect}
      onTapEmpty={() => {}}
      onTapGap={() => {}}
      regionLabel={(r) => REGION_LABEL_KEY[r]}
      provenance={(n) => `from ${n.id}`}
      regionSummary={(r) => summaries[r] ?? summary({ region: r, ariaName: `${REGION_LABEL_KEY[r]} 3` })}
      onProbe={onProbe}
      {...over}
    />,
  )

let rectSpy: ReturnType<typeof vi.spyOn> | null = null

beforeEach(() => {
  summaries = {}
  onProbe.mockReset()
  onSelect.mockReset()
  rectSpy = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: W,
      bottom: H,
      width: W,
      height: H,
      toJSON: () => ({}),
    } as DOMRect)
})

afterEach(() => {
  rectSpy?.mockRestore()
  cleanup()
})

const regionList = () => screen.getByRole('list', { name: 'persona.figure.regionList' })

describe('every part of the figure is reachable without a pointer', () => {
  // MUTATION GUARD (R2 #5). Deleting the region list leaves a keyboard owner
  // with a screen whose region map they can be told about and never open — the
  // probe is a hover panel, and hover is not a keyboard.
  it('offers one button per region, named by that region', () => {
    draw()
    const buttons = screen.getAllByRole('button', { name: /^persona\.region\./ })
    expect(buttons).toHaveLength(PERSONA_REGIONS.length)
    for (const r of PERSONA_REGIONS) {
      const label = REGION_LABEL_KEY[r]
      expect(
        buttons.some((b) => (b.textContent ?? '').includes(label)),
        `${r} is reachable`,
      ).toBe(true)
    }
    // …and they are in the off-screen list, not a second visible control row.
    expect(within(regionList()).getAllByRole('button')).toHaveLength(PERSONA_REGIONS.length)
  })

  it('pressing one opens the same panel the pointer opens', () => {
    summaries = {
      legs: summary({
        region: 'legs',
        placed: 2,
        lines: [{ text: 'Nights are when it moves.', sub: 'This conversation ・ Aug 10' }],
        ariaName: `${REGION_LABEL_KEY.legs} 2`,
      }),
    }
    draw()
    fireEvent.click(within(regionList()).getByRole('button', { name: new RegExp(REGION_LABEL_KEY.legs) }))
    const probe = screen.getByRole('status')
    expect(probe.textContent).toContain(REGION_LABEL_KEY.legs)
    expect(probe.textContent).toContain('persona.figure.regionKnown:{"count":2}')
    expect(probe.textContent).toContain('Nights are when it moves.')
    expect(probe.textContent).toContain('This conversation ・ Aug 10')
  })

  it('tells the module which region is being probed', () => {
    draw()
    fireEvent.click(within(regionList()).getByRole('button', { name: new RegExp(REGION_LABEL_KEY.arms) }))
    expect(onProbe).toHaveBeenCalledWith('arms')
  })

  it('keeps the note list too — both lists, or the figure is picture-only', () => {
    draw({ nodes: [node({ text: 'Ship before it is pretty.' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Ship before it is pretty.' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})

describe('the probe renders the state it was handed, and never rounds one into another', () => {
  // MUTATION GUARD (R4 #1, measured here because R2 writes the renderer).
  // Summing placed + unplaced would claim a reading for the ~159 notes that
  // predate regions — evidence nobody produced, printed under a heading that
  // says 「分かっていること」.
  it('never adds the notes it merely spread to the ones it read', () => {
    summaries = {
      legs: summary({
        region: 'legs',
        placed: 3,
        unplaced: 12,
        ariaName: `${REGION_LABEL_KEY.legs} 3`,
      }),
    }
    draw()
    fireEvent.click(within(regionList()).getByRole('button', { name: new RegExp(REGION_LABEL_KEY.legs) }))
    const probe = screen.getByRole('status')
    // Three were READ…
    expect(probe.textContent).toContain('persona.figure.regionKnown:{"count":3}')
    // …the twelve are reported separately and named for what they are…
    expect(probe.textContent).toContain('persona.figure.regionUnplaced:{"count":12}')
    // …and the sum, 15, is never printed anywhere.
    expect(probe.textContent).not.toContain('15')
  })

  // ⚠ THE PANEL USED TO CONTRADICT ITSELF HERE. With nothing read but notes
  // spread across the body it printed 「ここはまだ何もありません」 and then, two
  // lines below, 「置き場所が決まっていない 12」. The unplaced count is the
  // headline in that state; "nothing here" is reserved for genuinely nothing.
  it('does NOT say "nothing here" over notes that are merely unplaced', () => {
    summaries = {
      legs: summary({
        region: 'legs',
        placed: 0,
        unplaced: 12,
        ariaName: `${REGION_LABEL_KEY.legs} 12`,
      }),
    }
    draw()
    fireEvent.click(within(regionList()).getByRole('button', { name: new RegExp(REGION_LABEL_KEY.legs) }))
    const probe = screen.getByRole('status')
    expect(probe.textContent).toContain('persona.figure.regionUnplaced:{"count":12}')
    expect(probe.textContent).not.toContain('persona.region.none')
    expect(probe.textContent).not.toContain('persona.figure.regionKnown')
    // …and it is said ONCE, not twice.
    expect(probe.textContent?.match(/persona\.figure\.regionUnplaced/g)).toHaveLength(1)
  })

  it('prints NO number at all over a failed read', () => {
    // "Could not read" and "nothing here" are different states and must never
    // share a string — and a 0 over the first one is a measurement nobody took.
    summaries = {
      chest: summary({
        region: 'chest',
        state: 'unread',
        placed: 0,
        unplaced: 0,
        ariaName: `${REGION_LABEL_KEY.chest} unread`,
      }),
    }
    draw()
    fireEvent.click(within(regionList()).getByRole('button', { name: new RegExp(REGION_LABEL_KEY.chest) }))
    const probe = screen.getByRole('status')
    expect(probe.textContent).toContain('persona.region.unreadable')
    expect(probe.textContent).not.toContain('persona.region.none')
    expect(probe.textContent).not.toContain('persona.figure.regionKnown')
    expect(probe.textContent).not.toContain('persona.figure.regionUnplaced')
    expect(probe.textContent).not.toMatch(/\d/)
  })

  it('says nothing at all until a region is probed', () => {
    draw()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('the hit test is the silhouette, end to end', () => {
  // MUTATION GUARD (R2 #3, at the call site). armature.test.ts pins
  // `nearestPoint` itself; this pins that the FIGURE routes its pointer through
  // it — screen px → layout px → figure space — rather than through a region
  // box. (0, 0.85) is inside the legs' bounding box and in the air between the
  // two legs, so a box test raises 「続けかた」 over empty space.
  it('pointing between the legs raises nothing', () => {
    const { container } = draw()
    const host = container.firstElementChild as HTMLElement
    fireEvent.pointerMove(host, { ...at(0, 0.85), pointerType: 'mouse' })
    expect(screen.queryByRole('status')).toBeNull()
    expect(onProbe).not.toHaveBeenCalledWith('legs')
  })

  it('pointing AT the head raises the head', () => {
    // The companion: a hit test that answered null everywhere would pass the
    // test above while making the figure unpointable.
    const { container } = draw()
    const host = container.firstElementChild as HTMLElement
    fireEvent.pointerMove(host, { ...at(0, 0.07), pointerType: 'mouse' })
    expect(screen.getByRole('status').textContent).toContain(REGION_LABEL_KEY.head)
    expect(onProbe).toHaveBeenCalledWith('head')
  })

  it('leaving the figure closes the probe', () => {
    const { container } = draw()
    const host = container.firstElementChild as HTMLElement
    fireEvent.pointerMove(host, { ...at(0, 0.07), pointerType: 'mouse' })
    expect(screen.queryByRole('status')).not.toBeNull()
    fireEvent.pointerLeave(host)
    expect(screen.queryByRole('status')).toBeNull()
    expect(onProbe).toHaveBeenLastCalledWith(null)
  })
})

// ─── the region count line ───────────────────────────────────────────────────
//
// ONE function feeds BOTH the visible probe and the aria-label of the region
// button, because they said different things: the panel printed
// 「ここはまだ何もありません」 and then, two lines below,
// 「置き場所が決まっていない 40」 — a contradiction on one panel — while a screen
// reader was given only the first half and told the region was empty.
describe('regionCountLine — the empties are not the same state', () => {
  it('a FAILED read carries no number at all', () => {
    // A 0 here would be a measurement nobody took.
    expect(regionCountLine({ state: 'unread', placed: 0, unplaced: 0 })).toEqual({
      key: 'persona.region.unreadable',
    })
    // …and it stays numberless even when stale counts are lying around.
    expect(regionCountLine({ state: 'unread', placed: 7, unplaced: 3 })).toEqual({
      key: 'persona.region.unreadable',
    })
  })

  it('reports what was READ when anything was read', () => {
    expect(regionCountLine({ state: 'read', placed: 4, unplaced: 0 })).toEqual({
      key: 'persona.figure.regionKnown',
      vars: { count: 4 },
    })
  })

  it('NEVER says "nothing here" over notes that are merely unplaced', () => {
    // ⚠ THE FAILURE. ~159 notes predate regions and sit on the body without a
    // reading (regions.ts tier 4). Announcing that region as empty is the claim
    // this whole seam exists to prevent.
    expect(regionCountLine({ state: 'read', placed: 0, unplaced: 40 })).toEqual({
      key: 'persona.figure.regionUnplaced',
      vars: { count: 40 },
    })
  })

  it('says "nothing here" only when there is genuinely nothing', () => {
    expect(regionCountLine({ state: 'read', placed: 0, unplaced: 0 })).toEqual({
      key: 'persona.region.none',
    })
  })

  it('never sums the two counts', () => {
    // Adding them would claim evidence for every note that was never read.
    expect(regionCountLine({ state: 'read', placed: 2, unplaced: 40 })).toEqual({
      key: 'persona.figure.regionKnown',
      vars: { count: 2 },
    })
  })
})
