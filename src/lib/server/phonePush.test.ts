// The APNs side of waking the phone (phonePush.ts): what is stored, the
// provider token, and the HTTP/2 request as a real HTTP/2 server receives it.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { generateKeyPairSync, verify } from 'node:crypto'
import { statSync, rmSync } from 'node:fs'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { openGroundHome } from './paths'
import { setLockdownCache } from './lockdown'
import { JWT_REFRESH_MS, dropProviderToken, providerToken, pushTokenGone, readPushKey, savePushKey, sendPushToTalk, type PushKey } from './phonePush'

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const KEY: PushKey = { v: 1, keyId: 'ABC123DEFG', teamId: 'TEAM123456', p8: P8 }
const TARGET = { token: 'a1'.repeat(32), env: 'production' as const, topic: 'com.nannantown.openground.phone.voip-ptt' }

const parts = (jwt: string) => jwt.split('.').map((p, i) => (i < 2 ? JSON.parse(Buffer.from(p, 'base64url').toString()) : p))

beforeEach(() => {
  dropProviderToken()
  rmSync(join(openGroundHome(), 'phone-push-key.json'), { force: true })
})

describe('the owner APNs key', () => {
  it('is checked, then kept on this Mac only (0600)', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(await savePushKey({ p8: P8, keyId: 'short', teamId: KEY.teamId })).toEqual({ error: 'bad-key-id' })
    expect(await savePushKey({ p8: P8, keyId: KEY.keyId, teamId: 'x' })).toEqual({ error: 'bad-team-id' })
    expect(await savePushKey({ p8: 'not a key', keyId: KEY.keyId, teamId: KEY.teamId })).toEqual({ error: 'bad-key' })
    expect(await savePushKey({ p8: rsa, keyId: KEY.keyId, teamId: KEY.teamId })).toEqual({ error: 'bad-key' })
    expect(await readPushKey()).toBeNull()
    expect(await savePushKey({ p8: `\n${P8}\n`, keyId: ' abc123defg ', teamId: KEY.teamId })).toEqual({ ok: true })
    expect(await readPushKey()).toEqual({ ...KEY, p8: P8.trim() })
    expect(statSync(join(openGroundHome(), 'phone-push-key.json')).mode & 0o777).toBe(0o600)
  })
})

describe('the provider token (JWT)', () => {
  it('is ES256 with the key id, signed by the key, and claims the team', () => {
    const t0 = 1_790_000_000_000
    const jwt = providerToken(KEY, t0)
    const [header, claims, sig] = parts(jwt)
    expect(header).toEqual({ alg: 'ES256', kid: KEY.keyId })
    expect(claims).toEqual({ iss: KEY.teamId, iat: t0 / 1000 })
    const input = jwt.slice(0, jwt.lastIndexOf('.'))
    expect(verify('sha256', Buffer.from(input), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true)
  })

  it('is reused for 30 min (Apple: not more often than every 20, not less than every 60), then made again', () => {
    expect(JWT_REFRESH_MS).toBeGreaterThanOrEqual(20 * 60_000)
    expect(JWT_REFRESH_MS).toBeLessThan(60 * 60_000)
    const t0 = 1_790_000_000_000
    const first = providerToken(KEY, t0)
    expect(providerToken(KEY, t0 + 20 * 60_000)).toBe(first)
    expect(providerToken(KEY, t0 + JWT_REFRESH_MS - 1)).toBe(first)
    const next = providerToken(KEY, t0 + JWT_REFRESH_MS)
    expect(next).not.toBe(first)
    expect(parts(next)[1].iat).toBe((t0 + JWT_REFRESH_MS) / 1000)
    // A corrected .p8 under the same IDs signs anew at once.
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(providerToken({ ...KEY, p8: other }, t0 + JWT_REFRESH_MS)).not.toBe(next)
    // A different key never gets the old key's token.
    expect(parts(providerToken({ ...KEY, keyId: 'ZZZ999ZZZZ' }, t0 + JWT_REFRESH_MS))[0].kid).toBe('ZZZ999ZZZZ')
  })
})

describe('the push request, as an HTTP/2 server receives it', () => {
  const got: { headers: http2.IncomingHttpHeaders; body: string }[] = []
  let reply: { status: number; body?: string } = { status: 200 }
  const server = http2.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      got.push({ headers: req.headers, body })
      res.writeHead(reply.status)
      res.end(reply.body ?? '')
    })
  })
  const listening = new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
  const origin = () => listening
  afterAll(() => server.close())

  it('is a pushtotalk POST to /3/device/<token>, bearer-signed, carrying nothing readable', async () => {
    const at = await origin()
    expect(await sendPushToTalk(KEY, TARGET, at)).toEqual({ status: 200 })
    const { headers, body } = got[0]
    expect(headers[':method']).toBe('POST')
    expect(headers[':path']).toBe(`/3/device/${TARGET.token}`)
    expect(headers['apns-push-type']).toBe('pushtotalk')
    expect(headers['apns-topic']).toBe(TARGET.topic)
    expect(headers['apns-priority']).toBe('10')
    expect(headers['apns-expiration']).toBe('0')
    expect(headers.authorization).toBe(`bearer ${providerToken(KEY)}`)
    expect(JSON.parse(body)).toEqual({ aps: {} })
  })

  it('reads Apple refusals: 410 and BadDeviceToken mean the token is dead, others do not', async () => {
    const at = await origin()
    reply = { status: 410, body: JSON.stringify({ reason: 'Unregistered', timestamp: 1 }) }
    const gone = await sendPushToTalk(KEY, TARGET, at)
    expect(gone).toEqual({ status: 410, reason: 'Unregistered' })
    expect(pushTokenGone(gone)).toBe(true)
    reply = { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) }
    expect(pushTokenGone(await sendPushToTalk(KEY, TARGET, at))).toBe(true)
    reply = { status: 400, body: JSON.stringify({ reason: 'BadTopic' }) }
    expect(pushTokenGone(await sendPushToTalk(KEY, TARGET, at))).toBe(false)
    reply = { status: 429, body: JSON.stringify({ reason: 'TooManyRequests' }) }
    expect(pushTokenGone(await sendPushToTalk(KEY, TARGET, at))).toBe(false)
  })

  it('under work mode no HTTP/2 request is made at all', async () => {
    const at = await origin()
    const before = got.length
    setLockdownCache(true)
    try {
      expect(await sendPushToTalk(KEY, TARGET, at)).toEqual({ status: 0, reason: 'lockdown' })
    } finally {
      setLockdownCache(false)
    }
    expect(got.length).toBe(before)
  })

  it('an unreachable APNs host is an answer, not a hang', async () => {
    expect(await sendPushToTalk(KEY, TARGET, 'http://127.0.0.1:1')).toMatchObject({ status: 0 })
  })
})
