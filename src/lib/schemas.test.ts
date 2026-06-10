import { describe, it, expect } from 'vitest'
import { ProjectDataSchema, ProjectTaskSchema } from './schemas'

describe('ProjectDataSchema (loose recovery shape)', () => {
  it('accepts an empty default object', () => {
    const r = ProjectDataSchema.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.tasks).toEqual([])
      expect(r.data.notes).toBe('')
    }
  })

  it('accepts the legacy shape (milestones/goals fields present) and strips them', () => {
    const r = ProjectDataSchema.safeParse({
      description: '',
      tasks: [],
      milestones: [{ id: 'm1', name: 'thing', dueDate: null, createdAt: '' }],
      goals: [{ id: 'g1', title: 'Build login', status: 'draft' }],
      notes: '',
      updatedAt: '',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      // The data layer no longer knows these fields — zod strips them so they
      // vanish on the next write.
      expect('milestones' in r.data).toBe(false)
      expect('goals' in r.data).toBe(false)
    }
  })

  it('rejects when tasks is not an array', () => {
    const r = ProjectDataSchema.safeParse({ tasks: 'not-an-array' })
    expect(r.success).toBe(false)
  })
})

describe('ProjectTaskSchema (legacy field stripping)', () => {
  it('accepts a legacy task and strips legacy keys', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'do thing',
      done: false,
      // Legacy on-disk fields — must parse (stripped), not reject.
      kind: 'board',
      milestoneId: null,
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect('kind' in r.data).toBe(false)
      expect('milestoneId' in r.data).toBe(false)
    }
  })

  it('strips the batch-run-era fields (latestRun / agentSessionId / transcriptRef / activeSkill)', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'do thing',
      done: true,
      createdAt: '2026-01-01T00:00:00Z',
      activeSkill: 'frontend-design',
      agentSessionId: 'sess-abc',
      latestRun: {
        kind: 'review',
        topic: 'auth refactor',
        summary: 'rewired login',
        blockers: '',
        sessionId: 'sess-abc',
        finishedAt: '2026-01-02T00:00:00Z',
      },
      transcriptRef: {
        sessionId: 'sess-abc',
        cwd: '/Users/me/projects/app',
        jsonlPath: '/Users/me/.claude/projects/app/sess-abc.jsonl',
      },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect('latestRun' in r.data).toBe(false)
      expect('agentSessionId' in r.data).toBe(false)
      expect('transcriptRef' in r.data).toBe(false)
      expect('activeSkill' in r.data).toBe(false)
    }
  })

  it('keeps the surviving board fields intact', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'x',
      notes: 'memo',
      done: false,
      createdAt: '2026-01-01T00:00:00Z',
      boardColumn: 'doing',
      boardOrder: 2,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.boardColumn).toBe('doing')
      expect(r.data.boardOrder).toBe(2)
      expect(r.data.notes).toBe('memo')
    }
  })
})
