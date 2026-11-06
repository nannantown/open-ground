// The project president: one conversation desk in the primary checkout.
// It sharpens owner requests into Board cards and reads company status.
// Claude retains its existing interactive PTY and Remote Control. Selecting
// ChatGPT launches an explicit supply-role session in the structured SDK pool,
// using the owner's separately authorized ChatGPT plan and host-owned tools.
// Spawn locking, adoption and stop cover both pools, so a provider switch never
// starts two presidents. Conversations have separate provider-specific slots.
// OPEN GROUND's phone/assistant relay addresses either desk through the same
// durable delivery queue and append-only owner/president transcript.

import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { launchClaude, type LaunchClaudeOpts } from './claudeTerminal'
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
import { listLiveSupplyDesks, stopSupplyDesk, SUPPLY_DESK_LABEL } from './swarmSupplyRuntime'
import { spawnSdkSession, terminateSdkSession } from './sdkSession'
import { selectedRuntime, chatGptLaunchConfig } from './chatgptRuntime'
import { assertSwarmRuntimeAdmission, trackSwarmRuntimeLaunch, type SwarmRuntimeHandoff } from './swarmRuntimeAdmission'
import { assertAutomaticOperationAllowed } from './automationPolicy'
import { validateNativePresidentRecoveryAdmission, type NativeRecoveryAdmission } from './swarmNativeRecovery'
import { assertClaudeSubscriptionLaunch } from './subscriptionOnly'
import { runtimeOwnerKey } from './runtimeOwner'
import { chatGptDeskOptions } from './chatgptLaunch'
import { createChatGptQuery, distillChatGptMessage } from './chatgptQuery'
export { SUPPLY_DESK_LABEL } from './swarmSupplyRuntime'

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
 *  THE OWNER'S LAST MESSAGE (review 292ed010 B2). Since 2026-09-23 a
 *  hands-free update restarts the app even while this desk is mid-reply, and
 *  the owner may be talking to it from the phone (invisible to the app's
 *  "is the owner using the window" check). A resume that only "reports and
 *  waits" would silently drop that request — 「OK、積んで」 cut before the Board
 *  PUT, and the owner believes it was done. So the resumed desk answers any
 *  unanswered owner message first, checking the Board so it neither loses nor
 *  double-files the order.
 *
 *  ONE LINE, on purpose — the same hard-won delivery contract buildOrderInjection
 *  (swarmWorker.ts) documents: the whole thing must land as a SINGLE slash-command
 *  argument. A multi-line positional risks being split, or collapsed into a
 *  `[Pasted text]` chip where `/supply` is never parsed as a command at all. */
export const SUPPLY_RESUME_INJECTION =
  '/supply セッション再開: アプリ再起動をまたいで前回の会話を復元した。あなたの記憶は古い — 前回以降に司令官が配車・統合・完了させたカードがある。新しいカードを積む前に、まず Board の現状(todo/doing/review)を API で読み直し、既に実装済み・重複・前提が変わったタスクを積まないこと。読み直した結果を1行で報告する。再起動の直前にオーナーから届いた発言にまだ答え終えていなければ、続けてそれに答える — 依頼(カードを積む等)が既に Board に反映済みかを今読んだ現状で確かめ、未反映なら実行し、反映済みなら二重に積まずにそう伝える。それから待機する。'

export interface SpawnSwarmSupplyOpts {
  /** The registered project to feed — the supply PTY's cwd (its primary
   *  checkout). The route validates this with validateProjectPath first. */
  projectPath: string
  /** Server-selected intent: explicit conversation or automatic delegation. */
  cause?: 'owner' | 'automatic'
  cols?: number
  rows?: number
  /** Force a BRAND-NEW conversation, ignoring (and overwriting) the persisted
   *  session id. The escape hatch for a desk whose restored context has gone bad
   *  — off by default, so the normal button always resumes. */
  fresh?: boolean
  runtimeHandoff?: SwarmRuntimeHandoff
  /** Internal owner recovery capability; never accepted from a client body. */
  nativeRecovery?: NativeRecoveryAdmission
  recoveryInstructions?: string
  beforeLaunch?: () => Promise<void>
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
    handoffInstructions?: string
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
  // Mode-resolved model/effort. REQUIRED since 2026-09-16: an omitted `me` used
  // to mean "top tier" (fable), i.e. the scarcest model, chosen by forgetting.
  me: { model: string; effort?: ClaudeEffort },
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
    (opts.resume ? SUPPLY_RESUME_INJECTION : SUPPLY_INJECTION) + languageDirective(opts.lang) + (opts.handoffInstructions ? `\n\n${opts.handoffInstructions}` : ''),
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

/** Stop every live supply desk in the project. Lives HERE — the module that
 *  owns the desk and its PTY-by-design status — so the route layer never has
 *  to reach into the PTY pool directly (the import boundary exists precisely
 *  to stop that reach; this module is on its exemption list WITH the reason).
 *  Returns the ids it asked to die (kill is fire-and-forget by pool contract). */
export const stopSwarmSupplyDesks = (projectPath: string): string[] => {
  const desks = listLiveSupplyDesks(projectPath)
  for (const d of desks) stopSupplyDesk(d)
  return desks.map((d) => d.handleId)
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
const listAliveSupplyDesks = (projectPath: string) => listLiveSupplyDesks(projectPath)

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
  const existing = alive.find((d) => !d.stopping)
  if (!existing) return null
  const chatgpt = await selectedRuntime('swarm') === 'chatgpt'
  if (!!existing.agentSessionId?.startsWith('chatgpt-') !== chatgpt) {
    throw new Error('現在の社長窓口を停止してから、選んだ接続先でもう一度開始してください。会話の記録は残ります。')
  }
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
    terminalId: existing.runtime === 'pty' ? existing.handleId : '',
    ...(existing.runtime === 'sdk' ? { runtime: 'sdk' as const, sdkSessionId: existing.handleId } : {}),
    agentSessionId: existing.agentSessionId ?? '',
    // Nothing was RESUMED — no `claude --resume` ran. The desk was already up.
    resumed: false,
    reused: true,
  }
}

export const spawnSwarmSupply = (opts: SpawnSwarmSupplyOpts): Promise<SpawnSwarmSupplyResponse> =>
  trackSwarmRuntimeLaunch(opts.runtimeHandoff, () => spawnSwarmSupplyInternal(opts))

const spawnSwarmSupplyInternal = async (
  opts: SpawnSwarmSupplyOpts,
): Promise<SpawnSwarmSupplyResponse> => {
  assertSwarmRuntimeAdmission(opts.runtimeHandoff)
  if (!opts.runtimeHandoff && opts.cause !== 'owner') await assertAutomaticOperationAllowed(opts.projectPath)
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
    if (listLiveSupplyDesks(opts.projectPath).length) throw new Error('The president is still stopping. Try again when it has closed.')
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
  if (await selectedRuntime('swarm') === 'chatgpt') {
    assertSwarmRuntimeAdmission(opts.runtimeHandoff)
    const config = await chatGptLaunchConfig('swarm', opts.runtimeHandoff?.profile)
    const session = opts.fresh ? { agentSessionId: `chatgpt-${opts.runtimeHandoff?.operationId ?? randomUUID()}`, resume: false }
      : await resolveSwarmSession(opts.projectPath, 'supply', { provider: 'chatgpt' })
    const handoffTranscript = opts.runtimeHandoff?.publicTranscript ?? (session.resume
      ? await (await import('./chatgptResponses')).chatGptPublicConversation(session.agentSessionId) : undefined)
    const lang = await getPromptLang()
    await opts.beforeLaunch?.()
    if (!opts.runtimeHandoff && opts.cause !== 'owner') await assertAutomaticOperationAllowed(opts.projectPath)
    const desk = spawnSdkSession({ cwd: opts.projectPath, role: 'supply', provider: 'chatgpt',
      startPaused: !!opts.runtimeHandoff,
      handoffTranscript,
      agentSessionId: session.agentSessionId,
      options: { ...chatGptDeskOptions({ cwd: opts.projectPath, role: 'supply', ...session, ...config }),
        ...(opts.runtimeHandoff?.runtimeOwnerKey ? { runtimeOwnerKey: opts.runtimeHandoff.runtimeOwnerKey } : {}) },
      initialPrompt: (session.resume ? SUPPLY_RESUME_INJECTION : SUPPLY_INJECTION) + languageDirective(lang) + (opts.runtimeHandoff ? `\n\n${opts.runtimeHandoff.instructions}` : '') + (opts.recoveryInstructions ? `\n\n${opts.recoveryInstructions}` : ''),
      queryFn: createChatGptQuery(), distillMessage: distillChatGptMessage,
    })
    if (desk.status === 'failed') { terminateSdkSession(desk.id); throw new Error('ChatGPT president could not start.') }
    await recordSwarmSession(opts.projectPath, 'supply', session.agentSessionId).catch(() => {})
    return { terminalId: '', runtime: 'sdk', sdkSessionId: desk.id,
      agentSessionId: session.agentSessionId, resumed: session.resume }
  }
  // `fresh` skips the lookup entirely (and overwrites the record below) — the
  // owner's way out of a restored context that has gone bad.
  const session = opts.fresh
    ? { agentSessionId: opts.runtimeHandoff?.operationId ?? randomUUID(), resume: false }
    : await resolveSwarmSession(opts.projectPath, 'supply')
  // Token budget (card 68d8e00f): the execution MODE picks the desk's tier —
  // economy runs the supply officer on sonnet; optimize on opus since 2026-09-18
  // (owner: the desk investigates and specifies, sonnet was under-powered); max
  // on the top tier. desiredModelEffort (swarmLaunch.ts) is the one source.
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
  assertSwarmRuntimeAdmission(opts.runtimeHandoff)
  const subscriptionEnv = await assertClaudeSubscriptionLaunch(opts.projectPath)
  if (opts.runtimeHandoff?.runtimeOwnerKey) await runtimeOwnerKey(opts.runtimeHandoff.runtimeOwnerKey)
  if (!opts.runtimeHandoff && opts.cause !== 'owner') await assertAutomaticOperationAllowed(opts.projectPath)
  await opts.beforeLaunch?.()
  if (opts.nativeRecovery) await validateNativePresidentRecoveryAdmission(opts.projectPath, opts.nativeRecovery)
  assertSwarmRuntimeAdmission(opts.runtimeHandoff)
  if (!opts.runtimeHandoff && opts.cause !== 'owner') await assertAutomaticOperationAllowed(opts.projectPath)
  const launchOptions = supplyLaunchOpts(
    opts.projectPath, session.agentSessionId,
    { cols: opts.cols, rows: opts.rows, resume: session.resume, remoteName, lang, handoffInstructions: opts.runtimeHandoff?.instructions ?? opts.recoveryInstructions }, me,
  )
  launchOptions.env = { ...launchOptions.env, CLAUDE_CONFIG_DIR: subscriptionEnv.CLAUDE_CONFIG_DIR! }
  const ref = launchClaude(
    launchOptions,
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
