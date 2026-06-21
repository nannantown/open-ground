import { describe, it, expect } from 'vitest'
import { buildServerForkEnv } from '../../electron/forkEnv'

// Tests for the forked-server env assembly (electron/forkEnv.js).
//
// The security-critical invariant — collab token-relay destination lock: in a
// SHIPPED build the collab WS endpoint (OPENGROUND_COLLAB_WS_URL) must be the
// BAKED value and nothing the local launch env can change — otherwise a tampered
// `OPENGROUND_COLLAB_WS_URL=wss://attacker` in the user's env would redirect the
// signed-in user's Supabase token relay. We assert the baked value wins over a
// conflicting process.env, that a dev build (no baked WS URL) still honours an env
// override, that OPENGROUND_REALTIME stays overridable, and that the rest of the
// env layering (passthrough + the fixed PORT/PATH/bootId overrides) is preserved.

const base = {
  port: 47776,
  host: '127.0.0.1',
  bootId: 'boot-xyz',
  projectDir: '/Users/x/proj',
  webRoot: null as string | null,
  enrichedPath: '/opt/homebrew/bin:/usr/bin:/bin',
}

describe('forkEnv — collab WS URL destination lock (shipped build)', () => {
  it('baked WS URL wins over a conflicting process.env override (env tamper cannot redirect the relay)', () => {
    const env = buildServerForkEnv({
      ...base,
      bakedAuthEnv: { OPENGROUND_COLLAB_WS_URL: 'wss://og-collab.mindbrew.workers.dev' },
      processEnv: { OPENGROUND_COLLAB_WS_URL: 'wss://attacker.example' },
    })
    expect(env.OPENGROUND_COLLAB_WS_URL).toBe('wss://og-collab.mindbrew.workers.dev')
  })

  it('baked WS URL wins regardless of the env value (tampered / empty / unset)', () => {
    for (const tampered of ['wss://attacker.example', '', undefined]) {
      const env = buildServerForkEnv({
        ...base,
        bakedAuthEnv: { OPENGROUND_COLLAB_WS_URL: 'wss://baked.example' },
        processEnv: tampered === undefined ? {} : { OPENGROUND_COLLAB_WS_URL: tampered },
      })
      expect(env.OPENGROUND_COLLAB_WS_URL).toBe('wss://baked.example')
    }
  })
})

describe('forkEnv — dev build (no baked WS URL) keeps the env override', () => {
  it('process.env WS URL flows through when nothing was baked (dev-only override)', () => {
    const env = buildServerForkEnv({
      ...base,
      bakedAuthEnv: {},
      processEnv: { OPENGROUND_COLLAB_WS_URL: 'wss://localhost:8787' },
    })
    expect(env.OPENGROUND_COLLAB_WS_URL).toBe('wss://localhost:8787')
  })

  it('no baked, no env → the collab WS key is absent', () => {
    const env = buildServerForkEnv({ ...base, bakedAuthEnv: {}, processEnv: {} })
    expect(env.OPENGROUND_COLLAB_WS_URL).toBeUndefined()
    expect('OPENGROUND_COLLAB_WS_URL' in env).toBe(false)
  })
})

describe('forkEnv — OPENGROUND_REALTIME stays overridable (only the WS URL is locked)', () => {
  it('process.env can flip the realtime flag off even when baked on', () => {
    const env = buildServerForkEnv({
      ...base,
      bakedAuthEnv: {
        OPENGROUND_REALTIME: '1',
        OPENGROUND_COLLAB_WS_URL: 'wss://baked.example',
      },
      processEnv: { OPENGROUND_REALTIME: '' },
    })
    // The flag is overridable (a legitimate opt-out)…
    expect(env.OPENGROUND_REALTIME).toBe('')
    // …but the relay destination is NOT.
    expect(env.OPENGROUND_COLLAB_WS_URL).toBe('wss://baked.example')
  })
})

describe('forkEnv — env layering preserved (faithful to the old inline object)', () => {
  it('applies the fixed launch overrides and passes process.env through', () => {
    const env = buildServerForkEnv({
      ...base,
      webRoot: '/app/dist-web',
      bakedAuthEnv: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' },
      processEnv: { HOME: '/Users/x', SOME_USER_VAR: 'keep-me', PATH: '/should/be/overridden' },
    })
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.PORT).toBe('47776')
    expect(env.HOSTNAME).toBe('127.0.0.1')
    expect(env.OPENGROUND_BOOT_ID).toBe('boot-xyz')
    expect(env.OPENGROUND_PROJECT_DIR).toBe('/Users/x/proj')
    expect(env.OPENGROUND_WEB_ROOT).toBe('/app/dist-web')
    // Login config baked in…
    expect(env.SUPABASE_URL).toBe('https://x.supabase.co')
    expect(env.SUPABASE_ANON_KEY).toBe('anon')
    // …arbitrary user env passed through…
    expect(env.HOME).toBe('/Users/x')
    expect(env.SOME_USER_VAR).toBe('keep-me')
    // …but PATH is forced to the resolved login-shell PATH (overrides process.env.PATH).
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('omits OPENGROUND_WEB_ROOT when webRoot is null', () => {
    const env = buildServerForkEnv({ ...base, webRoot: null, bakedAuthEnv: {}, processEnv: {} })
    expect('OPENGROUND_WEB_ROOT' in env).toBe(false)
  })

  it('process.env cannot override the fixed PORT/HOSTNAME/bootId (launch wins)', () => {
    const env = buildServerForkEnv({
      ...base,
      bakedAuthEnv: {},
      processEnv: { PORT: '1', HOSTNAME: 'evil', OPENGROUND_BOOT_ID: 'spoof' },
    })
    expect(env.PORT).toBe('47776')
    expect(env.HOSTNAME).toBe('127.0.0.1')
    expect(env.OPENGROUND_BOOT_ID).toBe('boot-xyz')
  })
})
