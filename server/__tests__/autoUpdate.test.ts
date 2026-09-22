import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  INSTALL_WATCHDOG_MS,
  STAGE_WAIT_MS,
  eagerSquirrelHandoff,
  installStagingRequired,
  installReadiness,
  waitForInstallStaged,
  hasLiveForkedChildren,
  applyDownloadedUpdate,
} from '../../electron/autoUpdate'

// Regression guard for the electron-updater "Restart now" no-op bug (observed
// 2026-06-25, fixed in 0.11.8 / commit cc529d9; see electron/autoUpdate.js for the
// full story). The whole defect was an ORDERING + PREDICATE interaction that no
// test covered:
//
//   • before-quit reaps the forked server child by preventDefault()-ing the quit.
//   • quitAndInstall() (electron-updater's apply step) ALSO triggers a quit.
//   • If before-quit intercepts THAT quit, the install is skipped → "Restart now"
//     silently does nothing.
//
// The fix: the "Restart now" branch tears the server down FIRST, so by the time
// quitAndInstall fires before-quit's "are there live children?" predicate is false
// and it returns early without intercepting. These assertions ARE the proof of the
// goal's observable condition (1): "before-quit does not block quitAndInstall and
// Restart now works." They fail loudly if someone reorders the teardown or weakens
// the predicate.

describe('hasLiveForkedChildren (before-quit predicate)', () => {
  it('a present, un-killed serverChild is live → before-quit would reap', () => {
    expect(hasLiveForkedChildren({ serverChild: { killed: false } })).toBe(true)
  })

  it('no children → not live → before-quit returns early (no preventDefault)', () => {
    expect(hasLiveForkedChildren({})).toBe(false)
    expect(hasLiveForkedChildren({ serverChild: null })).toBe(false)
  })

  it('a SIGKILLed serverChild reads as not-live even before its exit fires', () => {
    // The robustness of the quitAndInstall ordering on the force-kill path: Node sets
    // child.killed=true synchronously when the signal is sent, so the gate clears
    // without waiting for the process to be reaped.
    expect(hasLiveForkedChildren({ serverChild: { killed: true } })).toBe(false)
  })

  it('any of the self-update children (canary/build/e2e) keeps the gate live', () => {
    expect(hasLiveForkedChildren({ activeCanaryHandle: { child: {} } })).toBe(true)
    expect(hasLiveForkedChildren({ activeBuildChild: { killed: false } })).toBe(true)
    expect(hasLiveForkedChildren({ activeE2eChild: { killed: false } })).toBe(true)
    // A canary handle with no child is not live (mid-teardown).
    expect(hasLiveForkedChildren({ activeCanaryHandle: { child: null } })).toBe(false)
  })

  it('packaged steady state — only serverChild ever exists, all else null', () => {
    expect(
      hasLiveForkedChildren({
        serverChild: null,
        activeCanaryHandle: null,
        activeBuildChild: null,
        activeE2eChild: null,
      }),
    ).toBe(false)
  })
})

describe('applyDownloadedUpdate ("Restart now" sequence)', () => {
  it('sets quitting, tears down, THEN quitAndInstall — in that exact order', async () => {
    const calls: string[] = []
    let quittingSetTo: boolean | null = null

    await applyDownloadedUpdate({
      setQuitting: (v) => {
        quittingSetTo = v
        calls.push('setQuitting')
      },
      shutdownServerChild: async () => {
        calls.push('shutdownServerChild')
      },
      quitAndInstall: () => {
        calls.push('quitAndInstall')
      },
    })

    expect(quittingSetTo).toBe(true)
    // The cutover ordering: flag first, teardown next, install LAST.
    expect(calls).toEqual(['setQuitting', 'shutdownServerChild', 'quitAndInstall'])
  })

  it('does NOT call quitAndInstall before teardown has settled', async () => {
    const calls: string[] = []
    let releaseTeardown!: () => void
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve
    })

    const done = applyDownloadedUpdate({
      setQuitting: () => calls.push('setQuitting'),
      shutdownServerChild: async () => {
        calls.push('teardown:start')
        await teardownGate
        calls.push('teardown:end')
      },
      quitAndInstall: () => calls.push('quitAndInstall'),
    })

    // Let microtasks drain while teardown is still pending: quitAndInstall must NOT
    // have fired yet (the exact bug — applying before the server is reaped).
    await Promise.resolve()
    expect(calls).not.toContain('quitAndInstall')
    expect(calls).toContain('teardown:start')

    releaseTeardown()
    await done
    expect(calls).toEqual(['setQuitting', 'teardown:start', 'teardown:end', 'quitAndInstall'])
  })

  it('still applies the update even if teardown rejects (install not held hostage)', async () => {
    const calls: string[] = []

    await applyDownloadedUpdate({
      setQuitting: () => calls.push('setQuitting'),
      shutdownServerChild: async () => {
        calls.push('teardown')
        throw new Error('child refused SIGTERM')
      },
      quitAndInstall: () => calls.push('quitAndInstall'),
    }).catch(() => calls.push('caught'))

    // .finally fires quitAndInstall regardless; the returned promise still rejects so
    // the caller's .catch sees it — but the update was applied.
    expect(calls).toEqual(['setQuitting', 'teardown', 'quitAndInstall', 'caught'])
  })

  it('INTEGRATION: when quitAndInstall fires, before-quit no longer intercepts', async () => {
    // The end-to-end invariant, both teardown mechanisms. We model the live state the
    // before-quit handler reads, mutate it the way main.js's terminateChild does, and
    // assert that AT THE MOMENT quitAndInstall runs the gate is already clear — so the
    // quit it triggers sails through before-quit's early return.
    for (const teardownStyle of ['null-out (happy path)', 'mark-killed (SIGKILL path)']) {
      const state: { serverChild: { killed: boolean } | null } = {
        serverChild: { killed: false },
      }
      // Sanity: before teardown the gate is live (before-quit WOULD reap).
      expect(hasLiveForkedChildren(state)).toBe(true)

      let gateAtInstall: boolean | null = null
      await applyDownloadedUpdate({
        setQuitting: () => {},
        shutdownServerChild: async () => {
          if (teardownStyle.startsWith('null-out')) {
            state.serverChild = null // child exited → main.js 'exit' handler nulls it
          } else {
            state.serverChild!.killed = true // SIGKILL sent → killed flips synchronously
          }
        },
        quitAndInstall: () => {
          gateAtInstall = hasLiveForkedChildren(state)
        },
      })

      // The crux: by quitAndInstall time the gate is clear, so before-quit's
      // `if (!hasChildren) return` fires and does NOT preventDefault the quit.
      expect(gateAtInstall, teardownStyle).toBe(false)
    }
  })
})

// ── The 2026-09-11 sighting of the SAME failure type: "Restart now" did nothing ──
// The owner restarted repeatedly and kept getting the same "0.11.106 has been
// downloaded" dialog. Cause: main.js drove electron-updater's
// `autoInstallOnAppQuit` from the user's hands-free setting, but on macOS that
// flag is not policy — it decides whether the downloaded zip is handed to
// Squirrel.Mac AT ALL. With it false, MacUpdater.quitAndInstall() registers a
// listener and RETURNS WITHOUT QUITTING (electron-updater 6.8.3,
// out/MacUpdater.js), so the app tore its server down and then just sat there.
describe('eagerSquirrelHandoff (autoInstallOnAppQuit is plumbing on macOS)', () => {
  it('macOS is ALWAYS eager — the user setting cannot switch it off', () => {
    // The regression itself: `false` here is what broke "Restart now".
    expect(eagerSquirrelHandoff('darwin', false)).toBe(true)
    expect(eagerSquirrelHandoff('darwin', true)).toBe(true)
  })

  it('Windows/Linux keep the flag as documented POLICY — it follows the setting', () => {
    // There the flag really does mean "install on quit" (electron-updater's
    // BaseUpdater adds the quit handler), so a user who turned hands-free
    // updates off must not get an install on every quit.
    expect(eagerSquirrelHandoff('win32', false)).toBe(false)
    expect(eagerSquirrelHandoff('win32', true)).toBe(true)
    expect(eagerSquirrelHandoff('linux', false)).toBe(false)
    expect(eagerSquirrelHandoff('linux', true)).toBe(true)
  })

  it('a non-boolean setting never reads as consent (off-platform)', () => {
    // Same strict narrowing as autoUpdateFromSettingsRaw: only a literal true.
    expect(eagerSquirrelHandoff('win32', 'yes' as unknown as boolean)).toBe(false)
    expect(eagerSquirrelHandoff('win32', 1 as unknown as boolean)).toBe(false)
    // …but macOS stays true regardless, because it is not a consent question.
    expect(eagerSquirrelHandoff('darwin', undefined as unknown as boolean)).toBe(true)
  })
})

describe('applyDownloadedUpdate — the stuck-install watchdog', () => {
  it('arms the watchdog BEFORE quitAndInstall, and fires it when the app is still alive', async () => {
    const calls: string[] = []
    let fire: (() => void) | null = null

    await applyDownloadedUpdate({
      setQuitting: () => {},
      shutdownServerChild: async () => calls.push('teardown') as unknown as void,
      // Model the macOS defect exactly: the install call returns and the process
      // survives it.
      quitAndInstall: () => calls.push('quitAndInstall'),
      onStuck: () => calls.push('onStuck'),
      timers: {
        setTimeout: (fn: () => void) => {
          calls.push('armed')
          fire = fn
          return { unref: () => calls.push('unref') }
        },
        watchdogMs: 1,
      },
    })

    // Armed first: on the happy path quitAndInstall never returns, so a watchdog
    // armed after it would not exist.
    expect(calls).toEqual(['teardown', 'armed', 'unref', 'quitAndInstall'])
    expect(fire).toBeTypeOf('function')
    fire!()
    expect(calls).toContain('onStuck')
  })

  it('reports a quitAndInstall that THROWS, instead of swallowing it', async () => {
    const calls: string[] = []
    let fire: (() => void) | null = null

    await applyDownloadedUpdate({
      setQuitting: () => {},
      shutdownServerChild: async () => {},
      quitAndInstall: () => {
        throw new Error('Squirrel refused the staged update')
      },
      onStuck: () => calls.push('onStuck'),
      timers: {
        setTimeout: (fn: () => void) => {
          fire = fn
          return null
        },
        watchdogMs: 1,
      },
    }).catch(() => calls.push('caught'))

    // The throw still propagates (caller's .catch), but the watchdog was already
    // armed, so the user is told rather than left with a dead window.
    expect(calls).toEqual(['caught'])
    fire!()
    expect(calls).toEqual(['caught', 'onStuck'])
  })

  it('no onStuck ⇒ no timer at all (the pre-existing callers stay unchanged)', async () => {
    const calls: string[] = []
    await applyDownloadedUpdate({
      setQuitting: () => {},
      shutdownServerChild: async () => {},
      quitAndInstall: () => calls.push('quitAndInstall'),
      timers: {
        setTimeout: () => {
          calls.push('armed')
          return null
        },
        watchdogMs: 1,
      },
    })
    expect(calls).toEqual(['quitAndInstall'])
  })

  it('the default watchdog delay is generous enough for a real Squirrel unpack', () => {
    // Not a magic-number echo: the point is that it must exceed the slowest
    // legitimate install (Squirrel.Mac unpacking a ~180 MB asar-less bundle),
    // and must still be short enough that a user is not left guessing for long.
    expect(INSTALL_WATCHDOG_MS).toBeGreaterThanOrEqual(30_000)
    expect(INSTALL_WATCHDOG_MS).toBeLessThanOrEqual(5 * 60_000)
  })
})

// ── WIRING GUARD (structure, not review) ──────────────────────────────────────
// The pure decisions above cannot catch the defect that actually shipped: the
// helper was right, the CALL SITE was wrong. main.js is not unit-testable (it
// imports Electron), so the wiring is pinned by reading the source — the same
// idiom gateEnvParity.test.ts uses for the self-update steps table. Both
// failures this module documents (2026-06-25, 2026-09-11) were wiring, so this
// is where the guard has to live.
describe('electron/main.js wiring — autoInstallOnAppQuit and the watchdog', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const main = readFileSync(join(repoRoot, 'electron/main.js'), 'utf8')
  // Strip comment lines first: this file talks ABOUT the old spellings at
  // length, and prose must never satisfy (or break) a source pin.
  const code = main
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  it('every autoInstallOnAppQuit assignment goes through eagerSquirrelHandoff (or a literal true)', () => {
    const assignments = Array.from(code.matchAll(/autoInstallOnAppQuit\s*=\s*([^\n]+)/g)).map((m) =>
      m[1].trim(),
    )
    expect(assignments.length, 'no assignment found — update this guard, not the app').toBeGreaterThan(0)
    for (const rhs of assignments) {
      expect(
        /^eagerSquirrelHandoff\(/.test(rhs) || /^true\b/.test(rhs),
        `autoInstallOnAppQuit = ${rhs} — on macOS this flag is plumbing, not policy: ` +
          'false there makes "Restart now" return without quitting. Use eagerSquirrelHandoff().',
      ).toBe(true)
    }
    // The specific regression: driving it straight off the user setting.
    expect(code).not.toMatch(/autoInstallOnAppQuit\s*=\s*autoUpdateEnabled\(\)/)
  })

  it('the platform really is consulted — eagerSquirrelHandoff is passed process.platform', () => {
    const calls = Array.from(code.matchAll(/eagerSquirrelHandoff\(([^)]*)\)/g)).map((m) => m[1])
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).toContain('process.platform')
  })

  it('every "apply the update" call site carries the stuck-install watchdog', () => {
    // A silent no-op is the failure mode; onStuck is the only thing that speaks.
    const applyCalls = code.split('applyDownloadedUpdate({').slice(1)
    expect(applyCalls.length, 'no apply site found — update this guard, not the app').toBeGreaterThan(0)
    for (const call of applyCalls) {
      // Look only as far as the call's own closing brace-paren.
      const body = call.slice(0, call.indexOf('})'))
      expect(body).toContain('onStuck:')
    }
  })

  it('NOTHING applies an update without passing the readiness gate first', () => {
    // The 2026-09-11 second half: tearing the back-end down while macOS is still
    // unpacking leaves an unusable window that will not quit. applyDownloadedUpdate
    // performs that teardown, so every route to it must come through
    // applyUpdateWhenStaged — which waits, with the app whole, when not ready.
    // A new "just apply it" shortcut is exactly the regression to catch here.
    const gate = 'async function applyUpdateWhenStaged'
    expect(code, 'the readiness gate is gone — this guard guards nothing').toContain(gate)
    const applySites = Array.from(code.matchAll(/applyDownloadedUpdate\(\{/g)).map((m) => m.index ?? 0)
    expect(applySites.length).toBe(1)
    // …and that one site sits INSIDE the gate function.
    const gateStart = code.indexOf(gate)
    expect(applySites[0]).toBeGreaterThan(gateStart)
    // Both doors (the dialog and the hands-free loop) call the gate.
    expect(Array.from(code.matchAll(/applyUpdateWhenStaged\(/g)).length).toBeGreaterThanOrEqual(3)
  })

  it('the readiness gate only waits when staging is OBSERVABLE', () => {
    // A darwin build whose native-updater handle failed to wire would otherwise
    // sit out the whole STAGE_WAIT_MS on an update that may well be ready.
    const gateBody = code.slice(code.indexOf('async function applyUpdateWhenStaged'))
    expect(gateBody).toMatch(/nativeUpdaterHandle && installReadiness\(/)
  })
})

// ── The readiness gate (the second half of the 2026-09-11 report) ────────────
// Pinning autoInstallOnAppQuit true moves staging to download time, so a click
// is USUALLY instant. Click within seconds of the dialog and it is not — and the
// old sequence tore the back-end down anyway, leaving a window that could not be
// used and would not quit, silently, for as long as unpacking took.
describe('installStagingRequired / installReadiness', () => {
  it('macOS must stage before the app can quit; other platforms need not', () => {
    expect(installStagingRequired('darwin')).toBe(true)
    expect(installStagingRequired('win32')).toBe(false)
    expect(installStagingRequired('linux')).toBe(false)
  })

  it('on macOS an UNSTAGED update means WAIT — never tear the back-end down', () => {
    expect(installReadiness('darwin', false)).toBe('staging')
    expect(installReadiness('darwin', true)).toBe('ready')
  })

  it('off macOS it is always ready — quitAndInstall runs the installer itself', () => {
    expect(installReadiness('win32', false)).toBe('ready')
    expect(installReadiness('linux', false)).toBe('ready')
  })

  it('a non-boolean staged flag is not "ready" (fail toward waiting, never toward a dead window)', () => {
    expect(installReadiness('darwin', undefined as unknown as boolean)).toBe('staging')
    expect(installReadiness('darwin', 'yes' as unknown as boolean)).toBe('staging')
  })
})

describe('waitForInstallStaged', () => {
  it('resolves immediately when already staged, without subscribing', async () => {
    let subscribed = false
    await expect(
      waitForInstallStaged({
        isStaged: () => true,
        onStaged: () => {
          subscribed = true
          return () => {}
        },
      }),
    ).resolves.toBe(true)
    expect(subscribed).toBe(false)
  })

  it('resolves true when the OS reports staging, and unsubscribes', async () => {
    let notify: (() => void) | null = null
    let off = 0
    const p = waitForInstallStaged({
      isStaged: () => false,
      onStaged: (cb) => {
        notify = cb
        return () => {
          off += 1
        }
      },
      timers: { setTimeout: () => null, clearTimeout: () => {}, timeoutMs: 1 },
    })
    notify!()
    await expect(p).resolves.toBe(true)
    // The listener is detached exactly once — a retained listener on a long-lived
    // native updater would fire into a dead closure on the next download.
    expect(off).toBe(1)
  })

  it('CLOSES THE SUBSCRIBE RACE: staged between the first check and the listener', async () => {
    // The edge that would otherwise cost the whole timeout on a ready update:
    // Squirrel finishes in the gap, so the event has already been emitted and
    // will never be emitted again. Only the post-subscribe re-check catches it.
    let staged = false
    await expect(
      waitForInstallStaged({
        isStaged: () => staged,
        onStaged: () => {
          staged = true // the event landed while we were subscribing
          return () => {}
        },
        timers: { setTimeout: () => null, clearTimeout: () => {}, timeoutMs: 1 },
      }),
    ).resolves.toBe(true)
  })

  it('resolves false on timeout, and never resolves twice', async () => {
    let fireTimeout: (() => void) | null = null
    let notify: (() => void) | null = null
    const p = waitForInstallStaged({
      isStaged: () => false,
      onStaged: (cb) => {
        notify = cb
        return () => {}
      },
      timers: {
        setTimeout: (fn: () => void) => {
          fireTimeout = fn
          return 'h'
        },
        clearTimeout: () => {},
        timeoutMs: 1,
      },
    })
    fireTimeout!()
    await expect(p).resolves.toBe(false)
    // A late native event must not re-settle (it would resolve a settled promise
    // and, worse, suggest the wait succeeded after we already said it did not).
    expect(() => notify!()).not.toThrow()
  })

  it('a missing unsubscribe is tolerated (the handle may already be gone)', async () => {
    let notify: (() => void) | null = null
    const p = waitForInstallStaged({
      isStaged: () => false,
      onStaged: (cb) => {
        notify = cb
        // returns void — no unsubscribe available
      },
      timers: { setTimeout: () => null, clearTimeout: () => {}, timeoutMs: 1 },
    })
    notify!()
    await expect(p).resolves.toBe(true)
  })

  it('the default wait is long enough for a real unpack, and bounded', () => {
    expect(STAGE_WAIT_MS).toBeGreaterThanOrEqual(60_000)
    expect(STAGE_WAIT_MS).toBeLessThanOrEqual(15 * 60_000)
  })
})

describe('applyDownloadedUpdate — the pending-install marker (beforeInstall)', () => {
  it('runs beforeInstall AFTER teardown + watchdog arming and BEFORE quitAndInstall', async () => {
    const calls: string[] = []
    await applyDownloadedUpdate({
      setQuitting: () => calls.push('setQuitting') as unknown as void,
      shutdownServerChild: async () => calls.push('teardown') as unknown as void,
      quitAndInstall: () => calls.push('quitAndInstall') as unknown as void,
      onStuck: () => {},
      beforeInstall: () => calls.push('beforeInstall') as unknown as void,
      timers: { setTimeout: () => (calls.push('armed'), null), watchdogMs: 1 },
    })
    // The marker must be on disk BEFORE the process can vanish inside quitAndInstall.
    expect(calls).toEqual(['setQuitting', 'teardown', 'armed', 'beforeInstall', 'quitAndInstall'])
  })

  it('a beforeInstall that THROWS never blocks the install', async () => {
    const calls: string[] = []
    await applyDownloadedUpdate({
      setQuitting: () => {},
      shutdownServerChild: async () => {},
      quitAndInstall: () => calls.push('quitAndInstall') as unknown as void,
      beforeInstall: () => {
        throw new Error('disk full')
      },
    })
    expect(calls).toEqual(['quitAndInstall'])
  })
})

describe('electron/main.js wiring — the updater has a memory (2026-09-13)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const main = readFileSync(join(repoRoot, 'electron/main.js'), 'utf8')
  const code = main
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  it('no updater line goes to the console alone — every one rides the file logger', () => {
    // The exact defect: 17 `[updater]` lines that only a Terminal launch could read.
    expect(code).not.toMatch(/console\.(log|error|warn)\((['`])\[updater\]/)
    expect(code).toContain("makeUpdaterLogger({ path: updaterLogPath(), tag: 'updater' })")
  })

  it("electron-updater's own narrative is pointed at the same file", () => {
    expect(code).toMatch(/autoUpdater\.logger = makeUpdaterLogger\(/)
  })

  it('the apply site writes the pending-install marker, and boot checks it before wiring the updater', () => {
    const apply = code.slice(code.indexOf('applyDownloadedUpdate({'))
    expect(apply.slice(0, apply.indexOf('})'))).toContain('beforeInstall:')
    expect(code).toContain('writePendingInstall({ path: pendingInstallPath()')
    const boot = code.indexOf('reportFailedInstallOnBoot()')
    const init = code.indexOf('initAutoUpdater()')
    expect(boot).toBeGreaterThan(-1)
    expect(init).toBeGreaterThan(-1)
    expect(boot).toBeLessThan(init)
    expect(code).toContain("showUpdateDialog('install-failed'")
  })

  it('the OS installer\'s errors are logged, and a re-announced SAME version keeps its staged flag', () => {
    expect(code).toMatch(/nativeUpdaterHandle\.on\('error'/)
    // The desync: resetting squirrelStaged on every electron-updater
    // 'update-downloaded' forgot a staging Squirrel will not repeat.
    expect(code).toContain('downloadedUpdate.version !== version) squirrelStaged = false')
  })
})

// ⚠ CEILING OF THIS BLOCK, READ BEFORE TRUSTING IT (rework, 2026-09-22).
// Everything below greps electron/main.js as TEXT. It cannot run Electron, so
// it pins that the right calls exist in the right ORDER in the source — never
// that they execute. A wiring change that keeps the text and moves it somewhere
// unreachable (e.g. the `will-quit` registration sliding inside the
// `if (!gotLock)` branch, or behind an early return) leaves every assertion
// here GREEN while the feature is dead. The only thing that catches that class
// is the packaged-app pass in docs/VERIFICATION.md §4.1 — which is why the
// updater.log line formats are part of this card's handover, not an extra.
describe('electron/main.js wiring — the ShipIt pre-flight (2026-09-21 "zero runs")', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const main = readFileSync(join(repoRoot, 'electron/main.js'), 'utf8')
  const code = main
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  it('asks launchd BEFORE the staging wait and the teardown, and stops on "block"', () => {
    const fn = code.slice(code.indexOf('async function applyUpdateWhenStaged'))
    const pre = fn.indexOf('await shipItPreflight()')
    const wait = fn.indexOf('waitForInstallStaged(')
    const apply = fn.indexOf('applyDownloadedUpdate({')
    expect(pre).toBeGreaterThan(-1)
    expect(pre).toBeLessThan(wait)
    expect(pre).toBeLessThan(apply)
    expect(fn.slice(pre, wait)).toContain("preflight.decision === 'block'")
    expect(fn.slice(pre, wait)).toContain('reportInstallBlocked(')
    expect(code).toContain("showUpdateDialog('install-blocked'")
  })

  it('a disabled job is enabled and RE-READ before the decision — never decided on the first read alone', () => {
    const fn = code.slice(code.indexOf('async function shipItPreflight'))
    const enable = fn.indexOf("launchctl(['enable'")
    const again = fn.indexOf("probeShipIt('after-enable')")
    const decide = fn.indexOf('decideInstallPreflight(')
    expect(enable).toBeGreaterThan(-1)
    expect(again).toBeGreaterThan(enable)
    expect(decide).toBeGreaterThan(again)
  })

  it('the pre-flight NEVER kickstarts — too early for the job, too early for the relaunch flag', () => {
    // 2026-09-22 rework, against Squirrel.Mac's source: the request is written
    // and the job submitted in -prepareUpdateForInstallation: at STAGING time
    // (SQRLUpdater.m:1070-1089, from :526), and the pre-flight below runs
    // BEFORE this file waits for staging — so the job may not exist yet. And
    // `launchAfterInstallation` is only set to YES inside quitAndInstall
    // (:1092-1110), so a kick from here would swap the app WITHOUT relaunching
    // it: the user quits into a version that never comes back up.
    const fn = code.slice(code.indexOf('async function shipItPreflight'), code.indexOf('const LOGIN_ITEMS_SETTINGS_URL'))
    expect(fn).not.toContain('kickstart')
    // The ordering that makes (a) true: the pre-flight precedes the staging wait.
    const apply = code.slice(code.indexOf('async function applyUpdateWhenStaged'))
    // Both must EXIST before the ordering means anything: `indexOf` returning
    // -1 for a deleted pre-flight would otherwise satisfy `-1 < n` silently.
    const preIdx = apply.indexOf('await shipItPreflight()')
    const waitIdx = apply.indexOf('waitForInstallStaged(')
    expect(preIdx).toBeGreaterThan(-1)
    expect(waitIdx).toBeGreaterThan(-1)
    expect(preIdx).toBeLessThan(waitIdx)
  })

  it('the kickstart is SYNCHRONOUS, bounded, and never carries -k', () => {
    const fn = code.slice(code.indexOf('function kickstartShipItSync'), code.indexOf('async function shipItPreflight'))
    expect(fn).toContain("'kickstart'")
    // -k kills a ShipIt that may be mid-install: the one destructive move here.
    expect(fn).not.toContain('-k')
    // will-quit has no event loop left, so an async call would never return.
    expect(fn).toContain('execFileSync')
    expect(fn).toMatch(/timeout:\s*\d+/)
  })

  it('the ONLY kickstart call site is will-quit, and it re-checks the installed version first', () => {
    // The armed flag is set in two places and consumed in exactly one.
    expect(code.match(/kickstartShipItSync\(/g)).toHaveLength(2) // definition + the one call
    const quit = code.slice(code.indexOf('function kickstartShipItBeforeExit'))
    const check = quit.indexOf('decideArmedRecoveryAtQuit(')
    const kick = quit.indexOf('kickstartShipItSync(')
    expect(check).toBeGreaterThan(-1)
    expect(kick).toBeGreaterThan(check)
    // Armed exactly twice: the install we are quitting for, and a self-repair.
    expect(code.match(/armedKickstart = \{ why:/g)).toHaveLength(2)
    expect(code).toContain("app.on('will-quit'")
    expect(code).toContain('kickstartShipItBeforeExit()')
    // THE ARM GATE. Without this early return every ordinary ⌘Q kickstarts the
    // installer; it is the one line standing between "self-repair" and "pokes
    // the OS installer on every quit forever". Since 2026-09-22 it returns the
    // unarmed-quit RELAUNCH WRITE — which is not a kick; the guard that the
    // unarmed path never kicks is the `kickstartShipItSync(` count above plus
    // the dedicated test below.
    expect(quit.slice(0, kick)).toContain('if (!armedKickstart) return relaunchUnarmedStagedInstall()')
    // Only the SELF-REPAIR arm re-verifies the relaunch flag. The install arm
    // must not, or an unreadable request would disable the whole fix.
    expect(code).toContain('verifyRelaunch: true')
    expect(code).toContain('verifyRelaunch: false')
    const verify = quit.indexOf('if (verifyRelaunch)')
    expect(verify).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(kick)
    expect(quit.slice(verify, kick)).toContain('relaunchesAfterInstall')
  })



  it('an install we are quitting for WRITES the relaunch instruction — armed branch only, before the kick', () => {
    // 2026-09-22: an install ran with `launchAfterInstallation` still NO and
    // the app never reopened. The flag is Squirrel's to write only inside
    // quitAndInstall, which on macOS can return without quitting — so for a
    // quit we own, the app states the relaunch itself.
    const quit = code.slice(code.indexOf('function kickstartShipItBeforeExit'))
    const gate = quit.indexOf('if (!armedKickstart) return')
    const branch = quit.indexOf('} else if (!stateRelaunchForInstall(')
    const kick = quit.indexOf('kickstartShipItSync(')
    expect(gate).toBeGreaterThan(-1)
    // THE BRANCH, not just the ordering: the write must live in the `else` of
    // `if (verifyRelaunch)`. Hoisted out of it (measured: the ordering-only
    // version of this test stayed green) it would also force a relaunch for the
    // SELF-REPAIR arm, which can fire on a quit the user chose — the ⌘Q bug.
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeGreaterThan(gate)
    expect(branch).toBeLessThan(kick)
    // A refusal must STOP the kick, never fall through to it.
    expect(quit.slice(branch, kick)).toContain('return')
    const fn = code.slice(code.indexOf('function stateRelaunchForInstall'), code.indexOf('function kickstartShipItBeforeExit'))
    expect(code.match(/ensureRelaunchAfterInstall\(/g)).toHaveLength(1)
    // It really writes — and atomically. A truncating writeFileSync that dies
    // halfway leaves ShipIt a request it cannot parse: no install AND no
    // relaunch, on a quit that already told the next boot it was installing.
    // The IO pair is the SHARED one (electron/shipIt.js), whose atomic write +
    // tmp cleanup is exercised for real in shipIt.test.ts. main.js must not
    // grow a second, unexercised copy of it.
    expect(fn).toContain('ensureRelaunchAfterInstall(shipItRequestIO(shipItStatePath()))')
    expect(fn).not.toContain('writeFileSync(')
    // Never bless a request that installs something else (a relaunched
    // downgrade is worse than no relaunch), and never kick an install whose
    // reopen we could not write.
    expect(fn).toContain('stagedShipItVersion()')
    expect(fn).toMatch(/staged !== version[\s\S]*return false/)
    expect(fn).toMatch(/'already-set'[\s\S]*return true/)
    // SELF-REPAIR stays read-only for the same ⌘Q reason.
    const selfRepair = quit.slice(quit.indexOf('if (verifyRelaunch)'), branch)
    expect(selfRepair).not.toContain('stateRelaunchForInstall(')
    expect(selfRepair).toContain('relaunchesAfterInstall')
  })

  it('AN ORDINARY QUIT that applies a staged update also writes the relaunch — but never kicks', () => {
    // Owner decision, 2026-09-22: an update that lands on a plain ⌘Q should
    // reopen the app too. Squirrel's staged request says NO, so somebody has to
    // write it, and the only process that can is this one, on its way out.
    const quit = code.slice(code.indexOf('function kickstartShipItBeforeExit'))
    expect(quit).toContain('if (!armedKickstart) return relaunchUnarmedStagedInstall()')
    const fn = code.slice(
      code.indexOf('function relaunchUnarmedStagedInstall'),
      code.indexOf('function kickstartShipItBeforeExit'),
    )
    expect(fn).toContain('stateRelaunchForInstall(')
    // NOT a kick. An unarmed quit still never pokes launchd — that half of the
    // arm gate is the whole reason this is a separate function and not a
    // widened branch. (`kickstartShipItSync(` appearing exactly twice in the
    // file, pinned above, is the same claim counted globally.)
    expect(fn).not.toContain('kickstart')
    // NO SECOND WRITE PATH: it reuses the one reviewed write site, so the three
    // refusals in stateRelaunchForInstall / ensureRelaunchAfterInstall (an
    // unrecognisable request, a missing targetBundleURL, a failed write) cover
    // this caller unchanged.
    expect(fn).not.toContain('ensureRelaunchAfterInstall(')
    expect(fn).not.toContain('writeFileSync(')
  })

  it('…and it stands down when the staged install cannot be read — silence beats a wrong promise', () => {
    // The unarmed quit has no version it quit FOR, so the armed path's version
    // gate has no input here. What stands in is "can we read what is about to
    // be installed at all": the request must parse and the bundle it points at
    // must yield a version. If not, write nothing — the behaviour before this
    // change, which is the safe side of a path that replaces an app bundle.
    const fn = code.slice(
      code.indexOf('function relaunchUnarmedStagedInstall'),
      code.indexOf('function kickstartShipItBeforeExit'),
    )
    const gate = fn.indexOf('if (!decideUnarmedStagedRelaunch(')
    const write = fn.indexOf('stateRelaunchForInstall(')
    expect(fn).toContain('const staged = stagedShipItVersion()')
    expect(gate).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(gate) // the check must PRECEDE the write
    // And it is macOS-and-packaged only: ShipIt exists nowhere else, and a dev
    // run has no request to bless.
    expect(fn).toMatch(/process\.platform !== 'darwin' \|\| !app\.isPackaged[\s\S]*return/)
    expect(fn.indexOf("process.platform !== 'darwin'")).toBeLessThan(gate)
  })

  it('THE LITTER GATE: a staged bundle of the version we are RUNNING is leftovers — never written to', () => {
    // Rework, 2026-09-22, measured on the owner's Mac: ShipItState.plist held
    // `launchAfterInstallation:false` for a staged 0.11.121 while /Applications
    // AND the running process were also 0.11.121 — the request and the
    // `update.*` bundle both SURVIVE a successful install, so "a staged bundle
    // reads" is the steady state of any Mac that has ever updated, not a
    // pending install. A truthiness-only gate writes YES into that litter on
    // every quit forever; only the VERSION tells the two apart (the same fact
    // `pendingShipItRequest`'s comment already states).
    const fn = code.slice(
      code.indexOf('function relaunchUnarmedStagedInstall'),
      code.indexOf('function kickstartShipItBeforeExit'),
    )
    // The staged version is COMPARED against the running one, not merely
    // tested for truthiness. The comparison itself (equal ⇒ no, OLDER ⇒ no,
    // newer ⇒ yes) is pure and pinned behaviourally in shipIt.test.ts; this
    // only pins that main.js routes through it and bails on false.
    expect(fn).toMatch(/const staged = stagedShipItVersion\(\)/)
    expect(fn).toMatch(
      /if \(!decideUnarmedStagedRelaunch\(\{ stagedVersion: staged, runningVersion: app\.getVersion\(\) \}\)\) return/,
    )
    expect(fn).not.toMatch(/if \(!stagedShipItVersion\(\)\) return/)
  })

  it('a quitAndInstall that never quit DISARMS the kickstart — or a later ⌘Q would reopen the app', () => {
    // The arm is made for the quit that is happening now. The install watchdog
    // firing proves that quit did not happen (MacUpdater can return without
    // quitting), and the arm must not ride the user's next, deliberate quit.
    const apply = code.slice(code.indexOf('async function applyUpdateWhenStaged'))
    const stuck = apply.indexOf('onStuck: ()')
    const arm = apply.indexOf('armedKickstart = { why:')
    expect(stuck).toBeGreaterThan(-1)
    expect(arm).toBeGreaterThan(-1)
    expect(apply.slice(stuck, arm)).toContain('armedKickstart = null')
    // The version we quit to install rides along, so will-quit can check it.
    expect(apply.slice(arm, arm + 200)).toContain('verifyRelaunch: false, version')
  })
  it('boot self-repair ARMS rather than fires, at most once per from→to, marker written BEFORE arming', () => {
    const fn = code.slice(code.indexOf('function armInstallSelfRepair'), code.indexOf('function kickstartShipItBeforeExit'))
    expect(fn).toContain('decideBootRecovery(')
    // The staged VERSION (a leftover update.* dir survives a successful
    // install — measured on a real Mac, 2026-09-22), read from the REQUEST
    // ShipIt actually replays.
    expect(fn).toContain('stagedShipItVersion()')
    const staged = code.slice(code.indexOf('function pendingShipItRequest'), code.indexOf('function armInstallSelfRepair'))
    // The path literal moved into the helper both sides share; pin it there and
    // pin that the reader still goes through the helper (otherwise "contains
    // ShipItState.plist" would be satisfied by the helper alone).
    expect(code).toContain("shipItLabel(shipItAppId()), 'ShipItState.plist')")
    expect(staged).toContain('shipItStatePath()')
    expect(staged).toContain('parseShipItRequest(')
    // Never a directory walk: readdir order could name a build the request does
    // not point at, and a deeper nesting would read as "nothing staged".
    expect(staged).not.toContain('readdirSync')
    // Never starts ShipIt here: a parked ShipIt installs on whatever quit comes
    // next, including one after the user hand-installed a NEWER build.
    expect(fn).not.toContain('kickstartShipItSync(')
    const write = fn.indexOf('writePendingInstall({ path: marker')
    const arm = fn.indexOf('armedKickstart = {')
    expect(write).toBeGreaterThan(-1)
    expect(arm).toBeGreaterThan(write)
    // Packaged macOS only — dev builds have no ShipIt job to kick.
    expect(fn).toContain("process.platform !== 'darwin' || !app.isPackaged")
    // And it only ever arms off a 'failed' verdict.
    const boot = code.slice(code.indexOf('function reportFailedInstallOnBoot'))
    expect(boot.indexOf('armInstallSelfRepair(')).toBeGreaterThan(boot.indexOf("verdict.kind !== 'failed'"))
  })

  it("logs the job's state at boot, right after the pending-install verdict", () => {
    const boot = code.indexOf('reportFailedInstallOnBoot()')
    const probe = code.indexOf("probeShipIt('boot')")
    const init = code.indexOf('initAutoUpdater()')
    expect(probe).toBeGreaterThan(boot)
    expect(probe).toBeLessThan(init)
  })

  it('launchctl is best-effort and bounded — a non-zero exit still yields its text', () => {
    const fn = code.slice(code.indexOf('async function launchctl'), code.indexOf('async function probeShipIt'))
    expect(fn).toContain("if (process.platform !== 'darwin') return null")
    expect(fn).toMatch(/timeout:\s*\d+/)
    expect(fn).toContain('err.stdout')
  })
})
