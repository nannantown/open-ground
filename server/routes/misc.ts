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
import { mkdir, rmdir, stat, readFile } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { execFile as execFileCb, spawn } from 'child_process'
import { promisify } from 'util'
import {
  getSettings,
  setSettings,
  setUserSettings,
  getCanvas,
  setCanvas,
  getNotificationState,
  markNotificationsRead,
  isLockdownEnabled,
  getManagerRuntimeDial,
} from '@/lib/server/store'
import { resolveExperiments } from '@/lib/server/experiments'
import { scanProjects } from '@/lib/server/scan'
import {
  acknowledgeIntegrityReport,
  listRestoreCandidatesForAll,
  readLastIntegrityReport,
} from '@/lib/server/homeIntegrity'
import { writeProjectData } from '@/lib/server/projectData'
import { updateRestartSafety } from '@/lib/server/liveDesks'
import {
  ensureProjectsMigrated,
  addCreatedProjectEntry,
  addImportedProjectEntry,
  removeProjectEntry,
} from '@/lib/server/registry'
import { ensureShareEvacuated, evacuateImportedProject } from '@/lib/server/shareEvac'
import { collectClaudeUsage } from '@/lib/server/claudeUsage'
import {
  fetchClaudeUsageCli,
  invalidateUsageCache,
  emptyCliUsage,
} from '@/lib/server/claudeUsageCli'
import { claudeConnection } from '@/lib/server/claudeConnection'
import { probeGhCli } from '@/lib/server/ghCli'
import { installHooks, uninstallHooks } from '@/lib/server/hooksInstall'
import type {
  NotificationStateResponse,
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
//
// NOTE: this is the DEV-BROWSER FALLBACK only. The packaged app (Electron, any
// OS) picks folders through the cross-platform Electron dialog instead — the
// client prefers window.openground.showOpenDialog and only falls back to this
// route when that bridge is absent (a plain vite dev browser, which is macOS).
// See src/lib/pickFolder.ts. osascript exists on macOS alone, which is why a
// Windows/Linux build must NOT reach here (it would fail with "Could not open
// the folder picker").
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
  // --- GET /api/home-integrity ----------------------------------------------
  // The home-data damage report: what the boot check found, and — the part the
  // owner actually needs — WHERE the restore candidates are. READ-ONLY by
  // contract: it never restores anything (homeIntegrity rule 2), it only says
  // what could be restored and from where.
  //
  // Ungated. It reports paths under the user's own ~/.openground on a
  // loopback-only server — the same class of information GET /api/projects
  // already returns — and putting the one surface that says "your data may be
  // gone" behind the swarm owner check would hide it from the person it is for.
  .get('/api/home-integrity', async (c) => {
    const [lastReport, candidates] = await Promise.all([
      readLastIntegrityReport(),
      listRestoreCandidatesForAll(),
    ])
    return c.json({ lastReport, candidates })
  })
  // --- POST /api/home-integrity/acknowledge ----------------------------------
  // "I know, this is fine now." Accepts the current state as the new baseline so
  // the app stops reporting a loss the owner has already decided about. Writes
  // ONLY integrity.json — never the protected files, never the backups — so the
  // worst case is silence about something already known, and every generation
  // stays restorable afterwards.
  .post('/api/home-integrity/acknowledge', async (c) => {
    const w = await acknowledgeIntegrityReport()
    return c.json({ acknowledgedAt: w.acknowledgedAt ?? null, counts: w.counts ?? {} })
  })
  // --- GET /api/projects ----------------------------------------------------
  .get('/api/projects', async (c) => {
    // Runs the one-shot legacy migration (existing users' projectsRoot →
    // registry, with canvas positions re-keyed) before listing. Idempotent.
    await ensureProjectsMigrated()
    // Carry any legacy in-repo "Share via Git" data (.openground/) back to the
    // central store once — the Share feature is gone. Idempotent (sentinel).
    await ensureShareEvacuated()
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

    let createdDir = false
    let registered = false
    try {
      await mkdir(target, { recursive: false })
      createdDir = true
      const desc = (description ?? '').trim()
      // Register the new folder BEFORE writing its central data. writeProjectData
      // routes through projectDataDir → projectUUIDFromPath(target), which THROWS
      // unless `target` is already a registered project — so a write here before
      // the register would 500 and strand the folder we just made: unregistered
      // on disk (invisible on the canvas) yet stat-able, so the next same-name
      // attempt fails the 409 "already exists" check forever.
      // addCreatedProjectEntry runs the same overlap/dangerous-target guard as
      // /import inside the registry lock: without it, a project created inside
      // an existing one would resolve to the OUTER project's UUID for all its
      // central data (projectUUIDFromPath returns the first isAtOrUnder match),
      // silently cross-wiring the two boards.
      const result = await addCreatedProjectEntry(target, desc || undefined)
      if ('rejection' in result) {
        // Undo the mkdir so the rejected spot isn't left holding an empty,
        // unregistered folder (which would 409 a corrected retry of the same
        // name). Deliberately NOT remembering the workspace — it just proved
        // to be a bad location.
        await rmdir(target).catch(() => {})
        const msg =
          result.rejection === 'overlap'
            ? 'That location overlaps a project already on your canvas.'
            : 'Pick a spot inside a normal folder, not your whole drive or home folder.'
        return c.json({ error: msg }, 400)
      }
      const entry = result.entry
      registered = true
      // Remember the workspace as part of this register step so a follow-up
      // canvas/tasks save can't race the security boundary either.
      if (ws !== settings.defaultWorkspace) await setSettings({ defaultWorkspace: ws })
      if (desc) {
        await writeProjectData(target, {
          description: desc,
          tasks: [],
          notes: '',
          updatedAt: new Date().toISOString(),
        })
      }
      return c.json({ path: target, name: clean, id: entry.id })
    } catch (e: any) {
      // Roll back a partial create so a mid-create failure leaves NO orphan: an
      // unregistered folder on disk would block same-name re-creation with a 409,
      // and a registry entry with no folder would surface a phantom "missing"
      // card. Best-effort (a cleanup failure must not mask the real error); the
      // folder we made is empty — writeProjectData writes to the central data dir,
      // never into `target` — so a non-recursive rmdir is safe.
      if (registered) await removeProjectEntry(target).catch(() => {})
      if (createdDir) await rmdir(target).catch(() => {})
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
    // A shared-clone (.openground/openground.json) imported AFTER the one-shot
    // global evac sentinel was stamped is never caught by the boot-time sweep —
    // rescue its inert Board/Canvas data into the central store now. No-op for a
    // normal folder (no marker); the fresh UUID means there is nothing to clobber.
    await evacuateImportedProject(entry)
    // basename (not split('/')) so the response name is the folder name on
    // Windows too — entry.path uses '\' there, which split('/') would miss.
    return c.json({ path: entry.path, name: basename(entry.path) || entry.path, id: entry.id })
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
    // The persisted settings plus two NON-persisted, server-computed fields —
    // the display-name suggestion (see suggestedDisplayName above) and the
    // resolved commander runtime dial. The POST below never receives either
    // back: the client saves only real Settings fields, and neither key is on
    // USER_SETTINGS_KEYS, so a forged body carrying them is dropped.
    //
    // ⚠ WHY THE RESOLVED DIAL RIDES ALONG. The Swarm tab's toggle IS the kill
    // switch for the SDK commander, and it used to re-implement the server's
    // rule against the raw keys in this same body. That copy drifted twice on
    // 2026-08-02: an absent dial drew ON while dispatch ran PTY, and (once an
    // unreadable settings.json started falling to the kill switch) a broken
    // file drew ON while the server ran PTY — the second one firing at exactly
    // the moment the owner reads the switch. The raw keys CANNOT answer it: a
    // tolerant read reports a missing key for both "never written" and "the
    // file is unreadable", which resolve to opposite runtimes. So the answer is
    // computed HERE, through the same reader desk launch (swarmManager.ts)
    // consults — one extra small local read per GET, in exchange for a toggle
    // that cannot lie. (The worker half of this block died 2026-08-13 with the
    // worker dial: workers are SDK-only, there is no worker toggle to draw.)
    const [settings, suggested, managerDial] = await Promise.all([
      getSettings(),
      suggestedDisplayName(),
      getManagerRuntimeDial(),
    ])
    const body: SettingsResponse = {
      ...settings,
      suggestedDisplayName: suggested,
      runtimeDialsEffective: {
        manager: managerDial.mode,
      },
    }
    return c.json(body)
  })
  .post('/api/settings', async (c) => {
    // SECURITY: never blind-merge the raw body. setSettings is a general merge,
    // so passing the body straight through let a forged / CSRF POST overwrite
    // `projects` — the validateProjectPath allowlist — with an arbitrary path
    // (e.g. /etc), which would make EVERY path-accepting route's boundary check
    // pass and let the caller spawn a shell/claude anywhere on disk. setUserSettings
    // narrows the body to a USER-PREFERENCE allowlist (language / displayName /
    // defaultWorkspace / openApps / defaultEditor / experiments), dropping
    // `projects`, `projectsRoot`, and the migration sentinels before the merge.
    // (Cross-origin forgery of this route is additionally blocked by the CSRF /
    // Origin guard in server/app.ts.) A non-JSON body is treated as empty (no-op).
    const body = await c.req.json().catch(() => ({}))
    await setUserSettings(body)
    return c.json({ ok: true })
  })
  // --- GET /api/notifications · POST /api/notifications/read -----------------
  // In-app notification READ-STATE (the Ground お知らせ bell). GET returns the set
  // of notification ids the user has already seen; POST merges more ids in (marking
  // read is monotonic — you never un-read). Persisted in ~/.openground (home-cache),
  // so unread state survives a re-login. This tracks ONLY read/unread — the
  // notification CONTENT comes from per-kind sources (today GET /api/collab/invites,
  // which is itself RLS-self-scoped). Local per-machine state with no cross-user
  // data (ids are opaque), so it needs no auth gate — mirrors /api/settings.
  .get('/api/notifications', async (c) => {
    const state = await getNotificationState()
    // Guard against a corrupted file so the client always gets a real array
    // (new Set(non-array) would throw client-side).
    return c.json<NotificationStateResponse>({
      readIds: Array.isArray(state.readIds) ? state.readIds : [],
    })
  })
  .post('/api/notifications/read', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((s): s is string => typeof s === 'string')
      : []
    const readIds = await markNotificationsRead(ids)
    return c.json<NotificationStateResponse>({ readIds })
  })
  // --- GET /api/experiments -------------------------------------------------
  // Owner-only experiment gate, resolved server-side (owner role AND the
  // settings toggle). Non-owners / signed-out users get eligible:false and
  // all-false flags, so every experimental surface stays invisible — see
  // src/lib/server/experiments.ts.
  .get('/api/experiments', async (c) => c.json(await resolveExperiments()))
  // --- GET /api/update/restart-safety ---------------------------------------
  // The Electron MAIN process asks this before auto-applying a downloaded
  // update (settings.autoUpdate) — "may the app restart right now without
  // destroying anything that can't come back?". Computed across BOTH desk
  // pools in ONE seam (liveDesks.updateRestartSafety); the caller fails CLOSED
  // (treats fetch error as unsafe). Pure read, no path input → no
  // validateProjectPath needed.
  .get('/api/update/restart-safety', async (c) => c.json(await updateRestartSafety()))
  // --- POST /api/sound/test -------------------------------------------------
  // The Settings「試聴」button: play the completion chime ONCE at the given
  // volume so the slider is auditable before a claude turn ever ends. Local
  // audio only (afplay / SystemSounds on this machine — no egress, so no
  // lockdown gate). Volume is narrowed exactly like setUserSettings does;
  // playback is fire-and-forget and fail-silent (`played:false` on an
  // unsupported platform, so the UI can say so instead of pretending).
  .post('/api/sound/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { volume?: unknown }
    const v = Number(body.volume)
    const volume = (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100) / 100
    let played = false
    try {
      if (process.platform === 'darwin') {
        spawn('afplay', ['-v', String(volume), '/System/Library/Sounds/Glass.aiff'], {
          detached: true,
          stdio: 'ignore',
        }).unref()
        played = true
      } else if (process.platform === 'win32') {
        spawn('powershell', ['-NoProfile', '-c', '[System.Media.SystemSounds]::Asterisk.Play()'], {
          detached: true,
          stdio: 'ignore',
        }).unref()
        played = true
      }
    } catch {
      played = false
    }
    return c.json({ ok: true, played })
  })
  // --- GET /api/usage -------------------------------------------------------
  .get('/api/usage', async (c) => {
    try {
      // `?refresh=1` busts the CLI-scrape cache so the user's manual refresh
      // actually re-runs `claude /usage` (≈9s) instead of returning the cached
      // value.
      if (c.req.query('refresh')) invalidateUsageCache()
      // Run both in parallel: the local jsonl scan is fast and always works,
      // the CLI scrape is slow (~9s wall, cached) but matches Anthropic's
      // numbers exactly. fetchClaudeUsageCli always resolves to a CliUsage
      // carrying a `status` (the defensive catch only fires on an unexpected
      // throw), so the HUD always gets a reason and can fall back to the
      // local-estimate fields.
      const [local, cli] = await Promise.all([
        collectClaudeUsage(),
        fetchClaudeUsageCli().catch(() => emptyCliUsage('scrape-failed')),
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
    // Work mode (lockdown): answer locally without touching GitHub. `lockdown:
    // true` lets the client say WHY checking is off rather than showing a
    // spurious "up to date".
    if (await isLockdownEnabled()) {
      return c.json({
        current,
        latest: current,
        hasUpdate: false,
        releaseUrl: '',
        publishedAt: '',
        notes: '',
        lockdown: true,
      })
    }
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
    // Work mode (lockdown): no GitHub fetch, not even a cached list (the panel
    // should read "disabled", not "up to date as of some earlier fetch").
    if (await isLockdownEnabled()) {
      const body: ReleaseNotesResponse = { current, releases: [], lockdown: true }
      return c.json(body)
    }
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
  // Dev-browser fallback for the folder picker (macOS osascript). The packaged
  // app goes through the Electron dialog (cross-platform) — see the helper note
  // above and src/lib/pickFolder.ts.
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
