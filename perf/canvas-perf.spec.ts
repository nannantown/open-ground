import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { seedHeavyHome, type SeedResult } from './seed'
import {
  measureGesture,
  pointerDrag,
  round2,
  wheelPan,
  wheelZoom,
  type GestureResult,
} from './measure'

// One serial test that seeds a heavy isolated home (50 projects / 200 Board
// cards / 300 Canvas elements), then drives standardized gestures on each
// surface and records interaction main-thread cost + frame smoothness. Results
// are written to PERF_OUT (default: scratchpad) so a baseline run and an
// after-fix run can be diffed for the "before/after numbers" deliverable.

const LABEL = process.env.PERF_LABEL ?? 'run'
const OUT =
  process.env.PERF_OUT ??
  `/private/tmp/claude-502/-Users-kokinaniwa-projects-OPEN-GROUND-w2-0630-171946-3517/3f0ca048-4422-48f6-9d86-1bc617faf2f3/scratchpad/perf-${LABEL}.json`

interface MountResult {
  name: string
  ms: number
  count: number
}

const center = async (loc: Locator): Promise<{ x: number; y: number }> => {
  const box = await loc.boundingBox()
  if (!box) throw new Error('no bounding box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Reload to a view and time how long until `count` nodes of `selector` exist.
const navAndMount = async (
  page: Page,
  name: string,
  selector: string,
  expected: number,
  prep: () => Promise<void>,
): Promise<MountResult> => {
  const t0 = Date.now()
  await prep()
  await expect
    .poll(async () => page.locator(selector).count(), { timeout: 60_000, intervals: [50, 100, 200] })
    .toBeGreaterThanOrEqual(expected)
  const ms = Date.now() - t0
  const cnt = await page.locator(selector).count()
  return { name, ms, count: cnt }
}

test.describe.configure({ mode: 'serial' })

test('canvas/board/ground perf at scale', async ({ page, request }) => {
  test.setTimeout(220_000)

  const seed: SeedResult = await seedHeavyHome(request)
  expect(seed.projects.length).toBeGreaterThanOrEqual(50)

  const client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')

  await page.addInitScript(() => {
    localStorage.setItem('openground:onboarded', '1')
  })

  const gestures: GestureResult[] = []
  const mounts: MountResult[] = []

  // ── Ground (50+ project cards) ────────────────────────────────────────────
  mounts.push(
    await navAndMount(page, 'ground-mount', '[data-card-id]', 50, async () => {
      await page.goto('/', { waitUntil: 'domcontentloaded' })
    }),
  )
  {
    const grid = page.locator('.canvas-grid').first()
    const c = await center(grid)
    gestures.push(await measureGesture(page, client, 'ground-pan', () => wheelPan(page, c.x, c.y)))
    gestures.push(await measureGesture(page, client, 'ground-zoom', () => wheelZoom(page, c.x, c.y)))
    // Drag a card (pointer down on it, move, up) — exercises the per-move
    // onCanvasChange path that re-renders every card.
    const card = page.locator('[data-card-id]').first()
    const cc = await center(card)
    gestures.push(
      await measureGesture(page, client, 'ground-drag-card', () =>
        pointerDrag(page, cc.x, cc.y, 80, 60),
      ),
    )
  }

  // ── Canvas (300 elements) ─────────────────────────────────────────────────
  // Expect ≥5 element nodes: the baseline (no culling) mounts all 300, the
  // virtualised build mounts only the on-screen subset (~a dozen on the narrowed
  // canvas surface). Both clear 5; the time-to-first-paint is what differs (and
  // what we measure) — the culled build paints far fewer DOM nodes.
  mounts.push(
    await navAndMount(page, 'canvas-mount', '[data-element-id]', 5, async () => {
      await page.evaluate(
        (v) => localStorage.setItem('openground.view', v),
        JSON.stringify({ projectId: seed.heavy.id, panelTab: 'canvas' }),
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
    }),
  )
  {
    const grid = page.locator('.canvas-grid').last()
    const c = await center(grid)
    gestures.push(await measureGesture(page, client, 'canvas-pan', () => wheelPan(page, c.x, c.y)))
    gestures.push(await measureGesture(page, client, 'canvas-zoom', () => wheelZoom(page, c.x, c.y)))
    const el = page.locator('[data-element-id]').first()
    const ec = await center(el)
    gestures.push(
      await measureGesture(page, client, 'canvas-drag-element', () =>
        pointerDrag(page, ec.x, ec.y, 120, 80),
      ),
    )
    // Click an element = selection change (re-renders all elements without memo).
    gestures.push(
      await measureGesture(page, client, 'canvas-select', async () => {
        await page.mouse.click(ec.x, ec.y)
      }),
    )
  }

  // ── Board (200 cards) ─────────────────────────────────────────────────────
  mounts.push(
    await navAndMount(page, 'board-mount', 'article', 200, async () => {
      await page.evaluate(
        (v) => localStorage.setItem('openground.view', v),
        JSON.stringify({ projectId: seed.heavy.id, panelTab: 'board' }),
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
    }),
  )
  {
    // Drag-hover storm: the dominant Board bottleneck is `dragover → setDropPos`
    // firing a full 200-card re-render per move. Drive it synthetically over the
    // todo column without opening the drawer (which would spawn a PTY).
    const firstCard = page.locator('article').first()
    const col = page.locator('.overflow-y-auto').first()
    const colCenter = await center(col)
    gestures.push(
      await measureGesture(page, client, 'board-dragover-storm', async () => {
        await firstCard.dispatchEvent('dragstart', { dataTransfer: await makeDataTransfer(page) })
        for (let i = 0; i < 40; i++) {
          await col.dispatchEvent('dragover', {
            dataTransfer: await makeDataTransfer(page),
            clientX: colCenter.x,
            clientY: colCenter.y + ((i % 20) - 10) * 12,
            bubbles: true,
          })
        }
        await col.dispatchEvent('drop', { dataTransfer: await makeDataTransfer(page) })
      }),
    )
    // Column scroll — big-list paint/layout cost.
    gestures.push(
      await measureGesture(page, client, 'board-scroll', async () => {
        await page.mouse.move(colCenter.x, colCenter.y)
        for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 60)
      }),
    )
  }

  // ── Persist + report ──────────────────────────────────────────────────────
  const payload = { label: LABEL, ts: new Date().toISOString(), seed: { projects: seed.projects.length, tasks: seed.taskCount, elements: seed.elementCount }, mounts, gestures }
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(payload, null, 2))

  // Console table (shows up in the `list` reporter output).
  const lines = [
    `\n=== PERF [${LABEL}] — 50 proj / ${seed.taskCount} cards / ${seed.elementCount} elements ===`,
    `MOUNT (ms): ` + mounts.map((m) => `${m.name}=${m.ms}(${m.count})`).join('  '),
    `GESTURE                  script(ms)  layout(ms)  recalc(ms)  medFrame  longFr  wall(ms)`,
    ...gestures.map(
      (g) =>
        `${g.name.padEnd(24)} ${String(g.scriptMs).padStart(9)} ${String(g.layoutMs).padStart(10)} ${String(g.recalcStyleMs).padStart(10)} ${String(g.frames.medianMs).padStart(8)} ${String(g.frames.longFrames).padStart(6)} ${String(g.wallMs).padStart(8)}`,
    ),
  ]
  console.log(lines.join('\n'))
  console.log(`\nwrote ${OUT}`)

  expect(round2(gestures.reduce((a, g) => a + g.scriptMs, 0))).toBeGreaterThan(0)
})

// A real DataTransfer so React's native-drag handlers (which read effectAllowed
// / setData) behave; Playwright's dispatchEvent won't synthesize one for us.
const makeDataTransfer = async (page: Page) =>
  page.evaluateHandle(() => new DataTransfer())
