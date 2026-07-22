// swarmLaunch — the launch defaults EVERY in-app swarm role (補給官 supply /
// worker / future 司令官 commander) shares, so the three stay in lockstep
// instead of each role hard-coding — and silently drifting on — its own model /
// effort. Mirrors the shell swarm launchers (swarm-supply.sh / swarm-new.sh),
// which run the top tier (`--effort max`; the tmux scripts still say opus — the in-app
// tier is SWARM_LAUNCH_MODEL and upgrades in one place).
//
// effort is guarded against CLAUDE_EFFORTS so a rename here can never emit a
// broken `--effort` argv — the same discipline launchOptsFromPrefs and the old
// inline swarmSupply guard applied. Centralizing it means a future commander
// launch inherits opus/max (and, once added, Remote Control) for free, without
// re-deriving the guard.

import { basename } from 'path'
import {
  CLAUDE_EFFORTS,
  type ClaudeEffort,
  type ExecutionMode,
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
} from '../types'
// Remote Control 名の識別化(下の swarmRemoteControlName / resolveSwarmRemoteName):
// 言語は OG の言語設定(Settings.language — promptLang)、プロジェクト表示名は
// registry(displayName || フォルダ名)から spawn 時に解決する。registry は
// store.ts を import し、store.ts は asExecutionMode 目的で本ファイルを import
// するため、swarmLaunch → registry → store → swarmLaunch という循環 import は
// 実在する。ただし両側とも関数内でしか相手を参照しない(module init 時に互いへ
// アクセスしない)ため今は無害 — この import 循環に頼って module top-level で
// 互いの値を読む変更を足すと TDZ / undefined 初期化を踏むので要注意。
import { pick, getPromptLang, type PromptLang } from './promptLang'
import { findProjectEntryByPath } from './registry'
// The [Quota] foundation (swarmQuota) is the tier AWARENESS layer this file reads
// (never writes): the ladder + which tiers are cooling. Importing it here is what
// turns the launch model from a fixed top-tier constant into "the highest tier
// with headroom" (see resolveAvailableTier). One-way dep — swarmQuota imports
// nothing back (it's the pure foundation).
import { MODEL_TIER_LADDER, isTierCooling, isModelTier, type ModelTier } from './swarmQuota'
// The [Probe] pre-launch wall detector (swarmTierProbe): one headless
// `claude --model <tier> -p` call that reads the CLI's own refusal string — the
// ONLY signal that sees a tier-local wall /usage cannot express (the 2026-07-13
// fable-only exhaustion; see the module head there). The probed resolver below
// consults it exactly when a tier is UNKNOWN; a wall it finds lands in the
// cooling table via the sensor's own write path, so the ladder walk drops a rung.
import { ensureTierProbed, type TierProbeVerdict } from './swarmTierProbe'
// The [Allowed] policy layer (swarmAllowedModels) is the SECOND, independent veto
// this file reads: the owner's permanent per-tier ON/OFF switch. Cooling expires;
// this does not. Both must pass for a tier to be launched on — `isTierSpawnable`
// is the single predicate that ANDs them, so no ladder walk can forget one.
import {
  allowedModelTiers,
  highestAllowedTier,
  isTierAllowed,
  isTierSpawnable,
} from './swarmAllowedModels'
import type { SwarmAllowedModels } from '../types'
// The [Usage] pre-launch signal — the SAME cache UsageHud reads (claudeUsageCli),
// consulted here read-only (never a live ~9s scrape at launch time; peekCachedUsage
// is a synchronous in-memory peek that misses on a cold/expired cache — see
// isTopTierExhaustedByUsage for the fail-open contract that follows from that).
import { peekCachedUsage, type CliUsage } from './claudeUsageCli'

/** The TOP-TIER model — what "full capability" means today. Fable 5 superseded
 *  Opus 4.8 as the newest flagship (alias verified against the CLI: `--model
 *  fable` accepted, bogus aliases rejected). Used by max-output mode, optimize's
 *  quality-critical slots (commander / heavy cards), the engine's adversarial
 *  reviewer default, and the no-mode back-compat default. ONE constant so the
 *  next model generation is a one-line bump.
 *
 *  This is the TOP of {@link MODEL_TIER_LADDER} (=== `MODEL_TIER_LADDER[0]`): the
 *  launch model is no longer this constant *directly* but the highest ladder tier
 *  with quota headroom (see {@link resolveAvailableTier}) — normally fable, but
 *  opus when fable is cooling, etc. The constant stays the single "what is the top
 *  tier" definition the ladder's head and the non-launch defaults share. */
export const SWARM_LAUNCH_MODEL = 'fable'

/** The effort literal the swarm runs at. Kept as a raw string so the
 *  CLAUDE_EFFORTS membership check below is a REAL guard: a typo'd rename
 *  degrades to undefined ("CLI default"), never a broken `--effort` argv. */
const SWARM_LAUNCH_EFFORT_RAW = 'max'

/** Effort every swarm role launches at — 'max' while the CLI still accepts it,
 *  else undefined (fall through to the CLI default rather than emit junk). */
export const SWARM_LAUNCH_EFFORT: ClaudeEffort | undefined = CLAUDE_EFFORTS.includes(
  SWARM_LAUNCH_EFFORT_RAW as ClaudeEffort,
)
  ? (SWARM_LAUNCH_EFFORT_RAW as ClaudeEffort)
  : undefined

export interface SwarmLaunchDefaults {
  model: string
  effort?: ClaudeEffort
  /** Remote Control session name (`--remote-control <name>`): the role launches
   *  controllable from claude.ai / mobile under this label, with NO manual
   *  toggle. ALWAYS a non-empty, explicit name — claude's `--remote-control
   *  [name]` takes an OPTIONAL value, so a bare flag would swallow the following
   *  positional prompt as the name (buildClaudeArgv emits it accordingly). */
  remoteControl: string
}

/** The shared launch defaults a swarm role runs with — Remote Control ON, plus a
 *  model/effort that DEFAULTS to opus/max but is overridable by the execution mode
 *  (see {@link resolveSwarmModelEffort}). `remoteName` is the role's Remote Control
 *  label so it's identifiable on claude.ai / mobile (supply / worker / …). Pass
 *  `me` (the mode-resolved model+effort) to run a role cheaper; omit it and the
 *  role keeps the historical opus/max (max-output mode / back-compat). `effort` is
 *  omitted entirely when undefined so the spread never sets `effort: undefined`. */
export const swarmLaunchDefaults = (
  remoteName: string,
  me: { model: string; effort?: ClaudeEffort } = {
    model: SWARM_LAUNCH_MODEL,
    effort: SWARM_LAUNCH_EFFORT,
  },
): SwarmLaunchDefaults => ({
  model: me.model,
  ...(me.effort ? { effort: me.effort } : {}),
  remoteControl: remoteName,
})

// ─── Remote Control セッション名の識別化(オーナー直接フィードバック 2026-07-18)──
// スマホ / claude.ai のセッション一覧には --remote-control に渡した名前がそのまま
// 並ぶ。固定の 'manager'/'worker'/'supply' では同名が大量に並び、どのプロジェクトの
// 何のセッションか読めない。そこで「役割 + プロジェクト表示名(+ worker はカード
// title)」を OG の言語設定で合成した名前を渡す。
//
// 名前の制約は実測済み(2026-07-18, claude CLI 2.1.214): 日本語・スペース・コロン・
// 括弧・120 字超のいずれも CLI が受理して /remote-control is active になり、
// claude.ai 一覧にもそのまま表示された(長名は一覧 UI 側が末尾省略)。よって ASCII
// への転写は不要 — 可読性のためだけに下の REMOTE_NAME_MAX で切り詰める。

export type SwarmRemoteRole = 'manager' | 'worker' | 'supply'

// 役割語(オーナー確定語彙 2026-07-18): JA は「マネージャー / ワーカー / タスク窓口」
// のナチュラル表記 — 「司令官/作業員/補給官」はセッション名には使わない。EN は
// Manager / Worker、supply のみ既存 i18n の EN 訳
// (projectPanel.swarm.supply.badge = 'Supply officer')と整合させる。
const REMOTE_ROLE_LABEL: Record<SwarmRemoteRole, { en: string; ja: string }> = {
  manager: { en: 'Manager', ja: 'マネージャー' },
  worker: { en: 'Worker', ja: 'ワーカー' },
  supply: { en: 'Supply officer', ja: 'タスク窓口' },
}

/** 一覧での可読性上限(code point 数)。実測ではもっと長くても通るが、モバイル一覧は
 *  先頭 20〜30 字しか見えないので、役割+プロジェクト名の後にタスク要約の頭が乗る
 *  長さで切る。切り詰めは code point 単位(Array.from)でサロゲートを分断しない。 */
export const REMOTE_NAME_MAX = 60

/** Remote Control 名を合成する(pure): `<役割語> <プロジェクト表示名>[: <タスク>]`。
 *  空白の連なり(改行・タブ含む)は 1 個のスペースに潰す — カード title の改行が
 *  そのまま名前に乗ると一覧が壊れて見えるため。C0/C1 制御文字(\x00-\x1F, \x7F-\x9F
 *  — ESC \x1b を含む)は先に除去する。quote 済みでも PTY 入力行に ESC が残ると
 *  zsh ZLE がキーバインドとして解釈し起動行が壊れ得るため — pastePrompt.ts が
 *  ESC を除去している方針と同じ理由。projectName が空でも役割語だけは必ず残る
 *  (旧固定名より情報が減ることはない)。上限超過は末尾 '…'。 */
export const swarmRemoteControlName = (
  role: SwarmRemoteRole,
  lang: PromptLang,
  projectName?: string,
  taskTitle?: string,
): string => {
  // \t \n \r は \s+ の空白畳み込みに委ねる(除去でなく 1 スペースへ)ので対象外。
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
  const clean = (s?: string): string =>
    (s ?? '')
      .replace(CONTROL_CHARS, '')
      .replace(/\s+/g, ' ')
      .trim()
  const label = pick(lang, REMOTE_ROLE_LABEL[role])
  const proj = clean(projectName)
  const task = clean(taskTitle)
  const base = proj ? `${label} ${proj}` : label
  const full = task ? `${base}: ${task}` : base
  const cps = Array.from(full)
  return cps.length <= REMOTE_NAME_MAX
    ? full
    : cps.slice(0, REMOTE_NAME_MAX - 1).join('') + '…'
}

/** spawn 時に言語設定(Settings.language — spawn 後の切替は次の spawn から反映)と
 *  プロジェクト表示名(registry: displayName?.trim() || フォルダ basename — scan.ts の
 *  カード表示名と同じ規則。git リポジトリ名ではない)を読んで合成する async 実体。
 *  manager / supply / worker の 3 spawn パスが呼ぶ。
 *
 *  NEVER THROWS: 名前の識別化は表示品質であって起動条件ではない。設定/レジストリの
 *  読みに失敗したら旧固定名(role 文字列そのもの)へ落として spawn を通す —
 *  「リモコン登録に失敗しても spawn 自体は成功する」既存挙動と同じ精神。 */
export const resolveSwarmRemoteName = async (
  role: SwarmRemoteRole,
  projectPath: string,
  taskTitle?: string,
): Promise<string> => {
  try {
    const [lang, entry] = await Promise.all([
      getPromptLang(),
      findProjectEntryByPath(projectPath),
    ])
    const projectName = entry?.displayName?.trim() || basename(projectPath) || undefined
    return swarmRemoteControlName(role, lang, projectName, taskTitle)
  } catch {
    return role
  }
}

// ─── Execution mode (トークン節約) — card 68d8e00f ────────────────────────────
// One global switch that sets how much capability the in-app swarm burns, so the
// owner trades quality ↔ weekly-budget with ONE toggle instead of per-card fiddling.
// The subscription weekly cap is finite; always-opus/max burns peak cost even on
// chores. Both models run on the SAME subscription (project_subscription_only) — a
// sonnet run is simply lighter, so it stretches the cap. NEVER an API key.

/** Narrow an untrusted value (settings / body) to a real mode, else the default.
 *  (`ExecutionMode` / `EXECUTION_MODES` / `DEFAULT_EXECUTION_MODE` are the shared
 *  contract in types.ts so the client toggle uses the same source.) */
export const asExecutionMode = (v: unknown): ExecutionMode =>
  typeof v === 'string' && (EXECUTION_MODES as readonly string[]).includes(v)
    ? (v as ExecutionMode)
    : DEFAULT_EXECUTION_MODE

const guardEffort = (e: string): ClaudeEffort | undefined =>
  CLAUDE_EFFORTS.includes(e as ClaudeEffort) ? (e as ClaudeEffort) : undefined

/** How heavy a card is — drives model/effort in `optimize` mode. Purely STATIC
 *  (labels / keywords / size): judging weight with another `claude` call would
 *  itself burn the budget this feature exists to save. */
export type CardWeight = 'heavy' | 'medium' | 'light'

// Signals that a card is high-stakes → keep full capability (top tier/max). Safety +
// architecture + release-blocking work, in EN and JA.
const HEAVY_SIGNALS =
  /(\bsandbox\b|\bguard\b|\bauth\b|認証|\bdelete\b|削除|\bbilling\b|課金|\bsecurity\b|セキュリティ|\bMAJOR\b|release[\s-]?block|リリースブロッカ|\bSPIKE\b|\bmigration\b|マイグレ|敵対レビュー|サンドボックス)/i
// Signals that a card is low-stakes → Sonnet/low is plenty (chores, copy, follow-ups).
const LIGHT_SIGNALS =
  /(\[minor\]|\[follow[\s-]?up\]|\btypo\b|\brename\b|文言|\bcomment\b|コメント|\bnit\b|\bcleanup\b|\blint\b|\bdoc\b|\bcopy\b)/i

/** Classify a card by static signals. Unknown/ambiguous → `medium` (the SAFE
 *  middle — never silently under-powers), and a heavy signal or a large brief
 *  (big notes ⇒ substantial work) wins over a light one. */
export const classifyCardWeight = (card: { title?: string; notes?: string }): CardWeight => {
  const text = `${card.title ?? ''}\n${card.notes ?? ''}`
  if (HEAVY_SIGNALS.test(text) || text.length > 1200) return 'heavy'
  if (LIGHT_SIGNALS.test(text) && text.length < 400) return 'light'
  return 'medium'
}

/** The DESIRED model + effort a swarm role would launch at under `mode`, BEFORE
 *  the quota fallback ({@link resolveSwarmModelEffort} maps the model through
 *  {@link resolveAvailableTier}). Workers in `optimize` route by card weight; the
 *  engine roles (supply/manager/overseer) key off the mode alone. Principle
 *  (card 68d8e00f): cut redundancy/volume, but keep CAPABILITY where a judgment's
 *  quality matters — so a HEAVY optimize card stays top-tier/max, and even economy
 *  roles keep `medium` effort (they reason across integration) while economy
 *  workers drop to `low`. The `overseer` (proxy-you brain, EPIC C) is a judgment席
 *  on par with the manager — its answer-as-owner decision is quality-critical, so
 *  it tracks the manager tier. */
const desiredModelEffort = (
  mode: ExecutionMode,
  role: 'worker' | 'supply' | 'manager' | 'overseer',
  card?: { title?: string; notes?: string },
): { model: string; effort?: ClaudeEffort } => {
  if (mode === 'max') return { model: SWARM_LAUNCH_MODEL, effort: guardEffort('max') }
  if (mode === 'economy') {
    // Aggressive: everything on sonnet. The owner chose to minimise burn — accept a
    // slightly lighter commander. Workers drop to low effort; roles keep medium.
    return { model: 'sonnet', effort: guardEffort(role === 'worker' ? 'low' : 'medium') }
  }
  // optimize — keep CAPABILITY where the judgment's quality matters, cut VOLUME/model
  // elsewhere. The commander's integration / safety-review DECISION is quality-critical,
  // so it stays on the top-tier model (savings there come from fewer review bodies,
  // not a weaker model).
  // The commander AND the proxy-you overseer both make quality-critical judgment
  // calls — keep them on the top-tier model at high effort (manager と同格・D4).
  if (role === 'manager' || role === 'overseer') return { model: SWARM_LAUNCH_MODEL, effort: guardEffort('high') }
  // The supply officer only translates intent into cards — sonnet is plenty.
  if (role === 'supply') return { model: 'sonnet', effort: guardEffort('medium') }
  // Workers route by card weight: heavy/safety work gets the top-tier model,
  // chores drop to sonnet.
  const w = card ? classifyCardWeight(card) : 'medium'
  if (w === 'heavy') return { model: SWARM_LAUNCH_MODEL, effort: guardEffort('max') }
  if (w === 'light') return { model: 'sonnet', effort: guardEffort('low') }
  return { model: 'sonnet', effort: guardEffort('medium') }
}

/** Map a DESIRED model tier to the one a worker should ACTUALLY launch on, given
 *  the two independent vetoes at `now`: which tiers are COOLING (the [Quota]
 *  foundation's table, swarmQuota) and which the owner has switched OFF (the
 *  [Allowed] hard mask, swarmAllowedModels — pass the freshly-read map when you
 *  can await settings; the globalThis mirror is the default).
 *
 *  The fallback steps DOWN the ladder (fable→opus→sonnet→haiku): a slot that
 *  wanted the top tier (max mode / heavy card / commander) gets the highest
 *  spawnable tier, and a slot that deliberately chose a cheaper tier (economy /
 *  optimize chore) keeps it unless it too is unusable, then drops further. Only
 *  when EVERY tier at-or-below `desired` is unusable does it look UP to the best
 *  spawnable one — a launch must never land on a known-dry tier while another
 *  still has headroom.
 *
 *  FAIL-CLOSED on the mask. When nothing is spawnable the resolver still has to
 *  name a model (the wait-until-reset decision belongs to the engine — see
 *  swarmAllowedModels.spawnBlock — not here), and it picks:
 *    • `desired`, iff that tier is ALLOWED (every tier merely cooling ⇒ today's
 *      behavior, unchanged: the engine parks and nothing is spawned anyway);
 *    • else the best ALLOWED tier — a switched-OFF tier is never returned, even
 *      as a last resort. That is the bug this card closes: the old
 *      `?? desired` handed the caller the very tier the owner had disabled.
 *    • else `null` — the owner switched EVERY tier off. There is no model to
 *      launch on, so the caller must not spawn (NoAllowedModelTierError / park).
 *
 *  With nothing cooling and nothing switched off this is the IDENTITY on
 *  `desired`, so the execution-mode matrix below is exactly today's behavior. An
 *  unknown model string (not on the ladder) is treated as the ladder head — walk
 *  the whole thing — a safe "best available" default rather than a throw. */
/** Does a per-model `/usage` row NAME this tier? The label is whatever the TUI
 *  printed — "Fable 5", "Fable", "fable", and (after the TUI's space loss)
 *  "Fable5" all mean the fable rung. Compared as WORDS (split on every
 *  non-letter), never as a substring, so a "Sonnet" row can never satisfy the
 *  fable tier. Splitting is also why no RegExp is built from `tier` here: there
 *  is nothing to escape, so claudeUsageCli's escape helper is not needed (and
 *  not duplicated). */
const rowNamesTier = (label: string, tier: string): boolean =>
  label
    .toLowerCase()
    .split(/[^a-z]+/)
    .includes(tier.toLowerCase())

/** True iff the cached `claude /usage` scrape shows the swarm's TOP tier
 *  ({@link SWARM_LAUNCH_MODEL}) genuinely EXHAUSTED. Three independent readings
 *  can say so, OR'd — any one at pct >= 100 is a wall the top tier cannot launch
 *  through:
 *    • `session` / `weekAll` — the ACCOUNT-WIDE slots. They cap every model at
 *      once, so the top tier is dry whenever they are.
 *    • `weekModels` — the per-model weekly rows (`Current week (<Model> only)`),
 *      matched to {@link SWARM_LAUNCH_MODEL} by label ({@link rowNamesTier}).
 *      The only reading that COULD see the top tier run dry alone — and it is
 *      DORMANT: the `claude` shipping today (2.1.207) prints NO per-model row.
 *      Where 2.1.196 rendered one, a "Per-model breakdown unavailable (rate
 *      limited — try again in a moment)" placeholder now sits, so `weekModels`
 *      is ALWAYS empty in practice and this branch never fires (live render
 *      captured 2026-07-13 04:5xZ: two rows, zero occurrences of "only").
 *
 *  So this predicate does NOT catch a fable-only wall today. At 03:04Z that same
 *  day `claude` refused every fable launch ("You've reached your Fable 5 limit")
 *  while the scrape read session 3% / weekAll 63% and carried no row that could
 *  say otherwise — /usage simply cannot express it. The reading above is wired
 *  for the day the row comes back; the signal that DOES observe the wall is the
 *  CLI's own refusal string (`claude --model <tier> -p …` — one second, and no
 *  tokens at all when the tier is dry). That probe is a separate card; see
 *  docs/commander/04-quota-models.md §5.7.
 *
 *  A per-model row for a DIFFERENT tier (a dry `Sonnet only` while fable has
 *  headroom) is deliberately ignored here: this predicate answers one question —
 *  "is the LADDER HEAD dry?" — because that is the only rung
 *  {@link resolveAvailableTier}'s veto excludes. Vetoing a middle rung from its
 *  own row would need the walk to take a per-tier mask, not a boolean; the
 *  cooling table (layer A) already covers those tiers reactively.
 *
 *  FAIL-OPEN by construction (2026-07-12, user-confirmed policy: don't
 *  pre-emptively hunt down a tier that might still have headroom):
 *    • no cache yet / expired (`usage` is null, e.g. never scraped or the
 *      scrape failed) → false, never treated as exhausted;
 *    • no per-model row in the render (`weekModels` empty/absent — an older
 *      cached payload, or a plan whose /usage shows none) → false, exactly as
 *      before this reading existed;
 *    • a gray-zone reading (pct < 100, e.g. 95%) → false — only a CONFIRMED,
 *      fully-spent slot (pct >= 100) counts, mirroring the same threshold
 *      swarmOrchestrator's `a5CoolingHint` already trusts for reset times. */
export const isTopTierExhaustedByUsage = (usage: CliUsage | null): boolean => {
  if (!usage) return false
  if (usage.session && usage.session.pct >= 100) return true
  if (usage.weekAll && usage.weekAll.pct >= 100) return true
  return (usage.weekModels ?? []).some(
    (row) => row.pct >= 100 && rowNamesTier(row.model, SWARM_LAUNCH_MODEL),
  )
}

export const resolveAvailableTier = (
  desired: string,
  now: number,
  allowed: SwarmAllowedModels = allowedModelTiers(),
  usage: CliUsage | null = peekCachedUsage(),
): string | null => {
  // A THIRD, independent veto (on top of cooling + the owner's mask): the cached
  // /usage scrape. It speaks to the swarm's TOP tier (SWARM_LAUNCH_MODEL) two
  // ways — the account-wide session/week-all slots (which cap every model) and
  // the top tier's OWN per-model weekly row, the only reading that catches it
  // running dry alone. See isTopTierExhaustedByUsage for the fail-open contract.
  const topTierExhausted = isTopTierExhaustedByUsage(usage)
  const spawnable = (tier: ModelTier): boolean =>
    !(topTierExhausted && tier === MODEL_TIER_LADDER[0]) && isTierSpawnable(tier, now, allowed)

  const startIdx = MODEL_TIER_LADDER.indexOf(desired as ModelTier)
  const from = startIdx < 0 ? 0 : startIdx
  for (let i = from; i < MODEL_TIER_LADDER.length; i++) {
    if (spawnable(MODEL_TIER_LADDER[i])) return MODEL_TIER_LADDER[i]
  }
  // Re-walk from the top for the "best available, above `desired`" case — mirrors
  // highestSpawnableTier but honors the usage veto too (that helper only knows
  // cooling + the mask).
  for (const tier of MODEL_TIER_LADDER) {
    if (spawnable(tier)) return tier
  }
  // Nothing has headroom. Keep `desired` only while the owner still allows it
  // AND the usage veto doesn't rule it out.
  if (
    startIdx >= 0 &&
    isTierAllowed(desired as ModelTier, allowed) &&
    !(topTierExhausted && (desired as ModelTier) === MODEL_TIER_LADDER[0])
  )
    return desired
  return highestAllowedTier(allowed)
}

/** {@link resolveAvailableTier} + the PRE-LAUNCH PROBE: the async resolver every
 *  spawn path calls at launch time (worker / manager / supply / overseer / brain
 *  / reviewer panel — they are all async there). Semantics:
 *
 *    1. Resolve the tier exactly as the sync walk does (cooling + mask + usage
 *       veto — behavior unchanged when everything is known).
 *    2. If the chosen tier is UNKNOWN — a ladder tier with no cooling mark (the
 *       usage veto was already applied by the walk) — PROBE it once
 *       ({@link ensureTierProbed}: collapsed, TTL-cached, fail-open).
 *    3. 'wall' ⇒ the probe has ALREADY cooled the tier (markRateLimited, disk-
 *       mirrored), so re-resolving walks one rung down — loop. 'ok'/'unknown' ⇒
 *       launch on it (fail-open: not knowing never kills a tier).
 *
 *  The loop is bounded by the ladder length: each 'wall' pass cools the tier it
 *  probed, so the walk can never revisit it. Two early exits keep the probe
 *  honest: a NON-ladder model string is returned as-is (never probe arbitrary
 *  strings), and a tier the walk returned WHILE COOLING (the nothing-spawnable
 *  "keep desired" fallback) is returned unprobed — it is already known-dry and
 *  the engine's park gate owns that case, exactly as before.
 *
 *  `probe` is injectable for tests; production always means ensureTierProbed. */
export const resolveAvailableTierProbed = async (
  desired: string,
  now: number = Date.now(),
  allowed: SwarmAllowedModels = allowedModelTiers(),
  usage: CliUsage | null = peekCachedUsage(),
  probe: (tier: string) => Promise<TierProbeVerdict> = ensureTierProbed,
): Promise<string | null> => {
  for (let i = 0; i < MODEL_TIER_LADDER.length; i++) {
    const tier = resolveAvailableTier(desired, now, allowed, usage)
    if (tier == null) return null
    if (!isModelTier(tier)) return tier // not a ladder tier — nothing to probe
    if (isTierCooling(tier, now)) return tier // known-dry fallback (park's case) — don't probe
    const verdict = await probe(tier)
    if (verdict !== 'wall') return tier // ok / unknown ⇒ fail-open: launch here
    // wall ⇒ the probe cooled `tier`; the next resolve walks one rung down.
  }
  // Every ladder tier probed dry in one pass — fall through to the sync walk's
  // own nothing-spawnable answer (desired-if-allowed / best-allowed / null), the
  // same state a fully-cooled ladder reaches today; the engine parks on it.
  return resolveAvailableTier(desired, now, allowed, usage)
}

// ─── EXECUTION MODE × QUOTA FALLBACK ─────────────────────────────────────────
// How the launch tier is chosen once a tier is cooling. resolveSwarmModelEffort
// takes the mode's DESIRED tier (desiredModelEffort, logic UNCHANGED) then maps it
// through resolveAvailableTier, which only ever steps DOWN the ladder:
//
//   mode      desired tier (unchanged)               under a quota wall
//   ────────  ─────────────────────────────────────  ─────────────────────────────
//   max       top (fable) for EVERY role             highest tier with headroom
//                                                     (fable→opus→sonnet→haiku)
//   optimize  fable: commander / overseer / heavy    each desired tier resolved
//             sonnet: supply / chore workers         among what's available (down)
//   economy   sonnet everywhere (workers low)        sonnet, else next tier below
//
// So the user-confirmed behavior — "when the top tier's quota is spent, drop one
// tier" — falls out of `max` and optimize's fable slots: they all resolve to the
// same highest-available tier together (no per-card出し分け). economy/optimize's
// deliberately-cheaper picks are preserved, just resolved among what's available.
// effort is NEVER touched by the fallback — only the model tier follows the quota.
//
// The owner's hard mask (Settings.swarmAllowedModels) narrows the ladder BEFORE
// any of this: a switched-OFF tier is simply not a candidate, in any mode. So a
// swarm with fable OFF runs `max` on opus — and the mode's UI copy says so
// (ExecutionModeToggle drops disabled tiers from the hint) rather than promising
// a model the engine will never launch.
//
// A THIRD, PRE-LAUNCH signal narrows it further still: the cached `claude
// /usage` scrape (claudeUsageCli — the same cache UsageHud reads, never a live
// spawn here). Unlike cooling (learned ONLY after a launch actually gets
// rate-limited — swarmOrchestrator.markRateLimited), this one can act BEFORE
// the swarm even tries — if the scrape already shows the top tier at a CONFIRMED
// 100% (isTopTierExhaustedByUsage: the account-wide session / week-all slots, OR
// the top tier's own `Current week (<Model> only)` row), the top tier is excluded
// from every ladder walk in resolveAvailableTier, exactly like a cooling mark
// would. A gray-zone reading (<100%) or no cache at all changes nothing
// (fail-open) — this is a "known exhausted" veto, not a heuristic.
//
// REACH, measured: only the ACCOUNT-WIDE slots actually fire today. The current
// CLI prints no per-model row (see isTopTierExhaustedByUsage), so a wall that
// belongs to the top tier ALONE — the 2026-07-13 fable case — is invisible to
// every layer here and the swarm still walks into it. Closing that is the
// refusal-string probe's job, not this cache's.

/** Resolve the model + effort a swarm role launches at under `mode`, WITH the live
 *  quota fallback, the owner's hard mask, AND the pre-launch usage-cache veto
 *  applied to the model (effort is passed through untouched). `now` defaults to
 *  the wall clock so every call site re-resolves the CURRENT state AT launch —
 *  and is injectable for deterministic tests. `allowed` defaults to the
 *  globalThis mirror of Settings; every spawn path that can await settings
 *  passes the freshly-read map. `usage` defaults to a synchronous peek of the
 *  claudeUsageCli cache (see {@link isTopTierExhaustedByUsage}) — never a live
 *  scrape at launch time.
 *
 *  Returns `null` when the owner has switched EVERY tier OFF: there is no model to
 *  launch on, so the caller MUST NOT spawn (it throws NoAllowedModelTierError, or
 *  the engine parks + escalates). See the table above for the mode × fallback matrix. */
export const resolveSwarmModelEffort = (
  mode: ExecutionMode,
  role: 'worker' | 'supply' | 'manager' | 'overseer',
  card?: { title?: string; notes?: string },
  now: number = Date.now(),
  allowed: SwarmAllowedModels = allowedModelTiers(),
  usage: CliUsage | null = peekCachedUsage(),
): { model: string; effort?: ClaudeEffort } | null => {
  const desired = desiredModelEffort(mode, role, card)
  const model = resolveAvailableTier(desired.model, now, allowed, usage)
  return model ? { ...desired, model } : null
}

/** {@link resolveSwarmModelEffort} with the PRE-LAUNCH PROBE — what every spawn
 *  path actually calls at launch time (they are all async there). Identical to
 *  the sync resolver when the chosen tier is already known (cooling mark, usage
 *  veto, fresh probe verdict); when it is UNKNOWN, one collapsed headless probe
 *  ({@link resolveAvailableTierProbed}) checks it can launch before a `claude`
 *  is seated on it — the only pre-launch signal that sees a tier-local wall
 *  (/usage cannot express one — measured 2026-07-13, see swarmTierProbe). The
 *  probe never holds the spawn past its wait window (fail-open race — see
 *  TIER_PROBE_LAUNCH_WAIT_MS). The sync {@link resolveSwarmModelEffort} above
 *  has NO production caller left (every spawn path is probed now) — it stays as
 *  the probe-free core this wraps, and the deliberate answer for any future
 *  sync context, which CANNOT await a probe by construction. `probe` is
 *  injectable for tests. */
export const resolveSwarmModelEffortProbed = async (
  mode: ExecutionMode,
  role: 'worker' | 'supply' | 'manager' | 'overseer',
  card?: { title?: string; notes?: string },
  now: number = Date.now(),
  allowed: SwarmAllowedModels = allowedModelTiers(),
  usage: CliUsage | null = peekCachedUsage(),
  probe: (tier: string) => Promise<TierProbeVerdict> = ensureTierProbed,
): Promise<{ model: string; effort?: ClaudeEffort } | null> => {
  const desired = desiredModelEffort(mode, role, card)
  const model = await resolveAvailableTierProbed(desired.model, now, allowed, usage, probe)
  return model ? { ...desired, model } : null
}

/** The live-worker ceiling for a mode — economy runs fewer parallel workers (each
 *  a full `claude`), max keeps the historical band, optimize sits in the middle.
 *  Clamped to [1, hardMax] so it never breaches ORCHESTRATOR_MAX_WORKERS. */
export const execModeMaxWorkers = (mode: ExecutionMode, hardMax: number): number => {
  const want = mode === 'economy' ? 2 : mode === 'optimize' ? 4 : hardMax
  return Math.max(1, Math.min(hardMax, want))
}
