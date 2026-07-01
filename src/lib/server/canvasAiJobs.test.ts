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
  TWEAK_CONFLICT_MESSAGE,
  TWEAK_TARGET_REMOVED_MESSAGE,
} from './canvasAi'
import {
  createCanvas,
  readCanvasFile,
  writeCanvasFile,
  appendCanvasElements,
  updateCanvasElementSource,
  hashElementSource,
  placeAppendedElements,
  deleteCanvas,
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
  // the canvas. startGenerateJob returns immediately with the job 'queued' (its
  // turn on the project chain is one microtask away; the POST has returned and a
  // client could drop the connection now), and the run still finishes on disk.
  it('runs to completion with no request involved and persists the elements', async () => {
    const id = startGenerateJob(
      { projectPath, canvasId, prompt: 'two labels' },
      { generate: async () => [textEl('e1'), textEl('e2', 40)] },
    )
    // Synchronously after start it's queued (off the beacon); it flips to running
    // when it wins its turn on the chain, then completes.
    expect(getCanvasAiJobState(id)?.status).toBe('queued')
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
    // Let it win its turn and actually start (the abort must reach a LIVE run).
    await waitForStatus(id, 'running')
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
    // Let it win its turn and start — we're testing the POST-generate signal
    // re-check, which only runs once the job is actually running …
    await waitForStatus(id, 'running')
    // … cancel while generate is still pending …
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
    // It must reach 'running' to appear on the beacon (a queued job is excluded).
    await waitForStatus(id, 'running')
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

  // ── per-project serialization (the head-of-line-block fix) ──────────────────

  // OBSERVABLE CONDITION 1: a hung run in project A must NOT block a run in
  // project B — they run in parallel (the multiplexer premise). Before the fix a
  // single GLOBAL chain made every run wait behind every other, across projects.
  it('runs in DIFFERENT projects do not block each other (parallel)', async () => {
    const projectPath2 = await mkdtemp(join(tmpdir(), 'og-canvas-ai-2-'))
    await registerTestProject(projectPath2)
    const { canvas: canvas2 } = await createCanvas(projectPath2, 'C2')
    try {
      // Project A: a generate job that HANGS forever (would block ITS OWN chain).
      const gateA = deferred<CanvasElement[]>()
      const idA = startGenerateJob(
        { projectPath, canvasId, prompt: 'A hangs' },
        { generate: () => gateA.promise },
      )
      // Project B: a normal job started right after A.
      const idB = startGenerateJob(
        { projectPath: projectPath2, canvasId: canvas2.id, prompt: 'B' },
        { generate: async () => [textEl('b1')] },
      )
      // B completes while A is still hung → no cross-project head-of-line block.
      const doneB = await waitForStatus(idB, 'done')
      expect(doneB.elements?.map((e) => e.id)).toEqual(['b1'])
      // A is genuinely running (hung) — not blocked by anything.
      expect(getCanvasAiJobState(idA)?.status).toBe('running')
      // Release A so it settles cleanly before teardown.
      gateA.resolve([textEl('a1')])
      await waitForStatus(idA, 'done')
    } finally {
      await rm(projectPath2, { recursive: true, force: true }).catch(() => {})
    }
  })

  // OBSERVABLE CONDITION 2: within ONE project a second run waits its turn — it is
  // reported as 'queued' (NOT 'running') and EXCLUDED from the active list, so the
  // global "Claude is designing" beacon doesn't falsely light for a waiting job.
  it('a second run in the SAME project is queued (not running) and off the beacon until its turn', async () => {
    const gate1 = deferred<CanvasElement[]>()
    const id1 = startGenerateJob(
      { projectPath, canvasId, prompt: 'first' },
      { generate: () => gate1.promise },
    )
    const id2 = startGenerateJob(
      { projectPath, canvasId, prompt: 'second' },
      { generate: async () => [textEl('e2')] },
    )
    // The first takes the chain and runs; the second waits its turn → queued.
    await waitForStatus(id1, 'running')
    expect(getCanvasAiJobState(id2)?.status).toBe('queued')
    // The beacon (active list) shows the running job, NOT the queued one.
    expect(listActiveCanvasAiJobs().some((j) => j.id === id1)).toBe(true)
    expect(listActiveCanvasAiJobs().some((j) => j.id === id2)).toBe(false)
    // Finish the first → the second now takes its turn and completes.
    gate1.resolve([textEl('e1')])
    const done2 = await waitForStatus(id2, 'done')
    expect(done2.elements?.map((e) => e.id)).toEqual(['e2'])
  })

  // OBSERVABLE CONDITION 3: cancelling a QUEUED job takes effect IMMEDIATELY —
  // without waiting for the head-of-line run — and that job's claude session is
  // never spawned (its generate is never invoked, nothing persists for it).
  it('cancelling a QUEUED job ends it immediately and never starts its run', async () => {
    const gate1 = deferred<CanvasElement[]>()
    let secondRan = false
    const id1 = startGenerateJob(
      { projectPath, canvasId, prompt: 'head-of-line' },
      { generate: () => gate1.promise },
    )
    const id2 = startGenerateJob(
      { projectPath, canvasId, prompt: 'queued' },
      {
        generate: async () => {
          secondRan = true
          return [textEl('e2')]
        },
      },
    )
    await waitForStatus(id1, 'running')
    expect(getCanvasAiJobState(id2)?.status).toBe('queued')
    // Cancel the QUEUED job while the head-of-line run is still going.
    expect(cancelCanvasAiJob(id2)).toBe(true)
    // It is cancelled RIGHT NOW — not after id1 releases the chain.
    const ended = getCanvasAiJobState(id2)
    expect(ended?.status).toBe('error')
    expect(ended?.error).toBe('cancelled')
    expect(listActiveCanvasAiJobs().some((j) => j.id === id2)).toBe(false)
    // Let the head-of-line run finish; the chain then reaches the cancelled job
    // and must SKIP it — its generate is never invoked.
    gate1.resolve([textEl('e1')])
    await waitForStatus(id1, 'done')
    await new Promise((r) => setTimeout(r, 20)) // let the chain advance past id2
    expect(secondRan).toBe(false)
    expect(getCanvasAiJobState(id2)?.status).toBe('error')
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

  // DATA-LOSS GUARD: a manual edit to the SAME element made WHILE the tweak runs
  // must survive. The tweak rewrote a snapshot of the start-time source; the user
  // then edited the element; on completion the now-stale rewrite must NOT clobber
  // that edit. We simulate the concurrent edit as a side effect of the injected
  // engine (it lands before persist), and let persist run through the REAL
  // updateCanvasElementSource (with its base-hash guard).
  it('a manual edit DURING a tweak is preserved (the stale rewrite is refused as a conflict)', async () => {
    const base = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, {
      ...base!,
      elements: [
        { id: 's1', type: 'screen', x: 0, y: 0, width: 400, height: 300, text: 'ORIGINAL' },
      ],
    })
    const id = startTweakJob(
      {
        projectPath,
        canvasId,
        elementId: 's1',
        req: {
          path: projectPath,
          source: 'ORIGINAL', // the snapshot the rewrite below is based on
          framework: 'react',
          instruction: 'restyle the header',
          element: { tag: 'div', classes: '', text: '', html: '' },
        },
      },
      {
        tweak: async () => {
          // The user manually edits the element mid-run (unconditional write —
          // no base hash, the path a real client save / inspector edit takes).
          await updateCanvasElementSource(projectPath, canvasId, 's1', 'MANUAL EDIT')
          return { source: 'STALE REWRITE' }
        },
        // persist defaults to the REAL guarded updateCanvasElementSource.
      },
    )
    const ended = await waitForStatus(id, 'error')
    // The job fails as a conflict rather than silently overwriting.
    expect(ended.error).toBe(TWEAK_CONFLICT_MESSAGE)
    // And the on-disk element keeps the user's edit — NOT the stale rewrite.
    const canvas = await readCanvasFile(projectPath, canvasId)
    expect(canvas?.elements.find((e) => e.id === 's1')?.text).toBe('MANUAL EDIT')
  })

  // The complement of the guard: with NO concurrent edit, the element still hashes
  // to the start-time snapshot, so a normal tweak applies exactly as before.
  it('a normal tweak (element untouched during the run) still applies', async () => {
    const base = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, {
      ...base!,
      elements: [
        { id: 's1', type: 'screen', x: 0, y: 0, width: 400, height: 300, text: 'ORIGINAL' },
      ],
    })
    const id = startTweakJob(
      {
        projectPath,
        canvasId,
        elementId: 's1',
        req: {
          path: projectPath,
          source: 'ORIGINAL',
          framework: 'react',
          instruction: 'restyle the header',
          element: { tag: 'div', classes: '', text: '', html: '' },
        },
      },
      { tweak: async () => ({ source: 'REWRITTEN' }) },
    )
    const done = await waitForStatus(id, 'done')
    expect(done.source).toBe('REWRITTEN')
    const canvas = await readCanvasFile(projectPath, canvasId)
    expect(canvas?.elements.find((e) => e.id === 's1')?.text).toBe('REWRITTEN')
  })

  // DATA-INTEGRITY GUARD (the complement of "applied"): if the target ELEMENT is
  // DELETED while the tweak runs, the rewrite reaches disk NOWHERE
  // (updateCanvasElementSource finds no element → returns false). The job must
  // FAIL — not report done+source, which the client would apply as a (false)
  // success. We delete the element as a side effect of the injected engine (it
  // lands before persist) and let persist run through the REAL
  // updateCanvasElementSource. Mirrors the generate side, where appendCanvasElements
  // throws when its canvas is gone.
  it('a tweak whose target ELEMENT is deleted mid-run fails (no false success)', async () => {
    const base = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, {
      ...base!,
      elements: [
        { id: 's1', type: 'screen', x: 0, y: 0, width: 400, height: 300, text: 'ORIGINAL' },
      ],
    })
    const id = startTweakJob(
      {
        projectPath,
        canvasId,
        elementId: 's1',
        req: {
          path: projectPath,
          source: 'ORIGINAL',
          framework: 'react',
          instruction: 'restyle the header',
          element: { tag: 'div', classes: '', text: '', html: '' },
        },
      },
      {
        tweak: async () => {
          // The user deletes the target element mid-run.
          const c = await readCanvasFile(projectPath, canvasId)
          await writeCanvasFile(projectPath, {
            ...c!,
            elements: c!.elements.filter((e) => e.id !== 's1'),
          })
          return { source: 'REWRITE' }
        },
        // persist defaults to the REAL updateCanvasElementSource.
      },
    )
    const ended = await waitForStatus(id, 'error')
    expect(ended.error).toBe(TWEAK_TARGET_REMOVED_MESSAGE)
    // No source is surfaced on a failed job → the client has nothing to apply.
    expect(ended.source).toBeUndefined()
    // The deleted element stays deleted — the failed tweak does not resurrect it.
    const canvas = await readCanvasFile(projectPath, canvasId)
    expect(canvas?.elements.find((e) => e.id === 's1')).toBeUndefined()
  })

  // Same guard, one level up: the whole CANVAS holding the element is deleted
  // mid-run. updateCanvasElementSource reads a now-missing canvas (null) → false,
  // so the job must fail rather than claim a write that never happened.
  it('a tweak whose CANVAS is deleted mid-run fails (no false success)', async () => {
    const base = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, {
      ...base!,
      elements: [
        { id: 's1', type: 'screen', x: 0, y: 0, width: 400, height: 300, text: 'ORIGINAL' },
      ],
    })
    const id = startTweakJob(
      {
        projectPath,
        canvasId,
        elementId: 's1',
        req: {
          path: projectPath,
          source: 'ORIGINAL',
          framework: 'react',
          instruction: 'restyle the header',
          element: { tag: 'div', classes: '', text: '', html: '' },
        },
      },
      {
        tweak: async () => {
          // The user deletes the whole canvas holding the element mid-run.
          await deleteCanvas(projectPath, canvasId)
          return { source: 'REWRITE' }
        },
      },
    )
    const ended = await waitForStatus(id, 'error')
    expect(ended.error).toBe(TWEAK_TARGET_REMOVED_MESSAGE)
    expect(ended.source).toBeUndefined()
    // The canvas is gone — deleting the last one recreates a fresh one under a NEW
    // id, so the original canvasId stays unreadable (nothing was written back).
    expect(await readCanvasFile(projectPath, canvasId)).toBeNull()
  })

  // Focused unit test of the consume-the-false logic in startTweakJob, isolated
  // from canvasData internals: whatever makes persist report `false` (target
  // removed), the job must end 'error' with TWEAK_TARGET_REMOVED_MESSAGE and carry
  // no source — never a done that the client would treat as applied.
  it('a tweak fails when persist reports the target was removed (false)', async () => {
    const base = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, {
      ...base!,
      elements: [{ id: 's1', type: 'screen', x: 0, y: 0, text: 'OLD' }],
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
      { tweak: async () => ({ source: 'NEW' }), persist: async () => false },
    )
    const ended = await waitForStatus(id, 'error')
    expect(ended.status).toBe('error')
    expect(ended.error).toBe(TWEAK_TARGET_REMOVED_MESSAGE)
    expect(ended.source).toBeUndefined()
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

  it('updateCanvasElementSource: base-hash guard writes on a match and refuses (conflict) on a mismatch', async () => {
    const base = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, {
      ...base!,
      elements: [{ id: 's1', type: 'screen', x: 0, y: 0, text: 'ORIGINAL' }],
    })
    const baseHash = hashElementSource('ORIGINAL')
    // Guard passes — the element still hashes to the snapshot → the write lands.
    expect(await updateCanvasElementSource(projectPath, canvasId, 's1', 'REWRITE', baseHash)).toBe(
      true,
    )
    expect((await readCanvasFile(projectPath, canvasId))?.elements[0].text).toBe('REWRITE')
    // The element is now 'REWRITE'; a second write guarded by the STALE snapshot
    // hash ('ORIGINAL') must be refused, and must NOT overwrite.
    expect(await updateCanvasElementSource(projectPath, canvasId, 's1', 'STALE', baseHash)).toBe(
      'conflict',
    )
    expect((await readCanvasFile(projectPath, canvasId))?.elements[0].text).toBe('REWRITE')
    // A guard on a MISSING element is reported as missing (false), not a conflict.
    expect(
      await updateCanvasElementSource(projectPath, canvasId, 'nope', 'X', hashElementSource('X')),
    ).toBe(false)
  })
})
