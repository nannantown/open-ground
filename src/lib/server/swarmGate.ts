// swarmGate.ts — the swarm control plane's access gate: owner app-login OR an
// explicit LOCAL unlock. A dedicated seam so the swarm gate stays separate from
// the marketplace/custom-tab role machinery (roles.ts): the marketplace routes
// (customModules / moduleSubmissions) keep gating on the signed-in role and
// NEVER honour the local unlock — they publish to Supabase, where a signed-out
// caller has no JWT and could do nothing real anyway; keeping the gates apart
// keeps their meanings apart.
//
// WHY A LOCAL UNLOCK IS SAFE — the swarm owner gate is a feature-VISIBILITY
// flag, not a security boundary: the core PTY route (POST /api/terminal)
// already spawns a login shell in any REGISTERED project with no role gate at
// all (only validateProjectPath), and the whole API binds to 127.0.0.1. A
// local process can therefore already run arbitrary commands in registered
// projects without ever touching swarm. Unlocking swarm for local signed-out
// use (業務モード = app-login disabled) adds NO attack surface; it only
// reveals the swarm control plane, which drives the same interactive `claude`
// PTYs. Full rationale + how-to: docs/SECURITY.md (business-mode section).
//
// UNLOCK SOURCES — SERVER-LOCAL STATE ONLY, never anything the request carries
// (header / body / query):
//   1. env  OPENGROUND_LOCAL_OWNER=1          (exact string '1')
//   2. settings.json  "swarmLocalOwner": true (~/.openground/settings.json,
//      edited BY HAND — the key is deliberately NOT in USER_SETTINGS_KEYS
//      (store.ts), so POST /api/settings can never flip it)
// Default: locked. Nothing configured ⇒ the gate is owner-login-only, exactly
// the behaviour before this seam existed (swarmSafety.routes.test.ts pins it).

import { getCustomTabRole } from './roles'
import { getSettings } from './store'

/** The explicit local unlock: env var or a hand-edited settings.json flag.
 *  Both are server-local; no request value can reach either. */
export const isSwarmLocalOwnerUnlocked = async (): Promise<boolean> => {
  if (process.env.OPENGROUND_LOCAL_OWNER === '1') return true
  return (await getSettings()).swarmLocalOwner === true
}

/** May this caller drive the swarm control plane? Local unlock first (cheap,
 *  disk-only); otherwise the signed-in owner role (roles.ts — may consult
 *  Supabase). Every /api/swarm route gates on this. */
export const hasSwarmOwnerAccess = async (): Promise<boolean> =>
  (await isSwarmLocalOwnerUnlocked()) || (await getCustomTabRole()) === 'owner'
