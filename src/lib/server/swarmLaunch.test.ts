import { describe, it, expect } from 'vitest'
import {
  SWARM_LAUNCH_MODEL,
  SWARM_LAUNCH_EFFORT,
  swarmLaunchDefaults,
  resolveSwarmModelEffort,
  classifyCardWeight,
  execModeMaxWorkers,
  asExecutionMode,
} from './swarmLaunch'
import { CLAUDE_EFFORTS, DEFAULT_EXECUTION_MODE } from '../types'

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

  it('swarmLaunchDefaults(name, me) overrides model/effort (mode-resolved cheaper run)', () => {
    expect(swarmLaunchDefaults('worker', { model: 'sonnet', effort: 'low' })).toEqual({
      model: 'sonnet',
      effort: 'low',
      remoteControl: 'worker',
    })
    // effort omitted when the override has none — never effort:undefined in the spread.
    const d = swarmLaunchDefaults('worker', { model: 'sonnet' })
    expect(d.model).toBe('sonnet')
    expect('effort' in d).toBe(false)
  })
})

describe('execution mode (token budget — card 68d8e00f)', () => {
  it('asExecutionMode narrows to a real mode, else the smart default', () => {
    expect(asExecutionMode('economy')).toBe('economy')
    expect(asExecutionMode('optimize')).toBe('optimize')
    expect(asExecutionMode('max')).toBe('max')
    expect(asExecutionMode('nonsense')).toBe(DEFAULT_EXECUTION_MODE)
    expect(asExecutionMode(undefined)).toBe(DEFAULT_EXECUTION_MODE)
    expect(asExecutionMode(42)).toBe(DEFAULT_EXECUTION_MODE)
    expect(DEFAULT_EXECUTION_MODE).toBe('optimize') // the shipped default
  })

  it('max mode = the historical opus/max for every role (NO regression)', () => {
    for (const role of ['worker', 'supply', 'manager'] as const) {
      expect(resolveSwarmModelEffort('max', role)).toEqual({ model: 'opus', effort: 'max' })
    }
  })

  it('economy mode = sonnet everywhere (workers low effort, roles medium)', () => {
    expect(resolveSwarmModelEffort('economy', 'worker')).toEqual({ model: 'sonnet', effort: 'low' })
    expect(resolveSwarmModelEffort('economy', 'supply')).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(resolveSwarmModelEffort('economy', 'manager')).toEqual({ model: 'sonnet', effort: 'medium' })
  })

  it('optimize keeps CAPABILITY for the commander (quality-critical), sonnet for supply', () => {
    // The manager's integration/safety-review DECISION stays opus even in optimize —
    // savings there come from fewer review bodies, not a weaker model.
    expect(resolveSwarmModelEffort('optimize', 'manager').model).toBe('opus')
    expect(resolveSwarmModelEffort('optimize', 'supply').model).toBe('sonnet')
  })

  it('optimize routes WORKERS by card weight — heavy stays opus, chores drop to sonnet', () => {
    const heavy = { title: 'sandbox guard for auth token deletion', notes: 'security-critical' }
    const light = { title: '[follow-up] fix a typo in a comment', notes: 'nit' }
    expect(resolveSwarmModelEffort('optimize', 'worker', heavy)).toEqual({ model: 'opus', effort: 'max' })
    expect(resolveSwarmModelEffort('optimize', 'worker', light)).toEqual({ model: 'sonnet', effort: 'low' })
    // Unknown / no card ⇒ the SAFE middle (sonnet/medium), never a silent under-power.
    expect(resolveSwarmModelEffort('optimize', 'worker')).toEqual({ model: 'sonnet', effort: 'medium' })
  })

  it('classifyCardWeight reads static signals (EN + JA), safe-middle by default', () => {
    expect(classifyCardWeight({ title: 'add sandbox guard' })).toBe('heavy')
    expect(classifyCardWeight({ title: '課金まわりの認証' })).toBe('heavy') // JA safety keywords
    expect(classifyCardWeight({ title: '[MAJOR] release blocker' })).toBe('heavy')
    expect(classifyCardWeight({ title: '[minor] rename a var' })).toBe('light')
    expect(classifyCardWeight({ title: 'add a feature', notes: 'medium sized work' })).toBe('medium')
    // A big brief ⇒ heavy even without a keyword (substantial work).
    expect(classifyCardWeight({ title: 'x', notes: 'y'.repeat(1300) })).toBe('heavy')
    // A heavy signal beats a light one.
    expect(classifyCardWeight({ title: '[minor] but touches auth' })).toBe('heavy')
  })

  it('execModeMaxWorkers caps parallelism by mode, clamped to [1, hardMax]', () => {
    expect(execModeMaxWorkers('max', 6)).toBe(6) // historical band
    expect(execModeMaxWorkers('economy', 6)).toBe(2) // fewer parallel claudes
    expect(execModeMaxWorkers('optimize', 6)).toBe(4) // middling
    expect(execModeMaxWorkers('economy', 1)).toBe(1) // never below 1
    expect(execModeMaxWorkers('optimize', 3)).toBe(3) // clamped to a small hardMax
  })
})
