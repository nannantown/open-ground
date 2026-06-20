// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  issueWorkerTicket,
  roomFor,
  readCollabWsUrl,
  workerHttpBase,
} from '../ticket'

// ZERO-CONFIG model: the loopback Hono no longer mints tickets — the HMAC secret
// lives only on the operator Worker. ticket.ts is now the RELAY CLIENT: it
// presents the caller's Supabase access token to the Worker's POST /ticket
// (server-to-server) and forwards the Worker-minted credential. These tests pin
// the relay (request shape, the token never appearing in the response, and every
// failure folding to a status the route maps) plus the two pure derivations the
// routes still need (roomFor, workerHttpBase). The mint→verify wire format itself
// moved wholesale to worker/src/* and is tested there.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('issueWorkerTicket — relay to the Worker POST /ticket', () => {
  it('presents the access token as a Bearer + {pid,scope} body to <worker>/ticket', async () => {
    const spy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ room: 'pid-1:board', token: 'aGVhZA.c2ln', expiresAt: 123 }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', spy as unknown as typeof fetch)

    const res = await issueWorkerTicket('wss://w.example.dev', 'ACCESS-TOKEN', 'pid-1', 'board')
    expect(res).toEqual({
      ok: true,
      ticket: { room: 'pid-1:board', token: 'aGVhZA.c2ln', expiresAt: 123 },
    })

    // The token travels ONLY in this server-to-server request (a Bearer header),
    // and the call targets the Worker's HTTP origin + /ticket.
    const [url, init] = spy.mock.calls[0]
    expect(url).toBe('https://w.example.dev/ticket')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer ACCESS-TOKEN')
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(init!.body as string)).toEqual({ pid: 'pid-1', scope: 'board' })
  })

  it('carries a canvas scope verbatim in the relayed body', async () => {
    const spy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ room: 'p:canvas:x', token: 'a.b', expiresAt: 1 }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', spy as unknown as typeof fetch)
    await issueWorkerTicket('wss://w.example.dev', 't', 'p', 'canvas:x')
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      pid: 'p',
      scope: 'canvas:x',
    })
  })

  it('maps a Worker 403 (membership rejected) to { ok:false, status:403 }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch,
    )
    expect(await issueWorkerTicket('wss://w.example.dev', 't', 'p', 'board')).toEqual({
      ok: false,
      status: 403,
    })
  })

  it('folds any other non-2xx (401/400/503/5xx) to a 502 upstream failure', async () => {
    for (const status of [400, 401, 500, 503]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('x', { status })) as unknown as typeof fetch,
      )
      expect(await issueWorkerTicket('wss://w.example.dev', 't', 'p', 'board')).toEqual({
        ok: false,
        status: 502,
      })
    }
  })

  it('folds a network throw to a 502 (never throws into the route)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    )
    expect(await issueWorkerTicket('wss://w.example.dev', 't', 'p', 'board')).toEqual({
      ok: false,
      status: 502,
    })
  })

  it('rejects a 200 with a malformed/incomplete body as a 502', async () => {
    // Missing token / wrong types — anything not { room:string, token:string,
    // expiresAt:number } is unusable and must not reach the browser as "ok".
    for (const body of [
      {},
      { room: 'r', token: 'a.b' }, // no expiresAt
      { room: 'r', token: 123, expiresAt: 1 }, // token not a string
      'not json at all',
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }),
        ) as unknown as typeof fetch,
      )
      const res = await issueWorkerTicket('wss://w.example.dev', 't', 'p', 'board')
      expect(res).toEqual({ ok: false, status: 502 })
    }
  })
})

describe('workerHttpBase — WS endpoint → Worker HTTP origin', () => {
  it('maps ws/wss → http/https and keeps only the origin', () => {
    expect(workerHttpBase('wss://og-collab.acct.workers.dev')).toBe(
      'https://og-collab.acct.workers.dev',
    )
    expect(workerHttpBase('ws://localhost:8787')).toBe('http://localhost:8787')
    // A path on the WS URL is dropped — the relay/asset routes append their own.
    expect(workerHttpBase('wss://w.example.dev/parties/og-collab-doc/x')).toBe(
      'https://w.example.dev',
    )
  })

  it('accepts http/https verbatim and a bare host (defaults to https)', () => {
    expect(workerHttpBase('https://w.example.dev')).toBe('https://w.example.dev')
    expect(workerHttpBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(workerHttpBase('og-collab.acct.workers.dev')).toBe('https://og-collab.acct.workers.dev')
  })
})

describe('roomFor — shared room derivation (both sides must match)', () => {
  it('joins collabProjectId + scope with a colon', () => {
    expect(roomFor('proj-1', 'board')).toBe('proj-1:board')
    expect(roomFor('proj-1', 'canvas:abc')).toBe('proj-1:canvas:abc')
  })
})

describe('readCollabWsUrl — graceful degrade', () => {
  it('null when unset, trimmed value when set', () => {
    delete process.env.OPENGROUND_COLLAB_WS_URL
    expect(readCollabWsUrl()).toBeNull()
    vi.stubEnv('OPENGROUND_COLLAB_WS_URL', '  wss://w.example.dev  ')
    expect(readCollabWsUrl()).toBe('wss://w.example.dev')
    vi.stubEnv('OPENGROUND_COLLAB_WS_URL', '   ')
    expect(readCollabWsUrl()).toBeNull() // blank → null
  })
})
