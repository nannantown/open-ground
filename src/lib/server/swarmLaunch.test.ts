import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SWARM_LAUNCH_MODEL,
  SWARM_DEFAULT_MODEL,
  SWARM_LAUNCH_EFFORT,
  desiredModelEffort,
  type SwarmModelRole,
  swarmLaunchDefaults,
  swarmRemoteControlName,
  resolveSwarmRemoteName,
  REMOTE_NAME_MAX,
  resolveSwarmModelEffort,
  resolveSwarmModelEffortProbed,
  resolveAvailableTier,
  resolveAvailableTierProbed,
  isTopTierExhaustedByUsage,
  resolveCardTier,
  TIER_MODEL_EFFORT,
  SAFETY_FLOOR_TIER,
  execModeMaxWorkers,
  asExecutionMode,
} from './swarmLaunch'
import {
  addProjectEntry,
  setProjectDisplayName,
  __resetMigrationCacheForTests,
} from './registry'
import * as registryModule from './registry'
import { setSettings } from './store'
import { ensureTierProbed, __resetTierProbeForTest, type TierProbeExec } from './swarmTierProbe'
import type { CliUsage } from './claudeUsageCli'
import {
  CLAUDE_EFFORTS,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_SWARM_ALLOWED_MODELS,
  EXECUTION_MODES,
  type SwarmAllowedModels,
  type SwarmModelTier,
} from '../types'
import { MODEL_TIER_LADDER, markCoolingUntil, isTierCooling, __resetQuotaForTest } from './swarmQuota'
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

  it('swarmLaunchDefaults(name, me) spreads model + effort + the Remote Control name', () => {
    // `me` is REQUIRED (2026-09-16). It used to default to the top tier, so this
    // test could call `swarmLaunchDefaults('worker')` and still read `fable` —
    // which is exactly how a caller that forgot to consult the execution mode
    // spent the scarcest quota in silence. Now the tier must be named at the
    // call, and tsc rejects the one-argument form outright.
    expect(swarmLaunchDefaults('worker', { model: 'fable', effort: 'max' })).toEqual({
      model: 'fable',
      effort: 'max',
      remoteControl: 'worker',
    })
  })

  it('carries the role through as the Remote Control session name', () => {
    expect(swarmLaunchDefaults('supply', { model: 'sonnet' }).remoteControl).toBe('supply')
    expect(swarmLaunchDefaults('worker', { model: 'opus' }).remoteControl).toBe('worker')
  })

  it('omits effort entirely (never effort:undefined) when the guard rejects it', () => {
    // SWARM_LAUNCH_EFFORT is guarded against CLAUDE_EFFORTS; whenever it survives
    // as a value the default carries it, and the key is present-or-absent — never
    // an explicit undefined that would clutter the spread.
    const d = swarmLaunchDefaults('worker', { model: 'opus', effort: SWARM_LAUNCH_EFFORT })
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

// Remote Control 名の識別化(オーナー直接フィードバック 2026-07-18): スマホ一覧に
// 「manager/worker」が同名で大量に並ぶ問題への対処。役割語はオーナー確定語彙
// (JA=マネージャー/ワーカー/タスク窓口、EN=Manager/Worker/Supply officer)、言語は
// Settings.language、プロジェクト名は registry の表示名(displayName || フォルダ名)。
// 名前制約は実測済み(CLI 2.1.214): 日本語/スペース/コロン/長名すべて受理・一覧表示。
describe('swarmRemoteControlName (識別可能なリモコン名 — pure)', () => {
  it('JA: 役割語 + プロジェクト表示名 (+ worker はカード title)', () => {
    expect(swarmRemoteControlName('manager', 'ja', 'OPEN GROUND')).toBe(
      'マネージャー OPEN GROUND',
    )
    expect(swarmRemoteControlName('supply', 'ja', 'OPEN GROUND')).toBe('タスク窓口 OPEN GROUND')
    expect(swarmRemoteControlName('worker', 'ja', 'OPEN GROUND', '検品可視化')).toBe(
      'ワーカー OPEN GROUND: 検品可視化',
    )
  })

  it('EN: Manager / Worker / Supply officer(既存 i18n EN 訳と整合)', () => {
    expect(swarmRemoteControlName('manager', 'en', 'myapp')).toBe('Manager myapp')
    expect(swarmRemoteControlName('supply', 'en', 'myapp')).toBe('Supply officer myapp')
    expect(swarmRemoteControlName('worker', 'en', 'myapp', 'Fix login bug')).toBe(
      'Worker myapp: Fix login bug',
    )
  })

  it('プロジェクト名が空でも役割語だけは残る(旧固定名より情報が減らない)', () => {
    expect(swarmRemoteControlName('worker', 'ja')).toBe('ワーカー')
    expect(swarmRemoteControlName('manager', 'en', '', '')).toBe('Manager')
    // タスクだけある(プロジェクト名なし)でも壊れない
    expect(swarmRemoteControlName('worker', 'en', undefined, 'fix')).toBe('Worker: fix')
  })

  it('title/プロジェクト名の改行・タブ・連続空白は 1 スペースに潰す(一覧を壊さない)', () => {
    expect(swarmRemoteControlName('worker', 'ja', ' p ', 'a\n b\t\tc   d')).toBe(
      'ワーカー p: a b c d',
    )
  })

  it('REMOTE_NAME_MAX 超は末尾 … に切り詰め・code point 単位でサロゲートを分断しない', () => {
    const name = swarmRemoteControlName('worker', 'ja', 'p', 'あ'.repeat(100))
    expect(Array.from(name).length).toBe(REMOTE_NAME_MAX)
    expect(name.endsWith('…')).toBe(true)
    // 絵文字(サロゲートペア)の並びを境界で切っても lone surrogate を作らない
    const n2 = swarmRemoteControlName('worker', 'en', 'p', '😀'.repeat(80))
    expect(Array.from(n2).length).toBe(REMOTE_NAME_MAX)
    expect(n2.endsWith('…')).toBe(true)
    for (const cp of Array.from(n2)) {
      const first = cp.charCodeAt(0)
      const loneSurrogate = first >= 0xd800 && first <= 0xdfff && cp.length === 1
      expect(loneSurrogate).toBe(false)
    }
  })

  it('C0/C1 制御文字(ESC 含む)は除去される — PTY 入力行を壊さないため', () => {
    // eslint-disable-next-line no-control-regex
    expect(swarmRemoteControlName('worker', 'en', 'p\x1broj', 'ta\x1bsk')).toBe(
      'Worker proj: task',
    )
    // eslint-disable-next-line no-control-regex
    expect(swarmRemoteControlName('worker', 'en', '\x00\x07proj\x7f', undefined)).toBe(
      'Worker proj',
    )
    // タブ・改行は除去でなく 1 スペースへの畳み込み(既存挙動を維持)
    expect(swarmRemoteControlName('worker', 'en', 'p\tq', 'a\nb')).toBe('Worker p q: a b')
  })

  it('ちょうど上限なら切り詰めない', () => {
    // 'Worker p: ' は 10 code point — title 50 で計 60 ちょうど。
    const title = 'x'.repeat(REMOTE_NAME_MAX - 10)
    const name = swarmRemoteControlName('worker', 'en', 'p', title)
    expect(name).toBe(`Worker p: ${title}`)
    expect(Array.from(name).length).toBe(REMOTE_NAME_MAX)
  })
})

describe('resolveSwarmRemoteName (spawn 時解決 — HOME 隔離統合)', () => {
  let home: string
  let scratch: string
  let proj: string
  let savedOgHome: string | undefined

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'og-rcname-home-')))
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-rcname-scratch-')))
    savedOgHome = process.env.OPENGROUND_HOME
    process.env.OPENGROUND_HOME = home
    __resetMigrationCacheForTests()
    proj = join(scratch, 'proj')
    await mkdir(proj, { recursive: true })
    await addProjectEntry(proj)
  })

  afterEach(async () => {
    // Restore, never delete: an unset OPENGROUND_HOME sends later resolution at the
    // REAL home dir (the 2026-07-18 data loss). See src/lib/server/testHomeGuard.ts.
    if (savedOgHome !== undefined) process.env.OPENGROUND_HOME = savedOgHome
    __resetMigrationCacheForTests()
    await rm(home, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  it('ja 設定では owner 表示名(displayName)を最優先で使う', async () => {
    await setSettings({ language: 'ja' })
    await setProjectDisplayName(proj, '受注管理')
    expect(await resolveSwarmRemoteName('manager', proj)).toBe('マネージャー 受注管理')
    expect(await resolveSwarmRemoteName('worker', proj, '検品可視化')).toBe(
      'ワーカー 受注管理: 検品可視化',
    )
  })

  it('言語未設定は English-first・displayName 無しはフォルダ名(git リポ名ではない)', async () => {
    expect(await resolveSwarmRemoteName('supply', proj)).toBe('Supply officer proj')
    expect(await resolveSwarmRemoteName('worker', proj, 'Fix bug')).toBe('Worker proj: Fix bug')
  })

  it('未登録パスでも throw せず basename で組む(名前解決は spawn を殺さない)', async () => {
    const outside = join(scratch, 'unregistered')
    await mkdir(outside, { recursive: true })
    await expect(resolveSwarmRemoteName('manager', outside)).resolves.toBe('Manager unregistered')
  })

  it('NEVER THROWS: registry 読みが throw しても catch fallback(role そのもの)へ落ちる', async () => {
    const spy = vi
      .spyOn(registryModule, 'findProjectEntryByPath')
      .mockRejectedValue(new Error('boom: simulated registry read failure'))
    try {
      await expect(resolveSwarmRemoteName('worker', proj, '検品可視化')).resolves.toBe('worker')
    } finally {
      spy.mockRestore()
    }
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
    for (const role of ['worker', 'supply', 'manager'] as const) {
      expect(resolveSwarmModelEffort('max', role)).toEqual({ model: 'fable', effort: 'max' })
    }
  })

  it('economy mode = sonnet everywhere (workers low effort, roles medium)', () => {
    expect(resolveSwarmModelEffort('economy', 'worker')).toEqual({ model: 'sonnet', effort: 'low' })
    expect(resolveSwarmModelEffort('economy', 'supply')).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(resolveSwarmModelEffort('economy', 'manager')).toEqual({ model: 'sonnet', effort: 'medium' })
  })

  it('optimize runs the always-on DESKS on opus/high — top tier is for heavy cards, not for sitting', () => {
    // ⚠ OWNER DECISION 2026-09-02. The desks are always-on: a commander re-reads
    // its context on every poke for the whole session, so on the top tier it
    // drained the weekly Fable budget with no heavy card in flight. They keep
    // HIGH effort on the middle rung; capability is preserved where it is
    // actually spent (the heavy-card worker below stays fable/max).
    expect(resolveSwarmModelEffort('optimize', 'manager')).toEqual({ model: 'opus', effort: 'high' })
    // ⚠ OWNER DECISION 2026-09-18: the supply desk is opus too (it investigates
    // and specifies cards — sonnet was under-powered), still at MEDIUM effort.
    // A mutation that drops it back to sonnet, or lifts it to fable, turns this
    // red (red measured against a temporary 'sonnet' on 2026-09-18).
    expect(resolveSwarmModelEffort('optimize', 'supply')).toEqual({ model: 'opus', effort: 'medium' })
    // …and the thing that must NOT have moved with them: an `ultra` card is still
    // top tier. A mutation that sends ultra work to opus too turns this red.
    expect(
      resolveSwarmModelEffort('optimize', 'worker', { title: 'rebuild the engine', tier: 'ultra' }),
    ).toEqual({ model: 'fable', effort: 'max' })
  })

  it('optimize routes WORKERS by DIFFICULTY TIER — the owner-approved table (2026-09-18)', () => {
    // The four rows, exactly as approved. Each is a distinct (model, effort) pair,
    // so ANY row edited to another row's value turns this red.
    const at = (tier: 'touch' | 'standard' | 'design' | 'ultra') =>
      resolveSwarmModelEffort('optimize', 'worker', { title: 'add a feature', tier })
    expect(at('touch')).toEqual({ model: 'sonnet', effort: 'low' })
    expect(at('standard')).toEqual({ model: 'opus', effort: 'medium' })
    expect(at('design')).toEqual({ model: 'opus', effort: 'high' })
    expect(at('ultra')).toEqual({ model: 'fable', effort: 'max' })
    // The exported table IS what the resolver reads (one place, no second copy).
    expect(TIER_MODEL_EFFORT).toEqual({
      touch: { model: 'sonnet', effort: 'low' },
      standard: { model: 'opus', effort: 'medium' },
      design: { model: 'opus', effort: 'high' },
      ultra: { model: 'fable', effort: 'max' },
    })
    // No tier written ⇒ the estimator: a short chore → touch row.
    const light = { title: '[follow-up] fix a typo in a comment', notes: 'nit' }
    expect(resolveSwarmModelEffort('optimize', 'worker', light)).toEqual({ model: 'sonnet', effort: 'low' })
    // ⚠ THE BASE IS OPUS (owner, 2026-08-26). This bucket is not just "a card with
    // no signal" — it is where every ordinary card lands, and it used to run on
    // sonnet, the cheapest tier the swarm has. `opus` was in the ladder but was
    // only ever reached by a cooling fable falling to it; nothing ever CHOSE it.
    expect(resolveSwarmModelEffort('optimize', 'worker', { title: 'add a feature' }))
      .toEqual({ model: 'opus', effort: 'medium' })
    // Unknown / no card ⇒ the same base, never a silent under-power.
    expect(resolveSwarmModelEffort('optimize', 'worker')).toEqual({ model: 'opus', effort: 'medium' })
  })

  it('⚠ all three tiers are actually REACHABLE by choice — opus is not a fallback-only rung', () => {
    // The guard against sliding back to a two-way pick: a mutation that sends the
    // base to sonnet (or to fable) collapses this set from three to two.
    const models = new Set(
      [
        { title: 'rebuild the engine', tier: 'ultra' as const }, // top
        { title: 'add a feature' }, // base
        { title: '[minor] typo' }, // light
      ].map((c) => resolveSwarmModelEffort('optimize', 'worker', c)!.model),
    )
    expect(Array.from(models).sort()).toEqual(['fable', 'opus', 'sonnet'])
  })

  it('resolveCardTier: no tier written ⇒ keyword estimator (EN + JA), safe middle by default', () => {
    // Safety keywords floor an unmarked card at `design` — NOT the top tier any
    // more (before 2026-09-18 they meant fable/max).
    expect(resolveCardTier({ title: 'add sandbox guard' })).toBe('design')
    expect(resolveCardTier({ title: '課金まわりの認証' })).toBe('design') // JA safety keywords
    expect(resolveCardTier({ title: '[MAJOR] release blocker' })).toBe('design')
    expect(resolveCardTier({ title: '[minor] rename a var' })).toBe('touch')
    expect(resolveCardTier({ title: 'add a feature', notes: 'medium sized work' })).toBe('standard')
    // A safety signal beats a light one.
    expect(resolveCardTier({ title: '[minor] but touches auth' })).toBe('design')
  })

  it('⚠ a LONG brief is not a hard task — the 1200-character rule is gone (2026-09-18)', () => {
    // The supply skill asks for detailed completion conditions, so a length rule
    // promoted the most carefully written cards to the most expensive tier. The
    // same card must resolve the same tier whether its brief is short or long.
    // Red measured on 2026-09-18 by temporarily restoring `|| text.length > 1200 ⇒
    // ultra` in resolveCardTier.
    const brief = 'Completion conditions: the button shows a spinner while saving. '
    const short = { title: 'add a save spinner', notes: brief }
    const long = { title: 'add a save spinner', notes: brief.repeat(40) } // ~2600 chars
    expect(long.notes.length).toBeGreaterThan(2000)
    expect(resolveCardTier(long)).toBe(resolveCardTier(short))
    expect(resolveCardTier(long)).toBe('standard')
    expect(desiredModelEffort('optimize', 'worker', long)).toEqual({ model: 'opus', effort: 'medium' })
    // …and the tier the supply officer WROTE is honoured regardless of length.
    expect(resolveCardTier({ ...long, tier: 'touch' })).toBe('touch')
  })

  it('an explicit tier wins over the estimator — in both directions', () => {
    // Up: a keyword-free card the supply officer judged hard.
    expect(resolveCardTier({ title: 'add a feature', tier: 'ultra' })).toBe('ultra')
    expect(resolveCardTier({ title: 'add a feature', tier: 'design' })).toBe('design')
    // Down: a chore-looking card the supply officer judged ordinary stays ordinary,
    // and an ordinary-looking card judged trivial runs light.
    expect(resolveCardTier({ title: '[minor] typo', tier: 'standard' })).toBe('standard')
    expect(resolveCardTier({ title: 'add a feature', tier: 'touch' })).toBe('touch')
    // Junk (a hand-edited card) is ignored like an absent tier — never a crash.
    expect(resolveCardTier({ title: 'add a feature', tier: 'opus' as never })).toBe('standard')
  })

  it('⚠ SAFETY FLOOR — a safety-keyword card never runs below design, whatever tier is written', () => {
    // The whole point: a mislabelled dangerous card must not run cheaply. Red
    // measured on 2026-09-18 by temporarily letting an explicit tier skip the floor.
    expect(SAFETY_FLOOR_TIER).toBe('design')
    for (const card of [
      { title: '認証まわりのトークン更新', tier: 'touch' as const },
      { title: 'fix login', notes: 'touches the auth middleware', tier: 'standard' as const },
      { title: 'drop old rows', notes: 'DB migration + delete', tier: 'touch' as const },
      { title: '課金ページの文言', tier: 'touch' as const },
    ]) {
      expect(resolveCardTier(card)).toBe('design')
      expect(desiredModelEffort('optimize', 'worker', card)).toEqual({ model: 'opus', effort: 'high' })
    }
    // The floor only ever RAISES: an ultra safety card stays ultra.
    expect(resolveCardTier({ title: 'auth rewrite', tier: 'ultra' })).toBe('ultra')
    // …and a card WITHOUT safety keywords is not dragged up by it.
    expect(resolveCardTier({ title: 'rename a var', tier: 'touch' })).toBe('touch')
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

  it('optimize ultra card also desires the top tier ⇒ drops to opus when fable cooling', () => {
    cool('fable')
    const top = { title: 'rebuild the engine', tier: 'ultra' as const }
    expect(resolveSwarmModelEffort('optimize', 'worker', top, NOW + HOUR + 1)!.model).toBe('fable')
    expect(resolveSwarmModelEffort('optimize', 'worker', top, NOW)!.model).toBe('opus')
  })

  it('the manager (top-tier judgment席) follows the fallback too', () => {
    cool('fable')
    expect(resolveSwarmModelEffort('optimize', 'manager', undefined, NOW)!.model).toBe('opus')
    expect(resolveSwarmModelEffort('optimize', 'manager', undefined, NOW)!.effort).toBe('high')
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
    for (const role of ['worker', 'supply', 'manager'] as const) {
      for (const mode of EXECUTION_MODES) {
        expect(resolveSwarmModelEffort(mode, role, undefined, NOW, ALL_OFF)).toBeNull()
      }
    }
  })

  it('does NOT expire: a year later a disabled tier is still disabled', () => {
    expect(resolveAvailableTier('fable', NOW + 365 * 24 * HOUR, off('fable'))).toBe('opus')
  })

  it('max mode with fable OFF launches every role on opus, effort untouched', () => {
    for (const role of ['worker', 'supply', 'manager'] as const) {
      expect(resolveSwarmModelEffort('max', role, undefined, NOW, off('fable'))).toEqual({
        model: 'opus',
        effort: 'max',
      })
    }
  })

  it('optimize: an ultra card cannot reach a disabled top tier; chores skip a disabled sonnet', () => {
    const top = { title: 'rebuild the engine', tier: 'ultra' as const }
    expect(resolveSwarmModelEffort('optimize', 'worker', top, NOW)!.model).toBe('fable')
    expect(resolveSwarmModelEffort('optimize', 'worker', top, NOW, off('fable'))!.model).toBe('opus')
    // sonnet OFF ⇒ the chore steps DOWN to haiku (never up onto the top tier by accident).
    // ⚠ An ACTUAL chore card, not `undefined`: since 2026-08-26 a card with no
    // signal is the opus BASE, so passing undefined here would exercise the base
    // and never touch sonnet at all — the assertion would pass while testing
    // nothing about a disabled sonnet.
    const chore = { title: '[minor] fix a typo' }
    expect(resolveSwarmModelEffort('optimize', 'worker', chore, NOW, off('sonnet'))!.model).toBe(
      'haiku',
    )
    // …and the BASE is independent of sonnet entirely: turning sonnet off does
    // not move an ordinary card, because it was never seated there.
    expect(resolveSwarmModelEffort('optimize', 'worker', undefined, NOW, off('sonnet'))!.model).toBe(
      'opus',
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

// ─── The PROBED resolvers — pre-launch wall detection (2026-07-13) ───────────
// Integration-shaped: the REAL ensureTierProbed runs behind the resolver, with
// only its exec seam mocked (CI never spawns a real `claude`). This is the card's
// acceptance shape in unit form: a dry fable refuses the probe ⇒ the launch
// lands on opus AND the cooling mark appears with no manual cool.

describe('resolveAvailableTierProbed / resolveSwarmModelEffortProbed (pre-launch probe)', () => {
  const NOW = 1_700_000_000_000
  const HOUR = 3_600_000
  const FABLE_LIMIT_NOTICE =
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."

  beforeEach(() => {
    __resetTierProbeForTest()
  })

  /** Wire the REAL ensureTierProbed to a scripted exec: `walls` refuse with the
   *  verbatim CLI notice, everything else answers. Returns the probe fn the
   *  resolvers take, plus the per-tier call log. */
  const scriptedProbe = (...walls: SwarmModelTier[]) => {
    const calls: string[] = []
    const exec: TierProbeExec = async (_bin, args) => {
      const tier = args[args.indexOf('--model') + 1]
      calls.push(tier)
      return walls.includes(tier as SwarmModelTier)
        ? { stdout: FABLE_LIMIT_NOTICE.replace('Fable 5', tier), stderr: '', failed: true }
        : { stdout: 'PROBE_OK', stderr: '', failed: false }
    }
    const probe = (tier: string) =>
      ensureTierProbed(tier, { exec, bin: '/fake/claude', now: () => NOW })
    return { probe, calls }
  }

  it('a dry fable refuses the probe ⇒ the launch drops to opus AND fable cools automatically', async () => {
    const { probe, calls } = scriptedProbe('fable')
    expect(isTierCooling('fable', NOW)).toBe(false) // no cooling mark, no usage veto — UNKNOWN
    const tier = await resolveAvailableTierProbed('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe)
    expect(tier).toBe('opus')
    expect(isTierCooling('fable', NOW)).toBe(true) // the probe recorded the wall — no manual cool
    expect(calls).toEqual(['fable', 'opus']) // one probe per unknown rung, nothing more
  })

  it('a healthy fable answers the probe ⇒ launch on fable, one probe total', async () => {
    const { probe, calls } = scriptedProbe()
    const tier = await resolveAvailableTierProbed('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe)
    expect(tier).toBe('fable')
    expect(calls).toEqual(['fable'])
    expect(isTierCooling('fable', NOW)).toBe(false)
  })

  it('a fresh verdict is reused — the next launch does not probe again', async () => {
    const { probe, calls } = scriptedProbe()
    await resolveAvailableTierProbed('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe)
    await resolveAvailableTierProbed('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe)
    expect(calls).toEqual(['fable']) // the TTL cache served the second launch
  })

  it("an inconclusive probe (timeout/no wording) is FAIL-OPEN: launch on the desired tier", async () => {
    const calls: string[] = []
    const exec: TierProbeExec = async (_bin, args) => {
      calls.push(args[args.indexOf('--model') + 1])
      return { stdout: '', stderr: 'spawn ETIMEDOUT', failed: true }
    }
    const probe = (tier: string) =>
      ensureTierProbed(tier, { exec, bin: '/fake/claude', now: () => NOW })
    const tier = await resolveAvailableTierProbed('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe)
    expect(tier).toBe('fable') // not knowing never kills a tier
    expect(isTierCooling('fable', NOW)).toBe(false)
    expect(calls).toEqual(['fable'])
  })

  it('an already-cooling fable is KNOWN: no probe spent on it, walk starts at opus', async () => {
    markCoolingUntil('fable', NOW + HOUR)
    const { probe, calls } = scriptedProbe()
    const tier = await resolveAvailableTierProbed('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe)
    expect(tier).toBe('opus')
    expect(calls).toEqual(['opus']) // fable was never probed — the table already knew
  })

  it('a usage-vetoed top tier is KNOWN: no probe spent on it either', async () => {
    const usage: CliUsage = {
      session: null,
      weekAll: { pct: 100, resetsAt: 'in 6 days' },
      capturedAt: '2026-07-12T00:00:00.000Z',
      status: 'ok',
    }
    const { probe, calls } = scriptedProbe()
    const tier = await resolveAvailableTierProbed('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS, usage, probe)
    expect(tier).toBe('opus')
    expect(calls).toEqual(['opus'])
  })

  it('every rung dry ⇒ each probed once, then the nothing-spawnable fallback (park owns it)', async () => {
    const { probe, calls } = scriptedProbe('fable', 'opus', 'sonnet', 'haiku')
    const tier = await resolveAvailableTierProbed('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe)
    expect(tier).toBe('fable') // the sync walk's "keep desired while allowed" answer — engine parks
    expect(calls).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    for (const t of MODEL_TIER_LADDER) expect(isTierCooling(t, NOW)).toBe(true)
  })

  it('a fully-cooled ladder at entry returns the park fallback WITHOUT probing (known-dry)', async () => {
    for (const t of MODEL_TIER_LADDER) markCoolingUntil(t, NOW + HOUR)
    const { probe, calls } = scriptedProbe()
    const tier = await resolveAvailableTierProbed('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe)
    expect(tier).toBe('fable') // same answer the sync walk gives today
    expect(calls).toEqual([])
  })

  it('the owner mask still wins: a disabled fable is never probed nor launched', async () => {
    const off = { fable: false, opus: true, sonnet: true, haiku: true } as SwarmAllowedModels
    const { probe, calls } = scriptedProbe()
    const tier = await resolveAvailableTierProbed('fable', NOW, off, null, probe)
    expect(tier).toBe('opus')
    expect(calls).toEqual(['opus'])
  })

  it('resolveSwarmModelEffortProbed: max/worker on a dry fable seats opus, effort untouched', async () => {
    const { probe } = scriptedProbe('fable')
    const me = await resolveSwarmModelEffortProbed(
      'max', 'worker', undefined, NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe,
    )
    expect(me).toEqual({ model: 'opus', effort: 'max' })
    expect(isTierCooling('fable', NOW)).toBe(true)
  })

  it('resolveSwarmModelEffortProbed: the probe goes to the tier that would LAUNCH (economy ⇒ sonnet)', async () => {
    const { probe, calls } = scriptedProbe()
    const me = await resolveSwarmModelEffortProbed(
      'economy', 'worker', undefined, NOW, DEFAULT_SWARM_ALLOWED_MODELS, null, probe,
    )
    expect(me).toEqual({ model: 'sonnet', effort: 'low' })
    expect(calls).toEqual(['sonnet']) // never a probe wasted on a tier this launch would not use
  })

  it('resolveSwarmModelEffortProbed: every tier masked OFF ⇒ null (fail-closed), no probes', async () => {
    const none = { fable: false, opus: false, sonnet: false, haiku: false } as SwarmAllowedModels
    const { probe, calls } = scriptedProbe()
    const me = await resolveSwarmModelEffortProbed(
      'max', 'worker', undefined, NOW, none, null, probe,
    )
    expect(me).toBeNull()
    expect(calls).toEqual([])
  })
})

// ─── FABLE CONTAINMENT (owner, 2026-09-16) ───────────────────────────────────
// The owner's weekly FABLE pool is the scarce one; Opus has headroom. The rule is
// therefore a CONTAINMENT rule, not a frugality one: under the default `optimize`
// mode, fable may be the desired tier for EXACTLY ONE slot — an `ultra` (before
// 2026-09-18: "heavy design")
// card's worker — and every other slot desires opus (or cheaper).
//
// This sweeps the WHOLE matrix rather than checking the roles known to be wrong,
// because the failure mode being guarded is a seat that NOBODY listed: one that
// reads SWARM_LAUNCH_MODEL directly instead of asking the mode, and so appears in
// no model table to audit. That is not hypothetical — the adversarial review panel
// was exactly that, and a per-role assertion could not have found it. (It cost
// nothing: `deps.review` has had no non-test caller since 2026-07-15, so the panel
// spent no fable. Nor is this guard what moved the owner's 51% Fable week: the
// 2026-09-18 breakdown put swarm workers at 19.4% of the 7-day spend and the bulk
// on the always-on desks' context; docs/commander/04-quota-models.md §5.9 is canon.)
//
// Enumerating SwarmModelRole means a role added later is covered the day it is
// added — and a role added WITHOUT being added to the union cannot reach
// desiredModelEffort at all, because tsc rejects it (the over-approximation half
// of the guard).
describe('fable containment — optimize desires the top tier for ultra worker cards ONLY', () => {
  const ROLES: SwarmModelRole[] = ['worker', 'supply', 'manager']
  const HEAVY = { title: 'auth guard rewrite', notes: 'security' } // matches HEAVY_SIGNALS
  const ORDINARY = { title: 'add a button', notes: 'small ui tweak' }
  const ULTRA = { title: 'add a button', notes: 'small ui tweak', tier: 'ultra' as const }
  const DESIGN = { title: 'add a button', tier: 'design' as const }

  it('names fable for exactly one (role, card) pair in optimize — the ultra worker', () => {
    const wantsFable: string[] = []
    for (const role of ROLES) {
      for (const [label, card] of [
        ['heavy', HEAVY],
        ['ordinary', ORDINARY],
        ['ultra', ULTRA],
        ['design', DESIGN],
      ] as const) {
        if (desiredModelEffort('optimize', role, card).model === SWARM_LAUNCH_MODEL) {
          wantsFable.push(`${role}/${label}`)
        }
      }
    }
    // A safety-keyword card is NOT a fable card any more (it floors at design).
    expect(wantsFable).toEqual(['worker/ultra'])
  })

  it('gives every non-worker role opus in optimize — including the supply desk', () => {
    for (const role of ['manager'] as const) {
      expect(desiredModelEffort('optimize', role)).toEqual({
        model: SWARM_DEFAULT_MODEL,
        effort: 'high',
      })
    }
    // Supply joined the opus row on 2026-09-18 (owner) at MEDIUM effort — a desk
    // that investigates and specifies, not a transcriber. Still never fable: the
    // containment test above counts it.
    expect(desiredModelEffort('optimize', 'supply')).toEqual({
      model: SWARM_DEFAULT_MODEL,
      effort: 'medium',
    })
  })

  it('leaves `max` alone — an explicit max run still puts EVERY role on the top tier', () => {
    for (const role of ROLES) {
      expect(desiredModelEffort('max', role, ORDINARY).model).toBe(SWARM_LAUNCH_MODEL)
    }
  })

  it('leaves `economy` alone — sonnet everywhere, and never fable', () => {
    for (const role of ROLES) {
      expect(desiredModelEffort('economy', role, HEAVY).model).toBe('sonnet')
    }
  })

  it('ultra keeps top tier/max; a safety-keyword card without a tier runs design (opus/high)', () => {
    expect(desiredModelEffort('optimize', 'worker', ULTRA)).toEqual({
      model: SWARM_LAUNCH_MODEL,
      effort: 'max',
    })
    expect(desiredModelEffort('optimize', 'worker', HEAVY)).toEqual({
      model: SWARM_DEFAULT_MODEL,
      effort: 'high',
    })
  })

  it('puts an ordinary card — and a card with NO signals at all — on opus', () => {
    expect(desiredModelEffort('optimize', 'worker', ORDINARY).model).toBe(SWARM_DEFAULT_MODEL)
    expect(desiredModelEffort('optimize', 'worker').model).toBe(SWARM_DEFAULT_MODEL)
  })

  it('SWARM_DEFAULT_MODEL is a real rung BELOW the top tier (not an alias for it)', () => {
    // Cheap protection against a future "bump the tier" edit that sets both
    // constants to the same string and silently re-opens the leak everywhere.
    expect(SWARM_DEFAULT_MODEL).not.toBe(SWARM_LAUNCH_MODEL)
    expect(MODEL_TIER_LADDER.indexOf(SWARM_DEFAULT_MODEL as (typeof MODEL_TIER_LADDER)[number])).toBeGreaterThan(
      MODEL_TIER_LADDER.indexOf(SWARM_LAUNCH_MODEL as (typeof MODEL_TIER_LADDER)[number]),
    )
  })
})
