import { describe, it, expect } from 'vitest'
import { app } from '../../app'

// Integration tests for the Hono backend. Hono apps can be invoked in-process
// via `app.request(path, init)` (no TCP bind, no supertest), so these exercise
// the *real* route handlers, middleware, and the centralized 404 / error
// shapes — not a mock.
//
// SCOPE — deliberately NOT exercised here: any route that spawns the `claude`
// CLI as a side effect (the terminal launch routes). Those have real process
// side effects and belong to the e2e suite. Everything below 400/403/404s
// *before* reaching a spawn, or is a pure read (health / projects / 404
// guard), so the suite stays hermetic.
//
// STABILITY — validateProjectPath() checks against the project registry
// (settings.projects) in the test home. We don't depend on it being populated:
// the security assertions all use `/etc`, which is never a registered project,
// so the boundary returns 403 whether the registry is empty (everything
// 403/false) or holds real projects (/etc is under none of them). The 400
// (missing field) and 404 (unknown route / unknown id) cases don't touch
// settings at all.

const ETC = '/etc' // guaranteed to be registered-by NOBODY → 403

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
    // The route always responds 200 with a JSON object. On a fresh machine the
    // registry is empty, so `projects` is just []. The contract under test is
    // "the route is reachable and returns JSON", not "the machine has projects".
    expect(body).not.toBeNull()
    expect(typeof body).toBe('object')
    expect(Array.isArray(body.projects)).toBe(true)
  })

  it('GET /api/settings → 200 + suggestedDisplayName (string | null, never persisted)', async () => {
    const res = await app.request('/api/settings')
    expect(res.status).toBe(200)
    const body = await res.json()
    // The display-name suggestion rides the GET response only. Its VALUE is
    // machine-dependent (`git config --global user.name` — read-only, never
    // mutated by the route), so the contract is shape, not content: the key
    // is always present, and it is a non-empty string or null.
    expect('suggestedDisplayName' in body).toBe(true)
    const v = body.suggestedDisplayName
    expect(v === null || (typeof v === 'string' && v.length > 0)).toBe(true)
    // And it must NOT round-trip into the persisted settings file: the test
    // home (OPENGROUND_HOME) starts fresh, so a plain getSettings-backed POST
    // echo would be the only way it could appear — assert the POSTed merge
    // path is never fed by this GET-only field.
    const { getSettings } = await import('@/lib/server/store')
    expect('suggestedDisplayName' in (await getSettings())).toBe(false)
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

  it('POST /api/project/delete {path:/etc} → 403 (boundary on mutation, before any Trash side effect)', async () => {
    const res = await app.request('/api/project/delete', json({ path: ETC }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not allowed/i)
  })
})

describe('Hono routes — body validation (zod / manual)', () => {
  it('POST /api/project/goals → 404 (the goals routes are gone)', async () => {
    // The Goals/Milestones feature was purged; its routes must now hit the
    // /api/* 404 guard instead of resolving to anything.
    const res = await app.request(
      '/api/project/goals',
      json({ path: ETC, op: 'add' }),
    )
    expect(res.status).toBe(404)
  })

  it('GET /api/project/journal → 404 (the journal route is gone)', async () => {
    const res = await app.request(
      `/api/project/journal?path=${encodeURIComponent(ETC)}`,
    )
    expect(res.status).toBe(404)
  })

  it('GET /api/project/doc → 404 (the doc routes are gone)', async () => {
    const res = await app.request(
      `/api/project/doc?path=${encodeURIComponent(ETC)}`,
    )
    expect(res.status).toBe(404)
  })

  it('POST /api/run → 404 (the batch-run routes are gone)', async () => {
    const res = await app.request('/api/run', json({}))
    expect(res.status).toBe(404)
  })

  it('GET /api/run/events → 404 (the run SSE stream is gone)', async () => {
    const res = await app.request('/api/run/events')
    expect(res.status).toBe(404)
  })

  it('POST /api/paste-file {} (no data) → 400', async () => {
    const res = await app.request('/api/paste-file', json({ name: 'x.txt' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/file data/i)
  })

  it('POST /api/paste-file saves under the paste dir with a sanitized name', async () => {
    const res = await app.request(
      '/api/paste-file',
      json({
        name: '../評価 レポート(最終).md',
        dataBase64: Buffer.from('hello drop').toString('base64'),
      }),
    )
    expect(res.status).toBe(200)
    const { path } = (await res.json()) as { path: string }
    // Directory components (incl. the `..`) are stripped entirely; the
    // readable basename survives with spaces collapsed to underscores.
    expect(path).toMatch(/__評価_レポート\(最終\)\.md$/)
    const { readFile } = await import('fs/promises')
    expect(await readFile(path, 'utf-8')).toBe('hello drop')
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

  it('POST /api/terminal/claude with an oversized initialPrompt → 400 (no spawn)', async () => {
    // initialPrompt is written verbatim to a tmpdir file, so an unbounded value
    // could exhaust /tmp. The cap is checked BEFORE cwd auth and before any
    // spawn, so /etc never matters and no pty is created — the suite stays
    // hermetic. Regression guard for the disk-exhaustion finding.
    const huge = 'x'.repeat(256 * 1024 + 1)
    const res = await app.request('/api/terminal/claude', json({ cwd: ETC, initialPrompt: huge }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/initialPrompt too large/i)
  })

  it('POST /api/terminal/claude with a normal prompt to /etc → 403 (cap passes, cwd rejects)', async () => {
    // A sub-cap prompt clears the size guard and falls through to the cwd
    // boundary, which 403s for an unregistered path before any spawn.
    const res = await app.request('/api/terminal/claude', json({ cwd: ETC, initialPrompt: 'do the thing' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not allowed/i)
  })
})

describe('Hono routes — dynamic params & 404 guard', () => {
  it('GET /api/terminal/active → 200 { cwds: [], claude: [] } (not captured by :id)', async () => {
    // The static `active` segment must resolve to the live-PTY listing, never
    // fall into the dynamic /api/terminal/:id route (which would 404 it as an
    // unknown terminal id). The test home spawns no PTYs, so both arrays are
    // empty — the contract under test is the route's existence + the
    // ActiveTerminalsResponse shape (cwds + claude working/waiting refinement).
    const res = await app.request('/api/terminal/active')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.cwds)).toBe(true)
    expect(body.cwds).toEqual([])
    expect(Array.isArray(body.claude)).toBe(true)
    expect(body.claude).toEqual([])
  })

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
