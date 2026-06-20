import { test, expect, type APIRequestContext, type Locator } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// Canvas tab — Figma-parity behaviours, driven by REAL mouse input (checklist
// G of docs/CANVAS_FIGMA_PARITY_PLAN.md). Same deep-link pattern as
// board-drawer.spec.ts: localStorage `openground.view` lands the page straight
// on the project's Canvas tab.
//
// Ground rules the whole file leans on:
//  - TWO `.canvas-grid` surfaces exist at once (the Ground canvas under the
//    project overlay + the project Canvas). ALWAYS address the LAST one.
//  - The active Canvas persists through a 400ms debounce
//    (ProjectCanvas.SAVE_DEBOUNCE_MS), so every mutation is asserted by
//    POLLING the canvases API until the write lands — never by sleeping.
//  - One rich seed, ONE canvas, separate world-space clusters per test, all
//    engine-consistent (positions match what applyAutoLayout computes) so the
//    first client-side mutation can't shuffle a neighbouring cluster.
//  - Seed viewport is {x:0, y:0, zoom:1} and nothing pans, so screen px ==
//    world px; gestures still derive coordinates from live bounding boxes.

test.use({ viewport: { width: 1600, height: 1000 } })

// ── Seed (written via POST /api/project/canvases — CanvasFile shape) ─────────

interface SeedLayout {
  mode: 'row' | 'column'
  gap: number
  padding: number
  align: 'start' | 'center' | 'end'
  justify?: 'start' | 'center' | 'end' | 'space-between'
}

interface SeedElement {
  id: string
  type: 'sticky' | 'frame'
  x: number
  y: number
  width: number
  height: number
  text: string
  rotation?: number
  parentId?: string
  layout?: SeedLayout
}

const SEED_ELEMENTS: SeedElement[] = [
  // ⇧A cluster — three loose stickies spread horizontally (wrap infers 'row').
  { id: 'wrap-a', type: 'sticky', x: 40, y: 40, width: 60, height: 60, text: 'A' },
  { id: 'wrap-b', type: 'sticky', x: 130, y: 40, width: 60, height: 60, text: 'B' },
  { id: 'wrap-c', type: 'sticky', x: 220, y: 40, width: 60, height: 60, text: 'C' },
  // Justify cluster — a row layout frame with two children already laid out at
  // the engine's own positions (mainStart = x+padding = 50; B = 50+60+gap).
  {
    id: 'just-frame',
    type: 'frame',
    x: 40,
    y: 200,
    width: 400,
    height: 120,
    text: 'Justify',
    layout: { mode: 'row', gap: 10, padding: 10, align: 'start' },
  },
  { id: 'just-a', type: 'sticky', x: 50, y: 210, width: 60, height: 60, text: 'JA', parentId: 'just-frame' },
  { id: 'just-b', type: 'sticky', x: 120, y: 210, width: 60, height: 60, text: 'JB', parentId: 'just-frame' },
  // Rotation cluster — pre-rotated sticky, isolated so the outside-corner
  // rotate annulus (≤26px past a corner) only ever hovers bare canvas.
  { id: 'rot-stick', type: 'sticky', x: 620, y: 40, width: 100, height: 100, text: 'R', rotation: 20 },
  // Resize cluster — a layout frame with ONE child: resizing the child must
  // keep its parentId (a layout child never leaves its frame by resizing).
  {
    id: 'rsz-frame',
    type: 'frame',
    x: 620,
    y: 220,
    width: 220,
    height: 120,
    text: 'Resize',
    layout: { mode: 'row', gap: 10, padding: 10, align: 'start' },
  },
  { id: 'rsz-child', type: 'sticky', x: 630, y: 230, width: 100, height: 100, text: 'RC', parentId: 'rsz-frame' },
  // Layers drop-INTO cluster — a loose sticky and a plain (non-layout) frame.
  // Seeded LAST so both rows sit at the top of the Layers tree (front-most).
  { id: 'drop-stick', type: 'sticky', x: 40, y: 400, width: 80, height: 80, text: 'D' },
  { id: 'drop-frame', type: 'frame', x: 220, y: 400, width: 220, height: 140, text: 'Drop' },
]

// ── API helpers ──────────────────────────────────────────────────────────────

interface ElementJson {
  id: string
  type: string
  x: number
  y: number
  width?: number
  height?: number
  rotation?: number
  parentId?: string
  layout?: { mode?: string; gap?: number; align?: string; justify?: string }
}

interface Seed {
  projectId: string
  path: string
  canvasId: string
}

// One seed per worker (workers=1 → one per run; a retry restarts the worker
// and re-seeds a fresh project, which only makes the retry more isolated).
let seed: Seed | undefined

const ensureSeeded = async (request: APIRequestContext): Promise<Seed> => {
  if (seed) return seed
  const project = await createAndImportProject(request, 'canvas')
  const created = await request.post('/api/project/canvases?action=create', {
    data: { path: project.path, name: 'Playground' },
  })
  expect(created.status()).toBe(200)
  const { canvas } = (await created.json()) as { canvas: { id: string } & Record<string, unknown> }
  const saved = await request.post('/api/project/canvases', {
    data: {
      path: project.path,
      canvas: { ...canvas, viewport: { x: 0, y: 0, zoom: 1 }, elements: SEED_ELEMENTS },
    },
  })
  expect(saved.status()).toBe(200)
  seed = { projectId: project.id, path: project.path, canvasId: canvas.id }
  return seed
}

// Read the persisted canvas back — this is what every mutation test polls
// (absorbing the 400ms save debounce) instead of waiting on wall-clock time.
const readElements = async (request: APIRequestContext): Promise<ElementJson[]> => {
  if (!seed) throw new Error('seed not initialised')
  const res = await request.get(
    `/api/project/canvases?path=${encodeURIComponent(seed.path)}&id=${seed.canvasId}`,
  )
  expect(res.status()).toBe(200)
  const file = (await res.json()) as { elements: ElementJson[] }
  return file.elements
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

const box = async (l: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await l.boundingBox()
  expect(b, 'element must have a bounding box').toBeTruthy()
  if (!b) throw new Error('no bounding box')
  return b
}

const center = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
})

test.describe('Canvas tab (Figma parity)', () => {
  test.beforeEach(async ({ page, request }) => {
    await ensureSeeded(request)
    await page.addInitScript(
      ([projectId]) => {
        // Fresh isolated HOME → skip onboarding; pin the UI language so the
        // asserted labels ('Pages', 'Center', 'Gap mode'…) are deterministic.
        localStorage.setItem('openground:onboarded', '1')
        localStorage.setItem('og-lang', 'en')
        // Deep-link into the Canvas tab — but only when the view key is
        // ABSENT, so the shell test's reload exercises the value the APP
        // itself re-persisted rather than this script overwriting it.
        if (!localStorage.getItem('openground.view')) {
          localStorage.setItem(
            'openground.view',
            JSON.stringify({ projectId, panelTab: 'canvas' }),
          )
        }
      },
      [(seed as Seed).projectId],
    )
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // Two grids = Ground behind the overlay + the project Canvas surface.
    // Interactions must always target the LAST one.
    await expect(page.locator('.canvas-grid')).toHaveCount(2)
  })

  test('deep-link shows Pages/Layers left + Design panel right; reload stays on the Canvas tab', async ({
    page,
  }) => {
    const left = page.locator('aside').filter({ hasText: 'Pages' })
    await expect(left).toBeVisible()
    await expect(left.getByText('Layers')).toBeVisible()
    // Pages lists the seeded Canvas by name.
    await expect(left.getByText('Playground')).toBeVisible()
    // The right sidebar (Design panel) never blanks out: with nothing selected
    // it shows the canvas summary (name + element count).
    const right = page.locator('aside').filter({ hasText: /\d+ elements/ })
    await expect(right).toBeVisible()
    await expect(right.getByText('Playground')).toBeVisible()

    // The APP re-persisted the view on its own (the init script only writes
    // when the key is absent) — so a reload restores the Canvas tab from the
    // app's write, not the test's.
    const persisted = await page.evaluate(() => localStorage.getItem('openground.view'))
    expect(JSON.parse(persisted ?? '{}')).toMatchObject({ panelTab: 'canvas' })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.canvas-grid')).toHaveCount(2)
    await expect(page.locator('aside').filter({ hasText: 'Pages' })).toBeVisible()
    await expect(page.locator('aside').filter({ hasText: /\d+ elements/ })).toBeVisible()
  })

  test('Shift+A wraps a shift-click multi-selection in an auto-layout frame (persisted parentId ×3)', async ({
    page,
    request,
  }) => {
    const a = page.locator('[data-element-id="wrap-a"]')
    await expect(a).toBeVisible()
    // Plain click selects A on pointer-down; shift-clicks toggle B and C in.
    await a.click()
    await page.locator('[data-element-id="wrap-b"]').click({ modifiers: ['Shift'] })
    await page.locator('[data-element-id="wrap-c"]').click({ modifiers: ['Shift'] })
    await page.keyboard.press('Shift+A')

    // Persisted result: ONE fresh frame carrying the default auto layout
    // (row inferred from the horizontal spread, gap 20) owning all three.
    await expect
      .poll(
        async () => {
          const els = await readElements(request)
          const parents = ['wrap-a', 'wrap-b', 'wrap-c'].map(
            (id) => els.find((e) => e.id === id)?.parentId,
          )
          if (parents.some((p) => !p) || new Set(parents).size !== 1) return null
          const frame = els.find((e) => e.id === parents[0])
          if (!frame || frame.type !== 'frame' || !frame.layout) return null
          return { mode: frame.layout.mode, gap: frame.layout.gap }
        },
        { timeout: 10_000 },
      )
      .toEqual({ mode: 'row', gap: 20 })
  })

  test('3×3 grid centre cell writes justify/align center and moves the children; gap Auto = space-between', async ({
    page,
    request,
  }) => {
    // Select the layout frame via its Layers row (a design frame's body is
    // click-through by design — the row is the deterministic select target).
    const row = page.locator('[data-layer-row="just-frame"]')
    await expect(row).toBeVisible()
    await row.click()
    // Auto-layout section is up (the frame already carries a layout).
    await expect(page.getByLabel('Gap mode')).toBeVisible()

    // Centre cell of the 3×3 align grid → justify center × align center.
    // Scope to the Alignment group: the cell's "Center" a11y name would
    // otherwise collide with the stroke-align "Center" button that the same
    // frame inspector also renders (strict-mode violation).
    await page
      .getByRole('group', { name: 'Alignment' })
      .getByRole('button', { name: 'Center', exact: true })
      .click()
    // Engine math for the seeded frame (x40 w400 pad10 gap10, kids 60×60):
    // innerMain 380, content+gap 130 → A.x = 50+125 = 175, B.x = 245;
    // innerCross 100 → both y = 210+20 = 230.
    await expect
      .poll(
        async () => {
          const els = await readElements(request)
          const frame = els.find((e) => e.id === 'just-frame')
          const a = els.find((e) => e.id === 'just-a')
          const b = els.find((e) => e.id === 'just-b')
          return {
            justify: frame?.layout?.justify,
            align: frame?.layout?.align,
            a: { x: a?.x, y: a?.y },
            bx: b?.x,
          }
        },
        { timeout: 10_000 },
      )
      .toEqual({ justify: 'center', align: 'center', a: { x: 175, y: 230 }, bx: 245 })

    // Gap unit select → Auto = space-between (leftover 260 between the two:
    // A back to main-start 50, B flush at 370; align center sticks).
    await page.getByLabel('Gap mode').selectOption('auto')
    await expect
      .poll(
        async () => {
          const els = await readElements(request)
          const frame = els.find((e) => e.id === 'just-frame')
          const a = els.find((e) => e.id === 'just-a')
          const b = els.find((e) => e.id === 'just-b')
          return { justify: frame?.layout?.justify, ax: a?.x, bx: b?.x }
        },
        { timeout: 10_000 },
      )
      .toEqual({ justify: 'space-between', ax: 50, bx: 370 })
  })

  test('hovering outside a corner shows the rotate cursor (url(…)); dragging rotates and persists', async ({
    page,
    request,
  }) => {
    const grid = page.locator('.canvas-grid').last()
    const stick = page.locator('[data-element-id="rot-stick"]')
    await expect(stick).toBeVisible()
    await stick.click() // select → corner handles + rotate annulus go live

    const handle = page.locator('[data-handle="br"]')
    await expect(handle).toBeVisible()
    // The rotate zone is the annulus OUTSIDE the (rotated) corner: from the
    // corner-handle point, step 16px further along the centre→corner ray —
    // past the 7px handle radius, inside the 26px outer bound, off the box.
    const c = center(await box(stick)) // AABB centre == rotation centre
    const corner = center(await box(handle))
    const len = Math.hypot(corner.x - c.x, corner.y - c.y)
    const hover = {
      x: corner.x + ((corner.x - c.x) / len) * 16,
      y: corner.y + ((corner.y - c.y) / len) * 16,
    }

    // The canvas drives the cursor via the wrapper's INLINE style — a curved-
    // arrow SVG data-URI cursor, so it must start with url(. Wiggle ±1px so
    // every poll tick dispatches a fresh pointermove.
    let flip = false
    await expect
      .poll(
        async () => {
          flip = !flip
          await page.mouse.move(hover.x + (flip ? 1 : 0), hover.y)
          return grid.evaluate((el) => el.style.cursor)
        },
        { timeout: 10_000 },
      )
      .toMatch(/^url\(/)

    // Drag a 40° arc about the centre: rotation 20° → ~60°.
    await page.mouse.move(hover.x, hover.y)
    await page.mouse.down()
    const r = Math.hypot(hover.x - c.x, hover.y - c.y)
    const a0 = Math.atan2(hover.y - c.y, hover.x - c.x)
    for (let i = 1; i <= 4; i++) {
      const a = a0 + (i / 4) * ((40 * Math.PI) / 180)
      await page.mouse.move(c.x + r * Math.cos(a), c.y + r * Math.sin(a))
    }
    await page.mouse.up()

    await expect
      .poll(
        async () => {
          const rot = (await readElements(request)).find((e) => e.id === 'rot-stick')?.rotation
          return typeof rot === 'number' && Number.isInteger(rot) && rot > 40 && rot < 80
            ? 'rotated to ~60°'
            : `rotation=${rot}`
        },
        { timeout: 10_000 },
      )
      .toBe('rotated to ~60°')
  })

  test('dragging the br handle resizes to integer px and keeps a layout child parented', async ({
    page,
    request,
  }) => {
    const child = page.locator('[data-element-id="rsz-child"]')
    await expect(child).toBeVisible()
    await child.click() // select the layout child itself

    const handle = page.locator('[data-handle="br"]')
    await expect(handle).toBeVisible()
    const hc = center(await box(handle))
    await page.mouse.move(hc.x, hc.y)
    await page.mouse.down()
    await page.mouse.move(hc.x + 35, hc.y + 25, { steps: 6 })
    await page.mouse.up()

    // Commit rounds to whole px (100×100 + the exact 35/25 pointer delta) and
    // a layout child never leaves its frame by being resized.
    await expect
      .poll(
        async () => {
          const el = (await readElements(request)).find((e) => e.id === 'rsz-child')
          return el ? { w: el.width, h: el.height, parent: el.parentId } : null
        },
        { timeout: 10_000 },
      )
      .toEqual({ w: 135, h: 125, parent: 'rsz-frame' })
  })

  test('dragging a layer row onto a frame row (middle band) drops it INTO the frame', async ({
    page,
    request,
  }) => {
    const src = page.locator('[data-layer-row="drop-stick"]')
    const dst = page.locator('[data-layer-row="drop-frame"]')
    await expect(src).toBeVisible()
    await expect(dst).toBeVisible()

    const from = center(await box(src))
    const to = center(await box(dst))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // Cross the 4px drag threshold, then settle on the frame row's CENTRE —
    // the 25–75% middle band reads as drop-INTO (edges insert above/below).
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()

    await expect
      .poll(
        async () =>
          (await readElements(request)).find((e) => e.id === 'drop-stick')?.parentId ?? null,
        { timeout: 10_000 },
      )
      .toBe('drop-frame')
  })

  test('⌘\\ hides both sidebars and brings them back, persisting the choice', async ({ page }) => {
    const pages = page.locator('aside').filter({ hasText: 'Pages' })
    const design = page.locator('aside').filter({ hasText: /\d+ elements/ })
    await expect(pages).toBeVisible()
    await expect(design).toBeVisible()

    await page.keyboard.press('ControlOrMeta+\\')
    await expect(pages).toHaveCount(0)
    await expect(design).toHaveCount(0)
    expect(
      await page.evaluate(() => localStorage.getItem('openground.canvas.sidebars')),
    ).toBe('0')

    await page.keyboard.press('ControlOrMeta+\\')
    await expect(pages).toBeVisible()
    await expect(design).toBeVisible()
    expect(
      await page.evaluate(() => localStorage.getItem('openground.canvas.sidebars')),
    ).toBe('1')
  })
})
