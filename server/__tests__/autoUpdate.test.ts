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
