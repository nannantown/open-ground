import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, expect } from 'vitest'
import { canonicalizePath, productionHome, testHomeProblem } from '@/lib/server/testHomeGuard'
import { installRepoRootFence } from './repoRootFence'

// HOME isolation for the whole vitest suite.
//
// Server code resolves its data dir via paths.openGroundHome(), which honours
// the OPENGROUND_HOME env var. If a test ever reaches that code with the var
// unset it reads/writes the *real* ~/.openground — and on 2026-07-18 it did:
// a run overwrote the live settings.json, collapsing 45 registered projects to
// 3 and permanently losing canvas.json's card layout (no backup existed).
// We point OPENGROUND_HOME at a throwaway tmp dir before any test module loads,
// so the suite is hermetic by construction.
//
// WHY THE OLD CHECK DIDN'T CATCH IT — it was a TAUTOLOGY:
//
//     const tmpHome = mkdtempSync(join(tmpdir(), 'openground-test-home-'))
//     process.env.OPENGROUND_HOME = tmpHome
//     if (!process.env.OPENGROUND_HOME.startsWith(tmpdir())) throw …
//
// The value was BUILT from tmpdir() one line above, so the assertion could not
// fail under any circumstance. It read like a safety net and was decoration.
//
// This file now does three things the old one didn't:
//   (a) a SUBSTANTIVE check right after pinning — canonicalizing (so it is not
//       a string-prefix restatement of how the value was built) and, crucially,
//       verifying the pinned home does not resolve INTO the real ~/.openground.
//       That second property is independent of construction: it still fires if
//       TMPDIR itself pointed somewhere inside the user's home.
//   (b) re-verification + re-pin on EVERY test (beforeEach + afterEach), so
//       containment no longer depends on vitest's isolate:true. `--no-isolate`
//       shares one process across files, which is exactly how a stray
//       `delete process.env.OPENGROUND_HOME` used to leak from one file into
//       every file after it.
//   (c) an error that NAMES THE TEST FILE responsible, because "some test
//       somewhere unset an env var" is not an actionable bug report.
//
// This layer reports and repairs; it is NOT the last line of defence. The
// fail-closed fence lives at the resolution seam in src/lib/server/paths.ts
// (via testHomeGuard.ts) and throws even if this file never ran — necessary
// because a tolerant caller can swallow an exception, but it cannot swallow a
// write that never happened.
const tmpHome = mkdtempSync(join(tmpdir(), 'openground-test-home-'))
process.env.OPENGROUND_HOME = tmpHome

// The genuine ~/.openground — reported for attribution when the check below
// refuses to run the suite.
//
// This capture used to be load-bearing: productionHome() was homedir()-derived,
// so it started reporting a tmp path the moment a test re-pinned $HOME (several
// do, to isolate the homedir()-anchored writers) and snapshotting it early was
// the only way to keep a trustworthy view. It is passwd-derived now and no
// longer moves with $HOME, so the timing no longer matters — kept as a constant
// only to avoid recomputing it. Said plainly because the old wording described a
// hazard that no longer exists, and a stale safety rationale reads as a defence
// someone can rely on (the same trap as the tmpRoots docstring, 2026-07-19).
const REAL_OPENGROUND_HOME = canonicalizePath(productionHome())

/**
 * Returns a human-readable reason the current pin is unsafe, or null if fine.
 *
 * DELEGATES to the fence's own predicate rather than restating it. This file
 * used to carry its own copy of the conditions, and the copy had drifted: it
 * checked "under a temp root" and "not inside the real ~/.openground" but NOT
 * "not under a real home dir". In an environment whose temp dir lives inside
 * $HOME (`TMPDIR=$HOME/tmp`) that made the two disagree — this layer said the
 * pin was fine, the fence rejected every path built from it, and the run became
 * thousands of red tests with no message pointing at the cause. Two predicates
 * for one contract is the same asymmetry that caused the 2026-07-14 incident,
 * so there is now exactly one (src/lib/server/testHomeGuard.ts testHomeProblem).
 * Found by adversarial review 2026-07-19.
 */
const unsafeReason = (): string | null => {
  const current = process.env.OPENGROUND_HOME
  // Pass the raw value as the candidate home: requireExplicitPin makes the
  // unset/blank case its own reason, and anything else is judged exactly as the
  // fence would judge it.
  const problem = testHomeProblem(current ?? '', { requireExplicitPin: true })
  if (!problem) return null
  return `${problem} (OPENGROUND_HOME=${current === undefined ? '(unset)' : current})`
}

// (a) Substantive check, immediately after pinning.
{
  const reason = unsafeReason()
  if (reason) {
    throw new Error(
      `[setup-home] refusing to run the suite against the real home directory.\n` +
        `  ${reason}\n` +
        `  pinned:    ${tmpHome}\n` +
        `  tmpdir():  ${tmpdir()}\n` +
        `  real home: ${REAL_OPENGROUND_HOME}`,
    )
  }
}

/** Best-effort "which test file is running", for attribution. */
const testFile = (): string => {
  try {
    return expect.getState()?.testPath ?? '(unknown file)'
  } catch {
    return '(unknown file)'
  }
}

const testName = (): string => {
  try {
    return expect.getState()?.currentTestName ?? '(unknown test)'
  } catch {
    return '(unknown test)'
  }
}

/**
 * (b) + (c). Re-verify, REPAIR FIRST (so the rest of the run stays contained
 * even as this test fails), then fail loudly naming the file.
 *
 * `when` distinguishes the two attributions:
 *   after  — the test that just ran broke it. Precise blame.
 *   before — it was already broken on entry: either this file's module-level /
 *            beforeAll code, or (under --no-isolate) a file that ran earlier in
 *            this same worker.
 */
const verifyAndRepin = (when: 'before' | 'after') => {
  const reason = unsafeReason()
  if (!reason) {
    // Not unsafe, but possibly STALE: a file whose afterEach restores a saved
    // value it never had (`if (saved !== undefined)`) leaves OPENGROUND_HOME
    // pointing at the scratch dir the same afterEach just deleted. Harmless
    // under isolate:true, but with --no-isolate the next file inherits a home
    // that does not exist. Still under tmp, so unsafeReason() says nothing —
    // hand it back to the suite baseline instead of letting it rot.
    if (when === 'after') {
      const current = process.env.OPENGROUND_HOME
      if (current && current !== tmpHome && !existsSync(current)) {
        process.env.OPENGROUND_HOME = tmpHome
      }
    }
    return
  }
  const broken = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = tmpHome // repair before reporting
  throw new Error(
    [
      `[setup-home] TEST HOME ISOLATION BROKEN (${when} test) — repaired, but this run is suspect.`,
      `  reason:      ${reason}`,
      `  saw:         ${broken === undefined ? '(unset)' : broken}`,
      `  test file:   ${testFile()}`,
      `  test name:   ${testName()}`,
      when === 'after'
        ? `  BLAME:       the test above left OPENGROUND_HOME unsafe. Restore the saved\n               value in its afterEach instead of \`delete process.env.OPENGROUND_HOME\`.`
        : `  BLAME:       it was already unsafe on entry — this file's top-level/beforeAll\n               code, or (with --no-isolate) a file that ran earlier in this worker.`,
      ``,
      `  Isolation exists because a 2026-07-18 test run destroyed the user's real`,
      `  ~/.openground (45 projects → 3, canvas layout unrecoverable). Do not silence`,
      `  this by re-pinning in your own test — fix whatever unset it.`,
    ].join('\n'),
  )
}

// Registered here, so they wrap EVERY test file in the run. vitest's default
// hook sequence ('stack') runs afterEach hooks in reverse registration order,
// so this one — registered first — runs LAST: after each file's own cleanup
// hooks, which is precisely where a bad restore becomes visible.
beforeEach(() => verifyAndRepin('before'))
afterEach(() => verifyAndRepin('after'))

// The OTHER thing a test must not damage. The home fence above protects the
// user's DATA; this one protects the WORKING TREE, whose cleanliness is a
// precondition for swarm integration. Registered after the hooks above, so it
// runs before them and after each file's own cleanup. See the module header for
// why this watches the directory instead of reading the source.
installRepoRootFence()

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
  // Module submission queue (server/routes/moduleSubmissions.ts) — same lazy
  // reads, so clear them too (incl. the admin allowlist) for a hermetic baseline.
  'SUPABASE_SUBMISSIONS_TABLE',
  'MODULE_ADMIN_EMAILS',
  // Realtime collab (server/routes/collab*.ts + ticket.ts readCollabWsUrl) —
  // same lazy reads, different leak source: a claude session launched FROM
  // INSIDE the OPEN GROUND app (in-app swarm workers, the manager's review
  // runs) inherits the Electron server's live collab env, so every "503 when
  // collab is disabled (no env)" case fails there while passing in a plain
  // terminal (observed 2026-07-02: three collabAsset/collabInvite cases red on
  // a worker AND on the reviewing manager, green under env -u). Enabled-path
  // tests stub these per case; vi.unstubAllEnvs() restores "unset".
  'OPENGROUND_REALTIME',
  'OPENGROUND_COLLAB_WS_URL',
]) {
  // Guard the guard: this list must never grow to include a home var. Unsetting
  // OPENGROUND_HOME makes openGroundHome() fall back to the user's REAL
  // ~/.openground, which is how a `npm test` run silently rewrote it on
  // 2026-07-19. Clearing anything else is just hermeticity.
  //
  // HOME is listed too even though this file does NOT redirect it (only
  // OPENGROUND_HOME is isolated — anything resolving through `homedir()`, e.g.
  // ~/.claude, still reaches the real home; projectSkills.test.ts records the
  // same asymmetry). Refusing to unset it is still right: an unset HOME is
  // strictly worse than the real one, and the day HOME does get isolated the
  // guard is already in place.
  // USERPROFILE is listed for the same reason as HOME, one platform over:
  // os.homedir() reads it on Windows, so unsetting it there has exactly the
  // effect this guard exists to prevent (review nit, 2026-07-19).
  if (key === 'OPENGROUND_HOME' || key === 'HOME' || key === 'USERPROFILE') {
    throw new Error(`[setup-home] refusing to unset ${key} — that points tests at the real home`)
  }
  delete process.env[key]
}
