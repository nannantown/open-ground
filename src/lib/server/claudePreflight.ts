// claudePreflight.ts — the shared run-gate every route that SPAWNS `claude`
// goes through. A `claude` started while the CLI is signed OUT opens claude's
// OWN OAuth browser at runtime (claude manages its auth, OPEN GROUND only
// reflects it). The run routes used to gate on `.installed` ONLY, so a
// distributed build — which is commonly installed:true / loggedIn:false — spawned
// a signed-out claude on every run and the OAuth browser opened. Worse, a single
// 実行 fans out to 2+ spawns (the task itself + the fire-and-forget auto-title),
// each opening its own browser, so it read as "the approval screen opens in an
// endless loop". (Full diagnosis: REPORT_FIX.md / the w3-0619-095342 REPORT.md.)
//
// Gating on installed && loggedIn stops every implicit/automatic spawn BEFORE it
// reaches launchClaude, and hands the client a machine-readable flag so it can
// surface a SINGLE "sign in to Claude" affordance instead of N silent browser
// tabs:
//   - claudeMissing  → CLI not installed at all
//   - claudeLoggedOut → installed but signed out (the new distributed-build case)
//
// subscription-only is preserved: we still never touch an API key. The ONE place
// a signed-out claude may still spawn is the dedicated /api/terminal/claude-login
// route, which gates on `.installed` only — it launches the single interactive
// terminal the user signs in through. After that, these gates pass and runs go
// through quietly.

import { claudeConnection } from './claudeConnection'

/** Discriminated result of {@link claudeRunPreflight}. On failure, `body` is the
 *  exact 503 payload a route should answer with (`c.json(result.body, 503)`). */
export type ClaudePreflightResult =
  | { ok: true }
  | { ok: false; body: { error: string; claudeMissing: true } }
  | { ok: false; body: { error: string; claudeLoggedOut: true } }

/**
 * Gate a route that is about to spawn `claude`. Returns `{ ok: true }` only when
 * the CLI is BOTH installed AND signed in; otherwise the caller answers 503 with
 * `result.body` — `claudeMissing` (not installed) or `claudeLoggedOut` (installed
 * but signed out). The dedicated login route deliberately does NOT use this: it
 * checks `.installed` alone so the user can spawn the one terminal they sign in
 * through. (claudeConnection caches for ~10s, so the toolbar indicator + a launch
 * don't each shell out to `claude auth status`.)
 */
export const claudeRunPreflight = async (): Promise<ClaudePreflightResult> => {
  const conn = await claudeConnection()
  if (!conn.installed) {
    return { ok: false, body: { error: conn.message, claudeMissing: true } }
  }
  if (!conn.loggedIn) {
    return { ok: false, body: { error: conn.message, claudeLoggedOut: true } }
  }
  return { ok: true }
}
