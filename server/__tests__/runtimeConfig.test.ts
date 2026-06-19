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

// Tests for the build-time app-login config seam (electron/runtimeConfig.js).
//
// This is the fix for "the distributed app hides Sign in": the build bakes the
// PUBLIC Supabase config into electron/runtime-config.json, and electron/main.js
// injects it into the forked server's env. We prove both halves here plus the
// whole chain end-to-end against the real /api/auth/config route, and that the
// SERVICE_ROLE key can never be baked.
//
// HOME is isolated to a tmp dir by src/test/setup-home.ts, and every write here
// targets a throwaway tmp file (never the repo's electron/runtime-config.json).

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-rtconfig-'))
  file = join(dir, 'runtime-config.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('runtimeConfig — bake allowlist', () => {
  it('BAKED_KEYS is exactly the two PUBLIC keys (never a server-secret)', () => {
    expect([...BAKED_KEYS].sort()).toEqual(['SUPABASE_ANON_KEY', 'SUPABASE_URL'])
    for (const k of BAKED_KEYS) {
      expect(k).not.toMatch(/SERVICE_ROLE|SECRET|PASSWORD|PRIVATE/i)
    }
  })

  it('NEVER writes SUPABASE_SERVICE_ROLE_KEY even when present in the env', () => {
    const written = writeRuntimeConfig(
      {
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_ANON_KEY: 'anon-public',
        SUPABASE_SERVICE_ROLE_KEY: 'super-secret-admin-key',
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
