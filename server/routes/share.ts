// server/routes/share.ts — Git-shared Board/Canvas data routes (Track C).
// Thin adapters over src/lib/server/gitShare.ts (the §3.8 "src/lib/server is
// the source of truth" rule) — see docs/SHARED_DATA_PLAN.md for the pinned
// contracts. Both routes take a project `path` and run it through the
// validateProjectPath security boundary (requireProjectPath) before any git
// command executes in that directory.
//
import { rm } from 'fs/promises'
import { Hono } from 'hono'
import { enablePreconditions, shareResolve, shareStatus, shareSync } from '@/lib/server/gitShare'
import {
  autoSyncSnapshot,
  ensureAutoSync,
  noteManualSync,
  stopAutoSync,
} from '@/lib/server/shareAutoSync'
import {
  migrateBoardFromShared,
  migrateBoardToShared,
  readProjectData,
  writeProjectData,
} from '@/lib/server/projectData'
import { migrateCanvasFromShared, migrateCanvasToShared } from '@/lib/server/canvasData'
import { isShared, sharedDataDir } from '@/lib/server/sharedData'
import { requireProjectPath } from '../middleware/projectPath'
import type { ShareEnableConfig } from '@/lib/types'

// Human-readable enable failures. Shown raw by the share dialog — kept short
// and actionable (the 'ignored' one is the case users actually hit).
const ENABLE_ERRORS: Record<'not-git' | 'already-shared' | 'ignored', string> = {
  'not-git': 'This project folder is not a git repository.',
  'already-shared': 'This project is already shared via git.',
  ignored:
    "This repo's .gitignore would ignore .openground/ — remove that rule first, otherwise the shared data could never be committed.",
}

// Strict parse of the enable body's optional `config` (ShareEnableConfig):
// exactly the three whitelisted ProjectConfig keys, each type-checked. An
// unknown key or wrong type is a 400 — the seeded policy syncs to the whole
// team via the marker, so a malformed write must never slip through silently.
// `undefined` (no config in the body) = the legacy enable, fully unchanged.
const parseEnableConfig = (
  raw: unknown,
): { ok: true; config?: ShareEnableConfig } | { ok: false } => {
  if (raw === undefined) return { ok: true }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false }
  const obj = raw as Record<string, unknown>
  const config: ShareEnableConfig = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    if (key === 'completionFlow') {
      if (value !== 'merge' && value !== 'pr') return { ok: false }
      config.completionFlow = value
    } else if (key === 'targetBranch') {
      if (typeof value !== 'string') return { ok: false }
      // Kept even when '' (after trim): an empty string is the dialog's
      // explicit "clear the saved target branch" — the enable handler drops
      // the key from the merged config. Absent key = leave it untouched.
      config.targetBranch = value.trim()
    } else if (key === 'members') {
      if (!Array.isArray(value) || value.some((m) => typeof m !== 'string'))
        return { ok: false }
      const members = Array.from(
        new Set(value.map((m) => (m as string).trim()).filter(Boolean)),
      )
      if (members.length > 0) config.members = members
    } else {
      return { ok: false }
    }
  }
  return { ok: true, ...(Object.keys(config).length > 0 ? { config } : {}) }
}

export const shareRoutes = new Hono()
  // GET /api/project/share/status?path= → ShareStatus
  // { shared, gitRepo, remoteUrl, dirty } — never errors for a valid path
  // (each field degrades to its "no" value when git is absent/unhappy).
  .get('/api/project/share/status', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const status = await shareStatus(path)
    if (status.shared && status.gitRepo) {
      // The status poll doubles as the auto-sync heartbeat: it keeps the
      // engine's personal-pref flag fresh (launch.autoSync, default ON) and
      // lazily brings the project onto the engine's radar.
      const data = await readProjectData(path)
      const enabled = data.launch?.autoSync !== false
      ensureAutoSync(path, enabled)
      return c.json({ ...status, auto: autoSyncSnapshot(path) })
    }
    return c.json(status)
  })
  // POST /api/project/share/sync {path} → ShareSyncResult
  // commit (.openground/ pathspec only) → pull --rebase --autostash → push.
  // Conflicts come back as 200 {ok:false, conflict:true, message} — a result
  // the UI narrates, not a transport error.
  .post('/api/project/share/sync', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const result = await shareSync(path)
    // Keep the auto engine's view consistent with what the user just saw.
    noteManualSync(path, result)
    return c.json(result)
  })
  // POST /api/project/share/resolve {path, choices} → ShareSyncResult
  // Re-runs the sync, resolving each conflicted file to the user's chosen
  // side ('mine' | 'theirs'). Choices are advisory lookups — only files git
  // actually reports as unmerged are touched, and a conflict without a
  // choice rolls back and returns the fresh conflict set.
  .post('/api/project/share/resolve', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    let body: { choices?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const raw = body.choices
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json({ error: 'choices required' }, 400)
    }
    const choices: Record<string, 'mine' | 'theirs'> = {}
    for (const [file, side] of Object.entries(raw as Record<string, unknown>)) {
      if (side === 'mine' || side === 'theirs') choices[file] = side
    }
    if (Object.keys(choices).length === 0) return c.json({ error: 'choices required' }, 400)
    const result = await shareResolve(path, choices)
    noteManualSync(path, result)
    return c.json(result)
  })
  // POST /api/project/share/enable {path, config?} → {ok:true} | {error}
  // Creates .openground/ and migrates Board + Canvas data into the repo. The
  // ONLY code path that ever creates the folder — detection elsewhere is
  // passive (marker presence). Nothing is committed here; the first Sync (or
  // the user's own git flow) publishes it.
  // `config` (ShareEnableConfig, optional — docs/SHARE_UX_FLOWS.md §2c): the
  // ShareStartDialog's confirmed policy. Merged into the CENTRAL config
  // BEFORE the board migration, so the existing central→marker carry-over
  // (S049) publishes it — no separate marker write path.
  .post('/api/project/share/enable', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    // Hono caches c.req.json(), so re-reading after requireProjectPath is safe.
    const body = (await c.req.json().catch(() => ({}))) as { config?: unknown }
    const parsed = parseEnableConfig(body.config)
    if (!parsed.ok) return c.json({ error: 'invalid config' }, 400)
    const pre = await enablePreconditions(path)
    if (!pre.ok) return c.json({ error: ENABLE_ERRORS[pre.reason], reason: pre.reason }, 412)
    try {
      if (parsed.config) {
        // Still unshared here → this writes the central tasks.json, which
        // migrateBoardToShared then reads and carries into the marker.
        const data = await readProjectData(path)
        const merged = { ...data.config, ...parsed.config }
        // targetBranch:'' is the explicit clear ("branch at launch") — drop
        // the key entirely so the marker never publishes an empty branch.
        if (merged.targetBranch === '') delete merged.targetBranch
        await writeProjectData(path, { ...data, config: merged })
      }
      // Board first: it creates the marker (with the shared description);
      // canvas migration then merge-preserves it. Both are idempotent, so a
      // crash between the two is healed by re-running enable… except the
      // marker already exists then ('already-shared'). Acceptable: the repo
      // state is still consistent (canvas data simply not migrated yet) and
      // disable→enable recovers. Worth revisiting if it ever bites.
      await migrateBoardToShared(path)
      await migrateCanvasToShared(path)
      return c.json({ ok: true })
    } catch (e) {
      // Best-effort rollback so a half-written .openground/ doesn't flip the
      // project into shared mode with partial data on the next read.
      await rm(sharedDataDir(path), { recursive: true, force: true }).catch(() => {})
      return c.json({ error: e instanceof Error ? e.message : 'enable failed' }, 500)
    }
  })
  // POST /api/project/share/disable {path} → {ok:true} | {error}
  // Copies the repo data back into central storage, then deletes .openground/.
  // The deletion lands in the working tree only — the dialog tells the user
  // the removal still needs a commit (their normal git flow).
  .post('/api/project/share/disable', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    if (!(await isShared(path))) {
      return c.json({ error: 'This project is not shared via git.' }, 412)
    }
    try {
      await migrateBoardFromShared(path)
      await migrateCanvasFromShared(path)
      await rm(sharedDataDir(path), { recursive: true, force: true })
      stopAutoSync(path)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'disable failed' }, 500)
    }
  })
