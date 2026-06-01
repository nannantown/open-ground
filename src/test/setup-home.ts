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
