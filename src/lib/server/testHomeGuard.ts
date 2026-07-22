import { realpathSync } from 'fs'
import { homedir, tmpdir, userInfo } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'

// ─── The production-home fence (fail-CLOSED) ─────────────────────────────────
//
// WHY THIS FILE EXISTS — the 2026-07-18 incident. A vitest run wrote the real
// ~/.openground/settings.json: the user's 45 registered projects collapsed to 3,
// and canvas.json's card layout (no backup) was lost permanently. The forensic
// evidence was unambiguous — the live settings held BOTH fixed values from
// storeSettingsRace.test.ts (projectsMigratedAt '2026-01-02T03:04:05.000Z' +
// archiveDirName '_arc'; nothing else in the repo writes that pair), and the
// registry had picked up a tmpdir that canvasCollabMirror.test.ts creates.
//
// Three failures had to line up, and all three were real:
//   1. src/test/setup-home.ts's guard was a TAUTOLOGY — it built the value with
//      join(tmpdir(), …) and then asserted startsWith(tmpdir()). It could not
//      fail, so the suite had no safety net at all, only the appearance of one.
//   2. paths.openGroundHome() re-read process.env on EVERY call, so the instant
//      OPENGROUND_HOME went missing every subsequent read AND write silently
//      retargeted the real home. No error, no signal — just quiet damage.
//   3. 17 `delete process.env.OPENGROUND_HOME` sites (4 unconditional) made
//      that "instant" routine, with containment resting entirely on vitest's
//      isolate:true — which --no-isolate (or a config that never loads) voids.
//
// So the fence lives HERE, at the resolution seam, and it is the ONE
// implementation both anchors call (paths.openGroundHome for the
// OPENGROUND_HOME-redirectable home, hooksInstall for its deliberately
// homedir()-anchored install dirs — see hooksInstall.ts:190). Two copies would
// drift, and drift between exactly those two anchors is what the 2026-07-14
// incident exploited.
//
// THE CONTRACT: while a test process is running, every OPEN GROUND home path
// must resolve under the OS temp dir. Anything else THROWS — reads included.
// Read paths are not exempt on purpose: a read that silently falls back to the
// real home is how a test discovers the user's real project registry and then
// writes it back somewhere. There is deliberately NO opt-out env var; a fence
// with a bypass is a fence that gets bypassed.
//
// FOUR TRAPS this had to survive (each cost a real audit to find):
//   • macOS /var vs /private/var. os.tmpdir() reports /var/folders/… while
//     realpath() of anything under it yields /private/var/folders/…. 36 test
//     files build their home with realpath(mkdtemp(…)), so a naive
//     startsWith(tmpdir()) rejects most of the suite on macOS and passes on
//     Linux CI. BOTH sides are canonicalized here.
//   • ENOENT on a not-yet-created dir. Several tests point OPENGROUND_HOME at
//     join(scratch,'home') and never mkdir it (swarmJanitor, swarmIntegrationLock,
//     swarmWorkerRegistry). realpathSync would throw, so canonicalize() walks up
//     to the nearest EXISTING ancestor and re-appends the missing tail.
//   • Symlinked homes must not be rewritten. swarmWorktreeTrust.test.ts points
//     OPENGROUND_HOME at a symlink and asserts the un-resolved key differs from
//     the resolved one. This guard VALIDATES and returns void — it never
//     normalizes the caller's value.
//   • A test may vi.mock('os') wholesale (editorDetect.test.ts does, exposing
//     only homedir). tmpdir() is therefore called defensively, with TMPDIR/TMP/
//     TEMP and /tmp as fallbacks — and if NOTHING resolves we throw rather than
//     wave the path through.
//
// Outside a test process this is inert: production resolves the real
// ~/.openground exactly as before (Electron leaves OPENGROUND_HOME unset —
// electron/main.js:747 sets it only for the self-update canary).

/**
 * True when this process is a test runner. Sampled at import AND per call.
 *
 * Deliberately NOT keyed on `NODE_ENV === 'test'` — that var is a generic
 * convention plenty of shells/dotfiles/unrelated tools export ambiently (and
 * leave exported), unlike the VITEST-specific markers below. Keying on it
 * meant any user who had `NODE_ENV=test` sitting in their shell environment
 * for an unrelated reason would arm this fence inside a real, packaged
 * Electron launch — and the fence THROWS on the real home by design, so that
 * launch would crash at boot. Nothing in this repo's actual test paths (unit
 * vitest run, e2e's playwright-spawned server) depends on the NODE_ENV
 * fallback: vitest always sets VITEST/VITEST_WORKER_ID itself, and e2e's
 * webServer isolates HOME/OPENGROUND_HOME directly without ever setting
 * NODE_ENV=test (playwright.config.ts). (Found 2026-07-20.)
 */
const detectTestProcess = (): boolean =>
  Boolean(
    process.env.VITEST ||
      process.env.VITEST_WORKER_ID ||
      process.env.VITEST_POOL_ID ||
      (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__,
  )

// Latched at import time so a test that clears its own VITEST markers mid-run
// can't switch the fence off. The per-call read is OR'd in for the reverse
// case (markers appearing after this module loaded) — both directions round
// toward "guard is ON".
const TEST_AT_IMPORT = detectTestProcess()

export const isTestProcess = (): boolean => TEST_AT_IMPORT || detectTestProcess()

/**
 * realpath() that tolerates a path whose leaf doesn't exist yet: walk up to the
 * nearest existing ancestor, canonicalize THAT, then re-append the missing tail.
 * Pure read — it never creates anything.
 */
export const canonicalizePath = (input: string): string => {
  let cur = resolve(input)
  const tail: string[] = []
  for (;;) {
    try {
      return tail.length ? join(realpathSync(cur), ...[...tail].reverse()) : realpathSync(cur)
    } catch {
      const parent = dirname(cur)
      // Hit the filesystem root without resolving anything (or lost read
      // permission on every ancestor) — fall back to the lexical form.
      if (parent === cur) return resolve(input)
      tail.push(basename(cur))
      cur = parent
    }
  }
}

/** `candidate` is `root` itself, or lives beneath it. Both must be canonical. */
export const isSamePathOrUnder = (candidate: string, root: string): boolean => {
  const [a, b] =
    process.platform === 'win32'
      ? [candidate.toLowerCase(), root.toLowerCase()]
      : [candidate, root]
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * The REAL user's home, read from the passwd entry — **immune to `$HOME`**.
 *
 * `homedir()` returns `$HOME` when it is set, so every baseline built from it
 * moves the moment a runner re-pins `$HOME`. That is not an edge case here: this
 * contract REQUIRES `HOME=$(mktemp -d) npm test`. Under it, `homedir()`-derived
 * baselines pointed at the throwaway home, so condition 2 no longer knew the real
 * `~/.openground` and condition 3 was suppressed — leaving only the env-derived
 * condition 1. `TMPDIR=<the real home> npx vitest run` then passed
 * `/Users/<u>/.openground` straight through (adversarial review, 2026-07-20).
 *
 * Falls back to `homedir()` when the passwd lookup is unavailable — `vi.mock('os')`
 * without `userInfo` (editorDetect.test.ts does this), or a container with no
 * passwd entry. Falling back is fine: it lands on the previous behaviour rather
 * than on "no baseline at all".
 */
const passwdHome = (): string => {
  try {
    const info = typeof userInfo === 'function' ? userInfo() : null
    const h = info?.homedir
    if (typeof h === 'string' && h) return h
  } catch {
    // No passwd entry for this uid — fall through.
  }
  return homedir()
}

// Captured AT IMPORT. TWO homes, deliberately kept apart:
//
//   PASSWD_HOMEDIR     the real user's home. THE DATA THIS FENCE PROTECTS.
//                      Does not move when a runner isolates $HOME.
//   EFFECTIVE_HOMEDIR  where THIS process's homedir()-anchored paths actually
//                      land (hooksInstall / claudeTrust / …). Equal to the above
//                      on a normal machine; a throwaway dir under `HOME=$(mktemp -d)`.
//
// Conflating them is what created the hole: the thing to protect and the thing a
// test may legitimately write under are not the same path once $HOME is isolated.
const PASSWD_HOMEDIR = canonicalizePath(passwdHome())
const REAL_OPENGROUND_HOME = canonicalizePath(join(passwdHome(), '.openground'))
const EFFECTIVE_HOMEDIR = canonicalizePath(homedir())

/**
 * Every plausible temp root, canonicalized. os.tmpdir() first, then the env
 * vars it reads, then /tmp — so a suite that mocks `os` away still has a fence.
 *
 * THIS LIST IS ENV-CONTROLLED AND IS TREATED AS SUCH. TMPDIR/TMP/TEMP are
 * ordinary mutable variables, so a caller can widen "what counts as temp" to
 * anything, including `$HOME` or `/`. Nothing is filtered out here — an earlier
 * version DID discard any root containing the real home, and that silently
 * disarmed the ENTIRE fence under `HOME=$(mktemp -d)` (every root contains that
 * home, so no roots survived and every path read as "not under tmp"); it was
 * removed in 5258a1e.
 *
 * So this list may only ever GRANT condition 1, never suppress a check. The
 * defence against a poisoned TMPDIR lives in REAL_HOME_IS_TEMPORARY below,
 * which is deliberately computed WITHOUT reference to these roots.
 *
 * (A previous version of this docstring claimed the discard was still here.
 * It was not — the comment outlived the code by one commit, and a safety
 * rationale that describes an unimplemented defence is worse than no comment:
 * it is exactly what hid the hole that adversarial review found on 2026-07-19.)
 */
const tempRoots = (): string[] => {
  const raw: string[] = []
  try {
    const t = tmpdir?.()
    if (typeof t === 'string' && t) raw.push(t)
  } catch {
    // vi.mock('os') replaced the module without tmpdir — fall through.
  }
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    const v = process.env[key]
    if (v) raw.push(v)
  }
  if (process.platform !== 'win32') raw.push('/tmp')
  // Plain array + includes rather than a Set: spreading a Set back out needs
  // downlevelIteration under this tsconfig target, and the list is 2-4 entries.
  const roots: string[] = []
  for (const r of raw) {
    const c = canonicalizePath(r)
    if (!c || roots.includes(c)) continue
    roots.push(c)
  }
  return roots
}

/** True when `p` canonically sits under a temp root. Used by tests + the assert. */
export const isUnderTempRoot = (p: string): boolean => {
  const roots = tempRoots()
  if (roots.length === 0) return false // can't prove safety ⇒ not safe
  const canon = canonicalizePath(p)
  return roots.some((root) => isSamePathOrUnder(canon, root))
}

// Structurally TRUSTED temp locations — hardcoded, never env-derived.
//
// These decide the one question whose answer SUPPRESSES a check, so they must
// not be reachable from TMPDIR/TMP/TEMP. Absolute prefixes are used rather than
// name heuristics because they cannot be widened by anything short of the OS
// layout changing.
// Exported ONLY so testHomeGuard.test.ts can pin its exact contents — a test
// that widens or empties this list must go red (see "TRUSTED_TEMP_PREFIXES is
// pinned" in that file). Nothing else may import this; it is read-only data,
// not a seam to branch on.
export const TRUSTED_TEMP_PREFIXES =
  process.platform === 'win32'
    ? []
    : ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders']

// Is the process's own home DIRECTORY a throwaway? True when the runner
// isolated it (`HOME=$(mktemp -d) npm test`, the way this contract tells people
// to run the suite), false on a normal machine.
//
// COMPUTED WITHOUT tempRoots() — this is the fix for the hole adversarial review
// found on 2026-07-19, and the reason matters more than the code. It used to be
// `isUnderTempRoot(REAL_HOMEDIR)`, i.e. derived from the same env-controlled list
// it is meant to defend against. Set `TMPDIR=$HOME` and the real home becomes
// "under a temp root", so this flipped to true, so condition 3 fell silent FOR
// THE WHOLE PROCESS — and condition 2 only knows about ~/.openground, which
// leaves every homedir-anchored path (~/.claude, ~/.claude.json) unguarded.
// Measured end to end, not argued: under `TMPDIR=$HOME npx vitest run` a test
// calling installHooks() wrote the user's REAL ~/.claude/settings.json (their
// global Claude config) and ~/.openground/hooks/, and claudeTrust could
// read-modify-write the real ~/.claude.json (OAuth tokens). Sampling at import
// did not help: the poisoning is in place before the module loads.
//
// Two requirements, both necessary:
//   • the home sits under a TRUSTED prefix (kills `TMPDIR=/`, `TMPDIR=/Users`,
//     `TMPDIR=/scratch` — none of which put the home anywhere temp-like);
//   • STRICTLY under it, never equal (kills `TMPDIR=$HOME`, where the "root"
//     IS the home — a poisoning shape, not an isolated runner).
// `HOME=$(mktemp -d)` keeps working in both environments the contract names:
// macOS gives /private/var/folders/…/T/tmp.X, Linux CI gives /tmp/tmp.X, and
// both are strict descendants of a trusted prefix. No 5258a1e regression.
const homeIsThrowaway = (home: string): boolean => {
  if (process.platform === 'win32') {
    // No stable absolute prefix to hardcode. Require a literal Temp/Tmp segment,
    // which the OS location (…\AppData\Local\Temp\…) always has and a plain
    // profile dir (C:\Users\<u>) never does. Weaker than the POSIX rule — noted
    // in docs/commander/07-test-isolation-contract.md §3.
    return home.split(/[\\/]/).some((seg) => /^te?mp$/i.test(seg))
  }
  return TRUSTED_TEMP_PREFIXES.some((root) => home !== root && isSamePathOrUnder(home, root))
}

// Asked of BOTH homes, because they answer different questions:
//   passwd    — is the user's real home itself throwaway? Almost never; it stays
//               false under `HOME=$(mktemp -d)`, which is exactly what keeps the
//               real home protected while the suite runs isolated.
//   effective — is THIS process's $HOME throwaway? True under an isolated runner,
//               and that is what makes writing beneath it legal (no 5258a1e
//               regression: the homedir-anchored resolvers land there).
const PASSWD_HOME_IS_TEMPORARY = homeIsThrowaway(PASSWD_HOMEDIR)
const EFFECTIVE_HOME_IS_TEMPORARY = homeIsThrowaway(EFFECTIVE_HOMEDIR)

// NO MEMOIZATION — deliberately. An earlier version cached passes keyed by
// (anchor, home), reasoning that "a value that canonicalizes under tmp can't
// drift into the real home". That reasoning is false: canonicalization is a
// FILESYSTEM query, and the filesystem mutates. A test may legitimately pin a
// not-yet-created tmp path (supported, and asserted), then later create a
// symlink at that exact path pointing into the real home — routine in this
// suite. The cached pass would then wave every subsequent write through the
// symlink into ~/.openground, and the cache would be the ONLY reason it got
// there. Re-validating costs a few realpath syscalls per call, and only inside
// a test process (production returns at the isTestProcess check below, before
// any of this runs). Correctness over microseconds.
// Found by adversarial review 2026-07-19.

/** Best-effort name of the test file currently executing, for attribution. */
const currentTestFile = (): string | undefined => {
  const w = (globalThis as { __vitest_worker__?: { filepath?: string; ctx?: { filepath?: string } } })
    .__vitest_worker__
  return w?.filepath ?? w?.ctx?.filepath
}

/**
 * WHY `home` IS UNSAFE UNDER TEST — or null when it is fine. FOUR conditions,
 * all required. The temp-root test alone is not enough, because TMPDIR/TMP/TEMP
 * are ordinary mutable env vars: point one at $HOME and "under a temp root"
 * becomes true for the very thing being protected.
 *
 * THE ONE IMPLEMENTATION. The fence below and src/test/setup-home.ts's per-test
 * re-verification both call this. They used to carry separate copies, and the
 * copies had DRIFTED: setup-home checked conditions 1-2 and not 3, so in an
 * environment where the temp dir sits inside $HOME (`TMPDIR=$HOME/tmp`, real on
 * some CI images) setup-home pronounced the pin safe while the fence rejected
 * it — thousands of red tests with no actionable message and nobody to blame.
 * That is the same "two anchors, two predicates" asymmetry as the 2026-07-14
 * incident, reproduced inside the very file that documents it. Keep it one copy.
 * (Found by adversarial review 2026-07-19.)
 */
export const testHomeProblem = (
  home: string,
  opts: { requireExplicitPin?: boolean } = {},
): string | null => {
  // Inert outside a test process, same as the fence. It is exported (setup-home
  // needs it) and therefore ships in the server bundle, so without this a future
  // production caller would silently start doing realpath work and judging the
  // real home. A guard's blast radius should not depend on nobody importing it.
  if (!isTestProcess()) return null
  const raw = process.env.OPENGROUND_HOME
  // Condition 0 FIRST, before touching the filesystem. canonicalizePath('')
  // resolves the process cwd, which THROWS (uv_cwd ENOENT) when the cwd has been
  // removed underneath the process — and setup-home passes '' for the unset
  // case. That throw would escape verifyAndRepin BEFORE its repair line, turning
  // an actionable "ISOLATION BROKEN" into an opaque ENOENT and leaving isolation
  // broken for the rest of the worker. Ordering, not luck (review 2026-07-19).

  //  0. (redirectable anchor only) OPENGROUND_HOME is SET to something
  //     non-blank. This is the M2 half of the fence, kept EXPLICITLY because
  //     deriving it from conditions 1-3 is WRONG — proven by adversarial review
  //     2026-07-19, after this file had shipped a comment claiming otherwise.
  //     The claim was: "unset falls back to ~/.openground, which is not under
  //     tmp, so condition 1 fires anyway." That holds only while $HOME is the
  //     REAL home. Seven test files re-pin process.env.HOME to a throwaway dir
  //     (hooksInstall / swarmSafety / swarmSessions{,.integration} /
  //     worktreeCleanup / projectSkills / swarmTwinDispatch). Inside that
  //     window `join(homedir(), '.openground')` lands UNDER tmp and satisfies
  //     all three — so an unset OPENGROUND_HOME resolved silently, exactly the
  //     2026-07-18 mechanism, with only the fake home saving the data.
  if (opts.requireExplicitPin && !(raw && raw.trim())) {
    return `OPENGROUND_HOME is ${
      raw === undefined ? 'UNSET' : 'BLANK'
    } — the home would be derived from $HOME instead of an explicit test pin`
  }
  //  1. under a temp root at all.
  const canon = canonicalizePath(home)
  if (!isUnderTempRoot(home)) {
    return `the resolved home is outside every OS temp root (canonical: ${canon})`
  }
  //  2. never the production ~/.openground itself — a path can canonicalize
  //     under a temp root AND into the real home at once (a symlink beneath
  //     /tmp aimed at it), so it is rejected however it was reached.
  if (isSamePathOrUnder(canon, REAL_OPENGROUND_HOME)) {
    return `the resolved home is the real ${REAL_OPENGROUND_HOME} (or inside it) — a temp path that symlinks into it is still the real thing`
  }
  //  3. never anywhere under a home directory that holds REAL DATA. Asked of
  //     BOTH homes, and suppressed per-home only when THAT home is a throwaway.
  //
  //     One check was not enough. It used the `homedir()` baseline, which under
  //     `HOME=$(mktemp -d)` — the way this contract MANDATES running the suite —
  //     is the throwaway home, so the check suppressed itself and the real home
  //     went unguarded. Splitting it means the isolated runner still gets to
  //     write beneath its own scratch home (effective: throwaway ⇒ allowed)
  //     while the user's actual home stays refused (passwd: not throwaway ⇒
  //     rejected). Found by adversarial review 2026-07-20 with a reproduction.
  const homes: { path: string; temporary: boolean; label: string }[] = [
    { path: PASSWD_HOMEDIR, temporary: PASSWD_HOME_IS_TEMPORARY, label: "the real user's home" },
    { path: EFFECTIVE_HOMEDIR, temporary: EFFECTIVE_HOME_IS_TEMPORARY, label: "this process's $HOME" },
  ]
  for (const h of homes) {
    if (h.temporary || !isSamePathOrUnder(canon, h.path)) continue
    return `the resolved home sits under ${h.label} (${h.path}). If your OS temp dir is INSIDE that home (e.g. TMPDIR=$HOME/tmp) this rejects every pin: run with a TMPDIR outside it, or isolate $HOME itself (HOME=$(mktemp -d))`
  }
  return null
}

/**
 * THE FENCE. No-op outside a test process; throws inside one when `home` is not
 * under the OS temp dir.
 *
 * @param home  the resolved home path (validated as-is, never rewritten)
 * @param anchor which resolver asked — named in the error so the fix is obvious
 */
export const assertTestHomeIsolated = (
  home: string,
  anchor: string,
  opts: { requireExplicitPin?: boolean } = {},
): void => {
  if (!isTestProcess()) return
  const problem = testHomeProblem(home, opts)
  if (!problem) return
  const envValue = process.env.OPENGROUND_HOME
  const pinned = !opts.requireExplicitPin || Boolean(envValue && envValue.trim())
  const where = currentTestFile()
  const roots = tempRoots()
  const message = [
    // NB: camelCase tag on purpose. The repo PII guard's encoded-path regex
    // (repoPiiGuard.test.ts:71, /-(?:Users|home)-(\w+)/) reads a hyphenated
    // "…-home-<word>" spelling as a leaked /home/<user> segment and fails the
    // suite. Same reason this chapter is docs/commander/07-test-isolation-
    // contract.md rather than a "…-safety" name.
    `[testHomeGuard] REFUSING to resolve an OPEN GROUND home while tests are running.`,
    `  reason:            ${problem}`,
    `  anchor:            ${anchor}`,
    `  resolved home:     ${home}`,
    `  canonical:         ${canonicalizePath(home)}`,
    `  temp roots:        ${roots.length ? roots.join(', ') : '(none resolvable!)'}`,
    `  OPENGROUND_HOME:   ${envValue === undefined ? '(unset)' : envValue}`,
    `  HOME:              ${process.env.HOME ?? '(unset)'} → homedir() ${homedir()}`,
    // The home this fence exists to defend, printed NEXT TO the effective one so
    // the split is visible at a glance — under `HOME=$(mktemp -d)` those two
    // lines disagree, and that disagreement is the whole point of the passwd
    // baseline. Without this line the message named every path involved EXCEPT
    // the one being protected, which is also what made the teeth for this case
    // unsatisfiable under the very command the contract mandates (2026-07-20).
    // Prints productionHome() — not the canonicalized REAL_OPENGROUND_HOME —
    // so the value here and the value the test asserts are the same expression.
    `  protected home:    ${productionHome()} (passwd — immune to $HOME)`,
    where ? `  offending test:    ${where}` : `  offending test:    (unknown — see stack below)`,
    ``,
    `This is the 2026-07-18 data-loss fence: a test run once overwrote the real`,
    `~/.openground/settings.json and destroyed 45 registered projects. Reads are`,
    `blocked too, so nothing can discover the real registry and write it back.`,
    ``,
    !pinned
      ? `FIX: something UNSET or blanked OPENGROUND_HOME (a bare \`delete process.env.OPENGROUND_HOME\`?).\n     Restore the saved value instead of deleting it — src/test/setup-home.ts pins it.\n     NOTE: this fires even though the fallback would have landed under tmp — the test\n     re-pinned $HOME, so "it resolved somewhere harmless" was luck, not containment.`
      : anchor.includes('homedir')
        ? `FIX: this anchor follows $HOME, not OPENGROUND_HOME. Pin process.env.HOME to a\n     tmpdir in the test's beforeEach as well (see hooksInstall.test.ts:62).`
        : `FIX: point OPENGROUND_HOME at a mkdtemp(join(tmpdir(), …)) dir.`,
  ].join('\n')

  // Surface it even if a tolerant caller swallows the throw: several read paths
  // wrap fs access in try/catch, and a fence you can't see is a fence you stop
  // trusting. (Prior art: a fail-closed check defeated by a tolerant reader.)
  console.error(message)
  throw new Error(message)
}

/** The real, un-redirectable production home — what the fence exists to protect. */
export const productionHome = (): string => join(passwdHome(), '.openground')
