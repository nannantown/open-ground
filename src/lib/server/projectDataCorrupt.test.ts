import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, open } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProjectData, ProjectTask } from '../types'
import { readProjectData, writeProjectData } from './projectData'
import { projectDataDir } from './projectDataPath'
import { registerTestProject } from '../../test/registerProject'

// Goal condition (2): a corrupt / invalid tasks.json must be TOLERATED — the
// cockpit recovers (serves a sane default or salvages the valid fields) instead
// of crashing, and the corrupt bytes are QUARANTINED rather than silently
// destroyed on the next save. HOME is tmpdir-isolated (setup-home.ts).

const TASKS = 'tasks.json'

const seedRaw = async (dir: string, raw: string): Promise<string> => {
  const dataDir = await projectDataDir(dir)
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, TASKS), raw, 'utf8')
  return dataDir
}

const card = (id: string): ProjectTask => ({
  id,
  title: `Task ${id}`,
  done: false,
  createdAt: '2026-06-30T00:00:00.000Z',
  boardColumn: 'todo',
})

const data = (over: Partial<ProjectData> = {}): ProjectData => ({
  description: '',
  tasks: [],
  notes: '',
  updatedAt: '',
  ...over,
})

describe('readProjectData — corrupt / invalid file resilience', () => {
  let dir: string
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-pd-corrupt-'))
    await registerTestProject(dir)
    // The recovery paths log to stderr by design ("recover, don't crash") —
    // silence it so the suite output stays clean, and assert it fired.
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    warn.mockRestore()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('unparseable JSON → serves empty(), does not throw, and LEAVES the file on disk', async () => {
    const dataDir = await seedRaw(dir, '{ this is not: valid json,,,')
    const out = await readProjectData(dir)
    expect(out.tasks).toEqual([])
    expect(out.description).toBe('')
    expect(warn).toHaveBeenCalled()
    // The corrupt original is untouched by a READ (quarantine happens on WRITE).
    expect(await readFile(join(dataDir, TASKS), 'utf8')).toBe('{ this is not: valid json,,,')
  })

  it('JSON that parses to a NON-object (bare string/array) → empty(), no crash, no key pollution', async () => {
    for (const raw of ['"just a string"', '[1,2,3]', '42', 'true', 'null']) {
      await seedRaw(dir, raw)
      const out = await readProjectData(dir)
      expect(out.tasks).toEqual([])
      expect(typeof out.description).toBe('string')
      expect(typeof out.notes).toBe('string')
      // The anti-pollution guarantee: a bare string/array never leaks char or
      // numeric keys (e.g. {0:'h',1:'e',…} or {0:1,1:2,…}) into the result.
      expect(Object.keys(out).some((k) => /^\d+$/.test(k))).toBe(false)
    }
  })

  it('schema-invalid whole file (tasks is not an array) → field-level recovery to empty tasks', async () => {
    await seedRaw(dir, JSON.stringify({ description: 'kept', tasks: 'oops-not-an-array', notes: 'also kept' }))
    const out = await readProjectData(dir)
    expect(out.tasks).toEqual([])
    // The valid scalar fields are salvaged, not wiped.
    expect(out.description).toBe('kept')
    expect(out.notes).toBe('also kept')
  })

  it('one malformed task among valid ones → keep the valid, drop only the bad', async () => {
    await seedRaw(
      dir,
      JSON.stringify({
        description: '',
        tasks: [
          { id: 'good1', title: 'ok', done: false, createdAt: 'x', boardColumn: 'todo' },
          { title: 'no id — invalid', done: false }, // fails ProjectTaskSchema (id required)
          { id: 'good2', title: 'ok2', done: true, createdAt: 'x', boardColumn: 'done' },
          42, // not even an object
        ],
        notes: '',
        updatedAt: 'x',
      }),
    )
    const out = await readProjectData(dir)
    expect(out.tasks.map((t) => t.id).sort()).toEqual(['good1', 'good2'])
  })

  // Regression (監査MINOR / silent card loss): a card carrying ONE malformed
  // attachment used to be dropped WHOLESALE — the bad element failed the inner
  // object → the attachments array failed → ProjectTaskSchema failed → this
  // field-level recovery filter (which keeps only individually-valid cards)
  // skipped it. The attachments field now sanitizes per-element, so the card
  // survives with its valid attachments intact.
  it('a card with ONE malformed attachment is NOT dropped — the bad attachment is sanitized, the card + valid attachments survive (happy path)', async () => {
    await seedRaw(
      dir,
      JSON.stringify({
        description: '',
        tasks: [
          {
            id: 'has-bad-attach',
            title: 'good + mime-less attachment',
            done: false,
            createdAt: 'x',
            boardColumn: 'todo',
            attachments: [
              { id: 'ok', name: 'shot.png', mime: 'image/png' },
              { id: 'broken', name: 'no mime here' }, // missing required `mime`
            ],
          },
          { id: 'plain', title: 'no attachments', done: false, createdAt: 'x', boardColumn: 'todo' },
        ],
        notes: '',
        updatedAt: 'x',
      }),
    )
    const out = await readProjectData(dir)
    // The whole-card silent loss this guards against: the card stays put.
    expect(out.tasks.map((t) => t.id).sort()).toEqual(['has-bad-attach', 'plain'])
    // Only the malformed attachment is sanitized away; the valid one is kept.
    const bad = out.tasks.find((t) => t.id === 'has-bad-attach')!
    expect(bad.attachments).toEqual([{ id: 'ok', name: 'shot.png', mime: 'image/png' }])
  })

  it('field-recovery branch: a malformed-attachment card is KEPT (sanitized) while a genuinely-invalid card still drops', async () => {
    await seedRaw(
      dir,
      JSON.stringify({
        description: '',
        tasks: [
          {
            id: 'bad-attach',
            title: 'one good + one mime-less attachment',
            done: false,
            createdAt: 'x',
            boardColumn: 'todo',
            attachments: [
              { id: 'ok', name: 'a.png', mime: 'image/png' },
              { id: 'broken', name: 'no mime' }, // missing required `mime`
            ],
          },
          // No id → fails ProjectTaskSchema → the WHOLE-FILE schema fails → the
          // lossy field-level recovery branch runs (the exact path that used to
          // silently drop the malformed-attachment card alongside this one).
          { title: 'genuinely invalid — no id', done: false },
        ],
        notes: '',
        updatedAt: 'x',
      }),
    )
    const out = await readProjectData(dir)
    // The malformed-attachment card survives the recovery filter (sanitized);
    // only the genuinely-invalid card is dropped.
    expect(out.tasks.map((t) => t.id)).toEqual(['bad-attach'])
    expect(out.tasks[0].attachments).toEqual([{ id: 'ok', name: 'a.png', mime: 'image/png' }])
  })

  // Sibling-field hardening (差し戻し MUST_FIX): the same silent-card-loss hole
  // existed on every UNGUARDED optional field, not just attachments. A junk
  // boardColumn / notes / assignee used to fail ProjectTaskSchema → drop the card.
  it('a card with a junk boardColumn survives and falls back to "todo" (not dropped)', async () => {
    await seedRaw(
      dir,
      JSON.stringify({
        description: '',
        tasks: [
          { id: 'bad-col', title: 'junk column', done: false, createdAt: 'x', boardColumn: 'nonsense' },
          { id: 'ok', title: 'fine', done: false, createdAt: 'x', boardColumn: 'doing' },
        ],
        notes: '',
        updatedAt: 'x',
      }),
    )
    const out = await readProjectData(dir)
    expect(out.tasks.map((t) => t.id).sort()).toEqual(['bad-col', 'ok'])
    expect(out.tasks.find((t) => t.id === 'bad-col')!.boardColumn).toBe('todo')
    expect(out.tasks.find((t) => t.id === 'ok')!.boardColumn).toBe('doing')
  })

  it('the junk-boardColumn card SURVIVES a write→read round-trip (proves the "todo" fallback is stable, not a one-read reprieve)', async () => {
    await seedRaw(
      dir,
      JSON.stringify({
        description: '',
        tasks: [{ id: 'bad-col', title: 'junk column', done: false, createdAt: 'x', boardColumn: 'nonsense' }],
        notes: '',
        updatedAt: 'x',
      }),
    )
    // First read sanitizes 'nonsense' → 'todo'; persist that back…
    const first = await readProjectData(dir)
    expect(first.tasks.map((t) => t.id)).toEqual(['bad-col'])
    expect(first.tasks[0].boardColumn).toBe('todo')
    await writeProjectData(dir, first)
    // …and read AGAIN. A .catch(undefined) here would have dropped boardColumn on
    // the write, and dropLegacyNonBoardTasks would then filter the card out as a
    // non-board entry on this second read (kind + boardColumn both absent). The
    // 'todo' fallback keeps the card across write cycles, for good.
    const second = await readProjectData(dir)
    expect(second.tasks.map((t) => t.id)).toEqual(['bad-col'])
    expect(second.tasks[0].boardColumn).toBe('todo')
  })

  it('a card with junk notes / assignee survives — the fields drop, the card (and its title) stays', async () => {
    await seedRaw(
      dir,
      JSON.stringify({
        description: '',
        tasks: [
          {
            id: 'junk-meta',
            title: 'keeps its title',
            done: false,
            createdAt: 'x',
            boardColumn: 'todo',
            notes: 42, // not a string
            assignee: ['nope'], // not a string
          },
        ],
        notes: '',
        updatedAt: 'x',
      }),
    )
    const out = await readProjectData(dir)
    expect(out.tasks.map((t) => t.id)).toEqual(['junk-meta'])
    expect(out.tasks[0].title).toBe('keeps its title')
    expect(out.tasks[0].notes).toBeUndefined()
    expect(out.tasks[0].assignee).toBeUndefined()
  })
})

describe('writeProjectData — corrupt file is quarantined, never clobbered into oblivion', () => {
  let dir: string
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-pd-quar-'))
    await registerTestProject(dir)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    warn.mockRestore()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  const quarantineFiles = async (dataDir: string): Promise<string[]> =>
    (await readdir(dataDir)).filter((f) => f.startsWith('tasks.corrupt-') && f.endsWith('.json'))

  it('a write over a corrupt tasks.json preserves the original bytes in a sibling quarantine', async () => {
    const corrupt = '{ corrupt board data the user might want back ::: '
    const dataDir = await seedRaw(dir, corrupt)

    const saved = await writeProjectData(dir, data({ tasks: [card('fresh')] }))
    // The new write landed cleanly…
    expect(saved.tasks.map((t) => t.id)).toEqual(['fresh'])
    expect((await readProjectData(dir)).tasks.map((t) => t.id)).toEqual(['fresh'])

    // …and the corrupt original was moved aside, not destroyed.
    const quarantined = await quarantineFiles(dataDir)
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(dataDir, quarantined[0]), 'utf8')).toBe(corrupt)
  })

  it('a CAS write over a corrupt file still quarantines (corrupt ⇒ no stamp ⇒ first-write semantics)', async () => {
    const corrupt = 'not json at all'
    const dataDir = await seedRaw(dir, corrupt)
    // A corrupt file has no readable updatedAt token, so even a CAS-guarded write
    // proceeds (it can't have been "changed since" a token that never existed) —
    // and it must quarantine, not clobber.
    const saved = await writeProjectData(dir, data({ tasks: [card('x')] }), {
      expectUpdatedAt: 'some-stale-token',
    })
    expect(saved.tasks).toHaveLength(1)
    const quarantined = await quarantineFiles(dataDir)
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(dataDir, quarantined[0]), 'utf8')).toBe(corrupt)
  })

  it('a normal (valid) file is NOT quarantined — no churn on the happy path', async () => {
    const dataDir = await seedRaw(
      dir,
      JSON.stringify({ description: '', tasks: [], notes: '', updatedAt: '2026-06-30T00:00:00.000Z' }),
    )
    await writeProjectData(dir, data({ tasks: [card('a')] }))
    expect(await quarantineFiles(dataDir)).toEqual([])
  })

  it('round-trips after recovery: the quarantined data does not resurrect on later reads', async () => {
    const dataDir = await seedRaw(dir, 'garbage{')
    await writeProjectData(dir, data({ tasks: [card('only')] }))
    // Subsequent reads see ONLY the fresh data; the quarantine sibling is inert.
    const out = await readProjectData(dir)
    expect(out.tasks.map((t) => t.id)).toEqual(['only'])
    expect((await quarantineFiles(dataDir))).toHaveLength(1)
  })
})

// Goal condition (1), durability: tasks.json is the user's irreplaceable work
// data, so writeProjectData must request a DURABLE (fsync'd) write — proven by
// spying on the shared FileHandle prototype's `sync` (calls through, so the real
// fsync still happens). This is the wiring proof that the atomicWrite fsync
// capability is actually engaged for board saves.
describe('writeProjectData — tasks.json is written durably (fsync)', () => {
  let dir: string
  let syncSpy: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-pd-fsync-'))
    await registerTestProject(dir)
    const probe = await open(join(dir, '.fsync-probe'), 'w')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncSpy = vi.spyOn(Object.getPrototypeOf(probe) as any, 'sync')
    await probe.close()
    await rm(join(dir, '.fsync-probe'), { force: true })
    syncSpy.mockClear()
  })
  afterEach(async () => {
    syncSpy.mockRestore()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('fsyncs on a board save', async () => {
    await writeProjectData(dir, data({ tasks: [card('a')] }))
    expect(syncSpy).toHaveBeenCalled()
  })
})
