import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readProjectData, writeProjectData } from './projectData'
import { projectDataDir } from './projectDataPath'
import { registerTestProject } from '../../test/registerProject'

// Tasks are ONLY board cards now. Legacy disk data still carries the old
// `kind` discriminator ('board' | 'chat' | 'assistant') and kind-less entries
// from before the split. The read path must silently DROP everything that
// isn't a board card — no migration write, they just vanish on the next save.

const seedTasksJson = async (dir: string, payload: unknown) => {
  const dataDir = await projectDataDir(dir)
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'tasks.json'), JSON.stringify(payload), 'utf8')
}

describe('readProjectData — legacy kind/chat/assistant tasks are dropped', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-pd-'))
    await registerTestProject(dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps board cards, drops chat/assistant and kind-less chats', async () => {
    await seedTasksJson(dir, {
      description: '',
      tasks: [
        // kind:'board' → keep
        { id: 'b1', title: 'Board card', kind: 'board', done: false, milestoneId: null, createdAt: 'x', boardColumn: 'doing' },
        // legacy chat → drop
        { id: 'c1', title: 'Old chat', kind: 'chat', done: false, milestoneId: null, createdAt: 'x' },
        // the old assistant conversation → drop
        { id: 'a1', title: 'Assistant', kind: 'assistant', done: false, milestoneId: null, createdAt: 'x' },
        // kind-absent WITH boardColumn → legacy board card → keep
        { id: 'b2', title: 'Pre-split board card', done: true, milestoneId: null, createdAt: 'x', boardColumn: 'done' },
        // kind-absent WITHOUT boardColumn → legacy chat → drop
        { id: 'c2', title: 'Pre-split chat', done: false, milestoneId: null, createdAt: 'x' },
      ],
      milestones: [{ id: 'm1', name: 'old milestone', dueDate: null, createdAt: 'x' }],
      goals: [{ id: 'g1', title: 'old goal', description: '', completionCriteria: '', status: 'draft', createdAt: '', updatedAt: '' }],
      notes: '',
      updatedAt: 'x',
    })

    const data = await readProjectData(dir)
    expect(data.tasks.map(t => t.id).sort()).toEqual(['b1', 'b2'])
    // Legacy per-task fields are stripped by the schema.
    for (const t of data.tasks) {
      expect('kind' in t).toBe(false)
      expect('milestoneId' in t).toBe(false)
    }
    // The old goals/milestones sections are gone from the read shape entirely.
    expect('milestones' in data).toBe(false)
    expect('goals' in data).toBe(false)
  })

  it('a kept board card without boardColumn gets one materialized (stable across writes)', async () => {
    await seedTasksJson(dir, {
      description: '',
      tasks: [{ id: 'b1', title: 'Board, no column', kind: 'board', done: false, milestoneId: null, createdAt: 'x' }],
      notes: '',
      updatedAt: 'x',
    })
    const first = await readProjectData(dir)
    expect(first.tasks).toHaveLength(1)
    expect(first.tasks[0].boardColumn).toBe('todo')
    // Round-trip: after a write (which persists the schema-stripped shape,
    // i.e. no `kind` anymore) the card must STILL be there on the next read.
    await writeProjectData(dir, first)
    const second = await readProjectData(dir)
    expect(second.tasks.map(t => t.id)).toEqual(['b1'])
  })

  it('legacy fields vanish from disk on the next write (no migration code)', async () => {
    await seedTasksJson(dir, {
      description: '',
      tasks: [
        { id: 'b1', title: 'Board', kind: 'board', done: false, milestoneId: null, createdAt: 'x', boardColumn: 'todo' },
        { id: 'c1', title: 'Chat', kind: 'chat', done: false, milestoneId: null, createdAt: 'x' },
      ],
      milestones: [],
      goals: [],
      notes: '',
      updatedAt: 'x',
    })
    const data = await readProjectData(dir)
    await writeProjectData(dir, data)
    const raw = JSON.parse(
      await readFile(join(await projectDataDir(dir), 'tasks.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(raw.milestones).toBeUndefined()
    expect(raw.goals).toBeUndefined()
    const tasks = raw.tasks as Array<Record<string, unknown>>
    expect(tasks.map(t => t.id)).toEqual(['b1'])
    expect(tasks[0].kind).toBeUndefined()
    expect(tasks[0].milestoneId).toBeUndefined()
  })
})
