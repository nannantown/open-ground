// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isCollabProjectId,
  isSafeId,
  readSharedBoardCache,
  writeSharedBoardCache,
  readSharedCanvasCache,
  writeSharedCanvasCache,
} from '../sharedCache'
import type { CanvasFile, ProjectData } from '../../types'

// The folder-less shared-project read-cache (option A). The SECURITY focus is the
// strict-UUID guard: collabProjectId is client-supplied, so a non-UUID (../, a
// slash, junk) must NEVER reach the filesystem (no traversal out of the shared
// root). HOME is isolated to a tmpdir per test (never touch the real
// ~/.openground — feedback_tests_isolate_home).

const UUID = '44444444-4444-4444-4444-444444444444'
const sample = (): ProjectData => ({
  description: '',
  notes: '',
  updatedAt: '',
  tasks: [{ id: 't1', title: 'hello', done: false } as ProjectData['tasks'][number]],
})

let home: string
// The suite-wide pin (src/test/setup-home.ts), restored in afterEach. NEVER
// `delete` it: an unset OPENGROUND_HOME makes every later openGroundHome()
// resolve to the REAL ~/.openground (the 2026-07-18 data loss).
const prevHome = process.env.OPENGROUND_HOME
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'og-shared-cache-'))
  process.env.OPENGROUND_HOME = home
})
afterEach(async () => {
  // NOT unset — see paths.ts openGroundHome(): empty means the real
  // ~/.openground, and worker processes are reused across test files. Restore
  // the suite-wide pin rather than leaving the (about to be removed) temp dir
  // in place, so the next file inherits a home that still exists.
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe('isCollabProjectId — the path-traversal guard', () => {
  it('accepts a real uuid; rejects traversal / slashes / junk / empty', () => {
    expect(isCollabProjectId(UUID)).toBe(true)
    expect(isCollabProjectId(UUID.toUpperCase())).toBe(true) // `i` flag is load-bearing
    expect(isCollabProjectId('../../etc/passwd')).toBe(false)
    expect(isCollabProjectId('a/b')).toBe(false)
    expect(isCollabProjectId('..')).toBe(false)
    expect(isCollabProjectId('')).toBe(false)
    expect(isCollabProjectId('not-a-uuid')).toBe(false)
    expect(isCollabProjectId(`${UUID}/../../x`)).toBe(false)
  })
})

describe('read/write shared board cache', () => {
  it('round-trips ProjectData under ~/.openground/shared/<id>/board.json', async () => {
    expect(await writeSharedBoardCache(UUID, sample())).toBe(true)
    const back = await readSharedBoardCache(UUID)
    expect(back?.tasks).toHaveLength(1)
    expect(back?.tasks[0].id).toBe('t1')
    // Confirms the on-disk location (separate `shared/` root, NOT projects/).
    const raw = await readFile(join(home, 'shared', UUID, 'board.json'), 'utf8')
    expect(JSON.parse(raw).tasks[0].id).toBe('t1')
  })

  it('read → null for an absent cache', async () => {
    expect(await readSharedBoardCache(UUID)).toBeNull()
  })

  it('an invalid id is an inert no-op for BOTH read and write (no traversal)', async () => {
    expect(await writeSharedBoardCache('../evil', sample())).toBe(false)
    expect(await readSharedBoardCache('../evil')).toBeNull()
    // Nothing was written outside the shared root.
    await expect(readFile(join(home, 'evil', 'board.json'), 'utf8')).rejects.toBeTruthy()
  })

  it('persists __proto__/junk keys verbatim WITHOUT polluting Object.prototype', async () => {
    // A malicious POST could carry __proto__; confirm round-trip is inert (V8
    // treats parsed __proto__ as an own data property, no prototype merge).
    const evil = JSON.parse(
      '{"description":"","notes":"","updatedAt":"","tasks":[{"id":"t1"}],"__proto__":{"polluted":true},"junk":7}',
    ) as ProjectData
    expect(await writeSharedBoardCache(UUID, evil)).toBe(true)
    expect((({} as Record<string, unknown>).polluted)).toBeUndefined()
    const back = await readSharedBoardCache(UUID)
    expect(back?.tasks).toHaveLength(1)
    expect((({} as Record<string, unknown>).polluted)).toBeUndefined()
  })

  it('returns false (no throw) for a non-serializable (cyclic) board', async () => {
    const cyclic = sample() as unknown as Record<string, unknown>
    cyclic.self = cyclic // cycle → JSON.stringify throws → inert no-op
    expect(await writeSharedBoardCache(UUID, cyclic as unknown as ProjectData)).toBe(false)
  })

  it('read → null for malformed JSON / wrong shape (corrupt cache never crashes the board)', async () => {
    await writeSharedBoardCache(UUID, sample())
    const file = join(home, 'shared', UUID, 'board.json')
    await writeFile(file, 'not valid json', 'utf8')
    expect(await readSharedBoardCache(UUID)).toBeNull()
    await writeFile(file, JSON.stringify({ description: '', tasks: 'nope' }), 'utf8')
    expect(await readSharedBoardCache(UUID)).toBeNull()
  })
})

describe('shared CANVAS cache (cv4)', () => {
  const CID = 'cv-11112222' // canvas id (UUID or id-xxxx); safe-id, not strict UUID
  const canvas = (): CanvasFile => ({
    id: CID,
    name: 'Wireframes',
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

  it('isSafeId accepts uuids/id-fallback, rejects traversal/slashes/dots', () => {
    expect(isSafeId('11111111-1111-1111-1111-111111111111')).toBe(true)
    expect(isSafeId('id-abc123')).toBe(true)
    expect(isSafeId('../evil')).toBe(false)
    expect(isSafeId('a/b')).toBe(false)
    expect(isSafeId('a.b')).toBe(false)
    expect(isSafeId('')).toBe(false)
  })

  it('round-trips a canvas under <shared>/<pid>/canvas/<cid>.json', async () => {
    expect(await writeSharedCanvasCache(UUID, CID, canvas())).toBe(true)
    const back = await readSharedCanvasCache(UUID, CID)
    expect(back?.elements).toHaveLength(1)
    expect(back?.name).toBe('Wireframes')
    const raw = await readFile(join(home, 'shared', UUID, 'canvas', `${CID}.json`), 'utf8')
    expect(JSON.parse(raw).id).toBe(CID)
  })

  it('an unsafe canvasId is an inert no-op for read AND write (no traversal)', async () => {
    expect(await writeSharedCanvasCache(UUID, '../evil', canvas())).toBe(false)
    expect(await readSharedCanvasCache(UUID, '../evil')).toBeNull()
    expect(await readSharedCanvasCache(UUID, CID)).toBeNull() // nothing written
  })

  it('a bad collabProjectId is rejected even with a safe canvasId', async () => {
    expect(await writeSharedCanvasCache('../evil', CID, canvas())).toBe(false)
    expect(await readSharedCanvasCache('../evil', CID)).toBeNull()
  })

  it('read → null for malformed JSON / wrong shape', async () => {
    await writeSharedCanvasCache(UUID, CID, canvas())
    const file = join(home, 'shared', UUID, 'canvas', `${CID}.json`)
    await writeFile(file, 'not json', 'utf8')
    expect(await readSharedCanvasCache(UUID, CID)).toBeNull()
    await writeFile(file, JSON.stringify({ id: CID, elements: 'nope' }), 'utf8')
    expect(await readSharedCanvasCache(UUID, CID)).toBeNull()
  })
})
