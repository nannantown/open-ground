import { describe, it, expect } from 'vitest'
import {
  chooseWorkerRuntime,
  countSdkWorkers,
  sdkSlotLimit,
  DEFAULT_SDK_MAX_WORKERS,
} from './swarmWorkerRuntimeDial'
import type { SdkPreflightResult } from './swarmWorkerSdk'

const WT = '/Users/tester/.openground/projects/u1/worktrees/wt1'
const passing: SdkPreflightResult = { ok: true, problems: [], claudeBin: '/bin/claude', cliVersion: '2.1.220' }
const failing: SdkPreflightResult = {
  ok: false,
  problems: ['guard did not deny `git push` for a worker session'],
  claudeBin: '/bin/claude',
  cliVersion: '2.1.220',
}

const choose = (
  settings: Parameters<typeof chooseWorkerRuntime>[0]['settings'],
  workers: { runtime?: 'pty' | 'sdk' }[] = [],
  preflight = () => passing,
) => chooseWorkerRuntime({ settings, workers, worktree: WT, home: '/Users/tester', preflight })

describe('the dial default — the shipped state', () => {
  it('is SDK when the setting is absent entirely (flipped 2026-08-01)', () => {
    // ⚠ THE ABSENT CASE MOVED, AND ONLY THE ABSENT CASE. What earned it was not
    // another review round — it was an acceptance pass against a real `claude`
    // through the packaged bundle: a worker spawns/works/commits, its worktree
    // comes down only after the desk has really gone, the deny veto FIRES in a
    // live session, the owner's inbox answer arrives, and three at once keep
    // three identities while the fourth degrades with its reason shown.
    //
    // This test is the one that has to be edited to change the shipped default,
    // which is the point of it existing: the default cannot drift silently.
    const c = choose({})
    expect(c.runtime).toBe('sdk')
    // …and it got there through the real decision, not by skipping it: the SDK
    // arm runs the preflight, the PTY arm never does.
    expect(c.preflight).toBeDefined()
    expect(c.fellBackBecause).toBeUndefined()
  })

  it('an absent dial still DEGRADES when the preflight refuses — the default is not a bypass', () => {
    // Flipping a default must not also flip who is allowed to say no. An absent
    // dial takes exactly the same road as an explicit 'sdk', including the exit.
    const c = choose({}, [], () => ({ ok: false, problems: ['no claude'] }) as never)
    expect(c.runtime).toBe('pty')
    expect(c.fellBackBecause).toContain('preflight')
  })

  it('is PTY when the mode says pty — the kill switch still wins', () => {
    // The switch is the whole safety story of the flip: whatever goes wrong with
    // the SDK runtime, writing 'pty' puts every worker back on the proven path
    // WITHOUT a release. It must keep working exactly as before.
    expect(choose({ swarmWorkerRuntime: { mode: 'pty' } })).toEqual({ runtime: 'pty' })
  })

  it('does not even run the preflight when the dial is off', () => {
    let ran = false
    choose({ swarmWorkerRuntime: { mode: 'pty' } }, [], () => {
      ran = true
      return passing
    })
    expect(ran).toBe(false)
  })
})

describe('choosing SDK', () => {
  it('picks SDK when the dial is on, a slot is free and the preflight passes', () => {
    const c = choose({ swarmWorkerRuntime: { mode: 'sdk' } })
    expect(c.runtime).toBe('sdk')
    expect(c.fellBackBecause).toBeUndefined()
  })

  it('defaults the slot budget to ONE — the first stage runs one SDK worker beside PTY ones', () => {
    expect(sdkSlotLimit({})).toBe(DEFAULT_SDK_MAX_WORKERS)
    expect(DEFAULT_SDK_MAX_WORKERS).toBe(1)
    const c = choose({ swarmWorkerRuntime: { mode: 'sdk' } }, [{ runtime: 'sdk' }])
    expect(c.runtime).toBe('pty')
    expect(c.fellBackBecause).toMatch(/slots are full \(1\/1\)/)
  })

  it('honours a larger budget', () => {
    const s = { swarmWorkerRuntime: { mode: 'sdk' as const, sdkMaxWorkers: 3 } }
    expect(choose(s, [{ runtime: 'sdk' }, { runtime: 'sdk' }]).runtime).toBe('sdk')
    expect(choose(s, [{ runtime: 'sdk' }, { runtime: 'sdk' }, { runtime: 'sdk' }]).runtime).toBe('pty')
  })

  it('a budget of 0 means "never" without having to flip the mode back', () => {
    expect(choose({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 0 } }).runtime).toBe('pty')
  })

  it('ignores nonsense budgets rather than disabling the dial by accident', () => {
    expect(sdkSlotLimit({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: -2 } })).toBe(DEFAULT_SDK_MAX_WORKERS)
    expect(sdkSlotLimit({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: NaN } })).toBe(DEFAULT_SDK_MAX_WORKERS)
  })
})

describe('every failure DEGRADES to PTY — never blocks the dispatch', () => {
  it('falls back with a reason when the preflight fails', () => {
    const c = choose({ swarmWorkerRuntime: { mode: 'sdk' } }, [], () => failing)
    expect(c.runtime).toBe('pty')
    // The reason has to be legible: an unexplained silent fallback is how a
    // migration ends up "not working" with nobody able to say why.
    expect(c.fellBackBecause).toContain('guard did not deny')
    expect(c.preflight).toBe(failing)
  })

  it('never returns anything but a runtime — a worker is always dispatchable', () => {
    for (const p of [passing, failing]) {
      for (const workers of [[], [{ runtime: 'sdk' as const }]]) {
        const c = choose({ swarmWorkerRuntime: { mode: 'sdk' } }, workers, () => p)
        expect(['pty', 'sdk']).toContain(c.runtime)
      }
    }
  })
})

describe('countSdkWorkers', () => {
  it('counts only sdk workers, treating an ABSENT runtime as pty', () => {
    expect(
      countSdkWorkers([
        { terminalId: 't1' }, // legacy roster entry
        { runtime: 'pty', terminalId: 't2' },
        { runtime: 'sdk', sdkSessionId: 's1' },
        { runtime: 'sdk', sdkSessionId: 's2' },
      ]),
    ).toBe(2)
  })

  it('is 0 for an empty roster', () => {
    expect(countSdkWorkers([])).toBe(0)
  })
})
