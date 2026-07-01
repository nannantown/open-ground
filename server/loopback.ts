// Loopback-origin helpers — the shared primitives behind the CSRF / DNS-rebinding
// guard. Extracted from server/app.ts so route modules can reuse the SAME check
// without importing app.ts (which would create an app ↔ route import cycle).
//
// OPEN GROUND binds to loopback (127.0.0.1) and is a LOCAL single-user tool, so
// every legitimate caller is either its own SPA (same-origin in prod :47776, or
// the Vite dev origin :5174 that proxies here — both LOOPBACK) or a local
// non-browser client (vitest via app.request(), curl, EventSource) that sends NO
// Origin/Host header. A browser ALWAYS attaches a Host header, and for a
// cross-origin state-changing request an Origin header too — so a page on the
// open internet (incl. one that DNS-rebinds a domain to 127.0.0.1) is detectable
// by a non-loopback Host/Origin.

export const isLoopbackHostname = (hostname: string): boolean => {
  const h = hostname.toLowerCase()
  // new URL().hostname returns IPv6 WITH brackets ([::1]); accept both forms.
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

export const originIsLocal = (origin: string): boolean => {
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false // unparseable Origin → treat as foreign (reject)
  }
}

export const hostIsLocal = (host: string): boolean => {
  try {
    // Host has no scheme (e.g. "127.0.0.1:47776"); wrap it so URL can parse it.
    return isLoopbackHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}
