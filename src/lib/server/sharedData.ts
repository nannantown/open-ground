import { join } from 'path'
import { readFile } from 'fs/promises'
import { atomicWriteJson } from './atomicWrite'

// ── Git-shared data seam ──────────────────────────────────────────────────
// A project can opt into storing its Board + Canvas data INSIDE the repo
// (".openground/", committed and shared through normal git) instead of the
// central ~/.openground/projects/<uuid>/ dir. The presence of a parseable
// marker file is the single source of truth for which mode a project is in:
// detection is automatic (a collaborator who clones a shared repo gets shared
// mode with zero setup), creation only ever happens via the explicit
// /api/project/share/enable route — the app never writes into a user's repo
// uninvited. See docs/SHARED_DATA_PLAN.md for the full design.
//
// Personal state (tabOrder, canvas activeId) NEVER moves into the repo; the
// storage adapters compose shared files + the central store.

export const SHARED_DIR = '.openground'
export const SHARED_MARKER_FILE = 'openground.json'

/** `<projectPath>/.openground` */
export const sharedDataDir = (projectPath: string): string => join(projectPath, SHARED_DIR)

export const sharedMarkerPath = (projectPath: string): string =>
  join(sharedDataDir(projectPath), SHARED_MARKER_FILE)

/** One ProjectTask per file under here — appends never conflict in git. */
export const boardCardsDir = (projectPath: string): string =>
  join(sharedDataDir(projectPath), 'board', 'cards')

/** ProjectData.notes as plain markdown (human-readable diffs). */
export const boardNotesPath = (projectPath: string): string =>
  join(sharedDataDir(projectPath), 'board', 'notes.md')

/** Board-card image attachments (one flat dir, content-hash file names) —
 *  shared mode mirrors canvas assets: the bytes ride the repo so a teammate's
 *  clone renders the same card thumbnails with zero setup. */
export const boardAssetsDir = (projectPath: string): string =>
  join(sharedDataDir(projectPath), 'board', 'assets')

/** Existing CanvasFile format, one file per canvas. */
export const canvasFilesDir = (projectPath: string): string =>
  join(sharedDataDir(projectPath), 'canvas', 'canvases')

/** Shared canvas order only ({order: string[]}); activeId stays central. */
export const canvasIndexPath = (projectPath: string): string =>
  join(sharedDataDir(projectPath), 'canvas', 'index.json')

/** Root holding the per-canvas asset dirs (one subdir per canvas id). */
export const canvasAssetsRoot = (projectPath: string): string =>
  join(sharedDataDir(projectPath), 'canvas', 'assets')

/** Canvas image assets, one subdir per canvas id. */
export const canvasAssetsDir = (projectPath: string, canvasId: string): string =>
  join(canvasAssetsRoot(projectPath), canvasId)

/** Marker + shared project-level meta. `version` is required and numeric —
 *  anything else is treated as "not shared" rather than an error, so a stray
 *  or corrupt file in someone's repo can never flip a project into shared
 *  mode by accident. */
export interface SharedMarker {
  version: number
  /** The project description shown on the Ground card — shared so a fresh
   *  clone gets it for free. Optional for forward-compat. */
  description?: string
  /** Generated language pair — collaborators with different language settings
   *  each see their own (descriptionForLang picks; falls back to description). */
  descriptionJa?: string
  descriptionEn?: string
  /** Shared project policy (completion flow / target branch / verify commands
   *  / review column) — see ProjectConfig in types.ts. Plain JSON passthrough;
   *  zod-validated when composed into ProjectData. */
  config?: Record<string, unknown>
}

export const SHARED_DATA_VERSION = 1

/** Parse the marker, or null when absent/unreadable/invalid (= not shared). */
export const readSharedMarker = async (projectPath: string): Promise<SharedMarker | null> => {
  try {
    const raw = await readFile(sharedMarkerPath(projectPath), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === 'number'
    ) {
      const m = parsed as {
        version: number
        description?: unknown
        descriptionJa?: unknown
        descriptionEn?: unknown
        config?: unknown
      }
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
      return {
        version: m.version,
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

/** Is this project in git-shared mode? (Fresh fs check per call — same
 *  no-cache philosophy as projectDataPath: a `git pull` or an enable/disable
 *  must be visible on the very next request.) */
export const isShared = async (projectPath: string): Promise<boolean> =>
  (await readSharedMarker(projectPath)) !== null

export const writeSharedMarker = async (
  projectPath: string,
  marker: SharedMarker,
): Promise<void> => {
  await atomicWriteJson(sharedMarkerPath(projectPath), marker)
}
