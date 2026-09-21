// SDK-only manager desk in the project's primary checkout. Conversation resume,
// quota learning and the one-desk-per-project lock apply to every new launch.
// Existing legacy PTY desks remain addressable until stopped; never seat a twin.

import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { resolveSwarmModelEffortProbed } from './swarmLaunch'
import { NoAllowedModelTierError } from './swarmAllowedModels'
import { resolveSwarmSession, recordSwarmSession, forgetSwarmSessionIf } from './swarmSessions'
import { getPromptLang, type PromptLang } from './promptLang'
import { markRateLimited, isModelTier } from './swarmQuota'
import { installOgManageSkill } from './ogManageSkill'
import { MANAGER_DESK_LABEL } from './swarmManagerLabel'
import { listManagerDesks } from './swarmManagerRuntime'
import {
  acquireDeskSpawnLock,
  deskSpawnLockKey,
  DESK_SPAWN_LOCK_WAIT_MS,
} from './deskSpawnLock'
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
import { getExecutionMode, getAllowedModelTiers } from './store'
import { recycleDeskSessionIfOverCap, deskRecycledLogLine } from './deskContextCap'
import { logToEngine } from './engineLogSink'
import type { ClaudeEffort } from '../types'
import { type SpawnSwarmManagerResponse } from '../types'

/** The skill the SDK commander runs from its initial prompt.
 *  The role is the `manager` running `/og-manage`
 *  — the tmux-FREE commander protocol (~/.claude/skills/og-manage/): its eyes
 *  are GET /api/swarm/workers + git, it dispatches via POST /api/swarm/worker,
 *  and it never mentions or runs tmux. The shell cockpit's `/manage` (tmux
 *  panes, swarm-pane.sh dispatch) stays untouched for the terminal cockpit —
 *  an in-app commander running THAT skill would advise tmux commands that
 *  cannot work inside the app's PTY, which is exactly why this injection
 *  points at the app-native sibling instead. */
export const MANAGER_INJECTION = '/og-manage'

/** The owner-facing name of this desk, also used to identify legacy PTY entries.
 *  Consumers: the model-limit watch names the desk
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
 *      direction: `running` can now come back on its OWN,
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
  '/og-manage セッション再開: アプリ再起動をまたいで前回の会話を復元した。記憶をそのまま前提にするな — worker roster・review・journal は再起動で全消えし(card 3 未着手)、再起動はたいていリリースなのでコード自体も変わっている。エンジンの running は前回 ON だった意図が自動で戻っていることがある(boot 時の自動再開・owner の手動停止があれば戻らない)ので、今の running が「誰かが今つけた」のか「前回の意図が生き残った」のかは決めつけるな。最初にやることは1つだけ: 「状況」を頭から実行し、Board の実体(todo/doing/review)・worker 一覧・エンジン状態を API と git で読み直して、その結果だけを根拠に現状を報告する。前回の認識との食い違いがあれば現物(API/git)を正とし、食い違った点を明示すること。'

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

/** Cool a tier only after a confirmed quota refusal followed by an early exit.
 *  Forget a refusal-only fresh session, never a resumed conversation's history.
 *  Compare-and-forget protects a newer session pointer. The SDK stream replay
 *  lets this watcher attach after the session record is written without a race. */
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
      // never drop the pointer to it (even after a quota refusal).
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
  /** The registered project to command — the manager session's cwd (its primary
   *  checkout). The route validates this with validateProjectPath first. */
  projectPath: string
  /** Force a BRAND-NEW conversation, ignoring (and overwriting) the persisted
   *  session id. The escape hatch for a restored context that has gone bad — off
   *  by default, so the normal button always resumes. */
  fresh?: boolean
}

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
  // Preserve in-flight legacy PTY desks across a dev reload. New launches use
  // SDK only, but an existing PTY must still block a second manager and be usable.
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

/** The desk spawn lock, shared with the SUPPLY desk (deskSpawnLock.ts).
 *
 *  It used to live here in full. It was extracted on 2026-08-15 when the Board
 *  grew a second door onto the supply desk: the compare-and-set is the same
 *  mechanism for both one-per-project desks, and a second hand-rolled copy of a
 *  lock whose correctness depends on "no await between these two lines" is
 *  exactly the drift this repo keeps paying for. Behaviour here is unchanged —
 *  same wait, same globalThis map, and `deskSpawnLockKey('manager', …)` returns
 *  the bare resolved path this file has always used as its key.
 *
 *  Re-exported because {@link swarmManager.spawn.test} and any future caller
 *  reads the budget from the module that spends it. */
export { DESK_SPAWN_LOCK_WAIT_MS }

/** Start an SDK manager, or adopt an existing desk without interrupting it. */
export const spawnSwarmManager = async (
  opts: SpawnSwarmManagerOpts,
): Promise<SpawnSwarmManagerResponse> => {
  // ── ONE SPAWN AT A TIME, per project: the check-then-act is a CRITICAL SECTION ──
  //
  // {@link adoptLiveDesk} decides existence on the pool, which cannot desynchronise
  // from itself — but reading it is only half the guard. Between that read and the
  // SDK spawn that finally puts a desk INTO the pool sit four awaits (the
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
  const release = await acquireDeskSpawnLock(
    deskSpawnLockKey('manager', resolve(opts.projectPath)),
    DESK_SPAWN_LOCK_WAIT_MS,
  )
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
  const resolved = opts.fresh
    ? { agentSessionId: randomUUID(), resume: false }
    : await resolveSwarmSession(opts.projectPath, 'manager')
  // DESK CONTEXT CAP (owner decision 2026-09-18 — deskContextCap.ts): a resumable
  // conversation already over the cap is NOT resumed; a fresh one opens instead,
  // still handed MANAGER_RESUME_INJECTION (`recycled`) so the new desk re-reads
  // the world before it speaks. The commander is stateless by design, so this
  // loses nothing and stops every later turn re-reading a huge context.
  const capped = await recycleDeskSessionIfOverCap(resolved)
  const session = { ...capped.session, recycled: capped.recycledFromTokens !== null }
  const noteRecycled = (): void => {
    if (capped.recycledFromTokens !== null)
      logToEngine(opts.projectPath, 'info', deskRecycledLogLine('司令官', capped.recycledFromTokens))
  }
  const recycledField =
    capped.recycledFromTokens !== null ? { recycledFromTokens: capped.recycledFromTokens } : {}
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
  // commander honors the same hard mask as every other role).
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
  const lang = await getPromptLang()
  const sdkDesk = await launchSdkDesk(opts, session, me, lang)
  noteRecycled()
  return { ...sdkDesk, ...recycledField }
}

/** SDK failures remain visible to the route and the engine's existing retry /
 *  recovery policy. Never fall back to a terminal launch. */
const launchSdkDesk = async (
  opts: SpawnSwarmManagerOpts,
  session: { agentSessionId: string; resume: boolean; recycled?: boolean },
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
    recycled: session.recycled,
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
