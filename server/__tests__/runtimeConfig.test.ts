import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeRuntimeConfig,
  readBakedAuthEnv,
  BAKED_KEYS,
} from '../../electron/runtimeConfig'
import { app } from '../app'
import { writeSession, clearSession } from '@/lib/server/authStore'

// Tests for the build-time config seam (electron/runtimeConfig.js).
//
// This is the fix for "the distributed app hides Sign in / has collab off": the
// build bakes the PUBLIC config — app login (SUPABASE_*) AND realtime collab
// (OPENGROUND_REALTIME / OPENGROUND_COLLAB_WS_URL) — into
// electron/runtime-config.json, and electron/main.js injects it into the forked
// server's env. We prove both halves here plus the whole chain end-to-end
// against the real /api/auth/config and /api/collab/config routes, and that no
// server-secret (SERVICE_ROLE / collab HMAC ticket secret) can ever be baked.
//
// HOME is isolated to a tmp dir by src/test/setup-home.ts, and every write here
// targets a throwaway tmp file (never the repo's electron/runtime-config.json).

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-rtconfig-'))
  file = join(dir, 'runtime-config.json')
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  // The collab end-to-end case signs in; clear so a session can't leak across tests.
  await clearSession()
})

describe('runtimeConfig — bake allowlist', () => {
  it('BAKED_KEYS is exactly the four PUBLIC keys (never a server-secret)', () => {
    expect([...BAKED_KEYS].sort()).toEqual([
      'OPENGROUND_COLLAB_WS_URL',
      'OPENGROUND_REALTIME',
      'SUPABASE_ANON_KEY',
      'SUPABASE_URL',
    ])
    for (const k of BAKED_KEYS) {
      expect(k).not.toMatch(/SERVICE_ROLE|SECRET|PASSWORD|PRIVATE/i)
    }
  })

  it('NEVER writes a server-secret (SERVICE_ROLE / collab ticket secret) even when present', () => {
    const written = writeRuntimeConfig(
      {
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_ANON_KEY: 'anon-public',
        SUPABASE_SERVICE_ROLE_KEY: 'super-secret-admin-key',
        // The collab HMAC ticket secret lives ONLY on the Worker — it is not in
        // BAKED_KEYS, so writeRuntimeConfig must drop it (belt-and-suspenders: the
        // module-load guard would also throw if it were ever added to the list).
        OPENGROUND_COLLAB_TICKET_SECRET: 'hmac-secret-never-ship',
      } as NodeJS.ProcessEnv,
      file,
    )
    expect(written).toEqual({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_ANON_KEY: 'anon-public',
    })
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('SERVICE_ROLE')
    expect(raw).not.toContain('super-secret-admin-key')
    expect(raw).not.toContain('TICKET_SECRET')
    expect(raw).not.toContain('hmac-secret-never-ship')
  })
})

describe('runtimeConfig — write/read round-trip (CI injection)', () => {
  it('bakes both keys, and readBakedAuthEnv returns them', () => {
    writeRuntimeConfig(
      { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon-public' } as NodeJS.ProcessEnv,
      file,
    )
    expect(readBakedAuthEnv(file)).toEqual({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_ANON_KEY: 'anon-public',
    })
  })

  it('trims whitespace and drops empty / missing values', () => {
    writeRuntimeConfig(
      { SUPABASE_URL: '  https://x.supabase.co  ', SUPABASE_ANON_KEY: '   ' } as NodeJS.ProcessEnv,
      file,
    )
    expect(readBakedAuthEnv(file)).toEqual({ SUPABASE_URL: 'https://x.supabase.co' })
  })

  it('bakes the collab keys (flag + Worker WS endpoint) and reads them back', () => {
    writeRuntimeConfig(
      {
        OPENGROUND_REALTIME: '1',
        OPENGROUND_COLLAB_WS_URL: 'wss://og-collab.mindbrew.workers.dev',
      } as NodeJS.ProcessEnv,
      file,
    )
    expect(readBakedAuthEnv(file)).toEqual({
      OPENGROUND_REALTIME: '1',
      OPENGROUND_COLLAB_WS_URL: 'wss://og-collab.mindbrew.workers.dev',
    })
  })

  it('bakes app-login AND collab keys together (a full release build)', () => {
    writeRuntimeConfig(
      {
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_ANON_KEY: 'anon-public',
        OPENGROUND_REALTIME: '1',
        OPENGROUND_COLLAB_WS_URL: 'wss://og-collab.mindbrew.workers.dev',
      } as NodeJS.ProcessEnv,
      file,
    )
    expect(readBakedAuthEnv(file)).toEqual({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_ANON_KEY: 'anon-public',
      OPENGROUND_REALTIME: '1',
      OPENGROUND_COLLAB_WS_URL: 'wss://og-collab.mindbrew.workers.dev',
    })
  })
})

describe('runtimeConfig — graceful degrade (no env build keeps login OFF)', () => {
  it('empty env writes {} and reads back {}', () => {
    const written = writeRuntimeConfig({} as NodeJS.ProcessEnv, file)
    expect(written).toEqual({})
    expect(existsSync(file)).toBe(true) // always written, never stale
    expect(readFileSync(file, 'utf8').trim()).toBe('{}')
    expect(readBakedAuthEnv(file)).toEqual({})
  })

  it('readBakedAuthEnv returns {} for a missing file', () => {
    expect(readBakedAuthEnv(join(dir, 'does-not-exist.json'))).toEqual({})
  })

  it('readBakedAuthEnv returns {} for a corrupt file', () => {
    writeFileSync(file, 'not json {{{')
    expect(readBakedAuthEnv(file)).toEqual({})
  })
})

// The whole chain: a CI-injected build (baked env) flips /api/auth/config to
// enabled:true (completion (a)); an env-less build keeps it false (completion (b)).
// The config route only checks readAuthConfig() (no network), so no fetch mock.
describe('runtimeConfig — end-to-end with /api/auth/config', () => {
  it('baked config → GET /api/auth/config { enabled: true }', async () => {
    const baked = writeRuntimeConfig(
      { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon-public' } as NodeJS.ProcessEnv,
      file,
    )
    // Simulate electron/main.js spreading the baked env into the forked server.
    for (const [k, v] of Object.entries(readBakedAuthEnv(file))) vi.stubEnv(k, v as string)
    expect(baked.SUPABASE_URL).toBeTruthy()

    const res = await app.request('/api/auth/config')
    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(true)
  })

  it('no baked config → GET /api/auth/config { enabled: false }', async () => {
    writeRuntimeConfig({} as NodeJS.ProcessEnv, file)
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    for (const [k, v] of Object.entries(readBakedAuthEnv(file))) vi.stubEnv(k, v as string)

    const res = await app.request('/api/auth/config')
    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(false)
  })
})

// The whole COLLAB chain, mirroring the auth chain above. A CI-injected build
// (baked OPENGROUND_REALTIME + OPENGROUND_COLLAB_WS_URL) + a signed-in session
// flips /api/collab/config to enabled:true — collab auto-enables in the shipped
// app for logged-in users (the goal). An env-less build keeps it false even when
// signed in (the public/dev build ships collab off). The config route reads only
// env + session (no network), so no fetch mock is needed.
//
// MANUAL E2E (against a real packaged build, equivalent to this in-process test):
//   1. Build with the collab vars present (what release.yml does):
//        OPENGROUND_REALTIME=1 \
//        OPENGROUND_COLLAB_WS_URL=wss://og-collab.mindbrew.workers.dev \
//        npm run build
//      → electron/runtime-config.json now contains both collab keys.
//   2. Launch prod (forks the bundled server with the baked env injected):
//        OPENGROUND_ELECTRON_MODE=prod electron electron/main.js   (or the .app)
//   3. Sign in via the toolbar, then:
//        curl -s http://127.0.0.1:47776/api/collab/config   → {"enabled":true}
//      (Before signing in it is {"enabled":false} — a session is required.)
describe('runtimeConfig — end-to-end with /api/collab/config', () => {
  const signIn = () =>
    writeSession({
      user: { id: 'u1', email: 'a@b.co', provider: 'google' },
      expiresAt: Date.now() + 3_600_000,
      accessToken: 'tok',
      refreshToken: 'r',
    })

  it('baked collab config + session → GET /api/collab/config { enabled: true }', async () => {
    const baked = writeRuntimeConfig(
      {
        OPENGROUND_REALTIME: '1',
        OPENGROUND_COLLAB_WS_URL: 'wss://og-collab.mindbrew.workers.dev',
      } as NodeJS.ProcessEnv,
      file,
    )
    // Simulate electron/main.js spreading the baked env into the forked server.
    for (const [k, v] of Object.entries(readBakedAuthEnv(file))) vi.stubEnv(k, v as string)
    expect(baked.OPENGROUND_COLLAB_WS_URL).toBeTruthy()
    await signIn()

    const res = await app.request('/api/collab/config')
    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(true)
  })

  it('no baked collab config, even signed in → GET /api/collab/config { enabled: false }', async () => {
    writeRuntimeConfig({} as NodeJS.ProcessEnv, file)
    // Clear any ambient collab env (the owner's shell may export these) so the
    // gate is hermetic — the public/dev build bakes nothing.
    vi.stubEnv('OPENGROUND_REALTIME', '')
    vi.stubEnv('OPENGROUND_COLLAB_WS_URL', '')
    for (const [k, v] of Object.entries(readBakedAuthEnv(file))) vi.stubEnv(k, v as string)
    await signIn()

    const res = await app.request('/api/collab/config')
    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(false)
  })
})
