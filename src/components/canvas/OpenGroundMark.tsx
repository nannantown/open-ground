import { useId } from 'react'
import { OG_RING_ORDER, OG_SHARD_CENTROIDS, OG_SHARDS, OG_VIEWBOX } from './openGroundShards'

// The OPEN GROUND brand mark — the ring of grains.
//
// Large sizes render the full marketing mark (all 20 intricate shards). Below
// ~SWAP_PX those shards turn to mush, so small sizes render a bolder derived
// variant: a solid black ring (outer 82 / inner 48 — same grain band as the
// logo) with a few large shard-shaped notches carved out of it. The notches are
// real shards from the mark, picked evenly around the ring and scaled up about
// their own centres so they punch cleanly through the outer edge (no thin
// leftover line). This keeps the brand's grain language while staying legible at
// 15–18px. When `spinning`, the whole thing rotates (.og-spin) about the ring
// centre (the viewBox is centred on it) as the assistant's "thinking" indicator.

const BRAND = '#231916'

// Below this rendered pixel size, draw the carved ring instead of the shards.
const SWAP_PX = 48

// Carved-ring geometry, in the source viewBox's units.
const CX = 145
const CY = 80
const OUTER = 82 // outer radius (grain-band outer edge)
const INNER = 48 // inner radius (grain-band inner edge → centre hole)
const NOTCH_COUNT = 8
const NOTCH_SCALE = 1.7 // enlarge each notch about its centre so it overshoots OUTER

// Pick NOTCH_COUNT shards spread evenly around the ring (subsample the angle-
// sorted order). Computed once — the geometry never changes.
const NOTCH_SHARDS: number[] = (() => {
  const total = OG_RING_ORDER.length
  const out: number[] = []
  for (let k = 0; k < NOTCH_COUNT; k++) {
    out.push(OG_RING_ORDER[Math.round((k * total) / NOTCH_COUNT) % total])
  }
  return Array.from(new Set(out))
})()

export const OpenGroundMark = ({
  size = 16,
  spinning = false,
  color = BRAND,
  className = '',
}: {
  size?: number
  spinning?: boolean
  color?: string
  className?: string
}) => {
  const maskId = useId()
  const cls = [spinning ? 'og-spin' : '', className].filter(Boolean).join(' ')
  const common = {
    viewBox: OG_VIEWBOX,
    width: size,
    height: size,
    'aria-hidden': true,
    style: { width: size, height: size },
    className: cls,
  } as const

  if (size < SWAP_PX) {
    return (
      <svg {...common}>
        <mask id={maskId}>
          <rect x="60" y="-5" width="170" height="170" fill="white" />
          {/* centre hole */}
          <circle cx={CX} cy={CY} r={INNER} fill="black" />
          {/* grain-shaped notches, scaled about each shard's own centre */}
          {NOTCH_SHARDS.map((i) => {
            const [mx, my] = OG_SHARD_CENTROIDS[i]
            return (
              <path
                key={i}
                d={OG_SHARDS[i]}
                fill="black"
                transform={`translate(${mx} ${my}) scale(${NOTCH_SCALE}) translate(${-mx} ${-my})`}
              />
            )
          })}
        </mask>
        <circle cx={CX} cy={CY} r={OUTER} fill={color} mask={`url(#${maskId})`} />
      </svg>
    )
  }

  return (
    <svg {...common} fill={color}>
      {OG_SHARDS.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  )
}
