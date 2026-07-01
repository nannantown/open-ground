import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { openGroundHome } from './paths'
import { atomicWriteText } from './atomicWrite'
import type { CanvasFile, ProjectData } from '../types'

// Local read-cache for FOLDER-LESS shared projects (member flow, option A).
//
// A member has no local repo, so their Board for a shared project lives in the
// authoritative Y.Doc (served by the Cloudflare DO). This cache mirrors the
// doc-derived board to disk so the panel opens INSTANTLY (and is readable
// offline) instead of showing a blank "connecting…" until the doc syncs. The DO
// stays authoritative — this is a convenience cache, never the source of truth.
//
// It lives under ~/.openground/shared/<collabProjectId>/ — a SEPARATE root from
// the registry's ~/.openground/projects/<uuid>/, so a shared-project cache can
// never be confused with (or collide into) a real local project's data dir.
//
// SECURITY: collabProjectId is client-supplied. It is og_projects.id
// (gen_random_uuid), so we accept ONLY a strict UUID — that makes it impossible
// to traverse out of the shared root (no '..', '/', NUL, etc.). The ROUTE layer
// additionally gates every read/write on MEMBERSHIP (getMyMembership under the
// caller's JWT); this module is pure disk I/O and never throws to the caller.

// Strict UUID (matches gen_random_uuid output). Rejecting non-UUIDs is the
// path-traversal guard — `..`/slashes/etc. can never satisfy it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isCollabProjectId = (id: string): boolean =>
  typeof id === 'string' && UUID_RE.test(id)

// Canvas ids are crypto.randomUUID (or an `id-xxxx` fallback). Accept any bounded
// alphanumeric/-/_ token — no `.`, `/`, NUL — so a client-supplied canvasId can
// never traverse out of the per-project shared dir. (More permissive than a
// strict UUID to cover the fallback, but equally traversal-safe.)
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const isSafeId = (id: string): boolean =>
  typeof id === 'string' && SAFE_ID_RE.test(id)

// A cache far larger than this is junk or abuse — refuse it rather than
// let a runaway client fill the user's disk (self-DoS guard; review LOW).
const MAX_CACHE_BYTES = 8 * 1024 * 1024

const sharedCacheDir = (collabProjectId: string): string =>
  join(openGroundHome(), 'shared', collabProjectId)

const cacheFile = (collabProjectId: string): string =>
  join(sharedCacheDir(collabProjectId), 'board.json')

// Per-canvas cache file: <shared>/<collabProjectId>/canvas/<canvasId>.json. Both
// ids are validated by the read/write helpers before this is reached.
const canvasCacheFile = (collabProjectId: string, canvasId: string): string =>
  join(sharedCacheDir(collabProjectId), 'canvas', `${canvasId}.json`)

// Read the cached board for a shared project. Returns null on invalid id /
// absent file / unreadable / malformed JSON / wrong shape. Never throws.
export const readSharedBoardCache = async (
  collabProjectId: string,
): Promise<ProjectData | null> => {
  if (!isCollabProjectId(collabProjectId)) return null
  try {
    const raw = await readFile(cacheFile(collabProjectId), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    // Minimal shape guard — the panel renders this, so a corrupt cache must not
    // crash the board (it just falls back to the live doc).
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as ProjectData).tasks)
    ) {
      return null
    }
    return parsed as ProjectData
  } catch {
    return null
  }
}

// Write the cached board. No-op (false) on invalid id / write error. Never
// throws. Creates the shared root on first write. The write is ATOMIC
// (atomicWriteText = temp file + rename), so the doc-sync mirror POSTing the same
// board concurrently — or a crash mid-write — can never leave a torn / truncated
// board.json for the next readSharedBoardCache to choke on (it would parse-fail →
// null → fall back to "connecting"). A reader only ever sees a complete file.
export const writeSharedBoardCache = async (
  collabProjectId: string,
  data: ProjectData,
): Promise<boolean> => {
  if (!isCollabProjectId(collabProjectId)) return false
  // Serialize first (in its own guard) so a non-serializable / cyclic / JSON-bomb
  // payload becomes an inert no-op instead of throwing, and so we can size-cap
  // BEFORE touching the disk.
  let json: string
  try {
    json = JSON.stringify(data)
  } catch {
    return false
  }
  if (json.length > MAX_CACHE_BYTES) {
    console.error(
      `[openground:sharedcache] refusing oversized board (${json.length}B > ${MAX_CACHE_BYTES}B)`,
    )
    return false
  }
  try {
    await mkdir(sharedCacheDir(collabProjectId), { recursive: true })
    await atomicWriteText(cacheFile(collabProjectId), json)
    return true
  } catch {
    return false
  }
}

// Read a member's cached CANVAS (cv4) — the offline/instant copy of one shared
// canvas. Returns null on invalid ids / absent / unreadable / wrong shape. Never
// throws. Both ids are validated (collabProjectId strict-UUID; canvasId safe-id)
// so neither can traverse out of the shared root.
export const readSharedCanvasCache = async (
  collabProjectId: string,
  canvasId: string,
): Promise<CanvasFile | null> => {
  if (!isCollabProjectId(collabProjectId) || !isSafeId(canvasId)) return null
  try {
    const raw = await readFile(canvasCacheFile(collabProjectId, canvasId), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as CanvasFile).elements)
    ) {
      return null
    }
    return parsed as CanvasFile
  } catch {
    return null
  }
}

// Write a member's cached CANVAS (cv4). No-op (false) on invalid ids / oversized /
// non-serializable / write error. Never throws. ATOMIC (atomicWriteText = temp +
// rename) for the same reason as the board: a concurrent doc-sync mirror writing
// the same canvasId — or a mid-write crash — never leaves a torn cache file.
export const writeSharedCanvasCache = async (
  collabProjectId: string,
  canvasId: string,
  data: CanvasFile,
): Promise<boolean> => {
  if (!isCollabProjectId(collabProjectId) || !isSafeId(canvasId)) return false
  let json: string
  try {
    json = JSON.stringify(data)
  } catch {
    return false
  }
  if (json.length > MAX_CACHE_BYTES) {
    console.error(
      `[openground:sharedcache] refusing oversized canvas (${json.length}B > ${MAX_CACHE_BYTES}B)`,
    )
    return false
  }
  try {
    await mkdir(join(sharedCacheDir(collabProjectId), 'canvas'), { recursive: true })
    await atomicWriteText(canvasCacheFile(collabProjectId, canvasId), json)
    return true
  } catch {
    return false
  }
}
