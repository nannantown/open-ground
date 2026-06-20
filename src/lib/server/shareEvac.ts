import { cp, mkdir, readFile, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJson } from './atomicWrite'
import { getSettings, setSettings } from './store'
import { openGroundHome, projectCentralDir } from './paths'
import { ProjectTaskSchema } from '../schemas'

// ── One-shot evacuation of the removed "Share via Git" feature ───────────────
// OPEN GROUND used to let a project store its Board + Canvas data INSIDE the
// repo under `.openground/` (a parseable `.openground/openground.json` marker
// was the mode switch), committed and synced through plain git. That feature
// is gone — all per-project data now lives centrally under
// ~/.openground/projects/<uuid>/ unconditionally.
//
// A user who had turned Share on still has their live Board/Canvas data sitting
// in the repo's `.openground/`. This migration copies it back into the central
// store ONCE so nothing is lost, then stamps a sentinel. It deliberately does
// NOT delete the repo's `.openground/` dir: it may be git-tracked (deleting it
// would dirty the user's working tree uninvited — see CLAUDE.md "no files
// written into project folders"); once the data is central the app never reads
// it again, so a leftover dir is inert. Best-effort per project: one bad repo
// is logged and skipped, never wedging the others or the boot path.

const now = () => new Date().toISOString()

const SHARED_DIR = '.openground'
const SHARED_MARKER_FILE = 'openground.json'
const TASKS_FILE = 'tasks.json'
const CANVASES_DIR = 'canvases'
const CANVASES_INDEX_FILE = 'canvases-index.json'
const TASK_ASSETS_SUBDIR = 'task-assets'
const CANVAS_ASSETS_SUFFIX = '-assets'

// Cached per OPEN GROUND home so the suite (a fresh tmp home per case) evacuates
// each home once, while a single home is never scanned twice in one process.
// The persisted `shareEvacuatedAt` sentinel is the cross-process guard. Mirrors
// registry.ts's ensureProjectsMigrated.
const evacuating = new Map<string, Promise<void>>()

export const ensureShareEvacuated = async (): Promise<void> => {
  const home = openGroundHome()
  let p = evacuating.get(home)
  if (!p) {
    p = evacuateOnce()
    // Evict on rejection so a transient FS failure self-heals on the next call
    // rather than caching a permanently-rejected promise.
    p.catch(() => {
      if (evacuating.get(home) === p) evacuating.delete(home)
    })
    evacuating.set(home, p)
  }
  return p
}

// Evacuate a SINGLE just-registered project's inert `.openground/` data into its
// central store, bypassing the one-shot global `shareEvacuatedAt` sentinel.
//
// evacuateOnce (the boot sweep) is gated by that sentinel so it runs once per
// home over the projects present AT THAT TIME. A shared-clone IMPORTED later —
// after the sentinel is stamped (i.e. on every existing install) — would never
// be swept, leaving its Board/Canvas data inert in the repo so the project shows
// up empty. The import route calls this so a late import is rescued too.
//
// Safe to call unconditionally: a non-shared folder has no marker, so
// evacuateProject is a cheap no-op; an import always mints a FRESH central UUID,
// so there is nothing central to clobber. Best-effort — a failure is logged and
// swallowed so a broken repo never fails the import itself (the data stays
// inert-recoverable, exactly as before this call existed).
export const evacuateImportedProject = async (entry: {
  id: string
  path: string
}): Promise<void> => {
  try {
    await evacuateProject(entry.path, projectCentralDir(entry.id))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[shareEvac] failed to evacuate imported ${entry.path}: ${String(err)}`)
  }
}

const evacuateOnce = async (): Promise<void> => {
  const settings = await getSettings()
  if (settings.shareEvacuatedAt) return
  for (const entry of settings.projects ?? []) {
    try {
      // Resolve the central dir straight from the registry entry id (NOT via
      // projectUUIDFromPath) so this never recurses back through the boot path.
      await evacuateProject(entry.path, projectCentralDir(entry.id))
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[shareEvac] failed to evacuate ${entry.path}: ${String(err)}`)
    }
  }
  await setSettings({ shareEvacuatedAt: now() })
}

interface LegacyMarker {
  version: number
  description?: string
  descriptionJa?: string
  descriptionEn?: string
  config?: Record<string, unknown>
}

const readMarker = async (projectPath: string): Promise<LegacyMarker | null> => {
  try {
    const raw = await readFile(join(projectPath, SHARED_DIR, SHARED_MARKER_FILE), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === 'number'
    ) {
      const m = parsed as Record<string, unknown>
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
      return {
        version: m.version as number,
        description: str(m.description),
        descriptionJa: str(m.descriptionJa),
        descriptionEn: str(m.descriptionEn),
        ...(m.config && typeof m.config === 'object'
          ? { config: m.config as Record<string, unknown> }
          : {}),
      }
    }
    return null
  } catch {
    return null
  }
}

// `<dir>` json file names minus `.json`.
const listJsonIds = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
  } catch {
    return []
  }
}

// Overwrite-copy a directory (best-effort): clear dest, then copy src if it
// exists. A missing source just clears the dest (no shared assets = none).
const copyDirOverwrite = async (src: string, dest: string): Promise<void> => {
  await rm(dest, { recursive: true, force: true })
  try {
    await cp(src, dest, { recursive: true })
  } catch {
    /* no source dir — nothing to carry over */
  }
}

const evacuateProject = async (projectPath: string, centralDir: string): Promise<void> => {
  const marker = await readMarker(projectPath)
  if (!marker) return // never shared (or marker absent/corrupt) — nothing to do

  await mkdir(centralDir, { recursive: true })

  // ── Board: shared cards + notes + marker description/config → central
  //    tasks.json, PRESERVING the central personal fields (tabOrder/customTabs/
  //    launch/disabledModules) the marker never carried. ──
  const cardsDir = join(projectPath, SHARED_DIR, 'board', 'cards')
  const tasks: unknown[] = []
  try {
    const files = (await readdir(cardsDir)).filter((f) => f.endsWith('.json'))
    for (const f of files) {
      try {
        const raw: unknown = JSON.parse(await readFile(join(cardsDir, f), 'utf8'))
        const r = ProjectTaskSchema.safeParse(raw)
        if (r.success) tasks.push(r.data)
      } catch {
        /* skip a corrupt card file — never abort the whole evacuation */
      }
    }
  } catch {
    /* no cards dir — notes-only or fresh share */
  }

  let notes = ''
  try {
    notes = await readFile(join(projectPath, SHARED_DIR, 'board', 'notes.md'), 'utf8')
  } catch {
    /* no notes file = '' */
  }

  let central: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(join(centralDir, TASKS_FILE), 'utf8'))
    if (parsed && typeof parsed === 'object') central = { ...(parsed as Record<string, unknown>) }
  } catch {
    /* no central file yet (fresh clone) */
  }

  const next: Record<string, unknown> = {
    ...central,
    description: marker.description ?? '',
    ...(marker.descriptionJa ? { descriptionJa: marker.descriptionJa } : {}),
    ...(marker.descriptionEn ? { descriptionEn: marker.descriptionEn } : {}),
    // The shared board policy (completion flow / target branch / members …)
    // rides home in tasks.json's config; ProjectDataSchema validates it on read.
    ...(marker.config ? { config: marker.config } : {}),
    tasks,
    notes,
    updatedAt: now(),
  }
  await atomicWriteJson(join(centralDir, TASKS_FILE), next)

  // Board card image attachments: .openground/board/assets/ → central task-assets/
  await copyDirOverwrite(
    join(projectPath, SHARED_DIR, 'board', 'assets'),
    join(centralDir, TASK_ASSETS_SUBDIR),
  )

  // ── Canvas: shared canvas files + order + per-canvas assets → central.
  //    Only when the repo actually carried canvas data (else leave central as-is
  //    so a board-only share doesn't wipe local canvases). ──
  const repoCanvasFilesDir = join(projectPath, SHARED_DIR, 'canvas', CANVASES_DIR)
  const ids = await listJsonIds(repoCanvasFilesDir)
  if (ids.length > 0) {
    const centralCanvases = join(centralDir, CANVASES_DIR)
    await rm(centralCanvases, { recursive: true, force: true })
    await mkdir(centralCanvases, { recursive: true })
    for (const id of ids) {
      await cp(join(repoCanvasFilesDir, `${id}.json`), join(centralCanvases, `${id}.json`))
    }
    // Per-canvas asset dirs (.openground/canvas/assets/<id>/ → canvases/<id>-assets/).
    const repoAssetsRoot = join(projectPath, SHARED_DIR, 'canvas', 'assets')
    try {
      const assetDirs = await readdir(repoAssetsRoot, { withFileTypes: true })
      for (const d of assetDirs) {
        if (!d.isDirectory()) continue
        await cp(join(repoAssetsRoot, d.name), join(centralCanvases, `${d.name}${CANVAS_ASSETS_SUFFIX}`), {
          recursive: true,
        })
      }
    } catch {
      /* no canvas assets */
    }
    // Order (shared) → central index; keep the personal activeId when it still
    // points at a live canvas, else fall back to the first.
    const order = await readRepoCanvasOrder(
      join(projectPath, SHARED_DIR, 'canvas', 'index.json'),
      ids,
    )
    let activeId: string | null = null
    try {
      const idx: unknown = JSON.parse(await readFile(join(centralDir, CANVASES_INDEX_FILE), 'utf8'))
      const a = (idx as { activeId?: unknown })?.activeId
      if (typeof a === 'string' && order.includes(a)) activeId = a
    } catch {
      /* no central index yet */
    }
    if (!activeId) activeId = order[0] ?? null
    await atomicWriteJson(join(centralDir, CANVASES_INDEX_FILE), { order, activeId })
  }
}

// Shared canvas order ({order: string[]}), filtered to live ids with any
// missing id appended — the same convergence rule the old canvasData applied.
const readRepoCanvasOrder = async (indexPath: string, ids: string[]): Promise<string[]> => {
  let order: string[] = []
  try {
    const raw = await readFile(indexPath, 'utf8')
    const parsed = (JSON.parse(raw) as { order?: unknown })?.order
    if (Array.isArray(parsed)) order = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    /* no/garbled index — rebuild from the file list */
  }
  const live = new Set(ids)
  const out = order.filter((id) => live.has(id))
  for (const id of ids) if (!out.includes(id)) out.push(id)
  return out
}

// Test seam: reset the per-home evacuation cache so a test can re-run it against
// a freshly-seeded home within the same process.
export const __resetShareEvacCacheForTests = () => evacuating.clear()
