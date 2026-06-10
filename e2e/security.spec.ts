import { test, expect } from '@playwright/test'

// Security boundary: every path-accepting route runs validateProjectPath, which
// only admits paths under a REGISTERED project (or its central worktrees). An
// unregistered path must be rejected — this is the guard that stops the local
// server from reading/writing arbitrary filesystem locations. We assert it on a
// representative spawn endpoint (POST /api/terminal/claude) with a path that
// was never imported — the 403 must land BEFORE any PTY is created.

test.describe('Path security boundary', () => {
  test('POST /api/terminal/claude rejects an unregistered cwd with 403', async ({ request }) => {
    const res = await request.post('/api/terminal/claude', {
      data: { cwd: '/tmp/definitely-not-registered-og' },
    })
    expect(res.status()).toBe(403)
  })

  test('GET /api/project rejects an unregistered project path with 403', async ({ request }) => {
    // /api/project reads a project's data for the given path; an unregistered
    // path must not resolve to any central data dir — it's a hard 403, not a
    // 404, so a probe can't distinguish "not allowed" from "absent".
    const res = await request.get(
      '/api/project?path=' + encodeURIComponent('/tmp/definitely-not-registered-og'),
    )
    expect(res.status()).toBe(403)
  })
})
