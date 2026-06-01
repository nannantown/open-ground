import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RunEntry, RunSession, ProjectData, ProjectTask } from '../types'
import {
  buildTaskRunSummary,
  taskRunKind,
  persistTaskRunSummaries,
  migrateRunSessionToLatestRun,
} from './taskRunSummary'

const makeEntry = (over: Partial<RunEntry> = {}): RunEntry => ({
  projectId: 'p1',
  projectName: 'Proj',
  projectPath: '/tmp/x',
  status: 'done',
  log: '',
  targetedTasks: [{ id: 't1', title: 'Task one', milestoneName: null }],
  agentSessionId: 'sess-abc',
  finishedAt: '2026-05-29T10:00:00.000Z',
  parsedResult: {
    completed: ['did it'],
    skipped: [],
    summary: 'summary text',
    blockers: '',
    taskComplete: true,
    topic: 'topic line',
  },
  ...over,
})

const writeTasks = async (dir: string, tasks: ProjectTask[]) => {
  await mkdir(join(dir, '.openground'), { recursive: true })
  const data: ProjectData = {
    description: '',
    tasks,
    milestones: [],
    goals: [],
    notes: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  await writeFile(join(dir, '.openground', 'tasks.json'), JSON.stringify(data), 'utf8')
}

const readTasks = async (dir: string): Promise<ProjectData> =>
  JSON.parse(await readFile(join(dir, '.openground', 'tasks.json'), 'utf8'))

describe('taskRunKind', () => {
  it('done task → done', () => {
    expect(taskRunKind(makeEntry())).toBe('done')
  })
  it('done with taskComplete:false (followups) → review', () => {
    const e = makeEntry({
      parsedResult: { completed: [], skipped: [], summary: 's', blockers: '', taskComplete: false },
    })
    expect(taskRunKind(e)).toBe('review')
  })
  it('error + overloaded → overloaded', () => {
    expect(taskRunKind(makeEntry({ status: 'error', overloaded: true, parsedResult: null }))).toBe('overloaded')
  })
  it('error → error', () => {
    expect(taskRunKind(makeEntry({ status: 'error', parsedResult: null }))).toBe('error')
  })
  it('cancelled → cancelled', () => {
    expect(taskRunKind(makeEntry({ status: 'cancelled', parsedResult: null }))).toBe('cancelled')
  })
  it('done but mergeStatus merging → folds to done', () => {
    expect(taskRunKind(makeEntry({ mergeStatus: 'merging' }))).toBe('done')
  })
})

describe('buildTaskRunSummary', () => {
  it('carries narrative + sessionId + finishedAt', () => {
    const s = buildTaskRunSummary(makeEntry())
    expect(s).toMatchObject({
      kind: 'done',
      topic: 'topic line',
      summary: 'summary text',
      blockers: '',
      taskComplete: true,
      sessionId: 'sess-abc',
      finishedAt: '2026-05-29T10:00:00.000Z',
    })
  })
})

describe('persistTaskRunSummaries', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-trs-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes latestRun/agentSessionId/transcriptRef onto the targeted task', async () => {
    await writeTasks(dir, [
      { id: 't1', title: 'Task one', done: false, milestoneId: null, createdAt: 'x' },
      { id: 't2', title: 'Other', done: false, milestoneId: null, createdAt: 'x' },
    ])
    await persistTaskRunSummaries(makeEntry({ projectPath: dir }), dir)
    const data = await readTasks(dir)
    const t1 = data.tasks.find(t => t.id === 't1')!
    const t2 = data.tasks.find(t => t.id === 't2')!
    expect(t1.latestRun?.kind).toBe('done')
    expect(t1.latestRun?.summary).toBe('summary text')
    expect(t1.agentSessionId).toBe('sess-abc')
    expect(t1.transcriptRef?.sessionId).toBe('sess-abc')
    expect(t1.transcriptRef?.jsonlPath).toContain('sess-abc.jsonl')
    // Untargeted task untouched.
    expect(t2.latestRun).toBeUndefined()
  })

  it('drops a run whose targeted task no longer exists', async () => {
    await writeTasks(dir, [
      { id: 'kept', title: 'Kept', done: false, milestoneId: null, createdAt: 'x' },
    ])
    await persistTaskRunSummaries(
      makeEntry({ projectPath: dir, targetedTasks: [{ id: 'gone', title: 'Gone', milestoneName: null }] }),
      dir,
    )
    const data = await readTasks(dir)
    expect(data.tasks).toHaveLength(1)
    expect(data.tasks[0].latestRun).toBeUndefined()
  })

  it('finishedAt-newer-wins: does not clobber a newer existing summary', async () => {
    await writeTasks(dir, [
      {
        id: 't1',
        title: 'Task one',
        done: false,
        milestoneId: null,
        createdAt: 'x',
        latestRun: {
          kind: 'done',
          summary: 'NEWER summary',
          blockers: '',
          sessionId: 'sess-new',
          finishedAt: '2026-05-29T12:00:00.000Z',
        },
        agentSessionId: 'sess-new',
      },
    ])
    // This run finished EARLIER than the stored one.
    await persistTaskRunSummaries(
      makeEntry({ projectPath: dir, finishedAt: '2026-05-29T10:00:00.000Z' }),
      dir,
    )
    const data = await readTasks(dir)
    expect(data.tasks[0].latestRun?.summary).toBe('NEWER summary')
    expect(data.tasks[0].agentSessionId).toBe('sess-new')
  })

  it('overwrites when this run is newer', async () => {
    await writeTasks(dir, [
      {
        id: 't1',
        title: 'Task one',
        done: false,
        milestoneId: null,
        createdAt: 'x',
        latestRun: {
          kind: 'cancelled',
          summary: 'OLD',
          blockers: '',
          sessionId: 'sess-old',
          finishedAt: '2026-05-29T08:00:00.000Z',
        },
      },
    ])
    await persistTaskRunSummaries(
      makeEntry({ projectPath: dir, finishedAt: '2026-05-29T10:00:00.000Z' }),
      dir,
    )
    const data = await readTasks(dir)
    expect(data.tasks[0].latestRun?.summary).toBe('summary text')
    expect(data.tasks[0].latestRun?.finishedAt).toBe('2026-05-29T10:00:00.000Z')
  })

  it('legacy task (no new fields) reads + persists without breaking', async () => {
    await writeTasks(dir, [
      { id: 't1', title: 'Legacy', done: false, milestoneId: null, createdAt: 'x' },
    ])
    await expect(
      persistTaskRunSummaries(makeEntry({ projectPath: dir }), dir),
    ).resolves.toBeUndefined()
    const data = await readTasks(dir)
    expect(data.tasks[0].latestRun).toBeDefined()
  })
})

describe('migrateRunSessionToLatestRun', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-mig-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const makeSession = (over: Partial<RunSession> = {}, entryOver: Partial<RunEntry> = {}): RunSession => ({
    id: 'run-1',
    startedAt: '2026-05-29T09:00:00.000Z',
    finishedAt: '2026-05-29T10:00:00.000Z',
    entries: [makeEntry({ projectPath: dir, ...entryOver })],
    ...over,
  })

  it('folds a settled run-file entry onto its targeted task', async () => {
    await writeTasks(dir, [
      { id: 't1', title: 'Task one', done: false, milestoneId: null, createdAt: 'x' },
    ])
    await migrateRunSessionToLatestRun(makeSession())
    const data = await readTasks(dir)
    expect(data.tasks[0].latestRun?.summary).toBe('summary text')
    expect(data.tasks[0].agentSessionId).toBe('sess-abc')
    expect(data.tasks[0].transcriptRef?.sessionId).toBe('sess-abc')
  })

  it('is idempotent — a second migrate of the same session is a no-op', async () => {
    await writeTasks(dir, [
      { id: 't1', title: 'Task one', done: false, milestoneId: null, createdAt: 'x' },
    ])
    await migrateRunSessionToLatestRun(makeSession())
    const first = await readTasks(dir)
    const firstSummary = first.tasks[0].latestRun
    await migrateRunSessionToLatestRun(makeSession())
    const second = await readTasks(dir)
    expect(second.tasks[0].latestRun).toEqual(firstSummary)
  })

  it('newer-wins: does not clobber a task whose latestRun is already newer', async () => {
    await writeTasks(dir, [
      {
        id: 't1',
        title: 'Task one',
        done: false,
        milestoneId: null,
        createdAt: 'x',
        latestRun: {
          kind: 'done',
          summary: 'NEWER',
          blockers: '',
          sessionId: 'sess-new',
          finishedAt: '2026-05-29T12:00:00.000Z',
        },
      },
    ])
    // run-file entry finished earlier than the stored summary.
    await migrateRunSessionToLatestRun(
      makeSession({ finishedAt: '2026-05-29T10:00:00.000Z' }, { finishedAt: '2026-05-29T10:00:00.000Z' }),
    )
    const data = await readTasks(dir)
    expect(data.tasks[0].latestRun?.summary).toBe('NEWER')
  })

  it('skips an unfinished entry (no finishedAt) — still-live, not migratable', async () => {
    await writeTasks(dir, [
      { id: 't1', title: 'Task one', done: false, milestoneId: null, createdAt: 'x' },
    ])
    await migrateRunSessionToLatestRun(
      makeSession({}, { status: 'running', finishedAt: undefined }),
    )
    const data = await readTasks(dir)
    expect(data.tasks[0].latestRun).toBeUndefined()
  })

  it('drops a run whose targeted task no longer exists', async () => {
    await writeTasks(dir, [
      { id: 'kept', title: 'Kept', done: false, milestoneId: null, createdAt: 'x' },
    ])
    await migrateRunSessionToLatestRun(
      makeSession({}, { targetedTasks: [{ id: 'gone', title: 'Gone', milestoneName: null }] }),
    )
    const data = await readTasks(dir)
    expect(data.tasks).toHaveLength(1)
    expect(data.tasks[0].latestRun).toBeUndefined()
  })
})
