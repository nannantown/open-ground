// Performance-measurement helpers for the canvas/board/Ground perf harness.
//
// The numbers we report are *interaction main-thread cost* (how much JS/layout
// work the page does to service a standardized gesture) plus *frame smoothness*
// (how evenly animation frames land while the gesture runs). Both are read in
// PROD mode (the real minified React build the packaged app ships), so they
// reflect what a user actually feels — not dev-mode noise.
//
// Primary metric: Chrome DevTools `Performance.getMetrics` deltas across a
// gesture. `ScriptDuration` is cumulative main-thread JS time; its delta over a
// pan/zoom/drag burst is dominated by React reconciliation, so it falls
// dramatically once we stop re-rendering N children per event. `RecalcStyle*`
// and `Layout*` deltas catch DOM-size effects (virtualization).
import type { CDPSession, Page } from '@playwright/test'

/** Cumulative main-thread metrics sampled from CDP, in milliseconds / counts. */
export interface MetricSample {
  scriptMs: number
  layoutMs: number
  recalcStyleMs: number
  layoutCount: number
  recalcStyleCount: number
}

interface CdpMetric {
  name: string
  value: number
}

const pick = (metrics: CdpMetric[], name: string): number =>
  metrics.find((m) => m.name === name)?.value ?? 0

export const sampleMetrics = async (client: CDPSession): Promise<MetricSample> => {
  const { metrics } = (await client.send('Performance.getMetrics')) as {
    metrics: CdpMetric[]
  }
  return {
    // CDP reports Duration metrics in SECONDS — convert to ms.
    scriptMs: pick(metrics, 'ScriptDuration') * 1000,
    layoutMs: pick(metrics, 'LayoutDuration') * 1000,
    recalcStyleMs: pick(metrics, 'RecalcStyleDuration') * 1000,
    layoutCount: pick(metrics, 'LayoutCount'),
    recalcStyleCount: pick(metrics, 'RecalcStyleCount'),
  }
}

/** Begin recording inter-frame intervals on the page. */
export const startFrameSampler = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const w = window as unknown as {
      __perfFrames?: number[]
      __perfRaf?: number
      __perfLast?: number
    }
    w.__perfFrames = []
    w.__perfLast = performance.now()
    const tick = (t: number) => {
      const last = w.__perfLast ?? t
      w.__perfFrames!.push(t - last)
      w.__perfLast = t
      w.__perfRaf = requestAnimationFrame(tick)
    }
    w.__perfRaf = requestAnimationFrame(tick)
  })
}

export interface FrameStats {
  frames: number
  medianMs: number
  p95Ms: number
  longFrames: number // > 50ms (visible jank at 60fps target)
}

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[idx]
}

/** Stop recording and summarize. The first interval is dropped (warm-up). */
export const stopFrameSampler = async (page: Page): Promise<FrameStats> => {
  const raw = await page.evaluate(() => {
    const w = window as unknown as { __perfFrames?: number[]; __perfRaf?: number }
    if (w.__perfRaf) cancelAnimationFrame(w.__perfRaf)
    const f = w.__perfFrames ?? []
    w.__perfFrames = []
    return f
  })
  const frames = raw.slice(1).filter((d) => d > 0)
  const sorted = [...frames].sort((a, b) => a - b)
  return {
    frames: frames.length,
    medianMs: round2(quantile(sorted, 0.5)),
    p95Ms: round2(quantile(sorted, 0.95)),
    longFrames: frames.filter((d) => d > 50).length,
  }
}

export interface GestureResult {
  name: string
  wallMs: number
  scriptMs: number
  layoutMs: number
  recalcStyleMs: number
  layoutCount: number
  recalcStyleCount: number
  frames: FrameStats
}

export const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Run `fn` (a scripted gesture) while sampling CDP metrics + frame cadence,
 * and return the delta cost attributable to the gesture. A short settle after
 * the gesture lets the final React commit + paint land before the after-sample.
 */
export const measureGesture = async (
  page: Page,
  client: CDPSession,
  name: string,
  fn: () => Promise<void>,
  settleMs = 200,
): Promise<GestureResult> => {
  // Quiesce, then snapshot.
  await page.waitForTimeout(120)
  const before = await sampleMetrics(client)
  await startFrameSampler(page)
  const t0 = Date.now()
  await fn()
  const wallMs = Date.now() - t0
  await page.waitForTimeout(settleMs)
  const after = await sampleMetrics(client)
  const frames = await stopFrameSampler(page)
  return {
    name,
    wallMs,
    scriptMs: round2(after.scriptMs - before.scriptMs),
    layoutMs: round2(after.layoutMs - before.layoutMs),
    recalcStyleMs: round2(after.recalcStyleMs - before.recalcStyleMs),
    layoutCount: after.layoutCount - before.layoutCount,
    recalcStyleCount: after.recalcStyleCount - before.recalcStyleCount,
    frames,
  }
}

// ── Scripted gestures ───────────────────────────────────────────────────────

// Dispatch a REALISTIC wheel burst: `perFrame` wheel events per animation frame
// across `frames` frames. A real trackpad/precision mouse emits events faster
// than the frame rate (~5-10 per frame), so this mirrors actual input density —
// and it's exactly what the rAF-coalesced commit is designed to absorb (N
// events/frame → 1 render/frame). Driving it from inside the page (one
// page.evaluate) instead of awaited page.mouse.wheel round-trips is what makes
// the density realistic; the awaited path is artificially ~1 event per 20ms.
const wheelBurst = async (
  page: Page,
  cx: number,
  cy: number,
  opts: { zoom: boolean; frames: number; perFrame: number },
): Promise<void> => {
  await page.evaluate(
    async ({ cx, cy, zoom, frames, perFrame }) => {
      const target = (document.elementFromPoint(cx, cy) ?? document.body) as Element
      const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
      for (let f = 0; f < frames; f++) {
        for (let i = 0; i < perFrame; i++) {
          const ev = new WheelEvent('wheel', {
            // Pan: diagonal scroll. Zoom: ctrlKey + alternating deltaY so we
            // never pin against the min/max-zoom clamp (which would stop work).
            deltaX: zoom ? 0 : 12,
            deltaY: zoom ? (f % 2 === 0 ? -10 : 10) : 12,
            ctrlKey: zoom,
            clientX: cx,
            clientY: cy,
            bubbles: true,
            cancelable: true,
          })
          target.dispatchEvent(ev)
        }
        await raf()
      }
    },
    { cx, cy, zoom: opts.zoom, frames: opts.frames, perFrame: opts.perFrame },
  )
}

/** Plain wheel over a point = canvas PAN (InfiniteCanvas onWheel, no modifier). */
export const wheelPan = async (page: Page, cx: number, cy: number): Promise<void> =>
  wheelBurst(page, cx, cy, { zoom: false, frames: 15, perFrame: 6 })

/** Ctrl+wheel over a point = canvas ZOOM (InfiniteCanvas onWheel, ctrlKey). */
export const wheelZoom = async (page: Page, cx: number, cy: number): Promise<void> =>
  wheelBurst(page, cx, cy, { zoom: true, frames: 15, perFrame: 6 })

/** Pointer drag from a point by (dx,dy) over `steps` moves = element/card drag. */
export const pointerDrag = async (
  page: Page,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  steps = 30,
): Promise<void> => {
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps)
  }
  await page.mouse.up()
}
