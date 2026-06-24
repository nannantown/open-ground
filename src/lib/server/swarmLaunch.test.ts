import { describe, it, expect } from 'vitest'
import {
  SWARM_LAUNCH_MODEL,
  SWARM_LAUNCH_EFFORT,
  swarmLaunchDefaults,
} from './swarmLaunch'
import { CLAUDE_EFFORTS } from '../types'

// The ONE place supply / worker / (future) commander source their model+effort,
// so all three stay in lockstep at opus/max. The CLAUDE_EFFORTS guard is the
// load-bearing bit: a rename that the CLI no longer accepts must degrade to "CLI
// default", never emit a broken `--effort` argv.

describe('swarmLaunch (shared swarm launch defaults)', () => {
  it('launches at opus / max', () => {
    expect(SWARM_LAUNCH_MODEL).toBe('opus')
    expect(SWARM_LAUNCH_EFFORT).toBe('max')
  })

  it("'max' is a real CLAUDE_EFFORTS member (the guard would otherwise drop it)", () => {
    expect(CLAUDE_EFFORTS).toContain('max')
  })

  it('swarmLaunchDefaults(name) spreads model + effort + the Remote Control name', () => {
    expect(swarmLaunchDefaults('worker')).toEqual({
      model: 'opus',
      effort: 'max',
      remoteControl: 'worker',
    })
  })

  it('carries the role through as the Remote Control session name', () => {
    expect(swarmLaunchDefaults('supply').remoteControl).toBe('supply')
    expect(swarmLaunchDefaults('worker').remoteControl).toBe('worker')
  })

  it('omits effort entirely (never effort:undefined) when the guard rejects it', () => {
    // SWARM_LAUNCH_EFFORT is guarded against CLAUDE_EFFORTS; whenever it survives
    // as a value the default carries it, and the key is present-or-absent — never
    // an explicit undefined that would clutter the spread.
    const d = swarmLaunchDefaults('worker')
    if (SWARM_LAUNCH_EFFORT === undefined) {
      expect('effort' in d).toBe(false)
    } else {
      expect(d.effort).toBe(SWARM_LAUNCH_EFFORT)
    }
  })
})
