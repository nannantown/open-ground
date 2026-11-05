import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createChatGptAuth } from './chatgptAuth'
import { ChatGptConversation } from './chatgptResponses'

const ISSUER = 'https://auth.openai.com'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const CLIENT = 'oaiapp_test_registration'
let keys: Awaited<ReturnType<typeof generateKeyPair>>
let publicJwk: Awaited<ReturnType<typeof exportJWK>>
const cleanup: (() => Promise<unknown>)[] = []

beforeAll(async () => {
  keys = await generateKeyPair('RS256')
  publicJwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }
})
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
  vi.unstubAllEnvs()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'og-chatgpt-auth-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let clock = Date.now()
  let locked = false
  let nonce = ''
  let activeLogin = ''
  const tokenBodies: URLSearchParams[] = []
  const revoked: string[] = []
  let tokenResult: ((body: URLSearchParams) => Promise<Record<string, unknown>>) | undefined
  const identity = async (claims: { nonce?: string; audience?: string | string[]; subject?: string } = {}) => new SignJWT({
    nonce: claims.nonce ?? nonce, email: 'owner@example.test',
  }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(ISSUER)
    .setAudience(claims.audience ?? CLIENT).setSubject(claims.subject ?? 'owner-subject')
    .setIssuedAt(Math.floor(clock / 1000)).setExpirationTime(Math.floor(clock / 1000) + 3600)
    .sign(keys.privateKey)
  const credentials = async (suffix = 'one') => ({
    access_token: `access-${suffix}`, refresh_token: `refresh-${suffix}`,
    id_token: await identity(), expires_in: 3600, token_type: 'Bearer', scope: SCOPE,
  })
  const mockedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [publicJwk] })
    if (url === `${ISSUER}/api/accounts/oauth/token`) {
      const body = new URLSearchParams(init?.body as URLSearchParams)
      tokenBodies.push(body)
      return Response.json(await (tokenResult ? tokenResult(body) : credentials()))
    }
    if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [
      { slug: 'available-model', display_name: 'Available model', visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
    ] })
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ revocation_endpoint: `${ISSUER}/oauth/revoke` })
    if (url === `${ISSUER}/oauth/revoke`) {
      revoked.push(new URLSearchParams(init?.body as URLSearchParams).get('token')!)
      return new Response('', { status: 200 })
    }
    throw new Error(`Unexpected mocked request: ${url}`)
  })
  const auth = createChatGptAuth({ home: () => directory, fetch: mockedFetch as typeof fetch,
    lockdown: () => locked, now: () => clock, requestTimeoutMs: 1000 })
  cleanup.push(async () => { if (activeLogin) await auth.cancelChatGptLogin(activeLogin) })
  const start = async () => {
    const result = await auth.beginChatGptLogin()
    activeLogin = result.loginId
    const url = new URL(result.authorizationUrl)
    nonce = url.searchParams.get('nonce')!
    return { ...result, url }
  }
  const callback = (authorization: URL, changes: Record<string, string> = {}) => {
    const url = new URL(authorization.searchParams.get('redirect_uri')!)
    url.searchParams.set('state', authorization.searchParams.get('state')!)
    url.searchParams.set('code', 'one-use-authorization-code')
    url.searchParams.set('client_id', CLIENT)
    for (const [name, value] of Object.entries(changes)) url.searchParams.set(name, value)
    return fetch(url)
  }
  const connect = async () => {
    const result = await start()
    expect((await callback(result.url)).status).toBe(200)
    return result
  }
  return { auth, start, callback, connect, identity, credentials, mockedFetch, tokenBodies, revoked,
    file: join(directory, 'secrets', 'chatgpt.json'), directory,
    advance: (ms: number) => { clock += ms }, setLocked: (value: boolean) => { locked = value },
    setTokenResult: (fn: typeof tokenResult) => { tokenResult = fn },
  }
}

describe('ChatGPT public-client authorization', () => {
  it('uses a fresh loopback PKCE ceremony and only exposes safe connection data', async () => {
    const f = await fixture()
    const { url } = await f.start()
    expect(url.origin + url.pathname).toBe(`${ISSUER}/api/accounts/authorize`)
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(url.searchParams.get('agent_name_hint')).toBe('OPEN GROUND')
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/)
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('id_token_hint')).toBe(false)
    expect((await f.auth.getChatGptConnection()).state).toBe('connecting')
    expect((await f.callback(url)).status).toBe(200)
    const exchange = f.tokenBodies[0]
    expect(exchange.get('client_id')).toBe(CLIENT)
    expect(exchange.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'))
    expect(exchange.get('resource')).toBe('https://api.openai.com/v1')
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'))
      .toBe(url.searchParams.get('code_challenge'))
    expect(await f.auth.getChatGptConnection()).toEqual({ state: 'connected', email: 'owner@example.test',
      models: [{ id: 'available-model', name: 'Available model', supportedEfforts: ['low', 'high'] }] })
    const exposed = JSON.stringify(await f.auth.getChatGptConnection())
    expect(exposed).not.toMatch(/access-one|refresh-one|id_token|code_verifier/)
    expect((await stat(f.file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(f.directory, 'secrets'))).mode & 0o777).toBe(0o700)
  })

  it('rejects an unrelated callback state without consuming the real login', async () => {
    const f = await fixture(), { url } = await f.start()
    expect((await f.callback(url, { state: 'wrong-state' })).status).toBe(400)
    expect(f.tokenBodies).toHaveLength(0)
    expect((await f.callback(url)).status).toBe(200)
    expect(f.tokenBodies).toHaveLength(1)
  })

  it('accepts the official singleton-array ID token audience through the complete callback', async () => {
    const f = await fixture()
    f.setTokenResult(async () => ({ ...await f.credentials(), id_token: await f.identity({ audience: [CLIENT] }) }))
    const { url } = await f.start()
    expect((await f.callback(url)).status).toBe(200)
    expect(await f.auth.getChatGptConnection()).toMatchObject({ state: 'connected', email: 'owner@example.test' })
    expect(await f.auth.getChatGptAccessToken()).toBe('access-one')
  })

  it.each([
    ['unrelated', ['oaiapp_different']],
    ['empty', []],
    ['multiple', [CLIENT, 'oaiapp_different']],
  ] as const)('rejects an %s ID token audience array without saving credentials', async (_name, audience) => {
    const f = await fixture()
    f.setTokenResult(async () => ({ ...await f.credentials(), id_token: await f.identity({ audience: Array.from(audience) }) }))
    const { url } = await f.start()
    expect((await f.callback(url)).status).toBe(400)
    expect((await f.auth.getChatGptConnection()).state).toBe('error')
    expect(JSON.parse(await readFile(f.file, 'utf8')).credentials).toBeUndefined()
    await expect(f.auth.getChatGptAccessToken()).rejects.toThrow('接続してください')
  })

  it.each(['nonce', 'audience', 'signature', 'scope'] as const)('refuses invalid %s before saving credentials', async (control) => {
    const f = await fixture()
    f.setTokenResult(async () => {
      const result = await f.credentials()
      if (control === 'scope') return { ...result, scope: 'openid profile email' }
      const idToken = await f.identity(control === 'nonce' ? { nonce: 'another-attempt' }
        : control === 'audience' ? { audience: 'oaiapp_different' } : {})
      return { ...result, id_token: control === 'signature' ? `${idToken.slice(0, -12)}AAAAAAAAAAAA` : idToken }
    })
    const { url } = await f.start()
    expect((await f.callback(url)).status).toBe(400)
    expect((await f.auth.getChatGptConnection()).state).toBe('error')
    expect(JSON.parse(await readFile(f.file, 'utf8')).credentials).toBeUndefined()
    await expect(f.auth.getChatGptAccessToken()).rejects.toThrow('接続してください')
  })

  it('retains host and issued registration through logout, and never copies tokens into returning URLs', async () => {
    const f = await fixture(), first = await f.connect()
    await f.auth.disconnectChatGpt()
    expect(f.revoked).toEqual(['refresh-one'])
    expect((await f.auth.getChatGptConnection()).state).toBe('signed-out')
    const second = await f.start()
    expect(second.url.searchParams.get('client_id')).toBe(CLIENT)
    expect(second.url.searchParams.get('ext_agent_host_id')).toBe(first.url.searchParams.get('ext_agent_host_id'))
    expect(second.url.searchParams.has('agent_name_hint')).toBe(false)
    expect(second.url.searchParams.has('id_token_hint')).toBe(false)
    expect((await f.callback(second.url, { client_id: 'oaiapp_unrelated' })).status).toBe(400)
    expect(f.tokenBodies).toHaveLength(1)
  })

  it('cancel closes its own listener and leaves no usable credentials', async () => {
    const f = await fixture(), result = await f.start()
    await f.auth.cancelChatGptLogin('unrelated-login')
    expect((await f.auth.getChatGptConnection()).state).toBe('connecting')
    await f.auth.cancelChatGptLogin(result.loginId)
    await expect(f.callback(result.url)).rejects.toThrow()
    expect((await f.auth.getChatGptConnection()).state).toBe('signed-out')
    expect(f.tokenBodies).toHaveLength(0)
  })

  it('rejects duplicate simultaneous callbacks and exchanges a code only once', async () => {
    const f = await fixture()
    let release!: () => void
    f.setTokenResult(async () => { await new Promise<void>((resolve) => { release = resolve }); return f.credentials() })
    const { url } = await f.start()
    const first = f.callback(url)
    await vi.waitFor(() => expect(f.tokenBodies).toHaveLength(1))
    expect((await f.callback(url)).status).toBe(400)
    release()
    expect((await first).status).toBe(200)
    expect(f.tokenBodies).toHaveLength(1)
  })
})

describe('renewal and local credential boundary', () => {
  it.each(['signed-out', 'usage-scope-not-granted'] as const)(
    'never uses ambient API keys or sends inference when %s', async (state) => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-must-never-be-used')
      vi.stubEnv('CODEX_API_KEY', 'sk-must-also-never-be-used')
      const f = await fixture()
      if (state === 'usage-scope-not-granted') {
        f.setTokenResult(async () => ({ ...await f.credentials(), scope: 'openid profile email offline_access' }))
        const { url } = await f.start()
        expect((await f.callback(url)).status).toBe(400)
      }
      f.mockedFetch.mockClear()
      await expect(f.auth.getChatGptAccessToken()).rejects.toThrow('ChatGPT に接続してください')
      await expect(f.auth.listChatGptModels()).rejects.toThrow('ChatGPT に接続してください')
      const conversation = new ChatGptConversation({ model: 'test-model', persist: false, tools: [],
        accessToken: f.auth.getChatGptAccessToken, accountKey: f.auth.getChatGptAccountKey,
        fetch: f.mockedFetch as typeof fetch,
      })
      await expect(conversation.run('This must never incur API usage.')).rejects.toThrow('ChatGPT に接続してください')
      expect(f.mockedFetch).not.toHaveBeenCalled()
    },
  )

  it('rotates one refresh token once for simultaneous callers', async () => {
    const f = await fixture()
    await f.connect(); f.advance(3_570_000)
    let release!: () => void
    f.setTokenResult(async () => { await new Promise<void>((resolve) => { release = resolve }); return f.credentials('two') })
    const first = f.auth.getChatGptAccessToken(), second = f.auth.getChatGptAccessToken()
    await vi.waitFor(() => expect(f.tokenBodies).toHaveLength(2))
    release()
    expect(await Promise.all([first, second])).toEqual(['access-two', 'access-two'])
    expect(f.tokenBodies[1].get('grant_type')).toBe('refresh_token')
    expect(f.tokenBodies[1].get('scope')).toBeNull()
    expect(JSON.parse(await readFile(f.file, 'utf8')).credentials.refreshToken).toBe('refresh-two')
  })

  it('disconnect cannot be undone by an in-flight refresh', async () => {
    const f = await fixture()
    await f.connect(); f.advance(3_570_000)
    let release!: () => void
    f.setTokenResult(async () => { await new Promise<void>((resolve) => { release = resolve }); return f.credentials('two') })
    const refresh = f.auth.getChatGptAccessToken()
    const rejected = expect(refresh).rejects.toThrow('接続が変わりました')
    await vi.waitFor(() => expect(f.tokenBodies).toHaveLength(2))
    await f.auth.disconnectChatGpt()
    release(); await rejected
    expect(JSON.parse(await readFile(f.file, 'utf8')).credentials).toBeUndefined()
    expect(f.revoked).toContain('refresh-two')
    expect((await f.auth.getChatGptConnection()).state).toBe('signed-out')
  })

  it('does not make auth, JWKS, or model requests while lockdown is enabled', async () => {
    const f = await fixture()
    await f.connect()
    f.mockedFetch.mockClear(); f.setLocked(true)
    await expect(f.auth.beginChatGptLogin()).rejects.toThrow('業務モード')
    await expect(f.auth.getChatGptAccessToken()).rejects.toThrow('業務モード')
    await expect(f.auth.listChatGptModels()).rejects.toThrow('業務モード')
    expect((await f.auth.getChatGptConnection()).state).toBe('error')
    expect(f.mockedFetch).not.toHaveBeenCalled()
  })

  it('refuses a symlinked secrets directory without writing to its target', async () => {
    const f = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'og-chatgpt-outside-'))
    cleanup.push(() => rm(outside, { recursive: true, force: true }))
    await symlink(outside, join(f.directory, 'secrets'))
    await expect(f.auth.beginChatGptLogin()).rejects.toThrow('安全に読めません')
    await expect(stat(join(outside, 'chatgpt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.mockedFetch).not.toHaveBeenCalled()
  })

  it('never forwards raw remote errors or credentials to connection status', async () => {
    const f = await fixture()
    f.setTokenResult(async () => { throw new Error('access-one refresh-one untrusted remote diagnostic') })
    const { url } = await f.start()
    expect((await f.callback(url)).status).toBe(400)
    const connection = await f.auth.getChatGptConnection()
    expect(connection.state).toBe('error')
    expect(JSON.stringify(connection)).not.toMatch(/access-one|refresh-one|untrusted remote/)
  })
})
