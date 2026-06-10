import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProjectData, ProjectTask } from '../types'
import {
  ProjectDataConflictError,
  readProjectData,
  writeProjectData,
  migrateBoardToShared,
} from './projectData'
import { boardCardsDir } from './sharedData'
import { registerTestProject } from '../../test/registerProject'
import { readdir } from 'fs/promises'

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

  it('SHARED mode: the incident — a stale empty snapshot cannot delete card files', async () => {
    const seeded = await writeProjectData(dir, data({ tasks: [card('a')] }))
    const staleToken = seeded.updatedAt
    await migrateBoardToShared(dir)
    // A teammate / fresh window writes after the share (bumps the token).
    const current = await readProjectData(dir)
    await writeProjectData(
      dir,
      { ...current, tasks: [...current.tasks, card('b')] },
      { expectUpdatedAt: current.updatedAt },
    )
    // The stale window persists its PRE-share empty board → must be refused…
    await expect(
      writeProjectData(dir, data({ tasks: [], description: '', notes: '' }), {
        expectUpdatedAt: staleToken,
      }),
    ).rejects.toBeInstanceOf(ProjectDataConflictError)
    // …and both card files survive on disk.
    const files = await readdir(boardCardsDir(dir))
    expect(files.sort()).toEqual(['a.json', 'b.json'])
  })
})
