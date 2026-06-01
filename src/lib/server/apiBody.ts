import type { z } from 'zod'

// Shared body-parsing helper for API routes that validate their input with
// a zod schema. Folds the three-step "json() → safeParse → 400 on error"
// dance into a single discriminated return so route handlers can stay
// flat. Returns either `{ ok: true, data }` (the parsed body, typed) or
// `{ ok: false, res }` (a ready-to-return web `Response` with a clear 400
// error message pointing at the offending field). Hono handlers can return
// a plain `Response` directly, so the foreign `NextResponse` dependency is
// gone — `jsonError` mirrors the old `NextResponse.json({...}, {status})`.
//
// Usage:
//   const parsed = await safeParseBody(req, MyBodySchema)
//   if (!parsed.ok) return parsed.res
//   const body = parsed.data  // typed
//
// Why a discriminated union instead of throw / catch: route handlers can
// return early without nested try/catch, and the type of `parsed.data` is
// narrowed automatically by the guard.

function jsonError(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
}

export async function safeParseBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { ok: false, res: jsonError('invalid JSON body') }
  }
  const r = schema.safeParse(raw)
  if (!r.success) {
    const issue = r.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : '<root>'
    const why = issue?.message ?? 'validation failed'
    return {
      ok: false,
      res: jsonError(`invalid body: ${where} — ${why}`),
    }
  }
  return { ok: true, data: r.data }
}
