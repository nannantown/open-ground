// SwarmSprite — draws one of the three swarm roles at its current state.
//
// A canvas rather than an <img> or a run of <div>s: 256 pixels × a 60fps loop is
// one draw call's worth of work, the sprite stays crisp at any integer scale
// (`imageRendering: pixelated`), and the palette comes from the state at draw
// time so ONE drawing serves every state.
//
// THE MOTION IS THE MESSAGE. At 16px on a Board card, movement reads before hue
// does, so each state moves differently on purpose:
//   starting  barely moves, fading in — it is not working yet
//   working   a quick two-frame bob — the ONLY state with real motion
//   waiting   almost still, breathing slowly — waiting, not asleep
//   asking    a double-bounce with a mark — the only state that is loud, because
//             it is the only one that is a claim on the owner
//   done      sets its work down and breaks into particles
//
// ⚠ TEARDOWN. The loop is cancelled on unmount and never restarted from a stale
// closure. A Board can hold dozens of these and they mount/unmount as cards move
// between columns; an orphaned rAF per card is the leak that would actually cost
// something here. `prefers-reduced-motion` drops to a single static frame rather
// than animating quietly — the states are still told apart by colour and mark.

import { useEffect, useRef } from 'react'
import {
  SPRITES,
  SPRITE_COLORS,
  SPRITE_EYE,
  SPRITE_SIZE,
  type SpriteRole,
  type SpriteState,
} from '@/lib/swarm/sprites'

export interface SwarmSpriteProps {
  role: SpriteRole
  state: SpriteState
  /** Integer pixel scale. 1 = actual size (16px), which is what a Board card
   *  uses; the Swarm tab draws the same sprite bigger. */
  scale?: number
  /** Accessible name. Required — a figure that conveys state must say what it
   *  says to a reader who cannot see it. */
  label: string
  className?: string
}

/** Extra columns to the right of the 16px body for the state's mark (…, !, the
 *  finished work). Kept in the same pixel lattice so nothing lands off-grid. */
const MARK_COLS = 6

export const SwarmSprite = ({ role, state, scale = 1, label, className }: SwarmSpriteProps) => {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    const map = SPRITES[role]
    const c = SPRITE_COLORS[state]
    const S = scale
    const still =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let raf = 0
    let t = 0

    const paint = () => {
      ctx.clearRect(0, 0, cv.width, cv.height)

      // Per-state motion + per-pixel alpha (used by starting/done).
      let bob = 0
      let alphaAt: ((x: number, y: number) => number) | null = null
      if (state === 'starting') {
        const p = still ? 1 : Math.min(1, (t % 3) / 1.2)
        alphaAt = () => 0.3 + 0.7 * p
      } else if (state === 'working') {
        bob = still ? 0 : (Math.floor(t * 6) % 2) * S
      } else if (state === 'waiting') {
        bob = still ? 0 : Math.sin(t * 1.6) > 0.85 ? S * 0.5 : 0
      } else if (state === 'asking') {
        const k = t % 1.6
        bob = still ? 0 : k < 0.12 ? -S : k < 0.24 ? 0 : k < 0.36 ? -S : 0
      } else if (state === 'done') {
        const p = still ? 0.34 : (t % 3) / 3
        alphaAt = (x, y) => {
          if (p < 0.35) return 1
          // A stable per-pixel order, so the figure always dissolves the same
          // way instead of shimmering differently on every frame.
          const k = ((x * 7 + y * 13) % 10) / 10
          return Math.max(0, 1 - ((p - 0.35) / 0.65 - k * 0.5) * 2.2)
        }
      }

      for (let y = 0; y < map.length; y++) {
        const row = map[y]
        for (let x = 0; x < row.length; x++) {
          const ch = row[x]
          if (ch === '.') continue
          const a = alphaAt ? alphaAt(x, y) : 1
          if (a <= 0) continue
          ctx.globalAlpha = a
          ctx.fillStyle =
            ch === 'e' ? SPRITE_EYE : ch === 'o' ? c.shade : ch === 'w' ? c.light : c.body
          ctx.fillRect(x * S, S + bob + y * S, S, S)
        }
      }
      ctx.globalAlpha = 1

      // The marks, in the same lattice.
      const mx = SPRITE_SIZE * S
      if (state === 'working') {
        ctx.fillStyle = c.light
        const k = still ? 0 : Math.floor(t * 6) % 2
        ctx.fillRect(mx, S * 4 + k * S, S, S)
        ctx.fillRect(mx + S, S * 6 + k * S, S, S)
      } else if (state === 'waiting') {
        // … marching — the difference between "waiting on someone" and "asleep"
        ctx.fillStyle = c.light
        const n = still ? 3 : Math.floor(t * 2) % 4
        for (let i = 0; i < 3; i++) {
          ctx.globalAlpha = i < n ? 1 : 0.25
          ctx.fillRect(mx + i * 2 * S, S * 8, S, S)
        }
        ctx.globalAlpha = 1
      } else if (state === 'asking') {
        // ! — the only loud mark in the set
        ctx.fillStyle = c.body
        ctx.fillRect(mx + S, S * 2, S, S * 3)
        ctx.fillRect(mx + S, S * 6, S, S)
      } else if (state === 'done') {
        // the finished work, left behind once the body has gone
        ctx.fillStyle = '#C8B79E'
        ctx.fillRect(mx + S, S * 12, S * 3, S * 2)
      }
    }

    if (still) {
      paint()
      return
    }
    const loop = () => {
      t += 1 / 60
      paint()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [role, state, scale])

  const w = (SPRITE_SIZE + MARK_COLS) * scale
  const h = (SPRITE_SIZE + 2) * scale
  return (
    <canvas
      ref={ref}
      width={w}
      height={h}
      style={{ width: w, height: h, imageRendering: 'pixelated' }}
      className={className}
      role="img"
      aria-label={label}
    />
  )
}
