// deepLink.ts — parse OPEN GROUND custom-scheme deep links.
//
// The desktop app registers the `openground://` protocol (Electron
// setAsDefaultProtocolClient + electron-builder `protocols`). An invite link is
//   openground://join?code=<token>
// Clicking it focuses the app and routes here to pre-fill / auto-redeem the code in
// the "Shared with me" dialog. This module is the PURE, side-effect-free parser
// shared by the renderer hook (src/lib/useJoinDeepLink.ts) — kept separate so it is
// trivially unit-testable and carries no Electron/React imports.

// A defensive ceiling so a pathological URL can't carry an enormous "code". A real
// invite code is a 43-char base64url string (256-bit); allow generous headroom for
// any future format without accepting unbounded input.
const MAX_CODE_LEN = 512

// Parse an `openground://join?code=…` deep link → the invite code, or null if the
// URL is not a well-formed join link of our scheme. Accepts the action either as
// the authority (`openground://join?code=…`) or the first path segment
// (`openground://x/join?code=…` / `openground:join?code=…`). Never throws.
export const parseJoinDeepLink = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!/^openground:/i.test(s)) return null

  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol.toLowerCase() !== 'openground:') return null

  // The "join" action can land as the host (openground://join?…) or as a path
  // segment (openground://x/join?… or openground:join?…). Only `join` is supported.
  const host = u.hostname.toLowerCase()
  const path = u.pathname.replace(/^\/+/, '').toLowerCase()
  const isJoin = host === 'join' || path === 'join' || path.startsWith('join/')
  if (!isJoin) return null

  const code = u.searchParams.get('code')?.trim()
  if (!code || code.length > MAX_CODE_LEN) return null
  return code
}
