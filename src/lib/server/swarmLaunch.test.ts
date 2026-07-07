import { describe, it, expect, beforeEach } from 'vitest'
import {
  SWARM_LAUNCH_MODEL,
  SWARM_LAUNCH_EFFORT,
  swarmLaunchDefaults,
  resolveSwarmModelEffort,
  resolveAvailableTier,
  classifyCardWeight,
  execModeMaxWorkers,
  asExecutionMode,
} from './swarmLaunch'
import { CLAUDE_EFFORTS, DEFAULT_EXECUTION_MODE } from '../types'
import { MODEL_TIER_LADDER, markCoolingUntil, __resetQuotaForTest } from './swarmQuota'

// The quota cooling table is a process-wide globalThis singleton; reset it before
// EVERY test so the existing (pre-quota) assertions see an empty table — nothing
// cooling ⇒ resolveAvailableTier is the identity, so today's model/effort matrix is
// unchanged — and the fallback cases below stay order-independent.
beforeEach(() => __resetQuotaForTest())

// The ONE place supply / worker / (future) commander source their model+effort,
// so all three stay in lockstep at opus/max. The CLAUDE_EFFORTS guard is the
// load-bearing bit: a rename that the CLI no longer accepts must degrade to "CLI
// default", never emit a broken `--effort` argv.

describe('swarmLaunch (shared swarm launch defaults)', () => {
  it('launches at the top tier (fable) / max', () => {
    expect(SWARM_LAUNCH_MODEL).toBe('fable')
    expect(SWARM_LAUNCH_EFFORT).toBe('max')
  })

  it("'max' is a real CLAUDE_EFFORTS member (the guard would otherwise drop it)", () => {
    expect(CLAUDE_EFFORTS).toContain('max')
  })

  it('swarmLaunchDefaults(name) spreads model + effort + the Remote Control name', () => {
    expect(swarmLaunchDefaults('worker')).toEqual({
      model: 'fable',
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

  it('max mode = the top tier (fable)/max for every role', () => {
    for (const role of ['worker', 'supply', 'manager', 'overseer'] as const) {
      expect(resolveSwarmModelEffort('max', role)).toEqual({ model: 'fable', effort: 'max' })
    }
  })

  it('economy mode = sonnet everywhere (workers low effort, roles medium)', () => {
    expect(resolveSwarmModelEffort('economy', 'worker')).toEqual({ model: 'sonnet', effort: 'low' })
    expect(resolveSwarmModelEffort('economy', 'supply')).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(resolveSwarmModelEffort('economy', 'manager')).toEqual({ model: 'sonnet', effort: 'medium' })
    // The proxy-you overseer is an engine role — sonnet/medium, not a worker's low.
    expect(resolveSwarmModelEffort('economy', 'overseer')).toEqual({ model: 'sonnet', effort: 'medium' })
  })

  it('optimize keeps top-tier CAPABILITY for the commander (quality-critical), sonnet for supply', () => {
    // The manager's integration/safety-review DECISION stays opus even in optimize —
    // savings there come from fewer review bodies, not a weaker model.
    expect(resolveSwarmModelEffort('optimize', 'manager').model).toBe('fable')
    expect(resolveSwarmModelEffort('optimize', 'supply').model).toBe('sonnet')
    // The overseer's answer-as-owner is a judgment席 on par with the manager (D4).
    expect(resolveSwarmModelEffort('optimize', 'overseer')).toEqual({ model: 'fable', effort: 'high' })
  })

  it('optimize routes WORKERS by card weight — heavy gets the top tier, chores drop to sonnet', () => {
    const heavy = { title: 'sandbox guard for auth token deletion', notes: 'security-critical' }
    const light = { title: '[follow-up] fix a typo in a comment', notes: 'nit' }
    expect(resolveSwarmModelEffort('optimize', 'worker', heavy)).toEqual({ model: 'fable', effort: 'max' })
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

// ─── Quota fallback (this card) — launch tier auto-follows the [Quota] foundation ─
// Cooling states are injected via swarmQuota.markCoolingUntil + a fixed `now`, so
// these are deterministic (no wall clock). The top-level beforeEach clears the
// table between cases. Done ①②③ map to the max-mode drops fable→opus→sonnet→haiku.

describe('quota fallback — launch tier follows the foundation (Done ①②③)', () => {
  const NOW = 1_700_000_000_000
  const HOUR = 3_600_000
  const cool = (tier: (typeof MODEL_TIER_LADDER)[number]) => markCoolingUntil(tier, NOW + HOUR)

  it('SWARM_LAUNCH_MODEL is the head of the ladder (one top-tier definition)', () => {
    expect(SWARM_LAUNCH_MODEL).toBe(MODEL_TIER_LADDER[0])
    expect(MODEL_TIER_LADDER[0]).toBe('fable')
  })

  it('all tiers available ⇒ max launches fable, as before (Done ③)', () => {
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW).model).toBe('fable')
  })

  it('fable cooling ⇒ worker launches opus, effort untouched (Done ①)', () => {
    cool('fable')
    const me = resolveSwarmModelEffort('max', 'worker', undefined, NOW)
    expect(me.model).toBe('opus')
    expect(me.effort).toBe('max') // the fallback moves the tier, never the effort
  })

  it('fable+opus cooling ⇒ worker launches sonnet (Done ②)', () => {
    cool('fable')
    cool('opus')
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW).model).toBe('sonnet')
  })

  it('fable+opus+sonnet cooling ⇒ worker launches haiku (bottom of the ladder)', () => {
    cool('fable')
    cool('opus')
    cool('sonnet')
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW).model).toBe('haiku')
  })

  it('every tier cooling ⇒ desired tier unchanged (the engine owns the wait, not the resolver)', () => {
    for (const t of MODEL_TIER_LADDER) cool(t)
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW).model).toBe('fable')
  })

  it('cooling is time-boxed: past the reset the top tier is available again (Done ② recovery)', () => {
    cool('fable')
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW).model).toBe('opus')
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW + HOUR + 1).model).toBe('fable')
  })

  it('optimize heavy card also desires the top tier ⇒ drops to opus when fable cooling', () => {
    cool('fable')
    const heavy = { title: 'sandbox guard for auth', notes: 'security-critical' }
    expect(resolveSwarmModelEffort('optimize', 'worker', heavy, NOW).model).toBe('opus')
  })

  it('the manager (top-tier judgment席) follows the fallback too', () => {
    cool('fable')
    expect(resolveSwarmModelEffort('optimize', 'manager', undefined, NOW).model).toBe('opus')
    expect(resolveSwarmModelEffort('optimize', 'manager', undefined, NOW).effort).toBe('high')
  })

  it('the overseer (proxy-you judgment席, desires fable) drops to opus with effort intact', () => {
    cool('fable')
    // Both model (fable→opus, DOWN) and effort (high, unchanged) — covers the
    // non-worker fallback path + effort preservation in the down direction (⑤).
    expect(resolveSwarmModelEffort('optimize', 'overseer', undefined, NOW)).toEqual({
      model: 'opus',
      effort: 'high',
    })
  })

  it('economy keeps its chosen sonnet while sonnet has headroom (fable/opus cooling is irrelevant)', () => {
    cool('fable')
    cool('opus')
    expect(resolveSwarmModelEffort('economy', 'worker', undefined, NOW)).toEqual({
      model: 'sonnet',
      effort: 'low',
    })
  })

  it('economy sonnet cooling ⇒ steps DOWN to haiku, effort still economy-low', () => {
    cool('sonnet')
    const me = resolveSwarmModelEffort('economy', 'worker', undefined, NOW)
    expect(me.model).toBe('haiku')
    expect(me.effort).toBe('low')
  })

  it('economy sonnet+haiku cooling ⇒ last-resort UP to the best available, effort intact (keep moving)', () => {
    cool('sonnet')
    cool('haiku') // fable/opus still have headroom
    // effort stays economy-low even when the tier escalates UP — the fallback moves
    // ONLY the model (⑤). Best available above the dry sonnet/haiku is fable.
    expect(resolveSwarmModelEffort('economy', 'worker', undefined, NOW)).toEqual({
      model: 'fable',
      effort: 'low',
    })
  })
})

describe('resolveAvailableTier (the ladder walk-down primitive)', () => {
  const NOW = 1_700_000_000_000
  const HOUR = 3_600_000

  it('is the identity when nothing is cooling', () => {
    for (const t of MODEL_TIER_LADDER) expect(resolveAvailableTier(t, NOW)).toBe(t)
  })

  it('walks DOWN from the desired tier to the first with headroom', () => {
    markCoolingUntil('fable', NOW + HOUR)
    expect(resolveAvailableTier('fable', NOW)).toBe('opus')
    markCoolingUntil('opus', NOW + HOUR)
    expect(resolveAvailableTier('fable', NOW)).toBe('sonnet')
  })

  it('never steps ABOVE the desired tier while an at-or-below tier is free', () => {
    markCoolingUntil('fable', NOW + HOUR) // fable dry, but sonnet is fine
    expect(resolveAvailableTier('sonnet', NOW)).toBe('sonnet')
  })

  it('only when the desired tier AND everything below is dry does it look UP', () => {
    markCoolingUntil('sonnet', NOW + HOUR)
    markCoolingUntil('haiku', NOW + HOUR)
    expect(resolveAvailableTier('sonnet', NOW)).toBe('fable') // best available, above
  })

  it('returns the desired tier unchanged when every tier is cooling', () => {
    for (const t of MODEL_TIER_LADDER) markCoolingUntil(t, NOW + HOUR)
    expect(resolveAvailableTier('sonnet', NOW)).toBe('sonnet')
  })

  it('treats an unknown model string as the ladder head (safe best-available default)', () => {
    expect(resolveAvailableTier('gpt-nonsense', NOW)).toBe('fable')
    markCoolingUntil('fable', NOW + HOUR)
    expect(resolveAvailableTier('gpt-nonsense', NOW)).toBe('opus')
  })
})
