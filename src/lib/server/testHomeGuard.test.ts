import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { homedir, tmpdir, userInfo } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPO_PROBE_PREFIX, REPO_ROOT } from '../../test/repoRootFence'
import { canvasFile, openGroundHome, settingsFile } from './paths'
import { getSettings, setSettings } from './store'
import { installHooks } from './hooksInstall'
import {
  assertTestHomeIsolated,
  canonicalizePath,
  isSamePathOrUnder,
  isTestProcess,
  isUnderTempRoot,
  passwdHome,
  productionHome,
  testHomeProblem,
  TRUSTED_TEMP_PREFIXES,
} from './testHomeGuard'

// This file shells out to a REAL `tsx` child three times (the TMPDIR-poisoning
// probes), and vitest's default budget is 5s — an order of magnitude below what
// every sibling that spawns a subprocess allows (30–60s: swarmSafety,
// swarmIntegrate, selfUpdateOnIntegrate, worktreeCleanup, …). MEASURED on
// 2026-07-20, 320 probe spawns while full suites ran in parallel:
//
//   load avg  70  (2 suites) — median 857ms, max 2769ms, 0 spawn failures
//   load avg 218  (3 suites) — median 1302ms, max 3933ms, 0 spawn failures
//
// So the child never fails to START for lack of process slots (the EAGAIN theory
// is not what bites); it just gets slow, and at 3933ms against a 5000ms budget the
// margin is 1.27×. Hence this ceiling, matching the siblings.
//
// The ceiling is only half of it: the child can also CRASH, for reasons that have
// nothing to do with slowness. The one that was measured (a tsx IPC-pipe
// collision inside the poisoned TMPDIR) no longer has a path here — TMPDIR now
// boots at a real temp dir and is poisoned from inside the child — but a crashed
// child is still retried by probeFreshWorld; see its docstring.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// ─── TEETH for the production-home fence ─────────────────────────────────────
//
// On 2026-07-18 a vitest run overwrote the real ~/.openground/settings.json:
// 45 registered projects collapsed to 3, and canvas.json's card layout was lost
// with no backup. The suite HAD a guard — src/test/setup-home.ts asserted the
// pinned home startsWith(tmpdir()) after building it with join(tmpdir(), …).
// It was a tautology: it could not fail, and it never did.
//
// So this file is written to the standard "a green test is not a working
// guard" — every case here MUST go red if the fence is removed. That was
// MEASURED, not assumed; the procedure and its output are recorded in
// docs/commander/07-test-isolation-contract.md §4.
//
// SAFETY OF THIS FILE ITSELF: the cases that must exercise a non-tmp home never
// point at the user's real ~/.openground or ~/.claude. They use decoy paths
// beside them (…/.openground-fence-probe-*) that must NOT exist before or after
// — their continued absence IS the assertion that no write happened.
//
// CONTAINMENT of the deliberate `delete process.env.OPENGROUND_HOME` below (six
// sites — unsetting it is the only way to prove the unset case throws): the
// file-level beforeEach saves the suite pin and the file-level afterEach puts it
// back, with the unsafeWorld() cases additionally restoring in a finally.
// vitest's default 'stack' hook order runs THIS file's afterEach before
// setup-home.ts's (reverse registration), so the value is already repaired by
// the time that re-verification runs — and if it ever is not, setup-home.ts
// throws and names this file. That containment is why src/testHomeEnvGuard.test.ts
// exempts this path from its repo-wide `delete` grep.

// Where the repo-root probes below build their throwaway dirs, and under what
// name. Both halves are load-bearing; neither is free to drift.
// (The count moves in both directions. The "fake real home" for the
// TMPDIR-poisoning cases left: it needs a path, not a directory, and anchoring
// it at the repo root was actively masking what it tested from inside a swarm
// worktree — see fakeRealHome() below. unsafeWorld() briefly moved here too on
// 2026-07-28, for the same reason and with the same masking effect — see its
// docstring for both that round and the /var/tmp anchor that replaced it.)
//
//   REPO_ROOT — resolved from THIS FILE, never from process.cwd(). A probe that
//     must read as "not temp" has to be built somewhere that is not temp (every
//     OS temp location is trusted by construction, so a probe under one passes
//     for the wrong reason), and the repo is the one such place the suite may
//     write to. cwd cannot be used: sibling files in this suite call
//     process.chdir() (swarmSafety.test.ts, hooksInstall.test.ts), so under
//     --no-isolate or a failed afterEach the cwd can be an ALREADY-DELETED tmp
//     dir and mkdtemp would die with ENOENT.
//
//   REPO_PROBE_PREFIX — matched by `/.og-fence-probe-*` in .gitignore. Every
//     case removes its dir in a finally, but a failed assertion, a crash or a
//     killed run skips that, and an untracked dir at the repo root is not
//     cosmetic here: swarm integration refuses a dirty tree (a worker must
//     commit before handing over) and `git add -A` would sweep it into a commit
//     — on 2026-07-19 exactly that swept a concurrent subagent's temp edit into
//     HEAD and left a safety net disarmed for about a minute.
//
// The coupling to .gitignore is invisible from here, which is how it broke —
// and the direction is the opposite of the intuitive one (git log -S, measured):
//
//   07-19 12:07  5d227df9  `og-fence-outside-` lands  ← the OLDER probe
//   07-19 23:07  62b71c0b  `.og-fence-probe-` lands   ← the NEWER probe
//   07-20 00:25  8081eb91  .gitignore gets `/.og-fence-probe-*` — the newer ONLY
//
// So the .gitignore line covered the probe its author had just written, and
// never went back for the one that had been dirtying the repo root for eleven
// hours (measured: `git check-ignore og-fence-outside-abc` exited 1 while
// `.og-fence-probe-abc` exited 0). The comment on that line states its intent
// correctly — "this covers a killed run" — so what was missing was never
// understanding. It was REACH.
//
// Which is why the teeth for this are NOT here. Sharing one const only pins the
// const: adversarial review gave one probe a fresh literal
// (`join(REPO_ROOT, 'og-fence-newprobe-')`) and the suite stayed 54/54 green
// while check-ignore exited 1 on that name — green through the exact event the
// teeth existed for. The rule that has reach is repo-wide and lives in
// src/testHomeEnvGuard.test.ts ("repo-tree writes only under the ignored probe
// prefix"): any file creating anything at a repo-root anchor must route through
// REPO_PROBE_PREFIX. The case at the bottom of THIS file pins only the narrower
// half — that this prefix is in fact ignored.
// Imported, NOT redeclared. A second copy of this name is how the .gitignore
// coupling broke the first time, and the fence that watches the repo root is
// the natural owner of both halves.


/** Fails loudly if a decoy exists, then removes it so the machine stays clean. */
const assertNeverCreated = async (p: string, what: string) => {
  const existed = existsSync(p)
  if (existed) await rm(p, { recursive: true, force: true })
  expect(existed, `${what} — the fence did NOT stop the write: ${p} was created`).toBe(false)
}

/**
 * A throwaway world with two halves that are what they claim BY LOCATION, so a
 * case can hold a path the fence MUST refuse without going anywhere near the
 * user's data: `tmp` really is inside the OS temp dir, `unsafeHome` really is
 * outside every temp root, AND outside condition 2's real ~/.openground and
 * condition 3's two real homes — so condition 1 is not just A reason
 * `testHomeProblem()` rejects it, it is the ONLY reason. That distinction is
 * not cosmetic: it is what "the fence has teeth" means here, and this world
 * has carried that claim wrong THREE times before landing.
 *
 * ROUND 1 (until 2026-07-28): both halves lived under ONE mkdtemp in the real
 * temp dir, and the "unsafe" half was made to READ as non-temp by stubbing
 * TMPDIR at a sibling subdirectory — shrinking the fence's notion of "temp"
 * around a path that was in fact inside it. MEASURED, faithfully reproducing
 * round 1's exact construction (`outer` built from the REAL tmpdir() BEFORE the
 * TMPDIR stub, matching the historical code exactly, not a simplified stand-in):
 * on Linux CI `outer` lands under `/tmp` because tmpdir() itself IS `/tmp`
 * there — the hardcoded `/tmp` entry in tempRoots() (added on every non-win32
 * platform for the `vi.mock('os')` case) matches it regardless of any TMPDIR
 * stub, so the "unsafe" home reads as safe and the fence correctly ALLOWED it.
 * On macOS, `outer` lands under `/var/folders/…` — not `/tmp` — so it stays
 * unmatched and the round-1 premise (`isUnderTempRoot(unsafeHome) === false`)
 * is TRUE THERE, full construction included: this bug could not have been
 * caught by strengthening the premise assert alone on a macOS machine, because
 * the premise really did hold. Confirmed CI-failing on `ci.yml` (ubuntu-latest,
 * `npm test`) for SEVEN consecutive releases — 0.11.32 through 0.11.38, the
 * latest at the time of this fix — via `gh run view --log-failed`, all showing
 * the identical `src/lib/server/testHomeGuard.test.ts (47 tests | 6 failed)`
 * signature (0.11.31 and earlier: no such failure). The narrower claim "any
 * construction anchored under `mkdtemp(join(tmpdir(), …))` is trivially unsafe
 * on every platform" is ALSO true and easy to mis-cite as "round 1 reproduced"
 * — it is not the same claim, because that construction is missing the TMPDIR
 * stub that made round 1's `fakeTmp` half legitimate; see the mutation note
 * below for where that distinction actually matters.
 *
 * ROUND 2 (2026-07-28, same day): moved `unsafeHome` to the repo root under
 * REPO_PROBE_PREFIX. This did NOT skip condition 1 — condition 1 is checked
 * FIRST in testHomeProblem() (testHomeGuard.ts:352, condition 2 is :358), and a
 * repo-root path under a swarm worker's checkout is genuinely outside every
 * temp root, so `testHomeProblem()` returned CONDITION 1's message for it too,
 * unmutated, exactly as it does for the round-3 anchor below (RE-MEASURED
 * directly from this worktree to confirm: both the repo-root anchor and this
 * file's own `/var/tmp` anchor return the identical "outside every OS temp
 * root" message when queried without any mutation). The round-2 premise assert
 * (`isUnderTempRoot(unsafeHome) === false`) was checking exactly this, and it
 * was TRUE — it was not a false premise.
 *
 * What round 2 actually got wrong: the repo-root anchor is a swarm worker's
 * checkout, which sits under `~/.openground/projects/<uuid>/worktrees/…` — SO
 * IT IS *ALSO* MATCHED BY CONDITION 2 (`isSamePathOrUnder(canon,
 * REAL_OPENGROUND_HOME)`). Condition 2 is a REDUNDANT BACKSTOP for that one
 * anchor, invisible as long as condition 1 keeps firing — until something
 * removes condition 1. MEASURED (integration review, from this worktree):
 * mutate `if (!isUnderTempRoot(home))` to `if (false && !isUnderTempRoot(home))`
 * in testHomeGuard.ts — i.e. disable condition 1 outright — and the round-2
 * commit's `testHomeGuard.test.ts` still ran 47 passed / 0 failed, in both
 * TMPDIR states: condition 2 silently caught what condition 1 used to. The
 * premise that was MISSING was not "does condition 1 fire" (it did) but "is
 * condition 1 the ONLY thing that would fire" — round 2 never asked that, so a
 * later refactor (or the deliberate mutation used to test this) could remove
 * condition 1 and nothing here would notice.
 *
 * THE FIX (round 3): anchor `unsafeHome` at `/var/tmp`, MEASURED (not assumed)
 * to satisfy all three constraints AT ONCE, and — this is what round 2 skipped
 * — measured to satisfy them EXCLUSIVELY: outside tempRoots() (which only ever
 * holds tmpdir()/TMPDIR/TMP/TEMP plus a hardcoded `/tmp`, never `/var/tmp`),
 * outside REAL_OPENGROUND_HOME, and outside both PASSWD_HOMEDIR and
 * EFFECTIVE_HOMEDIR — so testHomeProblem() reaches condition 1 AND nothing
 * downstream would also match if condition 1 vanished:
 *
 *   testHomeProblem('/var/tmp/og-fence-unsafe-<random>', {})
 *   → "the resolved home is outside every OS temp root (canonical: …)"
 *
 * measured under both `TMPDIR=/tmp` and the default TMPDIR, from this worktree
 * (i.e. anchored under ~/.openground exactly like a swarm worker). MEASURED
 * PER CONSUMING CASE too, not just for the bare anchor — every test that builds
 * on this world was independently reproduced (same stubs, same call sequence)
 * and every one of them hits condition 1 as the exclusive reason, including
 * "installHooks() writes NOTHING…" (:847) and the legacy-migration test
 * (:886), which stub `$HOME` to `unsafeHome` and, in the legacy case,
 * `vi.resetModules()` before re-importing — neither changes which condition
 * fires, because condition 1 is evaluated FIRST and does not depend on `$HOME`
 * at all. So this world does not need a "condition 1 for some cases,
 * condition 2/3 for others" split: every case gets condition-1 teeth from the
 * one anchor, uniformly.
 *
 * mutate-and-rerun on the FINAL design confirms this: the same
 * `if (false && !isUnderTempRoot(home))` mutation now goes 6 failed / 41 passed
 * on BOTH `TMPDIR=/tmp` and the default TMPDIR (measured) — a result round 2
 * could not produce in either environment, because round 2's anchor kept
 * condition 2 as a silent backstop and this one does not.
 *
 * `/var/tmp` is not a fresh assumption about this codebase: TRUSTED_TEMP_PREFIXES
 * (below) and sandbox.ts already both treat it as a real, standard path.
 * `npm test` executes ONLY on `ubuntu-latest` (.github/workflows/ci.yml);
 * win-build-check.yml is a compile-only check with no test step, so `/var/tmp`
 * not existing on a Windows CI runner never reaches this file. It CAN reach a
 * developer running `npm test` locally on Windows, though — as
 * `mkdtemp('/var/tmp/og-fence-unsafe-')` below, not as a hand-joined path:
 * MEASURED, `mkdtemp()` does NOT create a missing parent directory (unlike
 * `mkdir(…, { recursive: true })`) — it ENOENTs if `/var/tmp` does not exist.
 * So on a Windows box without a `\var\tmp`, this throws BEFORE the premise
 * assert is ever reached, and every case built on unsafeWorld() (6 of them)
 * goes red with that ENOENT. Nothing passes silently and no leftover is ever
 * created — the failure mode is loud, not a quiet gap. Whether `\var\tmp`
 * actually exists on a real Windows dev machine is NOT measured here; if it
 * does, this is moot (condition 1 fires exactly as on POSIX); if it does not,
 * the suite goes red with a clear ENOENT rather than a mysterious one.
 *
 * THREE THINGS ABOUT `/var/tmp` SPECIFICALLY, addressed rather than assumed:
 *
 *  1. A runner that sets `TMPDIR=/var/tmp` would put `/var/tmp` INTO
 *     tempRoots() (via the `TMPDIR` env read, independent of the hardcoded
 *     `/tmp` entry), so `unsafeHome` would then read as SAFE and condition 1
 *     would not fire. MEASURED: `testHomeProblem()` on a `/var/tmp`-anchored
 *     path under `TMPDIR=/var/tmp` returns `null` (no problem at all) — which
 *     is exactly what makes the premise assert below FAIL LOUDLY (`toMatch`
 *     against `null` is a clear assertion failure, not a silent pass). The
 *     premise is the safety valve for this environment, not a workaround.
 *  2. `/var/tmp` is sticky, multi-user, and NOT cleared on reboot (unlike a
 *     tmpfs `/tmp`). A predictable name there risks silently reusing another
 *     run's (or another user's) leftover directory — `mkdtemp()` avoids the
 *     question entirely by asking the OS for an atomically-unique name, the
 *     same primitive already used for `tempOuter` two lines below, rather than
 *     hand-rolling one from pid + a counter. Every consumer removes its own
 *     world in `cleanup()` (see below — both halves removed independently, so
 *     one failing does not strand the other), so a leftover here means a run
 *     was killed mid-test, not routine growth — same policy as every other tmp
 *     world in this file.
 *  3. Stubbing `$HOME` to a `/var/tmp` path (installHooks, legacy migration)
 *     makes `EFFECTIVE_HOME_IS_TEMPORARY` true for any module graph that
 *     re-imports afterward (`homeIsThrowaway()` checks TRUSTED_TEMP_PREFIXES,
 *     which lists `/var/tmp`) — condition 3's effective-home branch would be
 *     suppressed in that fresh module graph. MEASURED: it never matters here,
 *     because condition 1 already fires first, on the unmodified `unsafeHome`,
 *     before any per-test stub or module reset runs (this world's own premise
 *     check happens at construction time, ahead of anything the caller does
 *     with it). Documented so a future reader does not "fix" a redundancy that
 *     is not there.
 *
 * The premise below asserts BOTH that condition 1's message comes back AND
 * that conditions 2 and 3 do not ALSO match this path (mirrors
 * assertReachesCondition3() below, aimed at the opposite goal) — asserting the
 * message alone is what round 2 already had and it was not enough, because the
 * round-2 anchor produced the exact same message while condition 2 sat behind
 * it unexercised.
 *
 * Building the world locally (rather than pointing at a fixed real path like
 * `homedir()`) is not decoration either. The very first version of these cases
 * used `join(homedir(), '.openground-fence-probe-*')` as the stand-in for
 * "unsafe", which silently stops being unsafe when the runner isolates HOME —
 * and `HOME=$(mktemp -d) npm test` is exactly how this contract says to run the
 * suite. Seven cases passed for the wrong reason in one environment and failed
 * in the other.
 */

/**
 * The premise unsafeWorld() and outsideAnyHome() both rest on: not merely
 * "testHomeProblem() returns condition 1's message" (round 2's repo-root
 * anchor did too, unmutated — see the docstring above), but that condition 1
 * is the ONLY thing that would reject this path. If condition 2 or 3 ALSO
 * matches, disabling condition 1 alone — by mutation, or by a future refactor
 * — falls through to one of them as a silent backstop and every case built on
 * this world keeps passing with condition 1 dead, which is exactly what
 * happened in round 2. Mirrors assertReachesCondition3() below, built for the
 * opposite goal (that one wants condition 3 to be reachable; this one wants
 * conditions 2 and 3 to be UNreachable).
 *
 * This assert is deliberately STRICTER than the fence itself, on purpose: the
 * fence's own condition 3 is SUPPRESSED per-home by PASSWD_HOME_IS_TEMPORARY /
 * EFFECTIVE_HOME_IS_TEMPORARY (both memoized at import), and userInfo()/
 * homedir() here are called live at THIS call site rather than read from the
 * fence's import-time capture. So the direction this can be wrong in is only
 * one way: this assert can go red while the fence would actually have a
 * working backstop (a false alarm, safe to investigate) — it structurally
 * cannot go green while the fence's backstop is silently missing. If a future
 * anchor change makes this assert fail, that is the correct first place for
 * the lie to surface, not a place where the lie could hide.
 */
const assertOnlyCondition1 = (home: string) => {
  const canon = canonicalizePath(home)
  expect(
    testHomeProblem(home, {}),
    `the "unsafe" home (${home}) did not return CONDITION 1's message (outside every OS temp ` +
      `root). Either it is not rejected at all (e.g. a runner with TMPDIR=/var/tmp, which puts ` +
      `/var/tmp itself into tempRoots()) or it is rejected by a different condition first — ` +
      `either way, every case built on this world would keep passing even with condition 1 ` +
      `dead. Do NOT relax the fence to make this pass — find a new anchor.`,
  ).toMatch(/outside every OS temp root/)
  expect(
    isSamePathOrUnder(canon, canonicalizePath(productionHome())),
    `the "unsafe" home (${canon}) sits inside the real ${productionHome()} (condition 2), so ` +
      `disabling condition 1 alone would fall through to condition 2 as a SILENT BACKSTOP — this ` +
      `is exactly the round-2 bug: a repo-root anchor under a swarm worktree returns condition ` +
      `1's message too, but condition 2 ALSO matches it, so a mutation that kills condition 1 ` +
      `goes unnoticed. This assertion is what round 2 was missing.`,
  ).toBe(false)
  // passwdHome(), not a direct userInfo() call: userInfo() throws on a
  // container with no passwd entry for this uid (same trap testHomeGuard.ts's
  // own passwdHome() docstring names), and this helper claims to mirror the
  // fence's judgement — so it should fail the SAME way the fence does
  // (falling back to homedir()) rather than crashing this assert alone with a
  // bare, unactionable exception while the fence itself stays fine.
  expect(
    isSamePathOrUnder(canon, canonicalizePath(passwdHome())),
    `the "unsafe" home (${canon}) sits inside the real user's home (condition 3), which would ` +
      `be the same silent-backstop problem as condition 2 above.`,
  ).toBe(false)
  expect(
    isSamePathOrUnder(canon, canonicalizePath(homedir())),
    `the "unsafe" home (${canon}) sits inside this process's $HOME (condition 3's other half), ` +
      `which would be the same silent-backstop problem as condition 2 above.`,
  ).toBe(false)
}

let unsafeWorldSeq = 0

/**
 * Removes every given path independently — `Promise.allSettled`, not
 * `await a(); await b()`: one throwing (e.g. permission denied) must not
 * strand a sibling, especially the /var/tmp half, which outlives a reboot.
 *
 * Failures are reported TOGETHER, not just the first one: a bare
 * `for (…) if (rejected) throw r.reason` throws on the FIRST rejection and
 * silently drops every reason after it — exactly backwards for a helper
 * whose whole point is "don't let one failure hide another". If `/var/tmp`
 * is the one left behind, its reason must survive alongside the other's.
 */
const cleanupPaths = async (paths: string[]) => {
  const results = await Promise.allSettled(paths.map((p) => rm(p, { recursive: true, force: true })))
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0].reason
  throw new AggregateError(
    failures.map((f) => f.reason),
    `${failures.length}/${paths.length} cleanup path(s) failed: ${paths.join(', ')}`,
  )
}

const unsafeWorld = async () => {
  // The legitimate-temp half: a real mkdtemp under the real tmpdir(), so
  // "this is under a temp root" is true by location and not by env.
  const tempOuter = await realpath(await mkdtemp(join(tmpdir(), 'og-fence-world-')))
  const fakeTmp = join(tempOuter, 'tmp')
  // The unsafe half IS pre-created (empty), via mkdtemp for the same reason as
  // tempOuter above — an OS-guaranteed unique name, not a hand-rolled one, on
  // a directory that is shared/sticky and outlives a reboot (see point 2 in
  // the docstring above). Pre-creation is not decoration either: "refuses a
  // path outside tmp even when reached through a symlink under tmp" and
  // "re-validates every call" both `symlink(w.unsafeHome, …)` and then rely on
  // the fence dereferencing THROUGH that symlink. canonicalizePath()'s
  // missing-leaf tolerance only walks up the LEXICAL path when realpathSync()
  // fails — a symlink whose target does not exist is exactly that failure, so
  // a non-existent unsafeHome makes canonicalizePath silently stop at the
  // symlink's own location instead of following it, and the fence never sees
  // the unsafe target at all. MEASURED: with unsafeHome left uncreated, both
  // symlink cases break LOUDLY (2 red, `expected [Function] to throw an error`
  // — the assertion itself fails because the fence, with nothing to
  // dereference through, does not throw), not silently — pre-creation is
  // required for these two cases to test what they claim, and skipping it is
  // self-correcting rather than a silent hole. No case here requires
  // unsafeHome ITSELF to be absent; the one precondition check in this file
  // (`existsSync` in "setSettings rejects…") is on a SUBpath (`join(unsafeHome,
  // '.openground')`), which stays absent regardless.
  //
  // Created in its OWN try/catch, separate from the steps below: this mkdtemp
  // targets /var/tmp specifically (not the real tmpdir()), so an environment
  // where /var/tmp does not exist or is not writable throws HERE — and at
  // this point nothing has a handle on `tempOuter` yet to clean it up. Without
  // this try/catch that throw escaped as a bare, un-actionable ENOENT/EACCES
  // AND leaked `tempOuter` forever, breaking the "every precondition here
  // fails loud and clean" contract every other case in this file follows.
  let unsafeHome: string
  try {
    unsafeHome = await mkdtemp('/var/tmp/og-fence-unsafe-')
  } catch (err) {
    await cleanupPaths([tempOuter])
    throw err
  }
  try {
    await mkdir(fakeTmp, { recursive: true })
    assertOnlyCondition1(unsafeHome)
    expect(
      isUnderTempRoot(fakeTmp),
      `the legitimate-temp half (${fakeTmp}) is NOT under a temp root, so the cases that ` +
        `require a PIN THAT PASSES would go red for a reason that has nothing to do with ` +
        `what they test.`,
    ).toBe(true)
  } catch (err) {
    await cleanupPaths([tempOuter, unsafeHome])
    throw err
  }
  return {
    /** A real temp location — what the fence must accept. */
    tmp: fakeTmp,
    /** Outside every temp root — what the fence must refuse (condition 1). */
    unsafeHome,
    /**
     * Populates `<unsafeHome>/<dir>/<file>` and returns that directory, so a
     * case can hand the fence a home that is not just outside temp but LOOKS
     * lived-in.
     */
    seed: async (dir: string, file: string, contents: string) => {
      await mkdir(join(unsafeHome, dir), { recursive: true })
      await writeFile(join(unsafeHome, dir, file), contents)
      return join(unsafeHome, dir)
    },
    cleanup: () => cleanupPaths([tempOuter, unsafeHome]),
  }
}

/**
 * The zero-footprint sibling of unsafeWorld(): a path with the same
 * exclusively-condition-1 guarantee as unsafeWorld() — asserted via the same
 * assertOnlyCondition1(), not just claimed — but never written to disk at all,
 * for the one case that only ever hands the path to `assertTestHomeIsolated()`
 * directly and touches no filesystem. Anchored at `/` rather than `/var/tmp`
 * specifically so this helper can never be reached for a case that DOES write
 * (a non-root process cannot mkdir at `/`, which would make
 * `assertNeverCreated`-style checks pass for the wrong reason — by
 * permission, not by the fence — exactly the trap the setSettings case above
 * must avoid, which is why THAT case stays on the real unsafeWorld() instead).
 * Nothing is ever created here, so — unlike unsafeWorld()'s /var/tmp half — a
 * plain pid + counter is enough for a distinct name; there is no leftover to
 * collide with.
 */
const outsideAnyHome = () => {
  const home = join('/', `og-fence-outside-${process.pid}-${unsafeWorldSeq++}`)
  assertOnlyCondition1(home)
  return home
}

let savedHome: string | undefined
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  savedHome = process.env.OPENGROUND_HOME
  // The fence console.error()s on every violation by design (so a tolerant
  // caller that swallows the throw still leaves a trace). Capture it here to
  // keep the run readable AND to assert that trace exists.
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errSpy.mockRestore()
  vi.unstubAllEnvs()
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
})

describe('the fence is armed at all', () => {
  it('detects this process as a test process', () => {
    expect(isTestProcess()).toBe(true)
  })
})

describe('the 2026-07-18 accident itself — OPENGROUND_HOME goes missing', () => {
  it('THROWS instead of silently resolving the real ~/.openground', () => {
    delete process.env.OPENGROUND_HOME
    expect(() => openGroundHome()).toThrow(/REFUSING to resolve an OPEN GROUND home/)
    // The message must name what it refused and say the var is unset — that is
    // the whole difference between this and the silent retarget that lost data.
    //
    // ANCHORED ON THE LABEL, never a bare path match. Both halves were measured
    // on 2026-07-20, and a bare `new RegExp(escapeForRegex(productionHome()))`
    // failed each one in a different direction:
    //   • FALSE RED. Since the passwd baseline landed, productionHome() no
    //     longer follows $HOME while `resolved home:` still does. Under
    //     `HOME=$(mktemp -d)` — the way 07-test-isolation-contract.md MANDATES
    //     running this suite — they are different paths, so the bare regex
    //     matched nothing and the contract's own teeth went red under the
    //     contract's own command. The `protected home:` line is what makes the
    //     assertion true in BOTH modes, so it is the line worth pinning.
    //   • FALSE GREEN, same commit, different checkout. A swarm worker's
    //     worktree lives under the project data root inside the very directory
    //     productionHome() names, so the `offending test:` attribution line
    //     contained that string verbatim and satisfied the bare regex no matter
    //     what the fence actually said. Red in the primary checkout, green in
    //     the worktree — a location-dependent pass that proved nothing.
    // Pinning `label + path` kills both: it can only be satisfied by the line
    // the fence deliberately prints.
    expect(() => openGroundHome()).toThrow(
      new RegExp(`protected home:\\s+${escapeForRegex(productionHome())}`),
    )
    expect(() => openGroundHome()).toThrow(/OPENGROUND_HOME:\s+\(unset\)/)
  })

  it('blocks the exact files the incident destroyed (settings.json / canvas.json)', () => {
    delete process.env.OPENGROUND_HOME
    expect(() => settingsFile()).toThrow(/REFUSING/)
    expect(() => canvasFile()).toThrow(/REFUSING/)
  })

  it('keeps throwing on repeated calls — swallowing one does not buy silence', () => {
    delete process.env.OPENGROUND_HOME
    expect(() => openGroundHome()).toThrow(/REFUSING/)
    expect(() => openGroundHome()).toThrow(/REFUSING/)
    expect(() => openGroundHome()).toThrow(/REFUSING/)
  })

  it('leaves a console trace even when a caller swallows the throw', () => {
    delete process.env.OPENGROUND_HOME
    try {
      openGroundHome()
    } catch {
      // a tolerant caller
    }
    expect(errSpy).toHaveBeenCalled()
    expect(String(errSpy.mock.calls[0]?.[0])).toMatch(/REFUSING to resolve an OPEN GROUND home/)
  })
})

describe('reads are NOT exempt', () => {
  // The fence sits in the PATH BUILDER, not inside the fs call — deliberately.
  // store.readJson is a tolerant reader (`catch { return fallback }`), so a
  // fence thrown during readFile would be swallowed and getSettings would hand
  // back DEFAULT_SETTINGS as if all were well. Because settingsFile() is
  // evaluated as the ARGUMENT, before that try block, the throw escapes.
  // If anyone ever moves the check inside the fs call, this case goes red.
  it('getSettings REJECTS rather than falling back to defaults', async () => {
    delete process.env.OPENGROUND_HOME
    await expect(getSettings()).rejects.toThrow(/REFUSING/)
  })
})

describe('writes never reach a non-tmp home', () => {
  it('setSettings rejects AND creates nothing on disk', async () => {
    const w = await unsafeWorld()
    try {
      const probeHome = join(w.unsafeHome, '.openground')
      expect(existsSync(probeHome), 'precondition: target must not pre-exist').toBe(false)
      process.env.OPENGROUND_HOME = probeHome
      await expect(setSettings({ archiveDirName: '_fence_probe' })).rejects.toThrow(/REFUSING/)
      // The real assertion: not "it threw" but "nothing was written".
      await assertNeverCreated(probeHome, 'setSettings')
    } finally {
      await w.cleanup()
    }
  })

  it('the incident payload cannot land: a settings write to the real home is refused', async () => {
    // The literal shape that was found in the user's live settings.json.
    delete process.env.OPENGROUND_HOME
    await expect(
      setSettings({ projectsMigratedAt: '2026-01-02T03:04:05.000Z', archiveDirName: '_arc' }),
    ).rejects.toThrow(/REFUSING/)
  })
})

describe('the macOS /var vs /private/var trap', () => {
  it('accepts BOTH the raw and the realpath-ed form of a tmp dir', async () => {
    const raw = await mkdtemp(join(tmpdir(), 'og-fence-var-'))
    try {
      const canon = await realpath(raw)
      expect(isUnderTempRoot(raw)).toBe(true)
      expect(isUnderTempRoot(canon)).toBe(true)
      expect(() => assertTestHomeIsolated(raw, 'test')).not.toThrow()
      expect(() => assertTestHomeIsolated(canon, 'test')).not.toThrow()

      if (canon !== raw) {
        // macOS: tmpdir() is /var/folders/… while realpath() yields
        // /private/var/folders/…. This is the exact trap — 36 test files build
        // their home with realpath(mkdtemp(…)), so a lexical
        // startsWith(tmpdir()) rejects most of the suite here and passes on
        // Linux CI. Asserted so nobody "simplifies" the canonicalization away.
        expect(canon.startsWith(tmpdir())).toBe(false)
      }
    } finally {
      await rm(raw, { recursive: true, force: true })
    }
  })
})

describe('shapes the real suite actually uses', () => {
  it('accepts a tmp path whose directory was never created (no ENOENT)', () => {
    // swarmJanitor / swarmIntegrationLock / swarmWorkerRegistry all point
    // OPENGROUND_HOME at join(scratch, "home") and never mkdir it.
    const notCreated = join(tmpdir(), 'og-fence-never-created', 'home')
    expect(existsSync(notCreated)).toBe(false)
    expect(isUnderTempRoot(notCreated)).toBe(true)
    expect(() => assertTestHomeIsolated(notCreated, 'test')).not.toThrow()
  })

  it('accepts a symlinked home and returns it VERBATIM (never normalized)', async () => {
    // swarmWorktreeTrust.test.ts asserts the un-resolved key differs from the
    // resolved one; a guard that rewrote the env var would break that premise.
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-fence-link-')))
    try {
      const target = join(scratch, 'realhome')
      const link = join(scratch, 'linkhome')
      await mkdir(target, { recursive: true })
      await symlink(target, link)
      process.env.OPENGROUND_HOME = link
      expect(openGroundHome()).toBe(link)
      expect(openGroundHome()).not.toBe(target)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

describe('non-tmp homes are refused even when they exist', () => {
  it('refuses an existing directory outside tmpdir', async () => {
    // Built at the repo root under the gitignored probe prefix — see REPO_ROOT.
    // KNOWN, OUT OF SCOPE for the 2026-07-28 fix above: from a swarm worktree
    // this anchor is ALSO caught by condition 2 (same shape as round 2's bug —
    // see unsafeWorld()'s docstring), so disabling condition 1 alone would not
    // turn this case red — condition 2 backstops it exactly like it backstopped
    // round 2, even though the assertion below DOES route through the fence's
    // full message (`assertTestHomeIsolated(...).toThrow(/REFUSING/)`, not just
    // `isUnderTempRoot()`). Not fixed here because REPO_ROOT is the one
    // legitimate non-temp anchor this suite is allowed to write to (§4.11) — an
    // exclusivity fix would need the same /var/tmp-style anchor as
    // unsafeWorld(), which is a separate change from what this card covers.
    const outside = await mkdtemp(join(REPO_ROOT, REPO_PROBE_PREFIX))
    try {
      expect(isUnderTempRoot(outside)).toBe(false)
      expect(() => assertTestHomeIsolated(outside, 'test')).toThrow(/REFUSING/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses the real production home explicitly', () => {
    // Rejected by identity, not by location: productionHome() is refused even
    // when it happens to sit under a temp root (which it does whenever the
    // runner isolated HOME). That is the condition that survives a poisoned
    // TMPDIR, so assert the throw — not "it isn't under tmp".
    expect(() => assertTestHomeIsolated(productionHome(), 'test')).toThrow(/REFUSING/)
  })
})

describe('ways to disarm the fence while it is armed (adversarial review, 2026-07-19)', () => {
  // These three all passed the fence in its first version. They are the reason
  // "we wrote a guard" is not the same claim as "the guard cannot be walked
  // around" — each was found by attacking the fence, not by running the suite.

  it('a mid-run TMPDIR stub does not let ~/.openground pass (condition 2)', () => {
    // TMPDIR/TMP/TEMP are ordinary mutable env vars. Stubbing one at $HOME makes
    // "under a temp root" TRUE for the production home — condition 1 has been
    // neutralised by an env var — and the fence must still refuse on identity.
    //
    // SCOPE, stated because this case used to claim more than it proved: a stub
    // set HERE cannot test the real TMPDIR-poisoning hole. REAL_HOME_IS_TEMPORARY
    // is fixed at import, so condition 3 is still armed no matter what this stub
    // says, and the case would go green whether or not the hole existed. It
    // pins condition 2 and nothing else. The hole itself needs a child process —
    // see "poisoned TMPDIR at process start" below.
    vi.stubEnv('TMPDIR', homedir())
    expect(() => assertTestHomeIsolated(productionHome(), 'test')).toThrow(/REFUSING/)
  })

  it('refuses a path outside tmp even when reached through a symlink under tmp', async () => {
    const w = await unsafeWorld()
    try {
      const link = join(w.tmp, 'looks-like-tmp')
      await symlink(w.unsafeHome, link) // a tmp-looking path → outside tmp
      expect(() => assertTestHomeIsolated(link, 'test')).toThrow(/REFUSING/)
    } finally {
      await w.cleanup()
    }
  })

  it('re-validates every call — a path that PASSED can turn unsafe underneath it', async () => {
    // The fence once memoized passes, reasoning that "a value that canonicalizes
    // under tmp can't drift into the real home". Canonicalization is a
    // FILESYSTEM query, so it can: pin a not-yet-created tmp path (supported),
    // then create a symlink there aimed at the real home. With a cache, every
    // later call returns the stale pass and writes flow through the symlink.
    const w = await unsafeWorld()
    try {
      const pinned = join(w.tmp, 'home') // does not exist yet → legitimately passes
      expect(() => assertTestHomeIsolated(pinned, 'test')).not.toThrow()
      await symlink(w.unsafeHome, pinned) // same path, now resolving outside tmp
      expect(() => assertTestHomeIsolated(pinned, 'test')).toThrow(/REFUSING/)
    } finally {
      await w.cleanup()
    }
  })
})

// ─── Poisoned TMPDIR at PROCESS START ────────────────────────────────────────
//
// The hole adversarial review found on 2026-07-19, and the one shape that in-
// process tests structurally cannot reach. REAL_HOME_IS_TEMPORARY used to be
// `isUnderTempRoot(REAL_HOMEDIR)` — derived from the very env vars it defends
// against — and it is sampled ONCE at import. So `TMPDIR=$HOME` set before the
// process starts made the real home look throwaway, condition 3 fell silent for
// the whole run, and every homedir-anchored path (~/.claude, ~/.claude.json)
// sailed through: measured, a test calling installHooks() overwrote the user's
// real global Claude settings.
//
// A child process is the only honest way to measure it. The probe writes
// nothing — it asks the fence for verdicts on paths, which is the whole
// question — so this case cannot damage anything even if the fence is broken.
describe('a poisoned TMPDIR at process start does not disarm the homedir anchors', () => {
  const runProbe = (home: string, tmpdirValue: string, poisonAfterBoot?: string) => {
    const probe = fileURLToPath(new URL('./__fixtures__/tempRootPoisonProbe.ts', import.meta.url))
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
    let out: string
    try {
      out = execFileSync(tsx, [probe], {
        encoding: 'utf8',
        // VITEST arms the fence in the child (it is not a vitest process itself).
        // HOME and TMPDIR are the poisoning; everything else is inherited.
        // OG_PROBE_TMPDIR re-points TMPDIR from inside, for the cases where the
        // poisoned value must be a directory tsx cannot be asked to write into.
        env: {
          ...process.env,
          VITEST: '1',
          HOME: home,
          TMPDIR: tmpdirValue,
          ...(poisonAfterBoot ? { OG_PROBE_TMPDIR: poisonAfterBoot } : {}),
        },
        // stderr is PIPED, never discarded: when the probe dies, node's bare
        // `Command failed` says nothing about why, and the one thing that
        // explains it is the child's own stderr (0720 — this case went red
        // under a loaded machine and the cause was structurally invisible).
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      const err = e as { status?: unknown; signal?: unknown; stderr?: string; message?: string }
      throw new Error(
        [
          `probe failed (status=${String(err.status)} signal=${String(err.signal)}): ${err.message ?? e}`,
          `  tsx:    ${tsx}`,
          `  HOME:   ${home}`,
          `  TMPDIR: ${tmpdirValue}${poisonAfterBoot ? ` (then ${poisonAfterBoot})` : ''}`,
          `  stderr: ${(err.stderr ?? '').trim() || '(empty)'}`,
        ].join('\n'),
      )
    }
    return JSON.parse(out) as {
      home: string
      passwd: string
      hooksInstall: string
      claudeTrust: string
      ogManageSkill: string
      passwdOpenground: string
      passwdClaudeJson: string
    }
  }

  // A stand-in "real home": a path that reads as REAL DATA rather than as an
  // isolated runner. NOTHING IS CREATED — see the probe fixture's header: it
  // only asks the fence for verdicts on strings, and TMPDIR is re-pointed from
  // inside the child (OG_PROBE_TMPDIR), so tsx boots on a writable temp dir and
  // this path never has to exist. That also takes these two cases out of the
  // repo-root-residue class entirely (§4.11) instead of managing it.
  //
  // WHERE IT POINTS IS THE WHOLE POINT, and it used to point somewhere that made
  // these two cases prove less than they claimed. They were anchored at
  // REPO_ROOT. testHomeProblem() returns on its FIRST matching condition and
  // condition 2 is "the resolved home IS the real ~/.openground (or inside it)"
  // — so in a swarm worker, whose worktree lives under
  // ~/.openground/projects/<uuid>/worktrees/, the probe was refused by condition
  // 2 and never reached condition 3, which is the condition these cases exist to
  // pin. Measured 2026-07-20 with condition 3 disabled: from a worktree
  // 1 failed / 46 passed, from a primary checkout 3 failed / 44 passed. Green in
  // a worker, red on the commander's machine — the "false green depends on where
  // you ran it" class, from the guard that is supposed to be watching for it.
  //
  // Anchored at the passwd home instead: outside ~/.openground on every
  // checkout, and under a home that is not throwaway on either, so condition 3
  // carries these cases wherever the suite runs. assertReachesCondition3()
  // below asserts that premise rather than trusting it.
  const fakeRealHome = () => {
    const outer = join(userInfo().homedir, `${REPO_PROBE_PREFIX}anchor`)
    return { outer, home: join(outer, 'home') }
  }

  /**
   * The premise both cases rest on, asserted instead of assumed. A probe home
   * only exercises condition 3 if conditions 1 and 2 do not match it first; when
   * one of them does, the case still passes and says nothing. Failing here names
   * that directly, which is what the REPO_ROOT anchor could not do — from a
   * worktree it just quietly passed.
   */
  const assertReachesCondition3 = (home: string) => {
    const canon = canonicalizePath(home)
    expect(
      existsSync(home),
      `the probe home (${home}) EXISTS. It is meant to be a pure string — nothing should ` +
        `ever create it. If a run left it behind, remove it; if code now creates it, that ` +
        `code is writing inside the real user's home and must stop.`,
    ).toBe(false)
    expect(
      isSamePathOrUnder(canon, canonicalizePath(productionHome())),
      `the probe home (${canon}) sits inside the real ${productionHome()}, so condition 2 of ` +
        `testHomeProblem() refuses it BEFORE condition 3 is ever asked — these cases would ` +
        `pass without exercising the rule they exist for. This is what happened when the ` +
        `probe was anchored at REPO_ROOT and the checkout was a swarm worktree.`,
    ).toBe(false)
    expect(
      isSamePathOrUnder(canon, canonicalizePath(userInfo().homedir)),
      `the probe home (${canon}) is not under the real user's home, so condition 3 has ` +
        `nothing to fire on and a REFUSED verdict would prove something else.`,
    ).toBe(true)
  }

  /**
   * Runs the probe against the fake home, retrying if the child CRASHED.
   *
   * Why a retry is here at all, measured 2026-07-20 on a 3-parallel full-suite
   * run (the stderr capture in runProbe is what made it visible — before that the
   * failure was a bare `Command failed`):
   *
   *   listen EADDRINUSE: address already in use
   *     <repo>/.og-fence-probe-ser15c/<fakehome>/tsx-502/82427.pipe
   *
   * (`<fakehome>` was literally `home`; spelled as a placeholder because
   * src/repoPiiGuard.test.ts reads `/home/<segment>` as a real user path and
   * goes red on it — measured 2026-07-21, and origin/main carries the
   * unspelled form at testHomeGuard.test.ts:428.)
   *
   * tsx opens an IPC pipe at $TMPDIR/tsx-<uid>/<pid>.pipe, and back then TMPDIR
   * was poisoned from the moment the child booted, so the pipe landed inside the
   * poisoned home and under load that pid-derived path could already be taken.
   * That specific cause is now gone by construction: TMPDIR boots at a REAL temp
   * dir and the probe re-points it from inside (OG_PROBE_TMPDIR), so no pipe is
   * ever opened under the poisoned path. The retry stays for the general case —
   * a child that could not run at all — and a re-run gets a fresh pid regardless.
   *
   * The world is NOT rebuilt per attempt, because there is no world to build:
   * fakeRealHome() is a pure string and nothing may create it. That premise is
   * asserted once here, before any attempt.
   *
   * THIS CANNOT MASK A BROKEN FENCE. A fence that has stopped refusing answers
   * 'ALLOWED' — it returns a verdict, it does not crash — so a wrong answer is
   * handed straight to the assertions on the first attempt and fails there. Only
   * a child that could not run at all is retried, and if it never runs, the last
   * rich error (status/signal/stderr) is what surfaces.
   */
  const probeFreshWorld = (tmpdirFor: (w: { outer: string; home: string }) => string) => {
    const w = fakeRealHome()
    assertReachesCondition3(w.home)
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return { r: runProbe(w.home, tmpdir(), tmpdirFor(w)), home: w.home }
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  }

  it('refuses all three homedir anchors when TMPDIR IS $HOME', () => {
    // root === home: the poisoning shape. TMPDIR boots at a real temp dir and
    // the probe re-points it at the home from inside; tempRoots() re-reads the
    // variable per call, so condition 1 sees the poisoned value all the same.
    const { r, home } = probeFreshWorld((w) => w.home)
    expect(r.home).toBe(home)
    // Before the fix all three were ALLOWED: condition 1 passes (TMPDIR says
    // the home IS temp), condition 2 only knows ~/.openground, and condition 3
    // was suppressed because the poisoned answer said "the home is throwaway".
    expect(r.hooksInstall).toBe('REFUSED')
    expect(r.claudeTrust).toBe('REFUSED')
    expect(r.ogManageSkill).toBe('REFUSED')
  })

  it('refuses them for an ANCESTOR poisoning too (TMPDIR is $HOME/..)', () => {
    // The strict-descendant rule alone would NOT catch this — the root really
    // does contain the home, exactly like a legitimate mktemp home — so the
    // trusted-prefix requirement is what carries this case. Both rules needed.
    const { r } = probeFreshWorld((w) => w.outer)
    expect(r.hooksInstall).toBe('REFUSED')
    expect(r.claudeTrust).toBe('REFUSED')
    expect(r.ogManageSkill).toBe('REFUSED')
  })

  // The hole adversarial review reproduced on 2026-07-20, and the sharpest one
  // yet: it is opened by the way this contract TELLS people to run the suite.
  //
  //   HOME=$(mktemp -d) TMPDIR=<the real home> npx vitest run
  //   → testHomeProblem('<real home>/.openground') === null
  //
  // Isolating $HOME moved every homedir()-derived baseline onto the throwaway
  // home, so condition 2 no longer knew the real ~/.openground and condition 3
  // suppressed itself. Only the env-derived condition 1 was left — which is
  // precisely what the trusted-prefix rule was introduced to stop depending on.
  // The fix reads the real home from passwd (immune to $HOME) and asks
  // condition 3 of BOTH homes.
  it('refuses the REAL user home even when $HOME is isolated and TMPDIR is poisoned', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'og-isolated-home-'))
    try {
      // TMPDIR boots at a normal temp dir (tsx needs somewhere writable), then
      // the probe re-points it at the passwd home from inside. tempRoots() reads
      // the variable per call, so condition 1 sees the poisoned value — without
      // anything being created inside the user's real home.
      //
      // userInfo(), NOT homedir(): the gate runs this suite with $HOME already
      // isolated, so homedir() here is the GATE's throwaway home. Poisoning
      // TMPDIR with that value made the case pass for the wrong reason — the
      // real home simply was not under the "temp root", so condition 1 refused
      // it and the teeth stayed green with the fix reverted. Measured 2026-07-20.
      const r = runProbe(isolated, tmpdir(), userInfo().homedir)
      // Preconditions: three distinct homes, or this proves nothing.
      expect(r.home).toBe(isolated)
      expect(r.passwd).not.toBe(isolated)
      expect(r.passwd).toBe(userInfo().homedir)
      // Both were ALLOWED before the fix.
      expect(r.passwdOpenground).toBe('REFUSED')
      expect(r.passwdClaudeJson).toBe('REFUSED')
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('still ALLOWS a genuinely isolated $HOME — no 5258a1e regression', () => {
    // The case the suppression exists for: `HOME=$(mktemp -d)`. Its home is a
    // strict descendant of a trusted prefix, so writing under it stays legal and
    // the contract's documented way of running the suite keeps working.
    const isolated = mkdtempSync(join(tmpdir(), 'og-isolated-home-'))
    try {
      const r = runProbe(isolated, tmpdir())
      expect(r.hooksInstall).toBe('ALLOWED')
      expect(r.claudeTrust).toBe('ALLOWED')
      expect(r.ogManageSkill).toBe('ALLOWED')
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })
})

// 2026-07-20: detectTestProcess() used to OR in `NODE_ENV === 'test'` — a
// generic convention ambient shells/dotfiles/unrelated tools export and leave
// exported, unlike the VITEST-specific markers. A packaged Electron launch
// inheriting a stray NODE_ENV=test would arm this fail-closed fence and THROW
// resolving the real home, crashing production at boot. Child process because
// TEST_AT_IMPORT latches once at module load — the running suite's own
// VITEST=1 has already latched true in-process, so this case is structurally
// unreachable without a fresh process.
describe('NODE_ENV=test alone does not arm the fence', () => {
  it('isTestProcess() is false, and the real home stays writable, with only NODE_ENV=test set', () => {
    const probe = fileURLToPath(new URL('./__fixtures__/nodeEnvOnlyProbe.ts', import.meta.url))
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
    const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>
    // Strip every marker detectTestProcess() would otherwise legitimately see —
    // this suite's own vitest process has them all set, and they inherit into
    // the child by default.
    delete env.VITEST
    delete env.VITEST_WORKER_ID
    delete env.VITEST_POOL_ID
    const out = execFileSync(tsx, [probe], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] })
    const r = JSON.parse(out) as { isTestProcess: boolean; armedAgainstRealHome: 'REFUSED' | 'ALLOWED' }
    expect(r.isTestProcess).toBe(false)
    // 'REFUSED' would mean the fence armed for a plain NODE_ENV=test process and
    // then correctly rejected the real home from inside test mode — a bug in
    // the OPPOSITE direction that would break this teeth test's premise, not
    // satisfy it. What must hold is that the fence NEVER ENGAGED at all: a
    // production process with only NODE_ENV=test set can resolve its real home.
    expect(r.armedAgainstRealHome).toBe('ALLOWED')
  })
})

// The "refuses …" cases above (the fakeRealHome-based ones) name their attack
// home OUTSIDE any trusted prefix by construction, so they stay REFUSED
// whether TRUSTED_TEMP_PREFIXES holds its real value, is emptied, or is
// deleted outright — condition 3's suppression can only ever GRANT permission,
// never revoke it, so shrinking the list can't flip a REFUSED case to ALLOWED.
// Measured: emptying TRUSTED_TEMP_PREFIXES leaves every "refuses …" test above
// green. That made those tests look like teeth for this constant when they are
// not — the actual danger is the list being WIDENED (a future entry covering a
// real, non-temp directory), which would suppress condition 3 somewhere it must
// not and turn a REFUSED case into ALLOWED. Neither direction had a test that
// could go red for it, so pin it here directly.
describe('TRUSTED_TEMP_PREFIXES is pinned — the list this fence trusts by construction', () => {
  it('holds exactly the expected hardcoded prefixes (a change here must be deliberate)', () => {
    expect(TRUSTED_TEMP_PREFIXES).toEqual(
      process.platform === 'win32'
        ? []
        : ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'],
    )
  })

  it('never includes a root that would swallow this repo (or any non-temp dir)', () => {
    // The concrete danger: an entry wide enough to cover a real working
    // directory (the repo root, '/', a home dir) makes homeIsThrowaway() lie
    // for any home nested under it — exactly the fakeRealHome() shape the
    // "refuses …" tests above rely on. Assert the invariant directly rather
    // than only pinning the array, so a future PR that "updates the pin"
    // alongside a bad widening still gets caught.
    // userInfo().homedir, NOT homedir() — this suite runs with $HOME isolated
    // (HOME=$(mktemp -d)), so homedir() itself legitimately resolves under a
    // trusted prefix here. userInfo() reads the passwd entry directly and is
    // immune to $HOME, so it stays the real user's home even under isolation
    // (same reasoning as passwdHome() in testHomeGuard.ts).
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
    for (const prefix of TRUSTED_TEMP_PREFIXES) {
      expect(isSamePathOrUnder(repoRoot, prefix)).toBe(false)
      expect(isSamePathOrUnder(userInfo().homedir, prefix)).toBe(false)
      expect(prefix).not.toBe('/')
    }
  })
})

describe('the homedir()-anchored mirror (hooksInstall)', () => {
  // paths.openGroundHome()'s fence cannot cover these: hooksInstall anchors its
  // install dirs at homedir() on purpose, so OPENGROUND_HOME does not move them.
  it('refuses a non-tmp $HOME through the same one fence', () => {
    // Only ever hands a path to assertTestHomeIsolated() directly — no
    // filesystem touched by this call at all — so it needs outsideAnyHome(),
    // not the full unsafeWorld(): zero footprint, same condition-1 guarantee.
    const unsafeHome = outsideAnyHome()
    expect(() =>
      assertTestHomeIsolated(unsafeHome, 'hooksInstall (homedir-anchored)'),
    ).toThrow(/REFUSING/)
    // …and its FIX line must point at $HOME, not OPENGROUND_HOME.
    expect(() =>
      assertTestHomeIsolated(unsafeHome, 'hooksInstall (homedir-anchored)'),
    ).toThrow(/Pin process\.env\.HOME/)
  })

  it('installHooks() writes NOTHING when $HOME is not isolated', async () => {
    const w = await unsafeWorld()
    try {
      // stubEnv/unstubAllEnvs, not a hand-rolled save/restore: restoring with
      // `if (saved !== undefined)` would leave the stub in place for the rest of
      // the worker whenever HOME was unset on entry (POSIX always sets it;
      // Windows does not). vitest restores the exact prior state, unset included.
      vi.stubEnv('HOME', w.unsafeHome)
      // installHooks() catches internally and reports via result.errors, so
      // accept either shape — what must hold is that NOTHING was written.
      await installHooks().catch(() => undefined)
      // The write targets it would have created, had the fence not refused.
      await assertNeverCreated(join(w.unsafeHome, '.claude'), 'installHooks (~/.claude)')
      await assertNeverCreated(join(w.unsafeHome, '.openground'), 'installHooks (~/.openground)')
    } finally {
      await w.cleanup()
    }
  })
})

describe('the legacy-codename migration cannot move the real ~/.hove or ~/.pmmap', () => {
  // ensureOpenGroundHome() renames a legacy home (~/.hove, ~/.pmmap) onto the
  // resolved home when the latter does not exist yet. The fence checks the
  // DESTINATION (openGroundHome()); the SOURCE is homedir()-anchored, which
  // OPENGROUND_HOME cannot move. So a test pinning OPENGROUND_HOME at a tmp dir
  // it never creates — swarmJanitor / swarmIntegrationLock / swarmWorkerRegistry
  // all do exactly that — would MOVE the user's real ~/.hove into the tmpdir,
  // where afterEach deletes it recursively. A rename, not a copy.
  //
  // This test never goes near the real home: it builds a fake one that is
  // genuinely outside every temp root — the same shape as a real unpinned
  // $HOME, with nothing of the user's at stake.
  //
  // It used to build that fake home the way unsafeWorld() did, inside the real
  // temp dir with TMPDIR stubbed at a sibling subdirectory, and it went red on
  // Linux for the same reason and in the same run. It now shares unsafeWorld()
  // instead of carrying a second copy of the same construction — one copy is
  // the standing rule in this chapter, and this pair is why: the copies did not
  // even drift, they were identical, and one fix had to be written twice.
  it('throws instead of renaming, and leaves the legacy dir untouched', async () => {
    const w = await unsafeWorld()
    try {
      const legacy = await w.seed('.hove', 'settings.json', '{"projects":[{"id":"real"}]}')

      vi.stubEnv('HOME', w.unsafeHome)
      // A destination that IS under a temp root and does NOT exist — the exact
      // precondition that arms the migration branch. The SOURCE it then reaches
      // for, join(homedir(), '.hove'), is the one the fence must refuse.
      vi.stubEnv('OPENGROUND_HOME', join(w.tmp, 'never-created-home'))

      // Fresh module graph: ensureOpenGroundHome memoizes, and testHomeGuard
      // samples the real home at import. Both must see the stubbed world.
      vi.resetModules()
      const paths = await import('./paths')

      await expect(paths.ensureOpenGroundHome()).rejects.toThrow(/REFUSING/)
      // The legacy home is still where it was, with its contents intact.
      expect(existsSync(legacy)).toBe(true)
      expect(existsSync(join(legacy, 'settings.json'))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
      await w.cleanup()
    }
  })
})

// The pattern the repo sweep below uses, hoisted so it can be tested directly.
// Built from a string, not a regex literal: as a literal it would match ITSELF,
// and so would every comment describing the rule. (Both happened on the first
// run — the same self-reference trap that made an explanatory comment trip the
// repo PII guard earlier the same day.)
// The call-site half is copied from vitest's OWN hoister rather than invented:
// node_modules/@vitest/mocker/.../chunk-hoistMocks.js uses
//   /\b(?:vi|vitest)\s*\.\s*(?:mock|unmock|hoisted|doMock|doUnmock)\s*\(/
// Matching its shape is the only way to be sure the sweep sees everything the
// runtime accepts. The earlier hand-rolled version allowed neither the `vitest`
// alias (a real export; `vitest === vi`) nor any whitespace around `.` or before
// `(` — so `vitest.mock('./paths')` and `vi.mock ('./paths')` both ran for real
// and were reported by nothing (adversarial review 2026-07-19).
const MOCK_CHOKE_POINT_PATTERN =
  '\\b(?:vi|vitest)\\s*\\.\\s*(?:do)?[Mm]ock\\s*\\(\\s*(?:import\\s*\\(\\s*)?[\'"`][^\'"`]*[/](paths|testHomeGuard)(?:\\.[cm]?[jt]sx?)?[\'"`]'

describe('the mock-ban pattern actually catches the bypasses', () => {
  // Teeth for the teeth. The previous pattern looked thorough and missed four
  // real forms — including `vi.doMock`, whose `(?:do)?` spelling made the intent
  // obvious while the camelCase API made the branch unreachable. A guard's
  // pattern is a claim about coverage; assert it instead of reading it.
  const re = () => new RegExp(MOCK_CHOKE_POINT_PATTERN)

  // Samples are ASSEMBLED, never written whole: spelled out literally they are
  // themselves offending lines, and the repo sweep below would report this very
  // table. (It did, on the first run — the self-reference trap this file already
  // documents, walked into again while closing holes in the pattern.) Splitting
  // the `vi.` prefix keeps the file inside the sweep instead of exempting it.
  const VI = 'vi' + '.'

  it.each([
    [`${VI}mock('./paths')`, true],
    [`${VI}mock("@/lib/server/paths", () => ({}))`, true],
    [`${VI}mock('./testHomeGuard')`, true],
    [`${VI}doMock('./paths')`, true], // was MISSED — camelCase, non-hoisted
    [`${VI}mock('./paths.ts')`, true], // was MISSED — extension
    [`${VI}mock('./paths.js')`, true],
    [`${VI}mock(import('./paths'))`, true], // was MISSED — vitest >= 2.1 form
    [`${VI}mock(\n  './paths',\n)`, true], // was MISSED — split across lines
    [`vitest${'.'}mock('./paths')`, true], // was MISSED — the `vitest` alias
    [`${VI}mock ('./paths')`, true], // was MISSED — space before the paren
    [`vi ${'.'} mock('./paths')`, true], // was MISSED — spaces around the dot
    // Benign neighbours that must NOT trip it.
    [`${VI}mock('./claudeTerminal')`, false],
    [`${VI}mock('./pathsomething')`, false],
    [`await import('./paths')`, false],
  ])('sample %# → offender=%s', (sample, expected) => {
    expect(re().test(sample as string)).toBe(expected)
  })
})

describe('the choke point cannot be mocked away', () => {
  // vi.mock('./paths') replaces the choke point for a whole module graph, which
  // removes the fence from every module in it — a structural bypass no runtime
  // check can see. swarmOverseerBrain.launch.test.ts did exactly this (harmless
  // in itself: the replacement returned a mkdtemp path), and it would have
  // silently outlived any future edit that made the SUT reach the real home.
  // Pinning OPENGROUND_HOME gets the same isolation THROUGH the fence, so there
  // is no reason to mock either module. Cheap insurance, checked at the repo
  // level like repoPiiGuard.test.ts does.
  it('no test file mocks ./paths or ./testHomeGuard', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    // --others --exclude-standard: an UNTRACKED new test file executes exactly
    // like a tracked one, so a sweep limited to the index has a hole the size of
    // "git add it later" (review 2026-07-19).
    //
    // The pathspec must be at least as wide as the FILTER below, or the filter
    // is describing coverage the enumeration cannot deliver. It was not: `*.ts`
    // / `*.tsx` while `isHarness` accepts `src/test/**` at ANY extension and
    // names `vitest.config.[cm]?ts` explicitly. Measured 2026-07-20 — `git
    // ls-files … '*.ts' '*.tsx'` does not list `src/test/probe.mjs` or
    // `vitest.config.mts`, and those are the HIGHEST-leverage bypass sites there
    // are: a setupFile runs for the whole suite, so one `vi.doMock('./paths')`
    // in an `.mjs` helper would disable the fence everywhere while this guard
    // stayed green. Same defect class as the two sweeps in
    // src/testHomeEnvGuard.test.ts (docs/commander/07 §4.14).
    //
    // `isTest` stays *.test.ts(x) on purpose: vitest's `include` collects only
    // those, so a `.test.js` never executes and guarding it would be theatre.
    // If `include` ever grows, widen `isTest` in the same change.
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '*.ts',
        '*.tsx',
        '*.mts',
        '*.cts',
        '*.js',
        '*.jsx',
        '*.mjs',
        '*.cjs',
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
      .split('\0')
      .filter(Boolean)

    // Built from a string, not written as a regex literal: as a literal, this
    // line would match ITSELF, and so would every comment describing the rule.
    // (Both happened on the first run — the same self-reference trap that made
    // an explanatory comment trip the repo PII guard earlier the same day.)
    // Four holes closed after adversarial review 2026-07-19 (each was a form
    // that mocks the choke point for real while sailing past the old pattern):
    //   • `vi.doMock` — the old `(?:do)?mock` was DEAD CODE, because the API is
    //     camelCase. Worse, doMock is the NON-hoisted variant, which pairs
    //     exactly with the `await import('./lib/server/paths')` style this repo
    //     already uses — the most natural bypass was the most reliably missed.
    //   • an extension on the specifier (`'./paths.ts'`, `'./paths.js'`).
    //   • `vi.mock(import('./paths'))`, the vitest >= 2.1 form.
    //   • the call split across lines — the scan was line-by-line.
    // Still NOT caught: `vi.mock(SOME_CONST)`, where the specifier is indirect.
    // That needs resolution, not pattern-matching; the fence itself is the
    // backstop there (mocking paths does not remove testHomeGuard's own checks
    // from the other four anchors).
    const re = new RegExp(MOCK_CHOKE_POINT_PATTERN, 'g')
    const offenders: string[] = []
    for (const rel of files) {
      // Test files AND the shared harness. Scoping this to *.test.ts left the
      // HIGHEST-leverage bypass site invisible: vitest.config.ts's setupFiles
      // and the helpers under src/test/ run for the WHOLE suite, so one
      // vi.doMock there disables the fence everywhere at once — while every
      // individual test file stays clean (review 2026-07-19).
      const isTest = /\.test\.tsx?$/.test(rel)
      const isHarness = rel.startsWith('src/test/') || /^vitest\.config\.[cm]?ts$/.test(rel)
      if (!isTest && !isHarness) continue
      const src = readFileSync(join(root, rel), 'utf8')
      const lines = src.split('\n')
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        const lineNo = src.slice(0, m.index).split('\n').length
        // Prose about the rule is not a violation of it. Judged on the line the
        // match STARTS on, which is where a comment marker would sit.
        const t = (lines[lineNo - 1] ?? '').trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
        offenders.push(`${rel}:${lineNo} — ${m[0].replace(/\s+/g, ' ')}`)
      }
    }
    expect(
      offenders,
      `mocking the home choke point disables the fence for that file's whole module graph.\n` +
        `Pin process.env.OPENGROUND_HOME to a tmp dir instead (see\n` +
        `swarmOverseerBrain.launch.test.ts for the conversion).\n` +
        offenders.join('\n'),
    ).toEqual([])
  })
})

describe('the repo-root probes cannot dirty the working tree', () => {
  // Two cases in this file MUST build their throwaway home at the repo root
  // (anywhere temp is trusted by construction and would pass for the wrong
  // reason), so the only thing standing between "a run died before its finally"
  // and "the working tree is dirty" is that .gitignore matches the name.
  //
  // SCOPE, stated because the first version of this case claimed more than it
  // proved: this pins ONLY "the prefix is ignored". It does NOT stop a probe
  // from arriving with a different prefix — measured, not argued: swapping one
  // probe to `join(REPO_ROOT, 'og-fence-newprobe-')` left the suite 54/54 green
  // while check-ignore exited 1 on that name. That class — which is the 2026-07-19
  // event itself — is caught repo-wide in src/testHomeEnvGuard.test.ts
  // ("repo-tree writes only under the ignored probe prefix"). Both halves are
  // needed: that rule routes every writer through this prefix, and this case is
  // what makes routing through it worth anything.
  //
  // check-ignore, not "create it and run git status": a real dir would race the
  // sibling case that legitimately holds one while vitest runs files in
  // parallel. This asks git the same question without touching the tree.
  it('git ignores the repo-root probe prefix', () => {
    const sample = `${REPO_PROBE_PREFIX}deadbeef`
    const { status } = spawnSync('git', ['check-ignore', '-q', '--', sample], { cwd: REPO_ROOT })
    // status 1 = git ran and nothing matched — the real failure. Anything else
    // (128 = not a git tree / safe.directory, null = no git binary) is an
    // environment problem; sending that reader to "add it to .gitignore" would
    // have them edit a file that is already correct. Still fail-closed either
    // way — an unconsulted guard is not a passing guard.
    if (status === 1) {
      throw new Error(
        `.gitignore does not cover "${sample}".\n` +
          `A killed or failing run leaves that dir untracked at the repo root, which makes\n` +
          `git status dirty — swarm integration then refuses the tree and git add -A would\n` +
          `commit it. Add the prefix to .gitignore, or keep it as .og-fence-probe-*.`,
      )
    }
    expect(
      status,
      `git check-ignore could not be consulted (exit ${status ?? '(no git binary)'}). ` +
        `This is an ENVIRONMENT problem, not a .gitignore problem — do not "fix" .gitignore. ` +
        `Run the suite inside the repo, with git on PATH.`,
    ).toBe(0)
  })
})

describe('the helpers the fence is built from', () => {
  it('canonicalizePath resolves an existing dir and tolerates a missing leaf', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-fence-canon-')))
    try {
      expect(canonicalizePath(dir)).toBe(dir)
      expect(canonicalizePath(join(dir, 'a', 'b', 'c'))).toBe(join(dir, 'a', 'b', 'c'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('isSamePathOrUnder matches the dir itself and children, not sibling prefixes', () => {
    expect(isSamePathOrUnder('/a/b', '/a/b')).toBe(true)
    expect(isSamePathOrUnder('/a/b/c', '/a/b')).toBe(true)
    // The classic prefix bug: /a/bad must NOT count as under /a/b.
    expect(isSamePathOrUnder('/a/bad', '/a/b')).toBe(false)
  })
})

// ─── The derivation that was FALSE ───────────────────────────────────────────
//
// The merge with M2 (docs/commander/07-test-isolation-contract.md §2.1.1) briefly
// dropped M2's unset check, reasoning that the destination check subsumes it:
// "unset → ~/.openground → outside tmp → throws". Adversarial review refuted it
// on 2026-07-19 with a reproduction, and these are the teeth for the fix.
//
// The refutation: seven test files re-pin process.env.HOME to a throwaway dir
// (hooksInstall / swarmSafety / swarmSessions{,.integration} / worktreeCleanup /
// projectSkills / swarmTwinDispatch). Inside that window the unset fallback
// `join(homedir(), '.openground')` lands UNDER tmp, so every destination
// condition passes and the fence says nothing. Nothing was written to real data
// — the fake home absorbed it — but the DETECTION was gone in precisely the
// configuration the contract claims to cover.
describe('unset is NOT implied by the destination check', () => {
  it('THROWS on an unset OPENGROUND_HOME even while $HOME is re-pinned under tmp', async () => {
    const fake = await realpath(await mkdtemp(join(tmpdir(), 'og-fake-real-home-')))
    const savedRealHome = process.env.HOME
    try {
      process.env.HOME = fake
      delete process.env.OPENGROUND_HOME
      // PRECONDITION — without it this case could pass for the old reason and
      // prove nothing. The fallback must genuinely satisfy the destination
      // check, i.e. be a path the fence would otherwise wave through.
      expect(
        isUnderTempRoot(join(fake, '.openground')),
        'precondition: the unset fallback must land under a temp root',
      ).toBe(true)
      expect(() => openGroundHome()).toThrow(/REFUSING to resolve an OPEN GROUND home/)
      expect(() => openGroundHome()).toThrow(/OPENGROUND_HOME is UNSET/)
    } finally {
      if (savedRealHome !== undefined) process.env.HOME = savedRealHome
      await rm(fake, { recursive: true, force: true })
    }
  })

  it('THROWS on a whitespace-only OPENGROUND_HOME — blank is not a pin', () => {
    process.env.OPENGROUND_HOME = '   '
    expect(() => openGroundHome()).toThrow(/OPENGROUND_HOME is BLANK/)
  })

  it('still resolves normally when the pin is a real tmp dir', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-pinned-ok-')))
    try {
      process.env.OPENGROUND_HOME = dir
      expect(openGroundHome()).toBe(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
