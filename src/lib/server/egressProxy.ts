// Shared provider-host policy and an explicit loopback CONNECT proxy factory.
// Work mode uses the allowlist/matcher without opening a listener. The sandbox
// diagnostic calls createEgressProxy to test a loopback-only profile: Seatbelt
// blocks direct off-machine connections and this host-side proxy filters domains.
// There is no app singleton or Persona caller. CONNECT defaults to TLS port 443;
// plain HTTP is refused and every listener binds only to 127.0.0.1.

import { createServer, type Server } from 'http'
import { connect as netConnect } from 'net'

/** Legacy name for the provider allowlist shared with Work mode. Exact hosts
 *  and subdomains match; other telemetry/error-reporting hosts remain excluded.
 *  Keep this policy independent of whether a diagnostic proxy is running. */
export const BRAIN_EGRESS_ALLOW_HOSTS: readonly string[] = ['anthropic.com', 'claude.ai']

export interface EgressProxyOptions {
  /** Host allowlist: a CONNECT target matches when it equals an entry or is a
   *  subdomain of one (case-insensitive). Anything else → 403. */
  allowHosts: readonly string[]
  /** Destination ports allowed through. Default [443] — claude→Anthropic is pure
   *  TLS; nothing legitimate needs another port. (Tests widen this to reach a
   *  local ephemeral-port target.) */
  allowPorts?: readonly number[]
  /** Refusals/errors sink (default console.warn) — a confined process probing a
   *  non-allowlisted host is a SIGNAL, never swallowed silently. */
  log?: (message: string) => void
}

export interface EgressProxyHandle {
  /** The ephemeral 127.0.0.1 port the proxy listens on (for HTTPS_PROXY). */
  port: number
  close: () => Promise<void>
}

/** Does `host` match the allowlist (exact or subdomain, case-insensitive)?
 *  A trailing dot (a legal absolute FQDN — `api.anthropic.com.`) is stripped
 *  first so it can't dodge the suffix match. Exported for unit tests. */
export const isEgressHostAllowed = (host: string, allowHosts: readonly string[]): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '')
  return allowHosts.some((d) => {
    const dom = d.toLowerCase()
    return h === dom || h.endsWith(`.${dom}`)
  })
}

/** Parse a CONNECT request-target (`host:port`, or `[v6]:port`) → {host, port},
 *  else null. Exported for unit tests. */
export const parseConnectTarget = (url: string): { host: string; port: number } | null => {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(url) ?? /^([^:[\]]+):(\d{1,5})$/.exec(url)
  if (!m) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: m[1], port }
}

/** Start a CONNECT proxy on an ephemeral 127.0.0.1 port. The returned handle's
 *  close() tears down the listener AND every live tunnel. */
export const createEgressProxy = (opts: EgressProxyOptions): Promise<EgressProxyHandle> => {
  const log = opts.log ?? ((m: string) => console.warn(m))
  const allowPorts = opts.allowPorts ?? [443]
  const server: Server = createServer((req, res) => {
    // Plain (non-CONNECT) HTTP is never legitimate here — refuse it outright.
    log(`egress-proxy: REFUSED ${req.method ?? '?'} ${req.url ?? ''} (CONNECT-only)`)
    res.statusCode = 403
    res.end('CONNECT only\n')
  })
  // net.Socket upstream + the Duplex Node types the CONNECT client socket as.
  const tunnels = new Set<import('stream').Duplex>()

  server.on('connect', (req, clientSocket, head) => {
    const target = parseConnectTarget(req.url ?? '')
    const allowed =
      target !== null &&
      isEgressHostAllowed(target.host, opts.allowHosts) &&
      allowPorts.includes(target.port)
    if (!target || !allowed) {
      log(`egress-proxy: REFUSED CONNECT ${req.url ?? '(no target)'}`)
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.destroy()
      return
    }
    const upstream = netConnect({ host: target.host, port: target.port })
    tunnels.add(clientSocket)
    tunnels.add(upstream)
    const drop = (): void => {
      tunnels.delete(clientSocket)
      tunnels.delete(upstream)
      clientSocket.destroy()
      upstream.destroy()
    }
    let established = false
    upstream.on('connect', () => {
      established = true
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', (e) => {
      log(`egress-proxy: upstream error for ${req.url}: ${e.message}`)
      // A status line is only meaningful before the 200 handshake went out;
      // afterwards the tunnel just drops.
      if (!established) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      drop()
    })
    clientSocket.on('error', drop)
    upstream.on('close', drop)
    clientSocket.on('close', drop)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Loopback-bound: never reachable off-machine.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('egress-proxy: no listen address'))
        return
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            tunnels.forEach((s) => s.destroy())
            tunnels.clear()
            server.close(() => res())
          }),
      })
    })
  })
}
