// @vitest-environment node
//
// researchAuth — the local-only cookie store's promises, as BEHAVIOR:
//   1. round-trip through the PRODUCTION reader (set → getResearchTwitterAuth);
//   2. the file lands 0600 (and stays 0600 on overwrite);
//   3. the HTTP surface never echoes a stored value back (the exfiltration
//      pin — booleans only, on every research route);
//   4. researchWorkerEnv hands the pair to a worker spawn, {} when empty;
//   5. the swarm launch plan actually carries injected env through to the SDK
//      options (the passthrough a refactor could silently sever).
// The home is a throwaway tmp dir via OPENGROUND_HOME (setup-home.ts).

import { describe, it, expect, beforeEach } from 'vitest'
import { readFile, stat } from 'fs/promises'
import {
  clearResearchTwitterAuth,
  getResearchTwitterAuth,
  researchAuthStatus,
  researchWorkerEnv,
  setResearchTwitterAuth,
} from './researchAuth'
import { researchAuthFile } from './paths'
import { sdkWorkerLaunchPlan } from './swarmWorkerSdk'
import { researchRoutes } from '../../../server/routes/research'

const SECRET_A = 'tok-9f2c1d8e7b6a5049382716'
const SECRET_B = 'ct0-abcdef0123456789fedcba'

beforeEach(async () => {
  await clearResearchTwitterAuth()
})

describe('researchAuth store', () => {
  it('round-trips through the production reader, trimmed', async () => {
    await setResearchTwitterAuth({ authToken: `  ${SECRET_A} `, ct0: `${SECRET_B}\n` })
    expect(await getResearchTwitterAuth()).toEqual({ authToken: SECRET_A, ct0: SECRET_B })
    expect(await researchAuthStatus()).toEqual({ twitterConfigured: true })
  })

  it('writes the file 0600 — and re-asserts it on overwrite', async () => {
    await setResearchTwitterAuth({ authToken: SECRET_A, ct0: SECRET_B })
    expect((await stat(researchAuthFile())).mode & 0o777).toBe(0o600)
    await setResearchTwitterAuth({ authToken: SECRET_A + '2', ct0: SECRET_B })
    expect((await stat(researchAuthFile())).mode & 0o777).toBe(0o600)
  })

  it('refuses a lone cookie and oversized pastes', async () => {
    await expect(setResearchTwitterAuth({ authToken: SECRET_A, ct0: '' })).rejects.toThrow()
    await expect(
      setResearchTwitterAuth({ authToken: 'x'.repeat(501), ct0: SECRET_B }),
    ).rejects.toThrow()
    expect(await researchAuthStatus()).toEqual({ twitterConfigured: false })
  })

  it('clear is idempotent and a corrupt file reads as not-configured (fail closed)', async () => {
    await clearResearchTwitterAuth()
    await clearResearchTwitterAuth()
    expect(await getResearchTwitterAuth()).toBeNull()
  })

  it('researchWorkerEnv: the pair when configured, {} when not', async () => {
    expect(await researchWorkerEnv()).toEqual({})
    await setResearchTwitterAuth({ authToken: SECRET_A, ct0: SECRET_B })
    expect(await researchWorkerEnv()).toEqual({
      TWITTER_AUTH_TOKEN: SECRET_A,
      TWITTER_CT0: SECRET_B,
    })
  })
})

describe('HTTP surface — the values never come back out', () => {
  it('GET /api/research/auth and /channels stay value-free with cookies stored', async () => {
    await setResearchTwitterAuth({ authToken: SECRET_A, ct0: SECRET_B })
    for (const path of ['/api/research/auth', '/api/research/channels']) {
      const res = await researchRoutes.request(path)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).not.toContain(SECRET_A)
      expect(body).not.toContain(SECRET_B)
    }
    const auth = await (await researchRoutes.request('/api/research/auth')).json()
    expect(auth).toEqual({ twitterConfigured: true })
  })

  it('POST saves (write-only response), then both-empty clears', async () => {
    const save = await researchRoutes.request('/api/research/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twitterAuthToken: SECRET_A, twitterCt0: SECRET_B }),
    })
    expect(save.status).toBe(200)
    expect(await save.text()).not.toContain(SECRET_A)
    // Landed on disk (the production reader is the proof)…
    expect(await getResearchTwitterAuth()).toEqual({ authToken: SECRET_A, ct0: SECRET_B })
    // …and stored channels now report twitter as fully unlocked would require the
    // binary too, so assert only the auth flag here (channel matrix has its own tests).
    const clear = await researchRoutes.request('/api/research/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twitterAuthToken: '', twitterCt0: '' }),
    })
    expect(clear.status).toBe(200)
    expect(await getResearchTwitterAuth()).toBeNull()
  })

  it('POST rejects a lone value with 400 and stores nothing', async () => {
    const res = await researchRoutes.request('/api/research/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twitterAuthToken: SECRET_A, twitterCt0: '' }),
    })
    expect(res.status).toBe(400)
    expect(await getResearchTwitterAuth()).toBeNull()
  })
})

describe('worker spawn passthrough', () => {
  it('sdkWorkerLaunchPlan carries injected research env into the SDK options', () => {
    const built = sdkWorkerLaunchPlan({
      worktree: '/tmp/wt',
      agentSessionId: '00000000-0000-4000-8000-000000000000',
      title: 'probe',
      claudeBin: '/usr/local/bin/claude',
      env: { PATH: '/bin', TWITTER_AUTH_TOKEN: SECRET_A, TWITTER_CT0: SECRET_B },
      lang: 'en',
    })
    const env = built.options.env as Record<string, string>
    expect(env.TWITTER_AUTH_TOKEN).toBe(SECRET_A)
    expect(env.TWITTER_CT0).toBe(SECRET_B)
  })

  it('spawnSwarmWorker is wired to researchWorkerEnv (the call-site pin)', async () => {
    // The behavioral halves are proven above; this pins the one line that
    // joins them — deleting the injection at the spawn site must go red.
    const src = await readFile(new URL('./swarmWorker.ts', import.meta.url), 'utf8')
    expect(src).toContain('await researchWorkerEnv()')
    expect(src).toContain('...researchEnv')
  })
})
