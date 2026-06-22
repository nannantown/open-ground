// canvasSaveOcc.test.ts — route-level contract for the optimistic-concurrency
// canvas SAVE path (POST /api/project/canvases, default action). Exercised via
// app.request(...) (no TCP bind). Proves the HTTP boundary returns 200 + the
// bumped canvas on a fresh-rev save, and 409 + the current canvas on a stale
// save (so a client can refetch, merge, and retry). HOME is the throwaway test
// home (setup-home.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { app } from '../../app'
import { registerTestProject } from '../../../src/test/registerProject'
import { createCanvas, appendCanvasElements } from '@/lib/server/canvasData'
import type { CanvasElement, CanvasFile } from '@/lib/types'

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const txt = (id: string): CanvasElement => ({ id, type: 'text', x: 0, y: 0, text: id })

describe('POST /api/project/canvases — optimistic concurrency', () => {
  let projectPath: string
  let canvas: CanvasFile
  beforeEach(async () => {
    projectPath = await realpath(await mkdtemp(join(tmpdir(), 'og-canvas-save-occ-')))
    await registerTestProject(projectPath)
    canvas = (await createCanvas(projectPath, 'C1')).canvas // rev 1
  })
  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('saves with the current rev → 200 and the bumped canvas', async () => {
    const res = await app.request(
      '/api/project/canvases',
      postJson({ path: projectPath, canvas: { ...canvas, elements: [txt('x')] } }),
    )
    expect(res.status).toBe(200)
    const saved = (await res.json()) as CanvasFile
    expect(saved.rev).toBe((canvas.rev as number) + 1)
    expect(saved.elements.map((e) => e.id)).toEqual(['x'])
  })

  it('rejects a stale save → 409 with { conflict, canvas } carrying the AI-appended element', async () => {
    // An AI job appends server-side, advancing the rev past the client's copy.
    await appendCanvasElements(projectPath, canvas.id, [txt('ai-added')])

    // The client POSTs from its stale snapshot (rev 1) without the AI element.
    const res = await app.request(
      '/api/project/canvases',
      postJson({
        path: projectPath,
        canvas: { ...canvas, elements: [txt('client-edit')], rev: canvas.rev },
      }),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { conflict?: boolean; canvas?: CanvasFile }
    expect(body.conflict).toBe(true)
    // The current canvas handed back must include the AI element so the client
    // can merge it in rather than lose it.
    expect(body.canvas?.elements.map((e) => e.id)).toContain('ai-added')
    expect(body.canvas?.elements.map((e) => e.id)).not.toContain('client-edit')
  })

  it('still rejects a save whose body omits rev (treated as rev 0) once the canvas has advanced', async () => {
    // A pre-rev client (no rev field) is treated as expectedRev 0; the created
    // canvas is already at rev 1, so the save conflicts rather than clobbering.
    const { rev: _omit, ...noRev } = canvas
    const res = await app.request(
      '/api/project/canvases',
      postJson({ path: projectPath, canvas: { ...noRev, elements: [txt('y')] } }),
    )
    expect(res.status).toBe(409)
  })
})
