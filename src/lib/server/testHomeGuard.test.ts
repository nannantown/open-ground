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
  productionHome,
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

// Where the ONE remaining repo-root probe below builds its throwaway dir, and
// under what name. Both halves are load-bearing; neither is free to drift.
// (There were two. The other one — the "fake real home" for the TMPDIR-poisoning
// cases — no longer creates anything at all: it needs a path, not a directory,
// and anchoring it at the repo root was actively masking what it tested from
// inside a swarm worktree. See fakeRealHome() below.)
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
 * A throwaway world with its own idea of where "temp" is, so a case can hold a
 * path the fence MUST refuse without going anywhere near the user's data.
 *
 * Everything lives under one mkdtemp dir; TMPDIR is then stubbed at its `tmp/`
 * SUBdirectory. From the fence's point of view `unsafeHome` is therefore not
 * under any temp root — structurally identical to a real, populated $HOME — and
 * `tmp/` is a legitimate temp location.
 *
 * This indirection is not decoration. The first version of these cases used
 * `join(homedir(), '.openground-fence-probe-*')` as the stand-in for "unsafe",
 * which silently stops being unsafe when the runner isolates HOME — and
 * `HOME=$(mktemp -d) npm test` is exactly how this contract says to run the
 * suite. Seven cases passed for the wrong reason in one environment and failed
 * in the other. The world is built locally so both environments agree.
 */
const unsafeWorld = async () => {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'og-fence-world-')))
  const fakeTmp = join(outer, 'tmp')
  const unsafeHome = join(outer, 'home')
  await mkdir(fakeTmp, { recursive: true })
  await mkdir(unsafeHome, { recursive: true })
  vi.stubEnv('TMPDIR', fakeTmp)
  return {
    outer,
    /** A legitimate temp location under the stubbed TMPDIR. */
    tmp: fakeTmp,
    /** Outside every temp root — what the fence must refuse. */
    unsafeHome,
    cleanup: () => rm(outer, { recursive: true, force: true }),
  }
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
      const target = join(w.unsafeHome, '.openground')
      expect(existsSync(target), 'precondition: target must not pre-exist').toBe(false)
      process.env.OPENGROUND_HOME = target
      await expect(setSettings({ archiveDirName: '_fence_probe' })).rejects.toThrow(/REFUSING/)
      // The real assertion: not "it threw" but "nothing was written".
      await assertNeverCreated(target, 'setSettings')
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
  it('refuses a non-tmp $HOME through the same one fence', async () => {
    const w = await unsafeWorld()
    try {
      expect(() =>
        assertTestHomeIsolated(w.unsafeHome, 'hooksInstall (homedir-anchored)'),
      ).toThrow(/REFUSING/)
      // …and its FIX line must point at $HOME, not OPENGROUND_HOME.
      expect(() =>
        assertTestHomeIsolated(w.unsafeHome, 'hooksInstall (homedir-anchored)'),
      ).toThrow(/Pin process\.env\.HOME/)
    } finally {
      await w.cleanup()
    }
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
  // This test never goes near the real home. It builds a fake one and shrinks
  // the temp-root set around it (TMPDIR is stubbed at a SUBdirectory), so the
  // fake home is "not under tmp" from the fence's point of view — the same
  // shape as a real unpinned $HOME, with nothing of the user's at stake.
  it('throws instead of renaming, and leaves the legacy dir untouched', async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), 'og-legacy-')))
    try {
      const innerTmp = join(outer, 'tmp')
      const fakeHome = join(outer, 'home')
      const legacy = join(fakeHome, '.hove')
      await mkdir(innerTmp, { recursive: true })
      await mkdir(legacy, { recursive: true })
      await writeFile(join(legacy, 'settings.json'), '{"projects":[{"id":"real"}]}')

      // Temp roots become {innerTmp, /tmp} — fakeHome is under NEITHER.
      vi.stubEnv('TMPDIR', innerTmp)
      vi.stubEnv('HOME', fakeHome)
      // A destination that IS under a temp root and does NOT exist — the exact
      // precondition that arms the migration branch.
      vi.stubEnv('OPENGROUND_HOME', join(innerTmp, 'never-created-home'))

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
      await rm(outer, { recursive: true, force: true })
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
