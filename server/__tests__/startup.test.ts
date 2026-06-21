import { describe, it, expect } from 'vitest'
import { runStartupSequence } from '../../electron/startup'

// Tests for the whenReady startup ordering (electron/startup.js).
//
// The load-bearing invariant (white-screen-after-reinstall fix): the Chromium-
// cache self-heal runs BEFORE the window is created/loaded, so the renderer never
// reads a cache we are about to delete. electron/main.js routes its whenReady
// block through runStartupSequence; here we feed spies and assert the cache reset
// precedes window creation AND load. If a future edit reorders the steps so the
// clear lands after the window comes up, these assertions go red.
//
// (start() owns createWindow + loadURL in electron/main.js — it is the SOLE
// creator/loader of the window — so locking "resetCaches before start()" locks
// "resetCaches before createWindow/loadURL". The spies below model that.)

describe('startup — runStartupSequence ordering', () => {
  it('runs cache reset before window create AND load (the white-screen invariant)', async () => {
    const order: string[] = []
    await runStartupSequence({
      resetCaches: () => order.push('resetCaches'),
      registerIpc: () => order.push('registerIpc'),
      // start() owns createWindow + loadURL in main.js; model both here.
      start: async () => {
        order.push('createWindow')
        order.push('loadURL')
      },
    })

    expect(order).toEqual(['resetCaches', 'registerIpc', 'createWindow', 'loadURL'])
    // The two guarantees the white-screen fix depends on, stated explicitly.
    // (toContain first: indexOf('resetCaches') would be -1 if the reset were
    // dropped entirely, and -1 < n is trivially true — so guard its presence
    // independently of the deep-equal above before comparing positions.)
    expect(order).toContain('resetCaches')
    expect(order.indexOf('resetCaches')).toBeLessThan(order.indexOf('createWindow'))
    expect(order.indexOf('resetCaches')).toBeLessThan(order.indexOf('loadURL'))
  })

  it('reset still precedes window load when start() resolves asynchronously', async () => {
    const order: string[] = []
    await runStartupSequence({
      resetCaches: () => order.push('resetCaches'),
      registerIpc: () => {},
      start: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push('loadURL')
            resolve()
          }, 5)
        }),
    })
    expect(order).toEqual(['resetCaches', 'loadURL'])
  })

  it('does NOT begin window bringup if the cache reset throws (reset is strictly first)', () => {
    // Causal proof of ordering: if resetCaches throws, start() is never reached.
    // (In main.js resetStaleCachesOnVersionChange is itself try/wrapped and never
    // throws — this asserts the helper's ordering contract, not its error policy.)
    let startCalled = false
    expect(() =>
      runStartupSequence({
        resetCaches: () => {
          throw new Error('boom')
        },
        registerIpc: () => {},
        start: () => {
          startCalled = true
        },
      }),
    ).toThrow('boom')
    expect(startCalled).toBe(false)
  })

  it("returns start()'s result so the caller can await window bringup", async () => {
    let resolved = false
    const ret = runStartupSequence({
      resetCaches: () => {},
      registerIpc: () => {},
      start: async () => {
        resolved = true
      },
    })
    expect(ret).toBeInstanceOf(Promise)
    await ret
    expect(resolved).toBe(true)
  })
})
