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
// POST /api/swarm/orchestrator/start — turn the autonomous drain+dispatch ON.
// POST /api/swarm/orchestrator/stop  — turn it OFF (manual spawn untouched).
//
// Thin adapters over src/lib/server/swarmWorker.ts + swarmSupply.ts +
// swarmOrchestrator.ts. OWNER-ONLY:
// every route gates on the signed-in app-login role (getCustomTabRole,
// owner-only) at the very top, so a non-owner / signed-out caller gets 403
// before any body parse, path validation, or git — closing the local curl/SDK
// direct-call hole (the UI hiding the tab is NOT the only guard). Then every
// path-accepting route runs validateProjectPath (the registry allowlist) BEFORE
// any work, and the spawn routes also run the shared claude preflight so a
// missing/signed-out CLI fails fast (503) instead of orphaning a PTY (+worktree).
// Subscription-only: every spawn is an interactive `claude` PTY (launchClaude),
// never `claude -p`/SDK.

import { Hono } from 'hono'
import { getCustomTabRole } from '@/lib/server/roles'
import { readProjectData, writeProjectData, validateProjectPath } from '@/lib/server/projectData'
import { claudeRunPreflight } from '@/lib/server/claudePreflight'
import { spawnSwarmWorker, removeSwarmWorktree } from '@/lib/server/swarmWorker'
import { spawnSwarmSupply } from '@/lib/server/swarmSupply'
import { spawnSwarmManager } from '@/lib/server/swarmManager'
import {
  startOrchestrator,
  stopOrchestrator,
  stopOrchestratorWorker,
  resolveOrchestratorReview,
  getOrchestratorState,
  setAutoMerge,
  ClaudeNotReadyError,
} from '@/lib/server/swarmOrchestrator'

// The /order goal (card title + notes) is typed into the TUI as ONE line. A
// Board goal is a short observable completion condition; 8 KiB is a generous
// ceiling that still keeps the single PTY write trivial.
const MAX_GOAL = 8 * 1024

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
  .post('/api/swarm/worker', async (c) => {
    // OWNER-ONLY gate (runs first, before body parse / path validation): the
    // in-app swarm spawns claude PTYs + git worktrees, so the control plane is
    // restricted to the signed-in owner. Same server-side role resolution as the
    // custom-tab routes (identity from the app-login session; the
    // OPENGROUND_OWNER_EMAILS env override is honoured). Non-owner/signed-out → 403.
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
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

    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    const hint = typeof body?.hint === 'string' ? body.hint : undefined
    // RESTART: an existing central worktree to relaunch in place. Validated to sit
    // under this project's central worktrees dir by spawnSwarmWorker
    // (resolveExistingSwarmWorktree) — a crafted path throws there, not escapes.
    const worktree = typeof body?.worktree === 'string' && body.worktree ? body.worktree : undefined
    try {
      // WORKER: no env passed → the SWARM_MANAGER=1 guard stays inert (pass).
      const res = await spawnSwarmWorker({
        projectPath: path,
        title,
        notes,
        hint,
        worktree,
        cols,
        rows,
      })
      // CLAIM the card (todo→doing, recording its branch) so the autonomous
      // orchestrator engine doesn't ALSO grab this still-todo card on its next
      // pass and spawn a SECOND worker for it (twin-dispatch). Mirrors the engine's
      // own todo→doing move. Best-effort + only for a card still in `todo`: a
      // re-dispatch of a doing/review card is left where it is, and a kept CAS
      // write just leaves the card in todo (no worse than before this guard).
      if (taskId) {
        try {
          const fresh = await readProjectData(path)
          const cardNow = fresh.tasks.find((t) => t.id === taskId)
          const columnNow = cardNow?.boardColumn ?? (cardNow?.done ? 'done' : 'todo')
          if (cardNow && columnNow === 'todo') {
            await writeProjectData(
              path,
              {
                ...fresh,
                tasks: fresh.tasks.map((t) =>
                  t.id === taskId
                    ? { ...t, boardColumn: 'doing' as const, done: false, branch: res.branch }
                    : t,
                ),
              },
              { expectUpdatedAt: typeof fresh.updatedAt === 'string' ? fresh.updatedAt : undefined },
            )
          }
        } catch {
          /* best-effort claim — the worker is already live; a kept write is fine */
        }
      }
      return c.json(res)
    } catch (e: any) {
      return c.json({ error: `failed to spawn worker: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/swarm/supply — spawn the in-app supply officer (補給官) ------
  // Body: { path, cols?, rows? }. Launches ONE interactive claude PTY in the
  // project's PRIMARY checkout (NOT a worktree) running the /supply skill, which
  // turns the user's vague requests into observable Board:todo cards. No
  // worktree is created (supply only talks + writes the Board), so there is
  // nothing to tear down — stopping it is a plain terminal kill (DELETE
  // /api/terminal/:id). Owner-only + validated + preflighted exactly like
  // /worker; bypass + SWARM_MANAGER=1 (set in swarmSupply) so the guard blocks
  // any stray destructive git in the real checkout.
  .post('/api/swarm/supply', async (c) => {
    // OWNER-ONLY gate (see /api/swarm/worker): the supply session is an
    // owner-only control-plane spawn. Non-owner / signed-out → 403, before any
    // body parse / path validation.
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
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

    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    try {
      const res = await spawnSwarmSupply({ projectPath: path, cols, rows })
      return c.json(res)
    } catch (e: any) {
      return c.json({ error: `failed to spawn supply: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/swarm/manager — spawn the in-app commander (司令官) ----------
  // Body: { path, cols?, rows? }. Launches ONE interactive claude PTY in the
  // project's PRIMARY checkout (NOT a worktree) running the /manage skill — the
  // conversational commander the owner talks to (status / merge / advise),
  // complementing the autonomous orchestrator engine. No worktree is created
  // (the commander operates on the primary checkout), so there is nothing to
  // tear down — stopping it is a plain terminal kill (DELETE /api/terminal/:id).
  // Owner-only + validated + preflighted exactly like /supply; bypass +
  // SWARM_MANAGER=1 (set in swarmManager) so the guard blocks any stray
  // destructive git in the real checkout.
  .post('/api/swarm/manager', async (c) => {
    // OWNER-ONLY gate (see /api/swarm/worker): the commander session is an
    // owner-only control-plane spawn. Non-owner / signed-out → 403, before any
    // body parse / path validation.
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
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

    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    try {
      const res = await spawnSwarmManager({ projectPath: path, cols, rows })
      return c.json(res)
    } catch (e: any) {
      return c.json({ error: `failed to spawn manager: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/swarm/worktree/remove — tear a worker worktree down ---------
  // Body: { path, worktree, force? }. `force` (the kill/abandon case) lets a
  // dirty mid-implementation tree be removed; without it a dirty worktree is
  // kept (removed:false). The central-only guard lives in removeSwarmWorktree.
  .post('/api/swarm/worktree/remove', async (c) => {
    // OWNER-ONLY gate (see /api/swarm/worker): tearing a worktree down is a
    // control-plane action, restricted to the signed-in owner. Non-owner/
    // signed-out → 403, before any body parse / path validation.
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
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
  // Query: ?path= . Returns SwarmOrchestratorState { running, workers, log,
  // maxWorkers }. A project whose engine was never started reads back as a
  // stopped empty state. Owner-only + validated, like the rest of /api/swarm/*.
  .get('/api/swarm/orchestrator', async (c) => {
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
    const path = c.req.query('path') ?? ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    return c.json(await getOrchestratorState(path))
  })
  // --- POST /api/swarm/orchestrator/start — turn autonomous drain ON ---------
  // Body: { path }. Starts the per-project drain+dispatch loop (idempotent). The
  // engine itself spawns workers via the existing B primitive (spawnSwarmWorker —
  // interactive claude PTY, never `claude -p`/SDK) and moves cards todo→doing
  // through the project's own Board HTTP API. Preflights claude up front, so a
  // missing/signed-out CLI is a fast 503 (same body as POST /api/swarm/worker)
  // rather than a silently idle engine. Owner-only + validated.
  .post('/api/swarm/orchestrator/start', async (c) => {
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
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
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
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
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
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
  // --- POST /api/swarm/orchestrator/automerge — arm/disarm auto-integration ---
  // Body: { path, enabled:boolean }. Toggles Card③ (auto-merge completed review
  // cards onto the trunk). A SEPARATE switch from autonomy (start/stop), default
  // OFF: when OFF the engine only classifies review cards and shows "統合可"; when
  // ON it lands the fast-forwardable / cleanly-rebasable ones (FF / rebase only,
  // never force, never auto-resolving a conflict) and moves them review→done.
  // Only ever acts while the engine is running — the global stop halts it too.
  // Owner-only + validated, like the rest of /api/swarm/*.
  .post('/api/swarm/orchestrator/automerge', async (c) => {
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
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
    return c.json(await setAutoMerge(path, body.enabled))
  })
  // --- POST /api/swarm/orchestrator/review/resolve — resolve a stuck review card -
  // Body: { path, taskId, target:'blocked'|'todo' }. The owner takes a review card
  // the engine can NOT auto-land (a real rebase conflict, or one that keeps failing
  // verification) OUT of review so it never sits there forever: 'blocked' parks it
  // for manual resolution, 'todo' requeues it for a fresh worker. The engine clears
  // the card's conflict flag + its conflict/verify memos and tears down any
  // leftover worker. Idempotent — a card not currently in review is a no-op.
  // Returns the full SwarmOrchestratorState. Owner-only + validated.
  .post('/api/swarm/orchestrator/review/resolve', async (c) => {
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
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
