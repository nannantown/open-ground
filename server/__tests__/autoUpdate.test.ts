import { describe, it, expect } from 'vitest'
import { hasLiveForkedChildren, applyDownloadedUpdate } from '../../electron/autoUpdate'

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
