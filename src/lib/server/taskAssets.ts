// Board-card image attachments (B022). A card can carry screenshots; the
// "Insert task into input" paste appends their ABSOLUTE paths so the claude
// session can Read them directly.
//
// Storage follows the canvas-asset precedent exactly (canvasImages.ts):
//  - normal mode  → central ~/.openground/projects/<uuid>/task-assets/
//  - git-shared   → <repo>/.openground/board/assets/  (synced through git, so
//    a teammate's clone renders the same thumbnails — same rationale as
//    .openground/canvas/assets/)
//
// The asset id IS the file name: `<sha1-of-content>.<ext>`. Content-addressing
// makes uploads idempotent (re-pasting the same screenshot dedupes for free)
// and the strict id shape doubles as the traversal guard — the GET/DELETE
// routes echo client-supplied ids, so anything that isn't `40 hex + known
// image ext` is rejected before it can touch a path.

import { createHash } from 'crypto'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { projectDataDir } from './projectDataPath'
import { boardAssetsDir, isShared } from './sharedData'
import { extForMime } from './canvasImages'

/** Central asset-dir name under ~/.openground/projects/<uuid>/. */
export const TASK_ASSETS_SUBDIR = 'task-assets'

/** Upload cap — screenshots are well under this; bounds the base64 body. */
export const MAX_TASK_ASSET_BYTES = 5 * 1024 * 1024

// Extension → mime for the read path. Same closed whitelist as canvasImages
// (its EXT_TO_MIME is intentionally private — owning a copy here keeps the
// two stores independently tightenable).
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Strict id = `<sha1 hex>.<whitelisted ext>` — the ONLY shape the routes (and
 *  paste-task) accept from a client, so a forged id can never traverse out of
 *  the assets dir or address a non-image file. */
export const isValidTaskAssetId = (id: string): boolean => {
  const dot = id.lastIndexOf('.')
  if (dot !== 40) return false
  return /^[0-9a-f]{40}$/.test(id.slice(0, dot)) && Boolean(EXT_TO_MIME[id.slice(dot + 1)])
}

/** The live assets dir for this project's current mode (fresh marker check per
 *  call — same no-cache philosophy as canvasImages/sharedData). */
export const taskAssetsDir = async (projectPath: string): Promise<string> =>
  (await isShared(projectPath))
    ? boardAssetsDir(projectPath)
    : join(await projectDataDir(projectPath), TASK_ASSETS_SUBDIR)

/** Persist an uploaded image's bytes; returns the content-hash id. Throws on a
 *  mime outside the whitelist (the route pre-checks and 400s, so a throw here
 *  is a server bug, not user input). */
export const writeTaskAsset = async (
  projectPath: string,
  mime: string,
  data: Buffer,
): Promise<string> => {
  const ext = extForMime(mime)
  if (!ext) throw new Error(`unsupported image type: ${mime}`)
  const id = `${createHash('sha1').update(data).digest('hex')}.${ext}`
  const dir = await taskAssetsDir(projectPath)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, id), data)
  return id
}

/** Absolute on-disk path for an asset id (paste-task resolves attachments to
 *  paths claude can Read). The caller MUST have validated the id. */
export const taskAssetPath = async (projectPath: string, id: string): Promise<string> => {
  if (!isValidTaskAssetId(id)) throw new Error(`invalid task asset id: ${id}`)
  return join(await taskAssetsDir(projectPath), id)
}

/** Read an asset's bytes + mime, or null when invalid / not on disk. */
export const readTaskAsset = async (
  projectPath: string,
  id: string,
): Promise<{ data: Buffer; mime: string } | null> => {
  if (!isValidTaskAssetId(id)) return null
  try {
    const data = await readFile(join(await taskAssetsDir(projectPath), id))
    return { data, mime: EXT_TO_MIME[id.slice(id.lastIndexOf('.') + 1)] }
  } catch {
    return null
  }
}

/** Best-effort delete. Content-addressed files can be referenced by SEVERAL
 *  cards (same screenshot attached twice dedupes to one file), so the route
 *  only calls this after checking no task still references the id. */
export const deleteTaskAsset = async (projectPath: string, id: string): Promise<void> => {
  if (!isValidTaskAssetId(id)) return
  try {
    await unlink(join(await taskAssetsDir(projectPath), id))
  } catch {
    /* best-effort */
  }
}
