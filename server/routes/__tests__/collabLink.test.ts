// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { collabRoutes } from '../collab'
import { clearSession, writeSession } from '@/lib/server/authStore'
import { clearMembershipCache } from '@/lib/server/projectMembers'
import { setSettings } from '@/lib/server/store'

// POST/GET /api/collab/link — a member links their OWN local folder to a
// folder-less shared project so its Terminal can spawn Claude there. Two gates: a
// strict-UUID id (path-traversal guard, checked BEFORE any lookup) and MEMBERSHIP
// (caller-JWT). The registry write reuses Import's canonicalize + dangerous-target
// guard, so the allowlist is never weakened (the registry layer is unit-tested in
// src/lib/server/registry.test.ts). HOME is isolated by setup-home — but it's
// per-FILE, so we reset the registry between cases.

const PID = '55555555-5555-5555-5555-555555555555'

const signIn = () =>
  writeSession({
    user: { id: 'u-mem', email: 'm@e.co', provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'tok',
    refreshToken: 'r',
  })
const anonEnv = () => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon')
}
const stubMembers = (rows: unknown[]) => {
  const fn = vi.fn(async (url: string) =>
    url.includes('og_project_members')
      ? new Response(JSON.stringify(rows), { status: 200 })
      : new Response('[]', { status: 200 }),
  )
  vi.stubGlobal('fetch', fn as unknown as typeof fetch)
  return fn
}
const member = () => stubMembers([{ project_id: PID, user_id: 'u-mem', role: 'member' }])
const postJson = (path: string, body: unknown) =>
  collabRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const tmpDirs: string[] = []
const makeDir = async () => {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'og-link-route-')))
  tmpDirs.push(d)
  return d
}

beforeEach(async () => {
  clearMembershipCache()
  await clearSession()
  // Reset the registry (HOME is per-file, so prior cases' links would leak).
  await setSettings({ projectsMigratedAt: new Date().toISOString(), projects: [] })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  clearMembershipCache()
  await clearSession()
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('POST /api/collab/link — strict id + membership + safe registry write', () => {
  it('400 for a non-uuid id (traversal guard) BEFORE any membership lookup', async () => {
    anonEnv()
    await signIn()
    const spy = stubMembers([])
    const res = await postJson('/api/collab/link', { collabProjectId: '../evil', localPath: '/tmp' })
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('403 for a non-member', async () => {
    anonEnv()
    await signIn()
    stubMembers([]) // empty roster → not a member
    const dir = await makeDir()
    const res = await postJson('/api/collab/link', { collabProjectId: PID, localPath: dir })
    expect(res.status).toBe(403)
  })

  it('400 when localPath is missing or not a directory', async () => {
    anonEnv()
    await signIn()
    member()
    expect((await postJson('/api/collab/link', { collabProjectId: PID })).status).toBe(400)
    // A file, not a directory.
    const dir = await makeDir()
    const file = join(dir, 'a-file')
    await writeFile(file, 'x')
    expect(
      (await postJson('/api/collab/link', { collabProjectId: PID, localPath: file })).status,
    ).toBe(400)
    // A path that doesn't exist.
    expect(
      (await postJson('/api/collab/link', { collabProjectId: PID, localPath: join(dir, 'nope') }))
        .status,
    ).toBe(400)
  })

  it('member + real directory → 200 { localPath } (canonical), then GET echoes it', async () => {
    anonEnv()
    await signIn()
    member()
    const dir = await makeDir()
    const res = await postJson('/api/collab/link', { collabProjectId: PID, localPath: dir })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ localPath: dir })

    const got = await collabRoutes.request(`/api/collab/link?collabProjectId=${PID}`)
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({ localPath: dir })
  })

  it('409 when re-pointing an already-linked project at a different folder', async () => {
    anonEnv()
    await signIn()
    member()
    const dir = await makeDir()
    const dir2 = await makeDir()
    expect((await postJson('/api/collab/link', { collabProjectId: PID, localPath: dir })).status).toBe(200)
    const res = await postJson('/api/collab/link', { collabProjectId: PID, localPath: dir2 })
    expect(res.status).toBe(409)
  })
})

describe('GET /api/collab/link — strict id + membership', () => {
  it('400 bad id, 403 non-member, 200 { localPath: null } when unlinked', async () => {
    anonEnv()
    await signIn()
    const spy = stubMembers([])
    expect(
      (await collabRoutes.request('/api/collab/link?collabProjectId=' + encodeURIComponent('../x')))
        .status,
    ).toBe(400)
    expect(spy).not.toHaveBeenCalled()

    expect((await collabRoutes.request(`/api/collab/link?collabProjectId=${PID}`)).status).toBe(403)

    clearMembershipCache()
    member()
    const res = await collabRoutes.request(`/api/collab/link?collabProjectId=${PID}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ localPath: null })
  })
})
