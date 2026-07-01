// Seeds a fully-isolated OPEN GROUND server (booted by perf.config's webServer
// with HOME + OPENGROUND_HOME → throwaway tmp dirs) with a HEAVY dataset so the
// harness measures performance at the scale the goal calls for:
//   - 50+ registered projects on the Ground portfolio canvas
//   - one project with 200+ Board cards
//   - one Canvas with 300 elements
//
// Everything is created through the REAL HTTP API, so the server writes the
// files in exactly the shape it later reads — no hand-rolled on-disk schema to
// drift. The project folders are real dirs under os.tmpdir() (the server shares
// the test process's filesystem), matching e2e/fixtures/helpers.ts.
import { mkdtemp, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { APIRequestContext } from '@playwright/test'
import type { CanvasElement, CanvasFile } from '../src/lib/types'

export interface SeededProject {
  id: string
  path: string
}

export interface SeedResult {
  projects: SeededProject[]
  heavy: SeededProject
  canvasId: string
  taskCount: number
  elementCount: number
}

const expectOk = async (res: { ok: () => boolean; status: () => number; text: () => Promise<string> }, what: string) => {
  if (!res.ok()) throw new Error(`${what} failed: ${res.status()} ${await res.text()}`)
}

const importProject = async (
  request: APIRequestContext,
  label: string,
): Promise<SeededProject> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `og-perf-${label}-`)))
  await writeFile(join(dir, 'README.md'), `# ${label}\n`)
  const res = await request.post('/api/projects/import', { data: { path: dir } })
  await expectOk(res, `import ${label}`)
  const body = await res.json()
  return { id: body.id as string, path: body.path as string }
}

// 300 elements laid out in a world-space grid: a realistic mix of every leaf
// type the canvas renders (sticky / text / shape / frame), so per-type render
// passes (notes filter, frames filter+sort, etc.) are all exercised.
const makeElements = (count: number): CanvasElement[] => {
  // Spread over a LARGE world area (≈8400×4800 for 300) — a realistic "big
  // canvas" where most elements are off-screen at any time, so viewport culling
  // is meaningful (a tightly-packed grid would fit mostly on one screen and hide
  // the win). Each screen shows ~a few dozen of the 300.
  const cols = 20
  const cellW = 420
  const cellH = 320
  const out: CanvasElement[] = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = col * cellW
    const y = row * cellH
    const kind = i % 10
    const base = { id: `el-${i}`, x, y, width: 120, height: 90 }
    if (kind < 4) {
      out.push({ ...base, type: 'sticky', text: `Note ${i}`, color: '#FFE08A' })
    } else if (kind < 7) {
      out.push({ ...base, type: 'text', text: `Text block ${i} — lorem ipsum dolor`, width: 160, height: 44 })
    } else if (kind < 9) {
      out.push({ ...base, type: 'shape', text: '', width: 100, height: 100 })
    } else {
      out.push({ ...base, type: 'frame', text: `Frame ${i}`, width: 180, height: 130 })
    }
  }
  return out
}

export const seedHeavyHome = async (
  request: APIRequestContext,
  opts: { projectCount?: number; taskCount?: number; elementCount?: number } = {},
): Promise<SeedResult> => {
  const projectCount = opts.projectCount ?? 50
  const taskCount = opts.taskCount ?? 200
  const elementCount = opts.elementCount ?? 300

  // 1) The heavy project (Board + Canvas live here) + N light projects (Ground).
  const heavy = await importProject(request, 'heavy')
  const light: SeededProject[] = []
  for (let i = 0; i < projectCount; i++) {
    light.push(await importProject(request, `p${i}`))
  }
  const projects = [heavy, ...light]

  // 2) 200 Board cards in the heavy project (all land in 'todo' — the meanest
  //    single-column render case).
  const titles = Array.from({ length: taskCount }, (_, i) => `Task ${String(i + 1).padStart(3, '0')}`)
  const tRes = await request.post('/api/project/tasks', { data: { path: heavy.path, add: titles } })
  await expectOk(tRes, 'seed tasks')

  // 3) A 300-element Canvas in the heavy project. Create → fill → save (echoing
  //    the server's rev for the OCC check) → mark active so the Canvas tab opens
  //    straight onto it.
  const cRes = await request.post('/api/project/canvases?action=create', {
    data: { path: heavy.path, name: 'Perf Canvas' },
  })
  await expectOk(cRes, 'create canvas')
  // createCanvas returns { index, canvas } — the CanvasFile is nested under .canvas.
  const created = ((await cRes.json()) as { canvas: CanvasFile }).canvas
  const filled: CanvasFile = {
    ...created,
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: makeElements(elementCount),
  }
  const sRes = await request.post('/api/project/canvases', { data: { path: heavy.path, canvas: filled } })
  await expectOk(sRes, 'save canvas')
  await request.post('/api/project/canvases?action=active', { data: { path: heavy.path, id: created.id } })

  // 4) Ground card positions: spread all 51 cards in a grid so they're real,
  //    distinct, on-canvas cards (not stacked at the origin).
  const positions: Record<string, { x: number; y: number }> = {}
  const gcols = 10
  projects.forEach((p, i) => {
    positions[p.id] = { x: (i % gcols) * 340, y: Math.floor(i / gcols) * 240 }
  })
  const pRes = await request.post('/api/canvas', {
    data: { positions, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] },
  })
  await expectOk(pRes, 'seed ground positions')

  return { projects, heavy, canvasId: created.id, taskCount, elementCount }
}
