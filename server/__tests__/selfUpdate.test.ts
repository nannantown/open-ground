import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import {
  runSelfUpdateCycle,
  performEngineSwitch,
  performRollback,
  killProcessTree,
  gracefulGroupKill,
  processSubtreeGroups,
  runRegressionSteps,
} from '../../electron/selfUpdate'

// Tests for the unmanned self-update cycle (electron/selfUpdate.js) — the pure
// orchestration that lets the in-app swarm engine REPLACE ITSELF after a
// self-improvement merge: rebuild → canary (separate port) → /api/health →
// switch / stay. Every side effect is injected, so we drive each safety branch
// (rebuild-fail, canary-unhealthy, switch-fail) without Electron, a build, or a
// socket. These assertions ARE the proof of the goal's observable conditions:
//   (1) a merge runs a rebuild, (2) a canary is health-probed by bootId echo,
//   (3) health OK → switch, (4) health NG → DO NOT switch (stay on old), and the
//   switch path is cleanly separated with a rollback seam (onSwitchFailure).

/** A spy that records its label (and optional detail) into a shared call log,
 *  so tests can assert ORDER, not just that something ran. */
function makeLog() {
  const lines: Array<{ level: string; msg: string }> = []
  const log = (level: string, msg: string) => lines.push({ level, msg })
  const text = () => lines.map((l) => l.msg).join('\n')
  return { log, lines, text }
}

const CANARY = { child: { id: 'canary' }, port: 47901, bootId: 'canary-boot' }
const NEW_ENGINE = { child: { id: 'new' }, port: 47776, bootId: 'new-boot' }

describe('runSelfUpdateCycle', () => {
  it('happy path: rebuild → canary → health OK → switch, in that order', async () => {
    const calls: string[] = []
    const { log, text } = makeLog()
    const healthArgs: Array<{ port: number; bootId: string }> = []

    const result = await runSelfUpdateCycle({
      rebuild: async () => {
        calls.push('rebuild')
        return { ok: true }
      },
      startCanary: async () => {
        calls.push('startCanary')
        return CANARY
      },
      checkHealth: async (arg) => {
        calls.push('checkHealth')
        healthArgs.push(arg)
        return true
      },
      stopCanary: async () => {
        calls.push('stopCanary')
      },
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      log,
    })

    expect(result).toEqual({ rebuilt: true, canaryHealthy: true, switched: true, reason: 'ok' })
    // The cutover only happens AFTER the canary proved the build, and the canary
    // is retired before the switch.
    expect(calls).toEqual(['rebuild', 'startCanary', 'checkHealth', 'stopCanary', 'performSwitch'])
    // Health is probed against the canary's OWN bootId (the echo proof).
    expect(healthArgs).toEqual([{ port: CANARY.port, bootId: CANARY.bootId }])
    // The unmanned story is greppable in the logs (condition 5).
    expect(text()).toContain('cycle start')
    expect(text()).toContain('rebuild OK')
    expect(text()).toContain('canary health OK')
    expect(text()).toContain('cycle complete')
  })

  it('rebuild fails → stay on old: no canary, no switch', async () => {
    const calls: string[] = []
    const { log, text } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => {
        calls.push('rebuild')
        return { ok: false, reason: 'tsc error' }
      },
      startCanary: async () => {
        calls.push('startCanary')
        return CANARY
      },
      checkHealth: async () => true,
      stopCanary: async () => {
        calls.push('stopCanary')
      },
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      log,
    })
    expect(result).toMatchObject({ rebuilt: false, switched: false, reason: 'rebuild-failed' })
    expect(calls).toEqual(['rebuild']) // nothing past the rebuild ran
    expect(text()).toContain('rebuild FAILED')
  })

  it('rebuild throws → treated as rebuild-failed (never propagates)', async () => {
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => {
        throw new Error('boom')
      },
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {},
      performSwitch: async () => ({ ok: true }),
      log,
    })
    expect(result).toMatchObject({ rebuilt: false, switched: false, reason: 'rebuild-failed' })
  })

  it('canary spawn throws → stay on old, no switch', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => {
        throw new Error('fork failed')
      },
      checkHealth: async () => true,
      stopCanary: async () => {
        calls.push('stopCanary')
      },
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      log,
    })
    expect(result).toMatchObject({ rebuilt: true, canaryHealthy: false, switched: false, reason: 'canary-spawn-failed' })
    expect(calls).toEqual([]) // no stopCanary (never started), no switch
  })

  it('canary UNHEALTHY → DO NOT switch, tear canary down, stay on old (safe side)', async () => {
    const calls: string[] = []
    const { log, text } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => false, // no bootId echo / timeout
      stopCanary: async () => {
        calls.push('stopCanary')
      },
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      log,
    })
    expect(result).toMatchObject({ rebuilt: true, canaryHealthy: false, switched: false, reason: 'canary-unhealthy' })
    expect(calls).toEqual(['stopCanary']) // canary cleaned up, switch NEVER called
    expect(text()).toContain('NOT switching')
  })

  it('checkHealth throws → treated as unhealthy → no switch', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => {
        throw new Error('connection refused')
      },
      stopCanary: async () => {
        calls.push('stopCanary')
      },
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      log,
    })
    expect(result).toMatchObject({ canaryHealthy: false, switched: false, reason: 'canary-unhealthy' })
    expect(calls).toEqual(['stopCanary'])
  })

  it('canary healthy but switch fails → reports switched:false with the switch reason', async () => {
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {},
      performSwitch: async () => ({ ok: false, reason: 'new-engine-unhealthy' }),
      log,
    })
    expect(result).toEqual({ rebuilt: true, canaryHealthy: true, switched: false, reason: 'new-engine-unhealthy' })
  })

  it('canary teardown failure is swallowed (still proceeds to switch)', async () => {
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {
        throw new Error('kill failed')
      },
      performSwitch: async () => ({ ok: true }),
      log,
    })
    expect(result).toMatchObject({ switched: true, reason: 'ok' })
  })

  // --- Regression gate (task 402d34a0, condition 2: "回帰テスト赤") ---------------

  it('regression gate GREEN → still switches (runs after canary, before switch)', async () => {
    const calls: string[] = []
    const { log, text } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => {
        calls.push('rebuild')
        return { ok: true }
      },
      startCanary: async () => {
        calls.push('startCanary')
        return CANARY
      },
      checkHealth: async () => {
        calls.push('checkHealth')
        return true
      },
      stopCanary: async () => {
        calls.push('stopCanary')
      },
      runRegressionTests: async () => {
        calls.push('regression')
        return { ok: true }
      },
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      log,
    })
    expect(result).toEqual({ rebuilt: true, canaryHealthy: true, switched: true, reason: 'ok' })
    // Gate runs AFTER the canary is retired and BEFORE the switch.
    expect(calls).toEqual(['rebuild', 'startCanary', 'checkHealth', 'stopCanary', 'regression', 'performSwitch'])
    expect(text()).toContain('regression tests GREEN')
  })

  it('regression gate RED → DO NOT switch, stay on old (reason regression-failed)', async () => {
    const calls: string[] = []
    const { log, text } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {
        calls.push('stopCanary')
      },
      runRegressionTests: async () => {
        calls.push('regression')
        return { ok: false, reason: '3 failing tests' }
      },
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      log,
    })
    expect(result).toEqual({ rebuilt: true, canaryHealthy: true, switched: false, reason: 'regression-failed' })
    // Canary retired, gate ran, switch NEVER called — the old engine is untouched.
    expect(calls).toEqual(['stopCanary', 'regression'])
    expect(text()).toContain('regression tests RED')
  })

  it('regression gate THROWS → treated as red → no switch', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {},
      runRegressionTests: async () => {
        throw new Error('vitest crashed')
      },
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      log,
    })
    expect(result).toMatchObject({ switched: false, reason: 'regression-failed' })
    expect(calls).toEqual([]) // switch never reached
  })

  it('no regression gate provided → switch still gated by health alone (back-compat)', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {},
      // runRegressionTests omitted entirely.
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      log,
    })
    expect(result).toMatchObject({ switched: true, reason: 'ok' })
    expect(calls).toEqual(['performSwitch'])
  })

  // --- onSwitchSucceeded: the MUST-FIX2 snapshot seam (only on a real cutover) ----

  it('onSwitchSucceeded fires exactly once, AFTER performSwitch, on a successful switch', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {},
      performSwitch: async () => {
        calls.push('performSwitch')
        return { ok: true }
      },
      onSwitchSucceeded: () => {
        calls.push('onSwitchSucceeded')
      },
      log,
    })
    expect(result).toMatchObject({ switched: true, reason: 'ok' })
    // The snapshot refresh happens AFTER the cutover completes (on-disk == new live engine).
    expect(calls).toEqual(['performSwitch', 'onSwitchSucceeded'])
  })

  it('onSwitchSucceeded is NEVER fired when the switch FAILS (no snapshot of a bad build)', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {},
      performSwitch: async () => ({ ok: false, reason: 'new-engine-unhealthy' }),
      onSwitchSucceeded: () => {
        calls.push('onSwitchSucceeded')
      },
      log,
    })
    expect(result).toMatchObject({ switched: false, reason: 'new-engine-unhealthy' })
    expect(calls).toEqual([]) // a rejected switch must not refresh the known-good snapshot
  })

  it('onSwitchSucceeded is NEVER fired on a canary-unhealthy reject (build left on disk is bad)', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => false, // reject before switch
      stopCanary: async () => {},
      performSwitch: async () => ({ ok: true }),
      onSwitchSucceeded: () => {
        calls.push('onSwitchSucceeded')
      },
      log,
    })
    expect(result).toMatchObject({ switched: false, reason: 'canary-unhealthy' })
    expect(calls).toEqual([])
  })

  it('onSwitchSucceeded is NEVER fired on a regression-red reject', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {},
      runRegressionTests: async () => ({ ok: false, reason: 'red' }),
      performSwitch: async () => ({ ok: true }),
      onSwitchSucceeded: () => {
        calls.push('onSwitchSucceeded')
      },
      log,
    })
    expect(result).toMatchObject({ switched: false, reason: 'regression-failed' })
    expect(calls).toEqual([])
  })

  it('a throwing onSwitchSucceeded never undoes an already-completed switch', async () => {
    const { log, text } = makeLog()
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true,
      stopCanary: async () => {},
      performSwitch: async () => ({ ok: true }),
      onSwitchSucceeded: () => {
        throw new Error('snapshot copy failed')
      },
      log,
    })
    expect(result).toEqual({ rebuilt: true, canaryHealthy: true, switched: true, reason: 'ok' })
    expect(text()).toContain('post-switch known-good snapshot failed')
  })
})

describe('performEngineSwitch', () => {
  it('happy path: stop old → start new on fixed port → health OK → reload window', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    let reloaded = false
    const healthArgs: Array<{ port: number; bootId: string }> = []

    const result = await performEngineSwitch({
      stopOldEngine: async () => {
        calls.push('stopOld')
      },
      startNewEngine: async () => {
        calls.push('startNew')
        return NEW_ENGINE
      },
      waitHealthy: async (arg) => {
        calls.push('waitHealthy')
        healthArgs.push({ port: arg.port, bootId: arg.bootId })
        return true
      },
      reloadWindow: () => {
        calls.push('reload')
        reloaded = true
      },
      log,
    })

    expect(result).toMatchObject({ ok: true, child: NEW_ENGINE.child, bootId: NEW_ENGINE.bootId })
    // Old MUST stop before new starts (single fixed port), and reload is last.
    expect(calls).toEqual(['stopOld', 'startNew', 'waitHealthy', 'reload'])
    expect(reloaded).toBe(true)
    // New engine is validated against ITS bootId on the fixed port.
    expect(healthArgs).toEqual([{ port: NEW_ENGINE.port, bootId: NEW_ENGINE.bootId }])
  })

  it('new engine fails to spawn → onSwitchFailure(stage:spawn), no reload', async () => {
    const { log } = makeLog()
    let reloaded = false
    const failures: Array<{ stage: string; error?: string }> = []
    const result = await performEngineSwitch({
      stopOldEngine: async () => {},
      startNewEngine: async () => {
        throw new Error('EADDRINUSE')
      },
      waitHealthy: async () => true,
      reloadWindow: () => {
        reloaded = true
      },
      onSwitchFailure: (info) => {
        failures.push(info)
      },
      log,
    })
    expect(result).toMatchObject({ ok: false, reason: 'new-engine-spawn-failed' })
    expect(failures).toHaveLength(1)
    expect(failures[0].stage).toBe('spawn')
    expect(failures[0].error).toContain('EADDRINUSE')
    expect(reloaded).toBe(false) // never point the window at a dead engine
  })

  it('new engine never healthy → onSwitchFailure(stage:health), no reload', async () => {
    const { log, text } = makeLog()
    let reloaded = false
    const failures: Array<{ stage: string }> = []
    const result = await performEngineSwitch({
      stopOldEngine: async () => {},
      startNewEngine: async () => NEW_ENGINE,
      waitHealthy: async () => false,
      reloadWindow: () => {
        reloaded = true
      },
      onSwitchFailure: (info) => {
        failures.push(info)
      },
      log,
    })
    expect(result).toMatchObject({ ok: false, reason: 'new-engine-unhealthy' })
    expect(failures).toEqual([{ stage: 'health' }])
    expect(reloaded).toBe(false)
    expect(text()).toContain('rollback seam')
  })

  it('waitHealthy throws → treated as unhealthy → onSwitchFailure(health)', async () => {
    const { log } = makeLog()
    const failures: Array<{ stage: string }> = []
    const result = await performEngineSwitch({
      stopOldEngine: async () => {},
      startNewEngine: async () => NEW_ENGINE,
      waitHealthy: async () => {
        throw new Error('refused')
      },
      reloadWindow: () => {},
      onSwitchFailure: (info) => {
        failures.push(info)
      },
      log,
    })
    expect(result).toMatchObject({ ok: false, reason: 'new-engine-unhealthy' })
    expect(failures).toEqual([{ stage: 'health' }])
  })

  it('failure WITHOUT a rollback handler is safe (log-only, no throw)', async () => {
    const { log, lines } = makeLog()
    const result = await performEngineSwitch({
      stopOldEngine: async () => {},
      startNewEngine: async () => NEW_ENGINE,
      waitHealthy: async () => false,
      reloadWindow: () => {},
      // onSwitchFailure omitted — the default must not crash.
      log,
    })
    expect(result).toMatchObject({ ok: false, reason: 'new-engine-unhealthy' })
    expect(lines.some((l) => l.level === 'error' && /no rollback handler/.test(l.msg))).toBe(true)
  })

  // --- R2: tear the unhealthy new engine down to free the fixed port -----------

  it('new engine unhealthy → stopNewEngine(next.child) BEFORE onSwitchFailure (frees the port)', async () => {
    const { log } = makeLog()
    const calls: string[] = []
    const stopped: unknown[] = []
    const result = await performEngineSwitch({
      stopOldEngine: async () => {
        calls.push('stopOld')
      },
      startNewEngine: async () => {
        calls.push('startNew')
        return NEW_ENGINE
      },
      waitHealthy: async () => false,
      reloadWindow: () => {},
      stopNewEngine: async (child) => {
        calls.push('stopNew')
        stopped.push(child)
      },
      onSwitchFailure: () => {
        calls.push('rollback')
      },
      log,
    })
    expect(result).toMatchObject({ ok: false, reason: 'new-engine-unhealthy' })
    // The zombie new engine is torn down (with ITS child) BEFORE the rollback runs.
    expect(calls).toEqual(['stopOld', 'startNew', 'stopNew', 'rollback'])
    expect(stopped).toEqual([NEW_ENGINE.child])
  })

  it('spawn failure → stopNewEngine is NOT called (no child was created)', async () => {
    const { log } = makeLog()
    const calls: string[] = []
    const result = await performEngineSwitch({
      stopOldEngine: async () => {},
      startNewEngine: async () => {
        throw new Error('EADDRINUSE')
      },
      waitHealthy: async () => true,
      reloadWindow: () => {},
      stopNewEngine: async () => {
        calls.push('stopNew')
      },
      onSwitchFailure: () => {
        calls.push('rollback')
      },
      log,
    })
    expect(result).toMatchObject({ ok: false, reason: 'new-engine-spawn-failed' })
    expect(calls).toEqual(['rollback']) // no stopNew — startNewEngine never returned a child
  })

  it('stopNewEngine throwing is swallowed → rollback still runs, still reports unhealthy', async () => {
    const { log, text } = makeLog()
    const calls: string[] = []
    const result = await performEngineSwitch({
      stopOldEngine: async () => {},
      startNewEngine: async () => NEW_ENGINE,
      waitHealthy: async () => false,
      reloadWindow: () => {},
      stopNewEngine: async () => {
        throw new Error('kill -9 failed')
      },
      onSwitchFailure: () => {
        calls.push('rollback')
      },
      log,
    })
    expect(result).toMatchObject({ ok: false, reason: 'new-engine-unhealthy' })
    expect(calls).toEqual(['rollback'])
    expect(text()).toContain('tearing down the unhealthy new engine failed')
  })
})

// The rollback itself (task 402d34a0): restore the last known-good build → re-fork
// on the fixed port → health → reload. These assertions ARE the proof of the goal's
// observable conditions (2) auto-restore + restart on a failed switch and (3) the
// rollback is recorded (log + a notify callback that fires on every arm).
describe('performRollback', () => {
  const RESTORED = { child: { id: 'restored' }, port: 47776, bootId: 'restored-boot' }

  it('happy path: restore → start → health OK → reload + notify(ok), in that order', async () => {
    const calls: string[] = []
    const { log, text } = makeLog()
    const notes: Array<{ ok: boolean; stage: string; goodSha?: string; reason: string }> = []
    const healthArgs: Array<{ child: unknown; port: number; bootId: string }> = []

    const result = await performRollback({
      restoreArtifacts: async () => {
        calls.push('restore')
      },
      startEngine: async () => {
        calls.push('start')
        return RESTORED
      },
      waitHealthy: async (handle) => {
        calls.push('health')
        healthArgs.push(handle)
        return true
      },
      reloadWindow: () => {
        calls.push('reload')
      },
      notify: (info) => {
        calls.push('notify')
        notes.push(info)
      },
      stage: 'health',
      goodSha: 'abc1234',
      log,
    })

    expect(result).toEqual({ ok: true, reason: 'ok' })
    expect(calls).toEqual(['restore', 'start', 'health', 'reload', 'notify'])
    expect(healthArgs).toEqual([RESTORED]) // health probed against the restored handle
    expect(notes).toEqual([{ ok: true, stage: 'health', goodSha: 'abc1234', reason: 'ok' }])
    expect(text()).toContain('survived a broken self-update')
  })

  it('restore throws → notify(restore-failed), no engine started', async () => {
    const calls: string[] = []
    const { log } = makeLog()
    const notes: Array<{ ok: boolean; reason: string }> = []
    const result = await performRollback({
      restoreArtifacts: async () => {
        throw new Error('disk full')
      },
      startEngine: async () => {
        calls.push('start')
        return RESTORED
      },
      waitHealthy: async () => true,
      reloadWindow: () => {
        calls.push('reload')
      },
      notify: (info) => notes.push(info),
      stage: 'spawn',
      goodSha: 'abc1234',
      log,
    })
    expect(result).toEqual({ ok: false, reason: 'restore-failed' })
    expect(calls).toEqual([]) // never tried to start or reload
    expect(notes).toEqual([{ ok: false, stage: 'spawn', goodSha: 'abc1234', reason: 'restore-failed' }])
  })

  it('known-good engine fails to spawn → notify(respawn-failed), no reload', async () => {
    let reloaded = false
    const { log } = makeLog()
    const notes: Array<{ ok: boolean; reason: string }> = []
    const result = await performRollback({
      restoreArtifacts: async () => {},
      startEngine: async () => {
        throw new Error('fork failed')
      },
      waitHealthy: async () => true,
      reloadWindow: () => {
        reloaded = true
      },
      notify: (info) => notes.push(info),
      stage: 'health',
      log,
    })
    expect(result).toEqual({ ok: false, reason: 'respawn-failed' })
    expect(reloaded).toBe(false)
    expect(notes).toEqual([{ ok: false, stage: 'health', goodSha: 'unknown', reason: 'respawn-failed' }])
  })

  it('known-good engine never healthy → notify(respawn-unhealthy), no reload', async () => {
    let reloaded = false
    const { log } = makeLog()
    const notes: Array<{ ok: boolean; reason: string }> = []
    const result = await performRollback({
      restoreArtifacts: async () => {},
      startEngine: async () => RESTORED,
      waitHealthy: async () => false,
      reloadWindow: () => {
        reloaded = true
      },
      notify: (info) => notes.push(info),
      stage: 'health',
      goodSha: 'def5678',
      log,
    })
    expect(result).toEqual({ ok: false, reason: 'respawn-unhealthy' })
    expect(reloaded).toBe(false)
    expect(notes).toEqual([{ ok: false, stage: 'health', goodSha: 'def5678', reason: 'respawn-unhealthy' }])
  })

  it('waitHealthy throwing is treated as unhealthy (never propagates)', async () => {
    const { log } = makeLog()
    const result = await performRollback({
      restoreArtifacts: async () => {},
      startEngine: async () => RESTORED,
      waitHealthy: async () => {
        throw new Error('connection refused')
      },
      reloadWindow: () => {},
      notify: () => {},
      stage: 'health',
      log,
    })
    expect(result).toEqual({ ok: false, reason: 'respawn-unhealthy' })
  })

  it('a throwing notify hook never breaks a successful rollback', async () => {
    const { log } = makeLog()
    const result = await performRollback({
      restoreArtifacts: async () => {},
      startEngine: async () => RESTORED,
      waitHealthy: async () => true,
      reloadWindow: () => {},
      notify: () => {
        throw new Error('notification backend down')
      },
      stage: 'health',
      goodSha: 'abc1234',
      log,
    })
    expect(result).toEqual({ ok: true, reason: 'ok' })
  })
})

// Process-group kill (task 402d34a0 MUST-FIX1): the regression child is
// npm → vitest → a FORK POOL; killing only the parent orphans the pool, which spins
// a core to saturation. killProcessTree must reap the WHOLE group.
describe('killProcessTree', () => {
  it('POSIX: group-kills via a NEGATIVE pid (reaches the whole fork pool)', () => {
    const killed: Array<[number, string]> = []
    const childKills: string[] = []
    const child = { pid: 4242, kill: (s?: string) => childKills.push(s || '') }
    killProcessTree(child, { platform: 'linux', kill: (pid, sig) => killed.push([pid, sig]) })
    expect(killed).toEqual([[-4242, 'SIGKILL']]) // negative pid → the process GROUP
    expect(childKills).toEqual([]) // group kill succeeded → no direct fallback
  })

  it('Windows: no process groups → a direct child.kill, never a negative pid', () => {
    const killed: Array<[number, string]> = []
    const childKills: string[] = []
    const child = { pid: 4242, kill: (s?: string) => childKills.push(s || '') }
    killProcessTree(child, { platform: 'win32', kill: (pid, sig) => killed.push([pid, sig]) })
    expect(killed).toEqual([])
    expect(childKills).toEqual(['SIGKILL'])
  })

  it('falls back to a direct child.kill when the group signal throws (not a leader)', () => {
    const childKills: string[] = []
    const child = { pid: 4242, kill: (s?: string) => childKills.push(s || '') }
    killProcessTree(child, {
      platform: 'linux',
      kill: () => {
        throw new Error('ESRCH')
      },
    })
    expect(childKills).toEqual(['SIGKILL'])
  })

  it('no-ops on a null / already-exited / already-killed child (never throws)', () => {
    const boom = () => {
      throw new Error('must not signal a dead/absent child')
    }
    expect(() => killProcessTree(null)).not.toThrow()
    expect(() => killProcessTree(undefined)).not.toThrow()
    expect(() =>
      killProcessTree({ pid: 1, exitCode: 0, kill: boom }, { platform: 'linux', kill: boom }),
    ).not.toThrow()
    expect(() =>
      killProcessTree({ pid: 1, killed: true, kill: boom }, { platform: 'linux', kill: boom }),
    ).not.toThrow()
  })

  // Real-process proof: a detached child + its grandchild (a vitest-style fork
  // worker) must BOTH die. A parent-only kill would leave the grandchild orphaned.
  it.skipIf(process.platform === 'win32')(
    'group-kills a real detached child AND its grandchild (no orphaned workers)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'killtree-'))
      const gcPidFile = join(dir, 'grandchild.pid')
      // child → grandchild (NOT detached, so it inherits the child's group), records
      // the grandchild's pid, both stay alive. Mirrors npm → vitest → a fork worker.
      const childSrc =
        'const cp=require("child_process"),fs=require("fs");' +
        'const gc=cp.spawn(process.execPath,["-e","setInterval(()=>{},1e9)"],{stdio:"ignore"});' +
        'fs.writeFileSync(process.env.GC_PIDFILE,String(gc.pid));' +
        'setInterval(()=>{},1e9);'
      const child = spawn(process.execPath, ['-e', childSrc], {
        detached: true, // own process group → killProcessTree can signal the whole group
        stdio: 'ignore',
        env: { ...process.env, GC_PIDFILE: gcPidFile },
      })

      const isAlive = (pid: number) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      // Condition wait: returns the instant `pred` holds; `ms` is only a CEILING.
      // Caps here are deliberately generous (15s) because the predicate watches a
      // REAL OS process spawn/die — under a saturated machine that timing stretches,
      // and a tight cap would race it and flake. A wider ceiling costs nothing on an
      // unloaded run (it returns in tens of ms) yet kills the load-sensitivity.
      const waitFor = async (pred: () => boolean, ms: number) => {
        const deadline = Date.now() + ms
        // eslint-disable-next-line no-await-in-loop
        while (Date.now() < deadline) {
          if (pred()) return true
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 25))
        }
        return pred()
      }

      let grandchildPid = -1
      try {
        const ready = await waitFor(
          () => existsSync(gcPidFile) && readFileSync(gcPidFile, 'utf8').trim() !== '',
          15000,
        )
        expect(ready).toBe(true)
        grandchildPid = Number(readFileSync(gcPidFile, 'utf8').trim())
        expect(grandchildPid).toBeGreaterThan(0)
        expect(isAlive(child.pid as number)).toBe(true)
        expect(isAlive(grandchildPid)).toBe(true)

        killProcessTree(child)

        const childDead = await waitFor(() => !isAlive(child.pid as number), 15000)
        const grandchildDead = await waitFor(() => !isAlive(grandchildPid), 15000)
        expect(childDead).toBe(true)
        // The grandchild dying is the proof the GROUP died, not just the parent.
        expect(grandchildDead).toBe(true)
      } finally {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
        try {
          if (grandchildPid > 0) process.kill(grandchildPid, 'SIGKILL')
        } catch {
          /* gone */
        }
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )
})

// The canary-promotion gate (task c76cb3f3): the canary proves the new build BOOTS,
// but a self-modification can break the LOGIC while still booting — so booting alone
// must never promote. runRegressionSteps runs the ordered test steps (unit → e2e
// smoke) against the freshly-built engine, fail-fast, and NAMES the red step so the
// engine log records WHICH test failed (condition 4). These assertions ARE the proof
// of the goal's observable conditions at the orchestration layer:
//   (2) all steps green → ok:true (the cycle then switches),
//   (3) ANY step red → ok:false (the cycle then stays on old / hands to rollback),
//   (4) the failing step is identified in both the reason and the log.
describe('runRegressionSteps', () => {
  it('all steps GREEN → ok:true, runs every step IN ORDER (condition 2)', async () => {
    const { log, text } = makeLog()
    const ran: string[] = []
    const result = await runRegressionSteps({
      steps: [
        { name: 'unit', cmd: ['npm', 'test'] },
        { name: 'e2e', cmd: ['npm', 'run', 'test:e2e'] },
      ],
      runStep: async (step) => {
        ran.push(step.name)
        return { ok: true }
      },
      log,
    })
    expect(result).toEqual({ ok: true })
    expect(ran).toEqual(['unit', 'e2e'])
    expect(text()).toContain("step 'unit' GREEN")
    expect(text()).toContain("step 'e2e' GREEN")
  })

  it('unit RED → ok:false naming unit, and e2e is NEVER run (fail-fast, condition 3+4)', async () => {
    const { log, text } = makeLog()
    const ran: string[] = []
    const result = await runRegressionSteps({
      steps: [
        { name: 'unit', cmd: ['npm', 'test'] },
        { name: 'e2e', cmd: ['npm', 'run', 'test:e2e'] },
      ],
      runStep: async (step) => {
        ran.push(step.name)
        return step.name === 'unit' ? { ok: false, reason: 'exited 1' } : { ok: true }
      },
      log,
    })
    // The reason carries the step name so the cycle/log says WHICH test went red.
    expect(result).toEqual({ ok: false, reason: 'unit: exited 1', failedStep: 'unit' })
    // Fail-fast: the expensive e2e step never spawns once unit is red.
    expect(ran).toEqual(['unit'])
    expect(text()).toContain("step 'unit' RED (exited 1)")
    expect(text()).not.toContain("step 'e2e'")
  })

  it('unit GREEN but e2e RED → ok:false naming e2e (condition 3+4)', async () => {
    const { log, text } = makeLog()
    const ran: string[] = []
    const result = await runRegressionSteps({
      steps: [
        { name: 'unit', cmd: ['npm', 'test'] },
        { name: 'e2e', cmd: ['npm', 'run', 'test:e2e'] },
      ],
      runStep: async (step) => {
        ran.push(step.name)
        return step.name === 'e2e' ? { ok: false, reason: 'exited 2' } : { ok: true }
      },
      log,
    })
    expect(result).toEqual({ ok: false, reason: 'e2e: exited 2', failedStep: 'e2e' })
    // unit ran (and passed) first; e2e ran and failed — both attempted, in order.
    expect(ran).toEqual(['unit', 'e2e'])
    expect(text()).toContain("step 'unit' GREEN")
    expect(text()).toContain("step 'e2e' RED (exited 2)")
  })

  it('a step runner that THROWS is treated as that step failing red (never propagates)', async () => {
    const { log } = makeLog()
    const result = await runRegressionSteps({
      steps: [{ name: 'unit', cmd: ['npm', 'test'] }],
      runStep: async () => {
        throw new Error('spawn boom')
      },
      log,
    })
    expect(result).toEqual({ ok: false, reason: 'unit: spawn boom', failedStep: 'unit' })
  })

  it('a step resolving without an explicit reason still fails red (reason: unknown)', async () => {
    const { log } = makeLog()
    const result = await runRegressionSteps({
      steps: [{ name: 'e2e', cmd: ['npm', 'run', 'test:e2e'] }],
      runStep: async () => ({ ok: false }),
      log,
    })
    expect(result).toEqual({ ok: false, reason: 'e2e: unknown', failedStep: 'e2e' })
  })

  it('empty / absent step list passes vacuously (back-compat with the no-gate branch)', async () => {
    const { log } = makeLog()
    const ran: string[] = []
    const runStep = async (step: { name: string }) => {
      ran.push(step.name)
      return { ok: true }
    }
    expect(await runRegressionSteps({ steps: [], runStep, log })).toEqual({ ok: true })
    expect(await runRegressionSteps({ steps: undefined as never, runStep, log })).toEqual({ ok: true })
    expect(ran).toEqual([])
  })

  it('integrates with runSelfUpdateCycle: an e2e-red gate keeps the engine on old (condition 3)', async () => {
    // Drive the WHOLE cycle with runRegressionSteps as the real gate dep, proving a
    // build that BOOTS (canary healthy) but fails e2e is NOT promoted.
    const { log, text } = makeLog()
    let switched = false
    const result = await runSelfUpdateCycle({
      rebuild: async () => ({ ok: true }),
      startCanary: async () => CANARY,
      checkHealth: async () => true, // canary BOOTS fine — health alone would promote
      stopCanary: async () => {},
      runRegressionTests: () =>
        runRegressionSteps({
          steps: [
            { name: 'unit', cmd: ['npm', 'test'] },
            { name: 'e2e', cmd: ['npm', 'run', 'test:e2e'] },
          ],
          runStep: async (step) =>
            step.name === 'e2e' ? { ok: false, reason: 'exited 1' } : { ok: true },
          log,
        }),
      performSwitch: async () => {
        switched = true
        return { ok: true }
      },
      log,
    })
    // Boots but e2e red → stay on old, never switch (the gap this task closes).
    expect(switched).toBe(false)
    expect(result).toMatchObject({ canaryHealthy: true, switched: false, reason: 'regression-failed' })
    // The engine log names the red test (condition 4).
    expect(text()).toContain("step 'e2e' RED")
    expect(text()).toContain('regression tests RED (e2e: exited 1)')
  })
})

// The e2e forced-kill fix (task c76cb3f3 review-B M1): the e2e step's playwright owns a
// SEPARATE process group (its webServer on port 47876) it reaps ONLY from its own
// SIGTERM handler. SIGKILL-ing it (killProcessTree) skips that teardown → the webServer
// orphans, squats the port, and the next e2e fails EADDRINUSE forever (the gate wedges).
// gracefulGroupKill SIGTERMs the group first (so the runner reaps its sub-group), waits
// a grace, then escalates to SIGKILL. These prove the signal SEQUENCE (injected kill)
// and — the M1 proof — that a real two-group tree frees its port under gracefulGroupKill
// but is ORPHANED under killProcessTree (the negative control).
describe('processSubtreeGroups', () => {
  // npm(G1) → playwright(G1) → sh webServer(G2) → node server(G2): the real e2e shape.
  const TABLE = [
    { pid: 100, ppid: 1, pgid: 100 }, // npm (G1 leader)
    { pid: 150, ppid: 100, pgid: 100 }, // playwright (G1)
    { pid: 200, ppid: 150, pgid: 200 }, // sh webServer (G2 leader, re-grouped)
    { pid: 250, ppid: 200, pgid: 200 }, // node server bound to 47876 (G2)
    { pid: 900, ppid: 1, pgid: 900 }, // unrelated process — must NOT be collected
  ]

  it('discovers the root group AND a descendant that re-grouped (the webServer group)', () => {
    expect(processSubtreeGroups(100, () => TABLE)).toEqual([100, 200])
  })

  it('ignores processes outside the subtree', () => {
    // From playwright (150) down, the only groups are G1 (its own) and G2 (the webServer).
    expect(processSubtreeGroups(150, () => TABLE)).toEqual([100, 200])
    expect(processSubtreeGroups(900, () => TABLE)).toEqual([900])
  })

  it('lister throwing / empty → falls back to the root group only (never throws)', () => {
    expect(
      processSubtreeGroups(42, () => {
        throw new Error('no ps')
      }),
    ).toEqual([42])
    expect(processSubtreeGroups(42, () => [])).toEqual([42])
  })
})

describe('gracefulGroupKill', () => {
  // The real e2e subtree groups: G1 (npm/playwright) + G2 (the webServer).
  const TABLE = [
    { pid: 100, ppid: 1, pgid: 100 },
    { pid: 150, ppid: 100, pgid: 100 },
    { pid: 200, ppid: 150, pgid: 200 },
    { pid: 250, ppid: 200, pgid: 200 },
  ]

  it('POSIX: SIGINTs EVERY subtree group first, then ESCALATES to SIGKILL of each after grace', async () => {
    const signals: Array<[number, string]> = []
    const timers: Array<() => void> = []
    const child = { pid: 100, kill: () => {} }
    const p = gracefulGroupKill(child, {
      platform: 'linux',
      listProcs: () => TABLE,
      kill: (pid, sig) => signals.push([pid, sig]),
      graceMs: 5000,
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => {},
    })
    // SIGINT — NOT SIGTERM — to BOTH groups: it is the only signal that makes playwright
    // tear its webServer down, and a direct SIGINT to the webServer's group frees the
    // port regardless. The webServer's group (G2) is signalled DIRECTLY, never relied on
    // playwright to reap.
    expect(signals).toEqual([
      [-100, 'SIGINT'],
      [-200, 'SIGINT'],
    ])
    // Groups ignored SIGINT → grace timer fires → SIGKILL EVERY group (none orphans).
    expect(timers).toHaveLength(1)
    timers[0]()
    await p
    expect(signals).toEqual([
      [-100, 'SIGINT'],
      [-200, 'SIGINT'],
      [-100, 'SIGKILL'],
      [-200, 'SIGKILL'],
    ])
  })

  it('resolves WITHOUT escalation when the child exits within the grace', async () => {
    const signals: Array<[number, string]> = []
    let cleared = false
    let exitCb: (() => void) | null = null
    const child = {
      pid: 100,
      kill: () => {},
      once: (ev: string, cb: () => void) => {
        if (ev === 'exit') exitCb = cb
      },
    }
    const p = gracefulGroupKill(child, {
      platform: 'linux',
      listProcs: () => TABLE,
      kill: (pid, sig) => signals.push([pid, sig]),
      setTimer: () => 'TID',
      clearTimer: (id) => {
        if (id === 'TID') cleared = true
      },
    })
    expect(signals).toEqual([
      [-100, 'SIGINT'],
      [-200, 'SIGINT'],
    ])
    expect(typeof exitCb).toBe('function')
    exitCb!() // child exited within grace → grace cleared, NO SIGKILL escalation
    await p
    expect(cleared).toBe(true)
    expect(signals).toEqual([
      [-100, 'SIGINT'],
      [-200, 'SIGINT'],
    ])
  })

  it('no-ops on a null / already-exited child (never throws, resolves)', async () => {
    await expect(gracefulGroupKill(null)).resolves.toBeUndefined()
    await expect(
      gracefulGroupKill(
        { pid: 1, exitCode: 0 },
        {
          platform: 'linux',
          listProcs: () => {
            throw new Error('must not even enumerate a dead child')
          },
          kill: () => {
            throw new Error('must not signal a dead child')
          },
        },
      ),
    ).resolves.toBeUndefined()
  })

  it('Windows: no pgids → a DIRECT child SIGINT, never a negative pid', async () => {
    const groupSignals: Array<[number, string]> = []
    const childKills: string[] = []
    let exitCb: (() => void) | null = null
    const child = {
      pid: 999,
      kill: (s?: string) => childKills.push(s || ''),
      once: (ev: string, cb: () => void) => {
        if (ev === 'exit') exitCb = cb
      },
    }
    const p = gracefulGroupKill(child, {
      platform: 'win32',
      listProcs: () => TABLE,
      kill: (pid, sig) => groupSignals.push([pid, sig]),
      setTimer: () => 1,
      clearTimer: () => {},
    })
    expect(groupSignals).toEqual([]) // no negative-pid group signal on win32
    expect(childKills).toEqual(['SIGINT']) // direct child SIGINT instead
    exitCb!()
    await p
  })

  // ---- The M1 proof: a REAL two-group process tree (no mocks) ----
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  // Condition wait (see the note on the killtree helper above): `ms` is a CEILING,
  // not a fixed sleep — it returns the moment the port frees / the process dies.
  // The 15s caps absorb a loaded machine's slower REAL spawn / SIGKILL / port-release
  // without weakening the assertion (the predicate still proves the real outcome).
  const waitFor = async (pred: () => boolean | Promise<boolean>, ms: number) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      if (await pred()) return true
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25))
    }
    return !!(await pred())
  }
  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const s = createServer()
      s.once('error', reject)
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address()
        const port = addr && typeof addr === 'object' ? addr.port : 0
        s.close(() => resolve(port))
      })
    })
  // True iff `port` is currently bound (a fresh bind throws EADDRINUSE).
  const portBound = (port: number) =>
    new Promise<boolean>((resolve) => {
      const tester = createServer()
      tester.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'))
      tester.once('listening', () => tester.close(() => resolve(false)))
      tester.listen(port, '127.0.0.1')
    })
  const cleanupTree = (proc: { pid?: number | null }, childPid: number, dir: string) => {
    // `childPid > 0` guards EVERY target: a non-positive pid would make process.kill aim
    // at -1/0 — "every process I'm allowed to signal" — a catastrophic kill. The
    // retrying spawnTwoGroupTree below can hand us a failed attempt's childPid = -1, so
    // this guard is load-bearing, not theoretical.
    for (const target of [
      proc.pid ? -proc.pid : 0,
      childPid > 0 ? -childPid : 0,
      childPid > 0 ? childPid : 0,
    ]) {
      try {
        if (target) process.kill(target, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  // Spawn P (group leader G1) → C (its OWN group G2) which BINDS a fresh port —
  // playwright's two-group shape. P just holds C and idles; it does NOT reap C — the
  // whole point is that gracefulGroupKill DISCOVERS C's separate group and signals it
  // directly. When `stubborn`, BOTH P and C IGNORE SIGINT, so only the SIGKILL
  // escalation can free the port (proving the escalation reaps the webServer group too).
  //
  // The fixture is REAL OS plumbing, so under a loaded machine the SETUP itself can flake
  // for reasons unrelated to gracefulGroupKill — and a flaky setup would wrongly RED the
  // suite (and, via the integration gate, bounce a healthy branch). So setup is made
  // DETERMINISTIC: each attempt frees its OWN port and we only hand the fixture back once
  // the REAL post-conditions hold — the child is alive AND the port is actually bound to
  // a competing probe — so the test body's instantaneous portBound/isAlive checks can't
  // race a not-yet-settled OS state. A transient setup failure (the freePort→bind window
  // losing the port to another process, or EAGAIN/EMFILE under resource pressure) tears
  // the attempt down and retries with a FRESH port. The behaviour under test (the port
  // FREES / the child DIES after the kill) is untouched — only the fixture is hardened.
  const spawnTwoGroupTree = async (stubborn = false) => {
    const ignore = stubborn ? 'process.on("SIGINT",()=>{});' : ''
    const cSrc =
      'const net=require("net"),fs=require("fs");' +
      ignore +
      'const s=net.createServer(()=>{});' +
      's.listen(Number(process.env.GK_PORT),"127.0.0.1",()=>fs.writeFileSync(process.env.GK_READY,"1"));' +
      'setInterval(()=>{},1e9);'
    const pSrc =
      'const cp=require("child_process"),fs=require("fs");' +
      ignore +
      'const c=cp.spawn(process.execPath,["-e",process.env.GK_CSRC],{detached:true,stdio:"ignore",env:process.env});' +
      'fs.writeFileSync(process.env.GK_CPIDFILE,String(c.pid));' +
      'setInterval(()=>{},1e9);'
    let lastErr: unknown
    for (let attempt = 0; attempt < 6; attempt++) {
      let proc: ReturnType<typeof spawn> | undefined
      let childPid = -1
      let dir = ''
      try {
        const port = await freePort()
        dir = mkdtempSync(join(tmpdir(), 'gracekill-'))
        const cPidFile = join(dir, 'child.pid')
        const cReadyFile = join(dir, 'child.ready')
        proc = spawn(process.execPath, ['-e', pSrc], {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            GK_CSRC: cSrc,
            GK_PORT: String(port),
            GK_READY: cReadyFile,
            GK_CPIDFILE: cPidFile,
          },
        })
        const ready = await waitFor(() => existsSync(cPidFile) && existsSync(cReadyFile), 15000)
        if (ready) {
          childPid = Number(readFileSync(cPidFile, 'utf8').trim())
          // The ready FILE only proves C's listen callback fired; confirm the REAL
          // post-conditions before returning (settles at once in the normal case).
          const settled = await waitFor(
            async () => childPid > 0 && isAlive(childPid) && (await portBound(port)),
            15000,
          )
          if (settled) return { proc, childPid, dir, port }
        }
      } catch (e) {
        lastErr = e // transient (EAGAIN/EMFILE/port lost to another process) → retry fresh
      }
      // attempt didn't settle (or threw) → reap whatever started, then retry a fresh port
      cleanupTree(proc ?? {}, childPid, dir)
    }
    throw new Error(
      `two-group tree did not become ready after retries${lastErr ? `: ${String(lastErr)}` : ''}`,
    )
  }

  it.skipIf(process.platform === 'win32')(
    'graceful: discovers the SEPARATE server group and SIGINTs it → port is FREED',
    async () => {
      const { proc, childPid, dir, port } = await spawnTwoGroupTree()
      try {
        expect(await portBound(port)).toBe(true) // the "webServer" (G2) is up
        expect(isAlive(childPid)).toBe(true)

        // No mocks: gracefulGroupKill runs the REAL `ps` walk, finds C's group, SIGINTs it.
        await gracefulGroupKill(proc, { graceMs: 4000 })

        const freed = await waitFor(async () => !(await portBound(port)), 15000)
        expect(freed).toBe(true)
        expect(isAlive(childPid)).toBe(false) // the webServer (G2) really died
      } finally {
        cleanupTree(proc, childPid, dir)
      }
    },
    30000,
  )

  it.skipIf(process.platform === 'win32')(
    'stubborn: a server group that IGNORES SIGINT is still reaped by the SIGKILL escalation → port FREED',
    async () => {
      const { proc, childPid, dir, port } = await spawnTwoGroupTree(true)
      try {
        expect(await portBound(port)).toBe(true)
        expect(isAlive(childPid)).toBe(true)

        // SIGINT is ignored by both groups → only the post-grace SIGKILL frees the port.
        await gracefulGroupKill(proc, { graceMs: 1500 })

        const freed = await waitFor(async () => !(await portBound(port)), 15000)
        expect(freed).toBe(true)
        expect(isAlive(childPid)).toBe(false)
      } finally {
        cleanupTree(proc, childPid, dir)
      }
    },
    30000,
  )

  it.skipIf(process.platform === 'win32')(
    'negative control: killProcessTree (SIGKILL of G1 only) ORPHANS the server group (the M1 hazard)',
    async () => {
      const { proc, childPid, dir, port } = await spawnTwoGroupTree()
      try {
        expect(await portBound(port)).toBe(true)

        killProcessTree(proc) // SIGKILL only the child's OWN group — never discovers G2

        const pDead = await waitFor(() => !isAlive(proc.pid as number), 15000)
        expect(pDead).toBe(true)
        // G2 was never signalled → the webServer is still alive, still squatting the port.
        // This is exactly the wedge gracefulGroupKill's subtree-group discovery prevents.
        expect(isAlive(childPid)).toBe(true)
        expect(await portBound(port)).toBe(true)
      } finally {
        cleanupTree(proc, childPid, dir)
      }
    },
    30000,
  )
})
