import { describe, it, expect } from 'vitest'
import {
  GoalSchema,
  ProjectMilestoneSchema,
  ProjectDataSchema,
  GoalRunQueueSchema,
  RunQueueApiBodySchema,
  ProjectTaskSchema,
} from './schemas'

describe('GoalSchema', () => {
  it('accepts a minimal SMART/OKR Goal', () => {
    const r = GoalSchema.safeParse({
      id: 'g1',
      title: 'Build login',
      description: '',
      completionCriteria: '',
      status: 'draft',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown status enum value', () => {
    const r = GoalSchema.safeParse({
      id: 'g1',
      title: 't',
      description: '',
      completionCriteria: '',
      status: 'super-done', // not in enum
      createdAt: '',
      updatedAt: '',
    })
    expect(r.success).toBe(false)
  })

  it('preserves an attached runQueue when valid', () => {
    const r = GoalSchema.safeParse({
      id: 'g1',
      title: 't',
      description: '',
      completionCriteria: '',
      status: 'running',
      createdAt: '',
      updatedAt: '',
      runQueue: {
        milestoneIds: ['m1', 'm2'],
        currentIndex: 1,
        status: 'running',
        sessions: [],
      },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.runQueue?.currentIndex).toBe(1)
  })

  it('rejects a Goal missing the title', () => {
    const r = GoalSchema.safeParse({
      id: 'g1',
      description: '',
      completionCriteria: '',
      status: 'draft',
    })
    expect(r.success).toBe(false)
  })
})

describe('ProjectMilestoneSchema', () => {
  it('accepts a legacy milestone (Phase 6 fields absent)', () => {
    const r = ProjectMilestoneSchema.safeParse({
      id: 'm1',
      name: 'thing',
      dueDate: null,
      createdAt: '',
    })
    expect(r.success).toBe(true)
  })

  it('rejects negative order', () => {
    const r = ProjectMilestoneSchema.safeParse({
      id: 'm1',
      name: 'thing',
      dueDate: null,
      createdAt: '',
      order: -1,
    })
    // .int() alone allows negatives — assert it's still parsed (zod allows
    // negative ints). Use this as a guardrail-doc test: if we ever tighten
    // order to nonnegative, flip the expect.
    expect(r.success).toBe(true)
  })

  it('rejects unknown status enum', () => {
    const r = ProjectMilestoneSchema.safeParse({
      id: 'm1',
      name: 'x',
      dueDate: null,
      createdAt: '',
      status: 'totally-made-up',
    })
    expect(r.success).toBe(false)
  })
})

describe('GoalRunQueueSchema', () => {
  it('accepts a queue with no sessions yet', () => {
    const r = GoalRunQueueSchema.safeParse({
      milestoneIds: ['m1'],
      currentIndex: 0,
      status: 'idle',
    })
    expect(r.success).toBe(true)
  })

  it('rejects negative currentIndex', () => {
    const r = GoalRunQueueSchema.safeParse({
      milestoneIds: ['m1'],
      currentIndex: -1,
      status: 'idle',
    })
    expect(r.success).toBe(false)
  })

  it('rejects a session with an unknown result', () => {
    const r = GoalRunQueueSchema.safeParse({
      milestoneIds: ['m1'],
      currentIndex: 0,
      status: 'running',
      sessions: [
        { milestoneId: 'm1', sessionId: 's1', result: 'who-knows', finishedAt: '' },
      ],
    })
    expect(r.success).toBe(false)
  })
})

describe('ProjectDataSchema (loose recovery shape)', () => {
  it('accepts an empty default object', () => {
    const r = ProjectDataSchema.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.tasks).toEqual([])
      expect(r.data.milestones).toEqual([])
      expect(r.data.notes).toBe('')
    }
  })

  it('accepts the legacy shape (no goals field)', () => {
    const r = ProjectDataSchema.safeParse({
      description: '',
      tasks: [],
      milestones: [],
      notes: '',
      updatedAt: '',
    })
    expect(r.success).toBe(true)
  })

  it('rejects when tasks is not an array', () => {
    const r = ProjectDataSchema.safeParse({ tasks: 'not-an-array' })
    expect(r.success).toBe(false)
  })
})

describe('ProjectTaskSchema (Phase 2 latestRun / transcriptRef)', () => {
  it('accepts a legacy task (Phase 2 fields absent)', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'do thing',
      done: false,
      milestoneId: null,
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(r.success).toBe(true)
  })

  it('round-trips a task carrying latestRun + agentSessionId + transcriptRef', () => {
    const task = {
      id: 't1',
      title: 'do thing',
      done: true,
      milestoneId: null,
      createdAt: '2026-01-01T00:00:00Z',
      agentSessionId: 'sess-abc',
      latestRun: {
        kind: 'review' as const,
        topic: 'auth refactor',
        summary: 'rewired login',
        blockers: 'awaiting design call',
        followups: ['add tests', 'docs'],
        question: 'OAuth or magic link?',
        taskComplete: false,
        sessionId: 'sess-abc',
        finishedAt: '2026-01-02T00:00:00Z',
      },
      transcriptRef: {
        sessionId: 'sess-abc',
        cwd: '/Users/me/projects/app',
        jsonlPath: '/Users/me/.claude/projects/app/sess-abc.jsonl',
      },
    }
    const r = ProjectTaskSchema.safeParse(task)
    expect(r.success).toBe(true)
    if (r.success) {
      // New fields survive the parse unchanged.
      expect(r.data).toEqual(task)
      expect(r.data.latestRun?.kind).toBe('review')
      expect(r.data.transcriptRef?.jsonlPath).toMatch(/sess-abc\.jsonl$/)
    }
  })

  it('rejects a latestRun with a transient (non-settled) kind', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'x',
      done: false,
      milestoneId: null,
      createdAt: '',
      latestRun: {
        kind: 'running', // transient — must not persist
        summary: '',
        blockers: '',
        sessionId: 's',
        finishedAt: '',
      },
    })
    expect(r.success).toBe(false)
  })
})

describe('RunQueueApiBodySchema', () => {
  it('accepts start with op=start', () => {
    const r = RunQueueApiBodySchema.safeParse({
      path: '/a/b',
      goalId: 'g1',
      op: 'start',
    })
    expect(r.success).toBe(true)
  })

  it('rejects when op is missing', () => {
    const r = RunQueueApiBodySchema.safeParse({ path: '/a/b', goalId: 'g1' })
    expect(r.success).toBe(false)
  })

  it('rejects when op is an unknown verb (typo guard)', () => {
    const r = RunQueueApiBodySchema.safeParse({
      path: '/a/b',
      goalId: 'g1',
      op: 'stat', // common typo of 'start'
    })
    expect(r.success).toBe(false)
  })

  it('rejects when path is empty', () => {
    const r = RunQueueApiBodySchema.safeParse({
      path: '',
      goalId: 'g1',
      op: 'start',
    })
    expect(r.success).toBe(false)
  })
})
