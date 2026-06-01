// server/routes/misc.ts — Hono sub-router for the E-misc group.
// Declares FULL /api/... paths (the mount prefix in app.ts is empty:
// app.route('/', miscRoutes)). Handlers are THIN ADAPTERS over the existing
// src/lib/server/* logic — NextResponse.json(x[,status]) -> c.json(x[,status]),
// (await req.json()) -> (await c.req.json()), searchParams.get('x') ->
// c.req.query('x'). All src/lib/server/* calls stay identical; status codes and
// error shapes mirror the original route handlers byte-for-byte.
//
// Method-chaining style (new Hono().get(...).post(...)) so hc<AppType> on the
// client can recover this group's route tree. All module-level helpers that the
// handlers depend on are hoisted above the chain (they used to be interleaved
// between the per-route registrations).

import { Hono } from 'hono'
import { mkdir, stat, readdir, readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { getSettings, setSettings, getCanvas } from '@/lib/server/store'
import { scanProjects } from '@/lib/server/scan'
import { writeProjectData, validateProjectPath } from '@/lib/server/projectData'
import { listSkills } from '@/lib/server/skills'
import { collectClaudeUsage } from '@/lib/server/claudeUsage'
import { fetchClaudeUsageCli } from '@/lib/server/claudeUsageCli'
import { probeClaudeCli } from '@/lib/server/claudeCli'
import { installHooks, uninstallHooks } from '@/lib/server/hooksInstall'
import { nudge } from '@/lib/server/observer'
import { ObserverNudgeApiBodySchema } from '@/lib/schemas'
import type { ProjectsResponse } from '@/lib/types'
import { validateName } from './_shared'

const execFile = promisify(execFileCb)

// --- /api/update/check helpers ---------------------------------------------
// Owner/repo the in-app update banner queries for the latest GitHub Release.
// Parametrised so a fork / re-publisher points it at their own public repo
// without touching code: set OPENGROUND_RELEASES_REPO=<owner>/<repo>. The
// default is the public OPEN GROUND repo. NOTE: the GitHub repo's actual name
// is not renamed by this — this only changes where the running app *looks* for
// releases. Keep this in sync with package.json build.publish (which is also
// env-overridable via scripts/build-config or electron-builder's own config).
const RELEASES_REPO = process.env.OPENGROUND_RELEASES_REPO || 'nannantown/open-ground'

const stripV = (s: string): string => s.replace(/^v/i, '').trim()

// SemVer-aware comparison. Returns -1 / 0 / 1. Falls back to lexical when the
// strings aren't well-formed SemVer.
const compareVersions = (a: string, b: string): number => {
  const re = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/
  const ma = re.exec(stripV(a))
  const mb = re.exec(stripV(b))
  if (!ma || !mb) return stripV(a).localeCompare(stripV(b))
  for (let i = 1; i <= 3; i++) {
    const na = parseInt(ma[i] ?? '0', 10)
    const nb = parseInt(mb[i] ?? '0', 10)
    if (na !== nb) return na < nb ? -1 : 1
  }
  return 0
}

const readCurrentVersion = async (): Promise<string> => {
  try {
    const pkgPath = join(process.cwd(), 'package.json')
    const raw = await readFile(pkgPath, 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

interface GhRelease {
  tag_name: string
  html_url: string
  published_at: string
  body: string
  draft: boolean
  prerelease: boolean
}


// --- /api/folder-info helper -----------------------------------------------
// Folder names that are never projects — used only for the rough preview
// count shown in Settings before the folder is saved.
const FOLDER_INFO_SKIP = ['node_modules', '.next', 'dist', 'build', '.cache', '_archive']

// --- /api/pick-folder helper -----------------------------------------------
// Opens the native macOS folder picker and returns the chosen absolute path.
// A browser folder input cannot expose absolute paths, but OPEN GROUND's server
// runs locally — so it can ask macOS directly via osascript.
const PICK_FOLDER_SCRIPT = `set theFolder to choose folder with prompt "Select your projects folder" default location (path to home folder)
POSIX path of theFolder`

export const miscRoutes = new Hono()
  // --- GET /api/projects ----------------------------------------------------
  .get('/api/projects', async (c) => {
    const settings = await getSettings()
    const canvas = await getCanvas()

    if (!settings.projectsRoot) {
      const body: ProjectsResponse = {
        settings,
        projects: [],
        canvas,
        error: 'projectsRoot is not configured',
      }
      return c.json(body)
    }

    const projects = await scanProjects(settings)
    const body: ProjectsResponse = { settings, projects, canvas }
    return c.json(body)
  })
  // --- POST /api/projects/new -----------------------------------------------
  // validateName (shared with project rename) keeps the chosen folder name
  // friendly to macOS Finder / git / shells: no slashes, no traversal, no
  // leading dot (would be hidden + skipped by scan), no collision with the
  // archive sentinel folder.
  .post('/api/projects/new', async (c) => {
    const { name, description } = (await c.req.json()) as {
      name?: string
      description?: string
    }
    const settings = await getSettings()
    if (!settings.projectsRoot) {
      return c.json({ error: 'projectsRoot is not configured' }, 400)
    }
    const clean = (name ?? '').trim()
    const err = validateName(clean, settings.archiveDirName)
    if (err) return c.json({ error: err }, 400)

    const root = resolve(settings.projectsRoot)
    const target = join(root, clean)
    try {
      await stat(target)
      return c.json({ error: `"${clean}" already exists in this folder` }, 409)
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        return c.json({ error: e.message ?? 'stat failed' }, 500)
      }
    }

    try {
      await mkdir(target, { recursive: false })
      const desc = (description ?? '').trim()
      if (desc) {
        await writeProjectData(target, {
          description: desc,
          tasks: [],
          milestones: [],
          notes: '',
          updatedAt: new Date().toISOString(),
        })
      }
      return c.json({ path: target, name: clean })
    } catch (e: any) {
      return c.json({ error: e.message ?? 'create failed' }, 500)
    }
  })
  // --- GET / POST /api/settings ---------------------------------------------
  .get('/api/settings', async (c) => {
    return c.json(await getSettings())
  })
  .post('/api/settings', async (c) => {
    const body = await c.req.json()
    await setSettings(body)
    return c.json({ ok: true })
  })
  // --- GET /api/skills ------------------------------------------------------
  // GET /api/skills?projectPath=/abs/path&category=design|all
  // projectPath is optional; when provided it is validated against projectsRoot
  // so a stray query param can't read arbitrary directories. `category` defaults
  // to `design`; pass `category=all` to bypass the sieve.
  .get('/api/skills', async (c) => {
    const projectPath = c.req.query('projectPath') ?? undefined
    if (projectPath && !(await validateProjectPath(projectPath))) {
      return c.json({ error: `path not allowed: ${projectPath}` }, 403)
    }
    const categoryParam = c.req.query('category')
    const category: 'design' | 'all' = categoryParam === 'all' ? 'all' : 'design'
    const skills = await listSkills(projectPath, { category })
    return c.json({ skills })
  })
  // --- GET /api/usage -------------------------------------------------------
  .get('/api/usage', async (c) => {
    try {
      // Run both in parallel: the local jsonl scan is fast and always works,
      // the CLI scrape is slow (~9s wall, 5min cached) but matches Anthropic's
      // numbers exactly. If the CLI half fails, the HUD falls back to the
      // local-estimate fields.
      const [local, cli] = await Promise.all([
        collectClaudeUsage(),
        fetchClaudeUsageCli().catch(() => null),
      ])
      return c.json({ ...local, cli })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'usage scan failed' },
        200,
      )
    }
  })
  // --- GET /api/claude-probe ------------------------------------------------
  // Lightweight readiness check for the local `claude` CLI. Used by Settings
  // and the empty-state to warn the user that runs will fail until the CLI is
  // installed + authenticated (subscription-only — no API key). Presence-only;
  // does not verify auth (interactive) and is intentionally not a wizard.
  .get('/api/claude-probe', async (c) => {
    // `?force=1` bypasses the 10s cache (used by Settings' "Re-check" button).
    const force = c.req.query('force') === '1'
    return c.json(await probeClaudeCli(force))
  })
  // --- GET /api/update/check ------------------------------------------------
  .get('/api/update/check', async (c) => {
    const current = await readCurrentVersion()
    let latest = current
    let releaseUrl = ''
    let publishedAt = ''
    let notes = ''
    let err: string | undefined

    try {
      // Public unauthenticated endpoint — 60 req/hr per IP, plenty for a
      // single-user app checking once per session.
      const res = await fetch(
        `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`,
        {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(5000),
        },
      )
      if (res.ok) {
        const rel = (await res.json()) as GhRelease
        if (!rel.draft && !rel.prerelease && rel.tag_name) {
          latest = stripV(rel.tag_name)
          releaseUrl = rel.html_url
          publishedAt = rel.published_at
          notes = rel.body ?? ''
        }
      } else if (res.status === 404) {
        // No releases published yet — treat as "you're on latest".
      } else {
        err = `github responded ${res.status}`
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }

    const hasUpdate = compareVersions(current, latest) < 0
    return c.json({
      current,
      latest,
      hasUpdate,
      releaseUrl,
      publishedAt,
      notes,
      ...(err ? { error: err } : {}),
    })
  })
  // --- GET /api/folder-info -------------------------------------------------
  .get('/api/folder-info', async (c) => {
    const path = c.req.query('path')?.trim()
    if (!path) return c.json({ exists: false, projectCount: 0 })

    try {
      const s = await stat(path)
      if (!s.isDirectory()) {
        return c.json({ exists: false, projectCount: 0, notDir: true })
      }
    } catch {
      return c.json({ exists: false, projectCount: 0 })
    }

    let projectCount = 0
    try {
      const entries = await readdir(path, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.')) continue
        if (FOLDER_INFO_SKIP.includes(e.name)) continue
        projectCount++
      }
    } catch {}

    return c.json({ exists: true, projectCount })
  })
  // --- POST /api/pick-folder ------------------------------------------------
  .post('/api/pick-folder', async (c) => {
    try {
      const { stdout } = await execFile('osascript', ['-e', PICK_FOLDER_SCRIPT], {
        timeout: 180_000,
      })
      return c.json({ path: stdout.trim() })
    } catch (e: any) {
      const msg = `${e?.stderr ?? ''} ${e?.message ?? ''}`
      if (/User canceled/i.test(msg)) {
        return c.json({ cancelled: true })
      }
      return c.json({ error: 'Could not open the folder picker.' }, 500)
    }
  })
  // --- POST / DELETE /api/observer/install-hooks ----------------------------
  // Install / uninstall the OPEN GROUND Claude Code hook entries in the user's
  // ~/.claude/settings.json. Both operations are idempotent and preserve any
  // sibling hook entries the user defined.
  .post('/api/observer/install-hooks', async (c) => {
    const result = await installHooks()
    return c.json(result)
  })
  .delete('/api/observer/install-hooks', async (c) => {
    const result = await uninstallHooks()
    return c.json(result)
  })
  // --- POST /api/observer/nudge ---------------------------------------------
  // Internal-only endpoint invoked by scripts/openground-hook.js at Stop time.
  // Contract: ALWAYS returns 200 OK — the hook script must never be blocked or
  // get a non-200. Schema mismatches and unknown sids are silently dropped.
  .post('/api/observer/nudge', async (c) => {
    try {
      const raw = await c.req.json().catch(() => null)
      const parsed = ObserverNudgeApiBodySchema.safeParse(raw)
      if (parsed.success) {
        nudge(parsed.data.sid)
      }
    } catch {}
    return c.json({ ok: true })
  })
