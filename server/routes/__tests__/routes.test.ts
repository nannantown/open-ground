import { describe, it, expect } from 'vitest'
import { app } from '../../app'

// Integration tests for the Hono backend. Hono apps can be invoked in-process
// via `app.request(path, init)` (no TCP bind, no supertest), so these exercise
// the *real* route handlers, middleware, and the centralized 404 / error
// shapes — not a mock.
//
// SCOPE — deliberately NOT exercised here: any route that spawns the `claude`
// CLI as a side effect (startRun, /api/project/milestones/run,
// /api/project/goals/plan, /api/project/goals/run-queue start/resume). Those
// have real process side effects and belong to the e2e / runner-specific
// suites. Everything below 400/403/404s *before* reaching a spawn, or is a
// pure read (health / projects / 404 guard), so the suite stays hermetic.
//
// STABILITY — validateProjectPath() reads settings.projectsRoot from the real
// ~/.openground/settings.json. We don't depend on that being set: the security
// assertions all use `/etc`, which can never sit under a sane projectsRoot, so
// the boundary returns 403 whether projectsRoot is null (everything 403/false)
// or a real projects dir (/etc is outside it). The 400 (missing field) and 404
// (unknown route / unknown id) cases don't touch settings at all.

const ETC = '/etc' // guaranteed to be OUTSIDE any projectsRoot → 403

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('Hono routes — existence / contract (GET reads)', () => {
  it('GET /api/health → 200 + identity contract', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    // The launcher treats a server as "ours" only if app === 'openground'.
    expect(body.app).toBe('openground')
    expect(typeof body.projectDir).toBe('string')
    expect(typeof body.startedAt).toBe('string')
    // bootId / port may be null when hand-launched (no launcher env set).
    expect(body).toHaveProperty('bootId')
    expect(body).toHaveProperty('port')
  })

  it('GET /api/projects → 200 + JSON object', async () => {
    const res = await app.request('/api/projects')
    expect(res.status).toBe(200)
    const body = await res.json()
    // The route always responds 200 with a JSON object. We do NOT assert the
    // absence of an `error` field: in a clean environment (CI, fresh machine)
    // settings.projectsRoot is unset, so the scan legitimately returns an
    // error envelope while still 200. The contract under test is "the route
    // is reachable and returns JSON", not "the machine has projects".
    expect(body).not.toBeNull()
    expect(typeof body).toBe('object')
  })
})

describe('Hono routes — validateProjectPath security boundary', () => {
  it('GET /api/project?path=/etc → 403 (outside projectsRoot)', async () => {
    const res = await app.request(`/api/project?path=${encodeURIComponent(ETC)}`)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not allowed/i)
  })

  it('GET /api/project (no path) → 400 (path is required)', async () => {
    const res = await app.request('/api/project')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/required/i)
  })

  it('POST /api/project/archive {path:/etc} → 403 (boundary on mutation)', async () => {
    const res = await app.request('/api/project/archive', json({ path: ETC }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not allowed/i)
  })
})

describe('Hono routes — body validation (zod / manual)', () => {
  it('POST /api/project/goals (op:add, no title) → 400 (zod)', async () => {
    // Missing required `title` (and using /etc path, but zod runs first):
    // the discriminated-union schema rejects → 400 BEFORE any side effect.
    const res = await app.request(
      '/api/project/goals',
      json({ path: ETC, op: 'add' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })

  it('POST /api/run/dismiss {} (neither id nor all) → 400', async () => {
    const res = await app.request('/api/run/dismiss', json({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/id or all/i)
  })

  it('POST /api/terminal {} (no cwd) → 400', async () => {
    // terminal create validates cwd presence before validateProjectPath, and
    // never reaches createTerminal() (no pty spawned) on the empty-body path.
    const res = await app.request('/api/terminal', json({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/cwd/i)
  })

  it('POST /api/terminal {cwd:/etc} → 403 (cwd outside projectsRoot)', async () => {
    const res = await app.request('/api/terminal', json({ cwd: ETC }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not allowed/i)
  })
})

describe('Hono routes — dynamic params & 404 guard', () => {
  it('GET /api/terminal/:id (unknown id) → 404', async () => {
    const res = await app.request('/api/terminal/does-not-exist-12345')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/not found/i)
  })

  it('DELETE /api/terminal/:id (unknown id) → 404', async () => {
    const res = await app.request('/api/terminal/does-not-exist-12345', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
  })

  it('GET /api/undefined-route → 404 JSON (app.all guard)', async () => {
    // app.all('/api/*') is the catch-all: an unmatched /api path must return
    // a JSON 404, never fall through to the SPA static handler (which would
    // hand back index.html HTML and break JSON clients).
    const res = await app.request('/api/this-route-does-not-exist')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/not found/i)
    // It must be JSON, not HTML.
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
  })
})
