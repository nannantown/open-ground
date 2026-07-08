// egressProxy — a host-side, allowlist-only HTTP CONNECT proxy on 127.0.0.1.
//
// This is the "egress-proxy follow-up" docs/SANDBOX_EXPERIMENT.md names: Seatbelt
// cannot filter outbound by HOSTNAME, so a sandboxed process that must reach ONE
// approved service gets `network: 'loopback'` (sandbox.ts — every off-machine
// destination kernel-denied) plus HTTPS_PROXY pointed here; the DOMAIN decision
// then happens OUTSIDE the sandbox, in this process. The overseer brain is the
// user: it holds the private you-corpus in context, so its claude may reach
// Anthropic (the subscription endpoint) and NOTHING else — a prompt-injected
// brain trying any other host is refused twice (kernel EPERM on a direct
// connect; 403 here on a proxied one), and the refusal is LOGGED (an exfil
// attempt is a signal, not just an error).
//
// CONNECT-only: claude→Anthropic is pure TLS-over-443. Plain HTTP requests are
// refused (403) — nothing the brain legitimately does needs cleartext HTTP.
// Loopback-bound + allowlisted, so this is NOT an open relay: it grants a local
// process nothing it couldn't already do un-sandboxed (any local process can
// reach Anthropic directly); its sole purpose is to be the ONE hole the
// loopback-confined brain can use.

import { createServer, type Server } from 'http'
import { connect as netConnect } from 'net'

/** Domains the BRAIN's claude may CONNECT to — the subscription path and nothing
 *  else. Suffix-matched (subdomains included): `anthropic.com` covers
 *  api/statsig/console.anthropic.com; `claude.ai` covers the OAuth token refresh
 *  a subscription session may perform. Error-reporting hosts (sentry etc.) are
 *  deliberately ABSENT — a corpus-holding process sends telemetry nowhere; a
 *  refused CONNECT fails fast (403), it does not hang the client. */
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

// ── The brain's singleton (survives tsx-watch reloads — the globalThis pattern) ──

interface EgressProxyGlobal {
  __openground_brain_egress_proxy?: Promise<EgressProxyHandle>
}
const G = globalThis as unknown as EgressProxyGlobal

/** The ONE brain egress proxy, lazily started on first use. A failed start is NOT
 *  cached (a later call retries); the caller treats a rejection as "no proxy" and
 *  fails CLOSED (no brain launch without the sandbox+proxy pair on darwin). */
export const ensureBrainEgressProxy = (): Promise<EgressProxyHandle> => {
  if (!G.__openground_brain_egress_proxy) {
    G.__openground_brain_egress_proxy = createEgressProxy({
      allowHosts: BRAIN_EGRESS_ALLOW_HOSTS,
    }).catch((e: unknown) => {
      G.__openground_brain_egress_proxy = undefined
      throw e
    })
  }
  return G.__openground_brain_egress_proxy
}
