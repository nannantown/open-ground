import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureShareEvacuated,
  evacuateImportedProject,
  __resetShareEvacCacheForTests,
} from './shareEvac'
import { __resetMigrationCacheForTests } from './registry'
import { projectCentralDir } from './paths'
import { getSettings, setSettings } from './store'
import { registerTestProject } from '../../test/registerProject'

// One-shot evacuation of the removed "Share via Git" feature (shareEvac.ts).
// A project that had Share ON keeps its live Board + Canvas data INSIDE the
// repo under `.openground/` (a `.openground/openground.json` marker is the mode
// switch). ensureShareEvacuated() copies that data back into the central store
// ~/.openground/projects/<uuid>/ ONCE per home, preserving the central personal
// fields the marker never carried, then stamps a `shareEvacuatedAt` sentinel so
// it never runs again. It deliberately does NOT delete the repo's `.openground/`.
//
// HOME is tmpdir-isolated by src/test/setup-home.ts (OPENGROUND_HOME → a
// throwaway tmp dir) so the suite NEVER reads or writes the real ~/.openground —
// a regression that once let a destructive route wipe a user's real run history.
// We assert that invariant up front, then reset both the registry migration
// cache and the evacuation cache before each case so a freshly-seeded home is
// scanned cleanly.

// Belt-and-suspenders: refuse to run if HOME isolation didn't land.
if (!process.env.OPENGROUND_HOME || !process.env.OPENGROUND_HOME.startsWith(tmpdir())) {
  throw new Error(
    `[shareEvac.test] OPENGROUND_HOME (${String(
      process.env.OPENGROUND_HOME,
    )}) is not under tmpdir — refusing to run against the real home`,
  )
}

const SHARED_DIR = '.openground'

interface SeededMarker {
  version?: number
  description?: string
  descriptionJa?: string
  descriptionEn?: string
  config?: Record<string, unknown>
}

// Seed a fake git-shared `.openground/` tree in `dir`, mirroring exactly what
// the (now-deleted) Share via Git feature wrote and what shareEvac reads back:
//   .openground/openground.json          — the mode-switch marker
//   .openground/board/cards/<id>.json     — one card file per task
//   .openground/board/notes.md            — board notes
//   .openground/board/assets/<hash>.png   — card image attachments
//   .openground/canvas/canvases/<id>.json — one file per canvas
//   .openground/canvas/index.json         — { order: string[] } (shared)
//   .openground/canvas/assets/<id>/<f>    — per-canvas image assets
const seedShared = async (
  dir: string,
  opts: {
    marker: SeededMarker | null
    cards?: Record<string, unknown>[]
    notes?: string
    boardAssets?: Record<string, Buffer> // filename -> bytes
    canvases?: Record<string, unknown>[] // each must carry an `id`
    canvasOrder?: string[]
    canvasAssets?: Record<string, Record<string, Buffer>> // canvasId -> {file -> bytes}
  },
): Promise<void> => {
  const root = join(dir, SHARED_DIR)
  await mkdir(root, { recursive: true })
  if (opts.marker !== null) {
    await writeFile(join(root, 'openground.json'), JSON.stringify(opts.marker), 'utf8')
  }

  // Board
  if (opts.cards) {
    const cardsDir = join(root, 'board', 'cards')
    await mkdir(cardsDir, { recursive: true })
    for (const c of opts.cards) {
      await writeFile(join(cardsDir, `${String(c.id)}.json`), JSON.stringify(c), 'utf8')
    }
  }
  if (opts.notes !== undefined) {
    await mkdir(join(root, 'board'), { recursive: true })
    await writeFile(join(root, 'board', 'notes.md'), opts.notes, 'utf8')
  }
  if (opts.boardAssets) {
    const assetsDir = join(root, 'board', 'assets')
    await mkdir(assetsDir, { recursive: true })
    for (const [name, bytes] of Object.entries(opts.boardAssets)) {
      await writeFile(join(assetsDir, name), bytes)
    }
  }

  // Canvas
  if (opts.canvases) {
    const canvasesDir = join(root, 'canvas', 'canvases')
    await mkdir(canvasesDir, { recursive: true })
    for (const cv of opts.canvases) {
      await writeFile(join(canvasesDir, `${String(cv.id)}.json`), JSON.stringify(cv), 'utf8')
    }
  }
  if (opts.canvasOrder) {
    await mkdir(join(root, 'canvas'), { recursive: true })
    await writeFile(
      join(root, 'canvas', 'index.json'),
      JSON.stringify({ order: opts.canvasOrder }),
      'utf8',
    )
  }
  if (opts.canvasAssets) {
    for (const [canvasId, files] of Object.entries(opts.canvasAssets)) {
      const d = join(root, 'canvas', 'assets', canvasId)
      await mkdir(d, { recursive: true })
      for (const [name, bytes] of Object.entries(files)) {
        await writeFile(join(d, name), bytes)
      }
    }
  }
}

// A minimal valid board card (ProjectTaskSchema). `boardColumn` is required for
// it to survive the legacy-card filter on later reads, but shareEvac only zod-
// parses, so any schema-valid card is enough.
const card = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Task ${id}`,
  done: false,
  createdAt: '2026-06-10T00:00:00.000Z',
  boardColumn: 'todo',
  ...over,
})

// A minimal canvas file. shareEvac copies the file verbatim, so the exact shape
// is irrelevant beyond carrying an `id` for the file name.
const canvas = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  version: 1,
  elements: [],
})

// Binary payload with the full byte range so a lossy text-mode copy in the
// migration would be caught (PNG-ish header + every byte value).
const binaryBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  ])

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

describe('shareEvac — one-shot Share via Git evacuation', () => {
  let dir: string
  let uuid: string
  let central: string

  beforeEach(async () => {
    // A freshly-seeded home each case: clear both the registry migration cache
    // and the evacuation cache so neither short-circuits against a stale home.
    __resetMigrationCacheForTests()
    __resetShareEvacCacheForTests()
    // The suite shares ONE tmp home (setup-home.ts), and setSettings merges, so
    // a prior case's `shareEvacuatedAt` would persist and make every later run a
    // no-op. Clear the persisted sentinel (undefined → dropped by JSON.stringify
    // → absent on the next read). Cases that test a PRE-set sentinel set it
    // themselves after this.
    await setSettings({ shareEvacuatedAt: undefined })
    dir = await mkdtemp(join(tmpdir(), 'og-shareevac-'))
    uuid = await registerTestProject(dir)
    // shareEvac writes to projectCentralDir(entry.id) directly — read there.
    central = projectCentralDir(uuid)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('central round-trip: shared Board + Canvas data lands in the central store', async () => {
    const cfg = {
      completionFlow: 'pr',
      targetBranch: 'main',
      members: ['alice', 'bob'],
    }
    const hash = `${'a'.repeat(40)}.png`
    await seedShared(dir, {
      marker: {
        version: 1,
        description: 'shared board',
        descriptionJa: '共有ボード',
        config: cfg,
      },
      cards: [
        card('t1', { boardColumn: 'doing', boardOrder: 0, notes: 'plan' }),
        card('t2', { boardColumn: 'todo', boardOrder: 1, dependsOn: ['t1'] }),
      ],
      notes: '# shared notes\n',
      boardAssets: { [hash]: binaryBytes() },
      canvases: [canvas('cv1', 'First'), canvas('cv2', 'Second')],
      canvasOrder: ['cv2', 'cv1'],
      canvasAssets: { cv1: { 'img1.png': binaryBytes() } },
    })

    await ensureShareEvacuated()

    // ── Central tasks.json: tasks + notes + description + config ──
    const tasks = await readJson(join(central, 'tasks.json'))
    expect(tasks.description).toBe('shared board')
    expect(tasks.descriptionJa).toBe('共有ボード')
    expect(tasks.config).toEqual(cfg)
    expect(tasks.notes).toBe('# shared notes\n')
    expect((tasks.tasks as Array<{ id: string }>).map((t) => t.id).sort()).toEqual(['t1', 't2'])
    const t1 = (tasks.tasks as Array<Record<string, unknown>>).find((t) => t.id === 't1')
    expect(t1?.notes).toBe('plan')
    expect(t1?.boardColumn).toBe('doing')

    // ── Central canvases/: one file per canvas (copied verbatim) ──
    expect(existsSync(join(central, 'canvases', 'cv1.json'))).toBe(true)
    expect(existsSync(join(central, 'canvases', 'cv2.json'))).toBe(true)
    expect((await readJson(join(central, 'canvases', 'cv1.json'))).name).toBe('First')

    // ── Central canvases-index.json: order = shared order; activeId = order[0] ──
    const idx = await readJson(join(central, 'canvases-index.json'))
    expect(idx.order).toEqual(['cv2', 'cv1'])
    expect(idx.activeId).toBe('cv2')

    // ── Images: board → task-assets/, canvas → canvases/<id>-assets/ ──
    const boardAsset = await readFile(join(central, 'task-assets', hash))
    expect(boardAsset.equals(binaryBytes())).toBe(true)
    const canvasAsset = await readFile(join(central, 'canvases', 'cv1-assets', 'img1.png'))
    expect(canvasAsset.equals(binaryBytes())).toBe(true)

    // The sentinel is stamped so the migration is done.
    expect((await getSettings()).shareEvacuatedAt).toBeTruthy()
  })

  it('preserves central personal fields (tabOrder / customTabs / launch / disabledModules)', async () => {
    // Seed central tasks.json with PERSONAL fields the marker never carried —
    // the same path shareEvac reads + spreads, so they must survive.
    await mkdir(central, { recursive: true })
    await writeFile(
      join(central, 'tasks.json'),
      JSON.stringify({
        description: 'stale central desc',
        tabOrder: ['board', 'terminal'],
        customTabs: ['aaaaaaaa-0000-4000-8000-000000000001'],
        launch: { permissionMode: 'acceptEdits', model: 'opus', effort: 'high' },
        disabledModules: ['canvas'],
        tasks: [],
        notes: 'stale central notes',
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
      'utf8',
    )

    await seedShared(dir, {
      marker: { version: 1, description: 'shared desc' },
      cards: [card('t1')],
      notes: 'shared notes',
    })

    await ensureShareEvacuated()

    const tasks = await readJson(join(central, 'tasks.json'))
    // Personal fields preserved verbatim.
    expect(tasks.tabOrder).toEqual(['board', 'terminal'])
    expect(tasks.customTabs).toEqual(['aaaaaaaa-0000-4000-8000-000000000001'])
    expect(tasks.launch).toEqual({ permissionMode: 'acceptEdits', model: 'opus', effort: 'high' })
    expect(tasks.disabledModules).toEqual(['canvas'])
    // Shared fields were overwritten by the marker / repo data.
    expect(tasks.description).toBe('shared desc')
    expect(tasks.notes).toBe('shared notes')
    expect((tasks.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual(['t1'])
  })

  it('is idempotent: a second run is a no-op (sentinel guards it), no data churn', async () => {
    await seedShared(dir, {
      marker: { version: 1, description: 'once' },
      cards: [card('t1')],
      notes: 'n',
    })

    await ensureShareEvacuated()
    const afterFirst = await readFile(join(central, 'tasks.json'), 'utf8')
    const sentinel = (await getSettings()).shareEvacuatedAt
    expect(sentinel).toBeTruthy()

    // Mutate the repo's shared data AFTER the first evacuation: a correct
    // sentinel-guarded re-run must NOT pick this up.
    await seedShared(dir, {
      marker: { version: 1, description: 'changed-after' },
      cards: [card('t1'), card('t2')],
      notes: 'changed',
    })

    // Reset only the in-process cache (NOT the persisted sentinel) and re-run.
    __resetShareEvacCacheForTests()
    await ensureShareEvacuated()

    const afterSecond = await readFile(join(central, 'tasks.json'), 'utf8')
    expect(afterSecond).toBe(afterFirst) // central data untouched
    // Sentinel unchanged (evacuateOnce returned early before re-stamping).
    expect((await getSettings()).shareEvacuatedAt).toBe(sentinel)
  })

  it('non-shared projects (no marker) are left untouched — central stays empty', async () => {
    // A registered project with NO `.openground/openground.json` marker.
    await seedShared(dir, {
      marker: null, // no marker → not shared
      cards: [card('ignored')],
      notes: 'should not be read',
    })

    await ensureShareEvacuated()

    // Nothing was written into the central store for this project.
    expect(existsSync(join(central, 'tasks.json'))).toBe(false)
    expect(existsSync(join(central, 'canvases'))).toBe(false)
    // The sentinel is still stamped (the scan ran, found nothing to do).
    expect((await getSettings()).shareEvacuatedAt).toBeTruthy()
  })

  it('board-only share (no canvas files) does not wipe existing central canvases', async () => {
    // Pre-existing central canvases the user built locally.
    await mkdir(join(central, 'canvases'), { recursive: true })
    await writeFile(
      join(central, 'canvases', 'local.json'),
      JSON.stringify(canvas('local', 'Local')),
      'utf8',
    )
    await writeFile(
      join(central, 'canvases-index.json'),
      JSON.stringify({ order: ['local'], activeId: 'local' }),
      'utf8',
    )

    // A shared project that carries a board but NO canvas/canvases/ dir.
    await seedShared(dir, {
      marker: { version: 1, description: 'board only' },
      cards: [card('t1')],
      notes: 'b',
    })

    await ensureShareEvacuated()

    // Board data evacuated …
    const tasks = await readJson(join(central, 'tasks.json'))
    expect((tasks.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual(['t1'])
    expect(tasks.description).toBe('board only')

    // … but the local canvas + index were NOT touched (ids.length === 0 branch).
    expect(existsSync(join(central, 'canvases', 'local.json'))).toBe(true)
    const idx = await readJson(join(central, 'canvases-index.json'))
    expect(idx).toEqual({ order: ['local'], activeId: 'local' })
  })

  it('skips a bad repo and still stamps the sentinel (best-effort, never wedges boot)', async () => {
    // Register a SECOND project whose path vanishes before evacuation: its
    // central-dir resolution still works (id-based), but readMarker on a gone
    // dir returns null → it is simply skipped, and the sentinel still lands.
    const gone = await mkdtemp(join(tmpdir(), 'og-shareevac-gone-'))
    await registerTestProject(gone)
    await rm(gone, { recursive: true, force: true })

    // The primary project is a normal shared one.
    await seedShared(dir, {
      marker: { version: 1, description: 'survives' },
      cards: [card('t1')],
      notes: 'n',
    })

    await expect(ensureShareEvacuated()).resolves.toBeUndefined()

    const tasks = await readJson(join(central, 'tasks.json'))
    expect(tasks.description).toBe('survives')
    expect((await getSettings()).shareEvacuatedAt).toBeTruthy()
  })

  it('a pre-set sentinel makes the whole scan a no-op', async () => {
    // Sentinel already present (e.g. a prior boot evacuated). Even a shared
    // repo must NOT be touched.
    await setSettings({ shareEvacuatedAt: '2020-01-01T00:00:00.000Z' })
    await seedShared(dir, {
      marker: { version: 1, description: 'never read' },
      cards: [card('t1')],
      notes: 'n',
    })

    await ensureShareEvacuated()

    expect(existsSync(join(central, 'tasks.json'))).toBe(false)
    // Sentinel preserved (not re-stamped).
    expect((await getSettings()).shareEvacuatedAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it('finding #1: an imported shared-clone is evacuated even after the global sentinel is set', async () => {
    // Simulate an existing install post-upgrade: the boot sweep already ran and
    // stamped the global sentinel, so ensureShareEvacuated() is now a no-op for
    // everyone (proven by the case above). A shared-clone IMPORTED at this point
    // must still be rescued — the import route calls evacuateImportedProject on
    // the single new entry, independent of that global sentinel.
    await setSettings({ shareEvacuatedAt: '2020-01-01T00:00:00.000Z' })

    // A fresh shared-clone dir registered like an import (its own central UUID).
    const cloneDir = await mkdtemp(join(tmpdir(), 'og-shareevac-import-'))
    try {
      const cloneUuid = await registerTestProject(cloneDir)
      const cloneCentral = projectCentralDir(cloneUuid)
      await seedShared(cloneDir, {
        marker: { version: 1, description: 'imported share' },
        cards: [card('t1'), card('t2')],
        notes: 'imported notes',
        canvases: [canvas('cv1', 'Imported')],
        canvasOrder: ['cv1'],
      })

      // Sanity: the gated boot sweep does NOTHING here (sentinel set) — so without
      // the per-project import evac this clone would stay empty (the finding #1 bug).
      await ensureShareEvacuated()
      expect(existsSync(join(cloneCentral, 'tasks.json'))).toBe(false)

      // The fix: the import path evacuates this one project directly.
      await evacuateImportedProject({ id: cloneUuid, path: cloneDir })

      // Board + Canvas rescued into the imported project's central store …
      const tasks = await readJson(join(cloneCentral, 'tasks.json'))
      expect(tasks.description).toBe('imported share')
      expect(tasks.notes).toBe('imported notes')
      expect((tasks.tasks as Array<{ id: string }>).map((t) => t.id).sort()).toEqual(['t1', 't2'])
      expect(existsSync(join(cloneCentral, 'canvases', 'cv1.json'))).toBe(true)
      expect((await readJson(join(cloneCentral, 'canvases-index.json'))).order).toEqual(['cv1'])

      // … and the GLOBAL sentinel is untouched (per-project evac never re-stamps
      // it, so the boot sweep stays one-shot for every other project).
      expect((await getSettings()).shareEvacuatedAt).toBe('2020-01-01T00:00:00.000Z')
    } finally {
      // afterEach only removes `dir`; clean up this case's extra clone.
      await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
