import { describe, it, expect } from 'vitest'
import { ProjectDataSchema, ProjectTaskSchema, FeedbackApiBodySchema } from './schemas'

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

describe('FeedbackApiBodySchema (inline image attachments)', () => {
  it('accepts a message with no images (images defaults to [])', () => {
    const r = FeedbackApiBodySchema.safeParse({ message: 'hi' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.images).toEqual([])
  })

  it('accepts valid inline images', () => {
    const r = FeedbackApiBodySchema.safeParse({
      message: 'see screenshot',
      images: [
        { mime: 'image/webp', data: 'AAAA' },
        { name: 'shot.png', mime: 'image/png', data: 'Zm9v' },
      ],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.images).toHaveLength(2)
  })

  it('rejects an unsupported image mime', () => {
    const r = FeedbackApiBodySchema.safeParse({
      message: 'x',
      images: [{ mime: 'image/svg+xml', data: 'AAAA' }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects a data-URL prefix in the base64 (bare base64 only)', () => {
    const r = FeedbackApiBodySchema.safeParse({
      message: 'x',
      images: [{ mime: 'image/webp', data: 'data:image/webp;base64,AAAA' }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects more than the per-submission image cap (6)', () => {
    const r = FeedbackApiBodySchema.safeParse({
      message: 'x',
      images: Array.from({ length: 7 }, () => ({ mime: 'image/webp', data: 'AAAA' })),
    })
    expect(r.success).toBe(false)
  })

  it('rejects a single image over the per-image size cap', () => {
    const tooBig = 'A'.repeat(3_600_000) // > 3.5MB base64 per-image cap
    const r = FeedbackApiBodySchema.safeParse({
      message: 'x',
      images: [{ mime: 'image/webp', data: tooBig }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects images whose combined size exceeds the total cap', () => {
    const big = 'A'.repeat(3_000_000) // 3MB each (under per-image cap)
    const r = FeedbackApiBodySchema.safeParse({
      message: 'x',
      images: [
        { mime: 'image/webp', data: big },
        { mime: 'image/webp', data: big },
        { mime: 'image/webp', data: big },
      ], // 9MB combined > 8MB total cap
    })
    expect(r.success).toBe(false)
  })
})
