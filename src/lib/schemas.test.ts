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

  // Regression: a single malformed attachment must NOT take the whole card down.
  // Before this guard the bad element failed the inner object → the array failed
  // → ProjectTaskSchema failed → readProjectData's field-level recovery dropped
  // the card WHOLESALE (silent card loss). Now broken entries are sanitized away
  // per-element and the card (with its valid attachments) survives.
  it('sanitizes a malformed attachment per-element — drops only the broken entry, keeps the card + valid attachments', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'mixed attachments',
      done: false,
      createdAt: 'x',
      attachments: [
        { id: 'a1', name: 'good.png', mime: 'image/png' },
        { id: 'a2', name: 'broken — no mime' }, // missing required `mime`
        { id: '', name: 'broken — empty id', mime: 'image/png' }, // id.min(1) fails
      ],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.attachments).toEqual([{ id: 'a1', name: 'good.png', mime: 'image/png' }])
    }
  })

  it('keeps a valid attachments array untouched (the happy path is unaffected)', () => {
    const atts = [
      { id: 'a1', name: 'one.png', mime: 'image/png' },
      { id: 'a2', name: 'two.webp', mime: 'image/webp' },
    ]
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'good attachments',
      done: false,
      createdAt: 'x',
      attachments: atts,
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.attachments).toEqual(atts)
  })

  it('keeps the card when attachments is a non-array junk value (field drops, card survives)', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'junk attachments',
      done: false,
      createdAt: 'x',
      attachments: 'not-an-array',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.attachments).toBeUndefined()
  })

  it('keeps the card when prUrl / branch / reviewedBy / dependsOn carry junk values', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'junk metadata',
      done: false,
      createdAt: 'x',
      prUrl: 123, // not a string
      branch: { not: 'a string' },
      reviewedBy: ['nope'],
      dependsOn: 'should-be-an-array',
    })
    // None of these optional metadata fields may drop the card — each falls back
    // to undefined individually (the drop-the-field-never-the-card contract).
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.prUrl).toBeUndefined()
      expect(r.data.branch).toBeUndefined()
      expect(r.data.reviewedBy).toBeUndefined()
      expect(r.data.dependsOn).toBeUndefined()
    }
  })

  it('falls a junk boardColumn back to "todo" (NOT undefined) so the card stays a board card across writes', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'bad column',
      done: false,
      createdAt: 'x',
      boardColumn: 'nonsense-column', // not in the enum
    })
    expect(r.success).toBe(true)
    // 'todo' (NOT undefined): readProjectData's dropLegacyNonBoardTasks keys
    // "still a board card?" off a non-null boardColumn, so undefined would get
    // the card dropped on the NEXT read. 'todo' keeps it put.
    if (r.success) expect(r.data.boardColumn).toBe('todo')
  })

  it('leaves a valid boardColumn untouched (the catch only fires on junk)', () => {
    for (const col of ['todo', 'doing', 'review', 'done', 'blocked'] as const) {
      const r = ProjectTaskSchema.safeParse({ id: 't1', title: 'x', done: false, createdAt: 'x', boardColumn: col })
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.boardColumn).toBe(col)
    }
  })

  it('keeps the card when notes / assignee / boardOrder carry junk values (field drops, card survives)', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'junk board metadata',
      done: false,
      createdAt: 'x',
      notes: 42, // not a string — was a silent-card-loss hole before
      assignee: { not: 'a string' },
      boardOrder: 'not-a-number',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.notes).toBeUndefined()
      expect(r.data.assignee).toBeUndefined()
      expect(r.data.boardOrder).toBeUndefined()
    }
  })

  it('keeps the card when titleAuto / integrationConflict / selfSupplyKey / selfSupplyApproved carry junk values', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'junk flags',
      done: false,
      createdAt: 'x',
      titleAuto: 'yes', // not a boolean
      integrationConflict: 1, // not a boolean
      selfSupplyKey: { not: 'a string' },
      selfSupplyApproved: 'true', // not a boolean
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.titleAuto).toBeUndefined()
      expect(r.data.integrationConflict).toBeUndefined()
      expect(r.data.selfSupplyKey).toBeUndefined()
      expect(r.data.selfSupplyApproved).toBeUndefined()
    }
  })

  // Regression (audit NIT follow-up to the per-element attachments sweep):
  // createdAt was the LAST optional field still on a bare .default('') — and
  // .default only fills in `undefined`, so a non-string value (a number, an
  // object — a hand-edited / git-shared card) failed z.string() →
  // ProjectTaskSchema failed → readProjectData's filterValid dropped the card
  // WHOLESALE (silent card loss). .catch('') falls a junk value back to '' so
  // the card body survives, matching the optional metadata above.
  it('keeps the card when createdAt is a non-string junk value (number/object/etc) — falls back to "" so the card survives', () => {
    for (const junk of [42, { not: 'a string' }, ['nope'], true, null]) {
      const r = ProjectTaskSchema.safeParse({
        id: 't1',
        title: 'junk createdAt',
        done: false,
        createdAt: junk,
      })
      // Survival (NOT a drop): readProjectData's filterValid keeps exactly the
      // tasks whose ProjectTaskSchema.safeParse succeeds, so .success === true
      // here is precisely "the card is NOT dropped on read".
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.createdAt).toBe('')
    }
  })

  it('preserves a valid ISO-string createdAt unchanged (the catch only fires on a non-string)', () => {
    const r = ProjectTaskSchema.safeParse({
      id: 't1',
      title: 'good createdAt',
      done: false,
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.createdAt).toBe('2026-01-01T00:00:00Z')
  })

  it('still defaults a missing createdAt to "" (the .default applies for undefined)', () => {
    const r = ProjectTaskSchema.safeParse({ id: 't1', title: 'no createdAt', done: false })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.createdAt).toBe('')
  })

  // The whole point of the fix: in a MIXED tasks array a card carrying a junk
  // createdAt is no longer the one rotten apple silently dropped on read. This
  // mirrors readProjectData's filterValid (keep the elements whose
  // ProjectTaskSchema.safeParse succeeds) without importing the server layer —
  // a genuinely-broken card (no id) still drops, the junk-createdAt one lives.
  it('survives in a mixed tasks array — a junk-createdAt card is kept alongside good cards, only the genuinely-broken (no id) card drops', () => {
    const tasks: unknown[] = [
      { id: 'good', title: 'fine', done: false, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'junkdate', title: 'junk createdAt', done: false, createdAt: 42 },
      { title: 'no id — genuinely broken', done: false }, // identity missing → must drop
    ]
    const kept = tasks.flatMap(t => {
      const r = ProjectTaskSchema.safeParse(t)
      return r.success ? [r.data] : []
    })
    expect(kept.map(t => t.id)).toEqual(['good', 'junkdate'])
    // The recovered junk-createdAt card kept its body and got the '' fallback.
    expect(kept.find(t => t.id === 'junkdate')?.createdAt).toBe('')
  })

  it('still REJECTS a card whose identity fields (id/title/done) are malformed — those are not droppable metadata', () => {
    // The card's identity must still gate survival; otherwise field-level
    // recovery would resurrect genuinely-broken entries. (Teeth: proves the
    // .catch sweep did not over-reach into the required fields.)
    expect(ProjectTaskSchema.safeParse({ title: 'no id', done: false }).success).toBe(false)
    expect(ProjectTaskSchema.safeParse({ id: 't', done: false }).success).toBe(false) // no title
    expect(ProjectTaskSchema.safeParse({ id: 't', title: 'x' }).success).toBe(false) // no done
    expect(ProjectTaskSchema.safeParse({ id: 't', title: 'x', done: 'nope' }).success).toBe(false) // done not bool
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
