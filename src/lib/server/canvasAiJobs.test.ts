// canvasAiJobs.test.ts — the SERVER-SIDE JOB layer of the Canvas AI engine
// (the registry + persistence added so a run survives the client navigating
// away). The claude PTY itself is NOT exercised — the job's engine functions
// (generate / tweak) are injected as fakes via the deps param, so these tests
// are hermetic (no network, no real CLI) and fast. The pure parts (validation,
// prompts, marker) live in canvasAi.test.ts. HOME is the throwaway test home
// (setup-home.ts), so persistence lands there, never the real ~/.openground.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  startGenerateJob,
  startTweakJob,
  getCanvasAiJobState,
  listActiveCanvasAiJobs,
  cancelCanvasAiJob,
  _resetCanvasAiJobsForTest,
} from './canvasAi'
import {
  createCanvas,
  readCanvasFile,
  writeCanvasFile,
  appendCanvasElements,
  updateCanvasElementSource,
  placeAppendedElements,
} from './canvasData'
import { registerTestProject } from '../../test/registerProject'
import type { CanvasAiJobStatus, CanvasElement } from '@/lib/types'

const textEl = (id: string, x = 0, y = 0): CanvasElement => ({
  id,
  type: 'text',
  x,
  y,
  text: id,
})

const waitFor = async (pred: () => boolean, label: string, ms = 3000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for: ${label}`)
}
const waitForStatus = async (id: string, status: CanvasAiJobStatus) => {
  await waitFor(() => getCanvasAiJobState(id)?.status === status, `${id} → ${status}`)
  return getCanvasAiJobState(id)!
}

// A promise we resolve by hand, to hold a job in 'running' as long as we like.
const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('canvas AI jobs', () => {
  let projectPath: string
  let canvasId: string
  beforeEach(async () => {
    _resetCanvasAiJobsForTest()
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-ai-'))
    await registerTestProject(projectPath)
    const { canvas } = await createCanvas(projectPath, 'C1')
    canvasId = canvas.id
  })
  afterEach(async () => {
    _resetCanvasAiJobsForTest()
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  // (a) + (b): the run completes on its OWN lifecycle — there is no HTTP request
  // in sight, so a "disconnect" can't touch it — and the result is persisted to
  // the canvas. startGenerateJob returns immediately with the job already
  // 'running' (the POST has returned; a client could drop the connection now),
  // and the run still finishes and lands on disk.
  it('runs to completion with no request involved and persists the elements', async () => {
    const id = startGenerateJob(
      { projectPath, canvasId, prompt: 'two labels' },
      { generate: async () => [textEl('e1'), textEl('e2', 40)] },
    )
    expect(getCanvasAiJobState(id)?.status).toBe('running')
    const done = await waitForStatus(id, 'done')
    expect(done.elements?.map((e) => e.id)).toEqual(['e1', 'e2'])
    // Persisted server-side via the REAL appendCanvasElements.
    const canvas = await readCanvasFile(projectPath, canvasId)
    expect(canvas?.elements.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  // (d): explicit cancel is the ONLY thing that aborts the run. The abort signal
  // reaches the engine (in the real path that's what kills the PTY), the job
  // ends as 'error: cancelled', and nothing is persisted.
  it('explicit cancel aborts the run (and only cancel does); nothing persists', async () => {
    let abortedSignal = false
    const id = startGenerateJob(
      { projectPath, canvasId, prompt: 'hangs' },
      {
        generate: (_p, opts) =>
          new Promise<CanvasElement[]>((_res, rej) => {
            opts?.signal?.addEventListener(
              'abort',
              () => {
                abortedSignal = true
                rej(new Error('canvas AI task aborted'))
              },
              { once: true },
            )
          }),
        persist: async () => {
          throw new Error('a cancelled job must not persist')
        },
      },
    )
    expect(getCanvasAiJobState(id)?.status).toBe('running')
    expect(cancelCanvasAiJob(id)).toBe(true)
    const ended = await waitForStatus(id, 'error')
    expect(abortedSignal).toBe(true)
    expect(ended.error).toBe('cancelled')
    const canvas = await readCanvasFile(projectPath, canvasId)
    expect(canvas?.elements ?? []).toEqual([])
  })

  // (d, edge): a cancel that lands AFTER claude finished but BEFORE the result
  // is persisted must still win — the job ends 'error', nothing is written.
  it('a cancel landing after generate but before persist still wins (no persist)', async () => {
    const gate = deferred<CanvasElement[]>()
    let persisted = false
    const id = startGenerateJob(
      { projectPath, canvasId, prompt: 'race' },
      {
        generate: () => gate.promise,
        persist: async () => {
          persisted = true
          return []
        },
      },
    )
    // Cancel while generate is still pending …
    expect(cancelCanvasAiJob(id)).toBe(true)
    // … then let generate resolve: the post-generate signal re-check must skip
    // persist and end the job as cancelled.
    gate.resolve([textEl('e1')])
    const ended = await waitForStatus(id, 'error')
    expect(ended.error).toBe('cancelled')
    expect(persisted).toBe(false)
    expect((await readCanvasFile(projectPath, canvasId))?.elements ?? []).toEqual([])
  })

  // (c): a running job appears in the active list with its metadata, and leaves
  // once finished — this is what feeds the global beacon.
  it('lists a running job in the active list and drops it when done', async () => {
    const gate = deferred<CanvasElement[]>()
    const id = startGenerateJob(
      { projectPath, canvasId, prompt: 'slow' },
      { generate: () => gate.promise },
    )
    const mine = listActiveCanvasAiJobs().find((j) => j.id === id)
    expect(mine).toBeTruthy()
    expect(mine?.kind).toBe('generate')
    expect(mine?.projectPath).toBe(projectPath)
    expect(mine?.canvasId).toBe(canvasId)
    expect(mine?.elapsedMs).toBeGreaterThanOrEqual(0)
    gate.resolve([textEl('e1')])
    await waitForStatus(id, 'done')
    expect(listActiveCanvasAiJobs().some((j) => j.id === id)).toBe(false)
  })

  it('a tweak job writes the rewritten source onto the target element', async () => {
    const base = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, {
      ...base!,
      elements: [{ id: 's1', type: 'screen', x: 0, y: 0, width: 400, height: 300, text: 'OLD' }],
    })
    const id = startTweakJob(
      {
        projectPath,
        canvasId,
        elementId: 's1',
        req: {
          path: projectPath,
          source: 'OLD',
          framework: 'react',
          instruction: 'make it new',
          element: { tag: 'div', classes: '', text: '', html: '' },
        },
      },
      { tweak: async () => ({ source: 'NEW SOURCE' }) },
    )
    const done = await waitForStatus(id, 'done')
    expect(done.source).toBe('NEW SOURCE')
    expect(done.elementId).toBe('s1')
    const canvas = await readCanvasFile(projectPath, canvasId)
    expect(canvas?.elements.find((e) => e.id === 's1')?.text).toBe('NEW SOURCE')
  })

  it('a tweak the model judged "unchanged" does not rewrite the element', async () => {
    const base = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, {
      ...base!,
      elements: [{ id: 's1', type: 'screen', x: 0, y: 0, text: 'OLD' }],
    })
    let persisted = false
    const id = startTweakJob(
      {
        projectPath,
        canvasId,
        elementId: 's1',
        req: {
          path: projectPath,
          source: 'OLD',
          framework: 'react',
          instruction: 'already done',
          element: { tag: 'div', classes: '', text: '', html: '' },
        },
      },
      {
        tweak: async () => ({ source: 'OLD', unchanged: true }),
        persist: async () => {
          persisted = true
          return true
        },
      },
    )
    const done = await waitForStatus(id, 'done')
    expect(done.unchanged).toBe(true)
    expect(persisted).toBe(false)
    expect((await readCanvasFile(projectPath, canvasId))?.elements[0].text).toBe('OLD')
  })

  it('getCanvasAiJobState reports elapsedMs and a startedAt ISO timestamp', async () => {
    const gate = deferred<CanvasElement[]>()
    const id = startGenerateJob(
      { projectPath, canvasId, prompt: 'slow' },
      { generate: () => gate.promise },
    )
    const state = getCanvasAiJobState(id)
    expect(state?.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(typeof state?.startedAt).toBe('string')
    expect(Number.isNaN(Date.parse(state!.startedAt))).toBe(false)
    gate.resolve([textEl('e1')])
    await waitForStatus(id, 'done')
  })
})

describe('placeAppendedElements (non-overlapping append position)', () => {
  it('offsets a batch to the right of existing content', () => {
    const existing: CanvasElement[] = [
      { id: 'a', type: 'frame', x: 0, y: 0, width: 200, height: 100, text: '' },
    ]
    const incoming: CanvasElement[] = [
      { id: 'b', type: 'frame', x: 0, y: 0, width: 50, height: 50, text: '' },
    ]
    placeAppendedElements(existing, incoming)
    // existing maxX = 200, gap = 80 → incoming minX lands at 280, top-aligned.
    expect(incoming[0].x).toBe(280)
    expect(incoming[0].y).toBe(0)
  })
  it('normalises a batch to the origin on an empty canvas', () => {
    const incoming: CanvasElement[] = [
      { id: 'b', type: 'frame', x: 30, y: 40, width: 50, height: 50, text: '' },
    ]
    placeAppendedElements([], incoming)
    expect(incoming[0].x).toBe(0)
    expect(incoming[0].y).toBe(0)
  })
})

describe('canvas AI persistence helpers', () => {
  let projectPath: string
  let canvasId: string
  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-ai-p-'))
    await registerTestProject(projectPath)
    const { canvas } = await createCanvas(projectPath, 'C1')
    canvasId = canvas.id
  })
  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('appendCanvasElements adds to the canvas and returns the placed batch', async () => {
    const placed = await appendCanvasElements(projectPath, canvasId, [textEl('z1')])
    expect(placed).toHaveLength(1)
    expect((await readCanvasFile(projectPath, canvasId))?.elements.map((e) => e.id)).toContain('z1')
  })

  it('appendCanvasElements rejects when the canvas is gone', async () => {
    await expect(
      appendCanvasElements(projectPath, 'no-such-canvas', [textEl('z1')]),
    ).rejects.toThrow()
  })

  it('updateCanvasElementSource updates by id and returns false when missing', async () => {
    const base = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, {
      ...base!,
      elements: [{ id: 's1', type: 'screen', x: 0, y: 0, text: 'OLD' }],
    })
    expect(await updateCanvasElementSource(projectPath, canvasId, 's1', 'NEW')).toBe(true)
    expect((await readCanvasFile(projectPath, canvasId))?.elements[0].text).toBe('NEW')
    expect(await updateCanvasElementSource(projectPath, canvasId, 'nope', 'X')).toBe(false)
  })
})
