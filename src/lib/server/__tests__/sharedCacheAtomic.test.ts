// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Atomicity of the folder-less shared-project read-cache (goal condition 3). The
// member's doc-sync mirror can POST the SAME board / canvas in quick succession,
// so two writes to the same board.json / <canvasId>.json overlap; a non-atomic
// writeFile would interleave their bytes (or a crash mid-write would truncate the
// target), and the next readSharedBoardCache JSON.parse would fail → null → the
// panel falls back to "connecting…". The fix routes both writes through
// atomicWriteText (temp file + rename), so a reader only ever observes a COMPLETE
// file. We prove that two ways:
//   (A) a burst of overlapping writes converges to ONE complete, parseable file
//       (no half-written interleave) and leaves no `.tmp-` litter;
//   (B) a DETERMINISTIC mid-write crash (partial bytes written, then a throw,
//       injected over writeFile) leaves the PREVIOUS cached file fully intact —
//       because the truncated bytes land in the temp sibling, never the live
//       cache file, which is only ever swapped in by an atomic rename.
// HOME is tmpdir-isolated per test — this never touches the real ~/.openground
// (feedback_tests_isolate_home).

// One-shot crash injector over writeFile. Disarmed by default → every write passes
// straight through to the real impl (so the concurrency test exercises genuine
// atomic writes). When armed, the next writeFile writes only the FIRST HALF of its
// payload to the real target path, then throws — exactly the "truncated file
// remains" failure the bug report describes. Both 'fs/promises' and
// 'node:fs/promises' are mocked so the injection bites whichever specifier the
// write flows through (atomicWriteText imports from 'fs/promises'); spreading
// `...actual` keeps every OTHER fs call (mkdir/readFile/rename/rm/readdir) real.
// NOTE: a vi.mock factory is hoisted to the top of the file, so it must not
// reference any top-level binding AT EVALUATION TIME — only the `crash` object is
// touched, and only inside the lazily-invoked vi.fn body (same shape as
// canvasLockRace.test.ts). The injector body is therefore inlined per factory.
const crash = { armed: false }

vi.mock('fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('fs/promises')>()
  const real = actual.writeFile as (...a: unknown[]) => Promise<void>
  return {
    ...actual,
    writeFile: vi.fn(async (path: unknown, data: unknown, ...rest: unknown[]) => {
      if (crash.armed) {
        crash.armed = false // one-shot
        const s = typeof data === 'string' ? data : String(data)
        const half = s.slice(0, Math.max(1, Math.floor(s.length / 2)))
        await real(path, half, ...rest) // truncated bytes hit the real target, then…
        throw Object.assign(new Error('simulated crash mid-write'), { code: 'EIO' })
      }
      return real(path, data, ...rest)
    }),
  }
})
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('fs/promises')>()
  const real = actual.writeFile as (...a: unknown[]) => Promise<void>
  return {
    ...actual,
    writeFile: vi.fn(async (path: unknown, data: unknown, ...rest: unknown[]) => {
      if (crash.armed) {
        crash.armed = false // one-shot
        const s = typeof data === 'string' ? data : String(data)
        const half = s.slice(0, Math.max(1, Math.floor(s.length / 2)))
        await real(path, half, ...rest)
        throw Object.assign(new Error('simulated crash mid-write'), { code: 'EIO' })
      }
      return real(path, data, ...rest)
    }),
  }
})

// mkdtemp / rm / readFile / readdir resolve to the REAL impls via the spread above.
import { mkdtemp, rm, readFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readSharedBoardCache,
  writeSharedBoardCache,
  readSharedCanvasCache,
  writeSharedCanvasCache,
} from '../sharedCache'
import type { CanvasFile, ProjectData } from '../../types'

const UUID = '55555555-5555-5555-5555-555555555555'
const CID = 'cv-99998888'

const boardWith = (taskId: string): ProjectData => ({
  description: '',
  notes: '',
  updatedAt: '',
  tasks: [{ id: taskId, title: 'hello', done: false } as ProjectData['tasks'][number]],
})

const canvasWith = (name: string): CanvasFile => ({
  id: CID,
  name,
  rev: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [{ id: 'e1', type: 'sticky', x: 0, y: 0, text: 'hi' } as CanvasFile['elements'][number]],
  chats: [],
  activeChatId: null,
  sidebarOpen: false,
  sidebarWidth: null,
  createdAt: '',
  updatedAt: '',
})

let home: string
// The suite-wide pin (src/test/setup-home.ts), restored in afterEach. NEVER
// `delete` it: an unset OPENGROUND_HOME makes every later openGroundHome()
// resolve to the REAL ~/.openground (the 2026-07-18 data loss).
const prevHome = process.env.OPENGROUND_HOME
const boardDir = () => join(home, 'shared', UUID)
const boardFile = () => join(boardDir(), 'board.json')
const canvasDir = () => join(home, 'shared', UUID, 'canvas')
const canvasFile = () => join(canvasDir(), `${CID}.json`)
const tempLitter = async (dir: string) => (await readdir(dir)).filter((f) => f.includes('.tmp-'))

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'og-shared-atomic-'))
  process.env.OPENGROUND_HOME = home
  crash.armed = false
})
afterEach(async () => {
  crash.armed = false
  // NOT unset — see paths.ts openGroundHome(): empty means the real
  // ~/.openground, and worker processes are reused across test files. Restore
  // the suite-wide pin rather than leaving the (about to be removed) temp dir
  // in place, so the next file inherits a home that still exists.
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe('shared board cache — atomic write', () => {
  it('a burst of concurrent writes converges to one complete, valid file (no torn write, no temp litter)', async () => {
    const N = 25
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => writeSharedBoardCache(UUID, boardWith(`writer-${i}`))),
    )
    expect(results.every((r) => r === true)).toBe(true)

    // The on-disk file is exactly ONE complete payload — raw-parse never trips on
    // a half-written interleave (the whole point of the fix).
    const raw = await readFile(boardFile(), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    const parsed = JSON.parse(raw) as ProjectData
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.tasks[0].id).toMatch(/^writer-\d+$/)

    // readSharedBoardCache returns a valid board (never null from a torn parse).
    const back = await readSharedBoardCache(UUID)
    expect(back?.tasks[0].id).toBe(parsed.tasks[0].id)

    // No temp siblings survive the storm.
    expect(await tempLitter(boardDir())).toEqual([])
  })

  it('a crash mid-write leaves the PREVIOUS cached board intact (atomic temp+rename), not a truncated file', async () => {
    expect(await writeSharedBoardCache(UUID, boardWith('v1'))).toBe(true)

    // The next write dies after truncated bytes have hit disk.
    crash.armed = true
    expect(await writeSharedBoardCache(UUID, boardWith('v2'))).toBe(false)
    expect(crash.armed).toBe(false) // the injector actually fired (guards a silent no-op mock)

    // The live cache file is still the COMPLETE v1: the truncated bytes went to a
    // temp sibling that atomicWriteText cleaned up, never to board.json itself.
    const raw = await readFile(boardFile(), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect((JSON.parse(raw) as ProjectData).tasks[0].id).toBe('v1')

    const back = await readSharedBoardCache(UUID)
    expect(back?.tasks[0].id).toBe('v1') // NOT null (torn) and NOT a partial v2
    expect(await tempLitter(boardDir())).toEqual([])
  })
})

describe('shared canvas cache — atomic write', () => {
  it('a burst of concurrent writes converges to one complete, valid file (no torn write, no temp litter)', async () => {
    const N = 25
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => writeSharedCanvasCache(UUID, CID, canvasWith(`name-${i}`))),
    )
    expect(results.every((r) => r === true)).toBe(true)

    const raw = await readFile(canvasFile(), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    const parsed = JSON.parse(raw) as CanvasFile
    expect(parsed.id).toBe(CID)
    expect(parsed.elements).toHaveLength(1)
    expect(parsed.name).toMatch(/^name-\d+$/)

    const back = await readSharedCanvasCache(UUID, CID)
    expect(back?.name).toBe(parsed.name)

    expect(await tempLitter(canvasDir())).toEqual([])
  })

  it('a crash mid-write leaves the PREVIOUS cached canvas intact (atomic temp+rename), not a truncated file', async () => {
    expect(await writeSharedCanvasCache(UUID, CID, canvasWith('v1'))).toBe(true)

    crash.armed = true
    expect(await writeSharedCanvasCache(UUID, CID, canvasWith('v2'))).toBe(false)
    expect(crash.armed).toBe(false)

    const raw = await readFile(canvasFile(), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect((JSON.parse(raw) as CanvasFile).name).toBe('v1')

    const back = await readSharedCanvasCache(UUID, CID)
    expect(back?.name).toBe('v1')
    expect(await tempLitter(canvasDir())).toEqual([])
  })
})
