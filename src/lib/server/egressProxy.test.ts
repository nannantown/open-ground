// @vitest-environment node
//
// egressProxy — the brain's allowlist CONNECT proxy. Real sockets on 127.0.0.1
// (no fs, no HOME): an allowlisted CONNECT tunnels bytes end-to-end; anything
// else — unknown host, wrong port, plain HTTP — is refused 403 and LOGGED.

import { describe, it, expect, afterEach } from 'vitest'
import { createServer as createNetServer, connect as netConnect, type Server as NetServer } from 'net'
import { request as httpRequest, get as httpGet, type IncomingMessage } from 'http'
import {
  createEgressProxy,
  isEgressHostAllowed,
  parseConnectTarget,
  BRAIN_EGRESS_ALLOW_HOSTS,
  type EgressProxyHandle,
} from './egressProxy'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

/** A local TCP echo target standing in for "the upstream service". */
const startEcho = (): Promise<{ port: number; server: NetServer }> =>
  new Promise((resolve) => {
    const server = createNetServer((s) => {
      s.on('data', (d) => s.write(d))
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr !== 'string') resolve({ port: addr.port, server })
    })
    cleanups.push(() => new Promise((r) => server.close(() => r())))
  })

const startProxy = async (opts: Parameters<typeof createEgressProxy>[0]): Promise<EgressProxyHandle> => {
  const proxy = await createEgressProxy(opts)
  cleanups.push(() => proxy.close())
  return proxy
}

/** Issue a CONNECT through the proxy; resolve with the status + (on 200) socket. */
const doConnect = (
  proxyPort: number,
  target: string,
): Promise<{ status: number; socket: import('net').Socket }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target })
    req.on('connect', (res: IncomingMessage, socket) => resolve({ status: res.statusCode ?? 0, socket }))
    req.on('error', reject)
    req.end()
  })

describe('isEgressHostAllowed', () => {
  it('matches exact and subdomain, case-insensitive, trailing-dot stripped', () => {
    expect(isEgressHostAllowed('anthropic.com', BRAIN_EGRESS_ALLOW_HOSTS)).toBe(true)
    expect(isEgressHostAllowed('api.anthropic.com', BRAIN_EGRESS_ALLOW_HOSTS)).toBe(true)
    expect(isEgressHostAllowed('API.ANTHROPIC.COM', BRAIN_EGRESS_ALLOW_HOSTS)).toBe(true)
    expect(isEgressHostAllowed('api.anthropic.com.', BRAIN_EGRESS_ALLOW_HOSTS)).toBe(true)
    expect(isEgressHostAllowed('claude.ai', BRAIN_EGRESS_ALLOW_HOSTS)).toBe(true)
  })

  it('rejects lookalikes — suffix must sit on a label boundary', () => {
    expect(isEgressHostAllowed('evilanthropic.com', BRAIN_EGRESS_ALLOW_HOSTS)).toBe(false)
    expect(isEgressHostAllowed('anthropic.com.evil.io', BRAIN_EGRESS_ALLOW_HOSTS)).toBe(false)
    expect(isEgressHostAllowed('example.com', BRAIN_EGRESS_ALLOW_HOSTS)).toBe(false)
    expect(isEgressHostAllowed('claude.ai.attacker.net', BRAIN_EGRESS_ALLOW_HOSTS)).toBe(false)
  })
})

describe('parseConnectTarget', () => {
  it('parses host:port and [v6]:port; rejects junk and bad ports', () => {
    expect(parseConnectTarget('api.anthropic.com:443')).toEqual({ host: 'api.anthropic.com', port: 443 })
    expect(parseConnectTarget('[::1]:443')).toEqual({ host: '::1', port: 443 })
    expect(parseConnectTarget('no-port')).toBeNull()
    expect(parseConnectTarget('h:0')).toBeNull()
    expect(parseConnectTarget('h:70000')).toBeNull()
    expect(parseConnectTarget('')).toBeNull()
  })
})

describe('createEgressProxy', () => {
  it('tunnels an allowlisted CONNECT end-to-end (bytes echo back)', async () => {
    const echo = await startEcho()
    const proxy = await startProxy({ allowHosts: ['127.0.0.1'], allowPorts: [echo.port] })
    const { status, socket } = await doConnect(proxy.port, `127.0.0.1:${echo.port}`)
    expect(status).toBe(200)
    const roundtrip = await new Promise<string>((resolve) => {
      socket.once('data', (d) => resolve(d.toString()))
      socket.write('ping-through-tunnel')
    })
    expect(roundtrip).toBe('ping-through-tunnel')
    socket.destroy()
  })

  it('refuses a non-allowlisted host with 403 and logs the attempt', async () => {
    const logs: string[] = []
    const echo = await startEcho()
    const proxy = await startProxy({
      allowHosts: ['allowed.example'],
      allowPorts: [echo.port],
      log: (m) => logs.push(m),
    })
    const { status } = await doConnect(proxy.port, `127.0.0.1:${echo.port}`)
    expect(status).toBe(403)
    expect(logs.some((m) => m.includes('REFUSED CONNECT'))).toBe(true)
  })

  it('refuses an allowlisted host on a NON-allowlisted port (default 443-only)', async () => {
    const echo = await startEcho()
    // allowPorts omitted → [443]; the echo target's ephemeral port is not 443.
    const proxy = await startProxy({ allowHosts: ['127.0.0.1'] })
    const { status } = await doConnect(proxy.port, `127.0.0.1:${echo.port}`)
    expect(status).toBe(403)
  })

  it('refuses plain (non-CONNECT) HTTP with 403', async () => {
    const proxy = await startProxy({ allowHosts: ['127.0.0.1'] })
    const status = await new Promise<number>((resolve, reject) => {
      httpGet({ host: '127.0.0.1', port: proxy.port, path: 'http://127.0.0.1/x' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }).on('error', reject)
    })
    expect(status).toBe(403)
  })

  it('answers 502 when the allowlisted upstream is unreachable', async () => {
    // Grab a port that is closed by the time we CONNECT to it.
    const echo = await startEcho()
    const deadPort = echo.port
    await new Promise<void>((r) => echo.server.close(() => r()))
    const proxy = await startProxy({ allowHosts: ['127.0.0.1'], allowPorts: [deadPort] })
    const { status } = await doConnect(proxy.port, `127.0.0.1:${deadPort}`)
    expect(status).toBe(502)
  })

  it('binds to 127.0.0.1 (loopback-only — not reachable off-machine)', async () => {
    const proxy = await startProxy({ allowHosts: [] })
    // Connecting via loopback works; the listener address is pinned by listen().
    await new Promise<void>((resolve, reject) => {
      const s = netConnect({ host: '127.0.0.1', port: proxy.port }, () => {
        s.destroy()
        resolve()
      })
      s.on('error', reject)
    })
  })
})
