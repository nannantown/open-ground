// server/routes/project.ts — Group A (project) Hono sub-router.
// Thin adapters over the existing src/lib/server/* logic (CONTRACT §3.8: that
// layer is the source of truth, never reimplemented here). Each handler is a
// byte-for-byte behavioural port of the matching src/app/api/project/**
// Next.js route: same methods, same status codes, same error shapes.
//
// Declares FULL /api/... paths; app.ts mounts with app.route('/', projectRoutes)
// so the prefix stays empty. The Integration phase owns the mount.

import { Hono } from 'hono'
import { execFile as execFileCb, spawn } from 'child_process'
import { promisify } from 'util'
import { rename, rm, stat } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import {
  ProjectDataConflictError,
  readProjectData,
  writeProjectData,
  validateProjectPath,
} from '@/lib/server/projectData'
import {
  updateProjectEntryPath,
  removeProjectEntry,
  relocateProjectEntry,
  setProjectDisplayName,
} from '@/lib/server/registry'
import { projectCentralDir } from '@/lib/server/paths'
import {
  getSettings,
  setSettings,
  getCanvas,
  setCanvas,
} from '@/lib/server/store'
import { normalizeOpenApps } from '@/lib/server/openApps'
import { EditorNotFoundError, openInEditor, openWithApp } from '@/lib/server/editorCli'
import { detectInstalledEditors, resolveAllowedEditorBundle } from '@/lib/server/editorDetect'
import {
  getBranchChanges,
  getFileDiff,
  isSafeRepoRelFile,
} from '@/lib/server/branchChanges'
import { listProjectBranches } from '@/lib/server/gitBranches'
import { checkMergedBranches } from '@/lib/server/mergedBranches'
import { fetchPrInfo } from '@/lib/server/prInfo'
import { ensureReviewWorktree, ReviewWorktreeError } from '@/lib/server/reviewWorktree'
import {
  listProjectWorktrees,
  cleanProjectWorktrees,
} from '@/lib/server/worktreeCleanup'
import {
  createCanvas,
  deleteCanvas,
  listCanvases,
  readCanvasFile,
  renameCanvas,
  reorderCanvases,
  saveCanvasFile,
  setActiveCanvas,
} from '@/lib/server/canvasData'
import type {
  BoardColumn,
  ProjectData,
  ProjectTask,
  CanvasFile,
  ProjectSkillsResponse,
  CreateSkillResponse,
  OpenApp,
} from '@/lib/types'
import { listProjectSkills, listGlobalSkills } from '@/lib/server/projectSkills'
import {
  createGlobalSkill,
  MAX_REQUEST_LEN,
  SkillCreationBusyError,
} from '@/lib/server/generateSkill'
import {
  MAX_TASK_ASSET_BYTES,
  deleteTaskAsset,
  isValidTaskAssetId,
  readTaskAsset,
  writeTaskAsset,
} from '@/lib/server/taskAssets'
import { extForMime } from '@/lib/server/canvasImages'
import { validateName } from './_shared'
import { requireProjectPath } from '../middleware/projectPath'
import { claudeRunPreflight } from '@/lib/server/claudePreflight'
import { generateProjectDescription } from '@/lib/server/generateDescription'
import { generateTaskTitle } from '@/lib/server/generateTaskTitle'
import { getPromptLang } from '@/lib/server/promptLang'

const execFileAsync = promisify(execFileCb)

// ── Module-level helpers (hoisted above the chain) ───────────────────────────
// In the prior statement style these sat interleaved between route
// registrations. Method-chaining needs one uninterrupted expression, so every
// handler-dependency is declared up front here.

const detectLaunchMode = async (appPath: string): Promise<'open' | 'cwd'> => {
  try {
    const { stdout } = await execFileAsync('plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      join(appPath, 'Contents', 'Info.plist'),
    ])
    const plist = JSON.parse(stdout)
    const docTypes: any[] = Array.isArray(plist?.CFBundleDocumentTypes)
      ? plist.CFBundleDocumentTypes
      : []
    const accepts = docTypes.some((dt) => {
      const types: string[] = Array.isArray(dt?.LSItemContentTypes)
        ? dt.LSItemContentTypes
        : []
      return types.includes('public.folder') || types.includes('public.directory')
    })
    return accepts ? 'open' : 'cwd'
  } catch {
    return 'open'
  }
}

/** Validate an editor choice from the client before we `open -a` it. Allowlist:
 *  a real `.app` bundle path (a detected editor or a Finder-picked app), OR a
 *  bare name that matches a currently-detected editor. Anything else → null.
 *  Returns a clean {name, path, mode:'open'} OpenApp. */
const isLaunchableEditor = async (raw: unknown): Promise<OpenApp | null> => {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as { name?: unknown; path?: unknown }
  const name = typeof e.name === 'string' ? e.name.trim() : ''
  if (!name || name.length > 80) return null
  const path = typeof e.path === 'string' ? e.path.trim() : ''
  if (path) {
    // SECURITY: open -a runs the bundle's embedded binary, so confine a
    // client-supplied path to a real .app inside the scanned Applications dirs
    // (resolveAllowedEditorBundle realpath's it so symlinks can't escape).
    // Persist the resolved canonical path.
    const real = await resolveAllowedEditorBundle(path)
    return real ? { name, path: real, mode: 'open' } : null
  }
  const detected = await detectInstalledEditors()
  const hit = detected.find((d) => d.name === name)
  return hit ? { name: hit.name, path: hit.path, mode: 'open' } : null
}

// POST /api/project/delete moves the folder to the OS trash. The command is
// platform-branched by buildTrashCommand() below: macOS uses this JXA /
// NSFileManager.trashItemAtURL script; Windows uses PowerShell's VisualBasic
// FileSystem.DeleteDirectory(…SendToRecycleBin); Linux uses `gio trash`.
const TRASH_JXA = `ObjC.import('Foundation');
function run(argv) {
  var fm = $.NSFileManager.defaultManager;
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var ok = fm.trashItemAtURLResultingItemURLError(url, null, null);
  if (!ok) throw new Error('Could not move the folder to the Trash.');
}`

/**
 * Build the OS-native "move folder to the trash" command for `target` on the
 * given platform. Exported so the platform routing is unit-testable without
 * spawning a real process. Returns the execFile (cmd, args) pair — execFile
 * runs WITHOUT a shell, so no token in `args` is ever shell-interpreted.
 *
 * - darwin: Finder Trash via JXA / NSFileManager.trashItemAtURL. The path rides
 *   as a trailing argv (argv[0]) passed UNCHANGED — macOS behaviour is
 *   byte-for-byte what it was before the platform split (no regression).
 * - win32: Windows Recycle Bin via PowerShell's Microsoft.VisualBasic
 *   FileSystem.DeleteDirectory(…, SendToRecycleBin). The path is embedded in a
 *   single-quoted PowerShell string literal (every `'` doubled): `-Command`
 *   re-parses its argument so trailing `$args` are unreliable, and embedding
 *   sidesteps that. The script contains no double quotes, so Node's Windows
 *   argument quoting can't split it. A thrown .NET exception (missing/locked
 *   dir) makes powershell.exe exit non-zero → the caller's catch returns 500.
 * - else (linux/*): freedesktop trash via `gio trash <path>` (trailing argv).
 */
export function buildTrashCommand(
  platform: NodeJS.Platform,
  target: string,
): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    const psPath = target.replace(/'/g, "''")
    const ps =
      `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(` +
      `'${psPath}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', ps],
    }
  }
  if (platform === 'darwin') {
    return { cmd: 'osascript', args: ['-l', 'JavaScript', '-e', TRASH_JXA, target] }
  }
  return { cmd: 'gio', args: ['trash', target] }
}

interface TasksBody {
  path: string
  add?: string[]
  markDone?: string[]
  /** Move cards between board columns (e.g. a task claude finished a PR for
   *  moves to 'review'). Marking 'done' via here also sets done:true. */
  setColumn?: { id: string; column: BoardColumn }[]
  /** Record the pull request opened for a task — claude calls this when its
   *  `gh pr create` succeeds. http(s) URLs only; anything else is ignored. */
  setPrUrl?: { id: string; url: string }[]
  /** Record the task branch claude created (right after `git worktree add`).
   *  Plain branch-name strings only; anything else is ignored. */
  setBranch?: { id: string; branch: string }[]
  /** Stamp / clear a card's "auto-integration conflicted — merge by hand" flag.
   *  The commander engine (Card③) sets it when a rebase conflicts; it is also
   *  cleared automatically whenever a card leaves the review column. */
  setIntegrationConflict?: { id: string; value: boolean }[]
}

// Conservative git branch-name shape: word char first, then word chars, dots,
// slashes, hyphens. Rejects whitespace/control/shell noise a confused session
// might post. (Stricter than git itself — a weird-but-legal name is simply not
// recorded, never a failure.)
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/

const BOARD_COLUMNS: readonly BoardColumn[] = ['todo', 'doing', 'review', 'done', 'blocked']

// ── The chain ────────────────────────────────────────────────────────────────
// All routes are method-chained off the router instance so hc<AppType> on the
// client recovers this group's route tree. Behaviour is identical to the prior
// statement style.

// ── /api/project ───────────────────────────────────────────────────────────
// GET  ?path=  → ProjectData ; PUT ?path= body:ProjectData → saved ProjectData

export const projectRoutes = new Hono()
  .get('/api/project', async (c) => {
  const path = await requireProjectPath(c)
  if (path instanceof Response) return path
  return c.json(await readProjectData(path))
})
  .put('/api/project', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const body = (await c.req.json()) as ProjectData
    try {
      // The body's updatedAt is the snapshot token the client last READ —
      // writeProjectData refuses the write (CAS) when the store has moved on,
      // so a stale window can never wipe newer data (incident 2026-06-10:
      // a pre-share empty board overwrote freshly-shared card files).
      const saved = await writeProjectData(path, body, {
        expectUpdatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined,
      })
      return c.json(saved)
    } catch (e) {
      if (e instanceof ProjectDataConflictError) {
        return c.json({ error: 'conflict: project data changed since it was loaded', conflict: true }, 409)
      }
      throw e
    }
  })
  // ── /api/project/branches ────────────────────────────────────────────────
  // GET ?path= → ProjectBranchesResponse (local git branches, current first).
  // Data source for the Settings "Target branch" select; non-repo → empty.
  .get('/api/project/branches', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    return c.json(await listProjectBranches(path))
  })
  // ── /api/project/merged-branches ─────────────────────────────────────────
  // POST { path, branches (≤50), targetBranch? } → MergedBranchesResponse —
  // which of these task branches already landed in the target branch (pure
  // git ancestry check, no gh; B018/F065). Feeds the Review column's
  // "Merged → Done" chip. Never throws: unjudgeable branches come back
  // 'unknown'.
  .post('/api/project/merged-branches', async (c) => {
    let body: { path?: string; branches?: unknown; targetBranch?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path required' }, 400)
    const branches = body.branches
    if (!Array.isArray(branches) || branches.some((b) => typeof b !== 'string')) {
      return c.json({ error: 'branches must be an array of strings' }, 400)
    }
    if (branches.length > 50) return c.json({ error: 'too many branches (max 50)' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    const targetBranch =
      typeof body.targetBranch === 'string' && body.targetBranch.trim()
        ? body.targetBranch
        : undefined
    return c.json(await checkMergedBranches(path, branches as string[], targetBranch))
  })
  // ── /api/project/pr-info ─────────────────────────────────────────────────
  // POST { path, prUrl } → PrInfoResponse — PR state + diff stats for the
  // drawer's status strip (B023, F058/F085). Every failure mode (gh missing,
  // bad URL, network) is { available: false }, never an error status.
  .post('/api/project/pr-info', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    // Hono caches c.req.json() per request — safe to read again after the guard.
    const body = (await c.req.json().catch(() => ({}))) as { prUrl?: unknown }
    const prUrl = typeof body.prUrl === 'string' ? body.prUrl : ''
    return c.json(await fetchPrInfo(path, prUrl))
  })
  // ── /api/project/open ──────────────────────────────────────────────────
  // GET → { apps } ; POST { path, app } → open folder in app ; PUT { apps } → save list
  .get('/api/project/open', async (c) => {
    const s = await getSettings()
    return c.json({ apps: normalizeOpenApps(s.openApps) })
  })
  .post('/api/project/open', async (c) => {
  const { path, app } = (await c.req.json()) as { path?: string; app?: string }
  if (!path) return c.json({ error: 'path required' }, 400)
  if (!app) return c.json({ error: 'app required' }, 400)
  const s = await getSettings()
  const apps = normalizeOpenApps(s.openApps)
  const entry = apps.find((a) => a.name === app)
  if (!entry) return c.json({ error: 'app not registered' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
  try {
    if (entry.mode === 'cwd' && entry.path) {
      const { stdout } = await execFileAsync('plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        join(entry.path, 'Contents', 'Info.plist'),
      ])
      const exec = String(JSON.parse(stdout)?.CFBundleExecutable || '').trim()
      if (!exec) throw new Error('cannot read executable name from Info.plist')
      const binPath = join(entry.path, 'Contents', 'MacOS', exec)
      const child = spawn(binPath, ['--working-directory', path], {
        cwd: path,
        env: { ...process.env, PWD: path },
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    } else {
      await execFileAsync('open', ['-a', entry.name, path])
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? 'failed to open' }, 500)
  }
})
  .put('/api/project/open', async (c) => {
    const { apps } = (await c.req.json()) as { apps?: unknown }
    if (!Array.isArray(apps)) return c.json({ error: 'apps must be an array' }, 400)
    const cleaned = normalizeOpenApps(apps)
    const s = await getSettings()
    await setSettings({ ...s, openApps: cleaned })
    return c.json({ apps: cleaned })
  })
  // ── /api/project/reveal ───────────────────────────────────────────────────
  // POST { path } → reveal the project folder in the OS file manager.
  // macOS: `open`, Windows: `explorer`, Linux/other: `xdg-open`.
  // `explorer` exits non-zero even on success, so we fire-and-forget via spawn
  // and never inspect the exit code.
  // ── /api/project/review-worktree ──────────────────────────────────────────
  // POST { path, branch } → ensure a local checkout of the task branch under
  // the central worktrees dir and return its absolute path (Board flow F061:
  // the reviewer's one-click "try this branch"). The dir passes
  // validateProjectPath, so the client can follow up with /api/project/reveal.
  .post('/api/project/review-worktree', async (c) => {
    let body: { path?: string; branch?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body.path === 'string' ? body.path : ''
    const branch = typeof body.branch === 'string' ? body.branch : ''
    if (!path) return c.json({ error: 'path required' }, 400)
    if (!branch) return c.json({ error: 'branch required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    try {
      const result = await ensureReviewWorktree(path, branch)
      return c.json(result)
    } catch (e) {
      // Machine-readable `code` so the client can show localized copy per
      // failure category instead of echoing this English message verbatim.
      const code = e instanceof ReviewWorktreeError ? e.code : 'git-failed'
      return c.json({ error: e instanceof Error ? e.message : 'checkout failed', code }, 500)
    }
  })
  // ── /api/project/worktrees ────────────────────────────────────────────────
  // GET  ?path=        → { worktrees: ProjectWorktreeInfo[] } — the task/* and
  //                      review-* checkouts under the CENTRAL worktrees dir
  //                      (~/.openground/projects/<uuid>/worktrees/) only; the
  //                      main working tree is never listed (B012 / F082).
  // POST /clean {path} → { removed, skippedDirty } — removes the CLEAN ones
  //                      (dirty = uncommitted changes → always skipped), then
  //                      `git worktree prune`.
  .get('/api/project/worktrees', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    try {
      return c.json({ worktrees: await listProjectWorktrees(path) })
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'failed to list worktrees' }, 500)
    }
  })
  .post('/api/project/worktrees/clean', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    try {
      return c.json(await cleanProjectWorktrees(path))
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'failed to clean worktrees' }, 500)
    }
  })
  .post('/api/project/reveal', async (c) => {
  const { path } = (await c.req.json()) as { path?: string }
  if (!path) return c.json({ error: 'path required' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
  try {
    if (process.platform === 'win32') {
      const child = spawn('explorer', [path], { detached: true, stdio: 'ignore' })
      child.unref()
    } else if (process.platform === 'darwin') {
      await execFileAsync('open', [path])
    } else {
      const child = spawn('xdg-open', [path], { detached: true, stdio: 'ignore' })
      child.unref()
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? 'failed to reveal' }, 500)
  }
})
  // ── /api/project/open-editor ──────────────────────────────────────────────
  // POST { path, editor? } → open the project folder in an editor.
  //   editor present (a choice from the picker) → validate it, then `open -a`.
  //   editor absent → the saved defaultEditor (if any) → else CLI auto-detect
  //   (editorCli: OPENGROUND_EDITOR_CMD env → cursor/code/windsurf/zed → macOS
  //   `open -a`). Nothing found → 503 with a human message.
  .post('/api/project/open-editor', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; editor?: unknown }
    const path = typeof body.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path required' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    let chosen: OpenApp | null = null
    if (body.editor !== undefined && body.editor !== null) {
      chosen = await isLaunchableEditor(body.editor)
      if (!chosen) return c.json({ error: 'editor not launchable' }, 400)
    } else {
      const s = await getSettings()
      if (s.defaultEditor) chosen = await isLaunchableEditor(s.defaultEditor)
    }
    try {
      if (chosen) await openWithApp(path, chosen)
      else await openInEditor(path)
      return c.json({ ok: true })
    } catch (e: any) {
      if (e instanceof EditorNotFoundError) return c.json({ error: e.message }, 503)
      return c.json({ error: e?.message ?? 'failed to open editor' }, 500)
    }
  })
  // ── /api/project/editors ──────────────────────────────────────────────────
  // GET → { editors, default } : code editors detected on this machine (macOS
  // Applications scan; [] elsewhere) + the saved default, so the `<>` button
  // can offer a choice instead of auto-picking one.
  .get('/api/project/editors', async (c) => {
    const [editors, s] = await Promise.all([detectInstalledEditors(), getSettings()])
    // Drop a dead default (its editor was uninstalled) so the one-click button
    // doesn't silently 400 — the UI falls back to showing the chooser.
    let def = s.defaultEditor ?? null
    if (def) {
      const d = def
      const alive = d.path
        ? (await resolveAllowedEditorBundle(d.path)) !== null
        : editors.some((ed) => ed.name === d.name)
      if (!alive) def = null
    }
    // canPick: the Finder .app picker (osascript) is macOS-only. The client uses
    // it to decide whether to offer the chooser on a machine with no detected
    // editors (else it falls back to CLI auto-detection).
    return c.json({ editors, default: def, canPick: process.platform === 'darwin' })
  })
  // ── /api/project/default-editor ────────────────────────────────────────────
  // PUT { editor: OpenApp | null } → remember (or clear) the one-click default.
  .put('/api/project/default-editor', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { editor?: unknown }
    if (body.editor === null) {
      await setSettings({ defaultEditor: null })
      return c.json({ default: null })
    }
    const editor = await isLaunchableEditor(body.editor)
    if (!editor) return c.json({ error: 'editor not launchable' }, 400)
    await setSettings({ defaultEditor: editor })
    return c.json({ default: editor })
  })
  // ── /api/project/branch-changes ───────────────────────────────────────────
  // GET ?path= → BranchChangesResponse (header chip + "Branch changes" modal).
  // Thin adapter: config.targetBranch comes from the project's stored data,
  // the git work lives in src/lib/server/branchChanges.ts.
  .get('/api/project/branch-changes', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    try {
      const data = await readProjectData(path).catch(() => null)
      return c.json(await getBranchChanges(path, data?.config?.targetBranch))
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'failed to read branch changes' }, 500)
    }
  })
  // ── /api/project/file-diff ────────────────────────────────────────────────
  // GET ?path=&file=&scope=working|branch → { diff, truncated }. `file` is a
  // repo-RELATIVE path: absolute paths and `..` segments are rejected before
  // anything reaches git (and git only ever sees it after `--`).
  .get('/api/project/file-diff', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const file = c.req.query('file') ?? ''
    const scope = c.req.query('scope')
    if (!isSafeRepoRelFile(file)) return c.json({ error: 'invalid file path' }, 400)
    if (scope !== 'working' && scope !== 'branch') {
      return c.json({ error: 'scope must be "working" or "branch"' }, 400)
    }
    try {
      const data = await readProjectData(path).catch(() => null)
      return c.json(await getFileDiff(path, file, scope, data?.config?.targetBranch))
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'failed to read diff' }, 500)
    }
  })
  // ── /api/project/skills ───────────────────────────────────────────────────
  // GET ?path= → ProjectSkillsResponse: the Claude Code skills defined inside
  // the project (.claude/skills/<name>/SKILL.md). Read-only; the scan +
  // frontmatter parse live in src/lib/server/projectSkills.ts. A project with no
  // .claude/skills returns { skills: [] } (200), not an error.
  .get('/api/project/skills', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    try {
      const skills = await listProjectSkills(path)
      return c.json<ProjectSkillsResponse>({ skills })
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'failed to read skills' }, 500)
    }
  })
  // ── /api/skills/global ────────────────────────────────────────────────────
  // GET → ProjectSkillsResponse: the OG user's OWN global skills
  // (~/.claude/skills/<name>/SKILL.md), available to them in every project. No
  // project path / no validateProjectPath — it reads a FIXED location (the
  // server's own home), so there is no caller-supplied path to guard.
  .get('/api/skills/global', async (c) => {
    try {
      const skills = await listGlobalSkills()
      return c.json<ProjectSkillsResponse>({ skills })
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'failed to read global skills' }, 500)
    }
  })
  // ── /api/skills/global/create ─────────────────────────────────────────────
  // POST { request } → author a NEW global skill (~/.claude/skills/<name>/) by
  // running a one-off `claude` PTY (SUBSCRIPTION-ONLY — never `claude -p`), same
  // pattern as the card auto-description. Blocking (up to ~4min); the client
  // shows a spinner. Returns the created skill. No project path involved.
  //   400 empty request · 503 claude CLI missing · 500 creation failed
  .post('/api/skills/global/create', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { request?: unknown }
    const request = typeof body.request === 'string' ? body.request.trim() : ''
    if (!request) return c.json({ error: 'a skill request is required' }, 400)
    if (request.length > MAX_REQUEST_LEN) {
      return c.json({ error: `request is too long (max ${MAX_REQUEST_LEN} chars)` }, 400)
    }
    // Pre-flight: refuse the spawn unless claude is installed AND signed in
    // (shared run gate). A signed-out claude opens its own OAuth browser, so we
    // stop here and let the UI point at the single sign-in terminal; the 503
    // flag (claudeMissing | claudeLoggedOut) drives the copy.
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    try {
      const skill = await createGlobalSkill(request)
      return c.json<CreateSkillResponse>({ skill })
    } catch (e: any) {
      if (e instanceof SkillCreationBusyError) {
        return c.json({ error: e.message, busy: true }, 409)
      }
      return c.json({ error: e?.message ?? 'skill creation failed' }, 500)
    }
  })
  // ── /api/project/open/pick ────────────────────────────────────────────────
  // POST → Finder file picker for a .app, returns { name, path, mode } | { cancelled }
  .post('/api/project/open/pick', async (c) => {
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      'POSIX path of (choose file of type {"com.apple.application-bundle"} default location (POSIX file "/Applications") with prompt "Pick an app to open this folder in")',
    ])
    const path = stdout.trim().replace(/\/$/, '')
    if (!path) return c.json({ cancelled: true })
    const base = path.split('/').filter(Boolean).pop() ?? ''
    const name = base.replace(/\.app$/i, '')
    if (!name) return c.json({ cancelled: true })

    const mode = await detectLaunchMode(path)
    return c.json({ name, path, mode })
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? '')
    if (/cancel/i.test(msg)) return c.json({ cancelled: true })
    return c.json({ error: msg || 'failed to pick' }, 500)
  }
})
  // ── /api/project/rename ───────────────────────────────────────────────────
  // POST { path, name } → rename folder on disk, repoint the registry entry.
  // The entry's id is stable (UUID), so the canvas position needs no remap.
  .post('/api/project/rename', async (c) => {
  const { path, name } = (await c.req.json()) as { path?: string; name?: string }
  if (!path) return c.json({ error: 'path is required' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
  const clean = (name ?? '').trim()
  const err = validateName(clean)
  if (err) return c.json({ error: err }, 400)

  const sourceDir = resolve(path)
  const targetDir = join(dirname(sourceDir), clean)
  if (targetDir === sourceDir) {
    return c.json({ ok: true, path: sourceDir })
  }
  try {
    await stat(targetDir)
    return c.json({ error: `"${clean}" already exists in this folder` }, 409)
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      return c.json({ error: e.message ?? 'stat failed' }, 500)
    }
  }

  try {
    await rename(sourceDir, targetDir)
    const updated = await updateProjectEntryPath(sourceDir, targetDir)
    return c.json({ ok: true, path: targetDir, id: updated?.id })
  } catch (e: any) {
    return c.json({ error: e.message ?? 'rename failed' }, 500)
  }
})
  // ── /api/project/delete ───────────────────────────────────────────────────
  // POST { path } → move folder to the OS trash AND unregister it. Only a
  // registered project (or a path under one) may be deleted — the registry is
  // the allowlist, enforced via validateProjectPath. The trash step is
  // platform-branched (buildTrashCommand): macOS Finder Trash, Windows Recycle
  // Bin, Linux freedesktop trash — so delete works off macOS, not just on it.
  .post('/api/project/delete', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const path = typeof body?.path === 'string' ? body.path : ''
  if (!path) return c.json({ error: 'path is required' }, 400)
  if (!(await validateProjectPath(path))) {
    return c.json({ error: 'path not allowed' }, 403)
  }
  const target = resolve(path)
  const { cmd, args } = buildTrashCommand(process.platform, target)

  try {
    await execFileAsync(cmd, args, { timeout: 30_000 })
  } catch (e: any) {
    return c.json(
      { error: e?.stderr?.toString().trim() || e?.message || 'delete failed' },
      500,
    )
  }

  // Trashed successfully — drop the registry entry, its canvas position, AND its
  // central data dir. The folder is already gone, so any in-flight run is dead;
  // without this the per-project store (~/.openground/projects/<id>/) would
  // orphan forever under a dead uuid (Export isn't built, so it's unrecoverable).
  const removed = await removeProjectEntry(target)
  if (removed) {
    const canvas = await getCanvas()
    if (canvas.positions[removed.id]) {
      const { [removed.id]: _drop, ...rest } = canvas.positions
      await setCanvas({ ...canvas, positions: rest })
    }
    await rm(projectCentralDir(removed.id), { recursive: true, force: true }).catch(() => {})
  }
  return c.json({ ok: true })
})
  // ── /api/projects/relocate ────────────────────────────────────────────────
  // POST { id, newPath } → re-point a (typically missing) project at a folder the
  // user selected, KEEPING its uuid so central data + canvas position reconnect.
  // The native folder picker is the trust boundary (same as Import), so this is
  // an allowlist-growing action and does NOT pre-check validateProjectPath.
  .post('/api/projects/relocate', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const id = typeof body?.id === 'string' ? body.id : ''
  const newPath = typeof body?.newPath === 'string' ? body.newPath : ''
  if (!id || !newPath) return c.json({ error: 'id and newPath are required' }, 400)
  try {
    const st = await stat(newPath)
    if (!st.isDirectory()) return c.json({ error: 'not a directory' }, 400)
  } catch {
    return c.json({ error: 'folder does not exist' }, 400)
  }
  const result = await relocateProjectEntry(id, newPath)
  if ('rejection' in result) {
    const status = result.rejection === 'not-found' ? 404 : 409
    return c.json({ error: result.rejection }, status)
  }
  return c.json({ ok: true, id: result.entry.id, path: result.entry.path })
})
  // ── /api/projects/display-name ────────────────────────────────────────────
  // POST { path, displayName } → set the project's cosmetic NAME (shown on the
  // Ground card / project header in place of the folder basename). A blank name
  // clears it back to the folder name. This does NOT touch the folder on disk
  // (cf. /api/project/rename) — displayName is display-only and never used as a
  // path. The member-visible shared name (collab label) is synced client-side
  // after this returns. Allowlist: validateProjectPath (registry-gated).
  //   400 missing/invalid · 403 path not allowed · 404 not registered
  .post('/api/projects/display-name', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: string
    displayName?: string
  }
  const path = typeof body.path === 'string' ? body.path : ''
  const displayName = typeof body.displayName === 'string' ? body.displayName : ''
  if (!path) return c.json({ error: 'path is required' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
  const clean = displayName.trim()
  // Lenient vs validateName (folder names): a display label is never a path, so
  // slashes/dots are fine — only bound length and reject control chars. Empty is
  // valid (clears the override).
  if (clean.length > 64) return c.json({ error: 'name is too long (max 64 chars)' }, 400)
  if (/[\x00-\x1f]/.test(clean)) return c.json({ error: 'name contains invalid characters' }, 400)
  const updated = await setProjectDisplayName(path, clean)
  if (!updated) return c.json({ error: 'project not registered' }, 404)
  return c.json({ ok: true, id: updated.id, name: updated.displayName ?? '' })
})
  // ── /api/project/tasks ────────────────────────────────────────────────────
  // POST { path, add?, markDone? } → mutate task list
  .post('/api/project/tasks', async (c) => {
  const body = (await c.req.json()) as TasksBody
  if (!body.path) return c.json({ error: 'path required' }, 400)
  if (!(await validateProjectPath(body.path))) return c.json({ error: 'path not allowed' }, 403)

  const data = await readProjectData(body.path)

  for (const raw of body.add ?? []) {
    const title = raw.trim()
    if (!title) continue
    const task: ProjectTask = {
      id: randomUUID(),
      title,
      done: false,
      createdAt: new Date().toISOString(),
      // Every task IS a Board card; readProjectData drops legacy non-board
      // entries by "no boardColumn", so a new card must always carry one.
      boardColumn: 'todo',
    }
    data.tasks.push(task)
  }

  if (body.markDone?.length) {
    const ids = new Set(body.markDone)
    data.tasks = data.tasks.map((t) =>
      ids.has(t.id) ? { ...t, done: true, boardColumn: 'done' as BoardColumn } : t,
    )
  }

  for (const pr of body.setPrUrl ?? []) {
    if (!pr || typeof pr.id !== 'string' || typeof pr.url !== 'string') continue
    const url = pr.url.trim()
    if (url === '') {
      // Empty string clears a wrongly-recorded PR link.
      data.tasks = data.tasks.map((t) =>
        t.id === pr.id ? { ...t, prUrl: undefined } : t,
      )
      continue
    }
    try {
      const parsed = new URL(url)
      if (!/^https?:$/.test(parsed.protocol) || url.length > 500) continue
    } catch {
      continue
    }
    data.tasks = data.tasks.map((t) => (t.id === pr.id ? { ...t, prUrl: url } : t))
  }

  for (const br of body.setBranch ?? []) {
    if (!br || typeof br.id !== 'string' || typeof br.branch !== 'string') continue
    const branch = br.branch.trim()
    if (branch === '') {
      // Empty string clears a wrongly-recorded branch.
      data.tasks = data.tasks.map((t) => (t.id === br.id ? { ...t, branch: undefined } : t))
      continue
    }
    if (branch.length > 200 || !BRANCH_RE.test(branch)) continue
    data.tasks = data.tasks.map((t) => (t.id === br.id ? { ...t, branch } : t))
  }

  for (const mv of body.setColumn ?? []) {
    if (!mv || typeof mv.id !== 'string' || !BOARD_COLUMNS.includes(mv.column)) continue
    data.tasks = data.tasks.map((t) =>
      t.id === mv.id
        ? {
            ...t,
            boardColumn: mv.column,
            done: mv.column === 'done',
            // Leaving review invalidates the commander engine's conflict stamp
            // (Card③) — a rework or completion supersedes it, mirroring reviewedBy.
            integrationConflict: mv.column === 'review' ? t.integrationConflict : undefined,
          }
        : t,
    )
  }

  for (const ic of body.setIntegrationConflict ?? []) {
    if (!ic || typeof ic.id !== 'string' || typeof ic.value !== 'boolean') continue
    data.tasks = data.tasks.map((t) =>
      t.id === ic.id ? { ...t, integrationConflict: ic.value || undefined } : t,
    )
  }

  const saved = await writeProjectData(body.path, data, {
    expectUpdatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
  })
  return c.json(saved)
})
  // ── /api/project/task-asset ───────────────────────────────────────────────
  // Board-card image attachments (B022). POST uploads base64 JSON (the same
  // body shape as /api/paste-image); the returned id is the content-hash file
  // name the card stores in `attachments` — no path ever crosses the wire.
  // GET serves the bytes (?path=&id=); DELETE unlinks ONLY when no card still
  // references the id (content-addressing dedupes the same screenshot across
  // cards, so a blind unlink would break the other card's thumbnail).
  .post('/api/project/task-asset', async (c) => {
    let body: { path?: unknown; name?: unknown; mime?: unknown; dataBase64?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const path = typeof body.path === 'string' ? body.path : ''
    if (!path) return c.json({ error: 'path required' }, 400)
    const mime = typeof body.mime === 'string' ? body.mime : ''
    const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : ''
    if (!mime.startsWith('image/') || !extForMime(mime)) {
      return c.json({ error: `unsupported mime: ${mime || '(none)'}` }, 400)
    }
    if (!dataBase64) return c.json({ error: 'missing image data' }, 400)
    // Reject by encoded length BEFORE decoding (base64 is 4/3 the byte size) —
    // an oversized body must never cost a full Buffer allocation first.
    if (dataBase64.length > Math.ceil((MAX_TASK_ASSET_BYTES * 4) / 3) + 4) {
      return c.json({ error: 'image too large (max 5MB)' }, 413)
    }
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    const data = Buffer.from(dataBase64, 'base64')
    if (data.length === 0) return c.json({ error: 'empty image' }, 400)
    if (data.length > MAX_TASK_ASSET_BYTES) {
      return c.json({ error: 'image too large (max 5MB)' }, 413)
    }
    try {
      const id = await writeTaskAsset(path, mime, data)
      // Display name: basename only, conservatively sanitized, never a path.
      const rawName = typeof body.name === 'string' ? body.name : ''
      const name =
        rawName
          .split(/[/\\]/)
          .pop()!
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .slice(0, 120) || 'image'
      return c.json({ id, name, mime })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'write failed' }, 500)
    }
  })
  .get('/api/project/task-asset', async (c) => {
    const path = c.req.query('path') ?? ''
    const id = c.req.query('id') ?? ''
    if (!path) return c.json({ error: 'path required' }, 400)
    // Strict id shape (40-hex sha1 + whitelisted ext) — the traversal guard.
    if (!isValidTaskAssetId(id)) return c.json({ error: 'bad id' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    const out = await readTaskAsset(path, id)
    if (!out) return c.json({ error: 'not found' }, 404)
    return c.body(out.data as unknown as ArrayBuffer, 200, {
      'content-type': out.mime,
      // Content-addressed: the bytes behind an id never change — cache hard.
      'cache-control': 'private, max-age=31536000, immutable',
    })
  })
  .delete('/api/project/task-asset', async (c) => {
    const path = c.req.query('path') ?? ''
    const id = c.req.query('id') ?? ''
    if (!path) return c.json({ error: 'path required' }, 400)
    if (!isValidTaskAssetId(id)) return c.json({ error: 'bad id' }, 400)
    if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
    // Only reap unreferenced bytes. A still-referenced id (another card, or a
    // not-yet-persisted drawer state) is skipped — leak-not-loss by design.
    // `taskId` names the card the client just removed the attachment FROM: its
    // SAVED reference is excluded from the count, because the drawer's persist
    // is debounced and the stale disk copy would otherwise always say
    // "referenced" and leak the bytes. Other cards' references still protect.
    const taskId = c.req.query('taskId') ?? ''
    const data = await readProjectData(path)
    const referenced = data.tasks.some(
      (t) => t.id !== taskId && (t.attachments ?? []).some((a) => a.id === id),
    )
    if (!referenced) await deleteTaskAsset(path, id)
    return c.json({ ok: true, deleted: !referenced })
  })
  // ── /api/project/canvases ─────────────────────────────────────────────────
  // GET ?path[&id] → list | full CanvasFile
  // POST ?action=create|delete|rename|reorder|active (default: save) — body.path required
  .get('/api/project/canvases', async (c) => {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'path required' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
  const id = c.req.query('id')
  if (id) {
    const canvas = await readCanvasFile(path, id)
    if (!canvas) return c.json({ error: 'canvas not found' }, 404)
    return c.json(canvas)
  }
  const list = await listCanvases(path)
  return c.json(list)
})
  .post('/api/project/canvases', async (c) => {
  const action = c.req.query('action')
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  if (!body?.path) return c.json({ error: 'path required' }, 400)
  if (!(await validateProjectPath(body.path))) return c.json({ error: 'path not allowed' }, 403)

  if (action === 'create') {
    const result = await createCanvas(body.path, body.name)
    return c.json(result)
  }
  if (action === 'delete') {
    if (!body.id) return c.json({ error: 'id required' }, 400)
    const result = await deleteCanvas(body.path, body.id)
    return c.json(result)
  }
  if (action === 'rename') {
    if (!body.id || typeof body.name !== 'string') {
      return c.json({ error: 'id and name required' }, 400)
    }
    const result = await renameCanvas(body.path, body.id, body.name)
    if (!result) return c.json({ error: 'rename failed' }, 400)
    return c.json(result)
  }
  if (action === 'reorder') {
    if (!Array.isArray(body.order)) {
      return c.json({ error: 'order array required' }, 400)
    }
    const result = await reorderCanvases(body.path, body.order)
    return c.json(result)
  }
  if (action === 'active') {
    if (!body.id) return c.json({ error: 'id required' }, 400)
    const result = await setActiveCanvas(body.path, body.id)
    return c.json(result)
  }
  // Default: save a full Canvas file under optimistic concurrency control
  // (saveCanvasFile — serialised with AI append/tweak via withCanvasFileLock).
  const canvas = body.canvas as CanvasFile | undefined
  if (!canvas?.id) return c.json({ error: 'canvas.id required' }, 400)
  const outcome = await saveCanvasFile(body.path, canvas)
  if (!outcome.ok) {
    // Stale write: an AI job (or rename) advanced the canvas since the client
    // loaded it. Return 409 + the CURRENT canvas so the client can 3-way-merge
    // its edits with the server's new elements and retry — never a blind
    // overwrite that would erase the AI's additions.
    return c.json({ conflict: true, canvas: outcome.canvas }, 409)
  }
  return c.json(outcome.canvas)
})
  // ── /api/project/describe ─────────────────────────────────────────────────
  // POST ?path → auto-generate a project description by briefly running the
  // local `claude` CLI in the project (read-only). Thin adapter; the
  // subscription-safe PTY logic lives in generateDescription.ts. Returns
  // { description } on success; does NOT persist — the UI prefills it into the
  // editor for the user to review and save.
  .post('/api/project/describe', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    // Pre-flight: refuse the spawn unless claude is installed AND signed in
    // (shared run gate). describe auto-runs a one-off claude; a signed-out one
    // would open OAuth, so gate it and let the 503 flag (claudeMissing |
    // claudeLoggedOut) drive the UI.
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    try {
      const pair = await generateProjectDescription(path)
      const lang = await getPromptLang()
      // Active-language copy first; fall back to the other so `description`
      // is never empty when at least one language landed.
      const description = (lang === 'ja' ? pair.ja : pair.en) ?? pair.en ?? pair.ja ?? ''
      return c.json({
        description,
        ...(pair.ja ? { descriptionJa: pair.ja } : {}),
        ...(pair.en ? { descriptionEn: pair.en } : {}),
      })
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'description generation failed' }, 500)
    }
  })
  // ── /api/project/task-title ───────────────────────────────────────────────
  // POST { path, id } → summarize the card's content into a short title via a
  // one-off haiku session (generateTaskTitle — serialized, subscription-only)
  // and persist it — but ONLY while the card's title is still machine-derived
  // (titleAuto): the moment the user edits the title by hand, an in-flight
  // generation must not clobber it. Returns { title } (null = kept as-is).
  .post('/api/project/task-title', async (c) => {
    let body: { path?: string; id?: string; force?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    if (!body.path || !body.id) return c.json({ error: 'path and id required' }, 400)
    if (!(await validateProjectPath(body.path))) return c.json({ error: 'path not allowed' }, 403)
    const force = body.force === true
    const before = await readProjectData(body.path)
    const task = before.tasks.find((t) => t.id === body.id)
    if (!task) return c.json({ error: 'task not found' }, 404)
    // Hand-titled card: nothing to do (idempotent no-op, not an error — the
    // client fires this without checking). The explicit "✦ regenerate" button
    // sends force, which overrides — the user asked for a machine title.
    if (!task.titleAuto && !force) return c.json({ title: null })
    const content = [task.title, task.notes ?? ''].filter(Boolean).join('\n').trim()
    if (!content) return c.json({ title: null })
    // Shared run gate: installed && loggedIn. This is the fire-and-forget
    // auto-title spawn — the second OAuth tab a logged-out 実行 used to open —
    // so refusing it here is half of killing the browser loop (the client also
    // skips firing it while signed out).
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    try {
      const title = await generateTaskTitle(body.path, content)
      if (!title) return c.json({ title: null })
      // Re-read AFTER the (seconds-long) generation: the user may have edited
      // or deleted the card meanwhile — their edit wins, silently (a forced
      // regeneration only requires the card to still exist).
      const after = await readProjectData(body.path)
      const fresh = after.tasks.find((t) => t.id === body.id)
      if (!fresh) return c.json({ title: null })
      if (!force && (!fresh.titleAuto || fresh.title !== task.title)) return c.json({ title: null })
      after.tasks = after.tasks.map((t) =>
        t.id === body.id ? { ...t, title, titleAuto: true } : t,
      )
      await writeProjectData(body.path, after, {
        expectUpdatedAt: typeof after.updatedAt === 'string' ? after.updatedAt : undefined,
      })
      return c.json({ title })
    } catch (e: any) {
      // A concurrent user write between our re-read and save: their version
      // wins, the auto-title is simply dropped.
      if (e instanceof ProjectDataConflictError) return c.json({ title: null })
      return c.json({ error: e?.message ?? 'title generation failed' }, 500)
    }
  })
