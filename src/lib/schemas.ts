// Zod schemas for the on-disk + over-the-wire shapes that OPEN GROUND
// trusts the LEAST: tasks.json (claude can edit it despite the prompt
// telling it not to) and the bodies of mutation API routes (the dev
// server's wide-open localhost surface is fine for a single-user tool,
// but an honest-mistake malformed POST shouldn't be able to wedge the
// server).
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

import { z } from 'zod'

// ---- ProjectTask + ProjectData --------------------------------------------

// Old disk data may still carry batch-run-era fields (latestRun /
// agentSessionId / transcriptRef / activeSkill / images). The schema no longer
// knows them, so zod silently strips them on read and they vanish on the next
// write — no migration code.
export const ProjectTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  notes: z.string().optional(),
  done: z.boolean(),
  createdAt: z.string().default(''),
  // Board tab (backward compatible): kanban column + in-column sort key.
  boardColumn: z.enum(['todo', 'doing', 'review', 'done', 'blocked']).optional(),
  assignee: z.string().optional(),
  boardOrder: z.number().optional(),
  // PR opened for the task (completionFlow 'pr') — set via tasks {setPrUrl}.
  prUrl: z.string().optional(),
  // Task branch claude created — set via tasks {setBranch}.
  branch: z.string().optional(),
  // Title is machine-derived (first line / haiku) and untouched by the user.
  titleAuto: z.boolean().optional(),
})

export const ProjectDataSchema = z.object({
  description: z.string().default(''),
  // Generated language pair (descriptionForLang picks by UI language).
  descriptionJa: z.string().optional(),
  descriptionEn: z.string().optional(),
  // Shared project policy (completion flow / target branch / verify commands /
  // review column) + personal launch prefs — see types.ts.
  config: z
    .object({
      completionFlow: z.enum(['merge', 'pr']).optional(),
      targetBranch: z.string().optional(),
      verifyCommands: z.array(z.string()).optional(),
      reviewColumn: z.boolean().optional(),
      members: z.array(z.string()).optional(),
    })
    .optional(),
  launch: z
    .object({
      permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypass']).optional(),
      model: z.string().optional(),
      autoSync: z.boolean().optional(),
    })
    .optional(),
  tasks: z.array(ProjectTaskSchema).default([]),
  // Per-project tab ("Ground") order. Plain string ids; normalised against the
  // live module registry on use (see effectiveTabOrder). Optional so legacy
  // tasks.json files load unchanged.
  tabOrder: z.array(z.string()).optional(),
  notes: z.string().default(''),
  updatedAt: z.string().default(''),
})

// ---- API body schemas (the most-hit / most-fragile endpoints) -------------

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
  // Optional UI-context tag (e.g. the per-project tab the feedback is about).
  // The server prefixes the stored message with "[ctx:<context>] " rather than
  // assuming a new DB column, so this stays non-breaking with the existing
  // feedback table. Capped short — it's a source/label hint, not free text.
  context: z.string().max(120).optional(),
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
