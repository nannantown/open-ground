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

import {
  CLAUDE_EFFORTS,
  type ClaudeEffort,
  type ExecutionMode,
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
} from '../types'

/** The TOP-TIER model — what "full capability" means today. Fable 5 superseded
 *  Opus 4.8 as the newest flagship (alias verified against the CLI: `--model
 *  fable` accepted, bogus aliases rejected). Used by max-output mode, optimize's
 *  quality-critical slots (commander / heavy cards), the engine's adversarial
 *  reviewer default, and the no-mode back-compat default. ONE constant so the
 *  next model generation is a one-line bump. */
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

/** Resolve the model + effort a swarm role should launch at under `mode`. Workers
 *  in `optimize` route by card weight; the engine roles (supply/manager) key off
 *  the mode alone. Principle (card 68d8e00f): cut redundancy/volume, but keep
 *  CAPABILITY where a judgment's quality matters — so a HEAVY optimize card stays
 *  top-tier/max, and even economy roles keep `medium` effort (they reason across
 *  integration) while economy workers drop to `low`. */
export const resolveSwarmModelEffort = (
  mode: ExecutionMode,
  role: 'worker' | 'supply' | 'manager',
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
  if (role === 'manager') return { model: SWARM_LAUNCH_MODEL, effort: guardEffort('high') }
  // The supply officer only translates intent into cards — sonnet is plenty.
  if (role === 'supply') return { model: 'sonnet', effort: guardEffort('medium') }
  // Workers route by card weight: heavy/safety work gets the top-tier model,
  // chores drop to sonnet.
  const w = card ? classifyCardWeight(card) : 'medium'
  if (w === 'heavy') return { model: SWARM_LAUNCH_MODEL, effort: guardEffort('max') }
  if (w === 'light') return { model: 'sonnet', effort: guardEffort('low') }
  return { model: 'sonnet', effort: guardEffort('medium') }
}

/** The live-worker ceiling for a mode — economy runs fewer parallel workers (each
 *  a full `claude`), max keeps the historical band, optimize sits in the middle.
 *  Clamped to [1, hardMax] so it never breaches ORCHESTRATOR_MAX_WORKERS. */
export const execModeMaxWorkers = (mode: ExecutionMode, hardMax: number): number => {
  const want = mode === 'economy' ? 2 : mode === 'optimize' ? 4 : hardMax
  return Math.max(1, Math.min(hardMax, want))
}
