// server/routes/share.ts — Git-shared Board/Canvas data routes (Track C).
// Thin adapters over src/lib/server/gitShare.ts (the §3.8 "src/lib/server is
// the source of truth" rule) — see docs/SHARED_DATA_PLAN.md for the pinned
// contracts. Both routes take a project `path` and run it through the
// validateProjectPath security boundary (requireProjectPath) before any git
// command executes in that directory.
//
import { rm } from 'fs/promises'
import { Hono } from 'hono'
import { enablePreconditions, shareStatus, shareSync } from '@/lib/server/gitShare'
import { migrateBoardFromShared, migrateBoardToShared } from '@/lib/server/projectData'
import { migrateCanvasFromShared, migrateCanvasToShared } from '@/lib/server/canvasData'
import { isShared, sharedDataDir } from '@/lib/server/sharedData'
import { requireProjectPath } from '../middleware/projectPath'

// Human-readable enable failures. Shown raw by the share dialog — kept short
// and actionable (the 'ignored' one is the case users actually hit).
const ENABLE_ERRORS: Record<'not-git' | 'already-shared' | 'ignored', string> = {
  'not-git': 'This project folder is not a git repository.',
  'already-shared': 'This project is already shared via git.',
  ignored:
    "This repo's .gitignore would ignore .openground/ — remove that rule first, otherwise the shared data could never be committed.",
}

export const shareRoutes = new Hono()
  // GET /api/project/share/status?path= → ShareStatus
  // { shared, gitRepo, remoteUrl, dirty } — never errors for a valid path
  // (each field degrades to its "no" value when git is absent/unhappy).
  .get('/api/project/share/status', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    return c.json(await shareStatus(path))
  })
  // POST /api/project/share/sync {path} → ShareSyncResult
  // commit (.openground/ pathspec only) → pull --rebase --autostash → push.
  // Conflicts come back as 200 {ok:false, conflict:true, message} — a result
  // the UI narrates, not a transport error.
  .post('/api/project/share/sync', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    return c.json(await shareSync(path))
  })
  // POST /api/project/share/enable {path} → {ok:true} | {error}
  // Creates .openground/ and migrates Board + Canvas data into the repo. The
  // ONLY code path that ever creates the folder — detection elsewhere is
  // passive (marker presence). Nothing is committed here; the first Sync (or
  // the user's own git flow) publishes it.
  .post('/api/project/share/enable', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const pre = await enablePreconditions(path)
    if (!pre.ok) return c.json({ error: ENABLE_ERRORS[pre.reason], reason: pre.reason }, 412)
    try {
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
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'disable failed' }, 500)
    }
  })
