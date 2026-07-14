// lockdown.ts — work mode (業務モード): the one-toggle kill switch for every
// NON-Anthropic external egress this process makes.
//
// WHY: OPEN GROUND is used on confidential work machines. The owner needs a
// single observable switch that guarantees "nothing leaves this machine except
// the user's own claude subscription traffic". Two layers enforce it, both
// in-process (no external proxy / OS sandbox — that is a separate concern):
//
//   LAYER 1 — feature gates. Every feature that talks to the internet
//   (auto-update check, release notes, feedback, marketplace, Supabase auth,
//   collab) consults isLockdownEnabled() (store.ts) at its route/config seam
//   and reports itself unavailable, so the UI hides its entry points and the
//   code path that would fetch is never reached. Observable per feature.
//
//   LAYER 2 — the fetch floor. installLockdownFetchGuard() wraps this server
//   process's global fetch: while lockdown is ON, any http(s) request to a
//   non-loopback, non-Anthropic host throws instead of connecting. This is the
//   backstop for a call site layer 1 missed (today or in a future edit).
//
// Anthropic egress is deliberately allowed THROUGH the floor: the product is
// subscription-only (the user's own `claude` CLI), and lockdown must never
// break it. The claude CLI runs as a CHILD PROCESS with its own networking —
// the floor doesn't apply to it — but the allowlist keeps any future in-process
// Anthropic call working too. The allowlist is shared with the overseer's
// egress proxy (egressProxy.BRAIN_EGRESS_ALLOW_HOSTS) so "what counts as
// Anthropic" lives in exactly one place.
//
// The persisted switch is Settings.lockdownMode (settings.json, user-settable
// via POST /api/settings). This module holds only the SYNCHRONOUS mirror + the
// floor; the authoritative async reader isLockdownEnabled() lives in store.ts
// beside the other settings readers — store.ts mirrors the flag here on every
// read/write (the swarmAllowedModels cache pattern), and this module never
// imports store, so there is no import cycle.

import { BRAIN_EGRESS_ALLOW_HOSTS, isEgressHostAllowed } from './egressProxy'

// ─── The synchronous mirror ───────────────────────────────────────────────────

// globalThis so `tsx watch` reloads in dev keep the last-known value (same
// pattern as the terminal pool / the allowed-model tiers cache).
const g = globalThis as typeof globalThis & {
  __openground_lockdown?: { on: boolean }
}

/** Mirror the persisted switch for synchronous readers (the fetch floor).
 *  Called by store.ts on every settings read/write — never call it with a
 *  value that didn't come from settings.json. */
export const setLockdownCache = (on: unknown): void => {
  g.__openground_lockdown = { on: on === true }
}

/** Synchronous last-known value. false until the first settings read — the
 *  safe direction for a DEFAULT-OFF switch (a not-yet-mirrored boot behaves
 *  like the shipped default; installLockdownFetchGuard() warms the mirror
 *  before the server accepts requests). */
export const isLockdownEnabledSync = (): boolean => g.__openground_lockdown?.on === true

// ─── The fetch floor (layer 2) ────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** May this URL be fetched while lockdown is ON? Loopback (the app talking to
 *  itself) and Anthropic hosts pass; every other http(s) host is refused.
 *  Non-http(s) schemes (data:, blob:) pass — they never leave the process.
 *  An unparseable URL is refused (fail closed; the real fetch would reject it
 *  anyway). */
export const isEgressAllowedUnderLockdown = (rawUrl: string): boolean => {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
  const host = u.hostname.toLowerCase()
  if (LOOPBACK_HOSTS.has(host)) return true
  return isEgressHostAllowed(host, BRAIN_EGRESS_ALLOW_HOSTS)
}

/** The URL string of a fetch() input, however it was passed. */
const urlOfFetchInput = (input: unknown): string | null => {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') {
    return (input as { url: string }).url
  }
  return null
}

/** Thrown by the floor so callers (and tests) can tell "blocked by lockdown"
 *  from a genuine network failure. Every existing call site already treats a
 *  fetch rejection as "service unreachable", so blocking degrades exactly like
 *  being offline — no new failure mode. */
export class LockdownEgressError extends Error {
  constructor(host: string) {
    super(`lockdown mode: external egress blocked (${host})`)
    this.name = 'LockdownEgressError'
  }
}

/** Wrap this process's global fetch with the lockdown floor. Idempotent (a
 *  globalThis marker survives tsx-watch reloads, so the wrapper never stacks).
 *  Warms the synchronous mirror with one settings read first (dynamic import —
 *  store.ts imports this module, so a static import would be a cycle) so no
 *  request can race a cold mirror. Installed from the server entry
 *  (server/index.ts); tests install/restore explicitly via the returned
 *  uninstall. */
export const installLockdownFetchGuard = async (): Promise<() => void> => {
  const marker = globalThis as typeof globalThis & {
    __openground_lockdown_fetch_guard?: boolean
  }
  // getSettings mirrors lockdownMode here via setLockdownCache.
  await (await import('./store')).getSettings()
  if (marker.__openground_lockdown_fetch_guard) return () => {}
  marker.__openground_lockdown_fetch_guard = true

  const realFetch = globalThis.fetch.bind(globalThis)
  const guarded = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (isLockdownEnabledSync()) {
      const url = urlOfFetchInput(input)
      if (url === null || !isEgressAllowedUnderLockdown(url)) {
        let host = 'invalid-url'
        try {
          host = new URL(url ?? '').hostname
        } catch {
          /* keep the placeholder */
        }
        throw new LockdownEgressError(host)
      }
    }
    return realFetch(input, init)
  }) as typeof fetch
  globalThis.fetch = guarded

  return () => {
    globalThis.fetch = realFetch
    marker.__openground_lockdown_fetch_guard = false
  }
}
