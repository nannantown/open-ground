import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProjectData, ProjectTask } from '../types'
import {
  ProjectDataConflictError,
  mutateProjectData,
  readProjectData,
  writeProjectData,
} from './projectData'
import { registerTestProject } from '../../test/registerProject'

// CAS guard on writeProjectData (expectUpdatedAt): a writer holding a STALE
// snapshot must be refused instead of clobbering newer data. Born from a real
// incident (2026-06-10): a second app window still holding a pre-share empty
// board persisted it and deleted the freshly-shared card files. HOME is
// tmpdir-isolated by setup-home.ts.

const card = (id: string): ProjectTask => ({
  id,
  title: `Task ${id}`,
  done: false,
  createdAt: '2026-06-10T00:00:00.000Z',
  boardColumn: 'todo',
})

const data = (over: Partial<ProjectData> = {}): ProjectData => ({
  description: 'cas project',
  tasks: [],
  notes: '',
  updatedAt: '',
  ...over,
})

describe('writeProjectData — compare-and-swap on updatedAt', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-cas-'))
    await mkdir(dir, { recursive: true })
    await registerTestProject(dir)
  })

  it('first write passes with any expect token (no stored file yet)', async () => {
    const saved = await writeProjectData(dir, data({ tasks: [card('a')] }), {
      expectUpdatedAt: 'anything-goes-on-first-write',
    })
    expect(saved.tasks).toHaveLength(1)
  })

  it('matching token writes; stale token throws and leaves data intact', async () => {
    const first = await writeProjectData(dir, data({ tasks: [card('a')] }))
    // Fresh token → accepted.
    const second = await writeProjectData(
      dir,
      { ...first, tasks: [card('a'), card('b')] },
      { expectUpdatedAt: first.updatedAt },
    )
    expect(second.tasks).toHaveLength(2)
    // The OLD token (a snapshot from before `second`) → refused.
    await expect(
      writeProjectData(dir, data({ tasks: [] }), { expectUpdatedAt: first.updatedAt }),
    ).rejects.toBeInstanceOf(ProjectDataConflictError)
    // Nothing was clobbered.
    expect((await readProjectData(dir)).tasks).toHaveLength(2)
  })

  it('omitting the token keeps the old trusting behaviour', async () => {
    await writeProjectData(dir, data({ tasks: [card('a')] }))
    const overwritten = await writeProjectData(dir, data({ tasks: [] }))
    expect(overwritten.tasks).toHaveLength(0)
  })
})

describe('mutateProjectData — lock-scoped read-modify-write', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-rmw-'))
    await mkdir(dir, { recursive: true })
    await registerTestProject(dir)
  })

  it('serializes concurrent mutations so every one lands (no lost update)', async () => {
    const N = 12
    await writeProjectData(dir, data({ tasks: Array.from({ length: N }, (_, i) => card(`c${i}`)) }))

    // Fire N mutations at once, each moving a different card to 'review'. Reading
    // inside the lock means each loser sees the previous winner's write, so all
    // N moves persist — unlike a bare read→CAS-write, where stale losers would
    // throw ProjectDataConflictError and drop their move.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutateProjectData(dir, (d) => {
          const t = d.tasks.find((x) => x.id === `c${i}`)
          if (t) t.boardColumn = 'review'
        }),
      ),
    )

    const after = await readProjectData(dir)
    expect(after.tasks).toHaveLength(N)
    expect(after.tasks.every((t) => t.boardColumn === 'review')).toBe(true)
  })

  it('persists a replacement object returned by the mutator', async () => {
    await writeProjectData(dir, data({ tasks: [card('a')] }))
    const saved = await mutateProjectData(dir, (d) => ({ ...d, notes: 'hello' }))
    expect(saved.notes).toBe('hello')
    expect((await readProjectData(dir)).notes).toBe('hello')
  })

  it('rejects an unregistered path before mutating', async () => {
    await expect(
      mutateProjectData('/definitely/not/registered', () => {}),
    ).rejects.toBeTruthy()
  })
})
