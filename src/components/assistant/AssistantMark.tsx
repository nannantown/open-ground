// AssistantMark — the assistant's character: the app icon's shape (owner
// decision 2026-10-03, replacing the logo's 20 fine shards — "fewer pieces,
// easier to see"): a thick ring cut by 8 large grain-shaped notches, i.e. the
// carved ring OpenGroundMark draws at small sizes (CarvedRingMask). The ring is
// drawn as 4 pieces (split at the 4 notches that reach the hole) so each can
// move on its own (CSS `.og-ast*` in
// globals.css): they breathe open and closed, close briefly like a blink, and
// while it is thinking a light runs round them in the owner's colour. The
// top piece wears that colour at rest. Off holds still.
// Spec: docs/ASSISTANT_DESIGN.md.
import { useId, type CSSProperties } from 'react'
import { CarvedRingMask, OG_RING_CX, OG_RING_CY, OG_RING_OUTER } from '@/components/canvas/OpenGroundMark'
import { OG_VIEWBOX } from '@/components/canvas/openGroundShards'
import type { AssistantLook } from './useAssistant'

export const LOOK_COLOR: Record<AssistantLook, string> = {
  verm: 'rgb(var(--og-accent))',
  moss: 'rgb(var(--og-moss))',
  ochre: 'rgb(var(--og-ochre))',
  ink: 'rgb(var(--og-ink))',
}

// Where the ring is split into its pieces, in degrees clockwise from 3 o'clock
// (SVG y points down), in ring order from the top piece. Only 4 of the 8
// notches run all the way from the rim into the centre hole; the other 4 stop
// short of it, leaving the ring solid there (as on the app icon). So the ring
// is split only through those 4 through-notches, just past each one's leading
// edge — a cut anywhere else would cross ring material (a hairline seam at
// rest, the ring splitting open where the icon is solid when it breathes).
// Pinned geometrically by ringGeometry.test.ts.
export const RING_CUTS = [-137.5, -46.5, 43.5, 132.5] as const
// All pieces are the same ink — no coloured piece (owner decision 2026-10-05).

const rad = (deg: number) => (deg * Math.PI) / 180
const at = (deg: number, r = 200) =>
  `${(OG_RING_CX + r * Math.cos(rad(deg))).toFixed(2)},${(OG_RING_CY + r * Math.sin(rad(deg))).toFixed(2)}`

/** Per piece: the wedge that cuts it out of the ring, the outward direction it
 *  breathes along, and its place round the ring. */
const PIECES = RING_CUTS.map((a0, k) => {
  const a1 = k + 1 < RING_CUTS.length ? RING_CUTS[k + 1] : RING_CUTS[0] + 360
  const mid = (a0 + a1) / 2
  return {
    wedge: `${OG_RING_CX},${OG_RING_CY} ${at(a0)} ${at(mid)} ${at(a1)}`,
    style: {
      '--dx': Math.cos(rad(mid)).toFixed(3),
      '--dy': Math.sin(rad(mid)).toFixed(3),
      '--k': k,
    } as CSSProperties,
  }
})

export const AssistantMark = ({
  mode = 'idle',
  size = 40,
}: {
  look: AssistantLook
  mode?: 'idle' | 'think' | 'off'
  size?: number
}) => {
  const id = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox={OG_VIEWBOX}
      aria-hidden="true"
      data-mode={mode}
      className="og-ast overflow-visible"
    >
      <defs>
        <CarvedRingMask id={`${id}m`} />
        {PIECES.map((p, k) => (
          <clipPath key={k} id={`${id}c${k}`}>
            <polygon points={p.wedge} />
          </clipPath>
        ))}
      </defs>
      <g className="og-ast-blink">
        {PIECES.map((p, k) => (
          <circle
            key={k}
            cx={OG_RING_CX}
            cy={OG_RING_CY}
            r={OG_RING_OUTER}
            mask={`url(#${id}m)`}
            clipPath={`url(#${id}c${k})`}
            style={p.style}
            className="og-ast-shard"
          />
        ))}
      </g>
    </svg>
  )
}
