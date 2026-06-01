// Zod schemas for the on-disk + over-the-wire shapes that OPEN GROUND
// trusts the LEAST: tasks.json (claude can edit it despite the prompt
// telling it not to) and the bodies of mutation API routes (the dev
// server's wide-open localhost surface is fine for a single-user tool,
// but an honest-mistake malformed POST shouldn't be able to wedge the
// runner).
//
// Design rules:
//  - Schemas are loose where the codebase already was (optional fields,
//    empty arrays default, unknown extra fields ignored). Tightening them
//    would mean rejecting existing valid tasks.json files in the wild.
//  - `safe()` helpers are provided so callers can pick between "throw on
//    invalid" and "best-effort merge with the fallback". readProjectData
//    uses the latter so a single bad tasks.json doesn't crash the whole
//    cockpit.
//
// Important: these schemas have to track the TypeScript types in types.ts.
// `Static<typeof X>` would be the conventional way to enforce this; we keep
// it manual for now because the zod payloads are smaller than the type
// surface (most ParsedRunResult / RunEntry detail isn't user-editable).

import { z } from 'zod'

// ---- Goal + Milestone + RunQueue ------------------------------------------

export const ProjectMilestoneStatusSchema = z.enum([
  'pending',
  'in_progress',
  'verifying',
  'verified',
  'failed',
  'blocked',
])

export const ProjectMilestoneLastVerifySchema = z.object({
  passed: z.boolean(),
  commands: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  finishedAt: z.string().default(''),
  retryCount: z.number().int().nonnegative().default(0),
})

export const ProjectMilestoneSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  dueDate: z.string().nullable().default(null),
  createdAt: z.string().default(''),
  // Phase 6 optional fields:
  goalId: z.string().nullable().optional(),
  description: z.string().optional(),
  order: z.number().int().optional(),
  verifyCommands: z.array(z.string()).optional(),
  status: ProjectMilestoneStatusSchema.optional(),
  verifiedAt: z.string().optional(),
  lastVerify: ProjectMilestoneLastVerifySchema.optional(),
  lastRunSessionId: z.string().optional(),
})

export const GoalRunQueueStatusSchema = z.enum([
  'idle',
  'running',
  'paused',
  'completed',
  'failed',
])

export const GoalRunQueueSessionSchema = z.object({
  milestoneId: z.string(),
  sessionId: z.string(),
  result: z.enum(['verified', 'failed', 'cancelled']),
  finishedAt: z.string(),
})

export const GoalRunQueueSchema = z.object({
  milestoneIds: z.array(z.string()),
  currentIndex: z.number().int().nonnegative(),
  status: GoalRunQueueStatusSchema,
  startedAt: z.string().optional(),
  lastActivityAt: z.string().optional(),
  sessions: z.array(GoalRunQueueSessionSchema).optional(),
})

export const GoalStatusSchema = z.enum([
  'draft',
  'planning',
  'running',
  'blocked',
  'done',
])

export const GoalSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().default(''),
  completionCriteria: z.string().default(''),
  outcome: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
  status: GoalStatusSchema,
  createdAt: z.string().default(''),
  updatedAt: z.string().default(''),
  runQueue: GoalRunQueueSchema.optional(),
})

// ---- ProjectTask + ProjectData --------------------------------------------

export const TaskImageSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  addedAt: z.string(),
})

// Phase 2: persisted task-run summary + transcript pointer. `kind` mirrors the
// settled subset of RunKind (runStatus.ts) — transient states never persist.
export const TaskRunSummarySchema = z.object({
  kind: z.enum(['done', 'review', 'skipped', 'error', 'overloaded', 'cancelled']),
  topic: z.string().optional(),
  summary: z.string(),
  blockers: z.string(),
  decisions: z.array(z.string()).optional(),
  followups: z.array(z.string()).optional(),
  question: z.string().optional(),
  taskComplete: z.boolean().optional(),
  sessionId: z.string(),
  finishedAt: z.string(),
})

export const TranscriptRefSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  jsonlPath: z.string(),
})

export const ProjectTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  done: z.boolean(),
  milestoneId: z.string().nullable(),
  createdAt: z.string().default(''),
  images: z.array(TaskImageSchema).optional(),
  activeSkill: z.string().nullable().optional(),
  // Phase 2 optional fields (backward compatible):
  latestRun: TaskRunSummarySchema.optional(),
  agentSessionId: z.string().optional(),
  transcriptRef: TranscriptRefSchema.optional(),
  // Board tab (backward compatible): kanban column + in-column sort key.
  boardColumn: z.enum(['todo', 'doing', 'done', 'blocked']).optional(),
  boardOrder: z.number().optional(),
})

export const ProjectDataSchema = z.object({
  description: z.string().default(''),
  tasks: z.array(ProjectTaskSchema).default([]),
  milestones: z.array(ProjectMilestoneSchema).default([]),
  goals: z.array(GoalSchema).optional(),
  notes: z.string().default(''),
  updatedAt: z.string().default(''),
})

// ---- API body schemas (the most-hit / most-fragile endpoints) -------------

// /api/project/goals — Goal CRUD. The route uses `goalId` / `order` (not
// `id` / `ids`) so the schema follows the actual wire shape. patch is left
// as a free record because the route does its own per-field allowlisting.
export const GoalsApiBodySchema = z.discriminatedUnion('op', [
  z.object({
    path: z.string().min(1),
    op: z.literal('add'),
    // Empty title is allowed: a fresh Goal starts untitled and the right
    // pane focuses the title input with a "やりたいことを一言で" placeholder.
    // The list / card hero fall back to "(無題)" so an empty title never
    // breaks rendering or persistence.
    title: z.string(),
    description: z.string().optional(),
    completionCriteria: z.string().optional(),
    outcome: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    outOfScope: z.array(z.string()).optional(),
  }),
  z.object({
    path: z.string().min(1),
    op: z.literal('update'),
    goalId: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({
    path: z.string().min(1),
    op: z.literal('delete'),
    goalId: z.string().min(1),
  }),
  z.object({
    path: z.string().min(1),
    op: z.literal('reorder'),
    order: z.array(z.string().min(1)),
  }),
])

// /api/project/milestones — Milestone CRUD. The 'add' op takes an ARRAY
// of milestone inputs (the plan endpoint emits batches), not a single
// milestone. Other ops are 1:1 with goals/route.
const MilestoneAddInputSchema = z.object({
  name: z.string().min(1),
  goalId: z.string().nullable().optional(),
  description: z.string().optional(),
  verifyCommands: z.array(z.string()).optional(),
  order: z.number().int().optional(),
  dueDate: z.string().nullable().optional(),
})

export const MilestonesApiBodySchema = z.discriminatedUnion('op', [
  z.object({
    path: z.string().min(1),
    op: z.literal('add'),
    milestones: z.array(MilestoneAddInputSchema).min(1),
  }),
  z.object({
    path: z.string().min(1),
    op: z.literal('update'),
    milestoneId: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({
    path: z.string().min(1),
    op: z.literal('delete'),
    milestoneId: z.string().min(1),
  }),
  z.object({
    path: z.string().min(1),
    op: z.literal('reorder'),
    order: z.array(z.string().min(1)),
  }),
])

// /api/project/milestones/verify
export const MilestoneVerifyApiBodySchema = z.object({
  path: z.string().min(1),
  milestoneId: z.string().min(1),
})

// /api/project/goals/plan
export const GoalsPlanApiBodySchema = z.object({
  path: z.string().min(1),
  goalId: z.string().min(1),
  projectName: z.string().optional(),
  projectId: z.string().optional(),
})

// /api/run/cancel
export const RunCancelApiBodySchema = z.object({
  id: z.string().min(1),
})

// /api/run/dismiss — drop a finished run (`id`) or clear all finished runs
// (`all: true`). At least one must be present; an empty body or
// `{ id: null, all: false }` is a no-op the route now rejects with 400.
export const RunDismissApiBodySchema = z
  .object({
    id: z.string().min(1).optional(),
    all: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.all) || Boolean(b.id), {
    message: 'id or all required',
  })

// /api/run/purge — irreversibly delete archived run JSON. `ids` targets
// specific archived runs; an absent/empty `ids` prunes archive entries past
// the 30-day retention window. Distinct from dismiss, which only archives.
export const RunPurgeApiBodySchema = z.object({
  ids: z.array(z.string().min(1)).optional(),
})

// /api/run/transcript — read a finished session's Claude JSONL back from
// disk, paged. GET query params arrive as strings, so offset/limit are coerced
// from their string form. sessionId is constrained to the characters Claude
// uses for session ids (UUID-ish: hex + dashes) so it can never escape the
// session directory via "../" or an absolute path — the file lookup basenames
// it onto sessionDir(cwd) but the schema rejects the trick at the door too.
export const RunTranscriptQuerySchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/, 'invalid sessionId'),
  path: z.string().min(1),
  cwd: z.string().min(1).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
})

// /api/observer/nudge
export const ObserverNudgeApiBodySchema = z.object({
  sid: z.string().min(1),
  phase: z.string().optional(),
})

// /api/feedback — in-app feedback. The client sends only a message (required)
// and an optional contact email; the server augments the row with metadata
// (app version / os / project count) before forwarding to Supabase. The 5000
// char cap mirrors the DB check constraint in docs/FEEDBACK_SETUP.md so an
// over-long body is rejected at the door with a clear 400 rather than bouncing
// off Postgres. email is loosely validated (presence of '@') — it's an
// optional contact hint, not an auth identity.
export const FeedbackApiBodySchema = z.object({
  message: z.string().trim().min(1, 'message is required').max(5000, 'message must be 5000 characters or fewer'),
  email: z
    .string()
    .trim()
    .max(320)
    .email('invalid email')
    .optional()
    .or(z.literal('')),
})

export const RunQueueOpSchema = z.enum(['start', 'pause', 'resume', 'cancel'])

export const RunQueueApiBodySchema = z.object({
  path: z.string().min(1),
  goalId: z.string().min(1),
  op: RunQueueOpSchema,
  projectName: z.string().optional(),
  projectId: z.string().optional(),
})

export const MilestoneRunApiBodySchema = z.object({
  path: z.string().min(1),
  milestoneId: z.string().min(1),
  projectName: z.string().optional(),
  projectId: z.string().optional(),
})

// ---- Helpers --------------------------------------------------------------

/** Validate against the schema and either return the parsed value or the
 *  caller-provided fallback (used when "best-effort recovery" beats "crash
 *  the cockpit", e.g. when reading tasks.json the user / claude may have
 *  scrambled). The zod errors are dropped silently — the caller's fallback
 *  is the recovery signal. */
export const safeOrFallback = <T>(
  schema: z.ZodType<T>,
  raw: unknown,
  fallback: T,
): T => {
  const r = schema.safeParse(raw)
  return r.success ? r.data : fallback
}
