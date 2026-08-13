// server/routes/swarm.ts — the in-app swarm control plane (tmux-free).
//
// POST /api/swarm/worker          — spawn a worker: isolated central worktree +
//                                   one interactive `claude` PTY + a /order goal
//                                   typed in once the TUI is ready.
// POST /api/swarm/supply          — spawn the SUPPLY OFFICER (補給官): one
//                                   interactive `claude` PTY in the project's
//                                   PRIMARY checkout running the /supply skill
//                                   (turns the user's requests into Board:todo
//                                   cards). NO worktree — it only talks + writes
//                                   the Board, so stopping it is a plain PTY kill.
// POST /api/swarm/manager         — spawn the COMMANDER (司令官) CONVERSATION:
//                                   one interactive `claude` PTY in the project's
//                                   PRIMARY checkout running the /manage skill
//                                   (the human-in-the-loop counterpart to the
//                                   autonomous orchestrator engine below). NO
//                                   worktree — like supply, stopping it is a
//                                   plain PTY kill.
// POST /api/swarm/worktree/remove — tear a worker worktree down (kill/complete).
// GET  /api/swarm/orchestrator    — the COMMANDER engine's state for a project.
// GET  /api/swarm/workers         — the SERVER-TRUTH worker list (live PTYs +
//                                   engine roster + heartbeat files unified) —
//                                   see src/lib/server/swarmWorkerRegistry.ts.
// POST /api/swarm/orchestrator/start — turn the autonomous drain+dispatch ON.
// POST /api/swarm/orchestrator/stop  — turn it OFF (manual spawn untouched).
// GET  /api/swarm/quota           — the model-tier cooling table (swarmQuota).
// POST /api/swarm/quota/cool      — cool a tier BY HAND so launches drop a rung
//                                   (the manual override for when the automatic
//                                   rate-limit sensor is wrong or late — no
//                                   engine stop, no source patch needed).
// POST /api/swarm/quota/uncool    — release a cooled tier again.
//
// Thin adapters over src/lib/server/swarmWorker.ts + swarmSupply.ts +
// swarmOrchestrator.ts. OWNER-ONLY:
// every route gates on hasSwarmOwnerAccess (swarmGate.ts — the signed-in owner
// role OR the explicit server-local unlock: env OPENGROUND_LOCAL_OWNER=1 /
// settings.swarmLocalOwner, for login-disabled machines) at the very top, so
// an unauthorized caller gets 403 before any body parse, path validation, or
// git — closing the local curl/SDK direct-call hole (the UI hiding the tab is
// NOT the only guard). The unlock never comes from the request itself (see
// swarmGate.ts for why that is safe: this gate is a feature-visibility flag,
// not a security boundary — POST /api/terminal is already ungated locally).
// Then every path-accepting route runs validateProjectPath (the registry
// allowlist) BEFORE any work, and the spawn routes also run the shared claude
// preflight so a missing/signed-out CLI fails fast (503) instead of orphaning
// a PTY (+worktree). Subscription-only: every spawn is an interactive `claude`
// PTY (launchClaude), never `claude -p`/SDK.

import { Hono } from 'hono'
import { hasSwarmOwnerAccess } from '@/lib/server/swarmGate'
import {
  readProjectData,
  mutateProjectData,
  validateProjectPath,
  ProjectDataConflictError,
} from '@/lib/server/projectData'
import { claudeRunPreflight } from '@/lib/server/claudePreflight'
import { swarmEnvPreflight } from '@/lib/server/swarmEnvPreflight'
import {
  spawnSwarmWorker,
  removeSwarmWorktree,
  WorktreeOccupiedError,
  ensureSwarmWorktreeForBranch,
} from '@/lib/server/swarmWorker'
import { listSwarmWorkers } from '@/lib/server/swarmWorkerRegistry'
import { spawnSwarmSupply, stopSwarmSupplyDesks } from '@/lib/server/swarmSupply'
import { patchEngineIntent } from '@/lib/server/swarmEnginePersistence'
import { spawnSwarmManager } from '@/lib/server/swarmManager'
import { listManagerDesks, sayToManagerDesk } from '@/lib/server/swarmManagerRuntime'

/** Cap on one relayed message to the commander. Sized like the escalation answer
 *  cap: this is a sentence the owner dictated from a phone, not a payload. */
const MAX_MANAGER_SAY = 4000
import {
  startOrchestrator,
  stopOrchestrator,
  stopOrchestratorWorker,
  isCardDispatchInFlight,
  resolveOrchestratorReview,
  getOrchestratorState,
  drainTickOrchestrator,
  setSelfSupply,
  setOverseer,
  dismissOverseerReminder,
  writeManagerHeartbeat,
  noticeDeliverable,
  ClaudeNotReadyError,
} from '@/lib/server/swarmOrchestrator'
import { approveSelfSupplyCard } from '@/lib/server/swarmSelfSupply'
import { brainSandboxAvailable } from '@/lib/server/swarmOverseerBrain'
import { listSwarmNotifications, markSwarmNotificationHandled } from '@/lib/server/swarmNotifications'
import {
  listEscalations,
  openEscalation,
  answerEscalation,
  dismissEscalation,
  EscalationNotFoundError,
  EscalationStateError,
  MAX_ESCALATION_QUESTION,
  MAX_ESCALATION_CONTEXT,
  MAX_ESCALATION_ANSWER,
  MAX_ESCALATION_PLAIN_QUESTION,
  MAX_ESCALATION_SHORT_FIELD,
} from '@/lib/server/swarmEscalations'
import {
  coolingSnapshot,
  markCoolingUntil,
  clearCooling,
  isModelTier,
  allCoolingUntil,
  ensureCoolingTableLoaded,
  flushQuotaPersist,
  MAX_MANUAL_COOLING_MS,
  MODEL_TIER_LADDER,
} from '@/lib/server/swarmQuota'
import { highestSpawnableTier } from '@/lib/server/swarmAllowedModels'
import { getAllowedModelTiers, getSettings } from '@/lib/server/store'
import {
  readLandedLedger,
  weeklyLandedSeries,
  isSelfProject,
} from '@/lib/server/swarmLandedLedger'
import { basename } from 'path'
import type { SwarmAllowedModels } from '@/lib/types'
import type {
  AppNotificationsResponse,
  EscalationsResponse,
  EscalationOpenResponse,
  EscalationAnswerResponse,
  EscalationDismissResponse,
  EscalationProxyDraft,
  EscalationWhy,
  SwarmQuotaResponse,
  SwarmLandedKpi,
  SwarmLandedWeek,
  SpawnSwarmWorkerResponse,
} from '@/lib/types'

// The /order goal (card title + notes) is typed into the TUI as ONE line. A
// Board goal is a short observable completion condition; 8 KiB is a generous
// ceiling that still keeps the single PTY write trivial.
const MAX_GOAL = 8 * 1024

/** The cooling table as the owner sees it, at one instant. Snapshot + the two
 *  derived answers dispatch itself asks (which tier a launch resolves to; when
 *  the swarm un-parks if none is left). Read-only — no clock is stored.
 *
 *  `tiers` / `allCoolingUntil` report the COOLING table verbatim — unchanged, and
 *  deliberately blind to the owner's model mask (this endpoint is the cooling
 *  control plane; /cool and /uncool keep operating on exactly what it shows).
 *  `launchTier` is the one DERIVED claim about a launch, so it honors the mask:
 *  reporting a switched-OFF tier as "what launches next" would be a lie the engine
 *  never acts on (it resolves through swarmAllowedModels). Null when nothing is
 *  spawnable — every enabled tier cooling, or every tier switched off. */
const quotaSnapshot = (now: number, allowed: SwarmAllowedModels): SwarmQuotaResponse => ({
  now,
  tiers: coolingSnapshot(now),
  launchTier: highestSpawnableTier(now, allowed),
  allCoolingUntil: allCoolingUntil(now),
})

/** The board column a card sits in, with the pre-Board back-compat default. */
const columnOf = (card: { boardColumn?: string; done?: boolean }): string =>
  card.boardColumn ?? (card.done ? 'done' : 'todo')

/** What the pre-spawn claim found. `claimed` ⇒ this request now OWNS the card
 *  (it moved todo→doing); `busy` ⇒ another dispatch already owns it; `free` ⇒ a
 *  column nothing contends for (blocked / done — the engine never dispatches
 *  those), left exactly where it is; `missing` ⇒ the card vanished mid-request. */
type ClaimOutcome =
  | { kind: 'claimed' }
  | { kind: 'busy'; column: string }
  | { kind: 'free'; column: string }
  | { kind: 'missing' }

/** CLAIM a card for dispatch — the todo→doing compare-and-swap that must land
 *  BEFORE the worker is spawned.
 *
 *  Ordering is the whole point: `spawnSwarmWorker` creates a worktree (a git
 *  fetch + checkout — hundreds of ms, sometimes seconds), and for that entire
 *  window a claim-afterwards leaves the card sitting in `todo`, invisible to the
 *  autonomous engine's countedIds. Its next runDispatchPass therefore re-selects
 *  the SAME card and spawns a SECOND worker: two `swarm/*` branches on one card,
 *  one of which is guaranteed to conflict at integration. Claiming first shuts
 *  that window — `selectDispatch` only ever picks todo cards.
 *
 *  The read-modify-write runs inside the project's board lock
 *  ({@link mutateProjectData}), so the compare and the swap are atomic against
 *  the engine's own concurrent board writes. Throws only on a hard store failure
 *  (the caller refuses to spawn rather than risk the twin). */
const claimCardForDispatch = async (projectPath: string, taskId: string): Promise<ClaimOutcome> => {
  /** doing/review ⇒ some branch already exists for this card; anything else
   *  (blocked / done) is a column no dispatcher contends for. */
  const settle = (column: string): ClaimOutcome =>
    column === 'doing' || column === 'review' ? { kind: 'busy', column } : { kind: 'free', column }

  // Cheap pre-read: only a card that reads `todo` is worth the locked
  // read-modify-write below, which always writes. The lock re-checks anyway, so
  // a card that flips in between still resolves correctly — this just spares the
  // restart / blocked paths a no-op write.
  const pre = (await readProjectData(projectPath)).tasks.find((t) => t.id === taskId)
  if (!pre) return { kind: 'missing' }
  if (columnOf(pre) !== 'todo') return settle(columnOf(pre))

  let outcome: ClaimOutcome = { kind: 'missing' }
  await mutateProjectData(projectPath, (data) => {
    const card = data.tasks.find((t) => t.id === taskId)
    if (!card) return
    const column = columnOf(card)
    if (column !== 'todo') {
      outcome = settle(column)
      return
    }
    card.boardColumn = 'doing'
    card.done = false
    outcome = { kind: 'claimed' }
  })
  return outcome
}

/** Give a claimed card back when the spawn it was claimed for FAILED — otherwise
 *  a doomed spawn would park the card in `doing` with no worker behind it, where
 *  neither the engine (it only dispatches todo) nor the owner would ever see it
 *  move. Only reverts a card still sitting in `doing` (never overrides a column
 *  someone else set meanwhile). Best-effort: the 500 the caller returns is the
 *  real signal. */
const releaseCardClaim = async (projectPath: string, taskId: string): Promise<void> => {
  await mutateProjectData(projectPath, (data) => {
    const card = data.tasks.find((t) => t.id === taskId)
    if (card && columnOf(card) === 'doing') {
      card.boardColumn = 'todo'
      card.done = false
    }
  })
}

/** Record the branch the (now live) worker checked out on its card — the handle
 *  the review/integration stage reads. Runs AFTER the spawn because the branch
 *  name is minted inside it; the card is already `doing` by then, so no dispatch
 *  can slip in between. Best-effort — the worker is live either way. */
const recordCardBranch = async (
  projectPath: string,
  taskId: string,
  branch: string,
): Promise<void> => {
  await mutateProjectData(projectPath, (data) => {
    const card = data.tasks.find((t) => t.id === taskId)
    if (card) card.branch = branch
  })
}

export const swarmRoutes = new Hono()
  // --- POST /api/swarm/worker — spawn an in-app worker ----------------------
  // Body: { path, taskId? , title?, notes?, hint?, worktree?, cols?, rows? }
  //  - taskId   → the goal is read from that Board card (title + notes).
  //  - title    → explicit goal (curl / non-card callers); notes optional.
  //  - worktree → RESTART: relaunch in this EXISTING central worktree (same
  //               swarm/* branch + in-progress work) instead of forking a new one.
  //               Validated under the central worktrees dir by spawnSwarmWorker
  //               (resolveExistingSwarmWorktree), so a crafted path can't escape.
  // One of taskId | title is required.
  //
  // TWIN-DISPATCH: a card is CLAIMED (todo→doing, CAS under the board lock) BEFORE
  // the worktree/PTY spawn — and a card the autonomous engine already owns (live
  // worker, or mid-spawn: isCardDispatchInFlight) is refused with 409 instead of
  // getting a second worker. Claiming afterwards left the card `todo` for the whole
  // multi-second spawn, which is exactly when the engine's next runDispatchPass
  // re-selected it and spawned a rival branch. A failed spawn hands the claim back.
  // A RESTART is exempt (it re-enters an existing branch; it mints none).
  .post('/api/swarm/worker', async (c) => {
    // OWNER-ONLY gate (runs first, before body parse / path validation): the
    // in-app swarm spawns claude PTYs + git worktrees, so the control plane is
    // restricted to the signed-in owner. Same server-side role resolution as the
    // custom-tab routes (identity from the app-login session; the
    // OPENGROUND_OWNER_EMAILS env override is honoured). Non-owner/signed-out → 403.
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)

    // Resolve the goal: a Board card (taskId) wins; else an explicit title.
    let title = ''
    let notes: string | undefined
    const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
    if (taskId) {
      // The path passed validateProjectPath, so this read cannot escape the
      // registry. Live card title/notes are the goal source of truth.
      const projectData = await readProjectData(path)
      const card = projectData.tasks.find((t) => t.id === taskId)
      if (!card) return c.json({ error: 'task not found' }, 404)
      title = card.title ?? ''
      notes = typeof card.notes === 'string' ? card.notes : undefined
    } else if (typeof body?.title === 'string' && body.title.trim()) {
      title = body.title
      notes = typeof body?.notes === 'string' ? body.notes : undefined
    } else {
      return c.json({ error: 'taskId or title is required' }, 400)
    }
    if (!title.trim() && !(notes ?? '').trim()) {
      return c.json({ error: 'goal is empty' }, 400)
    }
    if (title.length + (notes?.length ?? 0) > MAX_GOAL) {
      return c.json({ error: 'goal too large' }, 400)
    }

    // Preflight BEFORE creating the worktree: a missing/signed-out claude is a
    // doomed spawn (it would open its own OAuth browser), and we don't want to
    // orphan a worktree for it. Same machine-readable 503 as the terminal route.
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)

    // Env preflight (git/shell): a worker spawn creates a git worktree
    // (createSwarmWorktree) and runs a PTY through a shell — checked BEFORE the
    // twin-dispatch claim below, so a missing prerequisite never claims a Board
    // card off the todo queue for a spawn that can't succeed. force:true — the
    // 10s cache is for the GET poll only; a spawn must never refuse on a stale
    // "not ready" answer the owner just fixed (e.g. ran `git init` moments ago).
    const envPre = await swarmEnvPreflight(path, { force: true })
    if (!envPre.ok) {
      return c.json(
        { error: envPre.issues.map((i) => i.message).join(' '), envIssues: envPre.issues.map((i) => i.id) },
        503,
      )
    }

    // (cols/rows from old clients are ignored — PTY dimensions died with the
    // PTY worker, 2026-08-13.)
    const hint = typeof body?.hint === 'string' ? body.hint : undefined
    // RESTART: an existing central worktree to relaunch in place. Validated to sit
    // under this project's central worktrees dir by spawnSwarmWorker
    // (resolveExistingSwarmWorktree) — a crafted path throws there, not escapes.
    const worktree = typeof body?.worktree === 'string' && body.worktree ? body.worktree : undefined
    // A RESTART re-enters an EXISTING worktree + branch, so it mints no second
    // branch and cannot twin-dispatch — its card is legitimately already `doing`.
    // Only a FRESH dispatch has to win the card first.
    const isRestart = worktree !== undefined

    // ── TWIN-DISPATCH GUARD (claim BEFORE spawn) ──────────────────────────────
    // Both halves close the same hazard from opposite sides: the autonomous
    // engine and this route each spawn workers, and neither sees the other's
    // in-flight spawn. The board column is the shared mutual-exclusion token.
    let claimed = false
    if (taskId) {
      // (a) The engine got there first — it is mid-spawn for this card, or its
      //     worker is already live (a lagging todo→doing move can hide that from
      //     the board). Refuse rather than mint a rival branch.
      if (!isRestart && (await isCardDispatchInFlight(path, taskId))) {
        return c.json({ error: 'task already dispatched' }, 409)
      }
      // (b) Take the card now, while the spawn (worktree + PTY) has NOT started:
      //     once it reads `doing`, selectDispatch skips it forever after.
      let outcome: ClaimOutcome
      try {
        outcome = await claimCardForDispatch(path, taskId)
      } catch (e: any) {
        // A refused/failed claim means we do NOT own the card — never spawn on it.
        // A CAS refusal is someone else writing the board (409); anything else is
        // the store failing under us (500).
        const conflict = e instanceof ProjectDataConflictError
        return c.json({ error: `failed to claim task: ${e?.message ?? e}` }, conflict ? 409 : 500)
      }
      if (outcome.kind === 'missing') return c.json({ error: 'task not found' }, 404)
      if (outcome.kind === 'busy' && !isRestart) {
        return c.json({ error: `task already dispatched (${outcome.column})` }, 409)
      }
      claimed = outcome.kind === 'claimed'
      // (c) Re-check UNDER the claim. Gate (a) read the engine BEFORE the CAS, so the
      //     engine could have reserved this card in between (runDispatchPass reserves
      //     every pick before its first spawn) and already be spawning on it — while
      //     the board still read `todo`, letting our CAS "win" a card that was not
      //     free. Only this second read, taken after the claim, can see that. Hand the
      //     card back and refuse: the engine's worker is the one that exists. Reverting
      //     to `todo` is the safe direction — if the engine's spawn lands, its own
      //     todo→doing move (or the reconcile pass, which retries the move for any
      //     counted worker still sitting in todo) restores `doing`; if that spawn threw,
      //     the card is freely dispatchable again instead of stranded in `doing` with no
      //     worker behind it.
      if (claimed && !isRestart && (await isCardDispatchInFlight(path, taskId))) {
        await releaseCardClaim(path, taskId).catch(() => {})
        return c.json({ error: 'task already dispatched' }, 409)
      }
    }

    // SAME RULE AS THE ENGINE (2026-08-04): a card that already has a `swarm/*`
    // branch is CONTINUED, not restarted. Without this the manual/commander door
    // mints a fresh branch and `recordCardBranch` below stamps it over the old
    // one — the same orphaning the engine's dispatch was fixed for, one door
    // over. An explicit `worktree` in the body still wins (that caller is naming
    // the place on purpose).
    let reuse: string | undefined = worktree
    if (!reuse && taskId) {
      const card = (await readProjectData(path).catch(() => ({ tasks: [] }))).tasks.find(
        (t) => t.id === taskId,
      )
      const branch = typeof card?.branch === 'string' ? card.branch.trim() : ''
      if (branch) reuse = (await ensureSwarmWorktreeForBranch(path, branch))?.worktree
    }

    let res: SpawnSwarmWorkerResponse
    try {
      // WORKER: no env — its veto arms via the guard opt (OPENGROUND_GUARD=1).
      res = await spawnSwarmWorker({
        projectPath: path,
        title,
        notes,
        hint,
        worktree: reuse,
      })
    } catch (e: any) {
      // The claim outlived the spawn it was for — hand the card back to `todo`
      // so it is re-dispatchable instead of stranded in `doing` worker-less.
      if (claimed) await releaseCardClaim(path, taskId).catch(() => {})
      // "A desk is already working here" is a CONFLICT, not a breakage: the
      // caller asked for a restart that would have made two claudes share one
      // worktree, and the right answer is the same 409 the card-claim gates use.
      // A 500 would read as "the server fell over" and invite a retry loop
      // against a healthy, occupied worktree.
      if (e instanceof WorktreeOccupiedError) {
        return c.json({ error: e.message, worktree: e.worktree, occupied: true }, 409)
      }
      return c.json({ error: `failed to spawn worker: ${e?.message ?? e}` }, 500)
    }
    // The branch only exists once the worktree does, so it lands in a second
    // write — safe now, because the card is already `doing` and off the queue.
    if (claimed) await recordCardBranch(path, taskId, res.branch).catch(() => {})
    return c.json(res)
  })
  // --- POST /api/swarm/supply — spawn the in-app supply officer (補給官) ------
  // Body: { path, cols?, rows?, fresh? }. Launches ONE interactive claude PTY in the
  // project's PRIMARY checkout (NOT a worktree) running the /supply skill, which
  // turns the user's vague requests into observable Board:todo cards. No
  // worktree is created (supply only talks + writes the Board), so there is
  // nothing to tear down — stopping it is a plain terminal kill (DELETE
  // /api/terminal/:id). Owner-only + validated + preflighted exactly like
  // /worker; bypass + SWARM_MANAGER=1 (set in swarmSupply) — a role TAG, not a
  // guard opt-in: the WORKER-ONLY PreToolUse veto never polices this trusted desk.
  // RESUMES the project's previous supply conversation by default (the response's
  // `resumed` says which happened); `fresh:true` opts out. See swarmSessions.ts.
  .post('/api/swarm/supply', async (c) => {
    // OWNER-ONLY gate (see /api/swarm/worker): the supply session is an
    // owner-only control-plane spawn. Non-owner / signed-out → 403, before any
    // body parse / path validation.
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)

    // Preflight BEFORE spawning: a missing/signed-out claude would open its own
    // OAuth browser and orphan a PTY. Same machine-readable 503 as /worker.
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)

    // Env preflight (git/shell): supply runs a PTY through a shell in the
    // project's PRIMARY checkout and NEVER calls git at all (no worktree, no
    // status/merge) — so requireGit:false AND requireGitRepo:false, or a
    // non-git registered project (measured 2026-07-22: 15 of 42) would lose a
    // feature that never needed git, or a git-less machine would block a
    // feature that never needed git installed either.
    const envPre = await swarmEnvPreflight(path, { force: true, requireGit: false, requireGitRepo: false })
    if (!envPre.ok) {
      return c.json(
        { error: envPre.issues.map((i) => i.message).join(' '), envIssues: envPre.issues.map((i) => i.id) },
        503,
      )
    }

    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    try {
      // Default: RESUME the project's persisted supply conversation when claude can
      // still load it (swarmSessions.ts) — the desk survives an app restart instead
      // of waking up amnesiac. `fresh:true` forces a brand-new conversation (the way
      // out of a restored context that has gone bad); anything but a literal true is
      // a resume, so a junk body can never silently discard the desk's memory.
      const fresh = body?.fresh === true
      const res = await spawnSwarmSupply({ projectPath: path, cols, rows, fresh })
      // The owner wants this desk UP — remember it across restarts (engine.json),
      // so an app update brings the supply officer back instead of a dead pane
      // (0803 owner request). AWAITED but swallow-on-fail: a failed mirror write
      // must not fail a spawn that already succeeded — while a FIRE-AND-FORGET
      // write here raced test teardowns with ENOTEMPTY (§8 of the doctrine, the
      // exact class measured 0801) and left the response claiming an intent the
      // disk might not hold yet. One small JSON write is worth the wait.
      await patchEngineIntent(path, { supplyDesired: true }).catch(() => {})
      return c.json(res)
    } catch (e: any) {
      return c.json({ error: `failed to spawn supply: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/swarm/manager — spawn the in-app commander (司令官) ----------
  // Body: { path, cols?, rows?, fresh? }. Launches ONE interactive claude PTY in the
  // project's PRIMARY checkout (NOT a worktree) running the /manage skill — the
  // conversational commander the owner talks to (status / merge / advise),
  // complementing the autonomous orchestrator engine. No worktree is created
  // (the commander operates on the primary checkout), so there is nothing to
  // tear down — stopping it is a plain terminal kill (DELETE /api/terminal/:id).
  // Owner-only + validated + preflighted exactly like /supply; bypass +
  // SWARM_MANAGER=1 (set in swarmManager) — a role TAG, not a guard opt-in:
  // the WORKER-ONLY PreToolUse veto never polices the trusted commander.
  // RESUMES the project's previous commander conversation by default (the response's
  // `resumed` says which happened) — and a resumed commander re-reads the Board
  // before it speaks, because the engine's in-memory roster did NOT survive the
  // restart even though the conversation did. `fresh:true` opts out (swarmSessions.ts).
  // --- POST /api/swarm/supply/stop — the owner turns the supply desk OFF -----
  // Body: { path }. Kills every live supply-desk PTY in the project and clears
  // the persisted supplyDesired flag — the counterpart of the spawn route's
  // set. The UI used to DELETE the raw terminal id, which stopped the desk but
  // could never speak to intent; with boot auto-resume in play (0803), a stop
  // that forgets to clear the flag would resurrect a desk the owner just
  // closed, every restart, forever. Owner-gated + validated like every
  // /api/swarm/* write.
  .post('/api/swarm/supply/stop', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    const stopped = stopSwarmSupplyDesks(path)
    await patchEngineIntent(path, { supplyDesired: false }).catch(() => {})
    return c.json({ ok: true, stopped })
  })
  .post('/api/swarm/manager', async (c) => {
    // OWNER-ONLY gate (see /api/swarm/worker): the commander session is an
    // owner-only control-plane spawn. Non-owner / signed-out → 403, before any
    // body parse / path validation.
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)

    // Preflight BEFORE spawning: a missing/signed-out claude would open its own
    // OAuth browser and orphan a PTY. Same machine-readable 503 as /supply.
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)

    // Env preflight (git/shell): the /og-manage CONVERSATION this launches runs
    // git constantly (status/merge/branch -d — swarmManager.ts), so unlike
    // /supply this still requires git to be INSTALLED (requireGit stays at its
    // true default); it only skips the "is this project itself a git repo"
    // check (requireGitRepo:false) — the commander desk's own server code never
    // shells out to git, only the claude session it launches does, and that
    // session's git commands run in the project's primary checkout regardless.
    const envPre = await swarmEnvPreflight(path, { force: true, requireGitRepo: false })
    if (!envPre.ok) {
      return c.json(
        { error: envPre.issues.map((i) => i.message).join(' '), envIssues: envPre.issues.map((i) => i.id) },
        503,
      )
    }

    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    try {
      // Default: RESUME the project's persisted commander conversation when claude
      // can still load it (swarmSessions.ts). The resumed commander is ordered to
      // re-read the Board first — its conversation survived the restart, the
      // engine's in-memory roster did not. `fresh:true` forces a new conversation.
      const fresh = body?.fresh === true
      const res = await spawnSwarmManager({ projectPath: path, cols, rows, fresh })
      return c.json(res)
    } catch (e: any) {
      return c.json({ error: `failed to spawn manager: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/swarm/manager/say — relay ONE message to the commander -------
  // Body: { path, text }. The RUNTIME-AGNOSTIC way to speak to the commander
  // desk, and the reason it exists is the phone.
  //
  // The owner reaches OPEN GROUND from outside through the SUPPLY desk, which
  // stays on a PTY precisely because Remote Control only works there. Supply can
  // read everything (「状況」) and file cards, but relaying an instruction —
  // 「swarm/X をマージして」 — used to mean knowing the commander's terminal id and
  // POSTing raw keystrokes to /api/terminal/:id/input, which is wrong twice: it
  // does not exist for an SDK commander, and even on a PTY it is the same
  // half-typed-input hazard the engine's notice path had to grow two refusals
  // for. One endpoint, one seam (swarmManagerRuntime.sayToManagerDesk), and the
  // caller never learns which runtime answered.
  //
  // Owner-gated + path-validated like every /api/swarm/* write. Never spawns:
  // "there is no commander desk" is reported (404), not fixed — waking a desk is
  // a decision with a model cost, and it belongs to the engine's reflex or the
  // owner's button, not to a relayed sentence.
  .post('/api/swarm/manager/say', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    if (!text) return c.json({ error: 'text is required' }, 400)
    if (text.length > MAX_MANAGER_SAY) return c.json({ error: 'text too large' }, 400)
    // A desk asked to stop is CLOSED — it refuses every push — so speaking to it
    // is not "held, try later", it is nobody home. Filtering here makes the
    // phone窓口 answer 404 (「司令官の卓が立っていません」) instead of telling the
    // owner their message is queued behind a busy desk that will never read it
    // (cycle-3 finding; same list, same question as adoption).
    const desk = listManagerDesks(path).find((d) => !d.stopping) ?? null
    if (!desk) return c.json({ error: 'no commander desk is running in this project' }, 404)
    const res = sayToManagerDesk(desk, text, { deliverable: noticeDeliverable })
    // held ≠ failed: a PTY desk mid-generation (or with a half-typed draft) is
    // asked again later rather than clobbered, and the caller is TOLD which it
    // was so it can say "届けました" or "今は取り込み中なので後で" honestly.
    return c.json({
      delivered: res.ok,
      runtime: desk.runtime,
      ...(res.heldBecause ? { heldBecause: res.heldBecause } : {}),
    })
  })
  // --- POST /api/swarm/manager/beat — the commander's heartbeat (card B) ------
  // The `/og-manage` commander curls this at each integration phase boundary (it
  // drives the app API for everything else too) so the engine can tell a HUNG desk
  // from a healthy one and RESUSCITATE it (swarmOrchestrator Part B). Owner-gated +
  // path-validated like every /api/swarm/* write; the write itself is best-effort
  // (a missed beat only looks like brief silence to the monitor). Body: { path,
  // phase?, note? }.
  .post('/api/swarm/manager/beat', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    const phase = typeof body?.phase === 'string' ? body.phase : undefined
    const note = typeof body?.note === 'string' ? body.note : undefined
    const ok = await writeManagerHeartbeat(path, { phase, note })
    return c.json({ ok })
  })
  // --- POST /api/swarm/worktree/remove — tear a worker worktree down ---------
  // Body: { path, worktree, force? }. `force` (the kill/abandon case) lets a
  // dirty mid-implementation tree be removed; without it a dirty worktree is
  // kept (removed:false). The central-only guard lives in removeSwarmWorktree.
  .post('/api/swarm/worktree/remove', async (c) => {
    // OWNER-ONLY gate (see /api/swarm/worker): tearing a worktree down is a
    // control-plane action, restricted to the signed-in owner. Non-owner/
    // signed-out → 403, before any body parse / path validation.
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    const worktree = typeof body?.worktree === 'string' ? body.worktree : ''
    if (!worktree) return c.json({ error: 'worktree is required' }, 400)
    const force = body?.force === true
    try {
      const res = await removeSwarmWorktree(path, worktree, { force })
      return c.json(res)
    } catch (e: any) {
      return c.json({ error: `failed to remove worktree: ${e?.message ?? e}` }, 500)
    }
  })
  // --- GET /api/swarm/orchestrator — the commander engine's state ------------
  // Query: ?path= . Returns SwarmOrchestratorState { running, manualStop (+ its
  // persisted half manualStopPersisted — the durable "owner stopped this by hand"
  // record that survives a restart), workers, log, maxWorkers, manager (the
  // commander desk's own heartbeat — phase/note/updatedAt + server-clock
  // freshness, read directly from ~/.openground/swarm/<repoKey>/manager.json so
  // the Swarm tab can show the post-worker inspection minutes; null when never
  // written/unreadable), … }. A project whose engine was never started reads
  // back as a stopped empty state (the manager heartbeat still surfaces — a
  // human-opened desk beats without an engine). Owner-only + validated, like
  // the rest of /api/swarm/*.
  // PURE READ-ONLY (idempotent, K8): this GET is polled by BOTH the Swarm hook AND
  // the display-only Board worker-map (BoardModule), so it must NEVER mutate/spawn
  // — a GET that spawned workers was a review MUST_FIX (the Board's "never touch
  // the engine" contract). Autonomy is STRICT opt-in via POST /orchestrator/start
  // (the old drain-tick auto-start was removed — card eadb25e6).
  .get('/api/swarm/orchestrator', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    const path = c.req.query('path') ?? ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json(await getOrchestratorState(path))
  })
  // --- GET /api/swarm/workers — the SERVER-TRUTH worker list -----------------
  // Query: ?path= . Returns SwarmWorkersResponse { workers: SwarmWorkerRecord[] }.
  // Unifies live PTYs, the engine's own roster, and heartbeat files so a worker
  // started ANY way — engine dispatch, the Board 実行 button, or a direct
  // `POST /api/swarm/worker` (curl/SDK) — shows up here, closing the registry
  // gap the two other name-based sources (localStorage / engine-only roster)
  // each missed. PURE READ-ONLY, polled by the Swarm worker tab. Owner-only +
  // validated, like the rest of /api/swarm/*.
  .get('/api/swarm/workers', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    const path = c.req.query('path') ?? ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json({ workers: await listSwarmWorkers(path) })
  })
  // --- GET /api/swarm/preflight — the git/shell env gate, surfaced up front --
  // Query: ?path= . Returns { ok, issues: [{ id, message }] } from
  // swarmEnvPreflight, exposed as a plain read so the Swarm tab can show every
  // unmet prerequisite BEFORE the owner ever presses a launch button, instead of
  // only discovering it as a failed-spawn 503. Uses the DEFAULT (requireGitRepo:
  // true) — the /worker view — since worker dispatch is the swarm's core
  // capability; a non-git project still gets supply/manager (they pass
  // requireGitRepo:false and are unaffected by a notAGitRepo answer here).
  // PURE READ-ONLY, owner-only + validated like the rest of /api/swarm/*.
  .get('/api/swarm/preflight', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    const path = c.req.query('path') ?? ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json(await swarmEnvPreflight(path))
  })
  // --- POST /api/swarm/orchestrator/drain-tick — the Swarm surface's tick -----
  // Body: { path }. A pure idempotent state read of the (possibly never-started)
  // engine: since card eadb25e6 (release blocker) it NO LONGER auto-starts a stopped
  // engine — merely having the Swarm pane open (incl. one restored on app launch)
  // must not spin up workers, so autonomy is STRICT opt-in via POST /start. Kept as
  // a POST separate from the GET above for back-compat with the useSwarmEngine poll
  // that drives it (and as the seam where a future consent-carrying tick would go).
  // Returns SwarmOrchestratorState. Owner-only + validated, exactly like /start.
  .post('/api/swarm/orchestrator/drain-tick', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json(await drainTickOrchestrator(path))
  })
  // --- GET /api/swarm/notifications — the FATAL swarm notifications (bell) ----
  // The in-app half of the escalation safety valve: the server-persisted fatal
  // events (newest-first) the Ground お知らせ bell renders. Machine-wide (not
  // per-project), so no path. Owner-only — a non-owner gets 403 and the bell
  // simply shows none (the client tolerates a non-ok fetch). Read-state is tracked
  // by the SAME /api/notifications read endpoint as collab invites.
  .get('/api/swarm/notifications', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    return c.json<AppNotificationsResponse>({ notifications: await listSwarmNotifications() })
  })
  // --- POST /api/swarm/notifications/handled — the owner dealt with one row ---
  // Body: { id }. Stamps `handledAt` so the Swarm tab's needs-attention feed stops
  // showing it. DISTINCT from the bell's read-state (/api/notifications/read):
  // "seen" is written wholesale when the bell opens, and wiring the feed to it
  // would empty the swarm's work list the first time the owner glanced at the
  // bell. Nothing is deleted — the row stays in the store and in the bell.
  // Idempotent, so a double-click / retry is harmless. Owner-only.
  .post('/api/swarm/notifications/handled', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) return c.json({ error: 'id is required' }, 400)
    await markSwarmNotificationHandled(id)
    return c.json({ ok: true })
  })
  // --- POST /api/swarm/orchestrator/start — turn autonomous drain ON ---------
  // Body: { path }. Starts the per-project drain+dispatch loop (idempotent). The
  // engine itself spawns workers via the existing B primitive (spawnSwarmWorker —
  // interactive claude PTY, never `claude -p`/SDK) and moves cards todo→doing
  // through the project's own Board HTTP API. Preflights claude up front, so a
  // missing/signed-out CLI is a fast 503 (same body as POST /api/swarm/worker)
  // rather than a silently idle engine. Owner-only + validated.
  .post('/api/swarm/orchestrator/start', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    try {
      return c.json(await startOrchestrator(path))
    } catch (e: any) {
      // Same machine-readable 503 the worker route returns when claude is
      // missing / signed out, so the client shows one sign-in affordance.
      if (e instanceof ClaudeNotReadyError) return c.json(e.body, 503)
      return c.json({ error: `failed to start orchestrator: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/swarm/orchestrator/stop — turn autonomous drain OFF ---------
  // Body: { path }. Stops dispatching (idempotent). Already-running workers are
  // LEFT ALONE (the manual control plane owns their teardown); the existing
  // manual spawn (POST /api/swarm/worker) is unaffected either way. Owner-only.
  .post('/api/swarm/orchestrator/stop', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json(await stopOrchestrator(path))
  })
  // --- POST /api/swarm/orchestrator/worker/stop — STOP one engine worker -------
  // Body: { path, terminalId }. The owner halts a SINGLE autonomous worker: the
  // engine tears down its worktree + kills its `claude` PTY and parks its Board
  // card in 'blocked' (so the running engine doesn't immediately re-dispatch the
  // card just halted), freeing the slot. Idempotent — an unknown id (already gone,
  // or a manual-spawn worker the engine never owned) is a no-op. The engine acts
  // only on its OWN workers; a manual worker is stopped via the existing
  // /api/swarm/worktree/remove. Returns the full SwarmOrchestratorState. Owner-only.
  .post('/api/swarm/orchestrator/worker/stop', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    const terminalId = typeof body?.terminalId === 'string' ? body.terminalId : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!terminalId) return c.json({ error: 'terminalId is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json(await stopOrchestratorWorker(path, terminalId))
  })
  // (POST /api/swarm/orchestrator/automerge was RETIRED 2026-07-16 — the auto-wake-
  // the-commander reflex is always armed while the engine runs, so the separate
  // toggle is gone and the route 404s like any unknown /api/* path. Merge consent
  // stays per-card: the [hold] title prefix + the commander's high-risk force-hold.)
  // --- POST /api/swarm/orchestrator/review/resolve — resolve a stuck review card -
  // Body: { path, taskId, target:'blocked'|'todo' }. The owner takes a review card
  // the engine can NOT auto-land (a real rebase conflict, or one that keeps failing
  // verification) OUT of review so it never sits there forever: 'blocked' parks it
  // for manual resolution, 'todo' requeues it for a fresh worker. The engine clears
  // the card's conflict flag + its conflict/verify memos and tears down any
  // leftover worker. Idempotent — a card not currently in review is a no-op.
  // Returns the full SwarmOrchestratorState. Owner-only + validated.
  .post('/api/swarm/orchestrator/review/resolve', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
    const target = body?.target === 'todo' ? 'todo' : body?.target === 'blocked' ? 'blocked' : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!taskId) return c.json({ error: 'taskId is required' }, 400)
    if (!target) return c.json({ error: 'target must be blocked or todo' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json(await resolveOrchestratorReview(path, taskId, target))
  })
  // --- POST /api/swarm/orchestrator/selfsupply — arm/disarm self-supply (b3fbbfba) -
  // Body: { path, enabled:boolean }. Toggles the engine proposing its OWN
  // improvement cards (discovered from tsc/lint/test/anomalies/TODOs) into todo. A
  // SEPARATE switch from autonomy (start/stop) and auto-integrate, default OFF.
  // Even when ON, a proposed card is owner-approval-gated (see /approve below): the
  // engine FILLS todo but never auto-dispatches what it proposed. Ignition waits
  // for the rest of the safety net to land — until then this stays OFF.
  // Owner-only + validated, like the rest of /api/swarm/*.
  .post('/api/swarm/orchestrator/selfsupply', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    if (typeof body?.enabled !== 'boolean') return c.json({ error: 'enabled is required' }, 400)
    return c.json(await setSelfSupply(path, body.enabled))
  })
  // --- POST /api/swarm/orchestrator/overseer — arm/disarm the OVERSEER (EPIC C) ----
  // Body: { path, enabled:boolean }. Toggles the autonomous proxy-you BRAINSTEM (the
  // THIRD toggle — D1): it watches the swarm and, on judgment edges, wakes a one-off
  // brain (fire-and-forget) or raises to the human inbox. SEPARATE from autonomy
  // (start/stop) / selfSupply, default OFF, in-memory (a restart re-arms
  // OFF — K2). ASYMMETRIC: an explicit autonomy OFF CLEARS it (the owner re-arms every
  // session). Owner-only + validated, like the rest of /api/swarm/* (K3). GET carries
  // no mutation (K8); this POST is the only path that sets `enabled` true.
  // L3: the brain's one-off PTY is ALWAYS kernel-sandboxed on macOS (network
  // loopback + the allowlist egress proxy — swarmOverseerBrain, NOT gated on the
  // owner experiment), so the warning fires only where that close is UNAVAILABLE
  // (off-darwin / sandbox-exec gone): there the brain runs on the permission-layer
  // stop-gap alone (a structural READ-ONLY design + budget still hold).
  .post('/api/swarm/orchestrator/overseer', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    if (typeof body?.enabled !== 'boolean') return c.json({ error: 'enabled is required' }, 400)
    const state = await setOverseer(path, body.enabled)
    // Surface the L3 warning to the UI when ARMING on a host where the brain's
    // structural egress close cannot exist (non-darwin, or sandbox-exec removed) —
    // it signals the reduced containment honestly. On macOS the brain is always
    // sandboxed regardless of the owner experiment, so no warning fires there.
    const sandboxWarning = body.enabled && !brainSandboxAvailable()
    return c.json({ ...state, sandboxWarning })
  })
  // --- POST /api/swarm/orchestrator/overseer/dismiss — forget the restore reminder --
  // Body: { path }. card 2b: clears the persisted `overseer:true` in engine.json so the
  // one-click restore banner stops appearing. Arms NOTHING and disarms nothing — it is
  // purely "I saw it, don't ask again". A SEPARATE endpoint from …/overseer on purpose:
  // POSTing { enabled:false } there is a NO-OP while the banner is up (the overseer is
  // already disarmed, so setOverseer's change-guard skips the persist) — the d1d6d704
  // dismiss trap. Owner-only + validated, like the rest of /api/swarm/* (K3).
  .post('/api/swarm/orchestrator/overseer/dismiss', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json(await dismissOverseerReminder(path))
  })
  // --- POST /api/swarm/orchestrator/selfsupply/approve — approve a proposed card --
  // Body: { path, cardId }. The owner green-lights ONE self-supplied (engine-
  // proposed) card for dispatch: sets selfSupplyApproved on the card so
  // selectDispatch stops skipping it. The per-card runaway gate — a self-supplied
  // card never spawns a worker until this runs. Idempotent (a non-self-supplied /
  // already-approved / absent card is a no-op). Owner-only + validated.
  .post('/api/swarm/orchestrator/selfsupply/approve', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    const cardId = typeof body?.cardId === 'string' ? body.cardId : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!cardId) return c.json({ error: 'cardId is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json(await approveSelfSupplyCard(path, cardId))
  })
  // ─── Escalations inbox (C1 — docs/OVERSEER_DESIGN.md §8) ───────────────────
  // The HUMAN VALVE: questions the swarm could not (or must not) answer land
  // here and wait for the real user. All owner-gated (the routes sweep in
  // swarmSafety.routes.test.ts covers them automatically); the persisted record
  // is the source of truth — the bell/OS toast are best-effort side channels.
  //
  // --- GET /api/swarm/escalations — the inbox (newest-first) -----------------
  // Query: ?path= (optional) filters to one project (validated when present);
  // ?status= (optional) filters to one lifecycle state — the SwarmModule panel
  // polls ?status=open every 10s, so resolved history (and its expanded PTY
  // captures) doesn't ride every poll. PURE READ (K8).
  .get('/api/swarm/escalations', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    const path = c.req.query('path') ?? ''
    if (path && !(await validateProjectPath(path))) {
      return c.json({ error: 'path not allowed' }, 403)
    }
    const statuses = ['open', 'answered', 'injected', 'dismissed'] as const
    const status = statuses.find((s) => s === c.req.query('status'))
    return c.json<EscalationsResponse>({
      escalations: await listEscalations({
        ...(path ? { projectPath: path } : {}),
        ...(status ? { status } : {}),
      }),
    })
  })
  // --- POST /api/swarm/escalations/open — raise a question to the user -------
  // Body: { path, question, context, plainQuestion?, whyEscalated, receiptKey?,
  //         taskId?, branch?, runtime?, terminalId?, sdkSessionId?, proxyDraft? }.
  // `runtime` + the ONE handle it names is the blocked worker's ADDRESS — an
  // SDK worker CANNOT be named by terminalId (it is the empty string).
  // Idempotent on receiptKey while
  // an 'open' record exists (returns {deduped:true} + the existing record).
  // Until C-core lands this is the manual/verification entry point; the
  // overseer will call openEscalation() in-process.
  .post('/api/swarm/escalations/open', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    const question = typeof body?.question === 'string' ? body.question.trim() : ''
    const context = typeof body?.context === 'string' ? body.context.trim() : ''
    if (!question) return c.json({ error: 'question is required' }, 400)
    if (!context) return c.json({ error: 'context is required' }, 400)
    if (question.length > MAX_ESCALATION_QUESTION) return c.json({ error: 'question too large' }, 400)
    if (context.length > MAX_ESCALATION_CONTEXT) return c.json({ error: 'context too large' }, 400)
    // 平易文 — optional; when present it becomes the owner-facing primary text.
    const plainQuestion = typeof body?.plainQuestion === 'string' ? body.plainQuestion.trim() : ''
    if (plainQuestion.length > MAX_ESCALATION_PLAIN_QUESTION) {
      return c.json({ error: 'plainQuestion too large' }, 400)
    }
    const whys: EscalationWhy[] = ['irreversible', 'insufficient-info', 'policy']
    const whyEscalated = whys.find((w) => w === body?.whyEscalated)
    if (!whyEscalated) {
      return c.json({ error: 'whyEscalated must be irreversible | insufficient-info | policy' }, 400)
    }
    // proxyDraft is optional but, when present, must be WELL-FORMED — silently
    // dropping a malformed draft would hide the proxy's provisional answer from
    // the owner (fail-loud beats fail-quiet on the decision surface).
    let proxyDraft: EscalationProxyDraft | undefined
    if (body?.proxyDraft !== undefined) {
      const d = body.proxyDraft
      const confidences = ['high', 'medium', 'low']
      if (
        !d ||
        typeof d !== 'object' ||
        typeof d.answer !== 'string' ||
        !confidences.includes(d.confidence) ||
        typeof d.isAbstention !== 'boolean'
      ) {
        return c.json({ error: 'proxyDraft is malformed' }, 400)
      }
      if (d.answer.length > MAX_ESCALATION_ANSWER) {
        return c.json({ error: 'proxyDraft.answer too large' }, 400)
      }
      proxyDraft = { answer: d.answer, confidence: d.confidence, isAbstention: d.isAbstention }
    }
    // The blocked worker's ADDRESS. `runtime` is what tells openEscalation which
    // handle names the worker (pty ⇔ terminalId, sdk ⇔ sdkSessionId —
    // workerRuntime.ts); without it an SDK raise stores NO address and the
    // owner's answer can never reach that worker. This route accepted only
    // `terminalId`, so every raise from outside the engine — the commander skill,
    // a manual curl, any external tool — could name a PTY worker and nothing else.
    // Unknown values are REFUSED rather than coerced: silently downgrading an
    // 'sdk' typo to a PTY record is exactly the un-answerable row this fixes.
    if (body?.runtime !== undefined && body.runtime !== 'pty' && body.runtime !== 'sdk') {
      return c.json({ error: 'runtime must be pty | sdk' }, 400)
    }
    const runtime: 'pty' | 'sdk' | undefined = body?.runtime
    // ⚠ A RUNTIME WITHOUT ITS HANDLE IS AN ADDRESS OF NOBODY. Validating the
    // word alone let `{runtime:'sdk', terminalId:'pty-typo'}` through with a 200
    // (measured), and `addressOf` then stored a record with no handle at all —
    // an inbox row the owner can answer into the void, reported as delivered.
    // The identity invariant is not "one of two words is present", it is
    // pty ⇔ terminalId / sdk ⇔ sdkSessionId, so the pair must agree HERE, at the
    // only door an external raiser comes through.
    if (runtime) {
      const handle = runtime === 'sdk' ? body?.sdkSessionId : body?.terminalId
      if (typeof handle !== 'string' || handle.length === 0) {
        return c.json(
          {
            error: `runtime '${runtime}' requires a non-empty ${
              runtime === 'sdk' ? 'sdkSessionId' : 'terminalId'
            } — an escalation with no handle can never be answered`,
          },
          400,
        )
      }
    }
    // Id-like fields ride an UNCAPPED persisted file — bound them here too
    // (the module clamps defensively as well). ⚠ EVERY id-like key must be in
    // this list: a new field added to the passthrough below but not here is a
    // hole straight into the file, which is how `sdkSessionId` must NOT arrive.
    for (const k of ['receiptKey', 'taskId', 'branch', 'terminalId', 'sdkSessionId'] as const) {
      if (typeof body?.[k] === 'string' && body[k].length > MAX_ESCALATION_SHORT_FIELD) {
        return c.json({ error: `${k} too large` }, 400)
      }
    }
    try {
      const res = await openEscalation({
        projectPath: path,
        question,
        context,
        ...(plainQuestion ? { plainQuestion } : {}),
        whyEscalated,
        receiptKey: typeof body?.receiptKey === 'string' ? body.receiptKey : undefined,
        taskId: typeof body?.taskId === 'string' ? body.taskId : undefined,
        branch: typeof body?.branch === 'string' ? body.branch : undefined,
        ...(runtime ? { runtime } : {}),
        terminalId: typeof body?.terminalId === 'string' ? body.terminalId : undefined,
        sdkSessionId: typeof body?.sdkSessionId === 'string' ? body.sdkSessionId : undefined,
        proxyDraft,
      })
      return c.json<EscalationOpenResponse>(res)
    } catch (e: any) {
      return c.json({ error: `failed to open escalation: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/swarm/escalations/answer — the owner's decision --------------
  // Body: { id, answer }. Persists the answer, writes the Q→A back to you-corpus
  // memory (owner answers only), then delivers: injects into the LIVE worker PTY
  // or queues for the card's next dispatch. Re-answering an answered record is
  // an idempotent no-op; answering a dismissed one is 409.
  .post('/api/swarm/escalations/answer', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const id = typeof body?.id === 'string' ? body.id : ''
    const answer = typeof body?.answer === 'string' ? body.answer.trim() : ''
    if (!id) return c.json({ error: 'id is required' }, 400)
    if (!answer) return c.json({ error: 'answer is required' }, 400)
    if (answer.length > MAX_ESCALATION_ANSWER) return c.json({ error: 'answer too large' }, 400)
    try {
      const res = await answerEscalation(id, answer)
      return c.json<EscalationAnswerResponse>(res)
    } catch (e: any) {
      if (e instanceof EscalationNotFoundError) return c.json({ error: 'escalation not found' }, 404)
      if (e instanceof EscalationStateError) return c.json({ error: e.message }, 409)
      return c.json({ error: `failed to answer escalation: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/swarm/escalations/dismiss — close unanswered -----------------
  // Body: { id }. Nothing is injected, nothing is learned. Idempotent on
  // already-resolved records.
  .post('/api/swarm/escalations/dismiss', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) return c.json({ error: 'id is required' }, 400)
    try {
      return c.json<EscalationDismissResponse>({ escalation: await dismissEscalation(id) })
    } catch (e: any) {
      if (e instanceof EscalationNotFoundError) return c.json({ error: 'escalation not found' }, 404)
      return c.json({ error: `failed to dismiss escalation: ${e?.message ?? e}` }, 500)
    }
  })
  // --- GET /api/swarm/quota — which model tiers are cooling -------------------
  // The cooling table swarmQuota keeps in memory, plus the two answers dispatch
  // derives from it (launchTier / allCoolingUntil). Process-wide, not
  // per-project — a quota belongs to the `claude` subscription, not a repo — so
  // there is no `path` and no validateProjectPath.
  .get('/api/swarm/quota', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    const now = Date.now()
    // Fold in the PERSISTED cooling marks before answering. Boot kicks this too
    // (server/index.ts) and it is memoized, so this is a no-op after the first
    // call — but awaiting it here is what makes the FIRST read after a restart
    // truthful rather than a clean slate. That clean slate was the bug: the app
    // forgot fable was dry, reported launchTier:"fable", and burned a session
    // discovering it again (2026-07-13).
    await ensureCoolingTableLoaded(now)
    return c.json<SwarmQuotaResponse>(quotaSnapshot(now, await getAllowedModelTiers()))
  })
  // --- POST /api/swarm/quota/cool — cool a tier BY HAND -----------------------
  // Body: { tier, untilMs } or { tier, minutes }. The operator's steering wheel
  // when the automatic sensor is wrong or late: mark a tier dry and every
  // subsequent launch (worker, reviewer, commander) resolves one rung down the
  // ladder — WITHOUT stopping the engine, and without a source patch, which a
  // packaged .app cannot take. Same table, same lazy expiry as the sensor's own
  // marks, so a manual cool self-heals at `until`.
  // Fail-closed: an unknown alias is rejected rather than cooled by guess, and
  // `until` must sit in (now, now + MAX_MANUAL_COOLING_MS] so a fat-fingered
  // epoch cannot retire a tier forever.
  .post('/api/swarm/quota/cool', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const tier = body?.tier
    if (!isModelTier(tier)) {
      return c.json({ error: `tier must be one of ${MODEL_TIER_LADDER.join(', ')}` }, 400)
    }
    const now = Date.now()
    // Hydrate before mutating: the persist below serialises the WHOLE table, so
    // writing while the boot load is still outstanding would mirror a table that
    // doesn't yet hold the other tiers' persisted marks. (swarmQuota's chain
    // enforces this ordering internally too — this just makes it explicit on the
    // route that can be the very first caller after a restart.)
    await ensureCoolingTableLoaded(now)
    let until: number
    if (typeof body?.untilMs === 'number' && Number.isFinite(body.untilMs)) {
      until = body.untilMs
    } else if (typeof body?.minutes === 'number' && Number.isFinite(body.minutes)) {
      until = now + body.minutes * 60_000
    } else {
      return c.json({ error: 'untilMs or minutes is required' }, 400)
    }
    if (until <= now) return c.json({ error: 'until must be in the future' }, 400)
    if (until > now + MAX_MANUAL_COOLING_MS) {
      return c.json({ error: `until must be within ${MAX_MANUAL_COOLING_MS}ms of now` }, 400)
    }
    markCoolingUntil(tier, until)
    // Await the mirror write, so a 200 here MEANS "on disk". The owner's next move
    // after cooling a tier is often to quit / relaunch the app; a fire-and-forget
    // save could still be in flight when the process dies.
    //
    // And if the write FAILED, say so — 500, not 200. The engine's own sensor path
    // is allowed to shrug off a failed save (a mark it can re-learn is not worth
    // killing the cockpit for), but this route exists BECAUSE the owner is telling
    // us something the sensor can't learn cheaply — "this tier is dry" — and its
    // whole value is that the fact survives the restart. A 200 that quietly meant
    // "in memory only" would put us straight back in the loop this closes: the app
    // relaunches, the mark is gone, and the next dispatch burns a session
    // rediscovering it. The mark IS applied in memory (we don't roll it back — the
    // running engine should still avoid the tier), which is what the message says.
    const flushed = await flushQuotaPersist()
    if (!flushed.persisted) {
      return c.json(
        {
          error:
            `${tier} is cooling in THIS process, but the cooling table could not be persisted — ` +
            `it will be forgotten when the app restarts: ${flushed.error}`,
        },
        500,
      )
    }
    return c.json<SwarmQuotaResponse>(quotaSnapshot(now, await getAllowedModelTiers()))
  })
  // --- POST /api/swarm/quota/uncool — release a tier --------------------------
  // Body: { tier }. Undo a cool (manual or sensor-made) so the tier is available
  // on the next launch. Idempotent: releasing an already-available tier is a
  // no-op that still returns the snapshot.
  .post('/api/swarm/quota/uncool', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const tier = body?.tier
    if (!isModelTier(tier)) {
      return c.json({ error: `tier must be one of ${MODEL_TIER_LADDER.join(', ')}` }, 400)
    }
    const now = Date.now()
    // Same two beats as /cool — and the uncool needs them just as much: hydrate
    // first (else the release lands on a table that hasn't loaded the disk's
    // marks and the persist would drop them), then flush (else a restart right
    // after would faithfully reload the mark the owner just released).
    await ensureCoolingTableLoaded(now)
    clearCooling(tier)
    // A failed save is arguably WORSE here than on /cool: the file still holds the
    // mark, so the next boot would hydrate it and the tier the owner just released
    // would come back cooling. Report that rather than answering 200.
    const flushed = await flushQuotaPersist()
    if (!flushed.persisted) {
      return c.json(
        {
          error:
            `${tier} is released in THIS process, but the cooling table could not be persisted — ` +
            `the old mark is still on disk, so it will be COOLING again after a restart: ${flushed.error}`,
        },
        500,
      )
    }
    return c.json<SwarmQuotaResponse>(quotaSnapshot(now, await getAllowedModelTiers()))
  })
  // --- GET /api/swarm/kpi/landed — the durable landed KPI (外向き着地/週) -----
  // Aggregates every registered project's swarm-landed.json (the ledger the
  // engine writes at promote + land — swarmLandedLedger.ts is the canon) into
  // fixed-length weekly buckets, split 自プロジェクト (self = a checkout of OG
  // itself, by package.json name) vs 外向き (every other project). THE dial the
  // owner steers by:「swarm が自分自身以外に何を着地させているか」. READ-ONLY —
  // it never sweeps, never writes; a project whose folder vanished degrades to
  // zero rows (fail-quiet), never a 500. No `path` param: the registry IS the
  // scope, so there is nothing for a caller to widen.
  .get('/api/swarm/kpi/landed', async (c) => {
    if (!(await hasSwarmOwnerAccess())) return c.json({ error: 'forbidden' }, 403)
    const weeksRaw = Number(c.req.query('weeks') ?? '12')
    const weeks = Number.isFinite(weeksRaw) ? Math.min(26, Math.max(4, Math.floor(weeksRaw))) : 12
    const now = Date.now()
    const settings = await getSettings()
    const projects = settings.projects ?? []
    const empty = weeklyLandedSeries([], { weeks, now })
    const buckets: SwarmLandedWeek[] = empty.map((w) => ({
      weekStart: w.weekStart,
      self: 0,
      external: 0,
    }))
    const perProject: SwarmLandedKpi['perProject'] = []
    const totals = { self: 0, external: 0 }
    const recentCutoff = now - 28 * 24 * 60 * 60 * 1000
    for (const entry of projects) {
      const ledger = await readLandedLedger(entry.path)
      const landed = ledger.filter((e) => e.landedAt)
      if (landed.length === 0) continue
      const self = await isSelfProject(entry.path)
      const series = weeklyLandedSeries(ledger, { weeks, now })
      for (let i = 0; i < buckets.length; i++) {
        if (self) buckets[i].self += series[i].landed
        else buckets[i].external += series[i].landed
      }
      const recent = landed.filter((e) => {
        const t = Date.parse(e.landedAt ?? '')
        return Number.isFinite(t) && t >= recentCutoff
      }).length
      perProject.push({
        id: entry.id,
        name: entry.displayName?.trim() || basename(entry.path),
        path: entry.path,
        self,
        total: landed.length,
        recent,
      })
      if (self) totals.self += landed.length
      else totals.external += landed.length
    }
    // Busiest projects first so the panel's list reads as a ranking.
    perProject.sort((a, b) => b.total - a.total)
    return c.json<SwarmLandedKpi>({ weeks: buckets, perProject, totals })
  })
