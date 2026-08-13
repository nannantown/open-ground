// swarmManager — the in-app, tmux-free replacement for the shell swarm's
// `manager` cockpit pane (the `/manage` commander). It is the "commander
// (司令官)" CONVERSATION primitive of the OPEN GROUND swarm port (docs /
// auto-memory project_inapp_swarm_port): the owner's INTEGRATION DESK. Given a
// registered project it launches ONE interactive `claude` PTY in the project's
// PRIMARY checkout running the `/og-manage` skill — the tmux-free commander
// protocol — which monitors the workers, answers "状況 / マージ / 掃除 / 相談",
// and integrates finished `swarm/*` branches (FF / rebase only, never forced)
// — all in conversation with the user, driving the app's own HTTP API (never
// tmux; the shell cockpit's `/manage` skill stays tmux-land, untouched).
//
// This is the human-in-the-loop counterpart to the AUTONOMOUS engine
// (swarmOrchestrator, behind /api/swarm/orchestrator): the engine is the
// unattended drain → dispatch → monitor → integrate loop the commander dashboard
// arms with its toggles; THIS session is the commander you talk to. The two
// coexist on the same tab.
//
// Like the SUPPLY officer (swarmSupply.ts) and UNLIKE a WORKER (swarmWorker.ts),
// the commander conversation gets NO worktree: it operates on the primary
// checkout. It runs bypass and — under WORKER-ONLY guard scoping (2026-07) — is
// NOT policed by the PreToolUse veto: the commander is the human-in-the-loop
// integration desk, a TRUSTED session the user talks to, so it runs with the same
// freedom as a plain claude (the veto polices only the confined, unattended worker
// — see scripts/openground-guard.js). SWARM_MANAGER=1 now only TAGS the session as
// the commander for tooling/skills, not as a guard opt-in. There is nothing to
// tear down on stop; stopping it is a plain PTY kill (the terminal DELETE route).
//
// This mirrors the shell `manager` launcher's FLAGS exactly — but hands claude
// the app-native skill instead of the cockpit one:
//   shell:  exec env SWARM_MANAGER=1 claude --model opus --effort max \
//               --dangerously-skip-permissions --remote-control manager "/manage"
//   in-app: same flags, positional prompt = "/og-manage"
//   - SWARM_MANAGER=1 — TAGS the session as the swarm commander (for tooling /
//     the commander skill). Under worker-only guard scoping it is NOT a guard
//     opt-in: the trusted commander is not policed by the PreToolUse veto.
//   - bypass (--dangerously-skip-permissions) — the commander runs git
//     (status / merge / branch -d) and Board moves unattended-style so the
//     conversation isn't interrupted by a tool-approval prompt each turn; its
//     safety net is the human in the loop, not the veto.
//   - opus / max — the commander reasons about integration order, conflicts and
//     worker state at full capability (mirrors the shell launcher).
//   - /og-manage as claude's POSITIONAL prompt — claude runs the skill on
//     startup, then stays interactive for the conversation. (A TUI-injected
//     slash command would not submit — the delivery fix swarmSupply/swarmWorker
//     document.) The skill difference is the point: /manage assumes a tmux
//     cockpit (swarm-pane.sh dispatch, respawn, swarm-watch), none of which
//     exist inside the app's PTY; /og-manage speaks the app's HTTP API instead.
// Subscription-only: launchClaude drives the user's `claude` CLI, never
// `claude -p` / the SDK.

import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { launchClaude, type LaunchClaudeOpts } from './claudeTerminal'
import {
  swarmLaunchDefaults,
  resolveSwarmModelEffortProbed,
  resolveSwarmRemoteName,
} from './swarmLaunch'
import { NoAllowedModelTierError } from './swarmAllowedModels'
import { resolveSwarmSession, recordSwarmSession, forgetSwarmSessionIf } from './swarmSessions'
import { getPromptLang, languageDirective, type PromptLang } from './promptLang'
// ⚠ PTY-ONLY functions are deliberately NOT imported here. `listLiveDesksIn` /
// `isTerminalProcessAlive` answer desk presence for one pool, and a commander
// desk can live on either — asking them is how a TWIN commander gets seated.
// Presence goes through swarmManagerRuntime (both pools); see docs/MAP.md §5.
import { onTerminalExit, getTerminalScreen } from './terminal'
import { matchesQuotaExhaustion, normalizeScreen } from './swarmRateLimitText'
import { markRateLimited, isModelTier } from './swarmQuota'
import { installOgManageSkill } from './ogManageSkill'
import { MANAGER_DESK_LABEL } from './swarmManagerLabel'
import { listManagerDesks } from './swarmManagerRuntime'
import {
  sdkManagerPreflight,
  sdkManagerLaunchPlan,
  SdkManagerUnavailableError,
} from './swarmManagerSdk'
import {
  spawnSdkSession,
  preloadSdk,
  attachSdkListener,
  type SdkSessionInfo,
  type SdkStreamFrame,
} from './sdkSession'
import { watchSdkDeskForLimit } from './sdkDeskLimit'
import { getExecutionMode, getAllowedModelTiers, getManagerRuntimeDial } from './store'
import type { ClaudeEffort } from '../types'
import { type SpawnSwarmManagerResponse } from '../types'

/** The skill the commander session runs, handed to claude as its positional
 *  prompt (claude submits it on startup; a TUI-injected slash command would
 *  not). The role is the `manager` (Remote Control label) running `/og-manage`
 *  — the tmux-FREE commander protocol (~/.claude/skills/og-manage/): its eyes
 *  are GET /api/swarm/workers + git, it dispatches via POST /api/swarm/worker,
 *  and it never mentions or runs tmux. The shell cockpit's `/manage` (tmux
 *  panes, swarm-pane.sh dispatch) stays untouched for the terminal cockpit —
 *  an in-app commander running THAT skill would advise tmux commands that
 *  cannot work inside the app's PTY, which is exactly why this injection
 *  points at the app-native sibling instead. */
export const MANAGER_INJECTION = '/og-manage'

/** The owner-facing name of this desk, carried onto its PTY pool entry
 *  (`TerminalInfo.deskLabel`). Consumers: the model-limit watch names the desk
 *  by it (ownerDeskLimit.ts), and the singleton guard IDENTIFIES a commander
 *  desk by it — the pool is the only authority that cannot desynchronise from
 *  itself. A desk the owner started by hand carries no label, so it is never
 *  mistaken for this one.
 *
 *  DEFINED in swarmManagerLabel.ts (a leaf module) and re-exported here: the
 *  runtime seam that finds desks needs the label, and this module needs that
 *  seam — see that file for the cycle it breaks. */
export { MANAGER_DESK_LABEL }

/** The positional prompt for a RESUMED commander (swarmSessions.ts): the same
 *  `/og-manage` skill, plus the ONE instruction a restored commander must obey
 *  before it opens its mouth — re-read the Board.
 *
 *  WHY this is not optional. Everything the commander believed when it was last
 *  awake is now suspect, in THREE different ways (updated 2026-07-22, card 2 —
 *  docs/ENGINE_PERSISTENCE_PLAN.md — see 01 章 §7.3/§7.4 for the canonical
 *  picture; this comment must not drift from it the way the string below once
 *  did):
 *    - Its per-worker ENGINE knowledge (roster / reviews / journal / KPI) is
 *      GONE — those are still in-memory-only (worker roster write-through is a
 *      SEPARATE, not-yet-built card 3). A commander that keeps talking about
 *      "the three workers I dispatched" is describing a world that no longer
 *      exists for THAT detail.
 *    - Its ENGINE ON/OFF state may or may not be what it remembers, in EITHER
 *      direction: `running` (and `selfSupply`) can now come back on its OWN,
 *      with no owner action, if the project's `engine.json` said
 *      `desiredRunning:true` before the restart (boot's `resumeEngines()` —
 *      the reversal of the old "restart always turns autonomy off" rule). So
 *      `running:true` right now might be the SAME engine picking up where it
 *      left off, not something the commander (or the owner) just switched on
 *      — and conversely a stopped engine or a suppressed resume (crash-loop
 *      breaker) means the OLD intent did NOT survive. Neither can be assumed;
 *      read it.
 *    - The CODE may have changed underneath it — an OPEN GROUND restart is usually
 *      a RELEASE. Cards it remembers as `doing` may be merged; its own file:line
 *      references may have shifted.
 *  (quota cooling is NOT in this list — it has been persisted to disk since
 *  2026-07-13 and survives a restart on its own; this comment used to claim
 *  otherwise, which was already stale before card 2.)
 *  So the resumed session is told to run 「状況」 FIRST — the skill's own status
 *  routine (GET /api/swarm/workers + /api/swarm/orchestrator + git + Board 列の
 *  突き合わせ), i.e. the existing read-the-world logic, not a new one — and report
 *  from what it FINDS, never from what it remembers.
 *
 *  ONE LINE, on purpose — the delivery contract buildOrderInjection (swarmWorker.ts)
 *  documents: the whole thing must land as a SINGLE slash-command argument, or it
 *  risks being split / collapsed into a `[Pasted text]` chip where `/og-manage` is
 *  never parsed as a command. */
export const MANAGER_RESUME_INJECTION =
  '/og-manage セッション再開: アプリ再起動をまたいで前回の会話を復元した。記憶をそのまま前提にするな — worker roster・review・journal は再起動で全消えし(card 3 未着手)、再起動はたいていリリースなのでコード自体も変わっている。エンジンの running/selfSupply は前回 ON だった意図が自動で戻っていることがある(boot 時の自動再開・owner の手動停止があれば戻らない)ので、今の running が「誰かが今つけた」のか「前回の意図が生き残った」のかは決めつけるな。最初にやることは1つだけ: 「状況」を頭から実行し、Board の実体(todo/doing/review)・worker 一覧・エンジン状態を API と git で読み直して、その結果だけを根拠に現状を報告する。前回の認識との食い違いがあれば現物(API/git)を正とし、食い違った点を明示すること。'

/** How long after launch a commander desk's death still counts as DEATH ON
 *  ARRIVAL — i.e. as evidence about the TIER rather than about the work.
 *
 *  Measured from the four desks that died in the 2026-07-19 incident: each
 *  reached its refusal 1.4–3.8s after its session opened, and the whole
 *  process — spawn, boot, refuse, exit — fits inside a few seconds. 90s is far
 *  past that spread while staying far short of any real integration session, so
 *  a desk that did actual work and then exited is never mistaken for one that
 *  never started. (Same order as the probe's own completion budget, and for the
 *  same reason: it bounds a `claude` that has to boot before it can answer.) */
export const DESK_DOA_WINDOW_MS = 90_000

/** LEARN FROM THE CORPSE: if the desk we just launched dies on arrival because
 *  its MODEL is spent, cool that tier so the next launch does not repeat it.
 *
 *  WHY THIS EXISTS ALONGSIDE THE PRE-LAUNCH PROBE (2026-07-19). The probe is a
 *  PREDICTION and every prediction has a fail-open path — it waits at most 8s,
 *  it cannot run without a resolved binary, and a tier can dry up in the seconds
 *  between the verdict and the spawn. When the prediction misses, the outcome is
 *  a desk that prints "You've reached your Fable 5 limit." and exits, and the
 *  engine's only recorded reaction was to try again 5 minutes later — on the same
 *  tier, because nothing had written the wall down. Four desks died that way.
 *  An OUTCOME is strictly better evidence than a prediction, and it is free: the
 *  desk already paid for it. This closes the loop no pre-launch check can.
 *
 *  ONLY THE CLI'S QUOTA-REFUSAL WORDING COOLS ANYTHING — the same polarity rule
 *  the probe follows (swarmRateLimitText.QUOTA_EXHAUSTION_PATTERNS, and the
 *  measured 2026-07-13 reason for it): a mark here is 20 PERSISTED minutes
 *  applied to every spawn path, so a desk that died of a crash, an owner's ^D, a
 *  bad skill or a transient 529 must NOT drag a healthy tier down with it. "The
 *  desk died young" is not evidence about the tier; "the desk said the tier is
 *  spent" is.
 *
 *  ALSO FORGETS THE STALE SESSION POINTER — BUT ONLY FOR A FRESH DESK. A FRESH
 *  desk (wasResumed=false) that dies quoting a quota refusal leaves behind a
 *  transcript containing nothing but that refusal, and the session record
 *  recordSwarmSession just wrote still names it; left alone, the NEXT commander
 *  launch's resolveSwarmSession would see that dead-but-loadable one-liner and
 *  `--resume` it instead of opening a real fresh desk. forgetSwarmSessionIf is
 *  compare-and-delete (keyed on the exact sessionId this watch was armed for),
 *  so a LATER launch that already recorded a good session over this one is
 *  never clobbered.
 *
 *  A RESUMED desk (wasResumed=true) must NEVER be forgotten this way: its
 *  transcript is days of real integration history plus one refusal line, and
 *  `--resume` on it is exactly the memory the commander is supposed to keep
 *  (docs/commander/00-INDEX.md's "conversation history survives restarts"
 *  guarantee). Forgetting it here would trade a working `--resume` for a wiped
 *  memory to save nothing — the next launch mints a session that has forgotten
 *  everything instead of resuming one that remembers everything but a refusal.
 *
 *  Best-effort throughout: a missing screen, an unreadable pool entry or a
 *  non-ladder model string all mean "learned nothing", never a thrown spawn.
 *
 *  MANAGER-ONLY, despite the generic name: the session-forget branch hardcodes
 *  the `'manager'` role (swarmSessions.SwarmSessionRole), because the only
 *  caller today is the commander's own launch path. If a future caller ever
 *  arms this watch for the SUPPLY desk, that hardcoded role must become a
 *  parameter first — otherwise a supply-desk DOA death would silently forget
 *  the COMMANDER's session record instead of its own. */
export const watchDeskForDeathOnArrival = (
  terminalId: string,
  tier: string,
  projectPath: string,
  agentSessionId: string,
  wasResumed: boolean,
  deps: {
    watch?: typeof onTerminalExit
    screen?: (id: string) => string | null
    now?: () => number
    forget?: typeof forgetSwarmSessionIf
  } = {},
): void => {
  if (!isModelTier(tier)) return // never cool an arbitrary model string
  const nowFn = deps.now ?? Date.now
  const bornAt = nowFn()
  const stop = (deps.watch ?? onTerminalExit)(terminalId, () => {
    try {
      if (nowFn() - bornAt > DESK_DOA_WINDOW_MS) return // it lived; its death says nothing
      const screen = (deps.screen ?? getTerminalScreen)(terminalId)
      if (!screen) return
      if (!matchesQuotaExhaustion(normalizeScreen(screen))) return
      const until = markRateLimited(tier, { ptyText: screen, now: nowFn() })
      console.warn(
        `[swarmManager] 司令官卓が tier '${tier}' の枯渇で起動即死 — ` +
          `${tier} を ${new Date(until).toISOString()} まで冷却(次の起動は1段下の tier)`,
      )
      // A resumed session's transcript is real history, not just a refusal —
      // never drop the pointer to it (see the header above).
      if (!wasResumed) {
        void (deps.forget ?? forgetSwarmSessionIf)(projectPath, 'manager', agentSessionId).catch(
          () => {},
        )
      }
    } catch {
      /* learning is best-effort; a fault here must never surface as a spawn error */
    }
  })
  // Disarm once the desk has outlived the window, so a long-lived commander's
  // eventual exit is never read as a launch failure.
  if (stop) setTimeout(stop, DESK_DOA_WINDOW_MS).unref?.()
}

/** The SDK arm of {@link watchDeskForDeathOnArrival} (2026-08-01).
 *
 *  WHY THIS EXISTS AT ALL. The SDK launch path armed only
 *  {@link watchSdkDeskForLimit}, and justified the missing death-watch with "an
 *  SDK session has no screen to race". That is true of ONE of the PTY watcher's
 *  three jobs. Read the corpse-learning watcher again and it does:
 *    1. SAMPLE THE SCREEN for the refusal wording — the only job a screenless
 *       runtime genuinely does not need (an SDK desk is TOLD: sdkEvents distils
 *       the CLI's refusal into a `quota_refusal` event on the session's stream);
 *    2. COOL THE TIER — `markRateLimited`, 20 persisted minutes, so the NEXT
 *       launch (the engine's resuscitation reflex fires every few minutes) does
 *       not seat another commander on the same spent tier. This is the whole
 *       point of the 2026-07-19 incident: four desks died in a row because
 *       nothing wrote the wall down;
 *    3. FORGET THE STALE SESSION POINTER for a FRESH desk — `forgetSwarmSessionIf`,
 *       so the next launch does not `--resume` a transcript whose entire content
 *       is one refusal line.
 *  Jobs 2 and 3 are runtime-agnostic — they are about the TIER and about the
 *  SESSION RECORD, neither of which knows what carried the conversation — and an
 *  SDK commander had NEITHER. The dial flipping to 'sdk' silently disabled both.
 *
 *  WHAT REPLACES THE SCREEN RACE. The `quota_refusal` event itself, inside the
 *  same {@link DESK_DOA_WINDOW_MS} birth window. No exit to wait for: on a PTY,
 *  "it exited" is the only proof that the wording was a STOP and not the desk
 *  merely printing about limits; on the SDK stream the event IS the CLI's own
 *  refusal message (matched against the SDK's exported prefix list), so there is
 *  no picture to misread. The window is still checked, for the identical reason
 *  it is checked on the PTY side: a refusal on day three is evidence about the
 *  work, not about the launch.
 *
 *  POLARITY IS NOT FORKED PER RUNTIME. `matchesQuotaExhaustion(normalizeScreen(…))`
 *  — the SAME predicate on the SAME wording list the PTY watch uses. A refusal
 *  that does not match cools NOTHING (the fail-safe direction: a missed mark
 *  costs one retry that re-learns the truth; a wrong mark parks a healthy tier).
 *
 *  MANAGER-ONLY, exactly like its PTY twin: the forget branch hardcodes the
 *  `'manager'` role. Arming this for the supply desk requires parameterising that
 *  first, or a supply DOA would forget the COMMANDER's session record.
 *
 *  Returns a detach function, or null when the session could not be subscribed
 *  to (already gone). Never throws — learning is best-effort. */
export const watchSdkDeskForDeathOnArrival = (
  sdkSessionId: string,
  tier: string,
  projectPath: string,
  agentSessionId: string,
  wasResumed: boolean,
  deps: {
    attach?: typeof attachSdkListener
    now?: () => number
    forget?: typeof forgetSwarmSessionIf
    mark?: typeof markRateLimited
  } = {},
): (() => void) | null => {
  if (!isModelTier(tier)) return null // never cool an arbitrary model string
  const nowFn = deps.now ?? Date.now
  const mark = deps.mark ?? markRateLimited
  const forget = deps.forget ?? forgetSwarmSessionIf
  const bornAt = nowFn()
  let learned = false
  /** The refusal wording, if this desk has quoted one. Remembered, NOT acted on
   *  — see the two rules below. */
  let refusal: string | null = null
  const onFrame = (f: SdkStreamFrame): void => {
    if (learned) return
    // ⚠ RULE 1: A REFUSAL IS NOT A DEATH. This watch is "learn from the CORPSE",
    // and the PTY twin gets that for free by hanging off `onTerminalExit` — it
    // cannot run before the desk is gone. The SDK stream has no such gate, and
    // the first cut fired on the refusal frame ALONE. But an SDK desk does not
    // die when it is refused: it PARKS ("The desk keeps running" —
    // sdkDeskLimit.ts) and `quota-parked` has explicit documented exits back to
    // working (sdkEvents.ts). So a live, parked commander was being treated as a
    // corpse: its tier was cooled for 20 persisted minutes across every spawn
    // path, and — far worse — the branch below DELETED THE SESSION POINTER OF A
    // CONVERSATION THAT WAS STILL RUNNING, which is the one thing that header
    // says must never happen. Remember the wording; wait for the ending.
    if (f.ev.kind === 'quota_refusal') {
      // ⚠ RULE 2: DO NOT RE-ASK THE QUESTION THE SDK ALREADY ANSWERED. This used
      // to run `matchesQuotaExhaustion(normalizeScreen(raw))` as a second gate.
      // That predicate is a PRIVATE MIRROR of Anthropic's wording, written for
      // the PTY path because pixels are all it has. Here the primary判定 is
      // Anthropic's own exported `USAGE_LIMIT_ERROR_PREFIXES` (12 entries), so
      // the second gate can only ever SUBTRACT — and measured 2026-08-01 it
      // subtracts a whole family: of six realistic refusal sentences only two
      // pass it, and every credit-exhaustion wording ("You're out of usage
      // credits…", "Fable 5 requires usage credits…", "You're out of extra
      // usage…") is silently dropped. The polarity rule the PTY twin enforces
      // with that regex ("the desk SAID the tier is spent", not "the desk died")
      // is already enforced upstream by the prefix list.
      refusal = f.ev.raw
      return
    }
    // The SDK counterpart of `onTerminalExit`: the pool announces the terminal
    // status when the pump unwinds (announceStatus, sdkSession.ts).
    if (f.ev.kind !== 'status') return
    if (f.ev.status !== 'exited' && f.ev.status !== 'failed') return
    if (refusal === null) return // it died of something else — says nothing about the tier
    try {
      if (nowFn() - bornAt > DESK_DOA_WINDOW_MS) return // it lived; this says nothing about the launch
      learned = true
      const until = mark(tier, { ptyText: refusal, now: nowFn() })
      console.warn(
        `[swarmManager] SDK 司令官卓が tier '${tier}' の枯渇で起動即死 — ` +
          `${tier} を ${new Date(until).toISOString()} まで冷却(次の起動は1段下の tier)`,
      )
      // A resumed session's transcript is real history, not just a refusal —
      // never drop the pointer to it (see watchDeskForDeathOnArrival's header).
      if (!wasResumed) {
        void forget(projectPath, 'manager', agentSessionId).catch(() => {})
      }
    } catch {
      /* learning is best-effort; a fault here must never disturb the event pump */
    }
  }
  // fromSeq 0 ⇒ replay whatever the buffer already holds, so a refusal that
  // arrived between the spawn and this call is not missed. This is also WHY the
  // caller may arm the watch after its `await`s: unlike the PTY exit callback,
  // nothing here is lost by subscribing late inside the birth window.
  const sub = (deps.attach ?? attachSdkListener)(sdkSessionId, 0, onFrame)
  if (!sub) return null
  sub.replay.forEach(onFrame)
  // Disarm once the desk has outlived the window, so a long-lived commander's
  // eventual limit is never read as a launch failure (its OWNER notice still
  // fires — that is watchSdkDeskForLimit's job, and it never expires).
  setTimeout(sub.detach, DESK_DOA_WINDOW_MS).unref?.()
  return sub.detach
}

export interface SpawnSwarmManagerOpts {
  /** The registered project to command — the commander PTY's cwd (its primary
   *  checkout). The route validates this with validateProjectPath first. */
  projectPath: string
  cols?: number
  rows?: number
  /** Force a BRAND-NEW conversation, ignoring (and overwriting) the persisted
   *  session id. The escape hatch for a restored context that has gone bad — off
   *  by default, so the normal button always resumes. */
  fresh?: boolean
}

/** Build the LaunchClaudeOpts for a commander conversation — pure + exported so
 *  the launch contract is unit-tested without spawning a PTY:
 *   - cwd = the project's PRIMARY checkout (NOT a worktree); the commander reads
 *     the repo, moves Board cards and integrates `swarm/*` branches on the trunk.
 *   - permissionMode:'bypass' — so its git + Board moves aren't gated by a
 *     tool-approval prompt on every turn (mirrors the shell `--dangerously-skip-…`).
 *   - env { SWARM_MANAGER:'1' } — TAGS the session as the swarm commander for
 *     tooling / the /manage skill. Under worker-only guard scoping this is NOT a
 *     guard opt-in: the trusted commander is unpoliced (the veto polices only the
 *     confined worker, which passes OPENGROUND_GUARD=1 + write roots instead).
 *   - appContext:true — the commander drives the Board (drain todo → review →
 *     done) through the app's HTTP API, so the app-context card is on-mission
 *     (same as supply; the worker turns it off for leanness).
 *   - model/effort/remoteControl — opus/max + Remote Control ON via the shared
 *     swarm launch default (swarmLaunch.ts), mirroring the shell commander's
 *     `--model opus --effort max … --remote-control <name>`. effort is
 *     CLAUDE_EFFORTS-guarded there. The Remote Control session name is the
 *     IDENTIFIABLE one the spawn path resolved (resolveSwarmRemoteName:
 *     「マネージャー <プロジェクト表示名>」/ "Manager <project>" per the app
 *     language) — opts.remoteName; absent (legacy caller) it falls back to the
 *     historical fixed 'manager'.
 *   - initialPrompt — `/og-manage` positional (claude runs the tmux-free
 *     commander skill on startup). */
//   - resume — when the project already has a commander conversation claude can
//     load (swarmSessions.resolveSwarmSession proved it), the SAME session id rides
//     `--resume` instead of `--session-id` (buildClaudeArgv), so the commander wakes
//     up remembering the last weeks of integration — with the re-read-the-Board
//     order above. Absent ⇒ the historical fresh-session launch, byte-for-byte.
export const managerLaunchOpts = (
  cwd: string,
  agentSessionId: string,
  opts: {
    cols?: number
    rows?: number
    resume?: boolean
    remoteName?: string
    // Settings.language, resolved by the caller. REQUIRED — not optional, no
    // default `{}` on `opts` any more — so a caller that forgets to thread it
    // through fails `tsc` instead of silently spawning a commander whose
    // replies ignore the setting (see buildOrderInjection's doc comment,
    // swarmWorker.ts, for the 2026-08-13 rework rationale).
    lang: PromptLang
  },
  // Mode-resolved model/effort (omitted ⇒ opus/max, back-compat).
  me?: { model: string; effort?: ClaudeEffort },
): LaunchClaudeOpts => ({
  cwd,
  agentSessionId,
  permissionMode: 'bypass',
  appContext: true,
  // The manager is NOT policed by the PreToolUse veto (worker-only scoping), so
  // strictMcpConfig is no longer a veto-pairing requirement here. Kept as
  // DEFENSE-IN-DEPTH: the commander boots with only its explicit MCP config (none)
  // instead of inheriting whatever user-scope MCP servers happen to be present,
  // keeping the engine-driven commander deterministic. (The confined WORKER still
  // REQUIRES strictMcpConfig — mcp__* tools bypass ITS veto; see swarmWorker.ts.)
  strictMcpConfig: true,
  // The commander is a DESK the owner talks to ("状況" / "マージ"), not an
  // unattended worker: when it stops on a spent model quota the owner's own
  // conversation is stopped, and nothing else notices (the engine's resuscitation
  // reflex only runs while the engine does). Watched by ownerDeskLimit.ts, which
  // names it by the role the owner knows it as — an account-wide exhaustion stops
  // every desk at once, so "which conversation" has to be in the message.
  ownerDesk: true,
  deskLabel: MANAGER_DESK_LABEL,
  ...swarmLaunchDefaults(opts.remoteName ?? 'manager', me),
  env: { SWARM_MANAGER: '1' },
  cols: opts.cols,
  rows: opts.rows,
  ...(opts.resume ? { resume: true } : {}),
  initialPrompt:
    (opts.resume ? MANAGER_RESUME_INJECTION : MANAGER_INJECTION) + languageDirective(opts.lang),
})

/** ONE DESK PER PROJECT, decided on the POOL (2026-07-19 incident): if a labelled
 *  commander desk is live in `projectPath`, ADOPT it — return its terminal (and
 *  repoint the session record at it) instead of building a twin. null ⇒ no desk
 *  exists, so the caller may spawn.
 *
 *  Eleven commander desks accumulated in three hours, and the duplicate-dispatcher
 *  hazard they created is the expensive part: two desks integrating one trunk is
 *  the shape of the 2026-07-15 concurrent-integration incident. The engine's
 *  presence probe was supposed to prevent this by spawning only when it reads
 *  'absent' — but 'absent' means "the PTY holding the RECORDED session id is
 *  gone", and the record is a single slot every spawn overwrites
 *  (recordSwarmSession, whose failure is deliberately swallowed). One missed
 *  write, one transient store read fault, or one spawn racing another leaves a
 *  live desk that the store no longer names — permanently invisible to presence,
 *  which then reads 'absent' and asks for another desk every five minutes,
 *  forever. The desks were never dead; they were UNADDRESSED.
 *
 *  So existence is decided where it cannot desynchronise: the PTY pool. This holds
 *  for EVERY caller (the engine's reflex and the owner's button alike), which the
 *  presence-based guard never could: the route had no such check at all, and the
 *  UI's was browser-local state.
 *
 *  …AND IT RECONCILES THE STORE ON THE WAY OUT. Refusing to spawn stops the
 *  bleeding; repointing the record at the desk that actually exists is what HEALS
 *  the desync, so presence stops reading 'absent' and the engine goes back to
 *  nudging the live desk instead of escalating 'manager-unrevivable' against it.
 *
 *  PURE with respect to the invariant: it reads the pool and writes the record,
 *  and can therefore NEVER create a second desk. That is why the timeout path in
 *  {@link spawnSwarmManager} may call it without holding the spawn lock. */
const adoptLiveDesk = async (projectPath: string): Promise<SpawnSwarmManagerResponse | null> => {
  // BOTH POOLS (2026-07-31, stage 3). `listManagerDesks` asks the PTY pool AND
  // the SDK pool, and re-confirms PTY entries against the process table — the
  // pool's `finishedAt` is stamped by an ASYNCHRONOUS onExit, so right after a
  // kill (the Restart button: DELETE the terminal, then POST a respawn) it can
  // still list a desk the OS already reaped.
  //
  // Spanning both pools is not tidiness, it is the invariant: the dial can be
  // flipped between two spawns, so a project whose commander is a live PTY and
  // whose dial now says 'sdk' would — with a PTY-only check — get an SDK desk
  // seated beside it. Two commanders integrating one trunk is exactly the
  // 2026-07-15 concurrent-integration hazard, arrived at from a new direction.
  // ⚠ A DESK ASKED TO STOP IS NOT A DESK TO REUSE (overnight review 2026-08-04,
  // cycle 3 — a regression in cycle 1's own fix). `stopping` marks a session
  // whose `closed` flag is already set: `pushSdkInput` refuses it, the engine
  // cannot nudge it, and it will never integrate anything again. Adopting one
  // returns `reused:true` for a desk that is deaf — so 停止 stuck (the earlier
  // fix) but the very next 「司令官」 press silently seated nothing, and on a
  // wedged session (which never reaps) the commander could not be relaunched at
  // all. The twin hazard this guard exists for is TWO LIVE commanders; a closed
  // one cannot be the second. Both doors — this one and getOrchestratorState's
  // published handle — now ask the same question of the same list.
  const aliveDesks = listManagerDesks(projectPath).filter((d) => !d.stopping)
  const existing = aliveDesks[0]
  if (!existing) return null
  if (aliveDesks.length > 1)
    console.warn(
      `[swarmManager] ${aliveDesks.length} live commander desks in ${projectPath} — ` +
        '本来1卓のみ。余分な卓は Terminal タブから閉じてください(自動 kill はしない)',
    )
  if (existing.agentSessionId) {
    await recordSwarmSession(projectPath, 'manager', existing.agentSessionId).catch(() => {})
  }
  return {
    terminalId: existing.runtime === 'pty' ? existing.handleId : '',
    runtime: existing.runtime,
    ...(existing.runtime === 'sdk' ? { sdkSessionId: existing.handleId } : {}),
    agentSessionId: existing.agentSessionId ?? '',
    resumed: false,
    reused: true,
  }
}

/** How long a caller waits for an in-flight commander spawn in the SAME project
 *  before giving up on the lock.
 *
 *  Sized off the critical section's own worst case, not off a round number: the
 *  slow step is `resolveSwarmModelEffortProbed`, which may probe several tiers in
 *  turn and budgets `TIER_PROBE_LAUNCH_WAIT_MS`-scale seconds for each (8s per
 *  rung), on top of a session probe, a skill install and two settings reads. 120s
 *  clears a full ladder walk with room to spare while still being a BOUND — a
 *  holder that never settles must not wedge the commander button forever. */
export const DESK_SPAWN_LOCK_WAIT_MS = 120_000

/** key = resolve(projectPath) → a promise that settles when the holder releases.
 *
 *  On globalThis so the critical section survives `tsx watch` reloads in dev —
 *  the same rule the PTY pool it guards follows (`globalThis.__openground_terminal`).
 *  A lock that reloaded while the pool did not would stop excluding anything at
 *  exactly the moment the pool still remembered the desk. */
const lockGlobal = globalThis as typeof globalThis & {
  __openground_manager_spawn_locks?: Map<string, Promise<void>>
}
const deskSpawnLocks: Map<string, Promise<void>> =
  lockGlobal.__openground_manager_spawn_locks ??
  (lockGlobal.__openground_manager_spawn_locks = new Map())

/** true ⇒ `p` settled within `ms`; false ⇒ the wait expired. Leaves no live timer
 *  behind either way, and the timer never holds the process open. */
const settledWithin = (p: Promise<void>, ms: number): Promise<boolean> =>
  new Promise((res) => {
    const timer = setTimeout(() => res(false), ms)
    timer.unref?.()
    const done = () => {
      clearTimeout(timer)
      res(true)
    }
    p.then(done, done)
  })

/** Take the project's spawn lock, waiting out any current holder. Returns the
 *  release fn (idempotent-safe: it only clears the map slot that is still OURS),
 *  or null when the wait expired. */
const acquireDeskSpawnLock = async (
  key: string,
  waitMs: number,
): Promise<(() => void) | null> => {
  const deadline = Date.now() + waitMs
  for (;;) {
    const held = deskSpawnLocks.get(key)
    if (!held) {
      // COMPARE-AND-SET. There is deliberately NO `await` between this read and
      // the write below, so on JS's single thread the pair is atomic — precisely
      // the property the old read-pool-then-launch sequence lacked.
      let release!: () => void
      const mine = new Promise<void>((r) => (release = r))
      deskSpawnLocks.set(key, mine)
      return () => {
        if (deskSpawnLocks.get(key) === mine) deskSpawnLocks.delete(key)
        release()
      }
    }
    if (!(await settledWithin(held, Math.max(0, deadline - Date.now())))) return null
    // The holder released — loop and re-test. Several waiters wake together and
    // only one wins the compare-and-set above; the losers simply wait again.
  }
}

/** Launch ONE interactive claude PTY in the project's primary checkout running
 *  the `/og-manage` skill (handed positionally so claude submits it on startup).
 *  Subscription-only (launchClaude — never `claude -p`/the SDK). Returns as soon
 *  as the PTY is up; claude boots and invokes /manage on its own. No worktree is
 *  created, so there is nothing to clean up on stop — the caller just kills the
 *  PTY. */
export const spawnSwarmManager = async (
  opts: SpawnSwarmManagerOpts,
): Promise<SpawnSwarmManagerResponse> => {
  // ── ONE SPAWN AT A TIME, per project: the check-then-act is a CRITICAL SECTION ──
  //
  // {@link adoptLiveDesk} decides existence on the pool, which cannot desynchronise
  // from itself — but reading it is only half the guard. Between that read and the
  // `launchClaude` that finally puts a desk INTO the pool sit four awaits (the
  // session probe, the skill install, two settings reads, and the tier probe, which
  // alone can spend tens of seconds walking the ladder). Two callers arriving inside
  // that window both read "no desk" and both spawn: a textbook check-then-act with
  // no lock.
  //
  // The two callers are independent BY CONSTRUCTION — the engine's resuscitation
  // reflex (swarmOrchestrator, on its own timer) and the owner's 司令官 button
  // (POST /api/swarm/manager) — and they run in the SAME Node process, so "truly
  // simultaneous" only requires landing in the same event-loop window, not the same
  // microsecond. The 2026-07-19 eleven-desk incident was the SEQUENTIAL form of this
  // (five minutes apart, where the pool read alone was enough); this is the
  // concurrent form, and it is closed by making the whole check-then-act atomic
  // with respect to other spawns of the SAME project.
  //
  // Keyed by `resolve(projectPath)` — EXACTLY the identity `listLiveDesksIn` uses to
  // decide whether a desk is "in this project" (it compares `resolve(d.cwd)`), so
  // the lock is never coarser or finer than the check it guards. Different projects
  // never wait on each other.
  //
  // Serialised, NOT coalesced: the second caller re-runs the check after the first
  // finishes rather than inheriting its result, so its answer still comes from the
  // pool (the authority) — it gets `reused:true` naming the desk that now exists,
  // and a first caller that FAILED does not poison it into failing too.
  //
  // `fresh` does NOT bypass any of this. It means "do not resume the persisted
  // conversation", which is a question about WHICH conversation a new desk opens —
  // not a licence to run two. An owner replacing a wedged desk stops it from the
  // Terminal tab first; the engine must never have that power (auto-killing a desk
  // in the repo's own cwd is the one thing 03 §2.3 rules out, because the owner's
  // own sessions live there too).
  const release = await acquireDeskSpawnLock(resolve(opts.projectPath), DESK_SPAWN_LOCK_WAIT_MS)
  if (!release) {
    // Waited out a holder that never settled. Falling through to spawn anyway is
    // the one thing we must not do — that is the twin this guard exists to
    // prevent. If the wedged holder already got its PTY up, ADOPT it (a pool read
    // + record write can never build a desk); otherwise refuse, and let the caller
    // decide: the engine's wakeManager reads a throw as "retry next pass", and the
    // owner's button surfaces it instead of quietly seating a second commander.
    const adopted = await adoptLiveDesk(opts.projectPath)
    if (adopted) return adopted
    throw new Error(
      `commander spawn already in flight for ${opts.projectPath} ` +
        `(waited ${DESK_SPAWN_LOCK_WAIT_MS}ms) — refusing to open a second 司令官 desk`,
    )
  }
  try {
    const adopted = await adoptLiveDesk(opts.projectPath)
    if (adopted) return adopted
    return await launchNewDesk(opts)
  } finally {
    release()
  }
}

/** The spawn half of {@link spawnSwarmManager}, split out so the critical section
 *  it must run inside is a single `try`/`finally` at the call site rather than a
 *  release scattered down every exit path. NEVER call this without holding the
 *  project's spawn lock. */
const launchNewDesk = async (
  opts: SpawnSwarmManagerOpts,
): Promise<SpawnSwarmManagerResponse> => {
  // RESUME the project's previous commander conversation whenever claude can still
  // load it (swarmSessions.ts) — the commander is a days-long integration desk, not
  // a disposable worker, and an OPEN GROUND restart (i.e. every release) used to
  // wipe it. Fail-open: any doubt about the persisted session (gone, corrupt, still
  // open in a live PTY, project moved) and it opens a fresh one instead — the desk
  // always launches. `fresh` skips the lookup outright (and overwrites the record
  // below): the owner's way out of a restored context that has gone bad.
  const session = opts.fresh
    ? { agentSessionId: randomUUID(), resume: false }
    : await resolveSwarmSession(opts.projectPath, 'manager')
  // Self-repair the /og-manage skill RIGHT BEFORE launch (idempotent, best-
  // effort): the boot-time install covers the normal path, but a skill deleted
  // mid-session — or a dev server that booted before the skill shipped — would
  // otherwise hand claude a slash command that resolves to nothing. A
  // user-authored file (managed-by marker removed) is still never overwritten,
  // and a failure never blocks the spawn (the commander then just reports the
  // missing skill conversationally).
  //
  // …AND THE BEST-EFFORT-NESS IS NOW VISIBLE (adversarial review 2026-07-19,
  // MUST-FIX 2). This install is the ONLY thing carrying the commander's half of
  // the review protocol — this card's specialist clauses AND the pre-existing
  // fail-CLOSED gate — from the repo to the desk that actually integrates. Two
  // outcomes leave the desk on a STALE copy:
  //   • 'kept-user' — the managed-by marker was removed, so it is never updated again.
  //   • 'error'     — source unreadable (e.g. a worktree-resident engine whose
  //                   resolveHookSourceRoot refuses to hand over a source root).
  // Neither blocks the spawn — that stays deliberate (a commander on an old skill
  // still beats no commander) — but they must not be SILENT, which they were:
  // the return value was discarded and `.catch(() => {})` swallowed the rest.
  // The repo-side pins (ogManageSkill.test.ts) hold 定数 ↔ repo SKILL.md; they do
  // NOT hold repo ↔ running desk. This log is the only seam where that gap is
  // observable, so the asymmetry is findable instead of inferred after the fact.
  const skill = await installOgManageSkill().catch((e) => ({
    outcome: 'error' as const,
    path: '(unresolved)',
    error: String(e),
  }))
  if (skill.outcome === 'error' || skill.outcome === 'kept-user') {
    console.warn(
      `[swarmManager] og-manage skill NOT refreshed (${skill.outcome}) at ${skill.path}` +
        `${skill.error ? `: ${skill.error}` : ''} — ` +
        '司令官は旧 SKILL.md で統合する(専門レビュアー条項・fail-CLOSED 条項を欠く可能性)',
    )
  }
  // Token budget (card 68d8e00f): economy runs the commander on sonnet; optimize keeps
  // it on the top tier (its integration / safety-review judgment is quality-critical).
  // Null ⇒ the owner switched every tier OFF: no model, no spawn (fail-CLOSED — the
  // commander is a claude PTY like any other and honors the same hard mask).
  // PROBED (2026-07-13): the 2026-07-13 burn was exactly THIS path — a commander
  // seated on a fable whose tier-local wall /usage could not show. One collapsed
  // headless probe (swarmTierProbe) now confirms the tier before the desk spawns;
  // wall ⇒ it cools (disk-mirrored) and the walk seats the commander one rung down.
  const me = await resolveSwarmModelEffortProbed(
    await getExecutionMode(),
    'manager',
    undefined,
    Date.now(),
    await getAllowedModelTiers(),
  )
  if (!me) throw new NoAllowedModelTierError()
  // Remote Control 名の識別化: 「マネージャー <プロジェクト表示名>」/ "Manager
  // <project>"(言語は Settings.language、表示名は registry の displayName ||
  // フォルダ名)。resolveSwarmRemoteName は never-throws — 解決に失敗しても旧固定名
  // 'manager' で spawn は通る。
  // ── RUNTIME FORK (stage 3) ──────────────────────────────────────────────────
  // Everything above this line is runtime-agnostic and must stay that way: the
  // session resume decision, the skill self-repair, the tier probe and the hard
  // model mask apply to a commander whatever carries it. Only the SPAWN differs.
  //
  // The dial is read here rather than passed in, so the engine's resuscitation
  // reflex and the owner's button can never disagree about which runtime this
  // project's commander uses. Since 2026-08-02 an ABSENT dial is an SDK desk;
  // an explicit 'pty' and any unrecognised MODE VALUE are a PTY.
  //
  // The dial's FILE-level behaviour — an unreadable / unparseable settings.json,
  // and when the `.catch` below actually fires — is documented in ONE place:
  // store.getManagerRuntimeDial. Do not restate it here.
  const dial = await getManagerRuntimeDial().catch(() => ({ mode: 'pty' as const }))
  // Settings.language ⇒ the commander's user-facing replies follow it — resolved
  // once and threaded into both the SDK and PTY launch paths below.
  const lang = await getPromptLang()
  if (dial.mode === 'sdk') {
    // FAIL-FAST (2026-08-13, with the worker fallback's deletion): an SDK dial
    // either seats an SDK desk or THROWS SdkManagerUnavailableError — the
    // silent DEGRADE-to-PTY that used to live here is gone. The reason: an
    // invisible degrade looks exactly like a switch that does not work, and a
    // fallback that absorbs real breakage keeps it broken forever. The PTY
    // launch below is now reachable ONLY from an explicit 'pty' dial (or the
    // unreadable-file fail-closed path) — it is the manual kill switch, not a
    // safety net. Callers already carry the failure: the 司令官 button's route
    // answers 500 with the reason, and the engine's resurrection reflex reads a
    // wakeManager throw as a failed attempt (grace → 3-strike fatal bell →
    // 30-min re-arm — its own backoff-and-bell, no new machinery needed).
    return await launchSdkDesk(opts, session, me, lang)
  }
  const remoteName = await resolveSwarmRemoteName('manager', opts.projectPath)
  const ref = launchClaude(
    managerLaunchOpts(
      opts.projectPath,
      session.agentSessionId,
      { cols: opts.cols, rows: opts.rows, resume: session.resume, remoteName, lang },
      me,
    ),
  )
  // Arm the death-watch BEFORE anything else can await: a tier this dry refuses in
  // 1.4–3.8s (measured 2026-07-19), which is well inside the store write below.
  watchDeskForDeathOnArrival(
    ref.terminalId,
    me.model,
    opts.projectPath,
    session.agentSessionId,
    session.resume,
  )
  // Persist for the NEXT boot. Best-effort by design: a failed write only costs the
  // commander its memory on the following launch (it starts fresh — the old
  // behaviour), and must NEVER turn a successfully-spawned PTY into a 500.
  await recordSwarmSession(opts.projectPath, 'manager', session.agentSessionId).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[swarmManager] could not persist the commander session id: ${String(e)}`)
  })
  return {
    terminalId: ref.terminalId,
    runtime: 'pty',
    agentSessionId: session.agentSessionId,
    resumed: session.resume,
  }
}

/** Spawn the commander on the Agent SDK runtime, or THROW
 *  {@link SdkManagerUnavailableError} when it cannot be established.
 *
 *  ⚠ THIS USED TO DEGRADE INSTEAD OF THROW (until 2026-08-13): every failure
 *  below returned `{ fellBackBecause }` and the caller seated a PTY desk, on
 *  the theory that "a PTY commander beats no commander". That fallback died
 *  with the worker's: it absorbed real breakage so quietly that a broken SDK
 *  runtime looked like a switch that does not work. Now the failure is LOUD
 *  and the retry is the caller's: the route answers 500 with the reason, and
 *  the engine's resurrection reflex counts a failed wake (grace → 3-strike
 *  'manager-unrevivable' bell → 30-min re-arm) until the machine recovers.
 *  The PTY commander still exists — behind the EXPLICIT dial only.
 *
 *  What is deliberately NOT here, compared with the PTY branch:
 *   - no Remote Control (the flag is inert outside a REPL — the supply desk is
 *     the owner's phone window instead);
 *   - no SCREEN SAMPLING in the death-on-arrival watch. ⚠ This bullet used to say
 *     "no death-on-arrival watch" outright, and that was wrong (fixed 2026-08-01):
 *     the PTY watcher has THREE jobs and only the first — sampling the screen for
 *     the refusal wording and racing the exit — is a picture-reading workaround an
 *     SDK session does not need. Cooling the spent TIER and forgetting the stale
 *     SESSION POINTER are about the tier and the session record, not about how the
 *     conversation was carried, and an SDK commander was getting NEITHER. Both are
 *     armed below via {@link watchSdkDeskForDeathOnArrival}, driven by the
 *     session's own `quota_refusal` event instead of a screen race. */
const launchSdkDesk = async (
  opts: SpawnSwarmManagerOpts,
  session: { agentSessionId: string; resume: boolean },
  me: { model: string; effort?: ClaudeEffort },
  lang: PromptLang,
): Promise<SpawnSwarmManagerResponse> => {
  const pre = sdkManagerPreflight()
  if (!pre.ok || !pre.claudeBin) {
    throw new SdkManagerUnavailableError(
      pre.problems.length ? pre.problems : ['no claude binary resolved for the SDK commander'],
    )
  }
  const plan = sdkManagerLaunchPlan({
    projectPath: opts.projectPath,
    agentSessionId: session.agentSessionId,
    resume: session.resume,
    me,
    claudeBin: pre.claudeBin,
    lang,
  })
  for (const w of plan.warnings) console.warn(`[swarmManager] ${w}`)
  // The SDK is ESM-only and this runs from a CJS bundle in the packaged app, so
  // the module has to be imported BEFORE the synchronous spawn below — see
  // sdkSession.preloadSdk. A load failure is reported by the spawn as a failed
  // session, which the `status === 'failed'` check further down already turns
  // into a throw, so nothing is caught here.
  const sdkReady = await preloadSdk()
  let sdkSession: SdkSessionInfo
  try {
    sdkSession = spawnSdkSession({
      cwd: opts.projectPath,
      role: 'manager',
      agentSessionId: session.agentSessionId,
      options: plan.options,
      initialPrompt: plan.initialPrompt,
      sdk: sdkReady,
    })
  } catch (e) {
    throw new SdkManagerUnavailableError([
      `SDK spawn failed (${String((e as Error)?.message ?? e).slice(0, 200)})`,
    ])
  }
  // A session that died inside spawnSdkSession (the SDK threw while building the
  // query) reports 'failed' synchronously. Treat it exactly like a preflight
  // miss: throw rather than recording a session id for a conversation that does
  // not exist.
  if (sdkSession.status === 'failed') {
    throw new SdkManagerUnavailableError([
      `the SDK session died at start (${sdkSession.exitReason ?? 'unknown'})`,
    ])
  }
  // The model-limit watch, wired at the SOURCE instead of on a sampling timer:
  // the CLI's refusal arrives as an event on this session's own stream, so there
  // is nothing to poll and no false-positive class to guard against.
  watchSdkDeskForLimit({
    sdkSessionId: sdkSession.id,
    cwd: opts.projectPath,
    deskLabel: MANAGER_DESK_LABEL,
  })
  await recordSwarmSession(opts.projectPath, 'manager', session.agentSessionId).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[swarmManager] could not persist the commander session id: ${String(e)}`)
  })
  // LEARN FROM THE CORPSE, SDK arm (2026-08-01) — cool a tier that refuses on
  // arrival, and drop the one-line-refusal session pointer for a FRESH desk.
  // Armed AFTER the record on purpose, and this ordering is only safe because the
  // watch replays the session buffer from seq 0: nothing that arrived during the
  // await is lost, and the forget can no longer race the write it is meant to
  // undo (the PTY arm has to arm first, and lives with that race, because a PTY
  // exit callback has no replay).
  watchSdkDeskForDeathOnArrival(
    sdkSession.id,
    me.model,
    opts.projectPath,
    session.agentSessionId,
    session.resume,
  )
  return {
    // EMPTY by the identity invariant — an SDK desk has no terminal.
    terminalId: '',
    runtime: 'sdk',
    sdkSessionId: sdkSession.id,
    agentSessionId: session.agentSessionId,
    resumed: session.resume,
  }
}
