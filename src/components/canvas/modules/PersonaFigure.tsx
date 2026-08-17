// PersonaFigure — the stand-in drawn as a human figure made of particles.
//
// WHAT A PARTICLE MEANS (the whole point of the surface):
//   • LIT   — one thing the stand-in knows: exactly one hand-written note
//             (ManualJudgment). Hovering it says what it is and where it came
//             from; clicking it opens that note.
//   • RAW   — one answer given inside a course that has not finished yet. Dim,
//             textless, and honest about it: nothing has been concluded from it.
//   • GAP   — the faintly pulsing patch: the region the question in the corner
//             is trying to fill.
//   • DUST  — not formed yet.
//
// So the figure is not decoration. Its density IS the corpus size, and the dark
// parts are the parts the stand-in would have to guess at.
//
// AN ARMATURE, NOT A MASK (2026-08-15). The body used to be a silhouette painted
// into an offscreen canvas and read back as an alpha mask. It gave density but
// no structure — the owner read it as four clouds — and, because jsdom has no 2D
// context, the whole seating path was untested. The geometry now comes from
// src/lib/persona/armature.ts as pure figure-space points, so the body has
// shoulders, limbs and a taper, AND every point exists in a test.
//
// NO DATA OF ITS OWN. Everything it draws is a prop; every write lives in
// PersonaModule, and so does every COUNT (see RegionSummary below — this file
// never tallies anything it renders). That keeps this file a renderer + a
// gesture surface, with the pure parts split between armature.ts (where a point
// is) and regions.ts (which region a note belongs to). This file exports no rule
// of its own; if you are about to add one, it belongs in one of those two.
//
// GESTURES ARE THE SAME CONTRACT AS InfiniteCanvas (src/components/canvas/
// InfiniteCanvas.tsx) — the app already taught the owner one canvas language and
// a second one would be a bug: plain wheel / two-finger scroll pans by
// (deltaX, deltaY); ⌘/Ctrl + wheel zooms by `zoom * (1 + (-deltaY * 0.01))`
// anchored at the cursor; holding Space turns a drag into a pan. Touch adds a
// one-finger drag-pan and a two-finger pinch, which InfiniteCanvas has no
// equivalent of only because it is not a touch surface. The approved v2 mock is
// a static demo and says nothing about gestures, so it does not get to delete
// them — `persona.figure.hint` already ships describing this exact model.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { capTrackingClass } from '@/lib/labelScript'
import { PERSONA_REGIONS, personaHash, type PersonaNode } from '@/lib/persona/regions'
import { buildArmaturePoints, nearestPoint, type ArmaturePoint } from '@/lib/persona/armature'
import { cameraForPoint } from '@/lib/persona/focus'
import type { PersonaRegion } from '@/lib/types'

// ── the particle field ──────────────────────────────────────────────────────

interface Particle extends ArmaturePoint {
  seed: number
  /** Index into the seated node list, or -1. */
  node: number
  /** A course answer that has not been consolidated into a finding yet. */
  raw: boolean
  /** Just landed from a spark — lit before its note has been re-read. */
  mint: boolean
  /** A spark is on its way here. Claimed but not yet visible, so the next spark
   *  in the same batch picks a different particle instead of stacking. */
  reserved: boolean
  /** Part of the pulsing patch the current question comes from. */
  gap: boolean
  /** 1 → 0 flare on arrival, so a new thing known announces itself once. */
  fresh: number
}

interface Field {
  /** Host size in CSS px. */
  w: number
  h: number
  /** Figure height in px, and where its crown sits — figure space × this. */
  s: number
  ox: number
  oy: number
  particles: Particle[]
}

// The stage is `bg-bg-deep`, which is dark in BOTH themes (the same token the
// terminal frames sit on), so the figure's tones are PAINTED rather than read
// from the live theme: the light theme's ink-faint is a dark brown that would
// vanish here, and dust that disappears at noon is not a smaller bug than a
// wrong hue. These are the approved mock's values.
/** A lit point ON the body. */
const TONE_BODY_LIT = '#F29580'
/** A lit point in the halo — cooler, so "around you" reads apart from "of you". */
const TONE_HALO_LIT = '#C98F7E'
/** Not formed yet. */
const TONE_UNLIT = '#5F4C3C'
/** The region under the pointer, and the pulsing gap patch — the same ochre. */
const TONE_HOVER = '#DDAE58'
/** Just arrived. */
const TONE_FRESH = '#FFD9A8'

interface Cam {
  x: number
  y: number
  s: number
}

interface Burst {
  x0: number
  y0: number
  target: Particle
  t: number
  raw: boolean
}

/** A request to fly sparks into a region. `seq` is what makes it fire: bump it
 *  and the same region sparks again (a value-equal prop would not). */
export interface PersonaSpark {
  seq: number
  region: PersonaRegion
  count: number
  /** 'raw' = one dim answer dot; 'node' = a finding taking its place. */
  kind: 'raw' | 'node'
}

/** One line of the region probe: a thing known, and where it came from. */
export interface RegionSummaryLine {
  text: string
  sub: string
}

/** What the probe says about one region. COMPOSED BY THE MODULE, never by this
 *  file — the figure has no corpus and must not appear to have counted one.
 *
 *  `state` is the honest-rendering seam. 'unread' is a FAILED read and prints
 *  「ここは読めていません」 with no numbers at all; a zero over a failed read
 *  would claim a measurement nobody took. 'read' with `placed: 0` prints
 *  「ここはまだ何もありません」, which is a measurement.
 *
 *  `placed` and `unplaced` are NEVER summed. `unplaced` counts notes that were
 *  spread across the body rather than read (regions.ts tier 4) — adding them to
 *  `placed` would claim evidence for the ~159 entries that predate regions. */
export interface RegionSummary {
  region: PersonaRegion
  state: 'read' | 'unread'
  placed: number
  unplaced: number
  lines: RegionSummaryLine[]
  /** What a screen reader announces for this region's button. */
  ariaName: string
}

/** The ONE count line for a region, as an i18n key + vars.
 *
 *  ⚠ SHARED BY THE PROBE AND THE ARIA NAME ON PURPOSE. They said different
 *  things: the visible probe printed 「ここはまだ何もありません」 and then, two
 *  lines below, 「置き場所が決まっていない 40」 — a contradiction on one panel —
 *  while the button a screen reader lands on announced only the first half, so a
 *  blind reader was told a region was empty when 40 notes sat in it. One
 *  function, so the two cannot drift again.
 *
 *  FOUR CASES, and the order is the meaning:
 *    unread            — a failed read. NO number: a 0 is a measurement nobody took.
 *    placed  > 0       — the count that was actually read.
 *    unplaced > 0      — nothing read HERE, but notes are spread across the body.
 *                        Not "nothing"; the honest word is "not placed yet".
 *    otherwise         — genuinely nothing, which is a measurement. */
export const regionCountLine = (s: {
  state: 'read' | 'unread'
  placed: number
  unplaced: number
}): { key: string; vars?: Record<string, number> } => {
  if (s.state === 'unread') return { key: 'persona.region.unreadable' }
  if (s.placed > 0) return { key: 'persona.figure.regionKnown', vars: { count: s.placed } }
  if (s.unplaced > 0) return { key: 'persona.figure.regionUnplaced', vars: { count: s.unplaced } }
  return { key: 'persona.region.none' }
}

const ZOOM_STEP = 0.01
const ZOOM_MIN = 1
const ZOOM_MAX = 2.6
/** How far past the frame the camera may travel — the figure can be pushed to
 *  the edge, never off screen. */
const PAN_MARGIN = 0.22
/** ONE radius, in screen px, for BOTH the node pick and the region probe. Two
 *  radii would mean the thing you clicked and the thing the probe described
 *  could disagree about what you were pointing at. */
const PICK_RADIUS = 22
const GAP_PATCH = 18
/** Width of the probe panel in px — needed to keep it inside the stage. */
const PROBE_W = 270

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Where the figure sits inside the host: as tall as fits with air around it,
 *  centred, nudged up so the feet are not flush with the bottom edge. */
const framePlacement = (w: number, h: number) => {
  const s = Math.min(h * 0.8, w * 0.62)
  return { s, ox: w / 2, oy: (h - s) / 2 - h * 0.015 }
}

const buildField = (w: number, h: number): Field => {
  const { s, ox, oy } = framePlacement(w, h)
  return {
    w,
    h,
    s,
    ox,
    oy,
    particles: buildArmaturePoints().map((p) => ({
      ...p,
      // Seeded from the position, not Math.random: the twinkle is then the same
      // on every mount, so a screenshot diff of this surface is stable.
      seed: (personaHash(`${p.x},${p.y}`) % 628) / 100,
      node: -1,
      raw: false,
      mint: false,
      reserved: false,
      gap: false,
      fresh: 0,
    })),
  }
}

/** Seat every node on a particle of its own region. Oldest note first so a NEW
 *  note takes a free seat instead of displacing the ones already on screen. */
const seatNodes = (field: Field, nodes: PersonaNode[]): void => {
  for (const p of field.particles) {
    p.node = -1
    p.mint = false
  }
  const byRegion = new Map<PersonaRegion, Particle[]>()
  for (const p of field.particles) {
    const list = byRegion.get(p.region)
    if (list) list.push(p)
    else byRegion.set(p.region, [p])
  }
  const order = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.addedAt === b.n.addedAt ? a.n.id.localeCompare(b.n.id) : a.n.addedAt < b.n.addedAt ? -1 : 1))
  for (const { n, i } of order) {
    const pool = byRegion.get(n.region)
    if (!pool || pool.length === 0) continue
    const start = personaHash(n.id) % pool.length
    for (let k = 0; k < pool.length; k++) {
      const p = pool[(start + k) % pool.length]
      if (p.node === -1 && !p.raw && !p.reserved) {
        p.node = i
        break
      }
    }
  }
}

const seatGap = (field: Field, region: PersonaRegion | null): void => {
  for (const p of field.particles) p.gap = false
  if (!region) return
  let seated = 0
  for (const p of field.particles) {
    if (seated >= GAP_PATCH) break
    if (p.region !== region || p.node !== -1 || p.raw || p.reserved) continue
    p.gap = true
    seated++
  }
}

const freeParticle = (field: Field, region: PersonaRegion): Particle | null => {
  const pool = field.particles.filter(
    (p) => p.region === region && p.node === -1 && !p.raw && !p.mint && !p.reserved,
  )
  if (pool.length === 0) return null
  // Middle-out rather than random: a spark lands somewhere plausible on the
  // body, and the same corpus always looks the same.
  return pool[Math.floor(pool.length * 0.5)] ?? null
}

// ── the component ───────────────────────────────────────────────────────────

interface TipState {
  x: number
  y: number
  text: string
  sub: string
}

interface ProbeState {
  region: PersonaRegion
  /** Screen position, or null when the probe was opened from the keyboard and
   *  there is no pointer to anchor it to. */
  at: { x: number; y: number } | null
}

export interface PersonaFigureProps {
  nodes: PersonaNode[]
  /** The region the current question is digging in — its dust pulses. */
  gapRegion: PersonaRegion | null
  /** Set while a course is running; cleared when its result lands, which is
   *  what turns the dim answer dots back into dust before the findings fly in. */
  pendingRegion: PersonaRegion | null
  spark: PersonaSpark | null
  onSelect: (node: PersonaNode) => void
  /** Tapping empty space / the pulsing patch — the module uses it to close the
   *  open note and to draw attention to the question card. */
  onTapEmpty: () => void
  onTapGap: () => void
  regionLabel: (region: PersonaRegion) => string
  provenance: (node: PersonaNode) => string
  /** What the probe says about a region. Owned by the module (see
   *  RegionSummary) — this file positions it and nothing else. */
  regionSummary: (region: PersonaRegion) => RegionSummary
  /** Which region is being probed, or null. Pointer and keyboard both land
   *  here, so a consumer never has to know which one the owner used.
   *
   *  The list screen subscribes: probing a region marks the rows that sit there
   *  and scrolls to the first one, so pointing at a part of the body and reading
   *  what is in it are the same gesture from either side. */
  onProbe?: (region: PersonaRegion | null) => void
  /** ⚠ THE OTHER HALF OF THAT BINDING: one note id, lit brighter than the rest
   *  and ringed, because a row in the list is being pointed at.
   *
   *  The camera moves ONLY if that point is off screen (src/lib/persona/
   *  focus.ts) — at the default view the whole figure is in frame, so running
   *  down a list of two hundred rows lights two hundred points and swings the
   *  body not once. */
  highlightId?: string | null
}

export const PersonaFigure = ({
  nodes,
  gapRegion,
  pendingRegion,
  spark,
  onSelect,
  onTapEmpty,
  onTapGap,
  regionLabel,
  provenance,
  regionSummary,
  onProbe,
  highlightId = null,
}: PersonaFigureProps) => {
  const { t } = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef<Field | null>(null)
  const camRef = useRef<Cam>({ x: 0, y: 0, s: 1 })
  const camToRef = useRef<Cam>({ x: 0, y: 0, s: 1 })
  const velRef = useRef({ x: 0, y: 0 })
  const burstRef = useRef<Burst[]>([])
  const dragRef = useRef<{
    wx: number
    wy: number
    lx: number
    ly: number
    moved: number
    pan: boolean
  } | null>(null)
  const pinchRef = useRef<{ d: number; s0: number; wx: number; wy: number } | null>(null)
  const spaceRef = useRef(false)
  const hoverRef = useRef<Particle | null>(null)
  /** The probed region, mirrored for the draw loop (which dims everything else)
   *  so a hover does not re-run the animation effect. */
  const probeRef = useRef<PersonaRegion | null>(null)
  /** Index into `nodes` of the point the list is pointing at, or -1. AN INDEX,
   *  not the particle: the field is thrown away and re-seated on every resize,
   *  so a held particle would be a stale object that silently matches nothing.
   *  The index survives re-seating, and the draw loop's comparison is O(1). */
  const hlRef = useRef(-1)
  const [tip, setTip] = useState<TipState | null>(null)
  const [probe, setProbe] = useState<ProbeState | null>(null)
  const [zoomed, setZoomed] = useState(false)

  // Latest props for the native listeners, which are attached once: reading
  // them through a ref keeps a re-render from tearing down and re-adding the
  // whole gesture surface (which would drop an in-flight drag).
  const live = useRef({
    nodes,
    gapRegion,
    onSelect,
    onTapEmpty,
    onTapGap,
    regionLabel,
    provenance,
    onProbe,
    t,
  })
  live.current = {
    nodes,
    gapRegion,
    onSelect,
    onTapEmpty,
    onTapGap,
    regionLabel,
    provenance,
    onProbe,
    t,
  }

  const reduced = useMemo(prefersReducedMotion, [])

  /** One place that changes the probe, because three of them (pointer move,
   *  pointer leave, keyboard) must agree on both the panel and the callback. */
  const setProbed = useCallback((next: ProbeState | null) => {
    const before = probeRef.current
    probeRef.current = next?.region ?? null
    setProbe(next)
    if ((next?.region ?? null) !== before) live.current.onProbe?.(next?.region ?? null)
  }, [])

  const clampCam = useCallback(() => {
    const f = fieldRef.current
    if (!f) return
    const cam = camToRef.current
    const hw = f.w / (2 * cam.s)
    const hh = f.h / (2 * cam.s)
    cam.x = Math.min(f.w * (1 + PAN_MARGIN) - hw, Math.max(-f.w * PAN_MARGIN + hw, cam.x))
    cam.y = Math.min(f.h * (1 + PAN_MARGIN) - hh, Math.max(-f.h * PAN_MARGIN + hh, cam.y))
  }, [])

  const recenter = useCallback(() => {
    const f = fieldRef.current
    if (!f) return
    camToRef.current = { x: f.w / 2, y: f.h / 2, s: 1 }
    velRef.current = { x: 0, y: 0 }
    setZoomed(false)
  }, [])

  const rebuild = useCallback(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    const rect = host.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2)
    canvas.width = w * dpr
    canvas.height = h * dpr
    const field = buildField(w, h)
    fieldRef.current = field
    burstRef.current = []
    seatNodes(field, live.current.nodes)
    seatGap(field, live.current.gapRegion)
    camRef.current = { x: w / 2, y: h / 2, s: 1 }
    camToRef.current = { x: w / 2, y: h / 2, s: 1 }
    setZoomed(false)
    // Deps stay EMPTY on purpose: this throws the particle field away and
    // recenters the camera, so it must fire for a resize and nothing else.
    // Reading the current nodes/gap through `live` is what keeps a new answer
    // from rebuilding the body and yanking the view back under the owner.
  }, [])

  // Build on mount + whenever the panel is resized.
  useEffect(() => {
    rebuild()
    const host = hostRef.current
    if (!host) return
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => rebuild())
      ro.observe(host)
      return () => ro.disconnect()
    }
    const onResize = () => rebuild()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [rebuild])

  useEffect(() => {
    const f = fieldRef.current
    if (!f) return
    seatNodes(f, nodes)
    seatGap(f, gapRegion)
  }, [nodes, gapRegion])

  // The list is pointing at a line. Light its point, and travel to it ONLY if
  // it is off screen — see focus.ts for why that condition is the whole rule.
  // Declared AFTER the seating effect so a highlight arriving in the same
  // render as a new note reads the seat that note was just given.
  useEffect(() => {
    const idx = highlightId ? nodes.findIndex((n) => n.id === highlightId) : -1
    hlRef.current = idx
    if (idx === -1) return
    const f = fieldRef.current
    if (!f) return
    const p = f.particles.find((q) => q.node === idx)
    if (!p) return
    const next = cameraForPoint(
      { x: f.ox + p.x * f.s, y: f.oy + p.y * f.s },
      camToRef.current,
      { w: f.w, h: f.h },
    )
    if (!next) return
    camToRef.current = next
    velRef.current = { x: 0, y: 0 }
    clampCam()
    // The camera left home, so the way back has to be on screen — the same chip
    // a pan or a zoom raises. (`zoomed` is "the camera moved", not "s > 1".)
    setZoomed(true)
  }, [highlightId, nodes, clampCam])

  // A course ended (or was abandoned): its un-consolidated answers stop being
  // dots. They were never findings, so they must not linger looking like one.
  useEffect(() => {
    const f = fieldRef.current
    if (!f || pendingRegion) return
    for (const p of f.particles) p.raw = false
  }, [pendingRegion])

  // Sparks. Fired by `seq` changing, never by value equality — answering twice
  // in the same region must spark twice.
  useEffect(() => {
    const f = fieldRef.current
    if (!f || !spark) return
    for (let i = 0; i < spark.count; i++) {
      const target = freeParticle(f, spark.region)
      if (!target) break
      // Claim the seat now, light it on ARRIVAL: a node that appears before its
      // spark gets there would make the flight decorative rather than the thing
      // that put it on the body.
      target.reserved = true
      burstRef.current.push({
        x0: f.w - 140,
        y0: f.h - 100,
        target,
        t: reduced ? 1 : -i * 0.12,
        raw: spark.kind === 'raw',
      })
    }
    // `spark.seq` is the trigger; the rest of the object is read once here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spark?.seq, reduced])

  // The draw loop. One rAF for the whole surface — the particles twinkle and
  // the camera eases, so there is always something to draw while mounted.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    // jsdom (tests) has no 2D context. Everything else on this surface — the
    // note list, the region list, the probe — still works, which is the point of
    // keeping both the data and the geometry out of here.
    if (!ctx) return
    if (typeof requestAnimationFrame !== 'function') return
    let raf = 0
    let clock = 0
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2)

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const f = fieldRef.current
      if (!f) return
      clock += 0.016
      const cam = camRef.current
      const camTo = camToRef.current
      const vel = velRef.current
      const k = reduced ? 1 : 0.16
      if (dragRef.current?.pan) {
        cam.x = camTo.x
        cam.y = camTo.y
      } else {
        if (!reduced && Math.abs(vel.x) + Math.abs(vel.y) > 0.02) {
          camTo.x += vel.x
          camTo.y += vel.y
          vel.x *= 0.9
          vel.y *= 0.9
        }
        cam.x += (camTo.x - cam.x) * k
        cam.y += (camTo.y - cam.y) * k
      }
      cam.s = reduced
        ? camTo.s
        : Math.exp(Math.log(cam.s) + (Math.log(camTo.s) - Math.log(cam.s)) * k)
      if (Math.abs(cam.s - camTo.s) < 0.001) cam.s = camTo.s

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, f.w, f.h)
      const sq = Math.sqrt(cam.s)
      const probed = probeRef.current
      const hl = hlRef.current
      /** Where the pointed-at point landed, so its ring can be drawn on top of
       *  every other particle instead of under the ones seated after it. */
      let hlAt: { x: number; y: number } | null = null
      for (const p of f.particles) {
        // figure space → layout px → camera.
        const lx = f.ox + p.x * f.s
        const ly = f.oy + p.y * f.s
        const vx = (lx - cam.x) * cam.s + f.w / 2
        const vy = (ly - cam.y) * cam.s + f.h / 2
        if (vx < -30 || vx > f.w + 30 || vy < -30 || vy > f.h + 30) continue
        // ⚠ THE POINTED-AT POINT IS NEVER DIMMED. A probe dims every region but
        // one; if the list points at a line seated outside that region, the
        // thing the owner is actually pointing at would be the faintest dot on
        // the screen — the exact inverse of what both gestures mean.
        const hot = hl !== -1 && p.node === hl
        const dim = !hot && probed !== null && p.region !== probed
        const halo = p.region === 'people'
        if (p.node !== -1 || p.mint) {
          if (p.fresh > 0) p.fresh = Math.max(0, p.fresh - (reduced ? 1 : 0.012))
          const br = 0.72 + 0.28 * Math.sin(clock * 0.9 + p.seed)
          if (hot) hlAt = { x: vx, y: vy }
          ctx.globalAlpha = dim
            ? 0.12
            : hot
              ? 1
              : Math.min(1, (halo ? 0.34 : 0.5) + 0.5 * br + p.fresh)
          ctx.fillStyle =
            p.fresh > 0
              ? TONE_FRESH
              : hot || hoverRef.current === p || (probed !== null && p.region === probed)
                ? TONE_HOVER
                : halo
                  ? TONE_HALO_LIT
                  : TONE_BODY_LIT
          ctx.beginPath()
          ctx.arc(
            vx,
            vy,
            ((dim ? 1.1 : hot ? 2.5 : halo ? 1.2 : 1.65) + p.fresh * 3.2) * sq,
            0,
            Math.PI * 2,
          )
          ctx.fill()
        } else if (p.raw) {
          ctx.globalAlpha = dim ? 0.12 : 0.34
          ctx.fillStyle = TONE_BODY_LIT
          ctx.beginPath()
          ctx.arc(vx, vy, 1.3 * sq, 0, Math.PI * 2)
          ctx.fill()
        } else if (p.gap) {
          ctx.globalAlpha = reduced ? 0.3 : 0.2 + 0.16 * Math.sin(clock * 1.6 + p.seed)
          ctx.fillStyle = TONE_HOVER
          ctx.beginPath()
          ctx.arc(vx, vy, 1.1 * sq, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.globalAlpha = dim ? 0.045 : 0.12
          ctx.fillStyle = TONE_UNLIT
          ctx.beginPath()
          ctx.arc(vx, vy, 0.95 * sq, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1

      // The ring around the pointed-at point. A brighter dot alone is not
      // findable on a body of ~1,800 points that all twinkle; the ring is what
      // makes "this line is HERE in you" a single glance instead of a search.
      if (hlAt) {
        ctx.globalAlpha = 0.85
        ctx.strokeStyle = TONE_HOVER
        ctx.lineWidth = 1.1
        ctx.beginPath()
        ctx.arc(hlAt.x, hlAt.y, (reduced ? 9 : 9 + Math.sin(clock * 3.2) * 1.6) * sq, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
      }

      for (let i = burstRef.current.length - 1; i >= 0; i--) {
        const b = burstRef.current[i]
        b.t += 0.035
        if (b.t >= 1) {
          b.target.reserved = false
          if (b.raw) b.target.raw = true
          else {
            b.target.mint = true
            // The flare belongs to ARRIVAL, not to departure: the point lights
            // when the thing actually landed on the body.
            b.target.fresh = 1
          }
          burstRef.current.splice(i, 1)
          continue
        }
        if (b.t < 0) continue
        const e = 1 - Math.pow(1 - b.t, 3)
        const tx = (f.ox + b.target.x * f.s - cam.x) * cam.s + f.w / 2
        const ty = (f.oy + b.target.y * f.s - cam.y) * cam.s + f.h / 2
        const x = b.x0 + (tx - b.x0) * e
        const y = b.y0 + (ty - b.y0) * e - Math.sin(e * Math.PI) * 42
        ctx.globalAlpha = 0.95 - b.t * 0.35
        ctx.fillStyle = TONE_BODY_LIT
        ctx.beginPath()
        ctx.arc(x, y, b.raw ? 1.7 : 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [reduced])

  // ── gestures ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const worldAt = (clientX: number, clientY: number) => {
      const f = fieldRef.current
      const rect = host.getBoundingClientRect()
      const cam = camRef.current
      const sx = clientX - rect.left
      const sy = clientY - rect.top
      if (!f) return { x: sx, y: sy, sx, sy }
      return { x: (sx - f.w / 2) / cam.s + cam.x, y: (sy - f.h / 2) / cam.s + cam.y, sx, sy }
    }

    /** THE hit test, and the only one. Screen px → layout px → figure space, then
     *  `nearestPoint` — the silhouette is the shape, so a region box would name a
     *  part of the body the owner is not pointing at (armature.ts). */
    const pick = (sx: number, sy: number): Particle | null => {
      const f = fieldRef.current
      if (!f || f.s <= 0) return null
      const cam = camRef.current
      const lx = (sx - f.w / 2) / cam.s + cam.x
      const ly = (sy - f.h / 2) / cam.s + cam.y
      return nearestPoint(
        f.particles,
        (lx - f.ox) / f.s,
        (ly - f.oy) / f.s,
        PICK_RADIUS / (f.s * cam.s),
      )
    }

    const onWheel = (e: WheelEvent) => {
      const f = fieldRef.current
      if (!f) return
      e.preventDefault()
      setTip(null)
      setProbed(null)
      const cam = camToRef.current
      if (e.ctrlKey || e.metaKey) {
        const w0 = worldAt(e.clientX, e.clientY)
        const ns = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.s * (1 + -e.deltaY * ZOOM_STEP)))
        cam.s = ns
        cam.x = w0.x - (w0.sx - f.w / 2) / ns
        cam.y = w0.y - (w0.sy - f.h / 2) / ns
      } else {
        cam.x += e.deltaX / cam.s
        cam.y += e.deltaY / cam.s
      }
      clampCam()
      setZoomed(cam.s > 1.1)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || spaceRef.current) return
      const ae = document.activeElement
      // Never steal the space bar from something the owner is typing in.
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      spaceRef.current = true
      host.style.cursor = 'grab'
      e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      spaceRef.current = false
      dragRef.current = null
      host.style.cursor = 'default'
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      host.setPointerCapture?.(e.pointerId)
      const w0 = worldAt(e.clientX, e.clientY)
      dragRef.current = {
        wx: w0.x,
        wy: w0.y,
        lx: e.clientX,
        ly: e.clientY,
        moved: 0,
        // Touch has no space bar and no hover, so a one-finger drag pans there
        // — the only place this surface's gestures differ from InfiniteCanvas.
        pan: spaceRef.current || e.pointerType === 'touch',
      }
      velRef.current = { x: 0, y: 0 }
      camToRef.current.x = camRef.current.x
      camToRef.current.y = camRef.current.y
      if (dragRef.current.pan) host.style.cursor = 'grabbing'
    }

    const onPointerMove = (e: PointerEvent) => {
      const f = fieldRef.current
      const drag = dragRef.current
      const w0 = worldAt(e.clientX, e.clientY)
      if (drag) {
        drag.moved += Math.abs(e.clientX - drag.lx) + Math.abs(e.clientY - drag.ly)
        drag.lx = e.clientX
        drag.ly = e.clientY
      }
      if (drag?.pan && f) {
        setTip(null)
        setProbed(null)
        const cam = camToRef.current
        cam.x = drag.wx - (w0.sx - f.w / 2) / camRef.current.s
        cam.y = drag.wy - (w0.sy - f.h / 2) / camRef.current.s
        velRef.current = {
          x: (cam.x - camRef.current.x) * 0.5,
          y: (cam.y - camRef.current.y) * 0.5,
        }
        clampCam()
        return
      }
      if (e.pointerType === 'touch') return
      const p = pick(w0.sx, w0.sy)
      hoverRef.current = p
      if (!p) {
        setTip(null)
        setProbed(null)
        host.style.cursor = spaceRef.current ? 'grab' : 'default'
        return
      }
      const { nodes: ns, provenance: prov, t: tr } = live.current
      const node = p.node !== -1 ? ns[p.node] : null
      // ONE panel at a time. Over a lit point the answer is THAT note — the most
      // specific thing there is to say — and the region probe would be a second
      // floating card over the same pixel. Everywhere else, the probe.
      if (node) {
        setProbed(null)
        setTip({ x: w0.sx, y: w0.sy, text: node.text, sub: prov(node) })
      } else if (p.raw) {
        setProbed(null)
        setTip({ x: w0.sx, y: w0.sy, text: tr('persona.tip.raw'), sub: tr('persona.tip.rawSub') })
      } else if (p.gap) {
        setProbed(null)
        setTip({ x: w0.sx, y: w0.sy, text: tr('persona.tip.gap'), sub: tr('persona.tip.gapSub') })
      } else {
        setTip(null)
        setProbed({ region: p.region, at: { x: w0.sx, y: w0.sy } })
      }
      host.style.cursor = 'pointer'
    }

    const endDrag = (e: PointerEvent) => {
      const drag = dragRef.current
      dragRef.current = null
      host.style.cursor = spaceRef.current ? 'grab' : 'default'
      if (!drag || drag.pan || drag.moved >= 6) return
      const w0 = worldAt(e.clientX, e.clientY)
      const p = pick(w0.sx, w0.sy)
      const { nodes: ns, onSelect: sel, onTapEmpty: empty, onTapGap: gap } = live.current
      if (p && p.node !== -1 && ns[p.node]) {
        sel(ns[p.node])
        return
      }
      if (p && (p.gap || p.raw)) {
        gap()
        return
      }
      empty()
      recenter()
    }

    const onPointerCancel = () => {
      dragRef.current = null
      host.style.cursor = spaceRef.current ? 'grab' : 'default'
    }

    const onPointerLeave = () => {
      hoverRef.current = null
      setTip(null)
      setProbed(null)
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      dragRef.current = null
      const [a, b] = [e.touches[0], e.touches[1]]
      const w0 = worldAt((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
      pinchRef.current = {
        d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        s0: camToRef.current.s,
        wx: w0.x,
        wy: w0.y,
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      const f = fieldRef.current
      const pinch = pinchRef.current
      if (!pinch || !f || e.touches.length !== 2) return
      e.preventDefault()
      const [a, b] = [e.touches[0], e.touches[1]]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const rect = host.getBoundingClientRect()
      const mx = (a.clientX + b.clientX) / 2 - rect.left
      const my = (a.clientY + b.clientY) / 2 - rect.top
      const ns = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinch.s0 * (d / pinch.d)))
      const cam = camToRef.current
      cam.s = ns
      cam.x = pinch.wx - (mx - f.w / 2) / ns
      cam.y = pinch.wy - (my - f.h / 2) / ns
      clampCam()
      setZoomed(ns > 1.1)
    }
    const onTouchEnd = () => {
      pinchRef.current = null
    }

    host.addEventListener('wheel', onWheel, { passive: false })
    host.addEventListener('pointerdown', onPointerDown)
    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerup', endDrag)
    host.addEventListener('pointercancel', onPointerCancel)
    host.addEventListener('pointerleave', onPointerLeave)
    host.addEventListener('touchstart', onTouchStart, { passive: true })
    host.addEventListener('touchmove', onTouchMove, { passive: false })
    host.addEventListener('touchend', onTouchEnd)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      host.removeEventListener('wheel', onWheel)
      host.removeEventListener('pointerdown', onPointerDown)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerup', endDrag)
      host.removeEventListener('pointercancel', onPointerCancel)
      host.removeEventListener('pointerleave', onPointerLeave)
      host.removeEventListener('touchstart', onTouchStart)
      host.removeEventListener('touchmove', onTouchMove)
      host.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [clampCam, recenter, setProbed])

  const probeSummary = probe ? regionSummary(probe.region) : null
  const probeLabel = probe ? regionLabel(probe.region) : ''

  return (
    <div ref={hostRef} className="absolute inset-0 touch-none select-none">
      <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />

      {/* The figure is a picture; a picture is not reachable from a keyboard.
       *  Every lit point is therefore ALSO a real button here — same target,
       *  same handler — so a keyboard-only owner can read any note. */}
      <ul className="sr-only" aria-label={t('persona.figure.nodeList')}>
        {nodes.map((n) => (
          <li key={n.id}>
            {/* ⚠ `aria-current` IS THE HIGHLIGHT'S ONLY NON-PIXEL FORM. The ring
             *  is painted on a canvas, which a screen reader cannot see and a
             *  test cannot read; the state it draws is real either way, so it is
             *  announced here too. That also makes the wiring from the list
             *  observable — the ring itself is verified on the running app. */}
            <button
              type="button"
              aria-current={n.id === highlightId ? 'true' : undefined}
              onClick={() => onSelect(n)}
            >
              {n.text}
            </button>
          </li>
        ))}
      </ul>

      {/* The SECOND non-mouse path, and it is not optional. The probe is a hover
       *  affordance: shipping it alone would hand a keyboard owner a screen with
       *  a region map they can be told about but never open. Pressing a region
       *  here opens exactly the panel the pointer opens. */}
      <ul className="sr-only" aria-label={t('persona.figure.regionList')}>
        {PERSONA_REGIONS.map((r) => (
          <li key={r}>
            <button type="button" onClick={() => setProbed({ region: r, at: null })}>
              {regionSummary(r).ariaName}
            </button>
          </li>
        ))}
      </ul>

      {tip && (
        <div
          className="pointer-events-none absolute z-10 max-w-[270px] rounded-[3px] border border-line bg-bg-card/95 px-3 py-2 text-meta leading-relaxed text-ink shadow-card"
          style={{ left: Math.max(8, Math.min(tip.x + 16, (fieldRef.current?.w ?? 0) - 280)), top: tip.y + 14 }}
        >
          {tip.text}
          <span className="mt-0.5 block text-ink-faint">{tip.sub}</span>
        </div>
      )}

      {/* ── the region probe: what this part of you knows, raised where you
       *  point. It replaced a standing wall of text down the left of the stage —
       *  the same facts, but only the ones asked for (owner: 「文字は極力少なく
       *  したい」). It never counts anything itself; see RegionSummary. */}
      {probeSummary && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute z-40 w-[270px] rounded-[3px] border border-line bg-bg-card/95 px-3.5 py-3 shadow-card"
          style={
            probe?.at
              ? {
                  left: Math.max(
                    18,
                    Math.min(probe.at.x + 24, (fieldRef.current?.w ?? PROBE_W + 36) - PROBE_W - 18),
                  ),
                  top: Math.max(18, Math.min(probe.at.y - 40, (fieldRef.current?.h ?? 200) - 160)),
                }
              : { left: 18, top: 18 }
          }
        >
          <h4 className={`label-cap ${capTrackingClass(probeLabel)} text-ochre`}>{probeLabel}</h4>
          {/* THE EMPTIES ARE NOT THE SAME STATE — see regionCountLine, which is
           *  also what the region button announces, so the panel and the screen
           *  reader cannot say different things about the same region. */}
          <p className="mt-1 text-plate text-ink-faint">
            {(() => {
              const line = regionCountLine(probeSummary)
              return t(line.key, line.vars)
            })()}
          </p>
          {/* NEVER summed with the count above: these are the notes that were
           *  spread across the body rather than read (regions.ts tier 4). Only
           *  when there IS a count above — otherwise regionCountLine has already
           *  made the unplaced number the headline, and printing it twice is how
           *  the old contradiction ("nothing here" + "40 not placed") read. */}
          {probeSummary.state === 'read' &&
            probeSummary.placed > 0 &&
            probeSummary.unplaced > 0 && (
              <p className="mt-0.5 text-plate text-ink-faint">
                {t('persona.figure.regionUnplaced', { count: probeSummary.unplaced })}
              </p>
            )}
          {probeSummary.lines.length > 0 && (
            <ul className="mt-2.5 flex flex-col gap-1.5">
              {probeSummary.lines.map((line) => (
                <li key={line.text} className="text-meta leading-relaxed text-ink">
                  {line.text}
                  <span className="mt-0.5 block text-plate text-ink-faint">{line.sub}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {zoomed && (
        <button
          type="button"
          onClick={recenter}
          title={t('persona.figure.reset')}
          className="absolute right-4 top-4 z-10 rounded-full border border-line px-3 py-1 text-meta text-ink-onDeep/70 transition-colors hover:border-accent hover:text-ink-onDeep"
        >
          {t('persona.figure.reset')}
        </button>
      )}
    </div>
  )
}
