// server/routes/terminal.ts — F-terminal group Hono sub-router.
// Thin adapter port of src/app/api/terminal/* route handlers. All
// src/lib/server/terminal logic stays IDENTICAL; only the HTTP plumbing
// changes: NextResponse.json(x[,{status}]) -> c.json(x[,status]),
// req.json() -> c.req.json(), [id] -> :id via c.req.param('id').
//
// Notes vs the Next version:
// - `export const dynamic/runtime` are Next-only and intentionally dropped;
//   Hono streams/serves natively.
// - Only the create route touches validateProjectPath (it validates `cwd`).
//   The input/resize/[id] routes never received a project path, so the
//   security boundary is unchanged (we don't add a guard where there wasn't one).
// - These routes parse the body manually (no zod schema exists for terminal),
//   matching the original loose `body?.field` reads + try/catch on invalid JSON.
//
// Mounted by the Integration phase: app.route('/', terminalRoutes) in server/app.ts.

import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { buildTaskPrompt } from '@/lib/server/taskPrompt'
import { centralWorktreesDir } from '@/lib/server/paths'
import { projectUUIDFromPath } from '@/lib/server/projectDataPath'
import { Hono } from 'hono'
import { readProjectData, validateProjectPath } from '@/lib/server/projectData'
import {
  createTerminal,
  getTerminal,
  killTerminal,
  listActiveTerminals,
  resizeTerminal,
  writeInput,
} from '@/lib/server/terminal'
import { launchClaude, launchOptsFromPrefs } from '@/lib/server/claudeTerminal'

import { bracketedPaste } from '@/lib/server/pastePrompt'

// Cap on the claude launch `initialPrompt`. It's written verbatim to a tmpdir
// file (claudeTerminal.launchClaude), so an unbounded value lets a caller
// exhaust /tmp. Real seeds (a task title, a short instruction) are well under a
// KB; 256 KiB is a generous ceiling that still keeps disk use trivial. The
// same cap bounds the paste-task injection string (one PTY write).
const MAX_INITIAL_PROMPT = 256 * 1024

export const terminalRoutes = new Hono()
  // --- POST /api/terminal — start a terminal in a project dir (validates cwd) ---
  .post('/api/terminal', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
    if (!cwd) return c.json({ error: 'cwd is required' }, 400)
    if (!(await validateProjectPath(cwd))) return c.json({ error: 'cwd not allowed' }, 403)
    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    try {
      const info = createTerminal({ cwd, cols, rows })
      return c.json(info)
    } catch (e: any) {
      return c.json({ error: `failed to start terminal: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/setup-terminal — a shell for first-run onboarding ----------
  // The onboarding install guide (Onboarding → OnboardingSetup) embeds a real
  // terminal so the user can install + sign in to the `claude` CLI before any
  // project exists. There is therefore NO project to validate the cwd against,
  // so this deliberately opens a plain login shell in the user's HOME instead
  // of going through validateProjectPath. Scope: a local single-user tool where
  // the user can already open a terminal in any project — a home-cwd shell at
  // first run widens nothing they couldn't already do. The id-based
  // stream/input/resize/delete routes are unchanged (they never took a path).
  .post('/api/setup-terminal', async (c) => {
    let body: any = {}
    try {
      body = await c.req.json()
    } catch {
      /* size is optional — fall back to defaults */
    }
    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    try {
      const info = createTerminal({ cwd: homedir(), cols, rows })
      return c.json(info)
    } catch (e: any) {
      return c.json({ error: `failed to start terminal: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/terminal/claude — launch an interactive `claude` session in a
  // project dir. OPEN GROUND mints the session id (so it owns the JSONL path)
  // and launches `claude --session-id <uuid>` inside a PTY the user types into.
  // Returns the TerminalInfo (tag:'claude' + agentSessionId) so the client can
  // attach BOTH a raw xterm view and a rendered chat view to the same session.
  .post('/api/terminal/claude', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    // Reject an oversized prompt before any auth/filesystem work — it's a cheap
    // request-shape check and stops a /tmp-exhaustion payload at the door.
    if (typeof body?.initialPrompt === 'string' && body.initialPrompt.length > MAX_INITIAL_PROMPT) {
      return c.json({ error: 'initialPrompt too large' }, 400)
    }
    const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
    if (!cwd) return c.json({ error: 'cwd is required' }, 400)
    if (!(await validateProjectPath(cwd))) return c.json({ error: 'cwd not allowed' }, 403)
    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    const model = typeof body?.model === 'string' && body.model ? body.model : undefined
    const initialPrompt =
      typeof body?.initialPrompt === 'string' && body.initialPrompt
        ? body.initialPrompt
        : undefined
    // Project data feeds the launch (the path already passed
    // validateProjectPath, so this read cannot escape the registry):
    //  - launch (PERSONAL prefs): permission mode + model — applied to EVERY
    //    claude launched in this project through this route (task launches
    //    and plain dock launches alike).
    const projectData = await readProjectData(cwd)
    // Board-card launch (taskWorktrees): the client starts a PLAIN claude
    // session — the task prompt is injected LATER via paste-task, never
    // auto-sent — but on a git project the session must already hold
    // --add-dir on the central worktrees dir, so file edits inside the task
    // worktree don't trip path prompts. (The old structured `task` body param
    // — server-composed initialPrompt that auto-started the task — is gone.)
    let addDir: string | undefined
    if (body?.taskWorktrees === true) {
      const isGit = await stat(join(cwd, '.git')).then(() => true).catch(() => false)
      if (isGit) {
        const worktreesDir = centralWorktreesDir(await projectUUIDFromPath(cwd))
        await mkdir(worktreesDir, { recursive: true })
        addDir = worktreesDir
      }
    }
    try {
      const agentSessionId = randomUUID()
      // Interactive, subscription-only. The default permission mode keeps
      // prompts visible in the raw terminal view; the project's personal
      // launch prefs can relax it (acceptEdits/plan/bypass) or pin a model.
      // An explicit request-body model still wins over the stored pref.
      const prefs = launchOptsFromPrefs(projectData.launch)
      const ref = launchClaude({
        cwd,
        agentSessionId,
        cols,
        rows,
        model: model ?? prefs.model,
        initialPrompt,
        addDir,
        permissionMode: prefs.permissionMode,
      })
      return c.json(ref.info)
    } catch (e: any) {
      return c.json({ error: `failed to start claude: ${e?.message ?? e}` }, 500)
    }
  })
  // --- GET /api/terminal/active — live PTY cwds + claude working/waiting ---
  // Feeds the Ground's per-card "terminal active" indicator (cwds) and the
  // claude beacon refinement (ActiveTerminalsResponse). Read-only and
  // deliberately unvalidated: it returns ONLY the cwds of terminals this app
  // itself spawned (each cwd already passed validateProjectPath at create
  // time), never anything derived from the request. Declared BEFORE the
  // dynamic /api/terminal/:id route so the static `active` segment is never
  // captured as an id.
  .get('/api/terminal/active', (c) => c.json(listActiveTerminals()))
  // --- GET /api/terminal/:id — fetch terminal info ---
  .get('/api/terminal/:id', (c) => {
    const info = getTerminal(c.req.param('id'))
    if (!info) return c.json({ error: 'not found' }, 404)
    return c.json(info)
  })
  // --- DELETE /api/terminal/:id — kill a terminal ---
  .delete('/api/terminal/:id', (c) => {
    const ok = killTerminal(c.req.param('id'))
    if (!ok) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })
  // --- POST /api/terminal/:id/input — write to terminal stdin ---
  .post('/api/terminal/:id/input', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const data = typeof body?.data === 'string' ? body.data : ''
    const ok = writeInput(c.req.param('id'), data)
    if (!ok) return c.json({ error: 'not found or finished' }, 404)
    return c.json({ ok: true })
  })
  // --- POST /api/terminal/:id/paste-task — inject a Board task prompt -------
  // Into a LIVE claude PTY's input box, via bracketed paste, WITHOUT sending
  // it: the server re-reads the task from tasks.json (the card may have been
  // edited since launch), composes the full task prompt (branch/worktree
  // protocol + shared config), and writes ESC[200~ <prompt> ESC[201~ with NO
  // trailing newline — the user reviews and hits Enter themselves. This is the
  // post-split companion of the plain `taskWorktrees` launch above.
  .post('/api/terminal/:id/paste-task', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
    if (!taskId) return c.json({ error: 'taskId is required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    // Read project config (the path passed validateProjectPath, so this read
    // cannot escape the registry). The TASK fields prefer the live values the
    // client sends — its drawer edits are debounced (~350ms) before they reach
    // tasks.json, and a just-created card may not be on disk at all, so reading
    // only the disk copy would paste stale or missing content. Fall back to the
    // persisted task when the client doesn't override (and require at least one
    // source of a title).
    const projectData = await readProjectData(path)
    const stored = projectData.tasks.find((t) => t.id === taskId)
    const liveTitle = typeof body?.title === 'string' ? body.title : undefined
    const liveNotes = typeof body?.notes === 'string' ? body.notes : undefined
    const title = (liveTitle ?? stored?.title ?? '').trim()
    if (!title) return c.json({ error: 'task not found' }, 404)
    const notes = liveNotes ?? stored?.notes
    const isGit = await stat(join(path, '.git')).then(() => true).catch(() => false)
    let worktreesDir: string | null = null
    if (isGit) {
      worktreesDir = centralWorktreesDir(await projectUUIDFromPath(path))
      await mkdir(worktreesDir, { recursive: true })
    }
    const prompt = buildTaskPrompt({
      cwd: path,
      task: { id: taskId, title, notes },
      port: Number(process.env.PORT) || 47776,
      worktreesDir,
      config: projectData.config,
    })
    if (prompt.length > MAX_INITIAL_PROMPT) {
      return c.json({ error: 'task content too large' }, 400)
    }
    // Bracketed paste, no trailing newline: insert, never auto-send.
    const ok = writeInput(c.req.param('id'), bracketedPaste(prompt))
    if (!ok) return c.json({ error: 'not found or finished' }, 404)
    return c.json({ ok: true })
  })
  // --- POST /api/terminal/:id/resize — resize the pty ---
  .post('/api/terminal/:id/resize', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const cols = Number(body?.cols)
    const rows = Number(body?.rows)
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return c.json({ error: 'cols/rows required' }, 400)
    }
    const ok = resizeTerminal(c.req.param('id'), cols, rows)
    if (!ok) return c.json({ error: 'not found or finished' }, 404)
    return c.json({ ok: true })
  })
