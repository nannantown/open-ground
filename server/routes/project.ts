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
import { rename, stat } from 'fs/promises'
import { dirname, join, resolve, basename, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import {
  readProjectData,
  writeProjectData,
  archiveProject,
  restoreProject,
  validateProjectPath,
} from '@/lib/server/projectData'
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
import {
  deleteTaskImage,
  extForMime,
  isValidImageId,
  readTaskImage,
  writeTaskImage,
} from '@/lib/server/taskImages'
import type { ProjectData, ProjectTask, TaskImage, CanvasFile } from '@/lib/types'
import { validateName } from './_shared'
import { requireProjectPath } from '../middleware/projectPath'

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

const projectId = (folderName: string) =>
  createHash('sha1').update(folderName).digest('hex').slice(0, 12)

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
  attachImages?: { taskId: string; images: TaskImage[] }
  detachImage?: { taskId: string; imageId: string }
}

// A clipboard screenshot is rarely more than a couple of MB.
const MAX_BYTES = 12 * 1024 * 1024

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
  const data = await readProjectData(path)
  return c.json(data)
})
  .put('/api/project', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const body = (await c.req.json()) as ProjectData
    const saved = await writeProjectData(path, body)
    return c.json(saved)
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
  // POST { path, name } → rename folder on disk, migrate canvas position
  .post('/api/project/rename', async (c) => {
  const { path, name } = (await c.req.json()) as { path?: string; name?: string }
  if (!path) return c.json({ error: 'path is required' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
  const settings = await getSettings()
  const clean = (name ?? '').trim()
  const err = validateName(clean, settings.archiveDirName)
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
    const oldId = projectId(basename(sourceDir))
    const newId = projectId(clean)
    if (oldId !== newId) {
      const canvas = await getCanvas()
      const pos = canvas.positions[oldId]
      if (pos) {
        const positions = { ...canvas.positions }
        delete positions[oldId]
        positions[newId] = pos
        await setCanvas({ ...canvas, positions })
      }
    }
    return c.json({ ok: true, path: targetDir, id: newId })
  } catch (e: any) {
    return c.json({ error: e.message ?? 'rename failed' }, 500)
  }
})
  // ── /api/project/archive ──────────────────────────────────────────────────
  // POST { path } → fs.rename into _archive
  .post('/api/project/archive', async (c) => {
  const { path } = await c.req.json()
  if (!path) return c.json({ error: 'path required' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
  try {
    const settings = await getSettings()
    const newPath = await archiveProject(path, settings)
    return c.json({ ok: true, path: newPath })
  } catch (e: any) {
    return c.json({ error: e.message ?? 'archive failed' }, 500)
  }
})
  // ── /api/project/restore ──────────────────────────────────────────────────
  // POST { path } → fs.rename out of _archive
  .post('/api/project/restore', async (c) => {
  const { path } = await c.req.json()
  if (!path) return c.json({ error: 'path required' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)
  try {
    const settings = await getSettings()
    const newPath = await restoreProject(path, settings)
    return c.json({ ok: true, path: newPath })
  } catch (e: any) {
    return c.json({ error: e.message ?? 'restore failed' }, 500)
  }
})
  // ── /api/project/delete ───────────────────────────────────────────────────
  // POST { path } → move folder to macOS Trash via JXA / NSFileManager.
  // NOTE: this route does its OWN root-containment check (target must sit strictly
  // UNDER projectsRoot, never equal it) rather than validateProjectPath, exactly
  // as the Next handler did — preserved verbatim. TRASH_JXA is hoisted above.
  .post('/api/project/delete', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const path = typeof body?.path === 'string' ? body.path : ''
  if (!path) return c.json({ error: 'path is required' }, 400)

  const settings = await getSettings()
  const root = settings.projectsRoot ? resolve(settings.projectsRoot) : null
  const target = resolve(path)
  if (!root || target === root || !target.startsWith(root + sep)) {
    return c.json({ error: 'path not allowed' }, 403)
  }

  try {
    await execFileAsync('osascript', ['-l', 'JavaScript', '-e', TRASH_JXA, target], {
      timeout: 30_000,
    })
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json(
      { error: e?.stderr?.toString().trim() || e?.message || 'delete failed' },
      500,
    )
  }
})
  // ── /api/project/tasks ────────────────────────────────────────────────────
  // POST { path, add?, markDone?, attachImages?, detachImage? } → mutate task list
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
      milestoneId: null,
      createdAt: new Date().toISOString(),
    }
    data.tasks.push(task)
  }

  if (body.markDone?.length) {
    const ids = new Set(body.markDone)
    data.tasks = data.tasks.map((t) => (ids.has(t.id) ? { ...t, done: true } : t))
  }

  const attach = body.attachImages
  if (attach?.taskId && attach.images?.length) {
    data.tasks = data.tasks.map((t) =>
      t.id === attach.taskId
        ? { ...t, images: [...(t.images ?? []), ...attach.images] }
        : t,
    )
  }

  const detach = body.detachImage
  if (detach?.taskId && detach.imageId) {
    data.tasks = data.tasks.map((t) =>
      t.id === detach.taskId
        ? { ...t, images: (t.images ?? []).filter((im) => im.id !== detach.imageId) }
        : t,
    )
  }

  const saved = await writeProjectData(body.path, data)
  return c.json(saved)
})
  // ── /api/project/task-image ───────────────────────────────────────────────
  // GET ?path&id → image bytes ; POST ?path&id (raw body) → store ; DELETE ?path&id
  // (MAX_BYTES hoisted above)
  .get('/api/project/task-image', async (c) => {
  const path = c.req.query('path')
  const id = c.req.query('id')
  if (!path || !id) return c.json({ error: 'path and id are required' }, 400)
  if (!isValidImageId(id)) return c.json({ error: 'invalid image id' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)

  const img = await readTaskImage(path, id)
  if (!img) return c.json({ error: 'image not found' }, 404)
  return c.body(new Uint8Array(img.data), 200, {
    'content-type': img.mime,
    'cache-control': 'private, max-age=31536000, immutable',
  })
})
  .post('/api/project/task-image', async (c) => {
  const path = c.req.query('path')
  const id = c.req.query('id')
  if (!path || !id) return c.json({ error: 'path and id are required' }, 400)
  if (!isValidImageId(id)) return c.json({ error: 'invalid image id' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)

  const mime = c.req.header('content-type') ?? ''
  if (!extForMime(mime)) return c.json({ error: `unsupported image type: ${mime || '(none)'}` }, 400)

  const data = Buffer.from(await c.req.arrayBuffer())
  if (data.length === 0) return c.json({ error: 'empty image body' }, 400)
  if (data.length > MAX_BYTES) return c.json({ error: 'image too large' }, 413)

  await writeTaskImage(path, id, mime, data)
  return c.json({ id, mime })
})
  .delete('/api/project/task-image', async (c) => {
  const path = c.req.query('path')
  const id = c.req.query('id')
  if (!path || !id) return c.json({ error: 'path and id are required' }, 400)
  if (!isValidImageId(id)) return c.json({ error: 'invalid image id' }, 400)
  if (!(await validateProjectPath(path))) return c.json({ error: 'path not allowed' }, 403)

  await deleteTaskImage(path, id)
  return c.json({ id })
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
