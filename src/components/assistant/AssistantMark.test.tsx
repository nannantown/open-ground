// @vitest-environment jsdom
// The character is the app icon's shape (owner decision 2026-10-03: "fewer
// pieces, easier to see"): the thick carved ring with 8 notches — the same
// mask OpenGroundMark draws at small sizes — split into 4 pieces, each
// carrying its own breathing direction, one wearing the owner's colour.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { OG_SHARDS, OG_VIEWBOX } from '@/components/canvas/openGroundShards'
import { OpenGroundMark } from '@/components/canvas/OpenGroundMark'
import { AssistantMark } from './AssistantMark'

afterEach(cleanup)

const cutOuts = (root: Element) =>
  Array.from(root.querySelectorAll('mask > *')).map((el) => el.outerHTML)

describe('AssistantMark', () => {
  it('is the app icon’s carved ring — 4 pieces, not the logo’s 20 shards', () => {
    const { container } = render(<AssistantMark look="moss" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe(OG_VIEWBOX)
    const pieces = container.querySelectorAll('.og-ast-shard')
    expect(pieces).toHaveLength(4)
    // None of the logo's fine shards is drawn as a piece of its own.
    const drawn = new Set(Array.from(container.querySelectorAll('.og-ast-blink path')).map((p) => p.getAttribute('d')))
    expect(OG_SHARDS.filter((d) => drawn.has(d))).toHaveLength(0)
    // Every piece is the ring cut by the same mask, each clipped to its own wedge.
    const masks = new Set(Array.from(pieces).map((p) => p.getAttribute('mask')))
    expect(masks.size).toBe(1)
    const clips = new Set(Array.from(pieces).map((p) => p.getAttribute('clip-path')))
    expect(clips.size).toBe(4)
  })

  it('cuts the ring exactly as the small app mark does (same hole, same 8 notches)', () => {
    const { container } = render(<AssistantMark look="moss" />)
    const { container: mark } = render(<OpenGroundMark size={16} />)
    const ours = cutOuts(container)
    expect(ours.filter((h) => h.startsWith('<path'))).toHaveLength(8)
    expect(ours).toEqual(cutOuts(mark))
  })

  it('each piece breathes along its own outward direction, in ring order', () => {
    const { container } = render(<AssistantMark look="verm" />)
    const pieces = Array.from(container.querySelectorAll<SVGElement>('.og-ast-shard'))
    const ks = pieces.map((p) => Number(p.style.getPropertyValue('--k'))).sort((a, b) => a - b)
    expect(ks).toEqual(Array.from({ length: 4 }, (_, i) => i))
    for (const p of pieces) {
      const dx = Number(p.style.getPropertyValue('--dx'))
      const dy = Number(p.style.getPropertyValue('--dy'))
      expect(Math.hypot(dx, dy)).toBeCloseTo(1, 2)
    }
  })

  it('no piece is coloured; the mode reaches the CSS', () => {
    const { container } = render(<AssistantMark look="verm" mode="think" />)
    const svg = container.querySelector('svg')!
    expect(container.querySelectorAll('.is-lead')).toHaveLength(0)
    expect(svg.style.getPropertyValue('--og-ast-look')).toBe('')
    expect(svg.dataset.mode).toBe('think')
  })
})
