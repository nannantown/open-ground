// HealthSchema — the contract /api/health emits and the launcher's identity
// probe validates. Lives here (not in src/app/api/health/route.ts) because
// Next 14 App Router only allows route files to export specific named symbols
// (GET/POST/.../runtime/dynamic); extra exports are a hard compile error.

import { z } from 'zod'

export const HealthSchema = z.object({
  app: z.literal('openground'),
  projectDir: z.string(),
  bootId: z.string().nullable(),
  port: z.number().nullable(),
  startedAt: z.string(),
})

export type Health = z.infer<typeof HealthSchema>
