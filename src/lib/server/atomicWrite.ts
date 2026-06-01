import { writeFile, rename, rm } from 'fs/promises'
import { dirname, join, basename } from 'path'

// Atomic JSON write. We write to a sibling temp file first, then `rename` it
// over the target. rename(2) within the same directory (= same filesystem) is
// atomic, so a crash / power loss / forced quit mid-write can never leave a
// truncated half-written JSON behind — the original stays intact until the
// rename swaps it out in one step. This matters because every JSON read site
// in src/lib/server treats a parse failure as "empty/default" and would
// silently lose data on the next save (see store.ts / projectData.ts /
// canvasData.ts read paths).
//
// The temp file is a hidden sibling so it lands on the same filesystem (cross-
// device rename throws EXDEV) and a per-process monotonic counter keeps the
// name unique even if two writes to the same path overlap in-process.
let seq = 0

// `mode` (when given) is applied to the temp file before the rename, so the
// final file inherits owner-only perms atomically — there's no window where the
// destination exists with looser permissions (matters for auth.json = 0600).
export const atomicWriteJson = async (
  path: string,
  data: unknown,
  opts?: { mode?: number },
): Promise<void> => {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${seq++}`)
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', ...(opts?.mode != null ? { mode: opts.mode } : {}) })
  try {
    await rename(tmp, path)
  } catch (e) {
    // rename failed (perms, etc.) — drop the orphan temp; the original target
    // is untouched, so the caller's data on disk is still consistent.
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}
