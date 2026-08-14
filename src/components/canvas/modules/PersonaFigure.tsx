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
// NO DATA OF ITS OWN. Everything it draws is a prop; every write lives in
// PersonaModule. That keeps this file a renderer + a gesture surface, and keeps
// the pure parts (which zone a note belongs to, how a judgment becomes a node)
// exported and testable without touching a pixel.
//
// GESTURES ARE THE SAME CONTRACT AS InfiniteCanvas (src/components/canvas/
// InfiniteCanvas.tsx) — the app already taught the owner one canvas language and
// a second one would be a bug: plain wheel / two-finger scroll pans by
// (deltaX, deltaY); ⌘/Ctrl + wheel zooms by `zoom * (1 + (-deltaY * 0.01))`
// anchored at the cursor; holding Space turns a drag into a pan. Touch adds a
// one-finger drag-pan and a two-finger pinch, which InfiniteCanvas has no
// equivalent of only because it is not a touch surface.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { COURSES } from '@/lib/persona/instruments'
import type { ManualJudgment, PersonaCourseId, PersonaQuestion, PersonaQuestionKind } from '@/lib/types'

// ── zones ───────────────────────────────────────────────────────────────────

/** The five regions of the figure. Same vocabulary the courses use
 *  (PersonaCourse.zone in instruments.ts), so a course visibly grows a REGION
 *  rather than an abstract score. */
export type PersonaZone = 'mind' | 'values' | 'craft' | 'core' | 'ground'

export const PERSONA_ZONES: readonly PersonaZone[] = ['mind', 'values', 'craft', 'core', 'ground']

/** FNV-1a. Any hash would do; what matters is that it is DETERMINISTIC — a note
 *  must sit in the same place on every mount, on every machine. `Math.random()`
 *  here would make the figure reshuffle itself each time the tab is opened, and
 *  a body that rearranges itself is not a mirror of anything. */
export const personaHash = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const COURSE_IDS = new Set<string>(COURSES.map((c) => c.id))

/** Which course minted this note, if any. The server tags a course finding with
 *  the course id; the exact prefix it uses is its own business, so every
 *  separator-delimited token of every tag is checked ('big5', 'persona:big5',
 *  'course-big5' all read the same). The course NAME appearing in the note's
 *  `context` is accepted as a fallback because a finding's provenance line is
 *  `<course name> ・ <the number it came from>` — see PersonaFinding.detail. */
export const courseIdFromJudgment = (j: {
  tags?: string[]
  context?: string
}): PersonaCourseId | null => {
  for (const tag of j.tags ?? []) {
    for (const part of tag.toLowerCase().split(/[\s:/\-_.]+/)) {
      if (COURSE_IDS.has(part)) return part as PersonaCourseId
    }
  }
  const named = j.context ? COURSES.find((c) => j.context?.includes(c.name)) : undefined
  return named ? named.id : null
}

/** Which region the day's question is digging in. Driven by the question's
 *  KIND (a durable, enumerable fact — see PersonaQuestionKind) rather than its
 *  wording, so the pulsing patch is stable for the life of the question. */
const QUESTION_ZONE: Record<PersonaQuestionKind, PersonaZone> = {
  'decision-speed-contrast': 'mind',
  'escalation-answer-rule': 'values',
  'escalation-dismissed': 'values',
  'escalation-long-open': 'mind',
  'corpus-gap': 'core',
  'card-rework': 'craft',
  'card-approved': 'craft',
  'card-stale-blocked': 'ground',
  'todo-passed-over': 'ground',
}

export const zoneForQuestion = (q: PersonaQuestion | null): PersonaZone | null =>
  q ? QUESTION_ZONE[q.kind] ?? 'mind' : null

/** Where a note sits on the figure, in priority order:
 *   1. a course finding lands in the region that course grows;
 *   2. an interview answer lands in the region its question was digging in —
 *      personaInterview.ts tags the write-back `['interview', q.kind]`, so the
 *      answer lights up the very patch that was pulsing while it was asked;
 *   3. everything else is spread deterministically by hash. That is the honest
 *      default: we do not know what a free-form note is "about", and guessing
 *      would put a wrong label on the owner's own words. */
export const zoneForJudgment = (j: ManualJudgment): PersonaZone => {
  const courseId = courseIdFromJudgment(j)
  if (courseId) {
    const course = COURSES.find((c) => c.id === courseId)
    if (course) return course.zone
  }
  for (const tag of j.tags ?? []) {
    const zone = QUESTION_ZONE[tag as PersonaQuestionKind]
    if (zone) return zone
  }
  return PERSONA_ZONES[personaHash(`${j.id}|${(j.tags ?? []).join(',')}`) % PERSONA_ZONES.length]
}

// ── nodes ───────────────────────────────────────────────────────────────────

/** One lit point: one note, its region, and enough of the note to show without
 *  going back to the list. */
export interface PersonaNode {
  id: string
  zone: PersonaZone
  text: string
  addedAt: string
  tags: string[]
  context?: string
  correctsId?: string
  courseId: PersonaCourseId | null
}

export const buildPersonaNodes = (judgments: ManualJudgment[]): PersonaNode[] =>
  judgments.map((j) => ({
    id: j.id,
    zone: zoneForJudgment(j),
    text: j.text,
    addedAt: j.addedAt,
    tags: j.tags ?? [],
    ...(j.context ? { context: j.context } : {}),
    ...(j.correctsId ? { correctsId: j.correctsId } : {}),
    courseId: courseIdFromJudgment(j),
  }))

// ── the particle field ──────────────────────────────────────────────────────

interface Particle {
  x: number
  y: number
  zone: PersonaZone
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
}

interface Field {
  w: number
  h: number
  particles: Particle[]
}

// The stage is `bg-bg-deep`, which is dark in BOTH themes (the same token the
// terminal frames sit on), so the figure's three tones are FIXED rather than
// read from the live theme: the light theme's ink-faint is a dark brown that
// would vanish here, and dust that disappears at noon is not a smaller bug than
// a wrong hue. Values are the dark-theme channels from src/app/globals.css
// (--og-accent / --og-ink-faint / --og-ochre), as bare "R G B" triplets for
// `rgb(R G B / a)`.
const TONE_LIT = '242 149 128'
const TONE_DUST = '201 189 170'
const TONE_GAP = '221 174 88'

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

/** A request to fly sparks into a zone. `seq` is what makes it fire: bump it
 *  and the same zone sparks again (a value-equal prop would not). */
export interface PersonaSpark {
  seq: number
  zone: PersonaZone
  count: number
  /** 'raw' = one dim answer dot; 'node' = a finding taking its place. */
  kind: 'raw' | 'node'
}

const ZOOM_STEP = 0.01
const ZOOM_MIN = 1
const ZOOM_MAX = 2.6
/** How far past the frame the camera may travel — the figure can be pushed to
 *  the edge, never off screen. */
const PAN_MARGIN = 0.22
const PICK_RADIUS = 20
const GAP_PATCH = 18

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** The silhouette, drawn once into an offscreen canvas and read back as an
 *  alpha mask — the particles are simply the pixels that came back opaque. A
 *  path (rather than an image) so it scales to any panel size and ships no
 *  asset. Returns null where 2D canvas is unavailable (jsdom in tests). */
const silhouetteMask = (
  w: number,
  h: number,
): { data: Uint8ClampedArray; unit: number; top: number; cx: number } | null => {
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const g = off.getContext('2d')
  if (!g) return null
  g.fillStyle = '#fff'
  g.strokeStyle = '#fff'
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const cx = w * 0.5
  const top = h * 0.1
  const u = h * 0.058
  const line = (a: number, b: number, c: number, d: number) => {
    g.beginPath()
    g.moveTo(a, b)
    g.lineTo(c, d)
    g.stroke()
  }
  const path = (pts: [number, number][]) => {
    g.beginPath()
    g.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
    g.stroke()
  }
  g.beginPath()
  g.arc(cx, top + u, u, 0, Math.PI * 2)
  g.fill()
  g.lineWidth = u * 0.52
  line(cx, top + u * 2.0, cx, top + u * 2.45)
  g.lineWidth = u * 0.6
  line(cx - u * 1.38, top + u * 2.85, cx + u * 1.38, top + u * 2.85)
  g.lineWidth = u * 1.85
  line(cx, top + u * 3.15, cx, top + u * 4.55)
  g.lineWidth = u * 1.3
  line(cx, top + u * 4.45, cx, top + u * 5.75)
  g.lineWidth = u * 1.55
  line(cx, top + u * 5.7, cx, top + u * 6.35)
  g.lineWidth = u * 0.4
  path([
    [cx - u * 1.58, top + u * 3.0],
    [cx - u * 1.8, top + u * 4.7],
    [cx - u * 1.55, top + u * 6.45],
  ])
  path([
    [cx + u * 1.58, top + u * 3.0],
    [cx + u * 1.8, top + u * 4.7],
    [cx + u * 1.55, top + u * 6.45],
  ])
  g.lineWidth = u * 0.52
  path([
    [cx - u * 0.52, top + u * 6.45],
    [cx - u * 0.6, top + u * 9.2],
    [cx - u * 0.66, top + u * 11.7],
  ])
  path([
    [cx + u * 0.52, top + u * 6.45],
    [cx + u * 0.6, top + u * 9.2],
    [cx + u * 0.66, top + u * 11.7],
  ])
  g.lineWidth = u * 0.34
  line(cx - u * 0.66, top + u * 11.9, cx - u * 1.05, top + u * 11.9)
  line(cx + u * 0.66, top + u * 11.9, cx + u * 1.05, top + u * 11.9)
  return { data: g.getImageData(0, 0, w, h).data, unit: u, top, cx }
}

const buildField = (w: number, h: number): Field | null => {
  const mask = silhouetteMask(w, h)
  if (!mask) return null
  const step = Math.max(6, Math.round(h / 96))
  const particles: Particle[] = []
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (mask.data[(y * w + x) * 4 + 3] <= 128) continue
      const zone: PersonaZone =
        y < mask.top + mask.unit * 2.5
          ? 'mind'
          : Math.abs(x - mask.cx) > mask.unit * 1.15 && y < mask.top + mask.unit * 6.5
            ? 'craft'
            : y < mask.top + mask.unit * 4.6
              ? 'values'
              : y < mask.top + mask.unit * 6.5
                ? 'core'
                : 'ground'
      particles.push({
        x,
        y,
        zone,
        // Seeded from the position, not Math.random: the twinkle is then the
        // same on every mount, so a screenshot diff of this surface is stable.
        seed: ((personaHash(`${x},${y}`) % 628) / 100),
        node: -1,
        raw: false,
        mint: false,
        reserved: false,
        gap: false,
      })
    }
  }
  return { w, h, particles }
}

/** Seat every node on a particle of its own zone. Oldest note first so a NEW
 *  note takes a free seat instead of displacing the ones already on screen. */
const seatNodes = (field: Field, nodes: PersonaNode[]): void => {
  for (const p of field.particles) {
    p.node = -1
    p.mint = false
  }
  const byZone = new Map<PersonaZone, Particle[]>()
  for (const p of field.particles) {
    const list = byZone.get(p.zone)
    if (list) list.push(p)
    else byZone.set(p.zone, [p])
  }
  const order = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.addedAt === b.n.addedAt ? a.n.id.localeCompare(b.n.id) : a.n.addedAt < b.n.addedAt ? -1 : 1))
  for (const { n, i } of order) {
    const pool = byZone.get(n.zone)
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

const seatGap = (field: Field, zone: PersonaZone | null): void => {
  for (const p of field.particles) p.gap = false
  if (!zone) return
  let placed = 0
  for (const p of field.particles) {
    if (placed >= GAP_PATCH) break
    if (p.zone !== zone || p.node !== -1 || p.raw || p.reserved) continue
    p.gap = true
    placed++
  }
}

const freeParticle = (field: Field, zone: PersonaZone): Particle | null => {
  const pool = field.particles.filter(
    (p) => p.zone === zone && p.node === -1 && !p.raw && !p.mint && !p.reserved,
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

export interface PersonaFigureProps {
  nodes: PersonaNode[]
  /** The region the current question is digging in — its dust pulses. */
  gapZone: PersonaZone | null
  /** Set while a course is running; cleared when its result lands, which is
   *  what turns the dim answer dots back into dust before the findings fly in. */
  pendingZone: PersonaZone | null
  spark: PersonaSpark | null
  onSelect: (node: PersonaNode) => void
  /** Tapping empty space / the pulsing patch — the module uses it to close the
   *  open note and to draw attention to the question card. */
  onTapEmpty: () => void
  onTapGap: () => void
  zoneLabel: (zone: PersonaZone) => string
  provenance: (node: PersonaNode) => string
}

export const PersonaFigure = ({
  nodes,
  gapZone,
  pendingZone,
  spark,
  onSelect,
  onTapEmpty,
  onTapGap,
  zoneLabel,
  provenance,
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
  const [tip, setTip] = useState<TipState | null>(null)
  const [zoomed, setZoomed] = useState(false)

  // Latest props for the native listeners, which are attached once: reading
  // them through a ref keeps a re-render from tearing down and re-adding the
  // whole gesture surface (which would drop an in-flight drag).
  const live = useRef({ nodes, gapZone, onSelect, onTapEmpty, onTapGap, zoneLabel, provenance, t })
  live.current = { nodes, gapZone, onSelect, onTapEmpty, onTapGap, zoneLabel, provenance, t }

  const reduced = useMemo(prefersReducedMotion, [])

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
    if (!field) return
    seatNodes(field, live.current.nodes)
    seatGap(field, live.current.gapZone)
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
    seatGap(f, gapZone)
  }, [nodes, gapZone])

  // A course ended (or was abandoned): its un-consolidated answers stop being
  // dots. They were never findings, so they must not linger looking like one.
  useEffect(() => {
    const f = fieldRef.current
    if (!f || pendingZone) return
    for (const p of f.particles) p.raw = false
  }, [pendingZone])

  // Sparks. Fired by `seq` changing, never by value equality — answering twice
  // in the same zone must spark twice.
  useEffect(() => {
    const f = fieldRef.current
    if (!f || !spark) return
    for (let i = 0; i < spark.count; i++) {
      const target = freeParticle(f, spark.zone)
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
    // note list, the question card — still works, which is the point of keeping
    // the data out of here.
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
      for (const p of f.particles) {
        const vx = (p.x - cam.x) * cam.s + f.w / 2
        const vy = (p.y - cam.y) * cam.s + f.h / 2
        if (vx < -30 || vx > f.w + 30 || vy < -30 || vy > f.h + 30) continue
        if (p.node !== -1 || p.mint) {
          const tw = 0.7 + 0.3 * Math.sin(clock * 2 + p.seed * 3)
          const a = hoverRef.current === p ? 1 : 0.5 + 0.4 * tw
          ctx.fillStyle = `rgb(${TONE_LIT} / ${a})`
          ctx.beginPath()
          ctx.arc(vx, vy, (p.node !== -1 ? 2.3 : 1.9) * sq, 0, Math.PI * 2)
          ctx.fill()
          if (p.node !== -1 && cam.s > 1.5) {
            ctx.strokeStyle = `rgb(${TONE_LIT} / 0.22)`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.arc(vx, vy, 6 * sq, 0, Math.PI * 2)
            ctx.stroke()
          }
        } else if (p.raw) {
          ctx.fillStyle = `rgb(${TONE_LIT} / 0.34)`
          ctx.beginPath()
          ctx.arc(vx, vy, 1.3 * sq, 0, Math.PI * 2)
          ctx.fill()
        } else {
          const d = reduced ? 0 : 1
          const ox = Math.sin(clock * 0.7 + p.seed) * 6 * d
          const oy = Math.cos(clock * 0.6 + p.seed * 2) * 6 * d
          const a = p.gap
            ? reduced
              ? 0.3
              : 0.2 + 0.16 * Math.sin(clock * 1.6 + p.seed)
            : 0.15
          ctx.fillStyle = `rgb(${p.gap ? TONE_GAP : TONE_DUST} / ${a})`
          ctx.beginPath()
          ctx.arc(vx + ox, vy + oy, 1.1 * sq, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      for (let i = burstRef.current.length - 1; i >= 0; i--) {
        const b = burstRef.current[i]
        b.t += 0.035
        if (b.t >= 1) {
          b.target.reserved = false
          if (b.raw) b.target.raw = true
          else b.target.mint = true
          burstRef.current.splice(i, 1)
          continue
        }
        if (b.t < 0) continue
        const e = 1 - Math.pow(1 - b.t, 3)
        const tx = (b.target.x - cam.x) * cam.s + f.w / 2
        const ty = (b.target.y - cam.y) * cam.s + f.h / 2
        const x = b.x0 + (tx - b.x0) * e
        const y = b.y0 + (ty - b.y0) * e - Math.sin(e * Math.PI) * 42
        ctx.fillStyle = `rgb(${TONE_LIT} / ${0.95 - b.t * 0.35})`
        ctx.beginPath()
        ctx.arc(x, y, b.raw ? 1.7 : 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
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

    const pick = (sx: number, sy: number): Particle | null => {
      const f = fieldRef.current
      if (!f) return null
      const cam = camRef.current
      let best: Particle | null = null
      let bd = PICK_RADIUS * PICK_RADIUS
      for (const p of f.particles) {
        const dx = (p.x - cam.x) * cam.s + f.w / 2 - sx
        const dy = (p.y - cam.y) * cam.s + f.h / 2 - sy
        const d = dx * dx + dy * dy
        if (d < bd) {
          bd = d
          best = p
        }
      }
      return best
    }

    const onWheel = (e: WheelEvent) => {
      const f = fieldRef.current
      if (!f) return
      e.preventDefault()
      setTip(null)
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
        host.style.cursor = spaceRef.current ? 'grab' : 'default'
        return
      }
      const { nodes: ns, zoneLabel: zl, provenance: prov, t: tr } = live.current
      const node = p.node !== -1 ? ns[p.node] : null
      const tipState: TipState = node
        ? { x: w0.sx, y: w0.sy, text: node.text, sub: prov(node) }
        : p.raw
          ? { x: w0.sx, y: w0.sy, text: tr('persona.tip.raw'), sub: tr('persona.tip.rawSub') }
          : p.gap
            ? { x: w0.sx, y: w0.sy, text: tr('persona.tip.gap'), sub: tr('persona.tip.gapSub') }
            : { x: w0.sx, y: w0.sy, text: tr('persona.tip.dust'), sub: zl(p.zone) }
      setTip(tipState)
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
      host.removeEventListener('touchstart', onTouchStart)
      host.removeEventListener('touchmove', onTouchMove)
      host.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [clampCam, recenter])

  return (
    <div ref={hostRef} className="absolute inset-0 touch-none select-none">
      <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />

      {/* The figure is a picture; a picture is not reachable from a keyboard.
       *  Every lit point is therefore ALSO a real button here — same target,
       *  same handler — so a keyboard-only owner can read any note. */}
      <ul className="sr-only" aria-label={t('persona.figure.nodeList')}>
        {nodes.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onSelect(n)}>
              {n.text}
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
