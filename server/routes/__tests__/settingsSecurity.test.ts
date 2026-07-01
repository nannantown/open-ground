import { describe, it, expect } from 'vitest'
import { app } from '../../app'
import { getSettings, setUserSettings } from '@/lib/server/store'
import { isValidProjectPath } from '@/lib/server/projectDataPath'

// Security regression guard for the POST /api/settings boundary-bypass.
//
// THE BUG (audit MAJOR): the route did `await setSettings(await c.req.json())`.
// setSettings is a blind merge, so a forged / CSRF POST could overwrite
// `projects` — the validateProjectPath allowlist — with an arbitrary path
// (e.g. /etc). After that EVERY path-accepting route's validateProjectPath()
// passes, so the caller can spawn a shell/claude anywhere on disk
// (POST /api/terminal). The fix narrows the body to a USER-PREFERENCE allowlist
// (store.setUserSettings) and adds a CSRF / Origin guard in server/app.ts.
//
// HOME is redirected to a throwaway tmp dir by ./src/test/setup-home.ts, so
// every write here lands in an isolated registry — never the real ~/.openground.

const EVIL_PATH = '/etc' // a path registered by NOBODY in a fresh test home

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

describe('POST /api/settings — key allowlist (boundary bypass)', () => {
  it('cannot overwrite `projects` (the validateProjectPath allowlist)', async () => {
    const res = await app.request(
      '/api/settings',
      post({
        projects: [{ id: 'evil', path: EVIL_PATH, addedAt: '2026-01-01T00:00:00.000Z' }],
        // a legit field rides along to prove the whole body wasn't just refused
        language: 'ja',
      }),
    )
    expect(res.status).toBe(200)

    const s = await getSettings()
    // The injected entry must NOT be in the registry…
    expect((s.projects ?? []).some((e) => e.id === 'evil')).toBe(false)
    expect((s.projects ?? []).some((e) => e.path === EVIL_PATH)).toBe(false)
    // …and the end-to-end boundary must still reject the arbitrary path: this is
    // the exact "validateProjectPath(/etc) === true" the bug produced.
    expect(await isValidProjectPath(EVIL_PATH)).toBe(false)
    // The legit field that rode along still persisted.
    expect(s.language).toBe('ja')
  })

  it('cannot forge the migration / boundary sentinels', async () => {
    await app.request(
      '/api/settings',
      post({
        projectsMigratedAt: 'HACKED',
        shareEvacuatedAt: 'HACKED',
        projectsRoot: '/',
        archiveDirName: 'HACKED',
        excludePatterns: ['HACKED'],
      }),
    )
    const s = await getSettings()
    expect(s.projectsMigratedAt).not.toBe('HACKED')
    expect(s.shareEvacuatedAt).not.toBe('HACKED')
    expect(s.projectsRoot).not.toBe('/')
    expect(s.archiveDirName).not.toBe('HACKED')
    expect(s.excludePatterns).not.toContain('HACKED')
  })

  it('still writes legitimate user-preference settings', async () => {
    const res = await app.request(
      '/api/settings',
      post({
        language: 'ja',
        displayName: 'Alice',
        defaultWorkspace: '/tmp/og-legit-ws',
      }),
    )
    expect(res.status).toBe(200)
    const s = await getSettings()
    expect(s.language).toBe('ja')
    expect(s.displayName).toBe('Alice')
    expect(s.defaultWorkspace).toBe('/tmp/og-legit-ws')
  })

  it('a malformed (non-object) body is a no-op, not a 500', async () => {
    const res = await app.request('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '"just a string"',
    })
    expect(res.status).toBe(200)
  })
})

describe('store.setUserSettings — unit (allowlist narrowing)', () => {
  it('drops `projects` / sentinels and keeps user preferences', async () => {
    const before = await getSettings()
    const beforeCount = (before.projects ?? []).length
    const applied = await setUserSettings({
      projects: [{ id: 'x', path: EVIL_PATH, addedAt: 't' }],
      projectsMigratedAt: 'NOPE',
      language: 'en',
      displayName: 'Bob',
    })
    // Only the whitelisted keys are reported as applied.
    expect(applied).toContain('language')
    expect(applied).toContain('displayName')
    expect(applied).not.toContain('projects')
    expect(applied).not.toContain('projectsMigratedAt')

    const after = await getSettings()
    expect((after.projects ?? []).length).toBe(beforeCount) // unchanged
    expect((after.projects ?? []).some((e) => e.id === 'x')).toBe(false)
    expect(after.projectsMigratedAt).not.toBe('NOPE')
    expect(after.language).toBe('en')
    expect(after.displayName).toBe('Bob')
  })

  it('a non-object body writes nothing', async () => {
    expect(await setUserSettings('hax' as unknown)).toEqual([])
    expect(await setUserSettings(['a', 'b'] as unknown)).toEqual([])
    expect(await setUserSettings(null)).toEqual([])
  })
})

describe('CSRF / cross-origin guard (server/app.ts)', () => {
  it('rejects a mutating POST from a foreign Origin (403)', async () => {
    const res = await app.request(
      '/api/settings',
      post({ language: 'ja' }, { origin: 'https://evil.example.com' }),
    )
    expect(res.status).toBe(403)
  })

  it('allows a mutating POST from a loopback Origin (the app itself)', async () => {
    for (const origin of [
      'http://127.0.0.1:5174',
      'http://127.0.0.1:47776',
      'http://localhost:5174',
    ]) {
      const res = await app.request('/api/settings', post({ language: 'ja' }, { origin }))
      expect(res.status).toBe(200)
    }
  })

  it('allows a mutating POST with NO Origin header (local non-browser client)', async () => {
    // The vitest suite + swarm curl scripts send no Origin — they must pass.
    const res = await app.request('/api/settings', post({ language: 'ja' }))
    expect(res.status).toBe(200)
  })

  it('does not guard safe GET requests (SSE / reads stay open)', async () => {
    const res = await app.request('/api/settings', { headers: { origin: 'https://evil.example.com' } })
    expect(res.status).toBe(200)
  })
})
