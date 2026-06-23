// server/routes/swarm.ts — the in-app swarm control plane (tmux-free).
//
// POST /api/swarm/worker          — spawn a worker: isolated central worktree +
//                                   one interactive `claude` PTY + a /order goal
//                                   typed in once the TUI is ready.
// POST /api/swarm/worktree/remove — tear a worker worktree down (kill/complete).
//
// Thin adapters over src/lib/server/swarmWorker.ts. OWNER-ONLY: both routes
// gate on the signed-in app-login role (getCustomTabRole, owner-only) at the
// very top, so a non-owner / signed-out caller gets 403 before any body parse,
// path validation, or git — closing the local curl/SDK direct-call hole. Then
// every path-accepting route runs validateProjectPath (the registry allowlist)
// BEFORE any work, and the spawn route also runs the shared claude preflight so
// a missing/signed-out CLI fails fast (503) instead of orphaning a worktree+PTY.
// Subscription-only: the worker is an interactive `claude` PTY (launchClaude),
// never `claude -p`/SDK.

import { Hono } from 'hono'
import { getCustomTabRole } from '@/lib/server/roles'
import { readProjectData, validateProjectPath } from '@/lib/server/projectData'
import { claudeRunPreflight } from '@/lib/server/claudePreflight'
import { spawnSwarmWorker, removeSwarmWorktree } from '@/lib/server/swarmWorker'

// The /order goal (card title + notes) is typed into the TUI as ONE line. A
// Board goal is a short observable completion condition; 8 KiB is a generous
// ceiling that still keeps the single PTY write trivial.
const MAX_GOAL = 8 * 1024

export const swarmRoutes = new Hono()
  // --- POST /api/swarm/worker — spawn an in-app worker ----------------------
  // Body: { path, taskId? , title?, notes?, hint?, cols?, rows? }
  //  - taskId  → the goal is read from that Board card (title + notes).
  //  - title   → explicit goal (curl / non-card callers); notes optional.
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
    try {
      // WORKER: no env passed → the SWARM_MANAGER=1 guard stays inert (pass).
      const res = await spawnSwarmWorker({
        projectPath: path,
        title,
        notes,
        hint,
        cols,
        rows,
      })
      return c.json(res)
    } catch (e: any) {
      return c.json({ error: `failed to spawn worker: ${e?.message ?? e}` }, 500)
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
