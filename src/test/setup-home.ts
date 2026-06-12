import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// HOME isolation for the whole vitest suite.
//
// Server code resolves its data dir via paths.openGroundHome(), which honours
// the OPENGROUND_HOME env var. If a test ever reaches that code with the var
// unset it would read/write the *real* ~/.openground — and a route test once
// proved it could (a `dismiss all` against the bare Hono app deleted a user's
// actual run history). We point OPENGROUND_HOME at a throwaway tmp dir before
// any test module loads, so the suite is hermetic by construction.
const tmpHome = mkdtempSync(join(tmpdir(), 'openground-test-home-'))
process.env.OPENGROUND_HOME = tmpHome

// Fail loudly if the override didn't land under tmpdir — that would mean the
// suite is about to touch the real home directory, exactly the regression this
// file exists to prevent.
if (!process.env.OPENGROUND_HOME.startsWith(tmpdir())) {
  throw new Error(
    `[setup-home] OPENGROUND_HOME (${process.env.OPENGROUND_HOME}) is not under tmpdir (${tmpdir()}) — refusing to run tests against the real home directory`,
  )
}

// Env isolation for the feedback proxy (server/routes/feedback.ts).
//
// That route reads SUPABASE_* and FEEDBACK_ADMIN_EMAILS LAZILY per request, and
// its tests assume an unset baseline they flip with vi.stubEnv per case. But the
// owner's dev shell exports these for real (Supabase is live; creds live in a
// gitignored .env.local). Inherited, they leak into the test process: the real
// FEEDBACK_ADMIN_EMAILS makes the "allowlist UNSET" cases gate (403) and a real
// SUPABASE_URL flips "unconfigured" cases the wrong way. Clear them here so the
// suite is hermetic regardless of who runs it. Tests that need a value stub it;
// vi.unstubAllEnvs() then restores it to "unset" rather than the shell's secret.
for (const key of [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_FEEDBACK_TABLE',
  'FEEDBACK_ADMIN_EMAILS',
  // Custom-tab modules (server/routes/customModules.ts) read these the same
  // lazy way — clear them so the owner's live shell can't flip role/market
  // gating cases.
  'SUPABASE_MODULES_TABLE',
  'SUPABASE_ROLES_TABLE',
  'OPENGROUND_OWNER_EMAILS',
  'OPENGROUND_TESTER_EMAILS',
]) {
  delete process.env[key]
}
