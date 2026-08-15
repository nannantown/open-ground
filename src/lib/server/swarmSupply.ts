// swarmSupply — the in-app, tmux-free replacement for the shell swarm's
// `swarm-supply.sh`. It is the "supply officer (補給官)" primitive of the OPEN
// GROUND swarm port (docs / auto-memory project_inapp_swarm_port): the user's
// CONVERSATION DESK. Given a registered project it launches ONE interactive
// `claude` PTY in the project's PRIMARY checkout running the `/supply` skill.
//
// TWO duties, and the second one is why this desk must STAY a PTY:
//   1. INTAKE — listen to the user's vague requests, sharpen each into an
//      OBSERVABLE task, file it into the Board `todo` column (Board HTTP API).
//   2. STATUS (2026-07-31) — answer 「今どうなってる?」 by READING the swarm:
//      GET /api/swarm/workers + /api/swarm/orchestrator + /api/project +
//      the escalation inbox, reported in plain, non-programmer Japanese. Read
//      only: it never dispatches, merges, moves a column past `todo`, or
//      switches the engine — those stay the commander's.
//
// WHY DUTY 2 LIVES HERE. This desk is the OWNER'S PHONE WINDOW: it is launched
// with Remote Control ON under an identifiable name (「タスク窓口 <project>」), so
// it is the one desk reachable from claude.ai / a phone. The COMMANDER can now
// run on the Agent SDK runtime, which has no terminal and therefore no Remote
// Control — so if this desk could only take orders, the owner would keep phone
// ORDERING and lose phone MONITORING. Duty 2 closes that, and is the stated
// precondition for moving the commander off the PTY at all
// (docs/SDK_CLIENT_INVESTIGATION.md §13-A, SDK_WORKER_MIGRATION_PLAN.md §14).
//
// Unlike a WORKER (swarmWorker.ts) the supply officer gets NO worktree: it
// operates on the primary checkout — it only READS the repo + writes the
// recoverable Board, never editing code or pushing. So there is nothing to tear
// down on stop; stopping it is a plain PTY kill (the terminal DELETE route).
//
// This mirrors `swarm-supply.sh` exactly:
//   exec env SWARM_MANAGER=1 claude --model opus --effort max \
//        --dangerously-skip-permissions --remote-control supply "/supply"
//   - SWARM_MANAGER=1 — TAGS the session as the supply officer (for tooling / the
//     /supply skill). Under WORKER-ONLY guard scoping (2026-07) this is NOT a guard
//     opt-in: like the commander, the supply desk is a TRUSTED session (it only
//     READS the repo + writes the recoverable Board), so the PreToolUse veto —
//     which polices only the confined worker — does not apply to it.
//   - bypass (--dangerously-skip-permissions) — the desk writes Board cards
//     unattended-style so the conversation isn't interrupted by a tool-approval
//     prompt on every `swarm-board.sh add`; its safety net is the human, not the veto.
//   - opus / max — the supply officer is a PM translating intent into precise,
//     observable tasks; it runs at full capability (mirrors the shell launcher).
//   - /supply as claude's POSITIONAL prompt — claude runs the skill on startup,
//     then stays interactive for the conversation. (A TUI-injected slash command
//     would not submit — the same delivery fix swarmWorker documents for /order.)
// Subscription-only: launchClaude drives the user's `claude` CLI, never
// `claude -p` / the SDK.

import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { launchClaude, type LaunchClaudeOpts } from './claudeTerminal'
import { killTerminal, listLiveDesksIn, isTerminalProcessAlive } from './terminal'
import {
  acquireDeskSpawnLock,
  deskSpawnLockKey,
  DESK_SPAWN_LOCK_WAIT_MS,
} from './deskSpawnLock'
import {
  swarmLaunchDefaults,
  resolveSwarmModelEffortProbed,
  resolveSwarmRemoteName,
} from './swarmLaunch'
import { NoAllowedModelTierError } from './swarmAllowedModels'
import { resolveSwarmSession, recordSwarmSession } from './swarmSessions'
import { getExecutionMode, getAllowedModelTiers } from './store'
import { getPromptLang, languageDirective, type PromptLang } from './promptLang'
import type { ClaudeEffort } from '../types'
import { type SpawnSwarmSupplyResponse } from '../types'

/** The skill the supply session runs, handed to claude as its positional prompt
 *  (claude submits it on startup; a TUI-injected slash command would not). */
export const SUPPLY_INJECTION = '/supply'

/** The positional prompt for a RESUMED supply desk (swarmSessions.ts): the same
 *  `/supply` skill, plus the one thing a restored conversation must be told —
 *  its memory of the Board is STALE. The desk was last awake before an app
 *  restart, and in the meantime the commander may have dispatched, merged or
 *  closed the very cards it remembers filing, so anything it "knows" about the
 *  queue is a guess. Re-reading the Board before filing is also the standing
 *  house rule for this role (積む前に必ず現状調査): a supply officer working from
 *  stale memory files duplicates of work that already shipped.
 *
 *  ONE LINE, on purpose — the same hard-won delivery contract buildOrderInjection
 *  (swarmWorker.ts) documents: the whole thing must land as a SINGLE slash-command
 *  argument. A multi-line positional risks being split, or collapsed into a
 *  `[Pasted text]` chip where `/supply` is never parsed as a command at all. */
export const SUPPLY_RESUME_INJECTION =
  '/supply セッション再開: アプリ再起動をまたいで前回の会話を復元した。あなたの記憶は古い — 前回以降に司令官が配車・統合・完了させたカードがある。新しいカードを積む前に、まず Board の現状(todo/doing/review)を API で読み直し、既に実装済み・重複・前提が変わったタスクを積まないこと。読み直した結果を1行で報告してから待機する。'

export interface SpawnSwarmSupplyOpts {
  /** The registered project to feed — the supply PTY's cwd (its primary
   *  checkout). The route validates this with validateProjectPath first. */
  projectPath: string
  cols?: number
  rows?: number
  /** Force a BRAND-NEW conversation, ignoring (and overwriting) the persisted
   *  session id. The escape hatch for a desk whose restored context has gone bad
   *  — off by default, so the normal button always resumes. */
  fresh?: boolean
}

/** Build the LaunchClaudeOpts for a supply session — pure + exported so the
 *  launch contract is unit-tested without spawning a PTY:
 *   - cwd = the project's PRIMARY checkout (NOT a worktree); supply reads the
 *     repo + writes the Board, it never branches.
 *   - permissionMode:'bypass' — so board writes aren't gated by a tool-approval
 *     prompt on every turn (mirrors swarm-supply.sh's --dangerously-skip-…).
 *   - env { SWARM_MANAGER:'1' } — TAGS the session as the supply officer for
 *     tooling / the /supply skill. Under worker-only guard scoping this is NOT a
 *     guard opt-in: the trusted supply desk is unpoliced (the veto polices only the
 *     confined worker, which passes OPENGROUND_GUARD=1 + write roots instead).
 *   - appContext:true — supply's whole job is writing Board cards, so the
 *     app-context card (board API + "track on the Board, not an internal todo")
 *     is exactly on-mission (the worker turns it off for leanness; supply keeps it).
 *   - model/effort/remoteControl — opus/max + Remote Control ON via the shared
 *     swarm launch default (swarmLaunch.ts), mirroring the shell supply officer's
 *     `--model opus --effort max … --remote-control <name>`. effort is
 *     CLAUDE_EFFORTS-guarded there. The Remote Control session name is the
 *     IDENTIFIABLE one the spawn path resolved (resolveSwarmRemoteName:
 *     「タスク窓口 <プロジェクト表示名>」/ "Supply officer <project>" per the app
 *     language) — opts.remoteName; absent (legacy caller) it falls back to the
 *     historical fixed 'supply'.
 *   - initialPrompt — `/supply` positional (claude runs the skill on startup). */
//   - resume — when the project already has a supply conversation claude can load
//     (swarmSessions.resolveSwarmSession proved it), the SAME session id rides
//     `--resume` instead of `--session-id` (buildClaudeArgv) and the desk wakes up
//     with its memory intact, plus the stale-Board warning above. Absent ⇒ the
//     historical fresh-session launch, byte-for-byte.
export const supplyLaunchOpts = (
  cwd: string,
  agentSessionId: string,
  opts: {
    cols?: number
    rows?: number
    resume?: boolean
    remoteName?: string
    // Settings.language, resolved by the caller. REQUIRED — not optional, no
    // default `{}` on `opts` any more — so a caller that forgets to thread it
    // through fails `tsc` instead of silently spawning a supply desk whose
    // replies ignore the setting (2026-08-13 rework rationale — see
    // buildOrderInjection's doc comment, swarmWorker.ts). NOTE (M2, same
    // rework): the `/supply` skill body itself instructs 日本語 replies
    // regardless of this directive — see skills/supply/SKILL.md and the
    // rework commit for the open gap this does NOT close.
    lang: PromptLang
  },
  // Mode-resolved model/effort (omitted ⇒ opus/max, back-compat).
  me?: { model: string; effort?: ClaudeEffort },
): LaunchClaudeOpts => ({
  cwd,
  agentSessionId,
  permissionMode: 'bypass',
  appContext: true,
  // Supply is NOT policed by the PreToolUse veto (worker-only scoping), so
  // strictMcpConfig is no longer a veto-pairing requirement here. Kept as
  // DEFENSE-IN-DEPTH: the supply desk boots with only its explicit MCP config
  // (none) instead of inheriting user-scope MCP servers. (The confined WORKER
  // still REQUIRES strictMcpConfig — mcp__* tools bypass ITS veto.)
  strictMcpConfig: true,
  // A DESK the owner talks to (フワッとした要望 → Board カード), not an unattended
  // worker: a model-limit stop here stops the owner's own conversation. Watched by
  // ownerDeskLimit.ts, which names it by the role the owner knows it as.
  ownerDesk: true,
  deskLabel: SUPPLY_DESK_LABEL,
  ...swarmLaunchDefaults(opts.remoteName ?? 'supply', me),
  env: { SWARM_MANAGER: '1' },
  cols: opts.cols,
  rows: opts.rows,
  ...(opts.resume ? { resume: true } : {}),
  initialPrompt:
    (opts.resume ? SUPPLY_RESUME_INJECTION : SUPPLY_INJECTION) + languageDirective(opts.lang),
})

/** Launch ONE interactive claude PTY in the project's primary checkout running
 *  the `/supply` skill (handed positionally so claude submits it on startup).
 *  Subscription-only (launchClaude — never `claude -p`/the SDK). Returns as soon
 *  as the PTY is up; claude boots and invokes /supply on its own. No worktree is
 *  created, so there is nothing to clean up on stop — the caller just kills the
 *  PTY.
 *
 *  RESUMES the project's previous supply conversation whenever claude can still
 *  load it (swarmSessions.ts) — the desk is a days-long conversation, not a
 *  disposable worker, so an app restart must not wipe its memory. Fail-open: any
 *  doubt about the persisted session (gone, corrupt, still open, project moved)
 *  and it opens a fresh one instead. The desk always launches. */
/** The supply desk's PTY label — the pool-side identity every desk-discovery
 *  read keys on (the supply twin of MANAGER_DESK_LABEL). Exported (2026-08-03)
 *  because getOrchestratorState now surfaces the live desk to the UI, and a
 *  second literal there would drift from this one. */
export const SUPPLY_DESK_LABEL = '補給官'

/** Stop every live supply desk in the project. Lives HERE — the module that
 *  owns the desk and its PTY-by-design status — so the route layer never has
 *  to reach into the PTY pool directly (the import boundary exists precisely
 *  to stop that reach; this module is on its exemption list WITH the reason).
 *  Returns the ids it asked to die (kill is fire-and-forget by pool contract). */
export const stopSwarmSupplyDesks = (projectPath: string): string[] => {
  const desks = listLiveDesksIn(projectPath, SUPPLY_DESK_LABEL)
  for (const d of desks) killTerminal(d.id)
  return desks.map((d) => d.id)
}

/** Every supply desk in `projectPath` that is REALLY there, newest first.
 *
 *  ⚠ THE `isTerminalProcessAlive` RE-CONFIRMATION IS THE POINT, and it is the
 *  supply twin of the commander's `.filter(d => !d.stopping)` — same defect,
 *  different pool. A desk asked to stop is not a desk to reuse: the pool stamps
 *  `finishedAt` from an ASYNCHRONOUS onExit, so for a moment after a kill it
 *  still lists a PTY the OS already reaped. Adopting one returns `reused:true`
 *  for a desk that is gone, which is how the commander's Restart button (DELETE
 *  then immediately POST) once handed back a dead pane instead of a new desk.
 *  `getOrchestratorState` already asks this exact question of this exact list
 *  before it PUBLISHES the supply handle; the spawn gate must ask the same one,
 *  or the two doors disagree about whether a desk exists.
 *
 *  (Supply has no `stopping` flag to filter on — that notion belongs to the SDK
 *  pool, and this desk is PTY-only by design, so one pool read is the whole
 *  answer. The process table is what stands in for it.) */
const listAliveSupplyDesks = (projectPath: string) =>
  listLiveDesksIn(projectPath, SUPPLY_DESK_LABEL).filter((d) => isTerminalProcessAlive(d.id))

/** A live supply desk to hand back INSTEAD of launching, or null.
 *
 *  PURE with respect to the invariant, exactly like swarmManager's adoptLiveDesk:
 *  it reads the pool and writes the session record, and can therefore NEVER
 *  create a second desk. That is why the lock-timeout path below may call it
 *  without holding the lock. */
const adoptLiveSupplyDesk = async (
  projectPath: string,
): Promise<SpawnSwarmSupplyResponse | null> => {
  const alive = listAliveSupplyDesks(projectPath)
  const existing = alive[0]
  if (!existing) return null
  if (alive.length > 1)
    console.warn(
      `[swarmSupply] ${alive.length} live supply desks in ${projectPath} — ` +
        '本来1卓のみ。余分な卓は Terminal タブから閉じてください(自動 kill はしない)',
    )
  // Re-point the project's single session slot at the desk that ACTUALLY
  // exists. Without this the store can keep naming a conversation nobody is
  // sitting at, which is how the desk's memory gets orphaned rather than
  // resumed. Best-effort: never turn an adoption into a failure.
  if (existing.agentSessionId) {
    await recordSwarmSession(projectPath, 'supply', existing.agentSessionId).catch(() => {})
  }
  return {
    terminalId: existing.id,
    agentSessionId: existing.agentSessionId ?? '',
    // Nothing was RESUMED — no `claude --resume` ran. The desk was already up.
    resumed: false,
    reused: true,
  }
}

export const spawnSwarmSupply = async (
  opts: SpawnSwarmSupplyOpts,
): Promise<SpawnSwarmSupplyResponse> => {
  // ── ONE SUPPLY DESK PER PROJECT: the check-then-act is a CRITICAL SECTION ──
  //
  // This guard did not exist until 2026-08-15. Until then the ONLY thing between
  // the owner and two 補給官 PTYs was a client-side `if (supply || supplyBusy)
  // return` in the Swarm tab — which is not a guard, it is one window's opinion.
  // The Board's front-desk seat is a SECOND door onto the same desk, and two
  // doors is what turns a latent race into a routine one.
  //
  // What a second spawn actually costs (swarmSessions.ts states it outright):
  // `resolveSwarmSession` refuses to resume a conversation it can see is still
  // open, so the second call mints a FRESH session id and `recordSwarmSession`
  // OVERWRITES the project's single stored slot with it. The first desk's
  // days-long conversation is not skipped, it is FORGOTTEN — while its PTY keeps
  // running, keeps holding Remote Control's identifiable name, and keeps filing
  // Board cards that its twin cannot see it filing (the /supply dedupe rule is
  // "re-read the Board before filing", which cannot see a sibling's UN-filed
  // intent). That `stopSwarmSupplyDesks` above is written in the PLURAL is the
  // tell that this has always been possible.
  //
  // Serialised, NOT coalesced (same stance as the commander): the second caller
  // re-runs the pool check after the first releases, so its answer comes from
  // the pool rather than being inherited from a call that may have failed.
  //
  // `fresh` does NOT bypass this. It means "do not resume the persisted
  // conversation" — a question about WHICH conversation a new desk opens, never
  // a licence to run two. An owner replacing a wedged desk stops it first
  // (POST /api/swarm/supply/stop, which also clears supplyDesired).
  const release = await acquireDeskSpawnLock(
    deskSpawnLockKey('supply', resolve(opts.projectPath)),
    DESK_SPAWN_LOCK_WAIT_MS,
  )
  if (!release) {
    // Waited out a holder that never settled. Falling through to spawn anyway is
    // the one thing we must not do — that is the twin this guard exists to
    // prevent. If the wedged holder already got its PTY up, ADOPT it (a pool read
    // + record write can never build a desk); otherwise refuse and let the caller
    // surface it, rather than quietly seating a second front desk.
    const adopted = await adoptLiveSupplyDesk(opts.projectPath)
    if (adopted) return adopted
    throw new Error(
      `supply spawn already in flight for ${opts.projectPath} ` +
        `(waited ${DESK_SPAWN_LOCK_WAIT_MS}ms) — refusing to open a second 補給官 desk`,
    )
  }
  try {
    const adopted = await adoptLiveSupplyDesk(opts.projectPath)
    if (adopted) return adopted
    return await launchNewSupplyDesk(opts)
  } finally {
    release()
  }
}

/** The spawn half of {@link spawnSwarmSupply}, split out so the critical section
 *  it must run inside is a single `try`/`finally` at the call site rather than a
 *  release scattered down every exit path (the shape swarmManager settled on).
 *  NEVER call this without holding the project's supply spawn lock. */
const launchNewSupplyDesk = async (
  opts: SpawnSwarmSupplyOpts,
): Promise<SpawnSwarmSupplyResponse> => {
  // `fresh` skips the lookup entirely (and overwrites the record below) — the
  // owner's way out of a restored context that has gone bad.
  const session = opts.fresh
    ? { agentSessionId: randomUUID(), resume: false }
    : await resolveSwarmSession(opts.projectPath, 'supply')
  // Token budget (card 68d8e00f): economy/optimize run the supply officer on sonnet.
  // Null ⇒ every tier switched OFF: no model, no spawn (the same hard mask every
  // other swarm role obeys — fail-CLOSED). Checked BEFORE we record anything, so a
  // refused launch never leaves a session id pointing at a conversation that
  // does not exist.
  // PROBED (2026-07-13): same pre-launch wall check as every other spawn path —
  // an UNKNOWN tier gets one collapsed headless probe before the desk is seated
  // on it (swarmTierProbe); wall ⇒ cool + one rung down, unknown ⇒ fail-open.
  const me = await resolveSwarmModelEffortProbed(
    await getExecutionMode(),
    'supply',
    undefined,
    Date.now(),
    await getAllowedModelTiers(),
  )
  if (!me) throw new NoAllowedModelTierError()
  // Remote Control 名の識別化: 「タスク窓口 <プロジェクト表示名>」/ "Supply officer
  // <project>"(言語は Settings.language、表示名は registry の displayName ||
  // フォルダ名)。resolveSwarmRemoteName は never-throws — 解決に失敗しても旧固定名
  // 'supply' で spawn は通る。
  const remoteName = await resolveSwarmRemoteName('supply', opts.projectPath)
  // Settings.language ⇒ the supply officer's user-facing replies follow it.
  const lang = await getPromptLang()
  const ref = launchClaude(
    supplyLaunchOpts(
      opts.projectPath,
      session.agentSessionId,
      { cols: opts.cols, rows: opts.rows, resume: session.resume, remoteName, lang },
      me,
    ),
  )
  // Persist for the NEXT boot. Best-effort by design: a failed write only costs the
  // desk its memory on the following launch (it starts fresh — the old behaviour),
  // and must NEVER turn a successfully-spawned PTY into a 500.
  await recordSwarmSession(opts.projectPath, 'supply', session.agentSessionId).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[swarmSupply] could not persist the supply session id: ${String(e)}`)
  })
  return {
    terminalId: ref.terminalId,
    agentSessionId: session.agentSessionId,
    resumed: session.resume,
  }
}
