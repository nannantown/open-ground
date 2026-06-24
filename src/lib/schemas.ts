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
  // Teammate who marked the card reviewed (review column); cleared on rework.
  reviewedBy: z.string().optional(),
  // Title is machine-derived (first line / haiku) and untouched by the user.
  titleAuto: z.boolean().optional(),
  // Image attachments — id is the content-hash file name in the task-asset
  // store; name/mime are display metadata. (3点セット: types.ts /
  // normalizeCard / here — a field missing from any of the three is silently
  // dropped on the shared-board round-trip.)
  attachments: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        mime: z.string(),
      }),
    )
    .optional(),
  // Ids of cards that should land before this one (B025) — informational.
  dependsOn: z.array(z.string()).optional(),
  // Soft deadline 'YYYY-MM-DD' (B026) — informational chip only. Strict shape
  // with .catch: a malformed value (a hand-edited shared card file) falls back
  // to undefined — the FIELD is dropped, never the whole card (rejecting the
  // card would make it vanish from the board over a typo'd date).
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  // Per-card run settings (実行 overrides: flow / model / effort). Same
  // drop-the-field-never-the-card resilience as dueDate — a hand-edited
  // shared card with junk here just loses the overrides.
  run: z
    .object({
      flow: z.enum(['merge', 'pr']).optional(),
      model: z.string().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    })
    .optional()
    .catch(undefined),
  // Set by the commander engine (Card③) when auto-integration could not land
  // this review card's branch because a rebase conflicted — a human must merge
  // it by hand. Cleared on any move out of review. (3点セット: types.ts /
  // tasks route setColumn clearing / here.)
  integrationConflict: z.boolean().optional(),
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
      effort: z
        .enum(['low', 'medium', 'high', 'xhigh', 'max'])
        .optional()
        .catch(undefined),
    })
    .optional(),
  tasks: z.array(ProjectTaskSchema).default([]),
  // Per-project tab ("Ground") order. Plain string ids; normalised against the
  // live module registry on use (see effectiveTabOrder). Optional so legacy
  // tasks.json files load unchanged.
  tabOrder: z.array(z.string()).optional(),
  // Custom tabs ATTACHED to this project (bare module uuids — the user-level
  // library lives in ~/.openground/custom-modules/). Personal, like tabOrder.
  customTabs: z.array(z.string()).optional(),
  // Built-in (native) modules HIDDEN from this project's row (bare ModuleId
  // strings). Personal, like tabOrder. See ProjectData.disabledModules.
  disabledModules: z.array(z.string()).optional(),
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
// Inline feedback image attachments. The client downscales + re-encodes to
// WebP, so real payloads are far below these caps — they're the SERVER-side
// backstop that mirrors the DB constraints (jsonb_array_length(images) <= 6 and
// pg_column_size(images) <= 12MB) so an oversized/malformed POST is rejected at
// the door with a clear 400 rather than bouncing off Postgres. 3点セット:
// FeedbackImage (types.ts) / this schema / the row build in routes/feedback.ts.
export const MAX_FEEDBACK_IMAGES = 6
// base64 chars: ~2.6MB decoded per image, ~6MB decoded across all of them.
export const MAX_FEEDBACK_IMAGE_B64 = 3_500_000
export const MAX_FEEDBACK_IMAGES_TOTAL_B64 = 8_000_000

// Accepted MIME types. A plain string + refine (not z.enum) keeps the inferred
// request type as `mime: string`, matching FeedbackImage in types.ts — with
// z.enum the client's FeedbackImage[] wouldn't assign to the typed $post body.
const FEEDBACK_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export const FeedbackImageApiSchema = z.object({
  // Display-only file name (tooltip / download). Never used as a path server-side.
  name: z.string().max(200).optional(),
  mime: z.string().refine((m) => FEEDBACK_IMAGE_MIMES.includes(m), 'unsupported image type'),
  // Standard base64 only (no data-URL prefix, no whitespace) so a malformed
  // client can't smuggle arbitrary text into the jsonb column.
  data: z
    .string()
    .min(1, 'empty image')
    .max(MAX_FEEDBACK_IMAGE_B64, 'image too large')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'invalid image encoding'),
})

export const FeedbackApiBodySchema = z
  .object({
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
    // Inline image attachments (base64). Optional + defaulted so clients that
    // send none keep working unchanged.
    images: z
      .array(FeedbackImageApiSchema)
      .max(MAX_FEEDBACK_IMAGES, `at most ${MAX_FEEDBACK_IMAGES} images`)
      .optional()
      .default([]),
  })
  .superRefine((val, ctx) => {
    const total = (val.images ?? []).reduce((n, im) => n + im.data.length, 0)
    if (total > MAX_FEEDBACK_IMAGES_TOTAL_B64) {
      ctx.addIssue({
        code: 'custom',
        message: 'images too large',
        path: ['images'],
      })
    }
  })

// Read-side guard for the owner inbox. GET /api/feedback/list returns Supabase
// rows VERBATIM, but `anon` can INSERT arbitrary JSON into the `images` column
// (RLS with_check is `true`), bypassing the write-side validation above — a
// non-array, a bogus mime, oversized/garbage data, anything. Re-validate each
// row's images HERE so the owner inbox only ever renders well-formed,
// size-bounded attachments: a crafted row can't crash the React tree
// (f.images.map on a non-array) or smuggle a non-image data: URL, and an
// oversized row is dropped wholesale rather than ballooning the inbox payload.
// A row that fails validation simply shows no images.
export const sanitizeFeedbackImages = (
  images: unknown,
): z.infer<typeof FeedbackImageApiSchema>[] => {
  const r = z.array(FeedbackImageApiSchema).max(MAX_FEEDBACK_IMAGES).safeParse(images)
  if (!r.success) return []
  const total = r.data.reduce((n, im) => n + im.data.length, 0)
  if (total > MAX_FEEDBACK_IMAGES_TOTAL_B64) return []
  return r.data
}

// /api/module-submissions — a tester's submission of a built custom tab for the
// owner to review (docs/CUSTOM_TABS_PLAN.md). The 200KB source cap mirrors the
// og_module_submissions DB check so an oversized body is rejected at the door
// with a clear 400 rather than bouncing off Postgres. 3点セット: SubmitModuleRequest
// (types.ts) / this schema / the row build in src/lib/server/customModulesSubmissions.ts.
export const MAX_SUBMISSION_SOURCE = 200_000

export const SubmitModuleBodySchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(60, 'name must be 60 characters or fewer'),
  description: z.string().max(4000, 'description must be 4000 characters or fewer').default(''),
  framework: z.enum(['react', 'html']).default('react'),
  source: z.string().min(1, 'source is required').max(MAX_SUBMISSION_SOURCE, 'source too large'),
})

// Read-side guard for the owner review inbox. GET /api/module-submissions reads
// rows that `anon` INSERTed under RLS — the DB checks bound sizes + the
// status/framework enums, but re-validate HERE (the sanitizeFeedbackImages
// posture) so a crafted or legacy row can't crash the inbox (e.g. a non-string
// field) or balloon the payload. A row that fails validation is dropped wholesale.
const ModuleSubmissionRowSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  // Display-only; bounded + null-safe so a garbage value never reaches the inbox.
  submitter_email: z.string().max(320).nullable().catch(null),
  name: z.string().max(200).catch(''),
  description: z.string().max(8000).catch(''),
  framework: z.enum(['react', 'html']).catch('react'),
  status: z.enum(['pending', 'approved', 'rejected']).catch('pending'),
  published_remote_id: z.string().nullable().catch(null),
  // Present only on the single-row fetch (the review preview); capped at the
  // write cap so an over-cap legacy row is dropped, not rendered.
  source: z.string().max(MAX_SUBMISSION_SOURCE).optional(),
})

export const sanitizeModuleSubmission = (
  row: unknown,
): z.infer<typeof ModuleSubmissionRowSchema> | null => {
  const r = ModuleSubmissionRowSchema.safeParse(row)
  return r.success ? r.data : null
}

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
