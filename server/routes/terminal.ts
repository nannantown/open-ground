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
import { join, sep } from 'path'
import { composeTaskPrompt } from '@/lib/server/composeTaskPrompt'
import { centralWorktreesDir, customModuleDir } from '@/lib/server/paths'
import { getCustomTabRole } from '@/lib/server/roles'
import { getModule } from '@/lib/server/customModules'
import { projectDataDir, projectUUIDFromPath } from '@/lib/server/projectDataPath'
import { isShared } from '@/lib/server/sharedData'
import { Hono } from 'hono'
import { readProjectData, validateProjectPath } from '@/lib/server/projectData'
import {
  ackFlowStream,
  createTerminal,
  getTerminal,
  killTerminal,
  listActiveTerminals,
  resizeTerminal,
  writeInput,
} from '@/lib/server/terminal'
import { launchClaude, launchOptsFromPrefs } from '@/lib/server/claudeTerminal'
import { CLAUDE_EFFORTS, type ClaudeEffort } from '@/lib/types'
import { TASK_ASSETS_SUBDIR } from '@/lib/server/taskAssets'
import { probeClaudeCli } from '@/lib/server/claudeCli'

import { bracketedPaste, buildCustomModulePrompt } from '@/lib/server/pastePrompt'

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
    // Pre-flight: a missing `claude` CLI means a doomed spawn (the PTY would
    // just print "command not found" and exit). Answer 503 with the
    // machine-readable flag — same contract as /api/project/describe and the
    // canvas AI routes — so the client can show "install claude" copy instead
    // of a generic launch failure. (probeClaudeCli caches for ~10s.)
    const probe = await probeClaudeCli()
    if (!probe.installed) {
      return c.json({ error: probe.message, claudeMissing: true }, 503)
    }
    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    const model = typeof body?.model === 'string' && body.model ? body.model : undefined
    let initialPrompt =
      typeof body?.initialPrompt === 'string' && body.initialPrompt
        ? body.initialPrompt
        : undefined
    // Project data feeds the launch (the path already passed
    // validateProjectPath, so this read cannot escape the registry):
    //  - launch (PERSONAL prefs): permission mode + model + effort — applied
    //    to EVERY claude launched in this project through this route (task
    //    launches and plain dock launches alike).
    //  - tasks: the 実行 path below re-reads the card for its stored run
    //    settings + content fallback.
    const projectData = await readProjectData(cwd)
    // Board-card 実行 (body.task): the drawer's Run button. The server
    // composes the FULL task prompt (same composer as paste-task — live
    // title/notes/attachments win over the disk copy, per-card flow override
    // applies) and passes it as the positional initialPrompt, so claude
    // starts working on the task immediately. This deliberately reinstates
    // the auto-started launch (2026-06-12): the drawer no longer auto-spawns
    // a plain session on open — running a task is one explicit button.
    const taskBody = body?.task && typeof body.task === 'object' ? body.task : undefined
    const taskId = typeof taskBody?.id === 'string' ? taskBody.id : ''
    if (taskBody && !taskId) return c.json({ error: 'task.id is required' }, 400)
    // Per-card overrides (live drawer values → stored card.run → project
    // prefs). flow/effort are validated to their enums — junk degrades to the
    // next fallback. model is DELIBERATELY a free string (a pinned full model
    // id like 'claude-sonnet-4-6' must pass — same philosophy as the defaults
    // strip keeping an off-list saved value selectable); it is shell-quoted
    // in buildClaudeArgv, and an unknown alias just errors visibly inside the
    // user's own terminal at spawn.
    let runModel: string | undefined
    let runEffort: ClaudeEffort | undefined
    if (taskId) {
      const stored = projectData.tasks.find((t) => t.id === taskId)
      const liveFlow =
        taskBody.flow === 'merge' || taskBody.flow === 'pr' ? taskBody.flow : undefined
      const composed = await composeTaskPrompt(cwd, projectData, {
        taskId,
        title: typeof taskBody.title === 'string' ? taskBody.title : undefined,
        notes: typeof taskBody.notes === 'string' ? taskBody.notes : undefined,
        attachmentIds: Array.isArray(taskBody.attachmentIds)
          ? (taskBody.attachmentIds as unknown[]).filter(
              (x): x is string => typeof x === 'string',
            )
          : undefined,
        flow: liveFlow,
      })
      if (!composed) return c.json({ error: 'task not found' }, 404)
      if (composed.length > MAX_INITIAL_PROMPT) {
        return c.json({ error: 'task content too large' }, 400)
      }
      initialPrompt = composed
      const liveModel =
        typeof taskBody.model === 'string' && taskBody.model.trim()
          ? taskBody.model.trim()
          : undefined
      const storedModel = stored?.run?.model?.trim() || undefined
      runModel = liveModel ?? storedModel
      const asEffort = (v: unknown): ClaudeEffort | undefined =>
        CLAUDE_EFFORTS.includes(v as ClaudeEffort) ? (v as ClaudeEffort) : undefined
      runEffort = asEffort(taskBody.effort) ?? asEffort(stored?.run?.effort)
    }
    // Board-card launch (taskWorktrees): on a git project the session must
    // already hold --add-dir on the central worktrees dir, so file edits
    // inside the task worktree don't trip path prompts.
    let addDir: string[] | undefined
    if (body?.taskWorktrees === true) {
      const dirs: string[] = []
      const isGit = await stat(join(cwd, '.git')).then(() => true).catch(() => false)
      if (isGit) {
        const worktreesDir = centralWorktreesDir(await projectUUIDFromPath(cwd))
        await mkdir(worktreesDir, { recursive: true })
        dirs.push(worktreesDir)
      }
      // Card attachments: in normal (central) mode the bytes live OUTSIDE the
      // repo (~/.openground/projects/<uuid>/task-assets/), so a session whose
      // cwd is the repo trips a path prompt on every attachment Read —
      // pre-authorize that dir too (git or not). In git-shared mode the assets
      // sit inside the repo (.openground/board/assets/), already covered by cwd.
      if (!(await isShared(cwd))) {
        const assetsDir = join(await projectDataDir(cwd), TASK_ASSETS_SUBDIR)
        await mkdir(assetsDir, { recursive: true })
        dirs.push(assetsDir)
      }
      if (dirs.length) addDir = dirs
    }
    try {
      const agentSessionId = randomUUID()
      // Interactive, subscription-only. The default permission mode keeps
      // prompts visible in the raw terminal view; the project's personal
      // launch prefs can relax it (acceptEdits/plan/bypass) or pin a model /
      // effort. Precedence: per-card run settings → explicit request-body
      // model → stored project prefs → CLI default.
      const prefs = launchOptsFromPrefs(projectData.launch)
      const ref = launchClaude({
        cwd,
        agentSessionId,
        cols,
        rows,
        model: runModel ?? model ?? prefs.model,
        effort: runEffort ?? prefs.effort,
        initialPrompt,
        addDir,
        permissionMode: prefs.permissionMode,
      })
      return c.json(ref.info)
    } catch (e: any) {
      return c.json({ error: `failed to start claude: ${e?.message ?? e}` }, 500)
    }
  })
  // --- POST /api/terminal/custom-module — claude in a custom module dir ------
  // The custom-tab sidebar's "Edit with Claude" session (docs/CUSTOM_TABS_PLAN.md).
  // The module dir is NOT a registered project, so — like /api/setup-terminal —
  // this deliberately does not go through validateProjectPath. The boundary is
  // narrower instead: owner-only, the request carries ONLY a moduleId (never a
  // raw cwd), the id is uuid-validated + must exist in index.json, and the cwd
  // is resolved SERVER-side via customModuleDir(). Plain claude, no prompt —
  // the brush-up text is injected UNSENT later via paste-custom-module below.
  .post('/api/terminal/custom-module', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
    const moduleId = typeof body?.moduleId === 'string' ? body.moduleId : ''
    if (!moduleId) return c.json({ error: 'moduleId is required' }, 400)
    // getModule regex-validates the id BEFORE any path is built from it.
    const def = await getModule(moduleId)
    if (!def) return c.json({ error: 'module not found' }, 404)
    // Same pre-flight as /api/terminal/claude: a missing CLI is a doomed spawn,
    // answer the machine-readable 503 instead.
    const probe = await probeClaudeCli()
    if (!probe.installed) {
      return c.json({ error: probe.message, claudeMissing: true }, 503)
    }
    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    const cwd = customModuleDir(def.id)
    await mkdir(cwd, { recursive: true })
    try {
      // appContext:false — the injected board/canvas usage card is meaningless
      // (and misleading) outside a registered project; this session only edits
      // the module's source file.
      const ref = launchClaude({
        cwd,
        agentSessionId: randomUUID(),
        cols,
        rows,
        appContext: false,
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
    // Compose via the shared composer (the path passed validateProjectPath,
    // so the project-data read cannot escape the registry): live drawer
    // values win over the disk copy, the card's stored run.flow shapes the
    // completion-flow section, attachments resolve to absolute paths. Same
    // prompt as the 実行 launch path — see composeTaskPrompt.ts. Deliberately
    // NO live flow/model/effort overrides here (unlike 実行's body.task):
    // this route pastes UNSENT text the user reviews and can edit before
    // Enter, and model/effort are launch flags a paste can't change anyway.
    const projectData = await readProjectData(path)
    const prompt = await composeTaskPrompt(path, projectData, {
      taskId,
      title: typeof body?.title === 'string' ? body.title : undefined,
      notes: typeof body?.notes === 'string' ? body.notes : undefined,
      attachmentIds: Array.isArray(body?.attachmentIds)
        ? (body.attachmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined,
    })
    if (!prompt) return c.json({ error: 'task not found' }, 404)
    if (prompt.length > MAX_INITIAL_PROMPT) {
      return c.json({ error: 'task content too large' }, 400)
    }
    // Bracketed paste, no trailing newline: insert, never auto-send.
    const ok = writeInput(c.req.param('id'), bracketedPaste(prompt))
    if (!ok) return c.json({ error: 'not found or finished' }, 404)
    return c.json({ ok: true })
  })
  // --- POST /api/terminal/:id/paste-custom-module — brush-up prompt ----------
  // Inject the custom module's label/description + editing instructions into
  // the sidebar claude session's input box, UNSENT (same bracketed-paste / no
  // trailing newline contract as paste-task — the user reviews and hits Enter).
  // Owner-only, and the target PTY must actually be the one running in this
  // module's dir, so a moduleId can never write into an unrelated terminal.
  .post('/api/terminal/:id/paste-custom-module', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    if ((await getCustomTabRole()) !== 'owner') return c.json({ error: 'forbidden' }, 403)
    const moduleId = typeof body?.moduleId === 'string' ? body.moduleId : ''
    if (!moduleId) return c.json({ error: 'moduleId is required' }, 400)
    const def = await getModule(moduleId)
    if (!def) return c.json({ error: 'module not found' }, 404)
    const info = getTerminal(c.req.param('id'))
    if (!info) return c.json({ error: 'not found or finished' }, 404)
    if (info.cwd !== customModuleDir(def.id)) {
      return c.json({ error: 'terminal does not belong to this module' }, 403)
    }
    const prompt = buildCustomModulePrompt(def)
    if (prompt.length > MAX_INITIAL_PROMPT) {
      return c.json({ error: 'module content too large' }, 400)
    }
    // Bracketed paste, no trailing newline: insert, never auto-send.
    const ok = writeInput(info.id, bracketedPaste(prompt))
    if (!ok) return c.json({ error: 'not found or finished' }, 404)
    return c.json({ ok: true })
  })
  // --- POST /api/terminal/:id/paste — generic UNSENT paste -------------------
  // The generalized sibling of paste-task: write caller-supplied text into a
  // LIVE PTY's input box via bracketed paste, with NO trailing newline — the
  // user reviews and presses Enter themselves. Used by the Board drawer's
  // "Review with claude" (F064), whose instruction text is composed
  // client-side. `path` is required purely as the auth gate (same
  // validateProjectPath boundary as every path-accepting route); the same
  // 256 KiB cap as paste-task bounds the single PTY write.
  .post('/api/terminal/:id/paste', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path is required' }, 400)
    const text = typeof body?.text === 'string' ? body.text : ''
    if (!text) return c.json({ error: 'text is required' }, 400)
    if (text.length > MAX_INITIAL_PROMPT) return c.json({ error: 'text too large' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    // Bind the PTY to the authorizing path: a path for project A must not be
    // able to write into a PTY running in project B (or in A's worktrees'
    // sibling). The pool knows every session's cwd.
    const id = c.req.param('id')
    const info = getTerminal(id)
    if (!info) return c.json({ error: 'not found or finished' }, 404)
    const inScope = info.cwd === path || info.cwd.startsWith(path + sep)
    const inWorktrees = await validateProjectPath(info.cwd).catch(() => false)
    if (!inScope && !(inWorktrees && (await projectUUIDFromPath(info.cwd).catch(() => null)) === (await projectUUIDFromPath(path).catch(() => '')))) {
      return c.json({ error: 'terminal does not belong to this project' }, 403)
    }
    // Bracketed paste, no trailing newline: insert, never auto-send.
    const ok = writeInput(id, bracketedPaste(text))
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
  // --- POST /api/terminal/:id/ack — flow-control ACK from a stream client ---
  // The SSE consumer reports how much of the `data` chunk stream it has
  // actually written to xterm (`bytes` = UTF-16 code units, the same .length
  // both sides count); terminal.ts pauses/resumes the PTY on the un-acked
  // backlog. A client whose ACKs stop while jammed (background-throttled
  // renderer) doesn't hold claude forever: after FLOW_PAUSE_CAP_MS its stream
  // is force-ended and it must repaint from the reconnect init (terminal.ts /
  // sse.ts). Like input/resize, this route is id-based and never receives a
  // project path, so there is no validateProjectPath boundary to add (same
  // unchanged-boundary note as the file header). A missing or finished PTY
  // still answers 200 {ok:true}: the client fires ACKs fire-and-forget, so one
  // landing right after exit is a normal race, not an error worth surfacing.
  .post('/api/terminal/:id/ack', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const streamId = typeof body?.streamId === 'string' ? body.streamId : ''
    if (!streamId) return c.json({ error: 'streamId is required' }, 400)
    const bytes = Number(body?.bytes)
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return c.json({ error: 'bytes must be a positive number' }, 400)
    }
    ackFlowStream(c.req.param('id'), streamId, bytes)
    return c.json({ ok: true })
  })
