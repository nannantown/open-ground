import { describe, it, expect, beforeEach } from 'vitest'
import {
  SWARM_LAUNCH_MODEL,
  SWARM_LAUNCH_EFFORT,
  swarmLaunchDefaults,
  resolveSwarmModelEffort,
  resolveAvailableTier,
  isTopTierExhaustedByUsage,
  classifyCardWeight,
  execModeMaxWorkers,
  asExecutionMode,
} from './swarmLaunch'
import type { CliUsage } from './claudeUsageCli'
import {
  CLAUDE_EFFORTS,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_SWARM_ALLOWED_MODELS,
  EXECUTION_MODES,
  type SwarmAllowedModels,
  type SwarmModelTier,
} from '../types'
import { MODEL_TIER_LADDER, markCoolingUntil, __resetQuotaForTest } from './swarmQuota'
import { __resetAllowedModelsForTest } from './swarmAllowedModels'

// The quota cooling table and the allowed-models mirror are process-wide
// globalThis singletons; reset BOTH before EVERY test so the existing (pre-quota)
// assertions see an empty table + an all-usable mask — nothing cooling and nothing
// disabled ⇒ resolveAvailableTier is the identity, so today's model/effort matrix
// is unchanged — and the fallback cases below stay order-independent.
beforeEach(() => {
  __resetQuotaForTest()
  __resetAllowedModelsForTest()
})

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
    expect(resolveSwarmModelEffort('optimize', 'manager')!.model).toBe('fable')
    expect(resolveSwarmModelEffort('optimize', 'supply')!.model).toBe('sonnet')
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
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW)!.model).toBe('fable')
  })

  it('fable cooling ⇒ worker launches opus, effort untouched (Done ①)', () => {
    cool('fable')
    const me = resolveSwarmModelEffort('max', 'worker', undefined, NOW)!
    expect(me.model).toBe('opus')
    expect(me.effort).toBe('max') // the fallback moves the tier, never the effort
  })

  it('fable+opus cooling ⇒ worker launches sonnet (Done ②)', () => {
    cool('fable')
    cool('opus')
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW)!.model).toBe('sonnet')
  })

  it('fable+opus+sonnet cooling ⇒ worker launches haiku (bottom of the ladder)', () => {
    cool('fable')
    cool('opus')
    cool('sonnet')
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW)!.model).toBe('haiku')
  })

  it('every tier cooling ⇒ desired tier unchanged (the engine owns the wait, not the resolver)', () => {
    for (const t of MODEL_TIER_LADDER) cool(t)
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW)!.model).toBe('fable')
  })

  it('cooling is time-boxed: past the reset the top tier is available again (Done ② recovery)', () => {
    cool('fable')
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW)!.model).toBe('opus')
    expect(resolveSwarmModelEffort('max', 'worker', undefined, NOW + HOUR + 1)!.model).toBe('fable')
  })

  it('optimize heavy card also desires the top tier ⇒ drops to opus when fable cooling', () => {
    cool('fable')
    const heavy = { title: 'sandbox guard for auth', notes: 'security-critical' }
    expect(resolveSwarmModelEffort('optimize', 'worker', heavy, NOW)!.model).toBe('opus')
  })

  it('the manager (top-tier judgment席) follows the fallback too', () => {
    cool('fable')
    expect(resolveSwarmModelEffort('optimize', 'manager', undefined, NOW)!.model).toBe('opus')
    expect(resolveSwarmModelEffort('optimize', 'manager', undefined, NOW)!.effort).toBe('high')
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
    const me = resolveSwarmModelEffort('economy', 'worker', undefined, NOW)!
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

// ─── Usage-cache pre-launch veto (claudeUsageCli, fail-open) ─────────────────
// Top-tier exhaustion is knowable BEFORE a launch fails via the cached `/usage`
// scrape: the account-wide session/weekAll slots, or — the only reading that
// catches the flagship running dry ALONE — its own `Current week (<Model> only)`
// row. `usage` is injected directly (the 6th param) so these stay deterministic
// — no globalThis cache, no node-pty spawn.
describe('isTopTierExhaustedByUsage (fail-open pure predicate)', () => {
  const slot = (pct: number): CliUsage => ({
    session: { pct, resetsAt: 'in 40 minutes' },
    weekAll: null,
    capturedAt: '2026-07-12T00:00:00.000Z',
    status: 'ok',
  })

  it('no cache at all ⇒ not exhausted (fail-open — never scraped / expired)', () => {
    expect(isTopTierExhaustedByUsage(null)).toBe(false)
  })

  it('gray zone (95%, even 99%) ⇒ not exhausted — only a CONFIRMED 100% counts', () => {
    expect(isTopTierExhaustedByUsage(slot(95))).toBe(false)
    expect(isTopTierExhaustedByUsage(slot(99))).toBe(false)
  })

  it('session at 100% ⇒ exhausted', () => {
    expect(isTopTierExhaustedByUsage(slot(100))).toBe(true)
  })

  it('weekAll at 100% (session unknown) ⇒ exhausted', () => {
    const usage: CliUsage = {
      session: null,
      weekAll: { pct: 100, resetsAt: 'in 6 days' },
      capturedAt: '2026-07-12T00:00:00.000Z',
      status: 'ok',
    }
    expect(isTopTierExhaustedByUsage(usage)).toBe(true)
  })

  it('both null slots (e.g. scrape-failed) ⇒ not exhausted', () => {
    const usage: CliUsage = {
      session: null,
      weekAll: null,
      capturedAt: '2026-07-12T00:00:00.000Z',
      status: 'scrape-failed',
    }
    expect(isTopTierExhaustedByUsage(usage)).toBe(false)
  })
})

// ─── The per-model weekly row — a DORMANT reading ────────────────────────────
// The account-wide slots CANNOT express "only the flagship is dry". Measured
// 2026-07-13 03:04Z: `claude` refused every launch with "You've reached your
// Fable 5 limit" while /usage read session 3% / weekAll 63%, so the swarm
// relaunched into the limit screen at every restart. A per-model row WOULD make
// that visible — but the CLI shipping today (2.1.207) prints none (it shows a
// "Per-model breakdown unavailable" placeholder instead), so `weekModels` is
// always empty in practice and NONE of these cases occur in the wild yet. They
// pin the contract for the day the row returns; the wall itself is only
// observable via a `claude --model <tier> -p` refusal probe (separate card).
//
// Every `usage` below is injected by hand — no globalThis cache, no pty spawn.
describe('isTopTierExhaustedByUsage — per-model weekly rows (dormant contract)', () => {
  // The 03:04Z account-wide numbers, plus the row the CLI did NOT print.
  const withModelRow = (model: string, pct: number): CliUsage => ({
    session: { pct: 3, resetsAt: '12:30 pm (Asia/Tokyo)' },
    weekAll: { pct: 63, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
    weekModels: [{ model, pct, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' }],
    capturedAt: '2026-07-13T03:04:00.000Z',
    status: 'ok',
  })

  it('the top tier spent at 100% ⇒ exhausted, even though session (3%) and weekAll (63%) look healthy', () => {
    expect(isTopTierExhaustedByUsage(withModelRow(SWARM_LAUNCH_MODEL, 100))).toBe(true)
  })

  it('matches the label however the TUI spells it — "Fable 5" / "Fable" / lowercase / space-lost "Fable5"', () => {
    // The row label is whatever /usage printed; the swarm must not depend on a
    // fixed spelling (the flagship name and its version suffix both move).
    for (const label of ['Fable 5', 'Fable', 'fable', 'FABLE', 'Fable5']) {
      expect(isTopTierExhaustedByUsage(withModelRow(label, 100))).toBe(true)
    }
  })

  it('a DIFFERENT tier at 100% is NOT a top-tier veto (a dry Sonnet row leaves fable launchable)', () => {
    // Layer A (cooling) covers the lower rungs reactively; this predicate answers
    // one question only — is the LADDER HEAD dry?
    for (const label of ['Sonnet', 'Sonnet 4.5', 'Opus', 'Haiku']) {
      expect(isTopTierExhaustedByUsage(withModelRow(label, 100))).toBe(false)
    }
  })

  it('the top tier in the gray zone (95%) ⇒ not exhausted (same threshold as the account-wide slots)', () => {
    expect(isTopTierExhaustedByUsage(withModelRow(SWARM_LAUNCH_MODEL, 95))).toBe(false)
    expect(isTopTierExhaustedByUsage(withModelRow(SWARM_LAUNCH_MODEL, 99))).toBe(false)
  })

  it('finds the dry top-tier row even when a healthy row is listed first', () => {
    // A first-match-wins reading would have latched onto Opus and missed it.
    const usage: CliUsage = {
      session: { pct: 3, resetsAt: '12:30 pm (Asia/Tokyo)' },
      weekAll: { pct: 63, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
      weekModels: [
        { model: 'Opus', pct: 30, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
        { model: 'Fable 5', pct: 100, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
      ],
      capturedAt: '2026-07-13T03:04:00.000Z',
      status: 'ok',
    }
    expect(isTopTierExhaustedByUsage(usage)).toBe(true)
  })

  it('BACK-COMPAT: no per-model rows at all (absent or empty) ⇒ unchanged fail-open false', () => {
    const noRows: CliUsage = {
      session: { pct: 3, resetsAt: '12:30 pm (Asia/Tokyo)' },
      weekAll: { pct: 63, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
      capturedAt: '2026-07-13T03:04:00.000Z',
      status: 'ok',
    }
    expect(isTopTierExhaustedByUsage(noRows)).toBe(false)
    expect(isTopTierExhaustedByUsage({ ...noRows, weekModels: [] })).toBe(false)
  })
})

describe('resolveAvailableTier / resolveSwarmModelEffort — usage-cache veto (this card)', () => {
  const NOW = 1_700_000_000_000
  const exhausted: CliUsage = {
    session: { pct: 100, resetsAt: 'in 40 minutes' },
    weekAll: null,
    capturedAt: '2026-07-12T00:00:00.000Z',
    status: 'ok',
  }
  const grayZone: CliUsage = {
    session: { pct: 95, resetsAt: 'in 40 minutes' },
    weekAll: null,
    capturedAt: '2026-07-12T00:00:00.000Z',
    status: 'ok',
  }

  it('fable confirmed exhausted (100%) ⇒ resolveAvailableTier drops to opus, exactly like cooling', () => {
    expect(resolveAvailableTier('fable', NOW, undefined, exhausted)).toBe('opus')
  })

  it('gray zone (95%) ⇒ no effect — fable is still returned (no over-hunting)', () => {
    expect(resolveAvailableTier('fable', NOW, undefined, grayZone)).toBe('fable')
  })

  it('null usage (no cache) ⇒ no effect — fail-open, fable still returned', () => {
    expect(resolveAvailableTier('fable', NOW, undefined, null)).toBe('fable')
  })

  it('the veto never touches a non-top tier: sonnet stays sonnet even when fable is exhausted', () => {
    expect(resolveAvailableTier('sonnet', NOW, undefined, exhausted)).toBe('sonnet')
  })

  it('max mode worker launch drops fable→opus under a confirmed-exhausted usage cache', () => {
    const me = resolveSwarmModelEffort('max', 'worker', undefined, NOW, undefined, exhausted)!
    expect(me.model).toBe('opus')
    expect(me.effort).toBe('max') // usage veto moves the tier only, same as cooling
  })

  it('composes with cooling: fable exhausted by usage AND opus cooling ⇒ drops to sonnet', () => {
    markCoolingUntil('opus', NOW + 3_600_000)
    expect(resolveAvailableTier('fable', NOW, undefined, exhausted)).toBe('sonnet')
  })

  it('a switched-OFF fable is still skipped even when usage says it is fine (mask independent of usage)', () => {
    const off = { fable: false, opus: true, sonnet: true, haiku: true } as SwarmAllowedModels
    expect(resolveAvailableTier('fable', NOW, off, null)).toBe('opus')
  })

  // End-to-end, for the day the row returns: a fable-only weekly row must move
  // the launch tier exactly like a 100% session would. It does NOT run today —
  // the CLI prints no such row (see the dormant-contract note above), so the
  // 2026-07-13 wall is still walked into. That is the probe card's job, not this
  // one's.
  const fableWeekDry: CliUsage = {
    session: { pct: 3, resetsAt: '12:30 pm (Asia/Tokyo)' },
    weekAll: { pct: 63, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
    weekModels: [{ model: 'Fable 5', pct: 100, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' }],
    capturedAt: '2026-07-13T03:04:00.000Z',
    status: 'ok',
  }

  it('DORMANT: a dry FABLE-only week WOULD drop the ladder head to opus, though session/weekAll read 3%/63%', () => {
    expect(resolveAvailableTier('fable', NOW, undefined, fableWeekDry)).toBe('opus')
  })

  it('DORMANT: …and a max-mode worker would then launch on opus/max instead of the limit screen', () => {
    const me = resolveSwarmModelEffort('max', 'worker', undefined, NOW, undefined, fableWeekDry)!
    expect(me.model).toBe('opus')
    expect(me.effort).toBe('max') // the veto moves the tier only — never the effort
  })

  it('DORMANT: a dry SONNET-only week changes nothing — fable still launches (the veto is head-only)', () => {
    const sonnetWeekDry: CliUsage = {
      ...fableWeekDry,
      weekModels: [{ model: 'Sonnet', pct: 100, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' }],
    }
    expect(resolveAvailableTier('fable', NOW, undefined, sonnetWeekDry)).toBe('fable')
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

// ─── The owner's HARD MASK (Settings.swarmAllowedModels) ─────────────────────
// A switched-OFF tier must be unreachable from EVERY launch path, in every mode,
// cooling or not — and unlike a cool it never expires. The incident: the old
// `?? desired` fallback handed the caller back the very tier the owner had
// disabled once everything else was dry.

describe('hard mask — a switched-OFF tier is never launched on', () => {
  const NOW = 1_700_000_000_000
  const HOUR = 3_600_000
  const off = (...tiers: readonly SwarmModelTier[]): SwarmAllowedModels => {
    const m = { ...DEFAULT_SWARM_ALLOWED_MODELS }
    for (const t of tiers) m[t] = false
    return m
  }
  const ALL_OFF = off('fable', 'opus', 'sonnet', 'haiku')

  it('the ladder walk SKIPS a disabled tier exactly like a cooling one', () => {
    expect(resolveAvailableTier('fable', NOW, off('fable'))).toBe('opus')
    expect(resolveAvailableTier('fable', NOW, off('fable', 'opus'))).toBe('sonnet')
  })

  it('the two vetoes compose: fable OFF + opus cooling ⇒ sonnet', () => {
    markCoolingUntil('opus', NOW + HOUR)
    expect(resolveAvailableTier('fable', NOW, off('fable'))).toBe('sonnet')
  })

  it('a disabled tier is never the last-resort "look UP" answer', () => {
    markCoolingUntil('sonnet', NOW + HOUR)
    markCoolingUntil('haiku', NOW + HOUR)
    // Everything at-or-below sonnet is dry; fable is disabled ⇒ opus, not fable.
    expect(resolveAvailableTier('sonnet', NOW, off('fable'))).toBe('opus')
  })

  it('FAIL-CLOSED: with every tier cooling, a DISABLED desired tier is not returned', () => {
    for (const t of MODEL_TIER_LADDER) markCoolingUntil(t, NOW + HOUR)
    // The old code returned `desired` here — the exact bug (a disabled fable).
    expect(resolveAvailableTier('fable', NOW, off('fable'))).toBe('opus')
    // …while an ENABLED desired tier still comes back unchanged (the engine parks).
    expect(resolveAvailableTier('sonnet', NOW, off('fable'))).toBe('sonnet')
  })

  it('every tier OFF ⇒ null: there is no model to launch on', () => {
    expect(resolveAvailableTier('fable', NOW, ALL_OFF)).toBeNull()
    expect(resolveAvailableTier('gpt-nonsense', NOW, ALL_OFF)).toBeNull()
    for (const role of ['worker', 'supply', 'manager', 'overseer'] as const) {
      for (const mode of EXECUTION_MODES) {
        expect(resolveSwarmModelEffort(mode, role, undefined, NOW, ALL_OFF)).toBeNull()
      }
    }
  })

  it('does NOT expire: a year later a disabled tier is still disabled', () => {
    expect(resolveAvailableTier('fable', NOW + 365 * 24 * HOUR, off('fable'))).toBe('opus')
  })

  it('max mode with fable OFF launches every role on opus, effort untouched', () => {
    for (const role of ['worker', 'supply', 'manager', 'overseer'] as const) {
      expect(resolveSwarmModelEffort('max', role, undefined, NOW, off('fable'))).toEqual({
        model: 'opus',
        effort: 'max',
      })
    }
  })

  it('optimize: a heavy card cannot reach a disabled top tier; chores skip a disabled sonnet', () => {
    const heavy = { title: 'sandbox guard for auth', notes: 'security-critical' }
    expect(resolveSwarmModelEffort('optimize', 'worker', heavy, NOW, off('fable'))!.model).toBe('opus')
    // sonnet OFF ⇒ the chore steps DOWN to haiku (never up onto the top tier by accident).
    expect(resolveSwarmModelEffort('optimize', 'worker', undefined, NOW, off('sonnet'))!.model).toBe(
      'haiku',
    )
  })

  it('economy with sonnet+haiku OFF climbs to the best ENABLED tier, effort still low', () => {
    expect(resolveSwarmModelEffort('economy', 'worker', undefined, NOW, off('sonnet', 'haiku'))).toEqual(
      { model: 'fable', effort: 'low' },
    )
  })

  it('the mask alone never re-enables a cooling tier (both vetoes stay independent)', () => {
    markCoolingUntil('opus', NOW + HOUR)
    // fable OFF, opus cooling ⇒ sonnet. Turning fable back ON returns fable.
    expect(resolveAvailableTier('fable', NOW, off('fable'))).toBe('sonnet')
    expect(resolveAvailableTier('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS)).toBe('fable')
  })
})
