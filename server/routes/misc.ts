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
import { mkdir, stat, readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { getSettings, setSettings, getCanvas, setCanvas } from '@/lib/server/store'
import { scanProjects } from '@/lib/server/scan'
import { writeProjectData } from '@/lib/server/projectData'
import {
  ensureProjectsMigrated,
  addProjectEntry,
  addImportedProjectEntry,
  removeProjectEntry,
} from '@/lib/server/registry'
import { collectClaudeUsage } from '@/lib/server/claudeUsage'
import { fetchClaudeUsageCli, invalidateUsageCache } from '@/lib/server/claudeUsageCli'
import { claudeConnection } from '@/lib/server/claudeConnection'
import { probeGhCli } from '@/lib/server/ghCli'
import { installHooks, uninstallHooks } from '@/lib/server/hooksInstall'
import type {
  ProjectsResponse,
  ReleaseNote,
  ReleaseNotesResponse,
  SettingsResponse,
} from '@/lib/types'
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

// --- /api/release-notes cache -------------------------------------------------
// The releases list changes ~once a day at most; cache it for 10 minutes so
// reopening Settings never burns the unauthenticated GitHub quota (60/h/IP).
// globalThis so the cache survives tsx-watch reloads in dev (same pattern as
// the terminal pool).
const RELEASE_NOTES_TTL_MS = 10 * 60_000
const gNotes = globalThis as typeof globalThis & {
  __openground_release_notes?: { at: number; releases: ReleaseNote[] }
}


// --- /api/pick-folder helper -----------------------------------------------
// Opens the native macOS folder picker and returns the chosen absolute path.
// A browser folder input cannot expose absolute paths, but OPEN GROUND's server
// runs locally — so it can ask macOS directly via osascript.
const PICK_FOLDER_SCRIPT = `set theFolder to choose folder with prompt "Choose a folder" default location (path to home folder)
POSIX path of theFolder`

// --- /api/settings helper ----------------------------------------------------
// Display-name suggestion: the user's global git identity. Computed once per
// process lifetime (the value changes ~never and the settings GET is hot on
// panel open); null when git is missing or user.name is unset. NEVER persisted
// — the client only uses it as the Display name input's placeholder.
let suggestedDisplayNameOnce: Promise<string | null> | null = null
const suggestedDisplayName = (): Promise<string | null> => {
  suggestedDisplayNameOnce ??= execFile('git', ['config', '--global', 'user.name'])
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null)
  return suggestedDisplayNameOnce
}

export const miscRoutes = new Hono()
  // --- GET /api/projects ----------------------------------------------------
  .get('/api/projects', async (c) => {
    // Runs the one-shot legacy migration (existing users' projectsRoot →
    // registry, with canvas positions re-keyed) before listing. Idempotent.
    await ensureProjectsMigrated()
    const settings = await getSettings()
    const canvas = await getCanvas()
    const projects = await scanProjects(settings)
    const body: ProjectsResponse = { settings, projects, canvas }
    return c.json(body)
  })
  // --- POST /api/projects/new -----------------------------------------------
  // Create a brand-new project folder under the remembered `defaultWorkspace`
  // and register it. The client picks the workspace once (native folder dialog)
  // and passes it as `workspace`; thereafter only `name` is needed. validateName
  // keeps the folder name friendly to macOS Finder / git / shells.
  .post('/api/projects/new', async (c) => {
    // Run the legacy migration first: it commits the registry via a full
    // setSettings({projects}) replace, so a write here before it lands would be
    // clobbered (orphaning a folder we just created). Mirrors GET /api/projects.
    await ensureProjectsMigrated()
    const { name, description, workspace } = (await c.req.json()) as {
      name?: string
      description?: string
      workspace?: string
    }
    const settings = await getSettings()
    const ws = (workspace ?? '').trim() || settings.defaultWorkspace || ''
    if (!ws) {
      // The client should open the folder picker and resubmit with `workspace`.
      return c.json({ error: 'needs-workspace', needsWorkspace: true }, 400)
    }

    const clean = (name ?? '').trim()
    const err = validateName(clean)
    if (err) return c.json({ error: err }, 400)

    const target = join(resolve(ws), clean)
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
          notes: '',
          updatedAt: new Date().toISOString(),
        })
      }
      // Remember the workspace for next time, then register the new folder
      // BEFORE returning so a follow-up canvas/tasks save can't race the
      // security boundary.
      if (ws !== settings.defaultWorkspace) await setSettings({ defaultWorkspace: ws })
      const entry = await addProjectEntry(target, desc || undefined)
      return c.json({ path: target, name: clean, id: entry.id })
    } catch (e: any) {
      return c.json({ error: e.message ?? 'create failed' }, 500)
    }
  })
  // --- POST /api/projects/import --------------------------------------------
  // Register an existing folder (anywhere on disk) as a project. The path comes
  // from the native folder picker. Rejects targets that would make too much of
  // the filesystem writable (filesystem/home root) or that nest with an
  // already-registered project.
  .post('/api/projects/import', async (c) => {
    // Migrate first so the overlap check runs against the migrated registry and
    // the new entry can't be clobbered by a later migration (see /new).
    await ensureProjectsMigrated()
    const { path, description } = (await c.req.json()) as {
      path?: string
      description?: string
    }
    const raw = (path ?? '').trim()
    if (!raw) return c.json({ error: 'path required' }, 400)

    let s
    try {
      s = await stat(raw)
    } catch {
      return c.json({ error: 'That folder does not exist.' }, 400)
    }
    if (!s.isDirectory()) return c.json({ error: 'That path is not a folder.' }, 400)

    // The duplicate + overlap/dangerous-target checks happen atomically with the
    // write inside addImportedProjectEntry (under the registry lock), so two
    // concurrent nested imports can't both bypass the overlap guard.
    const result = await addImportedProjectEntry(raw, (description ?? '').trim() || undefined)
    if ('rejection' in result) {
      if (result.rejection === 'duplicate') {
        return c.json({ error: 'That folder is already on your canvas.' }, 409)
      }
      if (result.rejection === 'overlap') {
        return c.json({ error: 'That folder overlaps a project already on your canvas.' }, 400)
      }
      // filesystem-root / home-root
      return c.json({ error: 'Pick a specific project folder, not your whole drive or home folder.' }, 400)
    }
    const entry = result.entry
    return c.json({ path: entry.path, name: entry.path.split('/').pop() ?? entry.path, id: entry.id })
  })
  // --- POST /api/projects/remove --------------------------------------------
  // Unregister a project ("Remove from canvas"). The folder is left untouched
  // on disk — only the registry entry and its canvas position are dropped.
  .post('/api/projects/remove', async (c) => {
    await ensureProjectsMigrated()
    const { path } = (await c.req.json()) as { path?: string }
    const raw = (path ?? '').trim()
    if (!raw) return c.json({ error: 'path required' }, 400)
    const removed = await removeProjectEntry(raw)
    if (!removed) return c.json({ error: 'not registered' }, 404)
    const canvas = await getCanvas()
    if (canvas.positions[removed.id]) {
      const { [removed.id]: _drop, ...rest } = canvas.positions
      await setCanvas({ ...canvas, positions: rest })
    }
    return c.json({ ok: true })
  })
  // --- GET / POST /api/settings ---------------------------------------------
  .get('/api/settings', async (c) => {
    // The persisted settings plus the non-persisted display-name suggestion
    // (see suggestedDisplayName above) — the POST below never receives it
    // back because the client saves only real Settings fields.
    const settings = await getSettings()
    const body: SettingsResponse = {
      ...settings,
      suggestedDisplayName: await suggestedDisplayName(),
    }
    return c.json(body)
  })
  .post('/api/settings', async (c) => {
    const body = await c.req.json()
    await setSettings(body)
    return c.json({ ok: true })
  })
  // --- GET /api/usage -------------------------------------------------------
  .get('/api/usage', async (c) => {
    try {
      // `?refresh=1` busts the 5-min CLI-scrape cache so the user's manual
      // refresh actually re-runs `claude /usage` (≈9s) instead of returning the
      // cached value.
      if (c.req.query('refresh')) invalidateUsageCache()
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
  // --- GET /api/gh-status ------------------------------------------------
  // Presence/auth probe for the GitHub CLI — Project settings pre-checks it
  // when the PR completion flow is selected (gh pr create runs in claude's
  // task session; failing there is too late). ?force=1 bypasses the cache.
  .get('/api/gh-status', async (c) => {
    const force = c.req.query('force') === '1'
    return c.json(await probeGhCli(force))
  })
  // --- GET /api/claude-connection -------------------------------------------
  // Passive, cross-platform "is the user's Claude connected?" status. Runs
  // `claude auth status` (shell on Windows, login-shell/known-paths fallback on
  // POSIX) and reports installed + loggedIn + plan + email + a human message.
  // Used by the toolbar indicator and Settings — PURELY informational; OPEN
  // GROUND never gates onboarding or runs on it. `?force=1` bypasses the 10s
  // cache (Settings' "Re-check" button).
  .get('/api/claude-connection', async (c) => {
    const force = c.req.query('force') === '1'
    return c.json(await claudeConnection(force))
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
  // --- GET /api/release-notes -------------------------------------------------
  // Published (non-draft) releases of the distribution repo, newest first —
  // the Settings drawer's "Release notes" section. Bodies are the bilingual
  // markdown notes written at publish time (docs/DISTRIBUTION.md §0).
  .get('/api/release-notes', async (c) => {
    const current = await readCurrentVersion()
    const cached = gNotes.__openground_release_notes
    if (cached && Date.now() - cached.at < RELEASE_NOTES_TTL_MS) {
      const body: ReleaseNotesResponse = { current, releases: cached.releases }
      return c.json(body)
    }
    try {
      const res = await fetch(
        `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`,
        {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(5000),
        },
      )
      if (!res.ok) throw new Error(`github responded ${res.status}`)
      const rels = (await res.json()) as GhRelease[]
      const releases: ReleaseNote[] = rels
        .filter((r) => !r.draft && !r.prerelease && r.tag_name)
        .map((r) => ({
          version: stripV(r.tag_name),
          url: r.html_url,
          publishedAt: r.published_at,
          body: r.body ?? '',
        }))
      gNotes.__openground_release_notes = { at: Date.now(), releases }
      const body: ReleaseNotesResponse = { current, releases }
      return c.json(body)
    } catch (e) {
      // Stale cache beats an empty panel; a true first-fetch failure surfaces
      // as an error the section renders inline.
      const releases = cached?.releases ?? []
      const body: ReleaseNotesResponse = {
        current,
        releases,
        error: e instanceof Error ? e.message : String(e),
      }
      return c.json(body)
    }
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
