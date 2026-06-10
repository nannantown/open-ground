// validateProjectPath in Hono clothing (CONTRACT §3.3). This is the security
// boundary that every path-accepting endpoint must keep: the resolved-and-
// canonicalized path must equal or sit under one of the registered projects
// (the `settings.projects` registry is the allowlist), otherwise the request is
// refused. "or under" is load-bearing — per-run worktrees live at
// <project>/.openground/worktrees/<id>.
//
// The actual check is NOT reimplemented here — we import the existing
// `validateProjectPath` from src/lib/server/projectData (the §3.8 "src/lib/server
// is the source of truth" rule). This file only adapts it to Hono's request
// model: pull `path` from the query string or the JSON body, validate, and
// either 403 or hand the validated path to the route.
//
// Two ways to use it:
//
//   1) As a guard helper inside a handler — read the path yourself and bail:
//
//        const path = await requireProjectPath(c)
//        if (path instanceof Response) return path   // already a 400/403
//        // ...path is validated, use it
//
//   2) As middleware on a route group — runs the guard, stashes the validated
//      path on the context, and lets the handler read it via getProjectPath(c):
//
//        app.post('/api/project/rename', projectPathGuard, (c) => {
//          const path = getProjectPath(c)   // guaranteed valid
//          ...
//        })

import type { Context, MiddlewareHandler } from 'hono'
import { validateProjectPath } from '@/lib/server/projectData'

// Context key the guard writes the validated path under. Typed via Hono's
// ContextVariableMap so getProjectPath / c.get('projectPath') are typed.
declare module 'hono' {
  interface ContextVariableMap {
    projectPath: string
  }
}

// Pull `path` from JSON body first (POST/PUT/PATCH), then fall back to the
// `?path=` query param (GET/DELETE). Body parsing is wrapped because a missing
// or non-JSON body must not throw — it just means "no path here, try query".
const readPath = async (c: Context): Promise<string | undefined> => {
  const method = c.req.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    try {
      const body = (await c.req.json()) as { path?: unknown }
      if (typeof body?.path === 'string' && body.path) return body.path
    } catch {
      // No body / not JSON — fall through to the query string.
    }
  }
  const q = c.req.query('path')
  return q || undefined
}

/**
 * Validate the request's project path. Returns the resolved-and-allowed path
 * string on success, or a Hono Response (400 / 403) the caller should return
 * as-is on failure. Use the `instanceof Response` check to branch.
 *
 * NOTE: reading a JSON body consumes it. If your handler also needs the body,
 * either use `c.req.json()` once and pass the value to your own validation, or
 * cache it — Hono caches `c.req.json()` per request, so calling it again in the
 * same handler returns the same parsed object (no double-read error).
 */
export const requireProjectPath = async (c: Context): Promise<string | Response> => {
  const path = await readPath(c)
  if (!path) return c.json({ error: 'path is required' }, 400)
  if (!(await validateProjectPath(path))) {
    return c.json({ error: 'path not allowed' }, 403)
  }
  return path
}

/**
 * Middleware form. Runs requireProjectPath; on success stashes the validated
 * path on the context (read it with getProjectPath(c)) and continues, on
 * failure short-circuits with the 400/403 JSON response.
 */
export const projectPathGuard: MiddlewareHandler = async (c, next) => {
  const result = await requireProjectPath(c)
  if (result instanceof Response) return result
  c.set('projectPath', result)
  return next()
}

/** Read the validated path stashed by projectPathGuard. */
export const getProjectPath = (c: Context): string => c.get('projectPath')
