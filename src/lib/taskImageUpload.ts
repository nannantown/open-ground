import type { TaskImage } from './types'
import { newId } from './ids'

// Client-side helpers for attaching clipboard-pasted images to tasks. Shared by
// every text input that accepts an image paste (project panel, run cockpit).

// Pull image files out of a paste event's clipboard. Returns [] for a plain
// text paste. Reads DataTransfer.items first (the path a clipboard screenshot
// takes) and falls back to .files for the cases where only that is populated.
export function imageFilesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  if (out.length === 0) {
    for (const f of Array.from(dt.files ?? [])) {
      if (f.type.startsWith('image/')) out.push(f)
    }
  }
  return out
}

// Upload pasted image files to a project's .hove/task-images/ store. Returns
// TaskImage metadata for the uploads that succeeded, plus the first error.
export async function uploadTaskImages(
  projectPath: string,
  files: File[],
): Promise<{ added: TaskImage[]; error: string | null }> {
  const added: TaskImage[] = []
  let error: string | null = null
  for (const file of files) {
    const id = newId()
    try {
      const res = await fetch(
        `/api/project/task-image?path=${encodeURIComponent(projectPath)}&id=${id}`,
        { method: 'POST', headers: { 'content-type': file.type }, body: file },
      )
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error ?? res.statusText)
      }
      added.push({
        id,
        name: file.name || 'Pasted image',
        mime: file.type,
        addedAt: new Date().toISOString(),
      })
    } catch (err: any) {
      error = err?.message ?? 'Image upload failed'
    }
  }
  return { added, error }
}

/** The GET URL that serves a stored task image — usable directly as `<img src>`. */
export const taskImageUrl = (projectPath: string, id: string) =>
  `/api/project/task-image?path=${encodeURIComponent(projectPath)}&id=${id}`

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** Project-relative on-disk path for a task image — what Claude can Read. */
export const taskImageRelPath = (image: TaskImage): string =>
  `.hove/task-images/${image.id}.${MIME_TO_EXT[image.mime] ?? 'png'}`

// Best-effort delete of a stored task image. Used when the user removes a
// staged paste from the composer before the task is saved — otherwise the
// bytes would sit on disk until the next tasks.json save triggers the GC.
export async function deleteTaskImage(projectPath: string, id: string) {
  try {
    await fetch(
      `/api/project/task-image?path=${encodeURIComponent(projectPath)}&id=${id}`,
      { method: 'DELETE' },
    )
  } catch {
    /* best-effort — GC will reclaim it on the next save */
  }
}
