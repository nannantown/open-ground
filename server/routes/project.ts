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
} from '@/lib/server/registry'
import { projectCentralDir } from '@/lib/server/paths'
import {
  getSettings,
  setSettings,
  getCanvas,
  setCanvas,
} from '@/lib/server/store'
import { normalizeOpenApps } from '@/lib/server/openApps'
import {
  createCanvas,
  deleteCanvas,
  listCanvases,
  readCanvasFile,
  renameCanvas,
  reorderCanvases,
  setActiveCanvas,
  writeCanvasFile,
} from '@/lib/server/canvasData'
import type { BoardColumn, ProjectData, ProjectTask, CanvasFile } from '@/lib/types'
import { validateName } from './_shared'
import { requireProjectPath } from '../middleware/projectPath'
import { probeClaudeCli } from '@/lib/server/claudeCli'
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

// POST /api/project/delete moves the folder to the macOS Trash via JXA /
// NSFileManager.
const TRASH_JXA = `ObjC.import('Foundation');
function run(argv) {
  var fm = $.NSFileManager.defaultManager;
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var ok = fm.trashItemAtURLResultingItemURLError(url, null, null);
  if (!ok) throw new Error('Could not move the folder to the Trash.');
}`

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
  // POST { path } → move folder to the macOS Trash AND unregister it. Only a
  // registered project (or a path under one) may be deleted — the registry is
  // the allowlist, enforced via validateProjectPath.
  .post('/api/project/delete', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const path = typeof body?.path === 'string' ? body.path : ''
  if (!path) return c.json({ error: 'path is required' }, 400)
  if (!(await validateProjectPath(path))) {
    return c.json({ error: 'path not allowed' }, 403)
  }
  const target = resolve(path)

  try {
    await execFileAsync('osascript', ['-l', 'JavaScript', '-e', TRASH_JXA, target], {
      timeout: 30_000,
    })
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
      t.id === mv.id ? { ...t, boardColumn: mv.column, done: mv.column === 'done' } : t,
    )
  }

  const saved = await writeProjectData(body.path, data, {
    expectUpdatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
  })
  return c.json(saved)
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
  // Default: save a full Canvas file.
  const canvas = body.canvas as CanvasFile | undefined
  if (!canvas?.id) return c.json({ error: 'canvas.id required' }, 400)
  const saved = await writeCanvasFile(body.path, canvas)
  return c.json(saved)
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
    // Pre-flight: a missing CLI means a doomed run. Surface it as a 503 with a
    // machine-readable flag so the UI can disable the affordance.
    const probe = await probeClaudeCli()
    if (!probe.installed) {
      return c.json({ error: probe.message, claudeMissing: true }, 503)
    }
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
    const probe = await probeClaudeCli()
    if (!probe.installed) {
      return c.json({ error: probe.message, claudeMissing: true }, 503)
    }
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
