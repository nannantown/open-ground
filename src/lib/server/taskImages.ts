import { mkdir, readFile, writeFile, readdir, unlink, stat } from 'fs/promises'
import { join } from 'path'
import type { ProjectData } from '../types'

// Clipboard-pasted task images live alongside tasks.json, inside the
// .openground/ directory OPEN GROUND owns. The file is named
// <imageId>.<ext>; its metadata (name, mime) is the TaskImage entry on the
// task in tasks.json.
const IMAGES_SUBDIR = '.openground/task-images'

// mime <-> extension whitelist. Clipboard images are effectively always one of
// these; anything else is rejected rather than guessed at.
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** The on-disk extension for a mime, or null if the type is unsupported. */
export const extForMime = (mime: string): string | null => MIME_TO_EXT[mime] ?? null

/** Image ids are client-generated; reject anything that could escape the dir. */
export const isValidImageId = (id: string) => /^[a-zA-Z0-9-]{1,64}$/.test(id)

const imagesDir = (projectPath: string) => join(projectPath, IMAGES_SUBDIR)

/** Persist a pasted image's bytes. Throws if the mime type is unsupported. */
export const writeTaskImage = async (
  projectPath: string,
  id: string,
  mime: string,
  data: Buffer,
) => {
  const ext = extForMime(mime)
  if (!ext) throw new Error(`unsupported image type: ${mime}`)
  const dir = imagesDir(projectPath)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${id}.${ext}`), data)
}

/** Read a stored image by id, returning its bytes and content-type. */
export const readTaskImage = async (
  projectPath: string,
  id: string,
): Promise<{ data: Buffer; mime: string } | null> => {
  const dir = imagesDir(projectPath)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  // The extension isn't known up front, so match <id>.<knownExt>.
  const match = entries.find((e) => {
    const dot = e.lastIndexOf('.')
    if (dot <= 0 || e.slice(0, dot) !== id) return false
    return Boolean(EXT_TO_MIME[e.slice(dot + 1).toLowerCase()])
  })
  if (!match) return null
  const ext = match.slice(match.lastIndexOf('.') + 1).toLowerCase()
  try {
    return { data: await readFile(join(dir, match)), mime: EXT_TO_MIME[ext] }
  } catch {
    return null
  }
}

/**
 * Best-effort delete of a stored image by id. Used when the user removes a
 * staged paste before the task is saved, so the bytes don't have to wait for
 * the next prune. The extension isn't known up front, so we match <id>.<ext>.
 */
export const deleteTaskImage = async (projectPath: string, id: string) => {
  const dir = imagesDir(projectPath)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  const match = entries.find((e) => {
    const dot = e.lastIndexOf('.')
    if (dot <= 0 || e.slice(0, dot) !== id) return false
    return Boolean(EXT_TO_MIME[e.slice(dot + 1).toLowerCase()])
  })
  if (!match) return
  try {
    await unlink(join(dir, match))
  } catch {
    /* best-effort */
  }
}

// A freshly uploaded file is kept regardless of references for this long: an
// image upload and the tasks.json save that references it are two separate
// round-trips, so a save whose payload predates the upload must not reap it.
const GC_MIN_AGE_MS = 2 * 60 * 1000

/**
 * Delete image files no task references — best-effort garbage collection run
 * after every tasks.json write, so removing an image or deleting a task that
 * carried one eventually reclaims the disk. Never throws.
 */
export const pruneTaskImages = async (projectPath: string, data: ProjectData) => {
  const dir = imagesDir(projectPath)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  const referenced = new Set<string>()
  for (const task of data.tasks) {
    for (const img of task.images ?? []) referenced.add(img.id)
  }
  const now = Date.now()
  await Promise.all(
    entries.map(async (entry) => {
      const dot = entry.lastIndexOf('.')
      const id = dot > 0 ? entry.slice(0, dot) : entry
      if (referenced.has(id)) return
      const full = join(dir, entry)
      try {
        const info = await stat(full)
        if (now - info.mtimeMs < GC_MIN_AGE_MS) return
        await unlink(full)
      } catch {
        /* best-effort — a concurrent unlink or transient error is fine */
      }
    }),
  )
}
