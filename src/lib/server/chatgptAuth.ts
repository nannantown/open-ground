// Independent public-client SIWC flow. Never reads Codex/ChatGPT credentials.
// Protocol: developers.openai.com/siwc/token-sharing-open-source/sign-in
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { openGroundHome } from './paths'
import { isLockdownEnabledSync } from './lockdown'
import { clearChatGptCooling } from './chatgptQuota'

export interface ChatGptModel { id: string; name: string; supportedEfforts?: string[] }
export interface ChatGptConnection {
  state: 'signed-out' | 'connecting' | 'connected' | 'error'
  email?: string
  models: ChatGptModel[]
  error?: string
}

const ISSUER = 'https://auth.openai.com'
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`
const TOKEN = `${ISSUER}/api/accounts/oauth/token`
const RESOURCE = 'https://api.openai.com/v1'
const USAGE_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = `openid profile email offline_access resource.invoke ${USAGE_SCOPE}`
const MAX_FILE_BYTES = 64 * 1024

interface Identity { subject: string; email?: string }
interface Credentials {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
  scopes: string[]
}
interface AuthFile {
  version: 1
  hostId?: string
  registration?: { clientId: string; identity?: Identity }
  credentials?: Credentials
}
interface PendingLogin {
  id: string
  generation: number
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  clientId?: string
  server: Server
  controller: AbortController
  timeout: ReturnType<typeof setTimeout>
  consumed: boolean
  response?: ServerResponse
}

class AuthError extends Error {}
const failure = (message: string): AuthError => new AuthError(message)
const safeError = (error: unknown): string => error instanceof AuthError
  ? error.message : 'ChatGPT との接続を確認できませんでした。もう一度接続してください。'
const changed = () => failure('ChatGPT の接続が変わりました。もう一度お試しください。')
const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 24_000 && !/[\u0000-\u001f\u007f]/.test(value)
const clientIdIsValid = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9_-]{3,512}$/.test(value) && value !== 'dynamic_agent_client'
const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const localResponse = (response: ServerResponse | undefined, ok: boolean) => {
  if (!response || response.writableEnded || response.destroyed) return
  response.writeHead(ok ? 200 : 400, {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff',
  })
  response.end(ok ? 'OPEN GROUND に接続しました。この画面を閉じてください。'
    : '接続は完了していません。OPEN GROUND に戻ってください。')
}

/** A factory keeps focused tests isolated; production uses the singleton below. */
export function createChatGptAuth(options: {
  home?: () => string
  fetch?: typeof fetch
  lockdown?: () => boolean | Promise<boolean>
  now?: () => number
  loginTimeoutMs?: number
  requestTimeoutMs?: number
} = {}) {
  const home = options.home ?? openGroundHome
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const now = options.now ?? Date.now
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  let generation = 0
  let pending: PendingLogin | undefined
  let lastError: string | undefined
  let storeQueue: Promise<unknown> = Promise.resolve()
  let lifecycleQueue: Promise<unknown> = Promise.resolve()
  let refresh: { generation: number; promise: Promise<string> } | undefined
  let modelRequest: { generation: number; promise: Promise<ChatGptModel[]> } | undefined
  let modelCache: { generation: number; at: number; models: ChatGptModel[] } | undefined
  const modelControllers = new Set<AbortController>()
  const serializeStore = <T>(task: () => Promise<T>): Promise<T> => {
    const result = storeQueue.then(task)
    storeQueue = result.catch(() => {})
    return result
  }
  const serializeLifecycle = <T>(task: () => Promise<T>): Promise<T> => {
    const result = lifecycleQueue.then(task)
    lifecycleQueue = result.catch(() => {})
    return result
  }
  const assertNetwork = async () => {
    const locked = options.lockdown ? await options.lockdown() : isLockdownEnabledSync()
      || (await (await import('./store')).getSettings()).lockdownMode === true
    if (locked) throw failure('業務モード中は ChatGPT に接続できません。')
  }
  const paths = () => {
    const directory = join(home(), 'secrets')
    return { directory, file: join(directory, 'chatgpt.json') }
  }
  const checkDirectory = async (create: boolean) => {
    const { directory } = paths()
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('ChatGPT の保存先を安全に開けません。')
    if (create) await chmod(directory, 0o700)
  }
  const readStore = async (): Promise<AuthFile> => {
    let handle
    try {
      await checkDirectory(false)
      handle = await open(paths().file, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw failure('ChatGPT の接続情報を読めません。')
      const data = JSON.parse(await handle.readFile('utf8')) as AuthFile
      if (data.version !== 1 || (data.hostId !== undefined
        && !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.hostId))) {
        throw failure('ChatGPT の接続情報を読めません。')
      }
      if (data.registration && (!clientIdIsValid(data.registration.clientId)
        || (data.registration.identity && !opaque(data.registration.identity.subject)))) {
        throw failure('ChatGPT の接続情報を読めません。')
      }
      const c = data.credentials
      if (c && (!data.registration?.identity || !opaque(c.accessToken) || !opaque(c.refreshToken)
        || !opaque(c.idToken) || !Number.isFinite(c.expiresAt) || !Array.isArray(c.scopes)
        || !c.scopes.every((scope) => typeof scope === 'string') || !c.scopes.includes(USAGE_SCOPE))) {
        throw failure('ChatGPT の接続情報を読めません。')
      }
      return data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }
      throw failure('ChatGPT の接続情報を安全に読めません。')
    } finally { await handle?.close() }
  }
  const writeStore = async (data: AuthFile) => {
    await checkDirectory(true)
    const { directory, file } = paths()
    const temporary = join(directory, `.chatgpt-${randomUUID()}.tmp`)
    let handle
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await handle.writeFile(`${JSON.stringify(data)}\n`, 'utf8')
      await handle.sync()
      await handle.close(); handle = undefined
      await rename(temporary, file)
      // rename replaces the old entry with our exclusively created 0600 file.
      // A pathname-based chmod here could follow a subsequently swapped symlink.
    } finally {
      await handle?.close()
      await rm(temporary, { force: true })
    }
  }
  const jsonRequest = async (url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    await assertNetwork()
    let response: Response
    try {
      response = await request(url, { ...init, redirect: 'error', signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) })
    } catch { throw failure('ChatGPT に接続できませんでした。もう一度お試しください。') }
    if (!response.ok) throw failure(response.status === 401 || response.status === 403
      ? 'ChatGPT にもう一度接続してください。' : 'ChatGPT が応答できませんでした。時間をおいてお試しください。')
    try {
      const value: unknown = await response.json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value as Record<string, unknown>
    } catch { throw failure('ChatGPT からの応答を確認できませんでした。') }
  }
  const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), {
    [customFetch]: async (url, init) => {
      await assertNetwork()
      return request(url, { ...init, redirect: 'error' })
    },
    timeoutDuration: timeoutMs,
  })
  const verifyIdentity = async (token: string, clientId: string, nonce?: string): Promise<Identity> => {
    try {
      await assertNetwork()
      const { payload } = await jwtVerify(token, jwks, {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256'],
        currentDate: new Date(now()), requiredClaims: ['sub', 'exp', 'iat'],
      })
      // OpenAI's documented ID-token audience is also a singleton array.
      // Keep the exact issued-client binding; multiple audiences need their
      // own authorized-party policy and are not accepted by this client.
      const audienceMatches = payload.aud === clientId || (Array.isArray(payload.aud)
        && payload.aud.length === 1 && payload.aud[0] === clientId)
      if (!opaque(payload.sub) || !audienceMatches
        || (nonce !== undefined && (typeof payload.nonce !== 'string' || !same(payload.nonce, nonce)))) {
        throw new Error()
      }
      return { subject: payload.sub, ...(typeof payload.email === 'string' && payload.email.length < 320
        && !/[\u0000-\u001f\u007f]/.test(payload.email) ? { email: payload.email } : {}) }
    } catch { throw failure('ChatGPT のアカウントを確認できませんでした。もう一度接続してください。') }
  }
  const credentialsFrom = (result: Record<string, unknown>, previous?: Credentials): Credentials => {
    const scopes = typeof result.scope === 'string' ? result.scope.split(/\s+/).filter(Boolean)
      : previous?.scopes ?? []
    if (!scopes.includes(USAGE_SCOPE)) throw failure('ChatGPT プランの利用を許可してから、もう一度接続してください。')
    if (!opaque(result.access_token) || !opaque(result.refresh_token)
      || (!previous && !opaque(result.id_token)) || (result.id_token !== undefined && !opaque(result.id_token))
      || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in)
      || result.expires_in <= 0 || result.expires_in > 86_400
      || (typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer')) {
      throw failure('ChatGPT の接続情報を確認できませんでした。')
    }
    return { accessToken: result.access_token, refreshToken: result.refresh_token,
      idToken: result.id_token as string | undefined ?? previous!.idToken,
      expiresAt: now() + result.expires_in * 1000, scopes }
  }
  const revoke = async (clientId: string, refreshToken: string) => {
    await assertNetwork()
    const discovery = await jsonRequest(`${ISSUER}/.well-known/openid-configuration`)
    const endpoint = discovery.revocation_endpoint
    if (typeof endpoint !== 'string' || new URL(endpoint).origin !== ISSUER || new URL(endpoint).protocol !== 'https:') {
      throw failure('ChatGPT 側の切断を確認できませんでした。')
    }
    const response = await request(endpoint, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }),
      signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw failure('ChatGPT 側の切断を確認できませんでした。')
  }
  const clearModels = () => {
    modelCache = undefined; modelRequest = undefined
    modelControllers.forEach((controller) => controller.abort())
    modelControllers.clear()
  }
  const stopPending = () => {
    const login = pending
    pending = undefined
    if (!login) return
    clearTimeout(login.timeout)
    login.controller.abort()
    localResponse(login.response, false)
    login.server.close()
  }
  const finishLogin = async (login: PendingLogin, callback: URL) => {
    try {
      if (callback.searchParams.has('error')) throw failure('ChatGPT への接続がキャンセルされました。')
      const code = callback.searchParams.get('code')
      const issued = callback.searchParams.get('client_id')
      const clientId = issued ?? login.clientId
      if (!opaque(code) || !clientIdIsValid(clientId) || (login.clientId && issued && issued !== login.clientId)) {
        throw failure('ChatGPT のログイン結果を確認できませんでした。')
      }
      await serializeStore(async () => {
        if (generation !== login.generation || pending !== login) throw changed()
        const saved = await readStore()
        if (!saved.registration) {
          saved.registration = { clientId }
          await writeStore(saved) // Retain a successful registration even if its code expires.
        } else if (saved.registration.clientId !== clientId) throw changed()
      })
      const result = await jsonRequest(TOKEN, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
          code, code_verifier: login.verifier, redirect_uri: login.redirectUri, resource: RESOURCE }),
      }, login.controller.signal)
      const credentials = credentialsFrom(result)
      const identity = await verifyIdentity(credentials.idToken, clientId, login.nonce)
      await serializeStore(async () => {
        if (generation !== login.generation || pending !== login) throw changed()
        const saved = await readStore()
        if (saved.registration?.clientId !== clientId || (saved.registration.identity
          && saved.registration.identity.subject !== identity.subject)) throw changed()
        saved.registration = { clientId, identity }; saved.credentials = credentials
        await writeStore(saved)
        clearChatGptCooling()
      })
      if (generation !== login.generation || pending !== login) throw changed()
      lastError = undefined
      localResponse(login.response, true)
    } catch (error) {
      if (generation === login.generation && pending === login) lastError = safeError(error)
      localResponse(login.response, false)
    } finally {
      clearTimeout(login.timeout)
      login.server.close()
      if (pending === login) pending = undefined
    }
  }
  const beginChatGptLogin = (): Promise<{ authorizationUrl: string; loginId: string }> => serializeLifecycle(async () => {
    await assertNetwork()
    generation++; stopPending(); clearModels(); lastError = undefined
    const current = generation
    const saved = await serializeStore(async () => {
      const data = await readStore()
      if (!data.hostId) { data.hostId = `urn:uuid:${randomUUID()}`; await writeStore(data) }
      return data
    })
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const server = createServer((req, response) => {
      const login = pending
      if (!login || login.server !== server || req.method !== 'GET' || req.headers.host !== new URL(login.redirectUri).host) {
        response.writeHead(404); response.end(); return
      }
      let callback: URL
      try { callback = new URL(req.url ?? '/', login.redirectUri) }
      catch { localResponse(response, false); return }
      if (callback.origin !== new URL(login.redirectUri).origin || callback.pathname !== '/auth/callback') {
        response.writeHead(404); response.end(); return
      }
      const returnedState = callback.searchParams.get('state')
      if (login.consumed || pending !== login || typeof returnedState !== 'string' || !same(returnedState, state)
        || ['state', 'code', 'client_id', 'error'].some((key) => callback.searchParams.getAll(key).length > 1)) {
        localResponse(response, false); return
      }
      login.consumed = true; login.response = response
      void finishLogin(login, callback)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw failure('ChatGPT のログイン窓を開けませんでした。') }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
    const login: PendingLogin = { id: randomUUID(), generation: current, state, nonce, verifier, redirectUri,
      clientId: saved.registration?.clientId, server, controller: new AbortController(), consumed: false,
      timeout: setTimeout(() => {
        if (pending === login) { generation++; stopPending(); lastError = 'ChatGPT への接続が時間切れになりました。もう一度接続してください。' }
      }, options.loginTimeoutMs ?? 15 * 60_000) }
    login.timeout.unref()
    pending = login
    const url = new URL(AUTHORIZE)
    const params: Record<string, string> = { client_id: login.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: saved.hostId!, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES,
      resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') }
    if (!login.clientId) params.agent_name_hint = 'OPEN GROUND'
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return { authorizationUrl: url.href, loginId: login.id }
  })
  const cancelChatGptLogin = (loginId: string): Promise<void> => serializeLifecycle(async () => {
    if (pending?.id !== loginId) return
    generation++; stopPending(); clearModels(); lastError = undefined
  })
  const getChatGptAccessToken = async (): Promise<string> => {
    await assertNetwork()
    const current = generation
    const saved = await serializeStore(readStore)
    if (generation !== current) throw changed()
    if (!saved.registration || !saved.credentials) throw failure('ChatGPT に接続してください。')
    if (saved.credentials.expiresAt > now() + 60_000) return saved.credentials.accessToken
    if (refresh?.generation === current) return refresh.promise
    const promise = (async () => {
      const result = await jsonRequest(TOKEN, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: saved.registration!.clientId,
          refresh_token: saved.credentials!.refreshToken, resource: RESOURCE }),
      })
      const credentials = credentialsFrom(result, saved.credentials)
      if (typeof result.id_token === 'string') {
        const identity = await verifyIdentity(result.id_token, saved.registration!.clientId)
        if (identity.subject !== saved.registration!.identity?.subject) throw changed()
      }
      if (generation !== current) {
        await revoke(saved.registration!.clientId, credentials.refreshToken).catch(() => {})
        throw changed()
      }
      await serializeStore(async () => {
        if (generation !== current) throw changed()
        const latest = await readStore()
        if (latest.registration?.clientId !== saved.registration!.clientId
          || latest.credentials?.refreshToken !== saved.credentials!.refreshToken) throw changed()
        latest.credentials = credentials
        await writeStore(latest)
      })
      return credentials.accessToken
    })()
    refresh = { generation: current, promise }
    try { return await promise } finally { if (refresh?.promise === promise) refresh = undefined }
  }
  const listChatGptModels = async (): Promise<ChatGptModel[]> => {
    await assertNetwork()
    const current = generation
    if (modelCache?.generation === current && now() - modelCache.at < 60_000) return structuredClone(modelCache.models)
    if (modelRequest?.generation === current) return structuredClone(await modelRequest.promise)
    const controller = new AbortController()
    modelControllers.add(controller)
    const promise = (async () => {
      const token = await getChatGptAccessToken()
      if (generation !== current) throw changed()
      const result = await jsonRequest(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } }, controller.signal)
      if (generation !== current) throw changed()
      if (!Array.isArray(result.models)) throw failure('ChatGPT のモデル一覧を確認できませんでした。')
      const models: ChatGptModel[] = result.models.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== 'object') return []
        const m = entry as Record<string, unknown>
        if (m.visibility !== 'list' || typeof m.slug !== 'string' || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(m.slug)) return []
        const efforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.flatMap((e: unknown) => {
          const value = typeof e === 'string' ? e : e && typeof e === 'object' ? (e as Record<string, unknown>).effort : null
          return typeof value === 'string' && /^(none|minimal|low|medium|high|xhigh|max|ultra)$/.test(value) ? [value] : []
        }) : []
        return [{ id: m.slug, name: typeof m.display_name === 'string' ? m.display_name.slice(0, 200) : m.slug,
          ...(efforts.length ? { supportedEfforts: efforts } : {}) }]
      })
      modelCache = { generation: current, at: now(), models }
      return models
    })()
    modelRequest = { generation: current, promise }
    try { return structuredClone(await promise) } finally {
      modelControllers.delete(controller)
      if (modelRequest?.promise === promise) modelRequest = undefined
    }
  }
  const getChatGptConnection = async (): Promise<ChatGptConnection> => {
    try {
      const saved = await serializeStore(readStore)
      const email = saved.registration?.identity?.email
      if (pending) return { state: 'connecting', models: [], ...(email ? { email } : {}) }
      if (lastError) return { state: 'error', models: [], error: lastError, ...(email ? { email } : {}) }
      if (!saved.credentials) return { state: 'signed-out', models: [] }
      return { state: 'connected', models: await listChatGptModels(), ...(email ? { email } : {}) }
    } catch (error) { return { state: 'error', models: [], error: safeError(error) } }
  }
  const disconnectChatGpt = (): Promise<void> => serializeLifecycle(async () => {
    generation++; stopPending(); clearModels(); lastError = undefined
    clearChatGptCooling()
    const saved = await serializeStore(async () => {
      const data = await readStore()
      const credentials = data.credentials
      delete data.credentials
      await writeStore(data)
      return { registration: data.registration, credentials }
    })
    if (saved.registration && saved.credentials) {
      try { await revoke(saved.registration.clientId, saved.credentials.refreshToken) }
      catch { lastError = 'この端末では切断しました。ChatGPT 側の切断は確認できないため、ChatGPT の設定でも接続を解除してください。' }
    }
  })
  const getChatGptAccountKey = async (): Promise<string> => {
    const saved = await serializeStore(readStore)
    if (!saved.credentials || !saved.registration?.identity) throw failure('ChatGPT に接続してください。')
    return createHash('sha256').update(JSON.stringify([ISSUER, saved.registration.clientId,
      saved.registration.identity.subject])).digest('hex')
  }
  return { getChatGptConnection, getChatGptAccessToken, getChatGptAccountKey, beginChatGptLogin,
    cancelChatGptLogin, disconnectChatGpt, listChatGptModels }
}

const auth = createChatGptAuth()
export const getChatGptConnection = auth.getChatGptConnection
export const getChatGptAccessToken = auth.getChatGptAccessToken
export const getChatGptAccountKey = auth.getChatGptAccountKey
export const beginChatGptLogin = auth.beginChatGptLogin
export const cancelChatGptLogin = auth.cancelChatGptLogin
export const disconnectChatGpt = auth.disconnectChatGpt
export const listChatGptModels = auth.listChatGptModels
