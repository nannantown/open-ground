import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProjectData, ProjectTask } from '../types'
import {
  readProjectData,
  writeProjectData,
  migrateBoardToShared,
  migrateBoardFromShared,
} from './projectData'
import { projectDataDir } from './projectDataPath'
import {
  SHARED_DATA_VERSION,
  boardAssetsDir,
  boardCardsDir,
  boardNotesPath,
  readSharedMarker,
  writeSharedMarker,
  sharedDataDir,
} from './sharedData'
import { TASK_ASSETS_SUBDIR, readTaskAsset, writeTaskAsset } from './taskAssets'
import type { SharedMarker } from './sharedData'
import { registerTestProject } from '../../test/registerProject'

// writeSharedMarker does not mkdir its parent (production callers — the
// migration / shared write — create .openground/board/cards first), so tests
// that seed a marker directly must create the dir themselves.
const seedMarker = async (dir: string, marker: SharedMarker) => {
  await mkdir(sharedDataDir(dir), { recursive: true })
  await writeSharedMarker(dir, marker)
}

// Git-shared board storage (docs/SHARED_DATA_PLAN.md, Track A): when the repo
// carries .openground/openground.json, tasks live as one card file each under
// .openground/board/cards/, notes in board/notes.md, description in the
// marker; tabOrder/updatedAt stay personal in the central tasks.json. HOME is
// isolated to a tmpdir by setup-home.ts — these tests never touch the real
// ~/.openground.

const card = (id: string, over: Partial<ProjectTask> = {}): ProjectTask => ({
  id,
  title: `Task ${id}`,
  done: false,
  createdAt: '2026-06-10T00:00:00.000Z',
  boardColumn: 'todo',
  ...over,
})

const data = (over: Partial<ProjectData> = {}): ProjectData => ({
  description: 'shared project',
  tasks: [],
  notes: '',
  updatedAt: '2026-06-10T00:00:00.000Z',
  ...over,
})

describe('projectData — git-shared mode', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-pds-'))
    await registerTestProject(dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const enableShared = () =>
    seedMarker(dir, { version: SHARED_DATA_VERSION, description: '' })

  it('round-trips tasks / notes / description / tabOrder through the repo layout', async () => {
    await enableShared()
    const written = await writeProjectData(dir, data({
      description: 'a board shared via git',
      tasks: [
        // Every shared card field must survive the per-file round-trip — a
        // field missing from normalizeCard silently vanishes (the 3点セット
        // lesson: types.ts / schemas.ts / normalizeCard).
        card('aaa', {
          boardColumn: 'doing',
          boardOrder: 0,
          notes: 'plan',
          attachments: [{ id: `${'b'.repeat(40)}.png`, name: 'shot.png', mime: 'image/png' }],
        }),
        card('bbb', { boardColumn: 'todo', boardOrder: 1, dependsOn: ['aaa'], dueDate: '2026-06-15' }),
      ],
      notes: '# shared notes\n',
      tabOrder: ['board', 'terminal'],
    }))

    // Repo layout: one card file per task + notes.md + marker description.
    const files = (await readdir(boardCardsDir(dir))).sort()
    expect(files).toEqual(['aaa.json', 'bbb.json'])
    expect(await readFile(boardNotesPath(dir), 'utf8')).toBe('# shared notes\n')
    expect((await readSharedMarker(dir))?.description).toBe('a board shared via git')
    // Card files are pretty-printed with a stable key order (id first).
    const rawCard = await readFile(join(boardCardsDir(dir), 'aaa.json'), 'utf8')
    expect(rawCard.startsWith('{\n  "id": "aaa"')).toBe(true)

    // Central tasks.json holds ONLY the personal fields live (tabOrder).
    const centralRaw = JSON.parse(
      await readFile(join(await projectDataDir(dir), 'tasks.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(centralRaw.tabOrder).toEqual(['board', 'terminal'])

    // Read composes both sources back into one ProjectData.
    const read = await readProjectData(dir)
    expect(read.description).toBe('a board shared via git')
    expect(read.notes).toBe('# shared notes\n')
    expect(read.tabOrder).toEqual(['board', 'terminal'])
    expect(read.updatedAt).toBe(written.updatedAt)
    // Deterministic order: column (todo < doing) then boardOrder then id.
    expect(read.tasks.map(t => t.id)).toEqual(['bbb', 'aaa'])
    expect(read.tasks.find(t => t.id === 'aaa')?.notes).toBe('plan')
    expect(read.tasks.find(t => t.id === 'aaa')?.attachments).toEqual([
      { id: `${'b'.repeat(40)}.png`, name: 'shot.png', mime: 'image/png' },
    ])
    expect(read.tasks.find(t => t.id === 'bbb')?.dependsOn).toEqual(['aaa'])
    expect(read.tasks.find(t => t.id === 'bbb')?.dueDate).toBe('2026-06-15')
  })

  it('orders cards deterministically: column, then boardOrder, then createdAt, then id', async () => {
    await enableShared()
    await writeProjectData(dir, data({
      tasks: [
        card('z', { boardColumn: 'done', boardOrder: 0 }),
        card('m', { boardColumn: 'todo' /* no boardOrder → after ordered */ }),
        card('a', { boardColumn: 'todo', boardOrder: 5 }),
        card('b', { boardColumn: 'todo', boardOrder: 1 }),
        card('k', { boardColumn: 'blocked' }),
      ],
    }))
    const read = await readProjectData(dir)
    expect(read.tasks.map(t => t.id)).toEqual(['b', 'a', 'm', 'z', 'k'])
  })

  it('skips a corrupt or schema-invalid card file without nuking the board', async () => {
    await enableShared()
    await writeProjectData(dir, data({ tasks: [card('good')] }))
    await writeFile(join(boardCardsDir(dir), 'broken.json'), '{ not json', 'utf8')
    await writeFile(join(boardCardsDir(dir), 'invalid.json'), JSON.stringify({ id: 42, title: 'no' }), 'utf8')

    const read = await readProjectData(dir)
    expect(read.tasks.map(t => t.id)).toEqual(['good'])
    // The bad files stay on disk for the user / git to recover.
    const files = (await readdir(boardCardsDir(dir))).sort()
    expect(files).toEqual(['broken.json', 'good.json', 'invalid.json'])
  })

  it('composes a fresh clone (repo files present, NO central tasks.json)', async () => {
    // Simulate a collaborator's clone: shared files exist, central data never
    // written on this machine.
    await seedMarker(dir, { version: SHARED_DATA_VERSION, description: 'from the repo' })
    await mkdir(boardCardsDir(dir), { recursive: true })
    await writeFile(join(boardCardsDir(dir), 'c1.json'), JSON.stringify(card('c1')), 'utf8')
    await writeFile(boardNotesPath(dir), 'cloned notes', 'utf8')

    const read = await readProjectData(dir)
    expect(read.description).toBe('from the repo')
    expect(read.tasks.map(t => t.id)).toEqual(['c1'])
    expect(read.notes).toBe('cloned notes')
    expect(read.tabOrder).toBeUndefined()
  })

  it('a missing cards dir reads as zero tasks (marker-only share)', async () => {
    await seedMarker(dir, { version: SHARED_DATA_VERSION, description: 'bare' })
    const read = await readProjectData(dir)
    expect(read.tasks).toEqual([])
    expect(read.notes).toBe('')
    expect(read.description).toBe('bare')
  })

  it('deleting a card removes its file; unchanged cards are left alone', async () => {
    await enableShared()
    await writeProjectData(dir, data({ tasks: [card('keep'), card('drop')] }))
    const before = await stat(join(boardCardsDir(dir), 'keep.json'))
    await new Promise(r => setTimeout(r, 10))
    await writeProjectData(dir, data({ tasks: [card('keep')] }))
    const files = await readdir(boardCardsDir(dir))
    expect(files.sort()).toEqual(['keep.json'])
    // Identical card content → file not rewritten (mtime unchanged): git stays quiet.
    const after = await stat(join(boardCardsDir(dir), 'keep.json'))
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('preserves an existing marker version on description updates', async () => {
    await seedMarker(dir, { version: 7, description: 'old' })
    await writeProjectData(dir, data({ description: 'new description' }))
    const marker = await readSharedMarker(dir)
    expect(marker).toEqual({ version: 7, description: 'new description' })
  })

  it('concurrent writes are serialized: one whole write wins, never an interleaved mix', async () => {
    // Which write enqueues first is nondeterministic (both await the registry
    // before taking the lock), so assert COHERENCE: the final state is exactly
    // one of the two writes — an interleaving could leave e.g. {a,b,c} on disk
    // (the second write's diff raced the first's card creation).
    await enableShared()
    await Promise.all([
      writeProjectData(dir, data({ tasks: [card('a'), card('b')] })),
      writeProjectData(dir, data({ tasks: [card('c')] })),
    ])
    const read = await readProjectData(dir)
    const ids = read.tasks.map(t => t.id).sort()
    expect([['a', 'b'], ['c']]).toContainEqual(ids)
    // Disk agrees with the composed read.
    expect((await readdir(boardCardsDir(dir))).sort()).toEqual(ids.map(id => `${id}.json`))
  })
})

describe('projectData — share migrations', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-pdm-'))
    await registerTestProject(dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('migrateBoardToShared: central → repo, then reads come from the repo', async () => {
    const central = await writeProjectData(dir, data({
      description: 'my project',
      tasks: [card('t1', { boardColumn: 'doing' }), card('t2', { done: true, boardColumn: 'done' })],
      notes: 'central notes',
      tabOrder: ['terminal', 'board'],
    }))

    await migrateBoardToShared(dir)

    const marker = await readSharedMarker(dir)
    expect(marker).toEqual({ version: SHARED_DATA_VERSION, description: 'my project' })
    expect((await readdir(boardCardsDir(dir))).sort()).toEqual(['t1.json', 't2.json'])
    expect(await readFile(boardNotesPath(dir), 'utf8')).toBe('central notes')

    const read = await readProjectData(dir)
    expect(read.description).toBe('my project')
    expect(read.tasks.map(t => t.id).sort()).toEqual(['t1', 't2'])
    expect(read.notes).toBe('central notes')
    // Personal fields still come from central.
    expect(read.tabOrder).toEqual(central.tabOrder)
  })

  it('migrateBoardToShared is idempotent and preserves a pre-existing marker version', async () => {
    await writeProjectData(dir, data({ description: 'desc', tasks: [card('t1')] }))
    // The canvas migration (Track B) may have ensured the marker first.
    await seedMarker(dir, { version: 9 })
    await migrateBoardToShared(dir)
    await migrateBoardToShared(dir)
    expect(await readSharedMarker(dir)).toEqual({ version: 9, description: 'desc' })
    expect((await readdir(boardCardsDir(dir))).sort()).toEqual(['t1.json'])
  })

  it('migrateBoardToShared materializes notes.md even when notes are empty', async () => {
    await writeProjectData(dir, data({ tasks: [card('t1')], notes: '' }))
    await migrateBoardToShared(dir)
    expect(await readFile(boardNotesPath(dir), 'utf8')).toBe('')
  })

  it('migrateBoardFromShared: repo → central, keeping central personal fields', async () => {
    await writeProjectData(dir, data({
      description: 'before share',
      tasks: [card('t1')],
      notes: 'before',
      tabOrder: ['board'],
    }))
    await migrateBoardToShared(dir)
    // Teammate edits arrive via git: a new card + changed notes + description.
    await writeFile(join(boardCardsDir(dir), 't2.json'), JSON.stringify(card('t2', { boardColumn: 'doing' })), 'utf8')
    await writeFile(boardNotesPath(dir), 'merged notes', 'utf8')
    await seedMarker(dir, { version: SHARED_DATA_VERSION, description: 'merged desc' })

    const migrated = await migrateBoardFromShared(dir)
    expect(migrated.tasks.map(t => t.id).sort()).toEqual(['t1', 't2'])
    expect(migrated.notes).toBe('merged notes')
    expect(migrated.description).toBe('merged desc')
    expect(migrated.tabOrder).toEqual(['board'])

    // .openground/ is NOT deleted here (the disable route owns that)…
    expect((await readdir(boardCardsDir(dir))).sort()).toEqual(['t1.json', 't2.json'])
    // …so simulate the route deleting it, then central must serve the data.
    await rm(sharedDataDir(dir), { recursive: true, force: true })
    const read = await readProjectData(dir)
    expect(read.tasks.map(t => t.id).sort()).toEqual(['t1', 't2'])
    expect(read.notes).toBe('merged notes')
    expect(read.description).toBe('merged desc')
    expect(read.tabOrder).toEqual(['board'])
  })

  it('migrateBoardFromShared is a no-op when the project is not shared', async () => {
    const central = await writeProjectData(dir, data({ tasks: [card('t1')], notes: 'n' }))
    const result = await migrateBoardFromShared(dir)
    expect(result.tasks.map(t => t.id)).toEqual(['t1'])
    expect(result.updatedAt).toBe(central.updatedAt)
  })

  it('full round-trip central → shared → central is lossless', async () => {
    const original = data({
      description: 'round trip',
      tasks: [
        card('a', { boardColumn: 'todo', boardOrder: 0, notes: 'memo' }),
        card('b', { boardColumn: 'done', done: true, boardOrder: 1 }),
      ],
      notes: 'notes body',
      tabOrder: ['board', 'canvas'],
    })
    await writeProjectData(dir, original)
    await migrateBoardToShared(dir)
    await migrateBoardFromShared(dir)
    await rm(sharedDataDir(dir), { recursive: true, force: true })
    const read = await readProjectData(dir)
    expect(read.description).toBe(original.description)
    expect(read.notes).toBe(original.notes)
    expect(read.tabOrder).toEqual(original.tabOrder)
    expect(read.tasks.map(t => t.id).sort()).toEqual(['a', 'b'])
    expect(read.tasks.find(t => t.id === 'a')).toMatchObject({ title: 'Task a', notes: 'memo', boardOrder: 0 })
  })

  it('enable→disable round-trip carries attachment BYTES (central → repo → central)', async () => {
    // Canvas precedent parity: the board migrations copy the task-assets dir
    // both ways, so an attached image survives Share → Stop sharing.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    await writeProjectData(dir, data({ tasks: [card('t1')] }))
    const id = await writeTaskAsset(dir, 'image/png', png)
    const centralAssets = join(await projectDataDir(dir), TASK_ASSETS_SUBDIR)
    expect(await readdir(centralAssets)).toEqual([id])

    // Enable: bytes follow the cards into the repo (.openground/board/assets/).
    await migrateBoardToShared(dir)
    expect(await readdir(boardAssetsDir(dir))).toEqual([id])
    // The live read now serves the repo copy (marker decides the store).
    expect((await readTaskAsset(dir, id))?.data.equals(png)).toBe(true)

    // A second image lands while shared (e.g. a teammate's upload via git).
    const png2 = Buffer.from('89504e470d0a1a0adeadbeef', 'hex')
    const id2 = await writeTaskAsset(dir, 'image/png', png2)
    expect((await readdir(boardAssetsDir(dir))).sort()).toEqual([id, id2].sort())

    // Disable: bytes ride back BEFORE the route rm-rf's .openground/.
    await migrateBoardFromShared(dir)
    await rm(sharedDataDir(dir), { recursive: true, force: true })
    expect((await readdir(centralAssets)).sort()).toEqual([id, id2].sort())
    expect((await readTaskAsset(dir, id))?.data.equals(png)).toBe(true)
    expect((await readTaskAsset(dir, id2))?.data.equals(png2)).toBe(true)
  })
})

describe('projectData — non-shared mode regression', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-pdn-'))
    await registerTestProject(dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('never creates .openground/ in the project and keeps data central', async () => {
    const written = await writeProjectData(dir, data({
      description: 'plain',
      tasks: [card('t1')],
      notes: 'central only',
      tabOrder: ['board'],
    }))
    // The repo stays free of OPEN GROUND files (the legacy contract).
    await expect(stat(sharedDataDir(dir))).rejects.toThrow()
    const read = await readProjectData(dir)
    expect(read).toEqual(written)
    // Everything (incl. description/tasks/notes) lives in the central file.
    const centralRaw = JSON.parse(
      await readFile(join(await projectDataDir(dir), 'tasks.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(centralRaw.description).toBe('plain')
    expect((centralRaw.tasks as unknown[]).length).toBe(1)
    expect(centralRaw.notes).toBe('central only')
  })

  it('a stray INVALID marker file does not flip the project into shared mode', async () => {
    await mkdir(sharedDataDir(dir), { recursive: true })
    await writeFile(join(sharedDataDir(dir), 'openground.json'), '{"version":"not a number"}', 'utf8')
    const written = await writeProjectData(dir, data({ tasks: [card('t1')], notes: 'n' }))
    const read = await readProjectData(dir)
    expect(read).toEqual(written)
    // No board/ layout was created by the write.
    await expect(stat(boardCardsDir(dir))).rejects.toThrow()
  })
})


describe('shared marker — generated description language pair', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-pds-pair-'))
    await registerTestProject(dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips descriptionJa/En through the marker and the shared read', async () => {
    await writeProjectData(dir, data({ tasks: [card('a')] }))
    await migrateBoardToShared(dir)
    const current = await readProjectData(dir)
    await writeProjectData(dir, {
      ...current,
      description: 'EN active',
      descriptionEn: 'EN active',
      descriptionJa: '日本語の説明',
    })
    const marker = await readSharedMarker(dir)
    expect(marker?.descriptionEn).toBe('EN active')
    expect(marker?.descriptionJa).toBe('日本語の説明')
    const back = await readProjectData(dir)
    expect(back.descriptionEn).toBe('EN active')
    expect(back.descriptionJa).toBe('日本語の説明')
  })
})
